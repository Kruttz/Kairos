import Anthropic from '@anthropic-ai/sdk'
import type { N8nWorkflow, Tag } from './types/workflow.js'
import type { BuildResult, BuildProvenance, WorkflowListItem, ExecutionSummary, ExecutionDetail, SmokeTestResult, CredentialRequirement } from './types/result.js'
import { computeWorkflowHash } from './utils/workflow-hash.js'
import { getRuleSetVersion, getPromptVersion, getNodeCatalogVersion } from './validation/provenance-versions.js'
import type { ClientOptions, BuildOptions, DeleteOptions, ExecutionFilter } from './types/options.js'
import type { IWorkflowLibrary, WorkflowMatch, WorkflowMetadataInput } from './library/types.js'
import { NullLibrary } from './library/null-library.js'
import { N8nApiClient } from './providers/n8n/api-client.js'
import { N8nFieldStripper } from './providers/n8n/stripper.js'
import { N8nProvider } from './providers/n8n/provider.js'
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
import { GenerationError } from './errors/generation-error.js'
import { ResponseParseError } from './errors/response-parse-error.js'
import { DeployActivationError } from './errors/deploy-activation-error.js'
import { inferWorkflowType } from './utils/workflow-type.js'
import { generateUUID } from './utils/uuid.js'
import { summarizeWorkflow } from './utils/workflow-summary.js'
import { diffWorkflows, formatDiff } from './utils/workflow-diff.js'
import type { WebhookReachabilityResult } from './utils/webhook-verify.js'
import { ClientMemoryStore } from './memory/store.js'
import { formatClientContext } from './memory/format.js'
import type { RememberInput, MemoryNode } from './memory/types.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_MODEL = process.env['KAIROS_MODEL'] ?? 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = process.env['KAIROS_MAX_TOKENS'] ? parseInt(process.env['KAIROS_MAX_TOKENS'], 10) : 16000
const DEFAULT_TIMEOUT_MS = process.env['KAIROS_TIMEOUT_MS'] ? parseInt(process.env['KAIROS_TIMEOUT_MS'], 10) : 300000

export class Kairos {
  private readonly provider: N8nProvider | null
  private readonly designer: WorkflowDesigner
  private readonly library: IWorkflowLibrary
  private readonly logger: ILogger
  private readonly telemetry: TelemetryCollector | null
  private readonly telemetryReader: TelemetryReader | null
  private readonly patternAnalyzer: PatternAnalyzer | null
  private readonly model: string
  private readonly maxTokens: number
  private readonly memoryStore: ClientMemoryStore
  private saveQueue: Promise<string | null> = Promise.resolve(null)

  constructor(options: ClientOptions) {
    const logger = options.logger ?? nullLogger
    this.model = options.model ?? DEFAULT_MODEL
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    const maxTokens = this.maxTokens
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

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
    this.designer = new WorkflowDesigner(anthropic, this.model, logger, patternsPath, options.nodeRegistry, maxTokens, timeoutMs)
    this.library = options.library ?? new NullLibrary()
    this.logger = logger
    this.memoryStore = new ClientMemoryStore(options.clientId ?? process.env['KAIROS_CLIENT_ID'], { logger })

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

  private buildProvenance(workflow: N8nWorkflow, designResult: DesignResult, runId: string): BuildProvenance {
    return {
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: designResult.attemptMetadata.at(-1)?.temperature ?? null,
      runId,
      ruleSetVersion: getRuleSetVersion(),
      promptVersion: getPromptVersion(),
      nodeCatalogVersion: getNodeCatalogVersion(),
      workflowHash: computeWorkflowHash(workflow),
    }
  }

  /** Explicitly writes a client memory node. No-op (returns null) when clientId isn't set. */
  async remember(input: RememberInput): Promise<MemoryNode | null> {
    return this.memoryStore.remember(input)
  }

  /** Retrieves relevant client memory nodes for a query. Returns [] when clientId isn't set. */
  async recall(query: string, k = 5): Promise<MemoryNode[]> {
    return this.memoryStore.retrieve(query, k)
  }

  /** Records a successful build/replace as a `history` memory node. Never fails the caller —
   * a write failure is logged and swallowed, matching the "memory never blocks a build" rule. */
  private async recordBuildHistory(
    verb: 'Built' | 'Replaced',
    name: string,
    workflowId: string | null,
    description: string,
    credentialsNeeded: CredentialRequirement[],
  ): Promise<void> {
    if (!this.memoryStore.isActive) return
    const credTypes = credentialsNeeded.map((c) => c.credentialType).join(', ') || 'none'
    await this.memoryStore.remember({
      type: 'history',
      description: `${verb} "${name}": ${description}`,
      body: `Workflow ID: ${workflowId ?? 'n/a'}\nCredentials needed: ${credTypes}`,
      source: 'build',
    }).catch((err) => this.logger.warn('Failed to write build history to client memory', { err: String(err) }))
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

    const clientMemories = await this.memoryStore.retrieve(description, 5)
    const clientContext = formatClientContext(clientMemories) ?? undefined

    let designResult: DesignResult
    try {
      designResult = await this.designer.design(
        { description, ...(options?.name ? { name: options.name } : {}) },
        matches,
        globalFailureRates,
        clientContext,
      )
    } catch (err) {
      if (err instanceof ValidationError || err instanceof GenerationError || err instanceof ResponseParseError) {
        await this.emitFailureTelemetry(err, description, workflowType, runId, buildStart, options?.dryRun ?? false)
      }
      throw err
    }

    await this.emitAttemptTelemetry(description, designResult, workflowType, runId)

    const workflow = options?.name
      ? { ...designResult.workflow, name: options.name }
      : designResult.workflow

    const summary = summarizeWorkflow(workflow, designResult.credentialsNeeded, designResult.attemptMetadata.at(-1)?.issues ?? [])

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
        tokensInput: designResult.attemptMetadata.reduce((s, m) => s + m.tokensInput, 0),
        tokensOutput: designResult.attemptMetadata.reduce((s, m) => s + m.tokensOutput, 0),
        dryRun: true,
        summary,
        finalIssues: designResult.attemptMetadata.at(-1)?.issues ?? [],
        provenance: this.buildProvenance(workflow, designResult, runId),
      }
    }

