import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  capturePayloads,
  listCapturedPayloads,
  deleteCapturedPayloads,
  captureDir,
  type CapturedPayload,
} from '../../../../src/reliability/replay/capture.js'
import { GuardError } from '../../../../src/errors/guard-error.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'

const WEBHOOK_WORKFLOW: N8nWorkflow = {
  nodes: [
    { id: '1', name: 'My Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } },
    { id: '2', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [250, 0], parameters: {} },
  ],
  connections: {},
  settings: {},
}

const NON_WEBHOOK_WORKFLOW: N8nWorkflow = {
  nodes: [{ id: '1', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {},
  settings: {},
}

function makeExecutionDetail(overrides: { body?: unknown; headers?: unknown } = {}) {
  return {
    id: 'exec-1',
    workflowId: 'wf-1',
    status: 'success',
    startedAt: '2026-01-01T00:00:00.000Z',
    mode: 'webhook',
    data: {
      resultData: {
        runData: {
          'My Webhook': [
            {
              data: {
                main: [[{ json: {
                  headers: overrides.headers ?? { host: 'localhost' },
                  body: overrides.body ?? { customerName: 'Jane', customerPhone: '555-0100' },
                  webhookUrl: 'http://localhost:15679/webhook/x',
                  executionMode: 'production',
                } }]],
              },
            },
          ],
        },
      },
    },
  }
}

interface MockClient {
  getExecutions: (workflowId?: string, filter?: unknown) => Promise<Array<{ id: string }>>
  getExecution: (id: string) => Promise<ReturnType<typeof makeExecutionDetail>>
}

function mockClient(overrides: Partial<MockClient> = {}): N8nApiClient {
  return {
    getExecutions: overrides.getExecutions ?? (async () => [{ id: 'exec-1' }]),
    getExecution: overrides.getExecution ?? (async () => makeExecutionDetail()),
  } as unknown as N8nApiClient
}

// Redirect HOME so these tests never touch the real ~/.kairos/captures directory.
let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-capture-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('capturePayloads', () => {
  it('skips non-webhook workflows honestly, does not throw', async () => {
    const result = await capturePayloads(mockClient(), NON_WEBHOOK_WORKFLOW, 'wf-1', 'client-a')
    expect(result.skippedNonWebhook).toBe(true)
    expect(result.captured).toEqual([])
  })

  it('captures only the trigger node payload fields, not the whole execution', async () => {
    const result = await capturePayloads(mockClient(), WEBHOOK_WORKFLOW, 'wf-1', 'client-a')
    expect(result.captured).toHaveLength(1)
    const captured = result.captured[0]!
    expect(captured.payload).toEqual({
      headers: { host: 'localhost' },
      body: { customerName: 'Jane', customerPhone: '555-0100' },
      webhookUrl: 'http://localhost:15679/webhook/x',
      executionMode: 'production',
    })
    expect(captured.triggerNodeName).toBe('My Webhook')
    expect(captured.scrubbed).toBe(false)
  })

  it('writes captures to disk chmod 600', async () => {
    await capturePayloads(mockClient(), WEBHOOK_WORKFLOW, 'wf-1', 'client-a')
    const dir = captureDir('client-a', 'wf-1')
    const filePath = join(dir, 'exec-1.json')
    const stats = await stat(filePath)
    // POSIX mode bits: owner read/write only, nothing for group/other.
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('rejects an invalid clientId before touching the filesystem (fail-closed, path-traversal guard)', async () => {
    await expect(capturePayloads(mockClient(), WEBHOOK_WORKFLOW, 'wf-1', '../../etc')).rejects.toThrow(GuardError)
    await expect(capturePayloads(mockClient(), WEBHOOK_WORKFLOW, 'wf-1', 'Has Spaces')).rejects.toThrow(GuardError)
  })

  describe('--scrub', () => {
    it('does not scrub by default', async () => {
      const secretBody = { note: 'Bearer sk-ant-abcdefghijklmnop1234567890' }
      const result = await capturePayloads(
        mockClient({ getExecution: async () => makeExecutionDetail({ body: secretBody }) }),
        WEBHOOK_WORKFLOW, 'wf-1', 'client-a',
      )
      expect(result.captured[0]!.payload.body).toEqual(secretBody)
      expect(result.captured[0]!.scrubbed).toBe(false)
    })

    it('redacts a recognizable secret pattern when --scrub is on', async () => {
      const secretBody = { note: 'sk-ant-abcdefghijklmnop1234567890' }
      const result = await capturePayloads(
        mockClient({ getExecution: async () => makeExecutionDetail({ body: secretBody }) }),
        WEBHOOK_WORKFLOW, 'wf-1', 'client-a', { scrub: true },
      )
      expect(result.captured[0]!.scrubbed).toBe(true)
      expect(JSON.stringify(result.captured[0]!.payload)).toContain('REDACTED')
      expect(JSON.stringify(result.captured[0]!.payload)).not.toContain('sk-ant-abcdefghijklmnop1234567890')
    })

    it('does NOT claim scrubbed when scrub is on but nothing matched -- honest, not optimistic', async () => {
      const result = await capturePayloads(mockClient(), WEBHOOK_WORKFLOW, 'wf-1', 'client-a', { scrub: true })
      expect(result.captured[0]!.scrubbed).toBe(false)
    })

    it('scrub is best-effort, not a PII guarantee: an ordinary customer name/phone survives scrubbing', async () => {
      // The whole point of the module doc's honesty requirement -- a name/phone number
      // doesn't match any of the secret-shaped regexes and must NOT be redacted, proving
      // --scrub cannot be mistaken for "this payload is now PII-free."
      const result = await capturePayloads(
        mockClient({ getExecution: async () => makeExecutionDetail({ body: { customerName: 'Jane Test', customerPhone: '555-0100' } }) }),
        WEBHOOK_WORKFLOW, 'wf-1', 'client-a', { scrub: true },
      )
      expect(result.captured[0]!.scrubbed).toBe(false)
      expect(result.captured[0]!.payload.body).toEqual({ customerName: 'Jane Test', customerPhone: '555-0100' })
    })
  })

  describe('retention', () => {
    it('caps at maxPerWorkflow, keeping the newest', async () => {
      const executions = Array.from({ length: 5 }, (_, i) => ({ id: `exec-${i}` }))
      let call = 0
      const result = await capturePayloads(
        mockClient({
          getExecutions: async () => executions,
          getExecution: async (id: string) => {
            call++
            return { ...makeExecutionDetail(), id }
          },
        }),
        WEBHOOK_WORKFLOW, 'wf-1', 'client-a', { maxPerWorkflow: 2 },
      )
      expect(call).toBe(5) // fetched all 5
      expect(result.sweptCount).toBe(3) // but only 2 survive after the sweep
      const remaining = await listCapturedPayloads('client-a', 'wf-1')
      expect(remaining).toHaveLength(2)
    })

    it('sweeps captures older than retentionDays regardless of count', async () => {
      const dir = captureDir('client-a', 'wf-1')
      await mkdir(dir, { recursive: true })
      const old: CapturedPayload = {
        executionId: 'exec-old',
        capturedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), // 40 days ago
        triggerNodeName: 'My Webhook',
        payload: {},
        scrubbed: false,
      }
      await writeFile(join(dir, 'exec-old.json'), JSON.stringify(old), 'utf-8')

      const result = await capturePayloads(mockClient(), WEBHOOK_WORKFLOW, 'wf-1', 'client-a', { retentionDays: 30 })
      const remaining = await listCapturedPayloads('client-a', 'wf-1')
      expect(remaining.some(r => r.executionId === 'exec-old')).toBe(false)
      expect(result.sweptCount).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('deleteCapturedPayloads -- the revocation path', () => {
  it('deletes every capture for a workflow and reports the count', async () => {
    await capturePayloads(mockClient(), WEBHOOK_WORKFLOW, 'wf-1', 'client-a')
    expect(await listCapturedPayloads('client-a', 'wf-1')).toHaveLength(1)

    const result = await deleteCapturedPayloads('client-a', 'wf-1')
    expect(result.deletedCount).toBe(1)
    expect(await listCapturedPayloads('client-a', 'wf-1')).toHaveLength(0)
  })

  it('is a safe no-op when nothing was ever captured', async () => {
    const result = await deleteCapturedPayloads('client-a', 'never-captured-wf')
    expect(result.deletedCount).toBe(0)
  })
})

describe('captureDir', () => {
  it('scopes by clientId and workflowId under ~/.kairos/captures', () => {
    const dir = captureDir('acme', 'wf-42')
    expect(dir.endsWith(join('.kairos', 'captures', 'acme', 'wf-42'))).toBe(true)
  })

  it('rejects a malformed clientId rather than constructing a path from it', () => {
    expect(() => captureDir('../escape', 'wf-1')).toThrow(GuardError)
  })
})
