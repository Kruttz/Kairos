import Anthropic from '@anthropic-ai/sdk'
import type { WorkflowMatch } from '../library/types.js'
import type { N8nWorkflow } from '../types/workflow.js'
import type { CredentialRequirement } from '../types/result.js'
import type { ILogger } from '../utils/logger.js'
import { GenerationError } from '../errors/generation-error.js'
import { ResponseParseError } from '../errors/response-parse-error.js'
import { ResponseTruncationError } from '../errors/response-truncation-error.js'
import { ValidationError } from '../errors/validation-error.js'
import type { ValidationIssue } from '../errors/validation-error.js'
import { N8nValidator } from '../validation/validator.js'
import type { NodeRegistry } from '../validation/registry.js'
import { PromptBuilder } from './prompt-builder.js'
import type { AttemptMetadata } from '../telemetry/types.js'
import type { RuleFailureRate } from '../telemetry/reader.js'
import type { DesignRequest, DesignResult, SystemPromptBlock } from './types.js'
import type { WorkflowReference } from '../pack/workflow-reference.js'

const MAX_ATTEMPTS = 3
const BASE_TEMPERATURE = 0.2
const FINAL_TEMPERATURE = 0.1
const DEFAULT_MAX_TOKENS = 16000
const DEFAULT_TIMEOUT_MS = 300000

