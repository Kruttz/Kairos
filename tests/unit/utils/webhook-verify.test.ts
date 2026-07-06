import { describe, it, expect, vi } from 'vitest'
import { findWebhookTrigger, interpretWebhookProbe, verifyWebhookReachable } from '../../../src/utils/webhook-verify.js'
import type { N8nWorkflow, N8nNode } from '../../../src/types/workflow.js'

function node(overrides: Partial<N8nNode>): N8nNode {
  return {
    id: 'n1',
    name: 'Node',
    type: 'n8n-nodes-base.set',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
    ...overrides,
  }
}

function workflow(nodes: N8nNode[]): N8nWorkflow {
  return { name: 'Test', nodes, connections: {} }
}

describe('findWebhookTrigger', () => {
  it('returns null when there is no webhook node', () => {
    const wf = workflow([node({ type: 'n8n-nodes-base.scheduleTrigger' })])
    expect(findWebhookTrigger(wf)).toBeNull()
  })

  it('extracts a custom path and method', () => {
    const wf = workflow([
      node({ type: 'n8n-nodes-base.webhook', parameters: { path: 'my-hook', httpMethod: 'get' } }),
    ])
    expect(findWebhookTrigger(wf)).toEqual({ path: 'my-hook', httpMethod: 'GET' })
  })

  it('falls back to default path/method when not specified', () => {
    const wf = workflow([node({ type: 'n8n-nodes-base.webhook', parameters: {} })])
    expect(findWebhookTrigger(wf)).toEqual({ path: 'webhook', httpMethod: 'POST' })
  })
})

describe('interpretWebhookProbe', () => {
  it('reports reachable:false for the exact n8n "not registered" signature', () => {
    const result = interpretWebhookProbe(404, '{"code":404,"message":"The requested webhook \\"POST status-check\\" is not registered.","hint":"..."}')
    expect(result.reachable).toBe(false)
    expect(result.detail).toContain('not registered')
  })

  it('reports reachable:true for a 200', () => {
    const result = interpretWebhookProbe(200, '{"status":"ok"}')
    expect(result.reachable).toBe(true)
    expect(result.statusCode).toBe(200)
  })

  it('reports reachable:true for a 500 from the workflow\'s own logic (route still dispatched)', () => {
    const result = interpretWebhookProbe(500, '{"error":"downstream credential missing"}')
    expect(result.reachable).toBe(true)
  })

  it('reports reachable:true for a 404 that is NOT the specific not-registered signature', () => {
    const result = interpretWebhookProbe(404, '{"success":false,"error":"record not found"}')
    expect(result.reachable).toBe(true)
  })
})

describe('verifyWebhookReachable', () => {
  it('returns null when the workflow has no webhook trigger', async () => {
    const client = { triggerWebhookProduction: vi.fn() }
    const wf = workflow([node({ type: 'n8n-nodes-base.manualTrigger' })])
    expect(await verifyWebhookReachable(client, wf)).toBeNull()
    expect(client.triggerWebhookProduction).not.toHaveBeenCalled()
  })

  it('delegates to the client and interprets the result', async () => {
    const client = { triggerWebhookProduction: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"status":"ok"}' }) }
    const wf = workflow([node({ type: 'n8n-nodes-base.webhook', parameters: { path: 'my-hook', httpMethod: 'POST' } })])
    const result = await verifyWebhookReachable(client, wf)
    expect(result?.reachable).toBe(true)
    expect(client.triggerWebhookProduction).toHaveBeenCalledWith('my-hook', 'POST')
  })

  it('degrades to reachable:null (not a throw) when the probe itself fails', async () => {
    const client = { triggerWebhookProduction: vi.fn().mockRejectedValue(new Error('connection refused')) }
    const wf = workflow([node({ type: 'n8n-nodes-base.webhook', parameters: {} })])
    const result = await verifyWebhookReachable(client, wf)
    expect(result?.reachable).toBeNull()
    expect(result?.detail).toContain('connection refused')
  })
})
