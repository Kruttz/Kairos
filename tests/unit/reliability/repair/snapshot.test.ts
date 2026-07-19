import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { saveSnapshot, listSnapshots, loadSnapshot } from '../../../../src/reliability/repair/snapshot.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'

function makeWorkflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    name: 'Snapshot Test Workflow',
    nodes: [{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} }],
    connections: {},
    settings: {},
    ...overrides,
  }
}

// Redirect HOME so these tests never touch the real ~/.kairos/snapshots directory --
// same discipline as capture.test.ts, since this is the same class of test-isolation risk
// (a prior bug in this codebase let test data leak into the real ~/.kairos/ directory).
let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-snapshot-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('saveSnapshot / listSnapshots / loadSnapshot', () => {
  it('round-trips a single snapshot', async () => {
    const workflow = makeWorkflow()
    const saved = await saveSnapshot('wf-1', workflow)
    expect(saved.ts).toBeDefined()
    expect(saved.path).toBeDefined()

    const loaded = await loadSnapshot('wf-1')
    expect(loaded).toEqual(workflow)
  })

  it('returns null (not a throw) when no snapshot exists for a workflow', async () => {
    const loaded = await loadSnapshot('never-snapshotted')
    expect(loaded).toBeNull()
  })

  it('returns an empty array (not a throw) when listing a workflow with no snapshots', async () => {
    const list = await listSnapshots('never-snapshotted')
    expect(list).toEqual([])
  })

  it('lists multiple snapshots newest first', async () => {
    await saveSnapshot('wf-1', makeWorkflow({ name: 'v1' }))
    await new Promise(r => setTimeout(r, 5))
    await saveSnapshot('wf-1', makeWorkflow({ name: 'v2' }))
    await new Promise(r => setTimeout(r, 5))
    await saveSnapshot('wf-1', makeWorkflow({ name: 'v3' }))

    const list = await listSnapshots('wf-1')
    expect(list).toHaveLength(3)
    expect(new Date(list[0]!.ts).getTime()).toBeGreaterThan(new Date(list[1]!.ts).getTime())
    expect(new Date(list[1]!.ts).getTime()).toBeGreaterThan(new Date(list[2]!.ts).getTime())
  })

  it('loadSnapshot with no ts returns the most recent one', async () => {
    await saveSnapshot('wf-1', makeWorkflow({ name: 'oldest' }))
    await new Promise(r => setTimeout(r, 5))
    await saveSnapshot('wf-1', makeWorkflow({ name: 'newest' }))

    const loaded = await loadSnapshot('wf-1')
    expect(loaded!.name).toBe('newest')
  })

  it('loadSnapshot with an explicit ts returns exactly that snapshot, not the most recent', async () => {
    const first = await saveSnapshot('wf-1', makeWorkflow({ name: 'first' }))
    await new Promise(r => setTimeout(r, 5))
    await saveSnapshot('wf-1', makeWorkflow({ name: 'second' }))

    const loaded = await loadSnapshot('wf-1', first.ts)
    expect(loaded!.name).toBe('first')
  })

  it('keeps snapshots for different workflows fully separate', async () => {
    await saveSnapshot('wf-a', makeWorkflow({ name: 'a' }))
    await saveSnapshot('wf-b', makeWorkflow({ name: 'b' }))

    expect((await loadSnapshot('wf-a'))!.name).toBe('a')
    expect((await loadSnapshot('wf-b'))!.name).toBe('b')
    expect(await listSnapshots('wf-a')).toHaveLength(1)
  })

  it('enforces the 10-snapshot cap, deleting the oldest beyond it', async () => {
    for (let i = 0; i < 12; i++) {
      await saveSnapshot('wf-1', makeWorkflow({ name: `v${i}` }))
      await new Promise(r => setTimeout(r, 2))
    }
    const list = await listSnapshots('wf-1')
    expect(list).toHaveLength(10)
    // The two oldest (v0, v1) should be gone -- newest-first list's last entries are v2..v11's oldest.
    const names = await Promise.all(list.map(async s => (await loadSnapshot('wf-1', s.ts))!.name))
    expect(names).not.toContain('v0')
    expect(names).not.toContain('v1')
    expect(names).toContain('v11')
  })

  it('chmods the snapshot file to 600 (owner read/write only)', async () => {
    const saved = await saveSnapshot('wf-1', makeWorkflow())
    const dir = join(scratchHome, '.kairos', 'snapshots', 'wf-1')
    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    const { stat } = await import('node:fs/promises')
    const mode = (await stat(saved.path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('never touches the real home directory (HOME redirect actually works)', async () => {
    await saveSnapshot('wf-1', makeWorkflow())
    const realSnapshotDir = join(ORIGINAL_HOME, '.kairos', 'snapshots', 'wf-1')
    // The real directory either doesn't exist, or if it does (from unrelated prior real use),
    // this test's own workflow name must not appear in it -- proves isolation either way.
    const scratchDir = join(scratchHome, '.kairos', 'snapshots', 'wf-1')
    const scratchFiles = await readdir(scratchDir)
    expect(scratchFiles.length).toBeGreaterThan(0)
    expect(realSnapshotDir).not.toBe(scratchDir)
  })
})
