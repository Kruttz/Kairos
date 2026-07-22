import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProcessContract } from './types.js'

/**
 * Minimal ProcessContract persistence -- Phase 0 scope only (docs/plans/
 * process-contract-promise-engine-plan.md §10). Deliberately mirrors
 * src/reliability/repair/snapshot.ts's own small save/list/load shape rather than
 * FileLibrary's fuller lifecycle (versioning, dedup, retrieval scoring) -- there is no real
 * need for any of that yet, and building it now would be exactly the kind of speculative
 * scope this plan's own guardrails (§9) argue against. No update/delete/versioning semantics
 * here -- re-saving a contract with the same id overwrites, same as re-running `kairos contract
 * plan` would produce a fresh save in a later phase. That's a real, deliberate limitation, not
 * an oversight -- a later phase's own design-verification pass should revisit this once there's
 * a genuine need (e.g. Phase 1's authoring flow, or Phase 2's compiled-pack linkage) rather than
 * guessed at now.
 *
 * That later phase is Contract Amendment/Diff (roadmap item 12, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 12) -- `amendProcessContract()` below is the
 * genuine need this doc comment predicted. `saveProcessContract()` itself stays exactly as it
 * was (a plain overwrite) for the common first-import case, where there is nothing to archive.
 */

export interface ContractVersionRecord {
  contract: ProcessContract
  supersededAt: string
  /** Which command caused this version to be superseded -- 'contract_plan'/'contract_intake' are
   * both "always saves regardless of conflict" paths (never a hard refusal, unlike import/amend)
   * that still archive what they overwrite, same guarantee, just a different trigger. */
  supersededBy: 'contract_amend' | 'contract_import' | 'contract_plan' | 'contract_intake'
}

function contractDir(clientId: string): string {
  return join(homedir(), '.kairos', 'contracts', clientId)
}

function contractPath(clientId: string, id: string): string {
  return join(contractDir(clientId), `${id}.json`)
}

/** `~/.kairos/contracts/<clientId>/<id>/versions/` -- deliberately a sibling directory to
 * `<id>.json` (the live contract), not nested inside it, so the live-contract read path
 * (`loadProcessContract`) never has to distinguish a plain file from a directory. Mirrors
 * `reliability/repair/snapshot.ts`'s own per-entity-directory-of-timestamped-files convention,
 * except UNBOUNDED (no retention cap, unlike snapshot.ts's MAX_SNAPSHOTS_PER_WORKFLOW) --
 * contract version history is explicitly "never deleted" (the plan's own guardrail) and is a
 * much lower-volume history than workflow-write snapshots (a handful of amendments over a
 * contract's life, not hundreds of writes). */
function versionsDir(clientId: string, id: string): string {
  return join(contractDir(clientId), id, 'versions')
}

function versionPath(clientId: string, id: string, version: number): string {
  return join(versionsDir(clientId, id), `v${version}.json`)
}

export async function saveProcessContract(contract: ProcessContract): Promise<{ path: string }> {
  const dir = contractDir(contract.clientId)
  await mkdir(dir, { recursive: true })
  const path = contractPath(contract.clientId, contract.id)
  await writeFile(path, JSON.stringify(contract, null, 2) + '\n', 'utf-8')
  await chmod(path, 0o600)
  return { path }
}

/** Archives `prior` (the contract as it exists on disk RIGHT NOW, before being overwritten) to
 * `versions/v<prior.version>.json`, then saves `next` as the new live contract. If `prior` is
 * undefined (nothing was ever saved at this id before), behaves exactly like a plain
 * `saveProcessContract(next)` -- there is nothing to archive. This is the ONLY function in this
 * codebase that should ever be called immediately before overwriting an already-saved contract
 * with a different version -- both `kairos contract import --confirm-version-change` and
 * `kairos contract amend --confirm` route through this, closing the same real gap for both call
 * sites rather than fixing it once and leaving the other silently unpatched. */
export async function amendProcessContract(
  next: ProcessContract,
  prior: ProcessContract | undefined,
  supersededBy: ContractVersionRecord['supersededBy'],
): Promise<{ path: string; archivedVersion?: number }> {
  if (!prior) {
    const { path } = await saveProcessContract(next)
    return { path }
  }

  const dir = versionsDir(prior.clientId, prior.id)
  await mkdir(dir, { recursive: true })
  const record: ContractVersionRecord = { contract: prior, supersededAt: new Date().toISOString(), supersededBy }
  const archivePath = versionPath(prior.clientId, prior.id, prior.version)
  await writeFile(archivePath, JSON.stringify(record, null, 2) + '\n', 'utf-8')
  await chmod(archivePath, 0o600)

  const { path } = await saveProcessContract(next)
  return { path, archivedVersion: prior.version }
}

/** Returns an empty array, not a throw, when this contract has never been amended -- "no
 * archived versions yet" is the normal case for most contracts, not an error. Sorted newest
 * (highest version) first, matching `listSnapshots()`'s own newest-first convention. */
export async function listContractVersions(clientId: string, id: string): Promise<ContractVersionRecord[]> {
  const dir = versionsDir(clientId, id)
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }

  const records: ContractVersionRecord[] = []
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8')
      records.push(JSON.parse(raw) as ContractVersionRecord)
    } catch {
      // A corrupted/unreadable version file is skipped, not fatal to the whole listing -- same
      // discipline as listProcessContracts()/snapshot.ts's own listSnapshots().
    }
  }
  return records.sort((a, b) => b.contract.version - a.contract.version)
}

/** Returns null, not a throw, when this specific archived version doesn't exist -- either it was
 * never archived, or `version` is the current live version (never archived, since only
 * SUPERSEDED versions ever get archived). */
export async function loadContractVersion(clientId: string, id: string, version: number): Promise<ProcessContract | null> {
  try {
    const raw = await readFile(versionPath(clientId, id, version), 'utf-8')
    return (JSON.parse(raw) as ContractVersionRecord).contract
  } catch {
    return null
  }
}

/** Returns null, not a throw, when the contract doesn't exist -- "nothing saved yet" is a real,
 * expected outcome (e.g. the first time a client's contract is looked up), not an error. */
export async function loadProcessContract(clientId: string, id: string): Promise<ProcessContract | null> {
  try {
    const raw = await readFile(contractPath(clientId, id), 'utf-8')
    return JSON.parse(raw) as ProcessContract
  } catch {
    return null
  }
}

/** Returns an empty array, not a throw, when the client has no contracts directory yet. */
export async function listProcessContracts(clientId: string): Promise<ProcessContract[]> {
  const dir = contractDir(clientId)
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }

  const contracts: ProcessContract[] = []
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8')
      contracts.push(JSON.parse(raw) as ProcessContract)
    } catch {
      // A corrupted/unreadable contract file is skipped, not fatal to the whole listing --
      // the other contracts are still real and still usable (same discipline as
      // snapshot.ts's listSnapshots()).
    }
  }
  return contracts
}
