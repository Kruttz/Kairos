import type { BuildResult } from '../types/result.js'
import { findWebhookTrigger } from '../utils/webhook-verify.js'
import { buildWebhookUrl } from '../utils/webhook-url.js'

/**
 * What a downstream workflow in the same pack is allowed to know about a workflow it declared
 * a dependency on -- never the full N8nWorkflow JSON (src/pack/pack-builder.ts's
 * dependency-graph design, docs/plans/hardening-and-chaining-plan.md Step 7 v4 §4).
 *
 * Three distinct lifecycle states this type must be able to represent, corrected after an
 * earlier draft conflated "deployed" with "live" and implied webhookUrl meant "callable":
 *   1. Dry-run -- deployed: false, activated: false. Nothing was created in n8n. Only the
 *      relative httpMethod/webhookPath are known (derivable from generated JSON alone);
 *      webhookUrl is never populated, since there is no real n8n instance to construct a
 *      meaningful endpoint against.
 *   2. Deployed but inactive -- deployed: true, activated: false. The workflow exists in n8n
 *      and webhookUrl is a real, deterministically-constructed endpoint string, but the
 *      workflow has not been activated -- that endpoint will not actually respond yet.
 *   3. Activated -- deployed: true, activated: true. The workflow is live. webhookUrl is still
 *      just the deterministic endpoint, not proof of anything beyond that: whether the
 *      specific webhook is registered, reachable, or actually callable is a SEPARATE fact
 *      (webhookVerified) that only exists when an explicit reachability probe ran.
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
   *
   * deployed alone does NOT mean live -- see `activated`.
   */
  deployed: boolean
  /**
   * True only when the workflow was both deployed AND activation was requested and actually
   * succeeded (BuildResult.activationRequired being false at this point already guarantees
   * success, since a real activation failure throws DeployActivationError before a BuildResult
   * is ever returned -- see Kairos.build()). A deployed-but-not-activated workflow still has a
   * real webhookUrl (the endpoint deterministically exists), it just won't respond to
   * requests yet.
   */
  activated: boolean
  /**
   * Set only when the upstream build's own webhook-reachability probe actually ran (see
   * BuildResult.webhookVerification -- only populated for a webhook-triggered workflow built
   * with activate: true). Most builds never run this probe, so most references will have this
   * field entirely absent even when activated is true -- absence must be read as "never
   * checked," never as "confirmed unreachable." true/false/null mirror
   * WebhookReachabilityResult.reachable exactly (null = the probe itself failed to determine
   * an answer, a distinct case from a confirmed unreachable result).
   */
  webhookVerified?: boolean | null
  workflowId: string | null
  httpMethod?: string
  webhookPath?: string
  /**
   * The deterministic n8n production endpoint URL for this workflow's webhook -- constructed
   * from a known base URL and the workflow's real path, exactly like
   * N8nApiClient.triggerWebhookProduction() constructs it. This is NOT proof the workflow is
   * active, that its webhook is registered with n8n, or that the endpoint is currently
   * reachable or callable -- those are the separate `activated`/`webhookVerified` facts above.
   * Populated once the workflow is deployed and a base URL is known, regardless of whether it
   * has been activated yet (state 2 above) -- the URL string itself doesn't depend on
   * activation state, only on the workflow having a real, known path.
   */
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
 * not a URL, since nothing was actually registered with n8n yet. See the WorkflowReference doc
 * comment for the full three-state breakdown this function's output must support.
 */
export function toWorkflowReference(result: BuildResult, workflowKey: string, n8nBaseUrl?: string): WorkflowReference {
  const deployed = !result.dryRun
  const activated = deployed && !result.activationRequired
  const trigger = findWebhookTrigger(result.workflow)
  const credentialsUsed = [...new Set(
    result.workflow.nodes.flatMap((n) => Object.keys(n.credentials ?? {})),
  )]

  return {
    workflowKey,
    workflowName: result.name,
    deployed,
    activated,
    ...(result.webhookVerification ? { webhookVerified: result.webhookVerification.reachable } : {}),
    workflowId: result.workflowId,
    ...(trigger ? { httpMethod: trigger.httpMethod, webhookPath: trigger.path } : {}),
    ...(trigger && deployed && n8nBaseUrl ? { webhookUrl: buildWebhookUrl(n8nBaseUrl, trigger.path) } : {}),
    nodeNames: result.workflow.nodes.map((n) => n.name),
    credentialsUsed,
  }
}
