/**
 * Builds n8n's production webhook URL for a given base URL and path -- extracted from
 * N8nApiClient.triggerWebhookProduction()'s original inline logic so it has exactly one
 * implementation, reused by both that method and pack-chaining's WorkflowReference
 * construction (src/pack/workflow-reference.ts). Two independent implementations of the same
 * URL-join is exactly the kind of duplication that silently drifts apart over time.
 */
export function buildWebhookUrl(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl.replace(/\/$/, '')}/webhook${cleanPath}`
}
