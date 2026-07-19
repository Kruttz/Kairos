import { N8nApiClient } from '../../providers/n8n/api-client.js'
import { nullLogger } from '../../utils/logger.js'
import { findWebhookTrigger } from '../../utils/webhook-verify.js'
import { assertNotProduction, importToSandbox, type SandboxConfig, type SandboxImportResult } from '../sandbox/manager.js'
import { listCapturedPayloads, type CapturedPayload } from './capture.js'
import {
  diffPayloadExecution,
  formatPayloadDiffResult,
  type PayloadDiffResult,
  type ReplayExecutionSnapshot,
  type ReplayNodeSnapshot,
  type ReplayVerdict,
} from './diff.js'
import type { N8nWorkflow } from '../../types/workflow.js'

/**
 * Imports a workflow's baseline and candidate versions into the sandbox, replays every
 * previously-captured payload against both, and diffs the results. This is the piece that
 * turns "Kairos detects drift" into "Kairos can test whether a replacement is safe" -- but
 * only as safe as its own guardrails make it, all of them enforced here, not just documented
 * (Codex, 2026-07-19):
 *
 * 1. Cleanup always runs, even on timeout/failure -- both imports are deleted in a `finally`,
 *    independently guarded so one failed delete never blocks the other.
 * 2. Baseline/candidate separation is unmistakable in both the sandbox (workflow names
 *    literally prefixed "baseline:"/"candidate:") and every returned result field.
 * 3. Production is never executed against. Only sandbox-vs-sandbox (see diff.ts's own design
 *    note) -- this module's only network calls are to the sandbox client passed in; captured
 *    payloads are read from disk (capture.ts), never re-fetched live from production during
 *    a replay run. `assertNotProduction` is called again here anyway, defense in depth.
 * 4. Polling for a fresh execution after injection is bounded and backs off -- never a tight
 *    busy-loop, never indefinite.
 * 5. "No execution found" is its own distinct outcome, never silently treated as a pass or
 *    folded into diff.ts's "not reached" (which means something categorically different --
 *    a legitimate untaken branch, not a failure to exercise the payload at all). It forces
 *    the whole run's verdict to INCOMPLETE, overriding whatever the comparable payloads
 *    showed -- a suite can never claim IDENTICAL while quietly failing to test something.
 * 6. Every outcome carries the original captured payload's execution ID AND the two fresh
 *    sandbox execution IDs this run created, for direct traceability back into the sandbox's
 *    own UI/logs if a human wants to dig in.
 * 7. The real return type is a plain structured object; formatReplayRunResult() is a
 *    separate, later step -- never baked into the run logic itself.
 * 8. This module never adds credentials to the sandbox. The whole point of sandbox-vs-sandbox
 *    diffing is comparing both versions under the SAME degraded conditions -- making the
 *    sandbox "more real" by wiring in credentials would silently change what's being tested
 *    without changing production, defeating the comparison. Not a missing feature; a
 *    deliberate non-goal.
 */

export type PayloadReplayStatus = 'compared' | 'no_execution_found'

export interface PayloadReplayOutcome {
  /** The captured payload's own executionId (from capture.ts) -- point 6. */
  payloadId: string
  status: PayloadReplayStatus
  /** The fresh sandbox execution IDs this run created, present only when found -- point 6. */
  baselineExecutionId?: string
  candidateExecutionId?: string
  /** Present only when status === 'compared'. */
  diff?: PayloadDiffResult
  detail: string
}

export type ReplayRunStatus = 'completed' | 'no_captures' | 'not_webhook_shaped'

export interface ReplayRunResult {
  status: ReplayRunStatus
  detail: string
  baselineImportedName?: string
  candidateImportedName?: string
  outcomes: PayloadReplayOutcome[]
  /** 'INCOMPLETE' whenever any outcome is 'no_execution_found' -- point 5. Overrides
   * whatever the comparable payloads' worst verdict would otherwise have been; a run can
   * never report a clean verdict while silently failing to test something. */
  verdict: ReplayVerdict | 'INCOMPLETE' | 'NOT_RUN'
  partialVerification: boolean
}

