import Anthropic from '@anthropic-ai/sdk'
import type { N8nWorkflow, Tag } from './types/workflow.js'
import type { BuildResult, WorkflowListItem, ExecutionSummary, ExecutionDetail, SmokeTestResult } from './types/result.js'
import type { ClientOptions, BuildOptions, DeleteOptions, ExecutionFilter } from './types/options.js'
import type { IWorkflowLibrary, WorkflowMatch, WorkflowMetadataInput } from './library/types.js'
import { NullLibrary } from './library/null-library.js'
import { N8nApiClient } from './providers/n8n/api-client.js'
import { N8nFieldStripper } from './providers/n8n/stripper.js'
import { N8nProvider } from './providers/n8n/provider.js'
import { N8nValidator } from './validation/validator.js'
import { WorkflowDesigner } from './generation/designer.js'
import type { DesignResult } from './generation/types.js'
import { TelemetryCollector } from './telemetry/collector.js'
import { TelemetryReader } from './telemetry/reader.js'
import { PatternAnalyzer } from './telemetry/pattern-analyzer.js'
import { nullLogger } from './utils/logger.js'
import type { ILogger } from './utils/logger.js'
import { scoreToMode } from './utils/thresholds.js'
import { GuardError } from './errors/guard-error.js'
import { ValidationError } from './errors/validation-error.js'
import { inferWorkflowType } from './utils/workflow-type.js'
import { generateUUID } from './utils/uuid.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_MODEL = process.env['KAIROS_MODEL'] ?? 'claude-sonnet-4-6'

export class Kairos {
  private readonly provider: N8nProvider | null
  private readonly designer: WorkflowDesigner
  private readonly validator: N8nValidator
  private readonly library: IWorkflowLibrary
  private readonly logger: ILogger
  private readonly telemetry: TelemetryCollector | null
  private readonly telemetryReader: TelemetryReader | null
  private readonly patternAnalyzer: PatternAnalyzer | null
  private readonly model: string
  private saveQueue: Promise<string | null> = Promise.resolve(null)

  constructor(options: ClientOptions) {
    const logger = options.logger ?? nullLogger
    this.model = options.model ?? DEFAULT_MODEL

    if (options.n8nBaseUrl && options.n8nApiKey) {
      try {
        new URL(options.n8nBaseUrl)
      } catch {
        throw new GuardError(`Invalid n8nBaseUrl: "${options.n8nBaseUrl}" — must be a valid URL`)
      }
      const apiClient = new N8nApiClient(options.n8nBaseUrl, options.n8nApiKey, logger)
      const stripper = new N8nFieldStripper()
      this.provider = new N8nProvider(apiClient, stripper)
    } else {
      this.provider = null
    }

    const anthropic = new Anthropic({ apiKey: options.anthropicApiKey })
    const patternsPath = typeof options.telemetry === 'string'
      ? join(options.telemetry, '..', 'patterns.json')
      : join(homedir(), '.kairos', 'patterns.json')
    this.designer = new WorkflowDesigner(anthropic, this.model, logger, patternsPath)
    this.validator = new N8nValidator()
    this.library = options.library ?? new NullLibrary()
    this.logger = logger

    if (options.telemetry === true) {
      this.telemetry = new TelemetryCollector()
      this.telemetryReader = new TelemetryReader()
      this.patternAnalyzer = new PatternAnalyzer()
    } else if (typeof options.telemetry === 'string') {
      this.telemetry = new TelemetryCollector(options.telemetry)
      this.telemetryReader = new TelemetryReader(options.telemetry)
      this.patternAnalyzer = new PatternAnalyzer(options.telemetry)
    } else {
      this.telemetry = null
      this.telemetryReader = null
      this.patternAnalyzer = null
    }
  }

  private requireProvider(): N8nProvider {
    if (!this.provider) {
      throw new GuardError('n8nBaseUrl and n8nApiKey are required for this operation — set them in the Kairos constructor, or use { dryRun: true } for generation-only mode')
    }
    return this.provider
  }

  private validateDescription(description: string): void {
    if (!description || description.trim().length === 0) {
      throw new GuardError('Description is required and must be non-empty')
    }
  }

