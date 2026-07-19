import { readdir, readFile, writeFile, mkdir, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { GuardError } from '../../errors/guard-error.js'
import { CLIENT_ID_PATTERN, SECRET_PATTERNS } from '../../memory/store.js'
import type { N8nWorkflow } from '../../types/workflow.js'
import type { N8nApiClient } from '../../providers/n8n/api-client.js'

/**
 * Opt-in payload capture from real n8n executions. **This is a privacy-posture change, not
 * just another telemetry file** (Codex, 2026-07-19): every trace Kairos already records is
 * deliberately payload-free (names/durations/counts only, never values -- see
 * telemetry/execution-tracer.ts). Capture exists specifically to break that guarantee for
 * the one feature (replay, Phase 2) that structurally cannot work without a real payload to
 * re-inject -- and it does so as narrowly, explicitly, and revocably as that requires:
 *
 * - Never implicit: no existing command's behavior changes. Only `kairos replay capture`
 *   writes anything here, and only when a human explicitly runs it.
 * - Minimized: only the triggering node's own input fields are ever stored (headers, params,
 *   query, body, webhookUrl, executionMode) -- not the rest of the execution, which may
 *   contain far more than what replay needs.
 * - Local-only, permissioned: chmod 600 per file, under this user's own ~/.kairos.
 * - Retention-capped: swept on every capture call, no background process, no unbounded growth.
 * - Scrub is best-effort, and says so: --scrub redacts known secret-shaped substrings (the
 *   same pattern list the memory module refuses to store), which is NOT the same claim as
 *   "PII-free." A customer's name or phone number does not match an API-key regex and will
 *   still be present after scrubbing. Docs must say this plainly, never imply a guarantee
 *   this mechanism cannot make.
 * - Firewalled from sharing: see tests/unit/reliability/module-boundaries.test.ts -- no file
 *   under reliability/community/ (Phase 5) may import this module or read its output
 *   directory, enforced as a standing test, not a comment someone has to remember.
 */

const DEFAULT_MAX_PER_WORKFLOW = 20
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_FETCH_LIMIT = 10

export interface CapturedTriggerPayload {
  headers?: Record<string, unknown>
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  webhookUrl?: string
  executionMode?: string
}

export interface CapturedPayload {
  executionId: string
  capturedAt: string
  triggerNodeName: string
  payload: CapturedTriggerPayload
  /** True only when --scrub was on AND this specific payload actually had something
   * redacted -- lets a reader distinguish "scrub ran, found nothing to redact" from "scrub
   * never ran at all" without re-deriving it from options they may not have access to. */
  scrubbed: boolean
}

export interface CaptureOptions {
  /** How many recent executions to attempt to capture from, not the retention cap -- these
   * are two different numbers on purpose (you might fetch 10 recent executions and still
   * only keep the newest `maxPerWorkflow` after the sweep). */
  limit?: number
  scrub?: boolean
  maxPerWorkflow?: number
  retentionDays?: number
}

export interface CaptureResult {
  captured: CapturedPayload[]
  /** True when this workflow has no webhook trigger. Capture only supports webhook-shaped
   * workflows today -- the only trigger type replay's injection mechanism (Phase 0 spike S3)
   * actually verified end-to-end. An honest, expected outcome for a non-webhook workflow,
   * never a thrown error. */
  skippedNonWebhook: boolean
  /** How many previously-captured files were deleted by this call's retention sweep (over
   * the count cap, or past the age cap) -- reported so a caller can see the sweep actually
   * ran, not just trust that it did. */
  sweptCount: number
}

function assertValidClientId(clientId: string): void {
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new GuardError(
      `Invalid clientId "${clientId}" -- must match ${CLIENT_ID_PATTERN.source}. Rejected before it could be used to construct a file path (fail-closed against path traversal), same discipline as the memory module's own clientId boundary.`,
    )
  }
}

export function captureDir(clientId: string, workflowId: string): string {
  assertValidClientId(clientId)
  return join(homedir(), '.kairos', 'captures', clientId, workflowId)
}

/**
 * Best-effort redaction, reusing the memory module's own secret-pattern list rather than a
 * separate definition of "what counts as a secret" that could silently drift from it.
 * Recurses through arrays/objects; replaces a matching string wholesale with a labeled
 * placeholder (not a partial mask) since these patterns match variable-length tokens where a
 * partial redaction could still leak enough to be useful.
 */
function redactValue(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') {
    for (const [name, pattern] of SECRET_PATTERNS) {
      if (pattern.test(value)) return { value: `[REDACTED: possibly contains ${name}]`, redacted: true }
    }
    return { value, redacted: false }
  }
  if (Array.isArray(value)) {
    let any = false
    const mapped = value.map(v => {
      const r = redactValue(v)
      if (r.redacted) any = true
      return r.value
    })
    return { value: mapped, redacted: any }
  }
  if (value !== null && typeof value === 'object') {
    let any = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = redactValue(v)
      if (r.redacted) any = true
      out[k] = r.value
    }
    return { value: out, redacted: any }
  }
  return { value, redacted: false }
}

/**
 * Walks n8n's real execution.data shape (confirmed live against a sandbox, Phase 0 S1/S3 --
 * data.resultData.runData.<nodeName>[0].data.main[0][0].json) to pull out only the trigger
 * node's own captured request, not the rest of the execution. Returns null (not an empty
 * object) when the shape doesn't match what's expected, so a caller can distinguish "no data
 * here" from "this execution genuinely had an empty payload."
 */
