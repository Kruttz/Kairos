export interface CredentialRequirement {
  service: string
  credentialType: string
  description: string
}

export type SmokeTestStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'not-applicable'

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
  smokeTest?: SmokeTestResult
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