    const provider = this.requireProvider()
    const deployed = await provider.deploy(workflow)
    // Log the workflow ID immediately — if any post-deploy step fails, this ID
    // lets the user manually locate and clean up the orphaned workflow in n8n.
    this.logger.info('Workflow deployed to n8n', { workflowId: deployed.workflowId, name: deployed.name })

    let webhookVerification: WebhookReachabilityResult | null = null
    if (options?.activate) {
      try {
        await provider.activate(deployed.workflowId)
      } catch (err) {
        throw new DeployActivationError(
          `Workflow ${deployed.workflowId} ("${deployed.name}") was deployed successfully but activation failed. ` +
          `The workflow exists in n8n but is inactive — see err.workflowId to locate or clean it up.`,
          deployed.workflowId,
          err,
        )
      }

      // smokeTest, if requested, already runs the equivalent check via its own webhook
      // branch below — avoid firing two near-identical probes at the same fresh webhook.
      if (!options?.smokeTest) {
        webhookVerification = await provider.checkWebhookReachable(workflow)
      }
    }

    // saveToLibrary must run before recordDeploy — recordDeploy chains onto saveQueue
    // and reads the savedId produced by saveToLibrary. Calling recordDeploy first would
    // read the previous build's savedId (or null on the first build).
    this.saveToLibrary(workflow, description, designResult, matches, deployed.workflowId)
    this.recordDeploy(deployed.workflowId)

