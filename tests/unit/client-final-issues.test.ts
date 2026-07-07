import { describe, it, expect, vi, afterEach } from 'vitest'
import { Kairos } from '../../src/client.js'
import { N8nProvider } from '../../src/providers/n8n/provider.js'
import { WorkflowDesigner } from '../../src/generation/designer.js'
import type { DesignResult } from '../../src/generation/types.js'

const SAMPLE_ISSUES = [
  { rule: 90, severity: 'warn' as const, message: 'Long unbranched node chain', nodeId: 'n1' },
]

function canned(issues = SAMPLE_ISSUES): DesignResult {
  return {
    workflow: {
      name: 'Test Workflow',
      nodes: [{
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      }],
      connections: {},
      settings: { executionOrder: 'v1' },
    },
    credentialsNeeded: [],
    attempts: 1,
    attemptMetadata: [{ tokensInput: 10, tokensOutput: 10, durationMs: 5, validationPassed: true, issues }],
    warnedRules: [],
  }
}

describe('BuildResult.finalIssues plumbing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('build() dry-run carries the final attempt\'s validation issues', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned())

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description', { dryRun: true })
    expect(result.finalIssues).toEqual(SAMPLE_ISSUES)
  })

  it('build() (deployed) carries the final attempt\'s validation issues', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned())
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-1', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description')
    expect(result.finalIssues).toEqual(SAMPLE_ISSUES)
  })

  it('build() returns an empty array (not undefined) when the final attempt had no issues', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned([]))
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-2', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description')
    expect(result.finalIssues).toEqual([])
  })

  it('replace() carries the final attempt\'s validation issues', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned())
    vi.spyOn(N8nProvider.prototype, 'get').mockRejectedValue(new Error('no previous version'))
    vi.spyOn(N8nProvider.prototype, 'update').mockResolvedValue({ workflowId: 'wf-3', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.replace('wf-3', 'Some change')
    expect(result.finalIssues).toEqual(SAMPLE_ISSUES)
  })
})