  async build(description: string, options?: BuildOptions): Promise<BuildResult> {
    this.validateDescription(description)
    this.logger.info('Kairos.build', { description, dryRun: options?.dryRun })
    const buildStart = Date.now()
    const runId = generateUUID()
    const workflowType = inferWorkflowType(description)

    await this.telemetry?.emit('build_start', {
      description,
      model: this.model,
      dryRun: options?.dryRun ?? false,
    }, runId)

    await this.library.initialize()
    const matches = await this.library.search(description)

    if (matches.length > 0) {
      const top = matches[0]!
      this.logger.info(`Library: ${matches.length} match(es), top="${top.workflow.description.slice(0, 50)}" score=${top.score.toFixed(2)} mode=${top.mode}`)
    } else {
      this.logger.info('Library: no matches (scratch mode)')
    }

    const globalFailureRates = await this.telemetryReader?.getFailureRates() ?? []

    if (globalFailureRates.length > 0) {
      const highFreq = globalFailureRates.filter((r) => r.rate >= 0.15)
      if (highFreq.length > 0) {
        this.logger.info(`Telemetry: ${highFreq.length} high-frequency failure rule(s) will be warned about`)
      }
    }

    let designResult: DesignResult
    try {
      designResult = await this.designer.design(
        { description, ...(options?.name ? { name: options.name } : {}) },
        matches,
        globalFailureRates,
      )
    } catch (err) {
      if (err instanceof ValidationError && err.attemptMetadata) {
        for (const meta of err.attemptMetadata) {
          await this.telemetry?.emit('generation_attempt', {
            description,
            attempt: meta.attempt,
            temperature: meta.temperature,
            durationMs: meta.durationMs,
            tokensInput: meta.tokensInput,
            tokensOutput: meta.tokensOutput,
            validationPassed: meta.validationPassed,
            issueCount: meta.issues.length,
            issues: meta.issues.map((i) => ({ rule: i.rule, severity: i.severity, message: i.message, nodeId: i.nodeId ?? null, nodeType: i.nodeType ?? null })),
            workflowType,
          }, runId)
        }
        await this.telemetry?.emit('build_complete', {
          description,
          success: false,
          totalAttempts: err.attemptMetadata.length,
          totalDurationMs: Date.now() - buildStart,
          totalTokensInput: err.attemptMetadata.reduce((s, m) => s + m.tokensInput, 0),
          totalTokensOutput: err.attemptMetadata.reduce((s, m) => s + m.tokensOutput, 0),
          workflowName: null,
          workflowId: null,
          dryRun: options?.dryRun ?? false,
          credentialsNeeded: 0,
          warnedRules: err.warnedRules ?? [],
          workflowType,
        }, runId)
        this.updatePatterns()
      }
      throw err
    }

    await this.emitAttemptTelemetry(description, designResult, workflowType, runId)

    const workflow = options?.name
      ? { ...designResult.workflow, name: options.name }
      : designResult.workflow

    this.saveToLibrary(workflow, description, designResult, matches)

    if (options?.dryRun) {
      const totalTokensInput = designResult.attemptMetadata.reduce((s, m) => s + m.tokensInput, 0)
      const totalTokensOutput = designResult.attemptMetadata.reduce((s, m) => s + m.tokensOutput, 0)

      await this.telemetry?.emit('build_complete', {
        description,
        success: true,
        totalAttempts: designResult.attempts,
        totalDurationMs: Date.now() - buildStart,
        totalTokensInput,
        totalTokensOutput,
        workflowName: workflow.name,
        workflowId: null,
        dryRun: true,
        credentialsNeeded: designResult.credentialsNeeded.length,
        warnedRules: designResult.warnedRules,
        workflowType,
      }, runId)

      this.updatePatterns()

      return {
        workflowId: null,
        name: workflow.name,
        workflow,
        credentialsNeeded: designResult.credentialsNeeded,
        activationRequired: true,
        generationAttempts: designResult.attempts,
        dryRun: true,
      }
    }

    const provider = this.requireProvider()
    const deployed = await provider.deploy(workflow)
    // Log the workflow ID immediately — if any post-deploy step fails, this ID
    // lets the user manually locate and clean up the orphaned workflow in n8n.
    this.logger.info('Workflow deployed to n8n', { workflowId: deployed.workflowId, name: deployed.name })
    this.recordDeploy()

    if (options?.activate) {
      await provider.activate(deployed.workflowId)
    }

    let smokeTestResult: SmokeTestResult | undefined
    if (options?.smokeTest) {
      smokeTestResult = await provider.smokeTest(deployed.workflowId, workflow).catch((err: unknown): SmokeTestResult => {
        this.logger.warn('Smoke test threw unexpectedly', { err: String(err) })
        return { status: 'error', triggerType: 'manual', error: String(err) }
      })
      this.logger.info('Smoke test complete', { status: smokeTestResult.status, triggerType: smokeTestResult.triggerType })
    }

    const totalTokensInput = designResult.attemptMetadata.reduce((s, m) => s + m.tokensInput, 0)
    const totalTokensOutput = designResult.attemptMetadata.reduce((s, m) => s + m.tokensOutput, 0)

    await this.telemetry?.emit('build_complete', {
      description,
      success: true,
      totalAttempts: designResult.attempts,
      totalDurationMs: Date.now() - buildStart,
      totalTokensInput,
      totalTokensOutput,
      workflowName: deployed.name,
      workflowId: deployed.workflowId,
      dryRun: false,
      credentialsNeeded: designResult.credentialsNeeded.length,
      warnedRules: designResult.warnedRules,
      workflowType,
    }, runId)

    this.updatePatterns()

    return {
      workflowId: deployed.workflowId,
      name: deployed.name,
      workflow,
      credentialsNeeded: designResult.credentialsNeeded,
      activationRequired: !options?.activate,
      generationAttempts: designResult.attempts,
      dryRun: false,
      ...(smokeTestResult !== undefined ? { smokeTest: smokeTestResult } : {}),
    }
  }

