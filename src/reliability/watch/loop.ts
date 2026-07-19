import { fetchLatestTrace, mergeTraces } from '../../telemetry/execution-tracer.js'
import { buildDriftCheckReport, type DriftCheckReport } from '../drift/report.js'
import { appendReliabilityAudit, type WatchTickAuditEntry } from './audit.js'
import type { ExecutionTrace } from '../../library/types.js'

/**
 * Phase 6, corrected scope (2026-07-19, Codex): detect -> diagnose -> notify -> audit only.
 * No propose/apply/rollback -- that's Phase 3 (`drift/repair.ts`), which does not exist yet and
 * now builds *after* this phase (Jordan's resequencing call, same date). This module composes
 * already-shipped, already-tested modules -- `buildDriftCheckReport()` (which internally calls
 * `diagnoseAll()`) -- rather than adding any new drift-detection or diagnosis logic of its own.
 *
 * Boring and safe by construction: this module never writes to a live workflow, never calls
 * anything from a not-yet-built repair module, and treats insufficient_data/not_applicable
 * exactly as the underlying report already does -- as non-findings, never surfaced as alerts.
 */

export interface WatchTarget {
  /** The FileLibrary entry id -- needed only to call `recordTrace()` back onto the right entry. */
  libraryId: string
  n8nWorkflowId: string
  workflowName?: string
  /** Trace history as of the start of this tick. The loop fetches one fresh trace (mirroring
   * `kairos drift check --live`) and merges it in -- it does not re-read the whole library
   * index per workflow; that's the caller's job, once per tick, not once per target. */
  existingTraces: ExecutionTrace[]
}

export type WatchTickStatus = 'checked' | 'fetch_failed'

export interface WatchTickResult {
  workflowId: string
  workflowName?: string
  checkedAt: string
  status: WatchTickStatus
  /** Present only when status === 'checked'. */
  report?: DriftCheckReport
  detail: string
}

export interface WatchTraceRecorder {
  recordTrace(libraryId: string, trace: ExecutionTrace): Promise<void>
}

/**
 * The pure decision logic for one target, given the outcome of a (possibly failed) live fetch
 * -- separated from `runWatchTick`'s network-calling loop so it's directly unit testable
 * without mocking `fetchLatestTrace`'s internal N8nApiClient construction (matches how
 * `replay/runner.ts` split `buildSnapshotFromExecution` (pure, tested) from `replayOnePayload`
 * (network, live-checkpointed) in Phase 2).
 */
export function buildTickResult(target: WatchTarget, latest: ExecutionTrace | null, checkedAt: string): WatchTickResult {
  const traces = latest ? mergeTraces(target.existingTraces, latest) : target.existingTraces

  if (!latest && target.existingTraces.length === 0) {
    return {
      workflowId: target.n8nWorkflowId,
      ...(target.workflowName ? { workflowName: target.workflowName } : {}),
      checkedAt,
      status: 'fetch_failed',
      detail: 'No executions found for this workflow (checked live, none on record either) -- nothing to evaluate yet.',
    }
  }

  const report = buildDriftCheckReport(
    { workflowId: target.n8nWorkflowId, ...(target.workflowName ? { workflowName: target.workflowName } : {}) },
    { traces },
  )

  return {
    workflowId: target.n8nWorkflowId,
    ...(target.workflowName ? { workflowName: target.workflowName } : {}),
    checkedAt,
    status: 'checked',
    report,
    detail: `Checked -- verdict ${report.verdict} (${report.traceCount} trace(s) on record).`,
  }
}

function toAuditEntry(result: WatchTickResult): WatchTickAuditEntry {
  const driftingCheckIds = result.report?.findings.filter(f => f.status === 'drifting').map(f => f.id)
  return {
    kind: 'watch_tick',
    ts: result.checkedAt,
    workflowId: result.workflowId,
    ...(result.workflowName ? { workflowName: result.workflowName } : {}),
    status: result.status,
    ...(result.report ? { verdict: result.report.verdict } : {}),
    ...(driftingCheckIds?.length ? { driftingCheckIds } : {}),
    detail: result.detail,
  }
}

/**
 * One pass over a list of watch targets: refresh each workflow's trace history with the latest
 * live execution (best-effort -- a fetch failure or a workflow with no fresh execution since
 * the last tick is not an error, it's the normal steady state for anything that doesn't run on
 * every tick interval), run all 9 drift checks + diagnosis via the same pathway
 * `kairos drift check --live` already uses, and audit every result regardless of verdict (G6,
 * and the explicit "log each check/result" requirement) before returning.
 */
export async function runWatchTick(
  lib: WatchTraceRecorder,
  targets: WatchTarget[],
  n8nBaseUrl: string,
  n8nApiKey: string,
  auditPath?: string,
  // Injectable for tests -- defaults to the real fetchLatestTrace, which constructs its own
  // N8nApiClient internally and so can't be exercised without a real network call otherwise.
  fetchTrace: typeof fetchLatestTrace = fetchLatestTrace,
): Promise<WatchTickResult[]> {
  const results: WatchTickResult[] = []

  for (const target of targets) {
    const checkedAt = new Date().toISOString()
    const latest = await fetchTrace(target.n8nWorkflowId, n8nBaseUrl, n8nApiKey)
    if (latest) await lib.recordTrace(target.libraryId, latest)

    results.push(buildTickResult(target, latest, checkedAt))
  }

  try {
    await appendReliabilityAudit(results.map(toAuditEntry), auditPath)
  } catch {
    // Best-effort, matching telemetry's "must never break a real result" discipline -- an
    // audit-write failure must never prevent the tick's own results from being returned.
  }

  return results
}
