import type { ILogger } from '../utils/logger.js'
import type { IWorkflowLibrary } from '../library/types.js'
import type { NodeRegistry } from '../validation/registry.js'
import type { WorkflowReference } from '../pack/workflow-reference.js'

export interface ClientOptions {
  anthropicApiKey: string
  n8nBaseUrl?: string
  n8nApiKey?: string
  model?: string
  /** Max output tokens for the generation call (default: 16000, or KAIROS_MAX_TOKENS). Raise
   * this if you see "Claude response was truncated (max_tokens reached)" on large workflows. */
  maxTokens?: number
  /** Timeout in ms for the generation call (default: 300000, or KAIROS_TIMEOUT_MS). Raise this
   * if you see "Anthropic API call failed: Request was aborted" on large, many-integration
   * workflows — larger maxTokens responses take longer to stream. */
  timeoutMs?: number
  logger?: ILogger
  library?: IWorkflowLibrary
  telemetry?: boolean | string
  /** Override the node-type registry validation uses during generation — e.g. a registry
   * synced from a live n8n instance via `kairos sync-nodes`. Defaults to the built-in
   * static registry when omitted. */
  nodeRegistry?: NodeRegistry
  /** Enables the per-client persistent memory layer (or KAIROS_CLIENT_ID env var) — must
   * match ^[a-z0-9][a-z0-9-]{0,63}$. Builds/replaces read relevant prior context into the
   * prompt and write a history entry after each successful deploy. Omit to leave memory
   * fully inert (default — no filesystem access, no behavior change). */
  clientId?: string
}

export interface BuildOptions {
  dryRun?: boolean
  activate?: boolean
  name?: string
  smokeTest?: boolean
  /** Pack-chaining context: specific prior workflows in the same pack this build should be
   * able to reference (real webhook path/method/URL, node names, credentials used) --
   * populated by PackBuilder's build loop from resolveBuildOrder()'s validated dependsOn, not
   * meant to be constructed by hand for a single build() call. Never a full N8nWorkflow JSON.
   * See docs/plans/hardening-and-chaining-plan.md Step 7 v4 §§4,6. */
  priorContext?: WorkflowReference[]
}

export interface DeleteOptions {
  confirm: true
}

export interface ExecutionFilter {
  status?: 'success' | 'error' | 'waiting' | 'running'
  limit?: number
  cursor?: string
}