  async replace(id: string, description: string): Promise<BuildResult> {
    this.validateDescription(description)
    this.logger.info('Kairos.update', { id, description })
    const buildStart = Date.now()
    const runId = generateUUID()
    const workflowType = inferWorkflowType(description)

    await this.telemetry?.emit('build_start', {
      description,
      model: this.model,
      dryRun: false,
    }, runId)

    await this.library.initialize()
    const matches = await this.library.search(description)
    const globalFailureRates = await this.telemetryReader?.getFailureRates() ?? []

    let designResult: DesignResult
    try {
      designResult = await this.designer.design({ description }, matches, globalFailureRates)
    } catch (err) {
      if (err instanceof ValidationError && err.attemptMetadata) {
        for (const meta of err.attemptMetadata) {
          await this.telemetry?.emit('generation_attempt', {
            description,
            attempt: meta.attempt,
            temperature: meta.temperature,
            durationMs: meta.durationMs,
            tokensInput: meta.tokensInput,
            tokensOutput: meta.tokensOutput,
            validationPassed: meta.validationPassed,
            issueCount: meta.issues.length,
            issues: meta.issues.map((i) => ({ rule: i.rule, severity: i.severity, message: i.message, nodeId: i.nodeId ?? null, nodeType: i.nodeType ?? null })),
            workflowType,
          }, runId)
        }
        await this.telemetry?.emit('build_complete', {
          description,
          success: false,
          totalAttempts: err.attemptMetadata.length,
          totalDurationMs: Date.now() - buildStart,
          totalTokensInput: err.attemptMetadata.reduce((s, m) => s + m.tokensInput, 0),
          totalTokensOutput: err.attemptMetadata.reduce((s, m) => s + m.tokensOutput, 0),
          workflowName: null,
          workflowId: null,
          dryRun: false,
          credentialsNeeded: 0,
          warnedRules: err.warnedRules ?? [],
          workflowType,
        }, runId)
        this.updatePatterns()
      }
      throw err
    }

    await this.emitAttemptTelemetry(description, designResult, workflowType, runId)

    const provider = this.requireProvider()
    const deployed = await provider.update(id, designResult.workflow)
    this.logger.info('Workflow updated in n8n', { workflowId: deployed.workflowId, name: deployed.name })

    this.saveToLibrary(designResult.workflow, description, designResult, matches)
    this.recordDeploy()

    const totalTokensInput = designResult.attemptMetadata.reduce((s, m) => s + m.tokensInput, 0)
    const totalTokensOutput = designResult.attemptMetadata.reduce((s, m) => s + m.tokensOutput, 0)

    await this.telemetry?.emit('build_complete', {
      description,
      success: true,
      totalAttempts: designResult.attempts,
      totalDurationMs: Date.now() - buildStart,
      totalTokensInput,
      totalTokensOutput,
      workflowName: deployed.name,
      workflowId: deployed.workflowId,
      dryRun: false,
      credentialsNeeded: designResult.credentialsNeeded.length,
      warnedRules: designResult.warnedRules,
      workflowType,
    }, runId)

    this.updatePatterns()

    return {
      workflowId: deployed.workflowId,
      name: deployed.name,
      workflow: designResult.workflow,
      credentialsNeeded: designResult.credentialsNeeded,
      activationRequired: true,
      generationAttempts: designResult.attempts,
      dryRun: false,
    }
  }

  async drain(): Promise<void> {
    await this.saveQueue.catch(() => {})
  }

  private updatePatterns(): void {
    if (!this.patternAnalyzer) return
    this.saveQueue = this.saveQueue
      .then(() => this.patternAnalyzer!.analyzeAndSave())
      .then(() => null)
      .catch((err: unknown) => {
        this.logger.warn('Pattern analysis failed (non-fatal)', { err: String(err) })
        return null
      })
  }