export interface ReplayRunOptions {
  pollTimeoutMs?: number
  pollIntervalMs?: number
  maxPollIntervalMs?: number
}

const DEFAULT_POLL_TIMEOUT_MS = 20_000
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_MAX_POLL_INTERVAL_MS = 2_000

function typeTag(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function shapeOf(json: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!json) return undefined
  const shape: Record<string, string> = {}
  for (const [k, v] of Object.entries(json)) shape[k] = typeTag(v)
  return shape
}

/** Walks the same real execution.data.resultData.runData shape confirmed live in Phase 0's
 * S1 spike, generalized to every node (capture.ts's extractTriggerPayload only reads the
 * trigger; this reads all of them, since replay needs to compare the whole workflow, not
 * just its input). Reuses the same httpCode-aware error read the tracer/telemetry side of
 * this codebase already established (execution-tracer.ts). */
export function buildSnapshotFromExecution(
  executionId: string,
  execution: { data?: unknown; startedAt?: string; stoppedAt?: string },
): ReplayExecutionSnapshot {
  const data = execution.data as Record<string, unknown> | undefined
  const resultData = data?.['resultData'] as Record<string, unknown> | undefined
  const runData = resultData?.['runData'] as Record<string, unknown[]> | undefined

  const nodes: Record<string, ReplayNodeSnapshot> = {}
  if (runData) {
    for (const [nodeName, runs] of Object.entries(runData)) {
      if (!Array.isArray(runs) || runs.length === 0) continue
      const first = runs[0] as Record<string, unknown>
      const errorObj = first['error'] as Record<string, unknown> | undefined
      if (errorObj) {
        const httpCode = errorObj['httpCode']
        const errorType = (errorObj['name'] as string | undefined)
          ?? (httpCode !== undefined ? `HTTP_${String(httpCode)}` : undefined)
          ?? 'UnknownError'
        nodes[nodeName] = { ran: true, status: 'error', errorType }
        continue
      }
      const nodeData = first['data'] as Record<string, unknown> | undefined
      const mainOutput = nodeData?.['main'] as unknown[][] | undefined
      const firstItem = mainOutput?.[0]?.[0] as Record<string, unknown> | undefined
      const json = firstItem?.['json'] as Record<string, unknown> | undefined
      const outputShape = shapeOf(json)
      nodes[nodeName] = { ran: true, status: 'success', ...(outputShape !== undefined ? { outputShape } : {}) }
    }
  }

  const startedMs = execution.startedAt ? new Date(execution.startedAt).getTime() : undefined
  const stoppedMs = execution.stoppedAt ? new Date(execution.stoppedAt).getTime() : undefined
  const durationMs = startedMs !== undefined && stoppedMs !== undefined ? stoppedMs - startedMs : undefined

  return { executionId, nodes, ...(durationMs !== undefined ? { durationMs } : {}) }
}

export interface SinglePayloadRunOutcome {
  status: 'found' | 'no_execution_found'
  executionId?: string
  snapshot?: ReplayExecutionSnapshot
}

/** Injects one captured payload at one sandbox workflow's webhook, then polls (bounded,
 * backing off) for a fresh execution to appear -- point 4. Never hangs indefinitely; gives
 * up cleanly and honestly at the deadline -- point 5. Exported for direct unit testing (the
 * poll/backoff/timeout logic is real, novel logic worth testing in isolation with a mock
 * client and small real timeouts, rather than only proven via the full live checkpoint). */
