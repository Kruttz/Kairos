import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '../utils/file-lock.js'
import type { ExceptionDeskItem } from './exception-types.js'

/**
 * ExceptionDesk v0 persistence (Phase 4). A single JSON object per contract (not JSONL) --
 * unlike ProofLedger's own append-only entries, an ExceptionDeskItem is mutable, stateful record
 * (status changes in place over its lifecycle, with its own embedded history array), so it's
 * stored the same way registry.ts/store.ts's own current-state records are: overwritten on
 * save, not appended to. Nested alongside ledger.jsonl/watermarks.json under the same
 * per-contract directory (ledger-store.ts's own precedent from Phase 3).
 *
 * Client-scoped (supplemental measurement-integrity audit, Finding 1, fixed 2026-07-20): every
 * path is nested under `<clientId>/<contractId>/`, matching store.ts's and registry.ts's own
 * existing convention -- same fix, same reasoning as ledger-store.ts's own doc comment. `clientId`
 * is now a required parameter on every exported function here.
 */

function contractExceptionDir(clientId: string, contractId: string): string {
  return join(homedir(), '.kairos', 'promise-ledger', clientId, contractId)
}

function exceptionsPath(clientId: string, contractId: string): string {
  return join(contractExceptionDir(clientId, contractId), 'exceptions.json')
}

export async function loadExceptionDeskItems(clientId: string, contractId: string): Promise<ExceptionDeskItem[]> {
  try {
    const raw = await readFile(exceptionsPath(clientId, contractId), 'utf-8')
    return JSON.parse(raw) as ExceptionDeskItem[]
  } catch {
    return []
  }
}

/** Write-to-temp-then-rename (P0 measurement-integrity fix, 2026-07-20) -- the same crash-safety
 * idiom src/library/file-library.ts's own persist() uses alongside its lock: `rename()` is
 * atomic on POSIX, so a reader (or a crash mid-write) never observes a half-written
 * exceptions.json, only the old complete file or the new complete file, never a torn one. */
async function writeAll(clientId: string, contractId: string, items: ExceptionDeskItem[]): Promise<void> {
  const dir = contractExceptionDir(clientId, contractId)
  await mkdir(dir, { recursive: true })
  const path = exceptionsPath(clientId, contractId)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(items, null, 2) + '\n', 'utf-8')
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, path)
}

/** Merges `items` into whatever's already on file, replacing any existing item with the same
 * id and appending genuinely new ones -- the same "open new, refresh existing in place" split
 * exception-desk.ts's updateExceptionDesk() already returns.
 *
 * Locked (P0 measurement-integrity fix, 2026-07-20): this is the single most important lock in
 * this arc. `kairos watch --contracts` (an unattended, continuously-running loop by design) and
 * `kairos exceptions ack`/`resolve` (a human, interactively) both call into this same
 * read-modify-write cycle against the same file, and running both at once is the EXPECTED usage
 * pattern this feature exists for, not a rare edge case. Without a lock, a human's resolution
 * and a concurrent watch tick's own refresh can race: whichever write lands second silently wins
 * in full, discarding the other's update entirely -- including a human's `resolved` status being
 * reverted back to `open` with no error, no warning, and no record that it happened. That would
 * have directly undermined this module's one core guarantee (human resolution only, never
 * auto-reverted -- exception-types.ts's own doc comment). */
export async function upsertExceptionDeskItems(clientId: string, contractId: string, items: ExceptionDeskItem[]): Promise<void> {
  if (items.length === 0) return
  const dir = contractExceptionDir(clientId, contractId)
  await mkdir(dir, { recursive: true })
  const path = exceptionsPath(clientId, contractId)
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const existing = await loadExceptionDeskItems(clientId, contractId)
    const byId = new Map(existing.map(i => [i.id, i]))
    for (const item of items) byId.set(item.id, item)
    await writeAll(clientId, contractId, [...byId.values()])
  } finally {
    await releaseLock()
  }
}

/** Saves a single updated item (e.g. after a human ack/resolve) -- a thin, explicit wrapper
 * around upsert so call sites reading `kairos exceptions ack/resolve` don't need to think about
 * the array shape underneath. */
export async function saveExceptionDeskItem(clientId: string, contractId: string, item: ExceptionDeskItem): Promise<void> {
  await upsertExceptionDeskItems(clientId, contractId, [item])
}
