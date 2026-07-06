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
    triggerWebhookProduction: vi.fn(),
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

  it('webhook trigger — passed on 200 response, probing the PRODUCTION url', async () => {
    const triggerWebhookProduction = vi.fn().mockResolvedValue({ statusCode: 200, body: '{"status":"ok"}' })
    const provider = makeProvider({ triggerWebhookProduction })

    const result = await provider.smokeTest('wf-1', makeWorkflow('webhook', 'my-path'))

    expect(result.status).toBe('passed')
    expect(result.triggerType).toBe('webhook')
    expect(result.durationMs).toBeTypeOf('number')
    expect(result.executionId).toBeUndefined()
    expect(triggerWebhookProduction).toHaveBeenCalledWith('my-path', 'POST')
  })

  it('webhook trigger — still passed on a 500 from the workflow\'s own logic (route still dispatched)', async () => {
    const triggerWebhookProduction = vi.fn().mockResolvedValue({ statusCode: 500, body: '{"error":"downstream failure"}' })
    const provider = makeProvider({ triggerWebhookProduction })

    const result = await provider.smokeTest('wf-1', makeWorkflow('webhook', 'my-path'))

    expect(result.status).toBe('passed')
  })

  it('webhook trigger — failed with a clear "not registered" message when n8n reports the route unregistered', async () => {
    const triggerWebhookProduction = vi.fn().mockResolvedValue({
      statusCode: 404,
      body: '{"code":404,"message":"The requested webhook \\"POST my-path\\" is not registered.","hint":"..."}',
    })
    const provider = makeProvider({ triggerWebhookProduction })

    const result = await provider.smokeTest('wf-1', makeWorkflow('webhook', 'my-path'))

    expect(result.status).toBe('failed')
    expect(result.triggerType).toBe('webhook')
    expect(result.error).toContain('not registered')
  })

  it('webhook trigger — error when request throws', async () => {
    const triggerWebhookProduction = vi.fn().mockRejectedValue(new Error('connection refused'))
    const provider = makeProvider({ triggerWebhookProduction })

    const result = await provider.smokeTest('wf-1', makeWorkflow('webhook'))

    expect(result.status).toBe('error')
    expect(result.triggerType).toBe('webhook')
    expect(result.error).toContain('connection refused')
  })

  it('extracts webhook path from node parameters', async () => {
    const triggerWebhookProduction = vi.fn().mockResolvedValue({ statusCode: 200, body: '{}' })
    const provider = makeProvider({ triggerWebhookProduction })

    await provider.smokeTest('wf-1', makeWorkflow('webhook', 'custom/path'))

    expect(triggerWebhookProduction).toHaveBeenCalledWith('custom/path', 'POST')
  })

  it('uses "webhook" as fallback path when webhook node has no path param', async () => {
    const triggerWebhookProduction = vi.fn().mockResolvedValue({ statusCode: 200, body: '{}' })
    const provider = makeProvider({ triggerWebhookProduction })

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

    expect(triggerWebhookProduction).toHaveBeenCalledWith('webhook', 'POST')
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
