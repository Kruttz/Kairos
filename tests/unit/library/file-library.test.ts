import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileLibrary } from '../../../src/library/file-library.js'
import type { N8nWorkflow } from '../../../src/types/workflow.js'

function makeWorkflow(name: string): N8nWorkflow {
  return {
    name,
    nodes: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        parameters: {},
        name: 'Start',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [250, 300],
      },
    ],
    connections: {},
  }
}

describe('FileLibrary', () => {
  let dir: string
  let lib: FileLibrary

  beforeEach(async () => {
    dir = join(tmpdir(), `kairos-test-lib-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    lib = new FileLibrary(dir)
    await lib.initialize()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('saves and retrieves a workflow', async () => {
    const wf = makeWorkflow('Test')
    const id = await lib.save(wf, { description: 'send slack message' })
    const stored = await lib.get(id)
    expect(stored).not.toBeNull()
    expect(stored!.description).toBe('send slack message')
    expect(stored!.workflow.name).toBe('Test')
  })

  it('persists to index.json', async () => {
    await lib.save(makeWorkflow('Persist'), { description: 'test persistence' })
    const raw = await readFile(join(dir, 'index.json'), 'utf-8')
    const data = JSON.parse(raw) as unknown[]
    expect(data).toHaveLength(1)
  })

  it('deduplicates failure patterns on save', async () => {
    const id = await lib.save(makeWorkflow('FP'), {
      description: 'test',
      failurePatterns: [
        { rule: 12, message: 'Forbidden field' },
        { rule: 12, message: 'Forbidden field' },
        { rule: 14, message: 'No trigger' },
      ],
    })
    const stored = await lib.get(id)
    expect(stored!.failurePatterns).toHaveLength(2)
    const rule12 = stored!.failurePatterns!.find((p) => p.rule === 12)
    expect(rule12!.occurrences).toBe(2)
    const rule14 = stored!.failurePatterns!.find((p) => p.rule === 14)
    expect(rule14!.occurrences).toBe(1)
  })

  it('stores new metadata fields', async () => {
    const id = await lib.save(makeWorkflow('Meta'), {
      description: 'full metadata test',
      generationMode: 'reference',
      generationAttempts: 2,
      topMatchScore: 0.85,
      sourceWorkflowIds: ['abc', 'def'],
      credentialsNeeded: [{ service: 'Slack', credentialType: 'slackOAuth2Api', description: 'Slack OAuth2 credentials' }],
    })
    const stored = await lib.get(id)
    expect(stored!.generationMode).toBe('reference')
    expect(stored!.generationAttempts).toBe(2)
    expect(stored!.topMatchScore).toBe(0.85)
    expect(stored!.sourceWorkflowIds).toEqual(['abc', 'def'])
    expect(stored!.credentialsNeeded).toHaveLength(1)
  })

  it('omits optional fields when not provided', async () => {
    const id = await lib.save(makeWorkflow('Minimal'), {
      description: 'minimal save',
    })
    const stored = await lib.get(id)
    expect(stored!.failurePatterns).toBeUndefined()
    expect(stored!.sourceWorkflowIds).toBeUndefined()
    expect(stored!.topMatchScore).toBeUndefined()
    expect(stored!.credentialsNeeded).toBeUndefined()
  })

  it('search returns scored matches with mode', async () => {
    await lib.save(makeWorkflow('Slack Notifier'), {
      description: 'send a slack message when new email arrives',
    })
    await lib.save(makeWorkflow('DB Backup'), {
      description: 'backup database to S3 every night',
    })

    const matches = await lib.search('send slack notification')
    await lib.drain()
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(matches[0]!.workflow.description).toContain('slack')
    expect(matches[0]!.mode).toBeDefined()
    expect(['direct', 'reference', 'scratch']).toContain(matches[0]!.mode)
  })

  it('recordOutcome tracks usage stats on source workflows', async () => {
    const id = await lib.save(makeWorkflow('Source'), { description: 'slack notification' })

    await lib.recordOutcome(id, {
      attempts: 2,
      firstTryPass: false,
      failedRules: [12, 14],
      mode: 'direct',
    })

    const stored = await lib.get(id)
    expect(stored!.timesUsedAsDirect).toBe(1)
    expect(stored!.timesUsedAsReference).toBeUndefined()
    expect(stored!.outcomeStats).toEqual({
      totalUses: 1,
      totalAttempts: 2,
      firstTryPasses: 0,
      failedRules: { '12': 1, '14': 1 },
    })

    await lib.recordOutcome(id, {
      attempts: 1,
      firstTryPass: true,
      failedRules: [],
      mode: 'reference',
    })

    const updated = await lib.get(id)
    expect(updated!.timesUsedAsDirect).toBe(1)
    expect(updated!.timesUsedAsReference).toBe(1)
    expect(updated!.outcomeStats!.totalUses).toBe(2)
    expect(updated!.outcomeStats!.totalAttempts).toBe(3)
    expect(updated!.outcomeStats!.firstTryPasses).toBe(1)
  })

  it('search increments timesRetrieved on returned matches', async () => {
    await lib.save(makeWorkflow('Slack Bot'), {
      description: 'send slack message on webhook',
    })

    await lib.search('send slack notification')
    await lib.search('slack message webhook')
    await lib.drain()

    const all = await lib.list()
    const slackBot = all.find((w) => w.workflow.name === 'Slack Bot')
    expect(slackBot!.timesRetrieved).toBe(2)
  })

  it('handles concurrent saves via write queue', async () => {
    const saves = Array.from({ length: 5 }, (_, i) =>
      lib.save(makeWorkflow(`Concurrent ${i}`), { description: `workflow ${i}` }),
    )
    const ids = await Promise.all(saves)

    expect(new Set(ids).size).toBe(5)

    const all = await lib.list()
    expect(all).toHaveLength(5)

    const raw = await readFile(join(dir, 'index.json'), 'utf-8')
    const data = JSON.parse(raw) as unknown[]
    expect(data).toHaveLength(5)
  })

  // ── Per-file architecture ─────────────────────────────────────────────────

  it('writes workflow to a separate file under workflows/', async () => {
    const wf = makeWorkflow('PerFile')
    const id = await lib.save(wf, { description: 'per-file test' })

    const wfPath = join(dir, 'workflows', `${id}.json`)
    const raw = await readFile(wfPath, 'utf-8')
    const stored = JSON.parse(raw) as { name: string }
    expect(stored.name).toBe('PerFile')
  })

  it('index.json entries do not contain workflow field', async () => {
    await lib.save(makeWorkflow('Lightweight'), { description: 'lightweight index test' })

    const raw = await readFile(join(dir, 'index.json'), 'utf-8')
    const entries = JSON.parse(raw) as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).not.toHaveProperty('workflow')
    expect(entries[0]).toHaveProperty('workflowName', 'Lightweight')
    expect(entries[0]).toHaveProperty('cachedNodeTypes')
  })

  it('migrates old monolithic index.json to per-file format', async () => {
    // Use a completely fresh subdirectory with no prior FileLibrary initialization.
    // The beforeEach already ran initialize() on `dir`, which creates workflows/,
    // so we need a virgin directory to test the old-format detection path.
    const migDir = join(dir, 'migrate-test')
    await mkdir(migDir, { recursive: true })

    const oldEntry = {
      id: 'test-migration-id',
      description: 'old format workflow',
      tags: [],
      platform: 'n8n',
      deployCount: 3,
      createdAt: '2024-01-01T00:00:00.000Z',
      workflow: makeWorkflow('OldFormat'),
    }
    await writeFile(join(migDir, 'index.json'), JSON.stringify([oldEntry]), 'utf-8')

    // Initialize a fresh library instance in the virgin directory (triggers migration)
    const freshLib = new FileLibrary(migDir)
    await freshLib.initialize()

    // workflows/ dir should now exist
    const wfDir = join(migDir, 'workflows')
    await expect(stat(wfDir)).resolves.toBeDefined()

    // The workflow file should exist
    const wfPath = join(wfDir, 'test-migration-id.json')
    const wfRaw = await readFile(wfPath, 'utf-8')
    const wf = JSON.parse(wfRaw) as { name: string }
    expect(wf.name).toBe('OldFormat')

    // index.json should be in new lightweight format (no workflow field)
    const indexRaw = await readFile(join(migDir, 'index.json'), 'utf-8')
    const entries = JSON.parse(indexRaw) as Array<Record<string, unknown>>
    expect(entries[0]).not.toHaveProperty('workflow')
    expect(entries[0]).toHaveProperty('workflowName', 'OldFormat')
    expect(entries[0]).toHaveProperty('deployCount', 3)

    // get() should return the full StoredWorkflow after migration
    const stored = await freshLib.get('test-migration-id')
    expect(stored).not.toBeNull()
    expect(stored!.description).toBe('old format workflow')
    expect(stored!.workflow.name).toBe('OldFormat')
    expect(stored!.deployCount).toBe(3)
  })

  it('list() returns full StoredWorkflow objects with workflow field populated', async () => {
    await lib.save(makeWorkflow('ListA'), { description: 'list workflow a' })
    await lib.save(makeWorkflow('ListB'), { description: 'list workflow b' })

    const all = await lib.list()
    expect(all).toHaveLength(2)
    for (const entry of all) {
      expect(entry.workflow).toBeDefined()
      expect(Array.isArray(entry.workflow.nodes)).toBe(true)
    }
    const names = all.map((e) => e.workflow.name).sort()
    expect(names).toEqual(['ListA', 'ListB'])
  })
})
