import type { ILogger } from '../utils/logger.js'
import type { IWorkflowLibrary } from '../library/types.js'
import type { NodeRegistry } from '../validation/registry.js'

export interface ClientOptions {
  anthropicApiKey: string
  n8nBaseUrl?: string
  n8nApiKey?: string
  model?: string
  /** Max output tokens for the generation call (default: 16000, or KAIROS_MAX_TOKENS). Raise
   * this if you see "Claude response was truncated (max_tokens reached)" on large workflows. */
  maxTokens?: number
  logger?: ILogger
  library?: IWorkflowLibrary
  telemetry?: boolean | string
  /** Override the node-type registry validation uses during generation — e.g. a registry
   * synced from a live n8n instance via `kairos sync-nodes`. Defaults to the built-in
   * static registry when omitted. */
  nodeRegistry?: NodeRegistry
}

export interface BuildOptions {
  dryRun?: boolean
  activate?: boolean
  name?: string
  smokeTest?: boolean
}

export interface DeleteOptions {
  confirm: true
}

export interface ExecutionFilter {
  status?: 'success' | 'error' | 'waiting' | 'running'
  limit?: number
  cursor?: string
}