export async function replayOnePayload(
  client: N8nApiClient,
  sandboxConfig: SandboxConfig,
  workflowId: string,
  trigger: { path: string; httpMethod: string },
  capture: CapturedPayload,
  options: Required<ReplayRunOptions>,
): Promise<SinglePayloadRunOutcome> {
  assertNotProduction(sandboxConfig.baseUrl)

  const before = await client.getExecutions(workflowId, { limit: 5 })
  const beforeIds = new Set(before.map(e => e.id))

  await client.triggerWebhookProduction(trigger.path, trigger.httpMethod, capture.payload.body ?? {})

  const deadline = Date.now() + options.pollTimeoutMs
  let backoffMs = options.pollIntervalMs
  let freshId: string | undefined

  while (Date.now() < deadline) {
    const executions = await client.getExecutions(workflowId, { limit: 5 })
    const fresh = executions.find(e => !beforeIds.has(e.id))
    if (fresh) {
      freshId = fresh.id
      break
    }
    await new Promise(resolve => setTimeout(resolve, backoffMs))
    backoffMs = Math.min(backoffMs * 1.5, options.maxPollIntervalMs)
  }

  if (!freshId) {
    return { status: 'no_execution_found' }
  }

  const detail = await client.getExecution(freshId)
  return { status: 'found', executionId: freshId, snapshot: buildSnapshotFromExecution(freshId, detail) }
}

/**
 * Full replay run: imports baseline + candidate into the sandbox (clearly named, credentials
 * stripped by importToSandbox -- never added back), replays every capture on file for this
 * workflow against both, diffs each, and always cleans up -- see the module doc for the full
 * guardrail list. `productionWorkflowId` is used only to look up which captures belong to
 * this workflow (capture.ts's own directory keying) -- never to execute anything.
 */
