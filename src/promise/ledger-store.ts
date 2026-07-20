import { appendFile, mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 * callers should never let a ledger-write failure change a poll's own returned result. */
export async function appendProofLedgerEntries(contractId: string, entries: ProofLedgerEntry[]): Promise<void> {
  if (entries.length === 0) return
  const dir = contractLedgerDir(contractId)
  await mkdir(dir, { recursive: true })
  const path = ledgerPath(contractId)
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  await appendFile(path, lines, 'utf-8')
  await chmod(path, 0o600)
}

export async function getProofLedgerEntries(contractId: string, limit = 200): Promise<ProofLedgerEntry[]> {
  try {
    const raw = await readFile(ledgerPath(contractId), 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as ProofLedgerEntry).slice(-limit)
  } catch {
    return []
  }
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

export async function saveContractPollWatermark(watermark: ContractPollWatermark): Promise<void> {
  const dir = contractLedgerDir(watermark.contractId)
  await mkdir(dir, { recursive: true })
  const all = await readWatermarks(watermark.contractId)
  all[watermark.n8nWorkflowId] = watermark
  const path = watermarksPath(watermark.contractId)
  await writeFile(path, JSON.stringify(all, null, 2) + '\n', 'utf-8')
  await chmod(path, 0o600)
}
