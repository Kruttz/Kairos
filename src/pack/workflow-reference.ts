import type { BuildResult } from '../types/result.js'
import { findWebhookTrigger } from '../utils/webhook-verify.js'
import { buildWebhookUrl } from '../utils/webhook-url.js'

/**
 * What a downstream workflow in the same pack is allowed to know about a workflow it declared
 * a dependency on -- never the full N8nWorkflow JSON (src/pack/pack-builder.ts's
 * dependency-graph design, docs/plans/hardening-and-chaining-plan.md Step 7 v4 §4).
 */
export interface WorkflowReference {
  workflowKey: string
  workflowName: string
  /**
   * True only when this workflow was actually deployed to n8n (dryRun: false at build time).
   * When false, workflowId/webhookUrl are always null/absent -- this is the field that
   * distinguishes "never deployed" (fine, expected in a dry-run pack) from "build failed"
   * (which is a different, 'unavailable' condition entirely -- see the pack-builder loop's
   * cascading availability gate). Never conflate the two: a dry-run workflow is fully
   * available for chaining at the content level, just missing deploy-time fields.
   */
  deployed: boolean
  workflowId: string | null
  httpMethod?: string
  webhookPath?: string
  webhookUrl?: string
  nodeNames: string[]
  credentialsUsed: string[]
}

/**
 * Builds a WorkflowReference from a completed BuildResult. workflowKey is passed in rather
 * than derived here -- BuildResult has no notion of pack-level workflow keys, that's assigned
 * during plan normalization (src/pack/pack-builder.ts).
 *
 * webhookUrl is only ever populated when the workflow was actually deployed (result.dryRun is
 * false) AND a base URL is known -- never fabricated or guessed. A dry-run workflow still gets
 * httpMethod/webhookPath (both derivable from the generated JSON alone, no deploy needed), just
 * not a callable URL, since nothing was actually registered with n8n yet.
 */
export function toWorkflowReference(result: BuildResult, workflowKey: string, n8nBaseUrl?: string): WorkflowReference {
  const deployed = !result.dryRun
  const trigger = findWebhookTrigger(result.workflow)
  const credentialsUsed = [...new Set(
    result.workflow.nodes.flatMap((n) => Object.keys(n.credentials ?? {})),
  )]

  return {
    workflowKey,
    workflowName: result.name,
    deployed,
    workflowId: result.workflowId,
    ...(trigger ? { httpMethod: trigger.httpMethod, webhookPath: trigger.path } : {}),
    ...(trigger && deployed && n8nBaseUrl ? { webhookUrl: buildWebhookUrl(n8nBaseUrl, trigger.path) } : {}),
    nodeNames: result.workflow.nodes.map((n) => n.name),
    credentialsUsed,
  }
}
