import { chmod, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { N8nWorkflow } from '../../types/workflow.js'

/**
 * The one safety net every live write this phase makes goes through first (docs/plans/
 * reliability-suite-plan.md 8.3): before repair-apply's write, or a standalone `kairos
 * rollback`, the CURRENT live workflow JSON is saved here. Deliberately not a version-control
 * product (no arbitrary-revision diffing, no branching) -- this is "one restore point before a
 * Kairos-driven write," matching capture.ts's own local-only/chmod-600 posture, not the
 * held-off "git for workflows" idea.
 *
 * Snapshot files wrap the workflow with its own `ts` field (rather than deriving the timestamp
 * back out of the filename) specifically so filename sanitization (colons aren't valid in
 * Windows filenames, replaced with `-`) never has to be reversed to recover the real ISO
 * timestamp -- the file is the source of truth for its own `ts`, the filename is just a
 * collision-free, roughly-sortable name.
 */

const MAX_SNAPSHOTS_PER_WORKFLOW = 10

interface SnapshotFile {
  ts: string
  workflow: N8nWorkflow
}

export interface SnapshotEntry {
  ts: string
  path: string
}

function snapshotDir(workflowId: string): string {
  return join(homedir(), '.kairos', 'snapshots', workflowId)
}

export async function listSnapshots(workflowId: string): Promise<SnapshotEntry[]> {
  const dir = snapshotDir(workflowId)
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }

  const entries: SnapshotEntry[] = []
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8')
      const parsed = JSON.parse(raw) as SnapshotFile
      entries.push({ ts: parsed.ts, path: join(dir, f) })
    } catch {
      // A corrupted/unreadable snapshot file is skipped, not fatal to the whole listing --
      // the other snapshots are still real and still usable.
    }
  }
  return entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
}

async function enforceRetention(workflowId: string): Promise<number> {
  const snapshots = await listSnapshots(workflowId)
  const excess = snapshots.slice(MAX_SNAPSHOTS_PER_WORKFLOW)
  for (const s of excess) {
    await unlink(s.path).catch(() => {})
  }
  return excess.length
}

export async function saveSnapshot(workflowId: string, workflow: N8nWorkflow): Promise<SnapshotEntry> {
  const dir = snapshotDir(workflowId)
  await mkdir(dir, { recursive: true })

  const ts = new Date().toISOString()
  const path = join(dir, `${ts.replace(/:/g, '-')}.json`)
  const file: SnapshotFile = { ts, workflow }

  await writeFile(path, JSON.stringify(file, null, 2), 'utf-8')
  await chmod(path, 0o600)
  await enforceRetention(workflowId)

  return { ts, path }
}

/** Most recent snapshot when `ts` is omitted. Returns null (not a throw) when none exist --
 * "nothing to restore" is a real, expected outcome (e.g. `kairos rollback` on a workflow
 * that's never had a Kairos-driven write yet), not an error. */
export async function loadSnapshot(workflowId: string, ts?: string): Promise<N8nWorkflow | null> {
  const snapshots = await listSnapshots(workflowId)
  const target = ts ? snapshots.find(s => s.ts === ts) : snapshots[0]
  if (!target) return null
  const raw = await readFile(target.path, 'utf-8')
  return (JSON.parse(raw) as SnapshotFile).workflow
}