  private async emitAttemptTelemetry(description: string, designResult: DesignResult, workflowType: string | null, runId: string): Promise<void> {
    for (const meta of designResult.attemptMetadata) {
      await this.telemetry?.emit('generation_attempt', {
        description,
        attempt: meta.attempt,
        temperature: meta.temperature,
        durationMs: meta.durationMs,
        tokensInput: meta.tokensInput,
        tokensOutput: meta.tokensOutput,
        validationPassed: meta.validationPassed,
        issueCount: meta.issues.length,
        issues: meta.issues.map((i) => ({ rule: i.rule, severity: i.severity, message: i.message, nodeId: i.nodeId ?? null, nodeType: i.nodeType ?? null })),
        workflowType,
      }, runId)
    }
  }

  private recordDeploy(): void {
    this.saveQueue = this.saveQueue
      .then(async (savedId) => {
        if (savedId) {
          await this.library.recordDeployment(savedId)
        }
        return savedId
      })
      .catch((err: unknown) => {
        this.logger.warn('Failed to record deployment (non-fatal)', { err: String(err) })
        return null
      })
  }

  private saveToLibrary(
    workflow: N8nWorkflow,
    description: string,
    designResult: DesignResult,
    matches: WorkflowMatch[],
  ): void {
    const failedAttempts = designResult.attemptMetadata.filter((m) => !m.validationPassed)
    const failurePatterns = failedAttempts.flatMap((m) =>
      m.issues.map((i) => ({ rule: i.rule, message: i.message })),
    )
    const topMatch = matches[0]
    const generationMode = topMatch ? scoreToMode(topMatch.score) : 'scratch' as const

    const autoTags = Array.from(new Set(
      workflow.nodes.flatMap((n) => {
        const bare = n.type.split('.').pop() ?? ''
        const tags = [bare]
        if (n.type.includes('Trigger') || n.type.includes('trigger')) tags.push(`trigger:${bare}`)
        if (n.type.includes('langchain')) tags.push('ai')
        return tags
      }),
    ))

    const metadata: WorkflowMetadataInput = {
      description,
      generationMode,
      generationAttempts: designResult.attempts,
    }
    if (autoTags.length > 0) metadata.tags = autoTags
    if (failurePatterns.length > 0) metadata.failurePatterns = failurePatterns
    if (matches.length > 0) metadata.sourceWorkflowIds = matches.map((m) => m.workflow.id)
    if (topMatch) metadata.topMatchScore = topMatch.score
    if (designResult.credentialsNeeded.length > 0) metadata.credentialsNeeded = designResult.credentialsNeeded

    const firstTryPass = designResult.attemptMetadata.length > 0
      && designResult.attemptMetadata[0]!.validationPassed
    const failedRules = Array.from(new Set(
      designResult.attemptMetadata
        .filter((m) => !m.validationPassed)
        .flatMap((m) => m.issues.map((i) => i.rule)),
    ))

    this.saveQueue = this.saveQueue
      .then(async () => {
        const savedId = await this.library.save(workflow, metadata)

        for (const match of matches) {
          if (match.mode === 'direct' || match.mode === 'reference') {
            await this.library.recordOutcome(match.workflow.id, {
              attempts: designResult.attempts,
              firstTryPass,
              failedRules,
              mode: match.mode,
            })
          }
        }

        return savedId
      })
      .catch((err: unknown) => {
        this.logger.warn('Failed to save workflow to library (non-fatal)', { err: String(err) })
        return null
      })
  }

  async get(id: string): Promise<N8nWorkflow> {
    return this.requireProvider().get(id)
  }

  async list(): Promise<WorkflowListItem[]> {
    return this.requireProvider().list()
  }

  async activate(id: string): Promise<void> {
    await this.requireProvider().activate(id)
  }

  async deactivate(id: string): Promise<void> {
    await this.requireProvider().deactivate(id)
  }

  async delete(id: string, options: DeleteOptions): Promise<void> {
    await this.requireProvider().delete(id, options)
  }

  async executions(workflowId?: string, filter?: ExecutionFilter): Promise<ExecutionSummary[]> {
    return this.requireProvider().executions(workflowId, filter)
  }

  async execution(id: string): Promise<ExecutionDetail> {
    return this.requireProvider().execution(id)
  }

  async listTags(): Promise<Tag[]> {
    return this.requireProvider().listTags()
  }

  async createTag(name: string): Promise<Tag> {
    return this.requireProvider().createTag(name)
  }

  async tag(workflowId: string, tagIds: string[]): Promise<void> {
    await this.requireProvider().tag(workflowId, tagIds)
  }

  async untag(workflowId: string, tagIds: string[]): Promise<void> {
    await this.requireProvider().untag(workflowId, tagIds)
  }
}
