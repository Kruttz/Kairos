import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendReliabilityAudit,
  getReliabilityAuditTrail,
  type WatchTickAuditEntry,
  type RepairProposeAuditEntry,
  type RepairSnapshotAuditEntry,
  type RepairVerifyAuditEntry,
  type RepairWriteAuditEntry,
  type RepairPostVerifyAuditEntry,
  type RepairRollbackAuditEntry,
} from '../../../../src/reliability/watch/audit.js'

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

describe('repair audit entry kinds (Phase 3)', () => {
  it('round-trips every repair entry kind through the same file, each keeping its own shape', async () => {
    const path = await tempAuditPath()
    const ts = new Date().toISOString()

    const propose: RepairProposeAuditEntry = {
      kind: 'repair_propose', ts, workflowId: 'wf-1', checkId: 'D9',
      riskLevel: 'low', verificationAvailability: 'available', produced: true,
      detail: 'Proposed a D9 restore.',
    }
    const snapshot: RepairSnapshotAuditEntry = {
      kind: 'repair_snapshot', ts, workflowId: 'wf-1',
      snapshotPath: '/Users/x/.kairos/snapshots/wf-1/2026-01-01.json',
      detail: 'Snapshot taken before write.',
    }
    const verify: RepairVerifyAuditEntry = {
      kind: 'repair_verify', ts, workflowId: 'wf-1', checkId: 'D9',
      status: 'verified', replayVerdict: 'IDENTICAL', partialVerification: false,
      detail: 'Replay verification clean.',
    }
    const write: RepairWriteAuditEntry = {
      kind: 'repair_write', ts, workflowId: 'wf-1', checkId: 'D9',
      auto: false, confirmedBy: 'human_prompt',
      detail: 'Wrote the proposed restore.',
    }
    const postVerify: RepairPostVerifyAuditEntry = {
      kind: 'repair_post_verify', ts, workflowId: 'wf-1', checkId: 'D9',
      passed: true, detail: 'Live workflow matches the applied target.',
    }
    const rollback: RepairRollbackAuditEntry = {
      kind: 'repair_rollback', ts, workflowId: 'wf-1',
      snapshotPath: '/Users/x/.kairos/snapshots/wf-1/2026-01-01.json',
      reason: 'Post-verify failed.', detail: 'Restored from snapshot.',
    }

    await appendReliabilityAudit([propose, snapshot, verify, write, postVerify, rollback], path)
    const trail = await getReliabilityAuditTrail(50, path)

    expect(trail).toHaveLength(6)
    expect(trail.map(e => e.kind)).toEqual([
      'repair_propose', 'repair_snapshot', 'repair_verify', 'repair_write', 'repair_post_verify', 'repair_rollback',
    ])
    expect(trail[0]).toEqual(propose)
    expect(trail[3]).toEqual(write)
    expect(trail[5]).toEqual(rollback)
  })

  it('a watch_tick entry and a repair entry coexist correctly in the same file', async () => {
    const path = await tempAuditPath()
    const tick = makeEntry()
    const propose: RepairProposeAuditEntry = {
      kind: 'repair_propose', ts: new Date().toISOString(), workflowId: 'wf-1', checkId: 'D9',
      produced: false, detail: 'Refused: internal consistency check failed.',
    }
    await appendReliabilityAudit([tick, propose], path)
    const trail = await getReliabilityAuditTrail(50, path)
    expect(trail[0]!.kind).toBe('watch_tick')
    expect(trail[1]!.kind).toBe('repair_propose')
  })
})
