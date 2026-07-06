import type { N8nWorkflow } from '../types/workflow.js'

export interface WebhookReachabilityResult {
  /** null = the probe itself failed (network error, timeout) -- genuinely unknown, not a confirmed failure */
  reachable: boolean | null
  statusCode?: number
  detail: string
}

const WEBHOOK_NOT_REGISTERED_PATTERN = /is not registered/i

export function findWebhookTrigger(workflow: N8nWorkflow): { path: string; httpMethod: string } | null {
  const node = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook')
  if (!node) return null
  const params = node.parameters as Record<string, unknown> | undefined
  const path = typeof params?.['path'] === 'string' ? params['path'] : 'webhook'
  const httpMethod = typeof params?.['httpMethod'] === 'string' ? params['httpMethod'].toUpperCase() : 'POST'
  return { path, httpMethod }
}

/**
 * Distinguishes n8n's specific "webhook not registered" 404 (a real activation/registration
 * gap) from any other response. Any other status -- including a 4xx/5xx from the workflow's
 * own logic -- still proves the route dispatched the request, which is the only thing this
 * checks: registration, not business-logic correctness.
 */
export function interpretWebhookProbe(statusCode: number, body: string): WebhookReachabilityResult {
  if (statusCode === 404 && WEBHOOK_NOT_REGISTERED_PATTERN.test(body)) {
    return {
      reachable: false,
      statusCode,
      detail:
        'n8n reports this workflow as active, but its production webhook returned 404 "not registered" — ' +
        'the route was not actually wired up. This is a known n8n platform gap, not a Kairos error; the ' +
        'active flag alone cannot be trusted for webhook-triggered workflows.',
    }
  }
  return { reachable: true, statusCode, detail: `Production webhook responded with HTTP ${statusCode}.` }
}

/**
 * Fires one real request at a workflow's production webhook URL to verify it's actually
 * reachable -- n8n's `active: true` on a workflow does not reliably mean its webhook route
 * was registered (confirmed directly against a live instance: survived a manual UI toggle,
 * a fresh path, and a deactivate/reactivate cycle, still 404ing "not registered" every time).
 * Never throws -- a probe failure degrades to `reachable: null`, not an exception.
 */
export async function verifyWebhookReachable(
  client: { triggerWebhookProduction(path: string, httpMethod: string): Promise<{ statusCode: number; body: string }> },
  workflow: N8nWorkflow,
): Promise<WebhookReachabilityResult | null> {
  const trigger = findWebhookTrigger(workflow)
  if (!trigger) return null
  try {
    const { statusCode, body } = await client.triggerWebhookProduction(trigger.path, trigger.httpMethod)
    return interpretWebhookProbe(statusCode, body)
  } catch (err) {
    return { reachable: null, detail: `Could not verify — probe request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
