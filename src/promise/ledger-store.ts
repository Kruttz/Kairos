import { appendFile, mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '../utils/file-lock.js'
import { normalizeContractPollWatermark, type ProofLedgerEntry, type ContractPollWatermark, type PersistedContractPollWatermark } from './ledger-types.js'
import { targetRefKey, type TargetDeploymentRef } from './targets/types.js'

/**
 * ProofLedger v0 persistence (Phase 3, plan doc §6.3). Two files per contract, mirroring
 * reliability/watch/audit.ts's own append-only-JSONL idiom (`reliability-audit.jsonl`) for the
 * ledger entries themselves, plus a small JSON map for watermarks (Prerequisite 2) -- not
 * append-only, since a watermark is current state, not a log of events.
 *
 * Client-scoped (supplemental measurement-integrity audit, Finding 1, fixed 2026-07-20): every
 * path is nested under `<clientId>/<contractId>/`, matching store.ts's and registry.ts's own
 * existing convention. Before this fix, these paths were keyed by `contractId` alone -- since
 * `contractId` is just a slug of the contract's own name (plan.ts's `deriveContractId()`), two
 * different clients naming a contract similarly (e.g. both "Referral Intake") would have
 * silently shared the same ledger/watermark files, mixing their data. `clientId` is now a
 * required parameter on every exported function here -- there is no remaining code path that
 * reads or writes unscoped storage, by construction, not just by convention.
 */

function contractLedgerDir(clientId: string, contractId: string): string {
  return join(homedir(), '.kairos', 'promise-ledger', clientId, contractId)
}

function ledgerPath(clientId: string, contractId: string): string {
  return join(contractLedgerDir(clientId, contractId), 'ledger.jsonl')
}

function watermarksPath(clientId: string, contractId: string): string {
  return join(contractLedgerDir(clientId, contractId), 'watermarks.json')
}

/** Best-effort by design (matches telemetry's "must never break a real result" discipline) --
 * callers should never let a ledger-write failure change a poll's own returned result.
 *
 * Locked (P0 measurement-integrity fix, 2026-07-20): appendFile's own O_APPEND atomicity only
 * covers a single write() syscall -- fine for one process, not a guarantee against two `kairos
 * ledger poll` invocations for the same contract racing (e.g. a cron overlap). The lock is
 * cheap and removes any doubt, not just theoretical protection. */
export async function appendProofLedgerEntries(clientId: string, contractId: string, entries: ProofLedgerEntry[]): Promise<void> {
  if (entries.length === 0) return
  const dir = contractLedgerDir(clientId, contractId)
  await mkdir(dir, { recursive: true })
  const path = ledgerPath(clientId, contractId)
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
export async function getProofLedgerEntries(clientId: string, contractId: string, limit = 200): Promise<ProofLedgerEntry[]> {
  let raw: string
  try {
    raw = await readFile(ledgerPath(clientId, contractId), 'utf-8')
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

async function readWatermarks(clientId: string, contractId: string): Promise<Record<string, PersistedContractPollWatermark>> {
  try {
    const raw = await readFile(watermarksPath(clientId, contractId), 'utf-8')
    return JSON.parse(raw) as Record<string, PersistedContractPollWatermark>
  } catch {
    return {}
  }
}

/** The legacy bare-key form of a ref -- only meaningful for `targetId === 'n8n'`, since that is
 * the only target whose watermarks could ever have been written before this phase existed. */
function watermarkLegacyKey(ref: TargetDeploymentRef): string | null {
  return ref.targetId === 'n8n' ? ref.targetDeploymentId : null
}

/** Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
 * §6.7). watermarks.json's own top-level shape is UNCHANGED (still `Record<string,
 * PersistedContractPollWatermark>`) -- only the KEY FORMAT for entries written from this phase
 * forward changes, which is why no whole-file migration is ever required; old bare-keyed entries
 * and new composite-keyed entries simply coexist as ordinary sibling keys in the same object.
 *
 * Reads by the collision-safe composite key (`targetRefKey()`, escaping both components so a
 * `:` inside either one can never be mistaken for the key's own delimiter) first, falling back
 * to the legacy bare key only for `targetId === 'n8n'` -- a pre-boundary file, which only ever
 * had bare keys, still resolves correctly for the one target that could have written it.
 *
 * When BOTH the composite and legacy keys exist for the same deployment -- e.g. a binary from
 * before this phase polls the same workflow *after* a phase-aware binary already wrote both
 * keys, updating only the legacy one -- this returns whichever has the newer `updatedAt`, never
 * blindly preferring the composite key. Without this, a stale composite-keyed watermark could
 * silently shadow a genuinely more recent legacy-keyed one written by an older binary. */
export async function loadContractPollWatermark(clientId: string, contractId: string, ref: TargetDeploymentRef): Promise<ContractPollWatermark | null> {
  const all = await readWatermarks(clientId, contractId)
  const composite = all[targetRefKey(ref)]
  const legacyKey = watermarkLegacyKey(ref)
  const legacy = legacyKey ? all[legacyKey] : undefined
  const winner =
    composite && legacy ? (composite.updatedAt >= legacy.updatedAt ? composite : legacy)
    : (composite ?? legacy)
  return winner ? normalizeContractPollWatermark(winner) : null
}

/** Locked (P0 measurement-integrity fix, 2026-07-20): this is a real read-modify-write cycle
 * (unlike the append-only ledger above) -- two concurrent pollers for different workflows on
 * the same contract would otherwise race on the shared watermarks.json, and the loser's own
 * watermark update could be silently lost, risking re-processing already-seen executions on
 * the next poll (duplicate, content-idempotent ledger entries -- not a correctness bug on its
 * own, but real storage-hygiene waste this lock removes entirely).
 *
 * `clientId` is a separate parameter, not a field on `ContractPollWatermark` itself (Finding 1
 * fix, 2026-07-20) -- that type is constructed inside ledger.ts, a pure extraction module with
 * no storage/client concept at all, and stays that way; clientId is purely a storage-layer
 * concern, entering only here.
 *
 * Writes the collision-safe composite key (Execution Substrate Boundary v0, Phase 1, plan §6.7)
 * and, for `targetId === 'n8n'` only, ALSO the legacy bare key -- an honest claim, stated
 * precisely: this EXPLICITLY REWRITES the legacy entry for whichever deployment is currently
 * being saved, every time, keeping it fresh for old-binary reads rather than leaving it frozen
 * after a single write. Every OTHER entry already in the file (a different deployment id, or a
 * different target's entries entirely) is left completely untouched. */
export async function saveContractPollWatermark(clientId: string, watermark: ContractPollWatermark): Promise<void> {
  const dir = contractLedgerDir(clientId, watermark.contractId)
  await mkdir(dir, { recursive: true })
  const path = watermarksPath(clientId, watermark.contractId)
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const all = await readWatermarks(clientId, watermark.contractId)
    all[targetRefKey(watermark)] = watermark
    const legacyKey = watermarkLegacyKey(watermark)
    if (legacyKey) all[legacyKey] = watermark
    const tmpPath = `${path}.tmp`
    await writeFile(tmpPath, JSON.stringify(all, null, 2) + '\n', 'utf-8')
    await chmod(tmpPath, 0o600)
    await rename(tmpPath, path)
  } finally {
    await releaseLock()
  }
}
