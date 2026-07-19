import { describe, it, expect } from 'vitest'
import { computeWorkflowHash, WORKFLOW_HASH_SCHEMA_VERSION } from '../../../src/utils/workflow-hash.js'
import type { N8nWorkflow } from '../../../src/types/workflow.js'

function makeWorkflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    name: 'Test Workflow',
    nodes: [
      { id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'intake', httpMethod: 'POST' } },
      { id: 'n2', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [200, 0], parameters: { channel: '#alerts' } },
    ],
    connections: { Trigger: { main: [[{ node: 'Notify', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    ...overrides,
  }
}

describe('computeWorkflowHash', () => {
  it('is stable across node array reordering', () => {
    const a = makeWorkflow()
    const b = makeWorkflow({ nodes: [...makeWorkflow().nodes].reverse() })
    expect(computeWorkflowHash(a)).toBe(computeWorkflowHash(b))
  })

  it('is stable across object key reordering within a node', () => {
    const a = makeWorkflow()
    const reordered = makeWorkflow()
    reordered.nodes[0] = { position: [0, 0], id: 'n1', parameters: { httpMethod: 'POST', path: 'intake' }, name: 'Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 2 }
    expect(computeWorkflowHash(a)).toBe(computeWorkflowHash(reordered))
  })

  it('changes when a node parameter value changes', () => {
    const a = makeWorkflow()
    const b = makeWorkflow()
    b.nodes[0]!.parameters = { ...b.nodes[0]!.parameters, path: 'different-path' }
    expect(computeWorkflowHash(a)).not.toBe(computeWorkflowHash(b))
  })

  it('changes when a node is added or removed', () => {
    const a = makeWorkflow()
    const b = makeWorkflow({ nodes: [a.nodes[0]!] })
    expect(computeWorkflowHash(a)).not.toBe(computeWorkflowHash(b))
  })

  it('changes when connections change but nodes/parameters are identical (the case a naive nodes-only hash would miss)', () => {
    const a = makeWorkflow()
    const b = makeWorkflow({ connections: {} }) // same nodes, same parameters, no wiring
    expect(computeWorkflowHash(a)).not.toBe(computeWorkflowHash(b))
  })

  it('changes when settings change but nodes/connections are identical', () => {
    const a = makeWorkflow()
    const b = makeWorkflow({ settings: { executionOrder: 'v0' } })
    expect(computeWorkflowHash(a)).not.toBe(computeWorkflowHash(b))
  })

  it('does NOT change when only the workflow name changes (deliberate scope decision)', () => {
    const a = makeWorkflow({ name: 'Original Name' })
    const b = makeWorkflow({ name: 'Renamed' })
    expect(computeWorkflowHash(a)).toBe(computeWorkflowHash(b))
  })

  it('does NOT change when only tags change (deliberate scope decision)', () => {
    const a = makeWorkflow({ tags: [{ id: 't1', name: 'prod' }] })
    const b = makeWorkflow({ tags: [{ id: 't2', name: 'staging' }] })
    expect(computeWorkflowHash(a)).toBe(computeWorkflowHash(b))
  })

  it('treats a missing settings object the same as an empty one', () => {
    const withSettings = makeWorkflow({ settings: {} })
    const withoutSettings = makeWorkflow()
    delete (withoutSettings as { settings?: unknown }).settings
    expect(computeWorkflowHash(withSettings)).toBe(computeWorkflowHash(withoutSettings))
  })

  it('produces a schema-version-prefixed SHA-256 digest', () => {
    const hash = computeWorkflowHash(makeWorkflow())
    expect(hash).toMatch(/^w2:[0-9a-f]{64}$/)
  })

  it('prefixes the current WORKFLOW_HASH_SCHEMA_VERSION exactly, not a hardcoded literal', () => {
    const hash = computeWorkflowHash(makeWorkflow())
    expect(hash.startsWith(`${WORKFLOW_HASH_SCHEMA_VERSION}:`)).toBe(true)
  })

  it('does NOT change when only webhookId differs -- n8n auto-assigns this to webhook nodes server-side at deploy/activation time; a workflow round-tripped through a live fetch must hash identically to the pre-deploy object Kairos built, or D9 would false-positive on every single webhook-triggered workflow, always (real bug found live, 2026-07-19, Phase 3 repair-apply checkpoint)', () => {
    const preDeploy = makeWorkflow()
    const postDeploy = makeWorkflow()
    postDeploy.nodes[0] = { ...postDeploy.nodes[0]!, webhookId: 'n8n-assigned-uuid-1234' } as typeof postDeploy.nodes[0]
    expect(computeWorkflowHash(preDeploy)).toBe(computeWorkflowHash(postDeploy))
  })

  it('still changes when a REAL parameter differs, even alongside a webhookId difference -- proves the fix only ignores webhookId specifically, not node differences generally', () => {
    const a = makeWorkflow()
    const b = makeWorkflow()
    b.nodes[0] = { ...b.nodes[0]!, webhookId: 'n8n-assigned-uuid-1234', parameters: { ...b.nodes[0]!.parameters, path: 'different-path' } } as typeof b.nodes[0]
    expect(computeWorkflowHash(a)).not.toBe(computeWorkflowHash(b))
  })
})
