export interface CredentialRequirement {
  service: string
  credentialType: string
  description: string
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
