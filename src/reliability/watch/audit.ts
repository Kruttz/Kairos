import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { DriftCheckId } from '../drift/checks.js'

/**
 * The G6 audit trail (docs/plans/reliability-suite-plan.md 12): every automated observation
 * this codebase makes, appended one JSON line per entry, never read back by any decision-making
 * code path except the repair ladder's own auto-mode cooldown/one-attempt-per-cause gate (which
 * reads its own prior `repair_write` entries as its one source of truth, rather than a second,
 * parallel state file -- see `apply.ts`) -- otherwise purely a record for a human to inspect
 * later ("why did Kairos say X" / "what did Kairos do and why"). Same conventions as
 * telemetry/pattern-analyzer.ts's pattern-audit.jsonl (append-only JSONL, best-effort,
 * timestamped) -- a second instance of the same pattern, not a new one.
 *
 * `kind` is a discriminated union. Started with a single member (`watch_tick`, Phase 6); Phase 3
 * (self-healing) adds six more here, one per rung of the apply ladder (docs/plans/
 * reliability-suite-plan.md 8.4) -- literal "audit every step" (Codex, 2026-07-19), not one
 * summary entry per `repair apply` invocation.
 */

export interface WatchTickAuditEntry {
  kind: 'watch_tick'
  ts: string
  workflowId: string
  workflowName?: string
  status: 'checked' | 'fetch_failed'
  /** Absent when status !== 'checked'. */
  verdict?: 'HEALTHY' | 'DRIFTING'
  /** Check IDs with status 'drifting' this tick -- empty/absent when verdict is HEALTHY or
   * status is fetch_failed. Never includes insufficient_data/not_applicable check IDs; those
   * are not findings, matching the 4-state discipline (Jordan/Codex, 2026-07-19). */
  driftingCheckIds?: string[]
  detail: string
}

/** A `repair propose` call produced (or refused to produce -- see `detail`) a proposal. */
export interface RepairProposeAuditEntry {
  kind: 'repair_propose'
  ts: string
  workflowId: string
  workflowName?: string
  checkId: DriftCheckId
  riskLevel?: 'low' | 'medium' | 'high'
  verificationAvailability?: 'available' | 'no_webhook_trigger' | 'no_captures' | 'sandbox_unavailable'
  /** False only for the internal-consistency refusal case (proposedMatchesStored was false,
   * §8.2a) -- a real bug, not a normal "nothing to propose" outcome. */
  produced: boolean
  detail: string
}

/** A snapshot was taken before a live write (repair-apply's own write, or a standalone
 * `kairos rollback`'s restore). */
export interface RepairSnapshotAuditEntry {
  kind: 'repair_snapshot'
  ts: string
  workflowId: string
  workflowName?: string
  snapshotPath: string
  detail: string
}

/** The replay-verification step ran (or was skipped/unavailable) before a write. */
export interface RepairVerifyAuditEntry {
  kind: 'repair_verify'
  ts: string
  workflowId: string
  workflowName?: string
  checkId: DriftCheckId
  status: 'verified' | 'unverifiable' | 'skipped'
  /** Present only when status === 'verified' or a replay run actually completed. */
  replayVerdict?: string
  partialVerification?: boolean
  detail: string
}

/** The live write itself happened -- the one rung in this whole arc that changes a live
 * workflow. `confirmedBy` records exactly which of the three explicit paths authorized it. */
export interface RepairWriteAuditEntry {
  kind: 'repair_write'
  ts: string
  workflowId: string
  workflowName?: string
  checkId: DriftCheckId
  auto: boolean
  confirmedBy: 'human_prompt' | 'yes_flag' | 'auto_flag'
  detail: string
}

/** Post-apply structural verification ran. */
export interface RepairPostVerifyAuditEntry {
  kind: 'repair_post_verify'
  ts: string
  workflowId: string
  workflowName?: string
  checkId: DriftCheckId
  passed: boolean
  detail: string
}

/** A snapshot was restored -- either repair-apply's own auto-rollback on a failed post-verify,
 * or a standalone `kairos rollback` invocation. */
export interface RepairRollbackAuditEntry {
  kind: 'repair_rollback'
  ts: string
  workflowId: string
  workflowName?: string
  snapshotPath: string
  reason: string
  detail: string
}

export type ReliabilityAuditEntry =
  | WatchTickAuditEntry
  | RepairProposeAuditEntry
  | RepairSnapshotAuditEntry
  | RepairVerifyAuditEntry
  | RepairWriteAuditEntry
  | RepairPostVerifyAuditEntry
  | RepairRollbackAuditEntry

function defaultAuditPath(): string {
  return join(homedir(), '.kairos', 'reliability-audit.jsonl')
}

/** Best-effort by design (matches telemetry's "must never break a real result" discipline) --
 * callers should wrap this in try/catch and never let an audit-write failure change a real
 * command's outcome. `auditPath` override exists for tests, matching the dependency-injection
 * fix already established in this codebase (Phase B's `os.homedir()` test-isolation bug) rather
 * than repeating it. */
export async function appendReliabilityAudit(entries: ReliabilityAuditEntry[], auditPath: string = defaultAuditPath()): Promise<void> {
  if (entries.length === 0) return
  await mkdir(dirname(auditPath), { recursive: true })
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  await appendFile(auditPath, lines, 'utf-8')
}

export async function getReliabilityAuditTrail(limit = 50, auditPath: string = defaultAuditPath()): Promise<ReliabilityAuditEntry[]> {
  try {
    const raw = await readFile(auditPath, 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as ReliabilityAuditEntry).slice(-limit)
  } catch {
    return []
  }
}
