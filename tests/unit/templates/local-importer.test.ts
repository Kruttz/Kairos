import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeImportedWorkflow,
  synthesizeDescription,
  computeTopologyHash,
  selectDiverse,
  LocalImporter,
  type ImportCandidate,
} from '../../../src/templates/local-importer.js'
import { FileLibrary } from '../../../src/library/file-library.js'
import type { N8nWorkflow, N8nNode } from '../../../src/types/workflow.js'

const NOOP_LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function node(overrides: Partial<N8nNode> & Pick<N8nNode, 'name' | 'type'>): N8nNode {
  return {
    id: `${Math.random().toString(36).slice(2)}-4000-8000-000000000000`,
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
    ...overrides,
  }
}

function validWorkflow(overrides?: Partial<N8nWorkflow>): N8nWorkflow {
  return {
    name: 'Test Import',
    nodes: [
      node({ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }),
      node({ name: 'Notify', type: 'n8n-nodes-base.slack', parameters: { resource: 'message', operation: 'send', select: 'channel', channelId: { __rl: true, mode: 'id', value: 'C123' }, text: 'hi' }, credentials: { slackOAuth2Api: { id: 'placeholder-id', name: 'Slack' } } }),
    ],
    connections: {
      Trigger: { main: [[{ node: 'Notify', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
    ...overrides,
  }
}

describe('normalizeImportedWorkflow', () => {
  it('accepts a bare workflow shape', () => {
    const result = normalizeImportedWorkflow(validWorkflow())
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Test Import')
    expect(result!.nodes).toHaveLength(2)
  })

  it('unwraps a { workflow: {...} } wrapper', () => {
    const result = normalizeImportedWorkflow({ id: 42, workflow: validWorkflow() })
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Test Import')
  })

  it('drops extra top-level fields like id, active, createdAt', () => {
    const raw = { ...validWorkflow(), id: 'abc', active: true, createdAt: '2020-01-01', versionId: 'v1' }
    const result = normalizeImportedWorkflow(raw)
    expect(result).not.toBeNull()
    expect((result as unknown as Record<string, unknown>)['id']).toBeUndefined()
    expect((result as unknown as Record<string, unknown>)['active']).toBeUndefined()
  })

  it('returns null when nodes is missing', () => {
    expect(normalizeImportedWorkflow({ name: 'X', connections: {} })).toBeNull()
  })

  it('returns null when connections is missing', () => {
    expect(normalizeImportedWorkflow({ name: 'X', nodes: [] })).toBeNull()
  })

  it('returns null when all nodes lack type or name', () => {
    expect(normalizeImportedWorkflow({ name: 'X', nodes: [{ id: '1' }], connections: {} })).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(normalizeImportedWorkflow('not an object')).toBeNull()
    expect(normalizeImportedWorkflow(null)).toBeNull()
  })

  it('defaults settings when missing', () => {
    const wf = validWorkflow()
    delete (wf as Partial<N8nWorkflow>).settings
    const result = normalizeImportedWorkflow(wf)
    expect(result!.settings).toBeDefined()
    expect(result!.settings!.executionOrder).toBe('v1')
  })
})

describe('synthesizeDescription', () => {
  it('harvests sticky note content when present', () => {
    const wf = validWorkflow({
      nodes: [
        node({ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }),
        node({ name: 'Note', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Sends a **Slack** alert when inventory is low' } }),
      ],
    })
    const desc = synthesizeDescription(wf, 'abcdef1234567890')
    expect(desc).toContain('Sends a Slack alert when inventory is low')
    expect(desc).not.toContain('**')
    expect(desc).toContain('[abcdef12]')
  })

  it('concatenates multiple sticky notes', () => {
    const wf = validWorkflow({
      nodes: [
        node({ name: 'Note1', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Step one' } }),
        node({ name: 'Note2', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Step two' } }),
      ],
    })
    const desc = synthesizeDescription(wf, 'hash123')
    expect(desc).toContain('Step one')
    expect(desc).toContain('Step two')
  })

  it('falls back to node-type summary when there are no sticky notes', () => {
    const wf = validWorkflow()
    const desc = synthesizeDescription(wf, 'ffff000011112222')
    expect(desc).toContain('manualTrigger')
    expect(desc).toContain('slack')
    expect(desc).toContain('[ffff0000]')
  })

  it('produces different descriptions for different hashes on identical fallback text', () => {
    const wf = validWorkflow({ name: 'Same Name', nodes: [node({ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' })] })
    const descA = synthesizeDescription(wf, 'aaaaaaaa11111111')
    const descB = synthesizeDescription(wf, 'bbbbbbbb22222222')
    expect(descA).not.toBe(descB)
  })
})

describe('computeTopologyHash', () => {
  it('is identical for the same structure regardless of parameter values', () => {
    const a = validWorkflow()
    const b = validWorkflow({
      nodes: [
        node({ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }),
        node({ name: 'Notify', type: 'n8n-nodes-base.slack', parameters: { resource: 'message', operation: 'send', select: 'channel', channelId: { __rl: true, mode: 'id', value: 'DIFFERENT_CHANNEL' }, text: 'a totally different message' }, credentials: { slackOAuth2Api: { id: 'placeholder-id', name: 'Slack' } } }),
      ],
    })
    expect(computeTopologyHash(a)).toBe(computeTopologyHash(b))
  })

  it('is stable regardless of node array order', () => {
    const wf = validWorkflow()
    const reordered: N8nWorkflow = { ...wf, nodes: [...wf.nodes].reverse() }
    expect(computeTopologyHash(wf)).toBe(computeTopologyHash(reordered))
  })

  it('differs when node types differ', () => {
    const a = validWorkflow()
    const b = validWorkflow({ nodes: [node({ name: 'Trigger', type: 'n8n-nodes-base.scheduleTrigger' }), a.nodes[1]!] })
    expect(computeTopologyHash(a)).not.toBe(computeTopologyHash(b))
  })

  it('differs when connection topology differs', () => {
    const a = validWorkflow()
    const b: N8nWorkflow = { ...a, connections: {} }
    expect(computeTopologyHash(a)).not.toBe(computeTopologyHash(b))
  })

  it('differs when a node has extra parameter keys', () => {
    const a = validWorkflow()
    const b = validWorkflow({
      nodes: [
        a.nodes[0]!,
        { ...a.nodes[1]!, parameters: { ...a.nodes[1]!.parameters, extraKey: 'x' } },
      ],
    })
    expect(computeTopologyHash(a)).not.toBe(computeTopologyHash(b))
  })
})

describe('selectDiverse', () => {
  function makeCandidate(nodeTypes: string[], description: string): ImportCandidate {
    const wf: N8nWorkflow = {
      name: 'C',
      nodes: nodeTypes.map((t, i) => node({ name: `N${i}`, type: t })),
      connections: {},
    }
    return { workflow: wf, description, hash: Math.random().toString(36), filePath: '/x', trustLevel: 'safe', safetyReasons: [] }
  }

  it('returns all candidates when under the limit', () => {
    const candidates = [makeCandidate(['n8n-nodes-base.webhook'], 'a'), makeCandidate(['n8n-nodes-base.slack'], 'b')]
    expect(selectDiverse(candidates, 10, new Map())).toHaveLength(2)
  })

  it('returns empty for a zero or negative limit', () => {
    const candidates = [makeCandidate(['n8n-nodes-base.webhook'], 'a')]
    expect(selectDiverse(candidates, 0, new Map())).toHaveLength(0)
  })

  it('guarantees at least one item from each structural cluster (diversity floor)', () => {
    const clusterA = Array.from({ length: 5 }, () => makeCandidate(['n8n-nodes-base.webhook', 'n8n-nodes-base.slack'], 'send a slack message'))
    const clusterB = Array.from({ length: 5 }, () => makeCandidate(['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.gmail'], 'send an email report'))
    const selected = selectDiverse([...clusterA, ...clusterB], 2, new Map())
    expect(selected).toHaveLength(2)
    // one from each cluster — distinguishable by which node types appear
    const hasWebhookCluster = selected.some((c) => c.workflow.nodes.some((n) => n.type === 'n8n-nodes-base.webhook'))
    const hasScheduleCluster = selected.some((c) => c.workflow.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger'))
    expect(hasWebhookCluster).toBe(true)
    expect(hasScheduleCluster).toBe(true)
  })

  it('respects the exact limit even with many clusters', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => makeCandidate([`n8n-nodes-base.custom${i}`], `unique ${i}`))
    expect(selectDiverse(candidates, 7, new Map())).toHaveLength(7)
  })

  it('falls back to a deterministic selection when no telemetry weights are provided', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate(['n8n-nodes-base.webhook'], `send email report ${i}`))
    const first = selectDiverse(candidates, 5, new Map())
    const second = selectDiverse(candidates, 5, new Map())
    expect(first).toHaveLength(5)
    expect(first.map((c) => c.description)).toEqual(second.map((c) => c.description))
  })
})

describe('LocalImporter.importFromDirectory', () => {
  let libDir: string
  let importDir: string
  let library: FileLibrary

  beforeEach(async () => {
    libDir = join(tmpdir(), `kairos-test-import-lib-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    importDir = join(tmpdir(), `kairos-test-import-src-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(libDir, { recursive: true })
    await mkdir(importDir, { recursive: true })
    library = new FileLibrary(libDir)
  })

  afterEach(async () => {
    await library.drain()
    await rm(libDir, { recursive: true, force: true })
    await rm(importDir, { recursive: true, force: true })
  })

  async function writeFixture(filename: string, content: unknown): Promise<void> {
    await writeFile(join(importDir, filename), JSON.stringify(content), 'utf-8')
  }

  it('imports valid workflows and saves them with imported provenance', async () => {
    await writeFixture('wf1.json', validWorkflow({ name: 'Alpha' }))
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir)

    expect(report.saved).toBe(1)
    const all = await library.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.sourceKind).toBe('imported')
    expect(all[0]!.sourceId).toBeTruthy()
    expect(all[0]!.sourceUrl).toContain('wf1.json')
  })

  it('counts unparseable JSON as a parse error and does not save it', async () => {
    await writeFile(join(importDir, 'broken.json'), '{ not valid json', 'utf-8')
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir)

    expect(report.parseErrors).toBe(1)
    expect(report.saved).toBe(0)
  })

  it('skips a duplicate topology within the same run', async () => {
    await writeFixture('a.json', validWorkflow({ name: 'A' }))
    await writeFixture('b.json', validWorkflow({ name: 'B' })) // same structure, different name/desc
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir)

    expect(report.parsed).toBe(2)
    expect(report.duplicates).toBe(1)
    expect(report.saved).toBe(1)
  })

  it('skips a duplicate that already exists in the library from a prior run', async () => {
    await writeFixture('a.json', validWorkflow({ name: 'A' }))
    const importer = new LocalImporter(library, NOOP_LOGGER)
    await importer.importFromDirectory(importDir)

    // Second run against the same file
    const report2 = await importer.importFromDirectory(importDir)
    expect(report2.duplicates).toBe(1)
    expect(report2.saved).toBe(0)
  })

  it('demotes a code-node-only workflow to review trust by default (not blocked)', async () => {
    await writeFixture('code.json', validWorkflow({
      nodes: [
        node({ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }),
        node({ name: 'Transform', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [{json: {ok: true}}]' } }),
      ],
      connections: { Trigger: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] } },
    }))
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir)

    expect(report.blocked).toBe(0)
    expect(report.reviewed).toBe(1)
    expect(report.saved).toBe(1)
    const all = await library.list()
    expect(all[0]!.trustLevel).toBe('review')
  })

  it('blocks code nodes when codeNodePolicy is explicitly "block"', async () => {
    await writeFixture('code.json', validWorkflow({
      nodes: [
        node({ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }),
        node({ name: 'Transform', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [{json: {ok: true}}]' } }),
      ],
      connections: { Trigger: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] } },
    }))
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir, { codeNodePolicy: 'block' })

    expect(report.blocked).toBe(1)
    expect(report.saved).toBe(0)
  })

  it('always blocks hardcoded secrets regardless of codeNodePolicy', async () => {
    await writeFixture('secret.json', validWorkflow({
      nodes: [
        node({ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }),
        node({ name: 'Call', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.example.com', headerParameters: { parameters: [{ name: 'Authorization', value: 'sk-abcdefghijklmnopqrstuvwx' }] } } }),
      ],
      connections: { Trigger: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
    }))
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir, { codeNodePolicy: 'review' })

    expect(report.blocked).toBe(1)
    expect(report.saved).toBe(0)
  })

  it('drops workflows that fail structural validation (duplicate node names, Rule 16)', async () => {
    await writeFixture('invalid.json', validWorkflow({
      nodes: [
        node({ name: 'Same', type: 'n8n-nodes-base.manualTrigger' }),
        node({ name: 'Same', type: 'n8n-nodes-base.slack' }),
      ],
      connections: {},
    }))
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir)

    expect(report.invalid).toBe(1)
    expect(report.saved).toBe(0)
  })

  it('dry-run persists nothing but still reports what would be selected', async () => {
    await writeFixture('a.json', validWorkflow({ name: 'A' }))
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir, { dryRun: true })

    expect(report.selected).toBe(1)
    expect(report.saved).toBe(0)
    const all = await library.list()
    expect(all).toHaveLength(0)
  })

  it('stops without saving when the library is already at capacity, and never touches existing entries', async () => {
    // MAX_LIBRARY_SIZE is read from KAIROS_LIBRARY_SIZE at module load time, so a fresh
    // module instance (via resetModules + dynamic import) is needed to pick up a small cap.
    const capDir = join(tmpdir(), `kairos-test-import-cap-${Date.now()}`)
    await mkdir(capDir, { recursive: true })
    const prevEnv = process.env['KAIROS_LIBRARY_SIZE']
    process.env['KAIROS_LIBRARY_SIZE'] = '10'
    vi.resetModules()
    try {
      const { FileLibrary: FreshFileLibrary } = await import('../../../src/library/file-library.js')
      const { LocalImporter: FreshLocalImporter } = await import('../../../src/templates/local-importer.js')

      const capLib = new FreshFileLibrary(capDir)
      await capLib.initialize()
      for (let i = 0; i < 10; i++) {
        await capLib.save(
          validWorkflow({ name: `Organic ${i}`, nodes: [node({ name: `T${i}`, type: 'n8n-nodes-base.manualTrigger' })], connections: {} }),
          { description: `organic workflow number ${i}` },
        )
      }

      await writeFixture('overflow.json', validWorkflow({ name: 'Overflow' }))
      const importer = new FreshLocalImporter(capLib, NOOP_LOGGER)
      const report = await importer.importFromDirectory(importDir)

      expect(report.capacityAvailable).toBe(0)
      expect(report.saved).toBe(0)
      expect(report.stoppedReason).toBeDefined()

      const all = await capLib.list()
      expect(all).toHaveLength(10)
      expect(all.every((w) => w.sourceKind !== 'imported')).toBe(true)

      await capLib.drain()
    } finally {
      if (prevEnv === undefined) delete process.env['KAIROS_LIBRARY_SIZE']
      else process.env['KAIROS_LIBRARY_SIZE'] = prevEnv
      vi.resetModules()
      await rm(capDir, { recursive: true, force: true })
    }
  })

  it('calls onProgress during processing', async () => {
    await writeFixture('a.json', validWorkflow({ name: 'A' }))
    await writeFixture('b.json', validWorkflow({ name: 'B', nodes: [node({ name: 'T', type: 'n8n-nodes-base.scheduleTrigger' })], connections: {} }))
    const snapshots: number[] = []
    const importer = new LocalImporter(library, NOOP_LOGGER)
    await importer.importFromDirectory(importDir, { onProgress: (p) => snapshots.push(p.parsed) })
    expect(snapshots.length).toBeGreaterThan(0)
  })

  it('reads workflow files nested in category subdirectories', async () => {
    await mkdir(join(importDir, 'messaging'), { recursive: true })
    await writeFile(join(importDir, 'messaging', 'nested.json'), JSON.stringify(validWorkflow({ name: 'Nested' })), 'utf-8')
    const importer = new LocalImporter(library, NOOP_LOGGER)
    const report = await importer.importFromDirectory(importDir)
    expect(report.saved).toBe(1)
  })
})
