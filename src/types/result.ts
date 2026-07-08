export interface CredentialRequirement {
  service: string
  credentialType: string
  description: string
}

/**
 * What was actually true when this specific workflow was built -- answers "was this built
 * under today's rules/catalog/prompt, or an older set?" and "what model/settings produced
 * it?" without any diffing, history, or rollback mechanic. See
 * src/validation/provenance-versions.ts and src/utils/workflow-hash.ts for how each field is
 * derived; ruleSetVersion and promptTemplateVersion are content-derived hashes (never a
 * manually bumped constant), nodeCatalogVersion is the exact pinned source-package versions
 * the catalog was generated from.
 */
export interface BuildProvenance {
  /** The published @kairos-sdk/core version that produced this build. */
  kairosVersion: string
  model: string
  maxTokens: number
  /** The final (successful) generation attempt's temperature. Null only when no attempt
   * metadata is available (shouldn't happen for a successful build, but the field degrades
   * honestly rather than fabricating a value). */
  temperature: number | null
  runId: string
  ruleSetVersion: string
  /** Hash of the static base system prompt template ONLY -- not the actual per-request
   * assembled prompt (which varies with the node catalog, matched library workflows,
   * patterns, and profile). See getPromptTemplateVersion() in provenance-versions.ts for why
   * that scope is deliberate, not an oversight. */
  promptTemplateVersion: string
  /** Which KAIROS_PROMPT_PROFILE ('minimal'/'standard'/'rich') shaped this build's prompt
   * assembly -- the other real input to what was actually sent, recorded alongside the
   * base-template hash above since it isn't captured by that hash. */
  promptProfile: string
  nodeCatalogVersion: Record<string, string>
  /** Deterministic hash of the built workflow's nodes/connections/settings -- see
   * src/utils/workflow-hash.ts. Always computable, including for dry-run builds, since it
   * only needs nodes/connections/settings, not a deployed workflowId. */
  workflowHash: string
}

export type SmokeTestStatus = 'passed' | 'failed' | 'error' | 'not-applicable'

export interface SmokeTestResult {
  status: SmokeTestStatus
  triggerType: 'manual' | 'webhook' | 'not-applicable'
  executionId?: string
  durationMs?: number
  error?: string
}

export interface BuildResult {
  workflowId: string | null
  name: string
  workflow: import('../types/workflow.js').N8nWorkflow
  credentialsNeeded: CredentialRequirement[]
  activationRequired: boolean
  generationAttempts: number
  tokensInput: number
  tokensOutput: number
  dryRun: boolean
  /** Plain-English "what this workflow does" summary — see src/utils/workflow-summary.ts */
  summary: string
  /**
   * The final generation attempt's structured validation issues (rule/severity/message) --
   * the same data summary is partially built from, but retained here as structured data for
   * anything (e.g. a risk report) that needs more than the already-rendered prose. Always
   * present going forward; only absent on results deserialized from a pack persisted before
   * this field existed.
   */
  finalIssues: import('../validation/types.js').ValidationIssue[]
  smokeTest?: SmokeTestResult
  /** Set only for webhook-triggered workflows built with activate: true — see src/utils/webhook-verify.ts */
  webhookVerification?: import('../utils/webhook-verify.js').WebhookReachabilityResult
  /** Absent only on results deserialized from a pack persisted before this field existed —
   * treat that case as "provenance unknown," never as an error. */
  provenance?: BuildProvenance
}

export interface DeployResult {
  workflowId: string
  name: string
}

export interface WorkflowListItem {
  id: string
  name: string
  active: boolean
  createdAt: string
  updatedAt: string
  tags?: Array<{ id: string; name: string }>
}

export interface ExecutionSummary {
  id: string
  workflowId: string
  status: 'success' | 'error' | 'waiting' | 'running' | 'canceled'
  startedAt: string
  stoppedAt?: string
  mode: string
}

export interface ExecutionDetail extends ExecutionSummary {
  data?: unknown
  workflowData?: unknown
}
