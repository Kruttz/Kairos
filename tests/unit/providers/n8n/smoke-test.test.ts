import { describe, it, expect, vi, beforeEach } from 'vitest'
import { N8nProvider } from '../../../../src/providers/n8n/provider.js'
import { N8nFieldStripper } from '../../../../src/providers/n8n/stripper.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'
import type { ExecutionDetail } from '../../../../src/types/result.js'

function makeWorkflow(
  triggerType: 'manual' | 'webhook' | 'schedule',
  webhookPath = 'my-hook',
): N8nWorkflow {
  const nodeType =
    triggerType === 'manual'
      ? 'n8n-nodes-base.manualTrigger'
      : triggerType === 'webhook'
        ? 'n8n-nodes-base.webhook'
        : 'n8n-nodes-base.scheduleTrigger'

  return {
    name: 'Test',
    nodes: [
      {
        id: 'node-1',
        name: 'Trigger',
        type: nodeType,
        typeVersion: 1,
        position: [0, 0],
        parameters: triggerType === 'webhook' ? { path: webhookPath } : {},
      },
    ],
    connections: {},
  }
}

function makeExecution(status: ExecutionDetail['status']): ExecutionDetail {
  return {
    id: 'exec-42',
    workflowId: 'wf-1',
    status,
    startedAt: new Date().toISOString(),
    mode: 'manual',
  }
}

function makeProvider(overrides: Partial<Record<keyof N8nApiClient, unknown>> = {}): N8nProvider {
  const client = {
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    getWorkflow: vi.fn(),
    listWorkflows: vi.fn(),
    deleteWorkflow: vi.fn(),
    activateWorkflow: vi.fn(),
    deactivateWorkflow: vi.fn(),
    getExecutions: vi.fn(),
    getExecution: vi.fn(),
    listTags: vi.fn(),
    createTag: vi.fn(),
    tagWorkflow: vi.fn(),
    untagWorkflow: vi.fn(),
    getNodeTypes: vi.fn(),
    triggerManual: vi.fn(),
    triggerWebhookTest: vi.fn(),
    ...overrides,
  } as unknown as N8nApiClient
  return new N8nProvider(client, new N8nFieldStripper())
}

