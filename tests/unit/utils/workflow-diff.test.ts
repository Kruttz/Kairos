import { describe, it, expect } from 'vitest'
import { diffWorkflows, formatDiff } from '../../../src/utils/workflow-diff.js'
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

describe('diffWorkflows', () => {
  it('reports no changes when both workflows are identical', () => {
    const wf = workflow([node({ name: 'A', type: 'n8n-nodes-base.webhook' })])
    const diff = diffWorkflows(wf, wf)
    expect(diff.addedNodes).toEqual([])
    expect(diff.removedNodes).toEqual([])
    expect(diff.changedTypeNodes).toEqual([])
    expect(formatDiff(diff)).toContain('No structural changes.')
  })

  it('detects an added node', () => {
    const before = workflow([node({ name: 'A', type: 'n8n-nodes-base.webhook' })])
    const after = workflow([
      node({ name: 'A', type: 'n8n-nodes-base.webhook' }),
      node({ name: 'B', type: 'n8n-nodes-base.slack' }),
    ])
    const diff = diffWorkflows(before, after)
    expect(diff.addedNodes).toEqual([{ name: 'B', type: 'n8n-nodes-base.slack' }])
    expect(formatDiff(diff)).toContain('+ added "B" (n8n-nodes-base.slack)')
  })

  it('detects a removed node', () => {
    const before = workflow([
      node({ name: 'A', type: 'n8n-nodes-base.webhook' }),
      node({ name: 'B', type: 'n8n-nodes-base.slack' }),
    ])
    const after = workflow([node({ name: 'A', type: 'n8n-nodes-base.webhook' })])
    const diff = diffWorkflows(before, after)
    expect(diff.removedNodes).toEqual([{ name: 'B', type: 'n8n-nodes-base.slack' }])
    expect(formatDiff(diff)).toContain('- removed "B" (n8n-nodes-base.slack)')
  })

  it('detects a node whose type changed under the same name', () => {
    const before = workflow([node({ name: 'Notify', type: 'n8n-nodes-base.slack' })])
    const after = workflow([node({ name: 'Notify', type: 'n8n-nodes-base.telegram' })])
    const diff = diffWorkflows(before, after)
    expect(diff.changedTypeNodes).toEqual([{ name: 'Notify', oldType: 'n8n-nodes-base.slack', newType: 'n8n-nodes-base.telegram' }])
    expect(formatDiff(diff)).toContain('"Notify" changed from n8n-nodes-base.slack to n8n-nodes-base.telegram')
  })

  it('detects added and removed credential types', () => {
    const before = workflow([
      node({ name: 'A', type: 'n8n-nodes-base.slack', credentials: { slackApi: { id: '1', name: 'My Slack' } } }),
    ])
    const after = workflow([
      node({ name: 'A', type: 'n8n-nodes-base.postgres', credentials: { postgres: { id: '2', name: 'My DB' } } }),
    ])
    const diff = diffWorkflows(before, after)
    expect(diff.addedCredentialTypes).toEqual(['postgres'])
    expect(diff.removedCredentialTypes).toEqual(['slackApi'])
    expect(formatDiff(diff)).toContain('+ now needs a "postgres" credential')
    expect(formatDiff(diff)).toContain('- no longer needs a "slackApi" credential')
  })
})
