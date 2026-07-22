import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '../utils/file-lock.js'
import type { ContractAmendmentProposal, ProposalStatus } from './evolution-types.js'

/**
 * Contract Evolution v0 persistence (roadmap item 11, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 11). Storage layout mirrors
 * exception-store.ts exactly -- same directory (`~/.kairos/promise-ledger/<clientId>/
 * <contractId>/`, since a proposal is derived FROM evidence, not part of the contract
 * definition itself, the same reasoning ledger.jsonl/exceptions.json already follow), same
 * single-JSON-array-per-contract shape (mutable, stateful records with their own embedded
 * history -- not append-only events like ledger.jsonl), same write-to-temp-then-rename +
 * file-lock idiom for the same reason: `kairos contract evolve run` (regenerating detections)
 * and a human's `kairos contract evolve accept/reject` (an interactive status change) are both
 * real, concurrently-expected read-modify-write callers of the same file.
 */

function contractProposalsDir(clientId: string, contractId: string): string {
  return join(homedir(), '.kairos', 'promise-ledger', clientId, contractId)
}

function proposalsPath(clientId: string, contractId: string): string {
  return join(contractProposalsDir(clientId, contractId), 'amendment-proposals.json')
}

export async function loadContractAmendmentProposals(clientId: string, contractId: string): Promise<ContractAmendmentProposal[]> {
  try {
    const raw = await readFile(proposalsPath(clientId, contractId), 'utf-8')
    return JSON.parse(raw) as ContractAmendmentProposal[]
  } catch {
    return []
  }
}

async function writeAll(clientId: string, contractId: string, proposals: ContractAmendmentProposal[]): Promise<void> {
  const dir = contractProposalsDir(clientId, contractId)
  await mkdir(dir, { recursive: true })
  const path = proposalsPath(clientId, contractId)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(proposals, null, 2) + '\n', 'utf-8')
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, path)
}

/**
 * Merges freshly-detected proposals (from `analyzeContractForAmendments()`, always
 * `status: 'proposed'`, freshly-generated ids/createdAt/empty history) into whatever's already
 * stored, keyed by the SAME deterministic id `evolution.ts`'s own `makeProposalId()` produces
 * for the same (contract, version, category, element). For an id that already exists: the
 * existing record's `status`/`history`/`createdAt`/`appliedToVersion` are PRESERVED -- a human's
 * prior accept/reject decision is never silently reset back to 'proposed' just because the same
 * hotspot was detected again -- but `summary`/`evidence`/`occurrenceCount`/`sampleSize`/
 * `confidence` are refreshed to the latest detection, so a stale proposal still reflects current
 * numbers even while its review status stays exactly what a human left it at. A proposal that
 * existed before but was NOT re-detected this run (the underlying hotspot went away) is left
 * untouched in storage -- Contract Evolution never deletes a record, only ever adds to the
 * history of one, matching every other audit-trailed store in this codebase.
 */
export async function upsertContractAmendmentProposals(clientId: string, contractId: string, freshlyDetected: ContractAmendmentProposal[]): Promise<ContractAmendmentProposal[]> {
  const path = proposalsPath(clientId, contractId)
  await mkdir(contractProposalsDir(clientId, contractId), { recursive: true })
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const existing = await loadContractAmendmentProposals(clientId, contractId)
    const byId = new Map(existing.map(p => [p.id, p]))

    for (const fresh of freshlyDetected) {
      const prior = byId.get(fresh.id)
      if (prior) {
        byId.set(fresh.id, {
          ...fresh,
          status: prior.status,
          history: prior.history,
          createdAt: prior.createdAt,
          ...(prior.appliedToVersion !== undefined ? { appliedToVersion: prior.appliedToVersion } : {}),
        })
      } else {
        byId.set(fresh.id, fresh)
      }
    }

    const merged = [...byId.values()]
    await writeAll(clientId, contractId, merged)
    return merged
  } finally {
    await releaseLock()
  }
}

/** Returns null, not a throw, when no proposal with this id exists -- the caller (cli.ts)
 * decides how to report that, matching every other "not found" convention in this codebase. */
export async function updateProposalStatus(
  clientId: string,
  contractId: string,
  proposalId: string,
  to: ProposalStatus,
  reason?: string,
  appliedToVersion?: number,
): Promise<ContractAmendmentProposal | null> {
  const path = proposalsPath(clientId, contractId)
  await mkdir(contractProposalsDir(clientId, contractId), { recursive: true })
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const existing = await loadContractAmendmentProposals(clientId, contractId)
    const index = existing.findIndex(p => p.id === proposalId)
    if (index === -1) return null

    const current = existing[index]!
    const updated: ContractAmendmentProposal = {
      ...current,
      status: to,
      history: [...current.history, { ts: new Date().toISOString(), from: current.status, to, actor: 'human', ...(reason ? { reason } : {}) }],
      ...(appliedToVersion !== undefined ? { appliedToVersion } : {}),
    }
    existing[index] = updated
    await writeAll(clientId, contractId, existing)
    return updated
  } finally {
    await releaseLock()
  }
}
