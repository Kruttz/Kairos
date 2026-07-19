import { describe, it, expect } from 'vitest'
import { runStaticChaosAudit } from '../../../../src/reliability/chaos/static-audit.js'
import type { N8nWorkflow, N8nNode } from '../../../../src/types/workflow.js'

function makeNode(overrides: Partial<N8nNode> = {}): N8nNode {
  return {
    id: 'n1', name: 'Node', type: 'n8n-nodes-base.set', typeVersion: 1, position: [0, 0], parameters: {},
    ...overrides,
  }
}

function makeWorkflow(nodes: N8nNode[]): N8nWorkflow {
  return { name: 'Test Workflow', nodes, connections: {} }
}

describe('runStaticChaosAudit — unguarded field refs', () => {
  it('flags a field reference with no fallback operator', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Send SMS', parameters: { text: '={{$json.body.customerPhone}}' } }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.unguardedFieldRefs).toHaveLength(1)
    expect(result.unguardedFieldRefs[0]).toMatchObject({
      field: 'customerPhone', fieldSource: 'body', nodeName: 'Send SMS', nodeType: 'n8n-nodes-base.set',
    })
    expect(result.unguardedFieldRefs[0]!.summary).toContain('Send SMS')
  })

  it('does not flag a field reference guarded by || in the same expression block', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Send SMS', parameters: { text: "={{$json.body.customerPhone || 'unknown'}}" } }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.unguardedFieldRefs).toHaveLength(0)
  })

  it('does not flag a field reference guarded by ?? in the same expression block', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Send SMS', parameters: { text: "={{$json.body.customerPhone ?? 'unknown'}}" } }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.unguardedFieldRefs).toHaveLength(0)
  })

  it('does not flag references inside IF/Switch/Filter nodes — the reference is the guard itself', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Check Phone', type: 'n8n-nodes-base.if', parameters: { conditions: '={{$json.body.customerPhone}}' } }),
      makeNode({ name: 'Route', type: 'n8n-nodes-base.switch', parameters: { value: '={{$json.body.customerPhone}}' } }),
      makeNode({ name: 'Only Valid', type: 'n8n-nodes-base.filter', parameters: { value: '={{$json.body.customerPhone}}' } }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.unguardedFieldRefs).toHaveLength(0)
  })

  it('scopes the guard check to the same expression block, not the whole node', () => {
    const workflow = makeWorkflow([
      makeNode({
        name: 'Two Fields',
        parameters: {
          a: '={{$json.body.email || "none"}}',
          b: '={{$json.body.phone}}',
        },
      }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.unguardedFieldRefs).toHaveLength(1)
    expect(result.unguardedFieldRefs[0]!.field).toBe('phone')
  })

  it('flags one finding per node per unguarded reference across multiple nodes', () => {
    const workflow = makeWorkflow([
      makeNode({ id: 'n1', name: 'Node A', parameters: { a: '={{$json.body.email}}' } }),
      makeNode({ id: 'n2', name: 'Node B', parameters: { b: '={{$json.body.email}}' } }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.unguardedFieldRefs).toHaveLength(2)
    expect(result.unguardedFieldRefs.map((f) => f.nodeName).sort()).toEqual(['Node A', 'Node B'])
  })

  it('returns no findings for a workflow with no field references at all', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { value: 'no expressions here' } })])
    const result = runStaticChaosAudit(workflow)
    expect(result.unguardedFieldRefs).toHaveLength(0)
  })
})

describe('runStaticChaosAudit — external call posture', () => {
  it('flags an httpRequest node with no onError and no retryOnFail', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: {} }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.externalCallPostureFindings).toHaveLength(1)
    expect(result.externalCallPostureFindings[0]!.nodeName).toBe('Call API')
  })

  it('flags a credentialed node with no onError and no retryOnFail', () => {
    const workflow = makeWorkflow([
      makeNode({
        name: 'Send Slack', type: 'n8n-nodes-base.slack', parameters: {},
        credentials: { slackApi: { id: '1', name: 'slack' } },
      }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.externalCallPostureFindings).toHaveLength(1)
  })

  it('does not flag a node with onError set to continueRegularOutput', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: {}, onError: 'continueRegularOutput' }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.externalCallPostureFindings).toHaveLength(0)
  })

  it('does not flag a node with retryOnFail set to true', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: {}, retryOnFail: true }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.externalCallPostureFindings).toHaveLength(0)
  })

  it('does not flag a plain Set node with no external call', () => {
    const workflow = makeWorkflow([makeNode({ name: 'Just Set', type: 'n8n-nodes-base.set', parameters: {} })])
    const result = runStaticChaosAudit(workflow)
    expect(result.externalCallPostureFindings).toHaveLength(0)
  })

  it('does not flag a credentialed node whose credentials object is empty', () => {
    const workflow = makeWorkflow([
      makeNode({ name: 'Weird', type: 'n8n-nodes-base.someNode', parameters: {}, credentials: {} }),
    ])
    const result = runStaticChaosAudit(workflow)
    expect(result.externalCallPostureFindings).toHaveLength(0)
  })
})

describe('runStaticChaosAudit — cross-referenced rules and disclaimer', () => {
  it('always includes the disclaimer', () => {
    const workflow = makeWorkflow([makeNode()])
    const result = runStaticChaosAudit(workflow)
    expect(result.disclaimer.length).toBeGreaterThan(0)
  })

  it('always includes a cross-reference to Rule 78 rather than recomputing the errorWorkflow check', () => {
    const workflow = makeWorkflow([makeNode()])
    const result = runStaticChaosAudit(workflow)
    const rule78 = result.crossReferencedRules.find((r) => r.rule === 78)
    expect(rule78).toBeDefined()
    expect(rule78!.note).toContain('errorWorkflow')
  })

  it('always includes cross-references to Rules 56 and 128', () => {
    const workflow = makeWorkflow([makeNode()])
    const result = runStaticChaosAudit(workflow)
    expect(result.crossReferencedRules.map((r) => r.rule)).toEqual(expect.arrayContaining([56, 128]))
  })
})
