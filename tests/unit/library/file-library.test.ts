import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileLibrary } from '../../../src/library/file-library.js'
import type { N8nWorkflow } from '../../../src/types/workflow.js'

function makeWorkflow(name: string): N8nWorkflow {
  return {
    name,
    nodes: [
      {
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
      credentialsNeeded: [{ name: 'Slack', nodeType: 'n8n-nodes-base.slack' }],
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
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(matches[0]!.workflow.description).toContain('slack')
    expect(matches[0]!.mode).toBeDefined()
    expect(['direct', 'reference', 'scratch']).toContain(matches[0]!.mode)
  })

  it('handles concurrent saves via write queue', async () => {
    const saves = Array.from({ length: 5 }, (_, i) =>
      lib.save(makeWorkflow(`Concurrent ${i}`), { description: `workflow ${i}` }),
    )
    await Promise.all(saves)

    const all = await lib.list()
    expect(all).toHaveLength(5)

    const raw = await readFile(join(dir, 'index.json'), 'utf-8')
    const data = JSON.parse(raw) as unknown[]
    expect(data).toHaveLength(5)
  })
})