function extractTriggerPayload(execution: { data?: unknown }, triggerNodeName: string): CapturedTriggerPayload | null {
  const data = execution.data as Record<string, unknown> | undefined
  const resultData = data?.['resultData'] as Record<string, unknown> | undefined
  const runData = resultData?.['runData'] as Record<string, unknown[]> | undefined
  const nodeRuns = runData?.[triggerNodeName]
  if (!Array.isArray(nodeRuns) || nodeRuns.length === 0) return null

  const firstRun = nodeRuns[0] as Record<string, unknown>
  const nodeData = firstRun['data'] as Record<string, unknown> | undefined
  const mainOutput = nodeData?.['main'] as unknown[][] | undefined
  const firstItem = mainOutput?.[0]?.[0] as Record<string, unknown> | undefined
  const json = firstItem?.['json'] as Record<string, unknown> | undefined
  if (!json) return null

  return {
    ...(json['headers'] !== undefined ? { headers: json['headers'] as Record<string, unknown> } : {}),
    ...(json['params'] !== undefined ? { params: json['params'] as Record<string, unknown> } : {}),
    ...(json['query'] !== undefined ? { query: json['query'] as Record<string, unknown> } : {}),
    ...(json['body'] !== undefined ? { body: json['body'] } : {}),
    ...(typeof json['webhookUrl'] === 'string' ? { webhookUrl: json['webhookUrl'] } : {}),
    ...(typeof json['executionMode'] === 'string' ? { executionMode: json['executionMode'] } : {}),
  }
}

/** Reads every capture file in a directory, tolerating individually corrupt/unreadable files
 * (skipped, not fatal to the whole listing) -- a capture directory a human might hand-edit
 * or partially clean up shouldn't take down every other function that reads it. */
async function readAllCaptures(dir: string): Promise<Array<{ file: string; entry: CapturedPayload }>> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: Array<{ file: string; entry: CapturedPayload }> = []
  for (const file of files) {
    try {
      out.push({ file, entry: JSON.parse(await readFile(join(dir, file), 'utf-8')) as CapturedPayload })
    } catch {
      continue
    }
  }
  return out
}

/** No background process (C5) -- runs synchronously as part of every capture call instead.
 * Two independent limits, both applied: keep only the newest `maxPerWorkflow` files, AND
 * drop anything older than `retentionDays` regardless of count. */
async function enforceRetention(dir: string, maxPerWorkflow: number, retentionDays: number): Promise<number> {
  const all = await readAllCaptures(dir)
  const sorted = all.sort((a, b) => new Date(b.entry.capturedAt).getTime() - new Date(a.entry.capturedAt).getTime())

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const toDelete = new Set<string>()
  sorted.forEach((item, i) => {
    if (i >= maxPerWorkflow) toDelete.add(item.file)
    if (new Date(item.entry.capturedAt).getTime() < cutoffMs) toDelete.add(item.file)
  })

  for (const file of toDelete) {
    await unlink(join(dir, file)).catch(() => {})
  }
  return toDelete.size
}

/**
 * Captures recent real executions of a webhook-triggered workflow, opt-in, one explicit call
 * at a time. See the module-level doc comment for the full privacy posture this implements.
 */
export async function capturePayloads(
  client: N8nApiClient,
  workflow: N8nWorkflow,
  workflowId: string,
  clientId: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const triggerNode = workflow.nodes.find(n => n.type === 'n8n-nodes-base.webhook')
  if (!triggerNode) {
    return { captured: [], skippedNonWebhook: true, sweptCount: 0 }
  }

  const maxPerWorkflow = options.maxPerWorkflow ?? DEFAULT_MAX_PER_WORKFLOW
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
  const limit = options.limit ?? DEFAULT_FETCH_LIMIT

  const dir = captureDir(clientId, workflowId)
  await mkdir(dir, { recursive: true })

  const summaries = await client.getExecutions(workflowId, { limit })
  const captured: CapturedPayload[] = []

  for (const summary of summaries) {
    const detail = await client.getExecution(summary.id)
    const rawPayload = extractTriggerPayload(detail, triggerNode.name)
    if (!rawPayload) continue

    let payload = rawPayload
    let scrubbed = false
    if (options.scrub) {
      const result = redactValue(rawPayload)
      payload = result.value as CapturedTriggerPayload
      scrubbed = result.redacted
    }

    const entry: CapturedPayload = {
      executionId: summary.id,
      capturedAt: new Date().toISOString(),
      triggerNodeName: triggerNode.name,
      payload,
      scrubbed,
    }

    const filePath = join(dir, `${summary.id}.json`)
    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8')
    await chmod(filePath, 0o600)
    captured.push(entry)
  }

  const sweptCount = await enforceRetention(dir, maxPerWorkflow, retentionDays)

  return { captured, skippedNonWebhook: false, sweptCount }
}

export async function listCapturedPayloads(clientId: string, workflowId: string): Promise<CapturedPayload[]> {
  const dir = captureDir(clientId, workflowId)
  const all = await readAllCaptures(dir)
  return all.map(a => a.entry).sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime())
}

/** Deletes every captured payload for a workflow -- the explicit revocation path. A human
 * (or, later, a client) asking "delete what you captured from me" must have a real answer;
 * this is that answer, not a retention timer they have to wait out. */
export async function deleteCapturedPayloads(clientId: string, workflowId: string): Promise<{ deletedCount: number }> {
  const dir = captureDir(clientId, workflowId)
  const all = await readAllCaptures(dir)
  for (const { file } of all) {
    await unlink(join(dir, file)).catch(() => {})
  }
  return { deletedCount: all.length }
}
