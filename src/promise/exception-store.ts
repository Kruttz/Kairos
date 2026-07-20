import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExceptionDeskItem } from './exception-types.js'

/**
 * ExceptionDesk v0 persistence (Phase 4). A single JSON object per contract (not JSONL) --
 * unlike ProofLedger's own append-only entries, an ExceptionDeskItem is mutable, stateful record
 * (status changes in place over its lifecycle, with its own embedded history array), so it's
 * stored the same way registry.ts/store.ts's own current-state records are: overwritten on
 * save, not appended to. Nested alongside ledger.jsonl/watermarks.json under the same
 * per-contract directory (ledger-store.ts's own precedent from Phase 3).
 */

function exceptionsPath(contractId: string): string {
  return join(homedir(), '.kairos', 'promise-ledger', contractId, 'exceptions.json')
}

export async function loadExceptionDeskItems(contractId: string): Promise<ExceptionDeskItem[]> {
  try {
    const raw = await readFile(exceptionsPath(contractId), 'utf-8')
    return JSON.parse(raw) as ExceptionDeskItem[]
  } catch {
    return []
  }
}

async function writeAll(contractId: string, items: ExceptionDeskItem[]): Promise<void> {
  const dir = join(homedir(), '.kairos', 'promise-ledger', contractId)
  await mkdir(dir, { recursive: true })
  const path = exceptionsPath(contractId)
  await writeFile(path, JSON.stringify(items, null, 2) + '\n', 'utf-8')
  await chmod(path, 0o600)
}

/** Merges `items` into whatever's already on file, replacing any existing item with the same
 * id and appending genuinely new ones -- the same "open new, refresh existing in place" split
 * exception-desk.ts's updateExceptionDesk() already returns. */
export async function upsertExceptionDeskItems(contractId: string, items: ExceptionDeskItem[]): Promise<void> {
  if (items.length === 0) return
  const existing = await loadExceptionDeskItems(contractId)
  const byId = new Map(existing.map(i => [i.id, i]))
  for (const item of items) byId.set(item.id, item)
  await writeAll(contractId, [...byId.values()])
}

/** Saves a single updated item (e.g. after a human ack/resolve) -- a thin, explicit wrapper
 * around upsert so call sites reading `kairos exceptions ack/resolve` don't need to think about
 * the array shape underneath. */
export async function saveExceptionDeskItem(contractId: string, item: ExceptionDeskItem): Promise<void> {
  await upsertExceptionDeskItems(contractId, [item])
}