describe('N8nProvider.smokeTest()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('returns not-applicable for unsupported trigger types (schedule)', async () => {
    const provider = makeProvider()
    const result = await provider.smokeTest('wf-1', makeWorkflow('schedule'))
    expect(result.status).toBe('not-applicable')
    expect(result.triggerType).toBe('not-applicable')
  })

  it('manual trigger — passed on success execution', async () => {
    const getExecution = vi.fn().mockResolvedValue(makeExecution('success'))
    const triggerManual = vi.fn().mockResolvedValue('exec-42')
    const provider = makeProvider({ triggerManual, getExecution })

    const resultPromise = provider.smokeTest('wf-1', makeWorkflow('manual'))
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.status).toBe('passed')
    expect(result.triggerType).toBe('manual')
    expect(result.executionId).toBe('exec-42')
    expect(result.durationMs).toBeTypeOf('number')
    expect(result.error).toBeUndefined()
  })

  it('manual trigger — failed when execution status is error', async () => {
    const getExecution = vi.fn().mockResolvedValue(makeExecution('error'))
    const triggerManual = vi.fn().mockResolvedValue('exec-99')
    const provider = makeProvider({ triggerManual, getExecution })

    const resultPromise = provider.smokeTest('wf-1', makeWorkflow('manual'))
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.status).toBe('failed')
    expect(result.triggerType).toBe('manual')
    expect(result.executionId).toBe('exec-99')
    expect(result.error).toContain('error')
  })

  it('manual trigger — failed when execution status is canceled', async () => {
    const getExecution = vi.fn().mockResolvedValue(makeExecution('canceled'))
    const triggerManual = vi.fn().mockResolvedValue('exec-10')
    const provider = makeProvider({ triggerManual, getExecution })

    const resultPromise = provider.smokeTest('wf-1', makeWorkflow('manual'))
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.status).toBe('failed')
    expect(result.error).toContain('canceled')
  })

  it('manual trigger — error when triggerManual throws', async () => {
    const triggerManual = vi.fn().mockRejectedValue(new Error('network down'))
    const provider = makeProvider({ triggerManual })

    const result = await provider.smokeTest('wf-1', makeWorkflow('manual'))

    expect(result.status).toBe('error')
    expect(result.triggerType).toBe('manual')
    expect(result.error).toContain('network down')
    expect(result.executionId).toBeUndefined()
  })

  it('manual trigger — polls until execution completes', async () => {
    const getExecution = vi
      .fn()
      .mockResolvedValueOnce(makeExecution('running'))
      .mockResolvedValueOnce(makeExecution('running'))
      .mockResolvedValue(makeExecution('success'))
    const triggerManual = vi.fn().mockResolvedValue('exec-42')
    const provider = makeProvider({ triggerManual, getExecution })

    const resultPromise = provider.smokeTest('wf-1', makeWorkflow('manual'))
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.status).toBe('passed')
    expect(getExecution).toHaveBeenCalledTimes(3)
  })

  it('webhook trigger — passed on 200 response', async () => {
    const triggerWebhookTest = vi.fn().mockResolvedValue(200)
    const provider = makeProvider({ triggerWebhookTest })

    const result = await provider.smokeTest('wf-1', makeWorkflow('webhook', 'my-path'))

    expect(result.status).toBe('passed')
    expect(result.triggerType).toBe('webhook')
    expect(result.durationMs).toBeTypeOf('number')
    expect(result.executionId).toBeUndefined()
    expect(triggerWebhookTest).toHaveBeenCalledWith('my-path')
  })

  it('webhook trigger — failed on 500 response', async () => {
    const triggerWebhookTest = vi.fn().mockResolvedValue(500)
    const provider = makeProvider({ triggerWebhookTest })

    const result = await provider.smokeTest('wf-1', makeWorkflow('webhook', 'my-path'))

    expect(result.status).toBe('failed')
    expect(result.error).toContain('500')
  })

  it('webhook trigger — error when request throws', async () => {
    const triggerWebhookTest = vi.fn().mockRejectedValue(new Error('connection refused'))
    const provider = makeProvider({ triggerWebhookTest })

    const result = await provider.smokeTest('wf-1', makeWorkflow('webhook'))

    expect(result.status).toBe('error')
    expect(result.triggerType).toBe('webhook')
    expect(result.error).toContain('connection refused')
  })

  it('extracts webhook path from node parameters', async () => {
    const triggerWebhookTest = vi.fn().mockResolvedValue(200)
    const provider = makeProvider({ triggerWebhookTest })

    await provider.smokeTest('wf-1', makeWorkflow('webhook', 'custom/path'))

    expect(triggerWebhookTest).toHaveBeenCalledWith('custom/path')
  })

  it('uses "webhook" as fallback path when webhook node has no path param', async () => {
    const triggerWebhookTest = vi.fn().mockResolvedValue(200)
    const provider = makeProvider({ triggerWebhookTest })

    const workflow: N8nWorkflow = {
      name: 'Test',
      nodes: [
        {
          id: 'node-1',
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    }
    await provider.smokeTest('wf-1', workflow)

    expect(triggerWebhookTest).toHaveBeenCalledWith('webhook')
  })
})

describe('N8nProvider.smokeTest() — API client triggerManual extraction', () => {
  it('uses exec id string as executionId in result', async () => {
    const getExecution = vi.fn().mockResolvedValue(makeExecution('success'))
    const triggerManual = vi.fn().mockResolvedValue('exec-abc')
    const provider = makeProvider({ triggerManual, getExecution })

    const resultPromise = provider.smokeTest('wf-1', makeWorkflow('manual'))
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.executionId).toBe('exec-abc')
  })
})
