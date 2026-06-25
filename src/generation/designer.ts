import Anthropic from '@anthropic-ai/sdk'
import type { WorkflowMatch } from '../library/types.js'
import type { N8nWorkflow } from '../types/workflow.js'
import type { CredentialRequirement } from '../types/result.js'
import type { ILogger } from '../utils/logger.js'
import { GenerationError } from '../errors/generation-error.js'
import { ResponseParseError } from '../errors/response-parse-error.js'
import { ValidationError } from '../errors/validation-error.js'
import type { ValidationIssue } from '../errors/validation-error.js'
import { N8nValidator } from '../validation/validator.js'
import { PromptBuilder } from './prompt-builder.js'
import type { AttemptMetadata } from '../telemetry/types.js'
import type { RuleFailureRate } from '../telemetry/reader.js'
import type { DesignRequest, DesignResult, SystemPromptBlock } from './types.js'

const MAX_ATTEMPTS = 3
const BASE_TEMPERATURE = 0.2
const FINAL_TEMPERATURE = 0.1

const GENERATE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: 'generate_workflow',
  description: 'Generate a valid n8n workflow JSON object',
  input_schema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'object',
        description: 'The complete n8n workflow object',
        properties: {
          name: { type: 'string' },
          nodes: { type: 'array' },
          connections: { type: 'object' },
          settings: { type: 'object' },
        },
        required: ['name', 'nodes', 'connections'],
      },
      credentialsNeeded: {
        type: 'array',
        description: 'List of credentials the user must configure before activating',
        items: {
          type: 'object',
          properties: {
            service: { type: 'string' },
            credentialType: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['service', 'credentialType', 'description'],
        },
      },
      error: {
        type: 'string',
        description: 'Set this if the request cannot be fulfilled — explain why',
      },
    },
    required: [],
  },
}

interface ToolUseResult {
  workflow: N8nWorkflow
  credentialsNeeded: CredentialRequirement[]
  error?: string
}

export class WorkflowDesigner {
  private readonly validator: N8nValidator
  private readonly promptBuilder: PromptBuilder

  constructor(
    private readonly anthropic: Anthropic,
    private readonly model: string,
    private readonly logger: ILogger,
    patternsPath?: string,
  ) {
    this.validator = new N8nValidator()
    this.promptBuilder = new PromptBuilder(patternsPath)
  }

  async design(request: DesignRequest, matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[] = []): Promise<DesignResult> {
    const attemptMetadata: AttemptMetadata[] = []
    let lastErrors: ValidationIssue[] = []
    let attempts = 0
    const built = this.promptBuilder.build(request, matches, globalFailureRates)

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt
      const temperature = attempt === MAX_ATTEMPTS ? FINAL_TEMPERATURE : BASE_TEMPERATURE

      let userMessage: string
      if (attempt === 1) {
        userMessage = built.userMessage
        this.logger.debug('WorkflowDesigner: attempt 1', { description: request.description })
      } else {
        const issueLines = lastErrors.map(
          (i) => `- [Rule ${i.rule}] ${i.message}${i.nodeId ? ` (node: ${i.nodeId})` : ''}`,
        )
        userMessage = this.promptBuilder.buildCorrectionMessage(request, matches, issueLines, attempt - 1)
        this.logger.debug(`WorkflowDesigner: correction attempt ${attempt}`, { issueCount: lastErrors.length })
      }

      const start = Date.now()
      const message = await this.callClaude(built.system, userMessage, temperature)
      const durationMs = Date.now() - start
      const parsed = this.extractToolUse(message)

      if (parsed.error) {
        throw new GenerationError(`Claude declined to generate workflow: ${parsed.error}`)
      }

      const validation = this.validator.validate(parsed.workflow)
      const errors = validation.issues.filter((i) => i.severity === 'error')

      attemptMetadata.push({
        attempt,
        temperature,
        durationMs,
        tokensInput: message.usage.input_tokens,
        tokensOutput: message.usage.output_tokens,
        validationPassed: validation.valid,
        issues: validation.issues,
      })

      if (validation.valid) {
        return { workflow: parsed.workflow, credentialsNeeded: parsed.credentialsNeeded, attempts, attemptMetadata, warnedRules: this.promptBuilder.getWarnedRules() }
      }

      lastErrors = errors
      this.logger.warn(`WorkflowDesigner: validation failed on attempt ${attempt}`, {
        errorCount: errors.length,
      })
    }

    const finalIssues = attemptMetadata.at(-1)?.issues ?? lastErrors
    throw new ValidationError(
      `Workflow failed validation after ${MAX_ATTEMPTS} attempts`,
      finalIssues,
      attemptMetadata,
      this.promptBuilder.getWarnedRules(),
    )
  }

  private async callClaude(
    system: SystemPromptBlock[],
    userMessage: string,
    temperature: number,
  ): Promise<Anthropic.Message> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      return await this.anthropic.messages.create(
        {
          model: this.model,
          max_tokens: 8192,
          temperature,
          system: system.map((b) => ({ type: b.type, text: b.text, ...(b.cache_control ? { cache_control: b.cache_control } : {}) })),
          messages: [{ role: 'user', content: userMessage }],
          tools: [GENERATE_WORKFLOW_TOOL],
          tool_choice: { type: 'tool', name: 'generate_workflow' },
        },
        { signal: controller.signal },
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new GenerationError(`Anthropic API call failed: ${detail}`, err)
    } finally {
      clearTimeout(timer)
    }
  }

  private extractToolUse(message: Anthropic.Message): ToolUseResult {
    if (message.stop_reason === 'max_tokens') {
      throw new GenerationError(
        'Claude response was truncated (max_tokens reached) — the workflow may be too large. Try a simpler description or break it into smaller workflows.',
      )
    }

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )
    if (!toolUseBlock) {
      throw new ResponseParseError(
        'Claude response contained no tool_use block — forced tool_choice failed unexpectedly',
      )
    }

    const input = toolUseBlock.input as Record<string, unknown>

    if (typeof input['error'] === 'string') {
      return {
        workflow: { name: '', nodes: [], connections: {} },
        credentialsNeeded: [],
        error: input['error'],
      }
    }

    if (!input['workflow'] || typeof input['workflow'] !== 'object') {
      throw new ResponseParseError('generate_workflow tool call missing workflow field')
    }

    const workflow = input['workflow'] as N8nWorkflow
    const credentialsNeeded = (input['credentialsNeeded'] as CredentialRequirement[] | undefined) ?? []

    return { workflow, credentialsNeeded }
  }
}
