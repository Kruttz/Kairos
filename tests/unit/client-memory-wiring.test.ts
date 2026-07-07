import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Kairos } from '../../src/client.js'
import { N8nProvider } from '../../src/providers/n8n/provider.js'
import { WorkflowDesigner } from '../../src/generation/designer.js'
import { ClientMemoryStore } from '../../src/memory/store.js'
import type { DesignResult } from '../../src/generation/types.js'

// NOTE: mutating process.env['HOME'] at runtime does NOT reliably redirect os.homedir()
// inside vitest's worker context (confirmed directly: it works in a plain Node script, but
// not here) -- an earlier version of this file relied on that and silently wrote real test
// data into the actual ~/.kairos/clients/ directory on every run. Isolation here instead
// replaces the private memoryStore field with a store pointed at a real temp baseDir via
// ClientMemoryStore's own baseDir option, which every other memory test file already uses
// safely. Cleaned up afterEach either way.
//
// Also forces embeddings off -- this file tests build()/replace() wiring, not the optional
// embedding path, and fastembed is a devDependency here so it's always "installed" within
// this repo's own test runs; without this it would try to load a real model and time out.
process.env['KAIROS_MEMORY_EMBEDDINGS'] = 'off'

function cannedDesignResult(): DesignResult {
  return {
    workflow: {
      name: 'Test Workflow',
      nodes: [{ id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
      settings: { executionOrder: 'v1' },
    },
    credentialsNeeded: [{ service: 'Gmail', credentialType: 'gmailOAuth2', description: 'x' }],
    attempts: 1,
    attemptMetadata: [{ tokensInput: 10, tokensOutput: 10, durationMs: 5, validationPassed: true, issues: [] }],
    warnedRules: [],
  }
}

function injectIsolatedMemoryStore(kairos: Kairos, clientId: string, tmpDir: string): void {
  const isolatedStore = new ClientMemoryStore(clientId, { baseDir: tmpDir })
  ;(kairos as unknown as Record<string, unknown>)['memoryStore'] = isolatedStore
}

describe('Kairos — client memory wiring', () => {
  let tmpDirs: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
    tmpDirs = []
  })

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kairos-client-memory-'))
    tmpDirs.push(dir)
    return dir
  }

  it('passes clientContext to design() when clientId is set and a relevant memory exists', async () => {
    const designSpy = vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult())
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-1', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
      clientId: 'wiring-test-client',
    })
    injectIsolatedMemoryStore(kairos, 'wiring-test-client', await makeTmpDir())

    await kairos.remember({ type: 'preference', description: 'Prefers Slack over email for alerts', body: 'Client explicitly asked for Slack.' })
    await kairos.build('Send a Slack alert on Slack for new signups')

    expect(designSpy).toHaveBeenCalledTimes(1)
    const clientContextArg = designSpy.mock.calls[0]![3] as string | undefined
    expect(clientContextArg).toBeDefined()
    expect(clientContextArg).toContain('[Client Context')
    expect(clientContextArg).toContain('Prefers Slack over email for alerts')
  })

  it('does not pass clientContext when no clientId is set (default behavior unchanged)', async () => {
    const designSpy = vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult())
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-2', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    await kairos.build('Some workflow')

    expect(designSpy).toHaveBeenCalledTimes(1)
    const clientContextArg = designSpy.mock.calls[0]![3] as string | undefined
    expect(clientContextArg).toBeUndefined()
  })

  it('writes a history memory node after a successful build when clientId is set', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult())
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-3', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
      clientId: 'history-test-client',
    })
    injectIsolatedMemoryStore(kairos, 'history-test-client', await makeTmpDir())

    await kairos.build('Build something new')

    const history = await kairos.recall('Build something new', 5)
    expect(history.some((n) => n.type === 'history' && n.description.includes('Test Workflow'))).toBe(true)
  })

  it('does not write memory history when clientId is not set (no-op, no filesystem writes)', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult())
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-4', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    await kairos.build('Build something else')
    expect(await kairos.recall('anything')).toEqual([])
  })

  it('remember()/recall() are no-ops without a clientId (return null/[])', async () => {
    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    expect(await kairos.remember({ type: 'preference', description: 'x', body: 'x' })).toBeNull()
    expect(await kairos.recall('x')).toEqual([])
  })

  it('a memory write failure never fails the build', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult())
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-5', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
      clientId: 'failure-test-client',
    })
    injectIsolatedMemoryStore(kairos, 'failure-test-client', await makeTmpDir())

    // Force the memory write to throw, simulating a filesystem error mid-build.
    const storeField = (kairos as unknown as Record<string, unknown>)['memoryStore'] as { remember: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(storeField, 'remember').mockRejectedValue(new Error('disk full'))

    const result = await kairos.build('Build despite memory failure')
    expect(result.workflowId).toBe('wf-5')
  })
})
