import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendReliabilityAudit, getReliabilityAuditTrail, type WatchTickAuditEntry } from '../../../../src/reliability/watch/audit.js'

let tmpDir: string | undefined

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

async function tempAuditPath(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-audit-test-'))
  return join(tmpDir, 'reliability-audit.jsonl')
}

function makeEntry(overrides: Partial<WatchTickAuditEntry> = {}): WatchTickAuditEntry {
  return {
    kind: 'watch_tick',
    ts: new Date().toISOString(),
    workflowId: 'wf-1',
    status: 'checked',
    verdict: 'HEALTHY',
    detail: 'Checked -- verdict HEALTHY (3 trace(s) on record).',
    ...overrides,
  }
}

describe('appendReliabilityAudit / getReliabilityAuditTrail', () => {
  it('round-trips a single entry', async () => {
    const path = await tempAuditPath()
    const entry = makeEntry()
    await appendReliabilityAudit([entry], path)
    const trail = await getReliabilityAuditTrail(50, path)
    expect(trail).toHaveLength(1)
    expect(trail[0]).toEqual(entry)
  })

  it('appends across multiple calls rather than overwriting', async () => {
    const path = await tempAuditPath()
    await appendReliabilityAudit([makeEntry({ workflowId: 'wf-1' })], path)
    await appendReliabilityAudit([makeEntry({ workflowId: 'wf-2' })], path)
    const trail = await getReliabilityAuditTrail(50, path)
    expect(trail.map(e => e.workflowId)).toEqual(['wf-1', 'wf-2'])
  })

  it('writes one line per entry when multiple entries are appended in one call', async () => {
    const path = await tempAuditPath()
    await appendReliabilityAudit([makeEntry({ workflowId: 'wf-1' }), makeEntry({ workflowId: 'wf-2' })], path)
    const trail = await getReliabilityAuditTrail(50, path)
    expect(trail).toHaveLength(2)
  })

  it('creates the parent directory if it does not exist', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-audit-test-'))
    const nestedPath = join(tmpDir, 'nested', 'dir', 'reliability-audit.jsonl')
    await appendReliabilityAudit([makeEntry()], nestedPath)
    const trail = await getReliabilityAuditTrail(50, nestedPath)
    expect(trail).toHaveLength(1)
  })

  it('does nothing (no file created) when given an empty entries array', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-audit-test-'))
    const path = join(tmpDir, 'reliability-audit.jsonl')
    await appendReliabilityAudit([], path)
    const trail = await getReliabilityAuditTrail(50, path)
    expect(trail).toHaveLength(0)
  })

  it('returns an empty array, not a throw, when the audit file does not exist yet', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-audit-test-'))
    const path = join(tmpDir, 'never-written.jsonl')
    const trail = await getReliabilityAuditTrail(50, path)
    expect(trail).toEqual([])
  })

  it('respects the limit, returning only the most recent entries', async () => {
    const path = await tempAuditPath()
    for (let i = 0; i < 5; i++) {
      await appendReliabilityAudit([makeEntry({ workflowId: `wf-${i}` })], path)
    }
    const trail = await getReliabilityAuditTrail(2, path)
    expect(trail.map(e => e.workflowId)).toEqual(['wf-3', 'wf-4'])
  })

  it('preserves driftingCheckIds when present', async () => {
    const path = await tempAuditPath()
    await appendReliabilityAudit([makeEntry({ status: 'checked', verdict: 'DRIFTING', driftingCheckIds: ['D1', 'D5'] })], path)
    const trail = await getReliabilityAuditTrail(50, path)
    expect(trail[0]!.driftingCheckIds).toEqual(['D1', 'D5'])
  })
})