const GENERATE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: 'generate_workflow',
  description: 'Generate a valid n8n workflow JSON object',
  input_schema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'object',
        // "Not a stringified JSON string" targets an observed failure mode: on very
        // large outputs the model sometimes serializes this nested object as a string.
        // NOTE: deliberately NOT in `required` — the error escape path returns {error}
        // with no workflow, and the pinned SDK (0.36.x) predates strict tool use.
        description: 'The complete n8n workflow object. Must be a raw JSON object, NOT a stringified JSON string.',
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
    nodeRegistry?: NodeRegistry,
    private readonly maxTokens: number = DEFAULT_MAX_TOKENS,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.validator = new N8nValidator(nodeRegistry)
    this.promptBuilder = new PromptBuilder(patternsPath)
  }

  async design(request: DesignRequest, matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[] = [], clientContext?: string, priorContext?: WorkflowReference[]): Promise<DesignResult> {
    const attemptMetadata: AttemptMetadata[] = []
    // Deliberately holds ALL issues (errors + warnings) from the previous attempt, not
    // just errors — so a build that's already retrying for a real error also gets a
    // chance to clean up warn-level issues (e.g. Rule 126 malformed node IDs) sitting
    // alongside it, instead of those shipping silently the moment the error clears.
    // The actual pass/fail gate below (validation.valid) is untouched by this — it still
    // only depends on error-severity issues, matching the documented "errors block
    // deployment, warnings are recorded" design.
    let lastIssues: ValidationIssue[] = []
    // Set when the most recent attempt produced no parseable workflow at all (stringified/
    // missing workflow field, truncation). Deliberately NOT cleared on a parse failure — a
    // parse failure carries forward whatever validation issues came before it (D4: the prior
    // attempt's unaddressed issues are still real, a parse failure just means we learned
    // nothing new about them this round). Cleared the moment a later attempt parses cleanly.
    let lastParseError: ResponseParseError | ResponseTruncationError | null = null
    let attempts = 0
    const built = this.promptBuilder.build(request, matches, globalFailureRates, undefined, clientContext, priorContext)

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt
      const temperature = attempt === MAX_ATTEMPTS ? FINAL_TEMPERATURE : BASE_TEMPERATURE

      let userMessage: string
      if (attempt === 1) {
        userMessage = built.userMessage
        this.logger.debug('WorkflowDesigner: attempt 1', { description: request.description })
      } else {
        const issueLines = lastIssues.map(
          (i) => `- [Rule ${i.rule}] ${i.message}${i.nodeId ? ` (node: ${i.nodeId})` : ''}`,
        )
        if (lastParseError) {
          const hint = lastParseError instanceof ResponseTruncationError
            ? 'generate a more compact workflow (leaner Code nodes, fewer redundant fields)'
            : 'the workflow field must be a raw JSON object, not a stringified JSON string'
          issueLines.push(`- [Format] ${lastParseError.message} — ${hint}.`)
        }
        const failingRuleIds = lastIssues.map((i) => i.rule)
        userMessage = this.promptBuilder.buildCorrectionMessage(request, matches, issueLines, attempt - 1, failingRuleIds)
        this.logger.debug(`WorkflowDesigner: correction attempt ${attempt}`, { issueCount: lastIssues.length, hadParseFailure: !!lastParseError })
      }

      const start = Date.now()
      const message = await this.callClaude(built.system, userMessage, temperature)
      const durationMs = Date.now() - start

      let parsed: ToolUseResult
      try {
        parsed = this.extractToolUse(message)
      } catch (err) {
        if (!(err instanceof ResponseParseError) && !(err instanceof ResponseTruncationError)) throw err

        attemptMetadata.push({
          attempt,
          temperature,
          durationMs,
          tokensInput: message.usage.input_tokens,
          tokensOutput: message.usage.output_tokens,
          validationPassed: false,
          issues: [],
          parseFailure: err.message,
        })
        this.logger.warn(`WorkflowDesigner: parse failure on attempt ${attempt}`, { message: err.message })
        lastParseError = err
        continue
      }

      if (parsed.error) {
        throw new GenerationError(`Claude declined to generate workflow: ${parsed.error}`)
      }

      lastParseError = null

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

      lastIssues = validation.issues
      this.logger.warn(`WorkflowDesigner: validation failed on attempt ${attempt}`, {
        errorCount: errors.length,
      })
    }

    // Whatever the FINAL attempt's failure kind was is what gets rethrown (D5) — a parse
    // failure on the last attempt rethrows that parse/truncation error (now carrying
    // attemptMetadata for telemetry), NOT a generic ValidationError with stale issues.
    if (lastParseError) {
      const Ctor = lastParseError instanceof ResponseTruncationError ? ResponseTruncationError : ResponseParseError
      throw new Ctor(lastParseError.message, lastParseError.cause, attemptMetadata)
    }

    const finalIssues = attemptMetadata.at(-1)?.issues ?? lastIssues
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
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.anthropic.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
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
      throw new ResponseTruncationError(
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

    let rawWorkflow = input['workflow']

    // Recovery shim: on very large outputs Claude sometimes serializes the nested
    // workflow object as a JSON *string* (observed directly on an 8.4K-token response
    // whose string contained complete, valid workflow JSON). Parse it back rather
    // than failing a response that is semantically fine.
    if (typeof rawWorkflow === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawWorkflow)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.logger.warn('WorkflowDesigner: workflow arrived as a JSON string — recovered via parse')
          rawWorkflow = parsed
        } else {
          throw new ResponseParseError(
            'generate_workflow tool call returned workflow as a JSON string that parsed to a non-object',
          )
        }
      } catch (err) {
        if (err instanceof ResponseParseError) throw err
        throw new ResponseParseError(
          'generate_workflow tool call returned workflow as a JSON string that could not be parsed as an object',
          err,
        )
      }
    }

    if (!rawWorkflow) {
      throw new ResponseParseError('generate_workflow tool call missing workflow field')
    }
    if (typeof rawWorkflow !== 'object' || Array.isArray(rawWorkflow)) {
      throw new ResponseParseError(
        `generate_workflow tool call returned workflow with wrong type (${Array.isArray(rawWorkflow) ? 'array' : typeof rawWorkflow}) — expected a JSON object`,
      )
    }

    const workflow = rawWorkflow as N8nWorkflow

    // Same failure class, defensively: credentialsNeeded stringified alongside the workflow.
    let rawCreds = input['credentialsNeeded']
    if (typeof rawCreds === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawCreds)
        rawCreds = Array.isArray(parsed) ? parsed : []
      } catch {
        rawCreds = []
      }
    }
    const credentialsNeeded = (Array.isArray(rawCreds) ? rawCreds : []) as CredentialRequirement[]

    return { workflow, credentialsNeeded }
  }
}