    let smokeTestResult: SmokeTestResult | undefined
    if (options?.smokeTest) {
      smokeTestResult = await provider.smokeTest(deployed.workflowId, workflow).catch((err: unknown): SmokeTestResult => {
        this.logger.warn('Smoke test threw unexpectedly', { err: String(err) })
        return { status: 'error', triggerType: 'manual', error: String(err) }
      })
      this.logger.info('Smoke test complete', { status: smokeTestResult.status, triggerType: smokeTestResult.triggerType })

      if (smokeTestResult.triggerType === 'webhook') {
        webhookVerification = {
          reachable: smokeTestResult.status === 'passed' ? true : smokeTestResult.status === 'failed' ? false : null,
          detail: smokeTestResult.error ?? 'Production webhook responded successfully.',
        }
      }
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
    await this.recordBuildHistory('Built', deployed.name, deployed.workflowId, description, designResult.credentialsNeeded)

    const finalSummary = summarizeWorkflow(workflow, designResult.credentialsNeeded, designResult.attemptMetadata.at(-1)?.issues ?? [], webhookVerification)

    return {
      workflowId: deployed.workflowId,
      name: deployed.name,
      workflow,
      credentialsNeeded: designResult.credentialsNeeded,
      activationRequired: !options?.activate,
      generationAttempts: designResult.attempts,
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      dryRun: false,
      summary: finalSummary,
      finalIssues: designResult.attemptMetadata.at(-1)?.issues ?? [],
      provenance: this.buildProvenance(workflow, designResult, runId),
      ...(smokeTestResult !== undefined ? { smokeTest: smokeTestResult } : {}),
      ...(webhookVerification !== null ? { webhookVerification } : {}),
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
    const clientMemories = await this.memoryStore.retrieve(description, 5)
    const clientContext = formatClientContext(clientMemories) ?? undefined

    let designResult: DesignResult
    try {
      designResult = await this.designer.design({ description }, matches, globalFailureRates, clientContext)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof GenerationError || err instanceof ResponseParseError) {
        await this.emitFailureTelemetry(err, description, workflowType, runId, buildStart, false)
      }
      throw err
    }

    await this.emitAttemptTelemetry(description, designResult, workflowType, runId)

    const provider = this.requireProvider()

    // Fetch the current deployed workflow before overwriting it, purely to compute a
    // "what changed" diff for the summary — a fetch failure here must not block the
    // replace itself, so this degrades to no diff rather than throwing.
    let previousWorkflow: N8nWorkflow | null = null
    try {
      previousWorkflow = await provider.get(id)
    } catch (err) {
      this.logger.warn('Could not fetch previous workflow for diff — summary will not include what changed', { id, err: String(err) })
    }

    const deployed = await provider.update(id, designResult.workflow)
    this.logger.info('Workflow updated in n8n', { workflowId: deployed.workflowId, name: deployed.name })

    this.saveToLibrary(designResult.workflow, description, designResult, matches, deployed.workflowId)
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
    await this.recordBuildHistory('Replaced', deployed.name, deployed.workflowId, description, designResult.credentialsNeeded)

    const baseSummary = summarizeWorkflow(designResult.workflow, designResult.credentialsNeeded, designResult.attemptMetadata.at(-1)?.issues ?? [])
    const summary = previousWorkflow
      ? `${baseSummary}\n\n${formatDiff(diffWorkflows(previousWorkflow, designResult.workflow))}`
      : baseSummary

    return {
      workflowId: deployed.workflowId,
      name: deployed.name,
      workflow: designResult.workflow,
      credentialsNeeded: designResult.credentialsNeeded,
      activationRequired: true,
      generationAttempts: designResult.attempts,
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      dryRun: false,
      summary,
      finalIssues: designResult.attemptMetadata.at(-1)?.issues ?? [],
      provenance: this.buildProvenance(designResult.workflow, designResult, runId),
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

  /**
   * A build/replace failure can throw ValidationError, GenerationError, or
   * ResponseParseError (ResponseTruncationError extends GenerationError) — all three
   * carry attemptMetadata when the failure surfaced after the retry loop ran. Shared by
   * build()'s and replace()'s catch blocks so every failure class gets the same
   * telemetry/pattern-learning visibility, not just validation failures.
   */
  private async emitFailureTelemetry(
    err: ValidationError | GenerationError | ResponseParseError,
    description: string,
    workflowType: string | null,
    runId: string,
    buildStart: number,
    dryRun: boolean,
  ): Promise<void> {
    const attemptMetadata = err.attemptMetadata
    if (!attemptMetadata) return

    for (const meta of attemptMetadata) {
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
        ...(meta.parseFailure ? { parseFailure: meta.parseFailure } : {}),
        workflowType,
      }, runId)
    }

    await this.telemetry?.emit('build_complete', {
      description,
      success: false,
      totalAttempts: attemptMetadata.length,
      totalDurationMs: Date.now() - buildStart,
      totalTokensInput: attemptMetadata.reduce((s, m) => s + m.tokensInput, 0),
      totalTokensOutput: attemptMetadata.reduce((s, m) => s + m.tokensOutput, 0),
      workflowName: null,
      workflowId: null,
      dryRun,
      credentialsNeeded: 0,
      warnedRules: err instanceof ValidationError ? (err.warnedRules ?? []) : [],
      workflowType,
    }, runId)

    this.updatePatterns()
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

  private recordDeploy(n8nWorkflowId?: string): void {
    this.saveQueue = this.saveQueue
      .then(async (savedId) => {
        if (savedId) {
          await this.library.recordDeployment(savedId, n8nWorkflowId)
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
    n8nWorkflowId?: string,
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
    if (n8nWorkflowId) metadata.n8nWorkflowId = n8nWorkflowId

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
