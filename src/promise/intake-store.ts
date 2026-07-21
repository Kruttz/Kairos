import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IntakeSession } from './intake-types.js'

/**
 * Intake session persistence -- deliberately mirrors src/promise/store.ts's exact save/load
 * shape (mkdir + writeFile pretty-JSON + chmod 0o600, null-on-missing rather than a throw) so a
 * session is stored the same way everything else in this arc is: predictable, local,
 * human-readable on disk, no new persistence pattern invented for one feature. Kept under each
 * client's own contracts directory, in a `_intake-sessions` subdirectory (leading underscore so
 * `listProcessContracts()`'s own `.json`-suffix directory scan -- which reads every `.json` file
 * directly inside `contracts/<client-id>/`, not recursively -- never picks up a session file as
 * if it were a contract; confirmed directly against store.ts's `readdir` call, which is
 * non-recursive).
 */

function intakeSessionDir(clientId: string): string {
  return join(homedir(), '.kairos', 'contracts', clientId, '_intake-sessions')
}

function intakeSessionPath(clientId: string, id: string): string {
  return join(intakeSessionDir(clientId), `${id}.json`)
}

export async function saveIntakeSession(session: IntakeSession): Promise<{ path: string }> {
  const dir = intakeSessionDir(session.clientId)
  await mkdir(dir, { recursive: true })
  const path = intakeSessionPath(session.clientId, session.id)
  await writeFile(path, JSON.stringify(session, null, 2) + '\n', 'utf-8')
  await chmod(path, 0o600)
  return { path }
}

/** Returns null, not a throw, when the session doesn't exist -- e.g. a mistyped --resume id, or
 * the first lookup before any session has ever been created for this client. */
export async function loadIntakeSession(clientId: string, id: string): Promise<IntakeSession | null> {
  try {
    const raw = await readFile(intakeSessionPath(clientId, id), 'utf-8')
    return JSON.parse(raw) as IntakeSession
  } catch {
    return null
  }
}
