import type { ValidationIssue } from '../errors/validation-error.js'

export interface TelemetryEvent {
  schemaVersion: number
  timestamp: string
  sessionId: string
  runId?: string
  eventType: 'build_start' | 'generation_attempt' | 'build_complete'
  data: Record<string, unknown>
}

export const TELEMETRY_SCHEMA_VERSION = 2

export interface AttemptMetadata {
  attempt: number
  temperature: number
  durationMs: number
  tokensInput: number
  tokensOutput: number
  validationPassed: boolean
  issues: ValidationIssue[]
  /** Set when this attempt produced no parseable workflow at all (stringified/missing
   * workflow field, truncation) — the attempt never reached validation. */
  parseFailure?: string
}

export interface BuildStartData {
  description: string
  model: string
  dryRun: boolean
}

export interface GenerationAttemptData {
  description: string
  attempt: number
  temperature: number
  durationMs: number
  tokensInput: number
  tokensOutput: number
  validationPassed: boolean
  issueCount: number
  issues: Array<{ rule: number; severity: 'error' | 'warn'; message: string; nodeId?: string | null; nodeType?: string | null }>
  workflowType?: string | null
}

export interface BuildCompleteData {
  description: string
  success: boolean
  totalAttempts: number
  totalDurationMs: number
  totalTokensInput: number
  totalTokensOutput: number
  workflowName: string | null
  workflowId: string | null
  dryRun: boolean
  credentialsNeeded: number
  warnedRules: number[]
  workflowType?: string | null
}
