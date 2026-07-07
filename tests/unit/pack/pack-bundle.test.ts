import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchWorkflowJson, writeWorkflowJsonFiles, slugifyWorkflowName } from '../../../src/pack/pack-bundle.js'
import type { N8nApiClient } from '../../../src/providers/n8n/index.js'
import type { N8nWorkflowResponse } from '../../../src/providers/n8n/types.js'

function makeResponse(overrides: Partial<N8nWorkflowResponse> = {}): N8nWorkflowResponse {
  return {
    id: 'wf-123',
    name: 'Missed-Call Text-Back',
    active: true,
    nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versionId: 'v1',
    ...overrides,
  }
}

function mockClient(getWorkflow: (id: string) => Promise<N8nWorkflowResponse>): N8nApiClient {
  return { getWorkflow } as unknown as N8nApiClient
}

let tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-pack-bundle-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
  tmpDirs = []
})

describe('slugifyWorkflowName', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugifyWorkflowName('Missed-Call Text-Back!')).toBe('missed-call-text-back')
  })

  it('falls back to a default for an all-symbol name', () => {
    expect(slugifyWorkflowName('!!!')).toBe('workflow')
  })
})

describe('fetchWorkflowJson', () => {
  it('returns the workflow stripped of n8n-internal fields on success', async () => {
    const client = mockClient(async () => makeResponse())
    const workflow = await fetchWorkflowJson('wf-123', client)
    expect(workflow).toEqual({
      name: 'Missed-Call Text-Back',
      nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    })
    expect(workflow).not.toHaveProperty('id')
    expect(workflow).not.toHaveProperty('active')
    expect(workflow).not.toHaveProperty('versionId')
  })

  it('preserves settings/tags when present', async () => {
    const client = mockClient(async () => makeResponse({ settings: { timezone: 'America/New_York' }, tags: [{ id: 't1', name: 'client-a' }] }))
    const workflow = await fetchWorkflowJson('wf-123', client)
    expect(workflow?.settings).toEqual({ timezone: 'America/New_York' })
    expect(workflow?.tags).toEqual([{ id: 't1', name: 'client-a' }])
  })

  it('returns null (does not throw) when the n8n API call fails', async () => {
    const client = mockClient(async () => { throw new Error('404 not found') })
    const workflow = await fetchWorkflowJson('wf-missing', client)
    expect(workflow).toBeNull()
  })
})

describe('writeWorkflowJsonFiles', () => {
  it('writes one file per workflow with a valid workflowId', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({ id, name: 'Referral Intake' }))
    const result = await writeWorkflowJsonFiles(
      [{ name: 'Referral Intake', workflowId: 'wf-1' }],
      client,
      dir,
    )
    expect(result.written).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
    const content = JSON.parse(await readFile(join(dir, 'referral-intake.workflow.json'), 'utf-8'))
    expect(content.name).toBe('Referral Intake')
  })

  it('skips a workflow with no workflowId, reporting why, without aborting the rest', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({ id }))
    const result = await writeWorkflowJsonFiles(
      [
        { name: 'Not Deployed', workflowId: null },
        { name: 'Deployed', workflowId: 'wf-2' },
      ],
      client,
      dir,
    )
    expect(result.written).toHaveLength(1)
    expect(result.written[0]!.workflowName).toBe('Deployed')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.workflowName).toBe('Not Deployed')
    expect(result.skipped[0]!.reason).toContain('no workflowId')
  })

  it('skips a workflow whose n8n fetch fails, without aborting the rest', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => {
      if (id === 'wf-bad') throw new Error('network error')
      return makeResponse({ id })
    })
    const result = await writeWorkflowJsonFiles(
      [
        { name: 'Broken', workflowId: 'wf-bad' },
        { name: 'Fine', workflowId: 'wf-ok' },
      ],
      client,
      dir,
    )
    expect(result.written).toHaveLength(1)
    expect(result.written[0]!.workflowName).toBe('Fine')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.workflowName).toBe('Broken')
    expect(result.skipped[0]!.reason).toContain('could not fetch')
  })

  it('creates the output directory if it does not exist', async () => {
    const dir = await makeTmpDir()
    const nestedDir = join(dir, 'nested', 'output')
    const client = mockClient(async (id) => makeResponse({ id }))
    await writeWorkflowJsonFiles([{ name: 'Test', workflowId: 'wf-1' }], client, nestedDir)
    const content = await readFile(join(nestedDir, 'test.workflow.json'), 'utf-8')
    expect(JSON.parse(content).name).toBeDefined()
  })
})