export async function runReplay(
  sandboxConfig: SandboxConfig,
  baselineWorkflow: N8nWorkflow,
  candidateWorkflow: N8nWorkflow,
  productionWorkflowId: string,
  clientId: string,
  options: ReplayRunOptions = {},
): Promise<ReplayRunResult> {
  assertNotProduction(sandboxConfig.baseUrl)

  const resolvedOptions: Required<ReplayRunOptions> = {
    pollTimeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxPollIntervalMs: options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
  }

  const baselineTrigger = findWebhookTrigger(baselineWorkflow)
  const candidateTrigger = findWebhookTrigger(candidateWorkflow)
  if (!baselineTrigger || !candidateTrigger) {
    return {
      status: 'not_webhook_shaped',
      detail: 'Replay only supports webhook-triggered workflows today (the only trigger type verified end-to-end, Phase 0 spike S3). Baseline and/or candidate has no webhook trigger.',
      outcomes: [],
      verdict: 'NOT_RUN',
      partialVerification: false,
    }
  }

  const captures = await listCapturedPayloads(clientId, productionWorkflowId)
  if (captures.length === 0) {
    return {
      status: 'no_captures',
      detail: `No captured payloads found for workflow ${productionWorkflowId} under client "${clientId}". Run "kairos replay capture ${productionWorkflowId} --client-id ${clientId}" first.`,
      outcomes: [],
      verdict: 'NOT_RUN',
      partialVerification: false,
    }
  }

  const client = new N8nApiClient(sandboxConfig.baseUrl, sandboxConfig.apiKey, nullLogger)

  // Point 2: unmistakable naming, both in the sandbox itself and in every returned result.
  let baselineImport: SandboxImportResult | undefined
  let candidateImport: SandboxImportResult | undefined
  const outcomes: PayloadReplayOutcome[] = []

  try {
    baselineImport = await importToSandbox(sandboxConfig, baselineWorkflow, `baseline: ${baselineWorkflow.name ?? 'workflow'}`)
    candidateImport = await importToSandbox(sandboxConfig, candidateWorkflow, `candidate: ${candidateWorkflow.name ?? 'workflow'}`)
    await client.activateWorkflow(baselineImport.id)
    await client.activateWorkflow(candidateImport.id)

    // A candidate is, by definition, normally meant to share baseline's own webhook path in
    // production -- importToSandbox rewrites each to a unique path specifically so both can
    // be active in the sandbox at once (confirmed live: without the rewrite, n8n correctly
    // refuses the second activation with a 409 webhook conflict). Inject against each
    // import's OWN resolved trigger, never the original workflow's `parameters.path`, which
    // is no longer what's actually registered.
    const baselineInjectionTrigger = baselineImport.webhookTrigger ?? baselineTrigger
    const candidateInjectionTrigger = candidateImport.webhookTrigger ?? candidateTrigger

    for (const capture of captures) {
      const baselineOutcome = await replayOnePayload(client, sandboxConfig, baselineImport.id, baselineInjectionTrigger, capture, resolvedOptions)
      const candidateOutcome = await replayOnePayload(client, sandboxConfig, candidateImport.id, candidateInjectionTrigger, capture, resolvedOptions)

      if (baselineOutcome.status !== 'found' || candidateOutcome.status !== 'found') {
        outcomes.push({
          payloadId: capture.executionId,
          status: 'no_execution_found',
          ...(baselineOutcome.executionId ? { baselineExecutionId: baselineOutcome.executionId } : {}),
          ...(candidateOutcome.executionId ? { candidateExecutionId: candidateOutcome.executionId } : {}),
          detail: `No fresh execution appeared within ${resolvedOptions.pollTimeoutMs}ms for ${baselineOutcome.status !== 'found' ? 'baseline' : ''}${baselineOutcome.status !== 'found' && candidateOutcome.status !== 'found' ? ' and ' : ''}${candidateOutcome.status !== 'found' ? 'candidate' : ''}. Treated as unverified, not as a pass.`,
        })
        continue
      }

      // Both are 'found' here (the branch above handled every other case and `continue`d),
      // so executionId/snapshot are guaranteed set by replayOnePayload's own contract.
      const diff = diffPayloadExecution(capture.executionId, baselineWorkflow, candidateWorkflow, baselineOutcome.snapshot!, candidateOutcome.snapshot!)
      outcomes.push({
        payloadId: capture.executionId,
        status: 'compared',
        ...(baselineOutcome.executionId ? { baselineExecutionId: baselineOutcome.executionId } : {}),
        ...(candidateOutcome.executionId ? { candidateExecutionId: candidateOutcome.executionId } : {}),
        diff,
        detail: `Compared successfully -- verdict ${diff.verdict}.`,
      })
    }
  } finally {
    // Point 1: always cleaned up, even on error/timeout above -- each deletion independently
    // guarded so one failing delete can never block the other.
    if (baselineImport) await client.deleteWorkflow(baselineImport.id).catch(() => {})
    if (candidateImport) await client.deleteWorkflow(candidateImport.id).catch(() => {})
  }

  const hasIncomplete = outcomes.some(o => o.status === 'no_execution_found')
  const comparedVerdicts = outcomes.filter(o => o.status === 'compared').map(o => o.diff!.verdict)
  const severity: Record<ReplayVerdict, number> = { IDENTICAL: 0, BENIGN_VARIANCE: 1, BEHAVIORAL_CHANGE: 2, BROKEN: 3 }
  const worstComparedVerdict = comparedVerdicts.reduce<ReplayVerdict>(
    (worst, v) => (severity[v] > severity[worst] ? v : worst),
    'IDENTICAL',
  )

  return {
    status: 'completed',
    detail: `Replayed ${captures.length} captured payload(s) against baseline and candidate.`,
    baselineImportedName: baselineImport?.name,
    candidateImportedName: candidateImport?.name,
    outcomes,
    // Point 5: an incomplete run can never report a clean comparable verdict.
    verdict: hasIncomplete ? 'INCOMPLETE' : worstComparedVerdict,
    partialVerification: hasIncomplete || outcomes.some(o => o.diff?.partialVerification === true),
  }
}

