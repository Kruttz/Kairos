import { describe, it, expect, vi, afterEach } from 'vitest'
import { Kairos } from '../../src/client.js'
import { N8nProvider } from '../../src/providers/n8n/provider.js'
import { WorkflowDesigner } from '../../src/generation/designer.js'
import type { DesignResult } from '../../src/generation/types.js'

const OLD_WORKFLOW = {
  name: 'Test Workflow',
  nodes: [
    { id: 'a', name: 'Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] as [number, number], parameters: {} },
    { id: 'b', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 1, position: [200, 0] as [number, number], parameters: {}, credentials: { slackApi: { id: '1', name: 'My Slack' } } },
  ],
  connections: {},
}

function canned(newNodeType: string): DesignResult {
  return {
    workflow: {
      name: 'Test Workflow',
      nodes: [
        { id: 'a', name: 'Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} },
        { id: 'b', name: 'Notify', type: newNodeType, typeVersion: 1, position: [200, 0], parameters: {}, credentials: { postgres: { id: '2', name: 'My DB' } } },
      ],
      connections: {},
      settings: { executionOrder: 'v1' },
    },
    credentialsNeeded: [],
    attempts: 1,
    attemptMetadata: [{ tokensInput: 10, tokensOutput: 10, durationMs: 5, validationPassed: true, issues: [] }],
    warnedRules: [],
  }
}

describe('Kairos.replace() — diff against the previously-deployed workflow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('includes a "what changed" diff in the summary when the previous workflow can be fetched', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned('n8n-nodes-base.postgres'))
    vi.spyOn(N8nProvider.prototype, 'get').mockResolvedValue(OLD_WORKFLOW)
    vi.spyOn(N8nProvider.prototype, 'update').mockResolvedValue({ workflowId: 'wf-1', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.replace('wf-1', 'Change Notify to use Postgres instead of Slack')

    expect(result.summary).toContain('What changed since the previous version:')
    expect(result.summary).toContain('"Notify" changed from n8n-nodes-base.slack to n8n-nodes-base.postgres')
    expect(result.summary).toContain('now needs a "postgres" credential')
    expect(result.summary).toContain('no longer needs a "slackApi" credential')
  })

  it('degrades gracefully (no diff, no throw) when fetching the previous workflow fails', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned('n8n-nodes-base.slack'))
    vi.spyOn(N8nProvider.prototype, 'get').mockRejectedValue(new Error('n8n returned 404'))
    vi.spyOn(N8nProvider.prototype, 'update').mockResolvedValue({ workflowId: 'wf-2', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.replace('wf-2', 'Some change')

    expect(result.workflowId).toBe('wf-2')
    expect(result.summary).not.toContain('What changed since the previous version:')
  })
})
