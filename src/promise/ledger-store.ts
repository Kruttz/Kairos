import { appendFile, mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '../utils/file-lock.js'
import type { ProofLedgerEntry, ContractPollWatermark } from './ledger-types.js'

/**
 * ProofLedger v0 persistence (Phase 3, plan doc §6.3). Two files per contract, mirroring
 * reliability/watch/audit.ts's own append-only-JSONL idiom (`reliability-audit.jsonl`) for the
 * ledger entries themselves, plus a small JSON map for watermarks (Prerequisite 2) -- not
 * append-only, since a watermark is current state, not a log of events.
 *
 * Nested under a per-contract directory rather than plan doc §6.3's original flat-file sketch
 * (`~/.kairos/promise-ledger/<contractId>.jsonl`) -- a small, deliberate refinement made during
 * implementation to make room for the watermarks file alongside the ledger, the same "revise
 * honestly when building reveals a better shape" discipline Phase 0's StartCondition.initialState
 * addition already established in this arc.
 */

function contractLedgerDir(contractId: string): string {
  return join(homedir(), '.kairos', 'promise-ledger', contractId)
}

function ledgerPath(contractId: string): string {
  return join(contractLedgerDir(contractId), 'ledger.jsonl')
}

function watermarksPath(contractId: string): string {
  return join(contractLedgerDir(contractId), 'watermarks.json')
}

/** Best-effort by design (matches telemetry's "must never break a real result" discipline) --
 * callers should never let a ledger-write failure change a poll's own returned result.
 *
 * Locked (P0 measurement-integrity fix, 2026-07-20): appendFile's own O_APPEND atomicity only
 * covers a single write() syscall -- fine for one process, not a guarantee against two `kairos
 * ledger poll` invocations for the same contract racing (e.g. a cron overlap). The lock is
 * cheap and removes any doubt, not just theoretical protection. */
export async function appendProofLedgerEntries(contractId: string, entries: ProofLedgerEntry[]): Promise<void> {
  if (entries.length === 0) return
  const dir = contractLedgerDir(contractId)
  await mkdir(dir, { recursive: true })
  const path = ledgerPath(contractId)
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    await appendFile(path, lines, 'utf-8')
    await chmod(path, 0o600)
  } finally {
    await releaseLock()
  }
}

/** Parses each JSONL line independently (P0 measurement-integrity fix, 2026-07-20) -- a single
 * corrupted or interleaved line (e.g. from a write that happened before locking was added, or
 * a truncated append from a killed process) is skipped, not fatal to the whole read. Previously
 * one bad line threw inside the surrounding try/catch and silently returned an EMPTY ledger for
 * the entire contract -- every real, valid entry discarded along with the one bad line, with SLA
 * compliance/reports then reading as "no evidence at all" instead of "all evidence except one
 * unreadable entry." Skipping per-line is strictly safer: it can only recover entries, never
 * fabricate one. */
export async function getProofLedgerEntries(contractId: string, limit = 200): Promise<ProofLedgerEntry[]> {
  let raw: string
  try {
    raw = await readFile(ledgerPath(contractId), 'utf-8')
  } catch {
    return []
  }
  const entries: ProofLedgerEntry[] = []
  for (const line of raw.trim().split('\n')) {
    if (!line) continue
    try {
      entries.push(JSON.parse(line) as ProofLedgerEntry)
    } catch {
      // A single corrupted line is skipped, not fatal -- see doc comment above.
    }
  }
  return entries.slice(-limit)
}

async function readWatermarks(contractId: string): Promise<Record<string, ContractPollWatermark>> {
  try {
    const raw = await readFile(watermarksPath(contractId), 'utf-8')
    return JSON.parse(raw) as Record<string, ContractPollWatermark>
  } catch {
    return {}
  }
}

export async function loadContractPollWatermark(contractId: string, n8nWorkflowId: string): Promise<ContractPollWatermark | null> {
  const all = await readWatermarks(contractId)
  return all[n8nWorkflowId] ?? null
}

/** Locked (P0 measurement-integrity fix, 2026-07-20): this is a real read-modify-write cycle
 * (unlike the append-only ledger above) -- two concurrent pollers for different workflows on
 * the same contract would otherwise race on the shared watermarks.json, and the loser's own
 * watermark update could be silently lost, risking re-processing already-seen executions on
 * the next poll (duplicate, content-idempotent ledger entries -- not a correctness bug on its
 * own, but real storage-hygiene waste this lock removes entirely). */
export async function saveContractPollWatermark(watermark: ContractPollWatermark): Promise<void> {
  const dir = contractLedgerDir(watermark.contractId)
  await mkdir(dir, { recursive: true })
  const path = watermarksPath(watermark.contractId)
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const all = await readWatermarks(watermark.contractId)
    all[watermark.n8nWorkflowId] = watermark
    const tmpPath = `${path}.tmp`
    await writeFile(tmpPath, JSON.stringify(all, null, 2) + '\n', 'utf-8')
    await chmod(tmpPath, 0o600)
    await rename(tmpPath, path)
  } finally {
    await releaseLock()
  }
}