export function formatReplayRunResult(result: ReplayRunResult): string {
  if (result.status !== 'completed') {
    return `Replay: ${result.status.toUpperCase()} -- ${result.detail}`
  }

  const lines: string[] = []
  const marker = result.verdict === 'INCOMPLETE'
    ? ' -- INCOMPLETE: at least one payload could not be executed and was not verified'
    : result.partialVerification ? ' (some payloads had partial verification)' : ''
  lines.push(`Replay run verdict: ${result.verdict}${marker}`)
  lines.push(`Baseline: ${result.baselineImportedName ?? '(unknown)'}`)
  lines.push(`Candidate: ${result.candidateImportedName ?? '(unknown)'}`)
  lines.push(`${result.outcomes.length} payload(s) attempted.`)
  lines.push('')

  for (const o of result.outcomes) {
    if (o.status === 'no_execution_found') {
      lines.push(`✗ Payload ${o.payloadId}: NO EXECUTION FOUND -- ${o.detail}`)
      if (o.baselineExecutionId) lines.push(`  baseline execution: ${o.baselineExecutionId}`)
      if (o.candidateExecutionId) lines.push(`  candidate execution: ${o.candidateExecutionId}`)
      lines.push('')
      continue
    }
    lines.push(`baseline execution: ${o.baselineExecutionId} | candidate execution: ${o.candidateExecutionId}`)
    lines.push(formatPayloadDiffResult(o.diff!))
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

interface FieldChanges {
  added: string[]
  removed: string[]
  typeChanged: Array<{ field: string; from: string; to: string }>
}

function computeFieldChanges(baseline: Record<string, string> = {}, candidate: Record<string, string> = {}): FieldChanges {
  const added = Object.keys(candidate).filter(k => !(k in baseline))
  const removed = Object.keys(baseline).filter(k => !(k in candidate))
  const typeChanged = Object.keys(baseline)
    .filter(k => k in candidate && baseline[k] !== candidate[k])
    .map(k => ({ field: k, from: baseline[k]!, to: candidate[k]! }))
  return { added, removed, typeChanged }
}

const VERDICT_PLAIN_LANGUAGE: Record<ReplayVerdict | 'INCOMPLETE' | 'NOT_RUN', string> = {
  IDENTICAL: '✅ SAFE TO DEPLOY -- no behavioral differences detected.',
  BENIGN_VARIANCE: '✅ SAFE TO DEPLOY -- only minor timing differences detected, no behavior change.',
  BEHAVIORAL_CHANGE: '⚠️  REVIEW BEFORE DEPLOYING -- this candidate behaves differently than the current version.',
  BROKEN: '❌ DO NOT DEPLOY -- this candidate fails in cases where the current version succeeds.',
  INCOMPLETE: '❓ INCONCLUSIVE -- at least one test could not be run at all.',
  NOT_RUN: '❓ NOT RUN -- no comparison was performed.',
}

function nextAction(result: ReplayRunResult): string {
  switch (result.status) {
    case 'no_captures':
      return 'Capture at least one real payload first: kairos replay capture <workflow-id>.'
    case 'not_webhook_shaped':
      return 'Replay only supports webhook-triggered workflows today. No action available for this workflow.'
    case 'completed':
      switch (result.verdict) {
        case 'IDENTICAL':
        case 'BENIGN_VARIANCE':
          return result.partialVerification
            ? 'Deploy is reasonable, but review the unverified step(s) below manually first -- they were never actually exercised by this test.'
            : 'Deploy with confidence -- every step was tested and nothing changed.'
        case 'BEHAVIORAL_CHANGE':
          return 'Review the changed step(s) below with a human before deploying. If the change is intentional, deploy; if not, fix the candidate and re-test.'
        case 'BROKEN':
          return 'Do not deploy this candidate as-is. Fix the failure(s) below and re-run the replay test.'
        case 'INCOMPLETE':
          return 'Re-run the replay test -- at least one payload never produced a result, so this run cannot be trusted either way.'
        case 'NOT_RUN':
          return 'No comparison was performed. This should not happen for a completed run -- please report this.'
      }
  }
}

/**
 * The primary, default human-readable output for `kairos replay run` -- built specifically
 * for an operator or client reading a report, not a developer debugging (that's what
 * formatReplayRunResult/formatPayloadDiffResult are for, still available via --verbose).
 * Required content (Jordan/Codex, 2026-07-19): verdict, full vs. partial verification,
 * payload count tested, changed nodes (in a field-level breakdown, not raw JSON), unverifiable
 * nodes with plain-language reasons, and an exact next action -- every one of these is always
 * present in the output, never optional/buried.
 */
export function formatReplayReportForHumans(result: ReplayRunResult): string {
  const lines: string[] = []
  lines.push('=== Replay Test Report ===')
  lines.push('')

  if (result.status !== 'completed') {
    lines.push(`Result: ${result.status === 'no_captures' ? 'No test data available' : 'Not applicable'}`)
    lines.push(result.detail)
    lines.push('')
    lines.push(`Next action: ${nextAction(result)}`)
    return lines.join('\n')
  }

  const comparedCount = result.outcomes.filter(o => o.status === 'compared').length
  const incompleteCount = result.outcomes.filter(o => o.status === 'no_execution_found').length

  lines.push(VERDICT_PLAIN_LANGUAGE[result.verdict])
  lines.push('')
  lines.push(`Verification: ${result.partialVerification ? 'PARTIAL -- see "Not verified" below' : 'FULL -- every step in every tested payload was exercised'}`)
  lines.push(`Payloads tested: ${comparedCount} compared${incompleteCount > 0 ? `, ${incompleteCount} could not be run at all` : ''} (out of ${result.outcomes.length} attempted, using real payloads captured from production)`)
  lines.push('')

  const changedNodes = new Map<string, { baseline?: Record<string, string>; candidate?: Record<string, string>; detail: string }>()
  const unverifiableNodes = new Map<string, string>()
  for (const o of result.outcomes) {
    if (o.status !== 'compared') continue
    for (const nd of o.diff!.nodeDiffs) {
      if (nd.status === 'changed' && !changedNodes.has(nd.node)) {
        changedNodes.set(nd.node, {
          ...(nd.baselineOutputShape ? { baseline: nd.baselineOutputShape } : {}),
          ...(nd.candidateOutputShape ? { candidate: nd.candidateOutputShape } : {}),
          detail: nd.detail,
        })
      }
      if (nd.status === 'unverifiable' && !unverifiableNodes.has(nd.node)) {
        unverifiableNodes.set(nd.node, nd.detail)
      }
    }
  }

  if (changedNodes.size > 0) {
    lines.push(`Changed step(s):`)
    for (const [node, info] of changedNodes) {
      lines.push(`  • ${node}`)
      if (info.baseline && info.candidate) {
        const { added, removed, typeChanged } = computeFieldChanges(info.baseline, info.candidate)
        if (added.length) lines.push(`      + new field(s): ${added.join(', ')}`)
        if (removed.length) lines.push(`      - removed field(s): ${removed.join(', ')}`)
        for (const t of typeChanged) lines.push(`      ~ ${t.field} changed type: ${t.from} -> ${t.to}`)
        if (!added.length && !removed.length && !typeChanged.length) lines.push(`      ${info.detail}`)
      } else {
        lines.push(`      ${info.detail}`)
      }
    }
    lines.push('')
  }

  if (unverifiableNodes.size > 0) {
    lines.push(`Not verified (these steps could not be meaningfully tested in this environment):`)
    for (const [node, detail] of unverifiableNodes) {
      lines.push(`  • ${node} -- ${detail}`)
    }
    lines.push('')
  }

  if (incompleteCount > 0) {
    lines.push(`Could not run at all: ${incompleteCount} payload(s) -- treated as unverified, not as a pass. See --verbose for details.`)
    lines.push('')
  }

  lines.push(`Next action: ${nextAction(result)}`)
  return lines.join('\n')
}
