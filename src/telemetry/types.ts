import type { ValidationIssue } from '../errors/validation-error.js'

export interface TelemetryEvent {
  schemaVersion: number
  timestamp: string
  sessionId: string
  runId?: string
  eventType: 'build_start' | 'generation_attempt' | 'build_complete' | 'bundle_exported' | 'preflight_completed' | 'drift_check_completed'
  data: Record<string, unknown>
}

export const TELEMETRY_SCHEMA_VERSION = 4

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

export interface BundleExportedData {
  packName: string
  fileCount: number
  skippedCount: number
  /** Whether writeBundle() stamped the manifest's export-time provenance -- always true for
   * any bundle written by code that includes this event type, kept explicit rather than
   * assumed so a telemetry consumer never has to cross-reference source versions to know. */
  hasProvenance: boolean
}

export interface PreflightCompletedData {
  packName: string
  /** Plain string, not PreflightVerdict -- telemetry/types.ts stays free of imports from
   * pack/ (a higher-level module) the same way it already does for every other event type. */
  verdict: string
  checkCount: number
  failCount: number
  warnCount: number
  live: boolean
}

export interface DriftCheckCompletedData {
  workflowId: string
  /** Plain string, not DriftCheckReport['verdict'] -- same import-boundary discipline as
   * PreflightCompletedData.verdict above. */
  verdict: string
  traceCount: number
  driftingCount: number
  live: boolean
}
