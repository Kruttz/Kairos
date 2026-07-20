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
 */

function contractDir(clientId: string): string {
  return join(homedir(), '.kairos', 'contracts', clientId)
}

function contractPath(clientId: string, id: string): string {
  return join(contractDir(clientId), `${id}.json`)
}

export async function saveProcessContract(contract: ProcessContract): Promise<{ path: string }> {
  const dir = contractDir(contract.clientId)
  await mkdir(dir, { recursive: true })
  const path = contractPath(contract.clientId, contract.id)
  await writeFile(path, JSON.stringify(contract, null, 2) + '\n', 'utf-8')
  await chmod(path, 0o600)
  return { path }
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
