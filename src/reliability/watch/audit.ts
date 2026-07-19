import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * The G6 audit trail (docs/plans/reliability-suite-plan.md 12): every automated observation
 * this codebase makes, appended one JSON line per entry, never read back by any decision-making
 * code path -- purely a record for a human to inspect later ("why did Kairos say X"). Same
 * conventions as telemetry/pattern-analyzer.ts's pattern-audit.jsonl (append-only JSONL,
 * best-effort, timestamped) -- a second instance of the same pattern, not a new one.
 *
 * `kind` is a discriminated union deliberately started with a single member (`watch_tick`) --
 * Phase 3 (self-healing) adds `propose`/`apply`/`rollback` kinds to this same file/type when it
 * ships, rather than this module guessing at their shape now.
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

export type ReliabilityAuditEntry = WatchTickAuditEntry

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
