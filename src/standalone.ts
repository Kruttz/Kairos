/**
 * Standalone entry point — excludes the Kairos client and its @anthropic-ai/sdk dependency.
 * Use this when you only need validation, the library, or the MCP server and don't want
 * to install @anthropic-ai/sdk.
 *
 * import { N8nValidator, FileLibrary } from '@kairos-sdk/core/standalone'
 */

export { N8nProvider } from './providers/n8n/provider.js'
export { N8nApiClient } from './providers/n8n/api-client.js'
export { N8nFieldStripper } from './providers/n8n/stripper.js'
export type { IProvider } from './providers/types.js'

export { NullLibrary } from './library/null-library.js'
export { FileLibrary, tokenize, buildSearchCorpus } from './library/file-library.js'
export { hybridScore } from './library/scorer.js'
export type { ScoredEntry } from './library/scorer.js'
export { clusterWorkflows, rerank } from './library/cluster.js'
export type { WorkflowCluster } from './library/cluster.js'
export type { IWorkflowLibrary, WorkflowMatch, StoredWorkflow, FailurePattern, WorkflowMetadataInput, SourceKind, TrustLevel, OutcomeData, OutcomeStats, EmbeddingFn, ExecutionTrace } from './library/types.js'

export { N8nValidator } from './validation/validator.js'
export { NodeRegistry, DEFAULT_REGISTRY } from './validation/registry.js'
export type { ValidationResult } from './validation/types.js'
export type { ValidationIssue } from './errors/validation-error.js'

export {
  KairosError,
  GenerationError,
  ResponseParseError,
  ValidationError,
  ProviderError,
  ApiError,
  GuardError,
} from './errors/index.js'

export type {
  N8nWorkflow,
  N8nNode,
  N8nConnections,
  N8nSettings,
  Tag,
} from './types/workflow.js'

export type {
  BuildResult,
  DeployResult,
  WorkflowListItem,
  ExecutionSummary,
  ExecutionDetail,
  CredentialRequirement,
  SmokeTestResult,
  SmokeTestStatus,
} from './types/result.js'

export type {
  ClientOptions,
  BuildOptions,
  DeleteOptions,
  ExecutionFilter,
} from './types/options.js'

export { TemplateSyncer } from './templates/syncer.js'
export type { SyncProgress } from './templates/types.js'

export type { ILogger } from './utils/logger.js'
export { nullLogger } from './utils/logger.js'

export { TelemetryCollector } from './telemetry/collector.js'
export { TelemetryReader } from './telemetry/reader.js'
export type { RuleFailureRate } from './telemetry/reader.js'
export type { TelemetryEvent, AttemptMetadata } from './telemetry/types.js'

export { PatternAnalyzer } from './telemetry/pattern-analyzer.js'
export type {
  Pattern,
  PatternAnalysis,
  PatternState,
  PatternTrend,
  ScoringFactors,
  SessionSummary,
  DriftReport,
  WarningEffectiveness,
} from './telemetry/pattern-analyzer.js'
