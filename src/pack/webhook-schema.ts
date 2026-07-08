import type { N8nWorkflow } from '../types/workflow.js'
import { findWebhookTrigger } from '../utils/webhook-verify.js'

/**
 * The honest scope of this module (read before extending it): the codebase already
 * investigated and explicitly rejected a fuller version of this idea. The repo-integration
 * plan found that extracting a webhook's required fields from static n8n node metadata is
 * unreliable specifically for the Webhook node -- httpMethod/path aren't marked statically
 * required, and body shape depends on response-mode/content-type the validator "can't
 * reliably see." The existing webhook-body-access prompt guidance (library/sub-patterns.ts)
 * was deliberately kept as LLM prompt text, never turned into an enforced validator rule, for
 * the same reason: "a downstream Set/Code node commonly and legitimately remaps fields to the
 * top level anyway." This module doesn't attempt to solve that ambiguity -- it works around
 * it by being explicit about uncertainty in every output (see DISCLAIMER below), rather than
 * overclaiming a contract this codebase already knows it can't reliably infer.
 */

export interface WebhookFieldRefs {
  body: string[]
  query: string[]
  headers: string[]
}

// Segments allow hyphens (not just \w) since HTTP header/query names conventionally use them
// (x-api-key, x-signature, content-type) -- a plain \w-based path segment would silently
// truncate at the first hyphen.
const FIELD_REF_PATTERN = /\$json\.(body|query|headers)\.([a-zA-Z_$][\w$-]*(?:\.[a-zA-Z_$][\w$-]*)*)/g

/**
 * Walks every node's parameters for expressions referencing $json.body/query/headers,
 * capturing the full nested path after the root (e.g. "$json.body.customer.email" ->
 * body: ["customer.email"]). A fresh, separate implementation from validator.ts's private
 * extractJsonFieldRefs (which only captures one level and is tuned for its own two rules) --
 * do not modify that one for this use case, build here instead.
 */
export function extractWebhookFieldRefs(workflow: N8nWorkflow): WebhookFieldRefs {
  const seen: Record<keyof WebhookFieldRefs, Set<string>> = { body: new Set(), query: new Set(), headers: new Set() }

  const walk = (val: unknown): void => {
    if (typeof val === 'string') {
      const re = new RegExp(FIELD_REF_PATTERN.source, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(val)) !== null) {
        const root = m[1] as keyof WebhookFieldRefs
        seen[root].add(m[2]!)
      }
    } else if (Array.isArray(val)) {
      for (const item of val) walk(item)
    } else if (val !== null && typeof val === 'object') {
      for (const v of Object.values(val as Record<string, unknown>)) walk(v)
    }
  }

  for (const node of workflow.nodes) walk(node.parameters)

  return {
    body: [...seen.body].sort(),
    query: [...seen.query].sort(),
    headers: [...seen.headers].sort(),
  }
}

export const WEBHOOK_INFERENCE_DISCLAIMER =
  "Fields below are inferred from expressions referencing $json.body/$json.query/$json.headers in this workflow. " +
  "This is a best-effort guess, not a verified contract — the actual payload shape depends on the calling system " +
  "and on n8n's webhook response-mode configuration, neither of which this can see. Verify against a real request " +
  'before relying on this in production.'

export interface TestPayload {
  url: string
  method: string
  sampleQuery?: Record<string, string>
  sampleHeaders?: Record<string, string>
  sampleBody?: Record<string, unknown>
  note: string
}

/**
 * Naive placeholder guessing from field name only -- deliberately simple. The value here is
 * getting the field NAMES right (pulled from real workflow logic), not sophisticated fake-data
 * generation; resist expanding this list.
 */
function guessPlaceholder(fieldPath: string): string {
  const lower = fieldPath.toLowerCase()
  if (lower.includes('email')) return 'test@example.com'
  if (lower.includes('phone')) return '555-0100'
  if (lower.includes('name')) return 'Jane Doe'
  if (lower.includes('date') || lower.includes('time')) return new Date().toISOString()
  if (lower.includes('id')) return 'example-id-123'
  return 'example value'
}

/** Query params and headers are always flat in a real HTTP request -- the dotted path itself becomes the key. */
function buildFlatSample(paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.map((p) => [p, guessPlaceholder(p)]))
}

/** A JSON body can genuinely be nested -- "customer.email" becomes { customer: { email: ... } }. */
function buildNestedSample(paths: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const path of paths) {
    const segments = path.split('.')
    let cursor = obj
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!
      if (typeof cursor[seg] !== 'object' || cursor[seg] === null) cursor[seg] = {}
      cursor = cursor[seg] as Record<string, unknown>
    }
    cursor[segments[segments.length - 1]!] = guessPlaceholder(path)
  }
  return obj
}

/**
 * Sample test payload for a webhook-shaped workflow. Returns null for any workflow without a
 * webhook trigger -- this artifact simply doesn't apply, no file should be forced into existence.
 */
export function generateTestPayload(workflow: N8nWorkflow): TestPayload | null {
  const trigger = findWebhookTrigger(workflow)
  if (!trigger) return null

  const refs = extractWebhookFieldRefs(workflow)
  const payload: TestPayload = {
    url: trigger.path,
    method: trigger.httpMethod,
    note: WEBHOOK_INFERENCE_DISCLAIMER,
  }
  if (refs.query.length > 0) payload.sampleQuery = buildFlatSample(refs.query)
  if (refs.headers.length > 0) payload.sampleHeaders = buildFlatSample(refs.headers)
  if (refs.body.length > 0) payload.sampleBody = buildNestedSample(refs.body)

  return payload
}
