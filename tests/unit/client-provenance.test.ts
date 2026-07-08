import { describe, it, expect, vi, afterEach } from 'vitest'
import { Kairos } from '../../src/client.js'
import { N8nProvider } from '../../src/providers/n8n/provider.js'
import { WorkflowDesigner } from '../../src/generation/designer.js'
import { computeWorkflowHash } from '../../src/utils/workflow-hash.js'
import { getRuleSetVersion, getPromptVersion, getNodeCatalogVersion, getKairosVersion } from '../../src/validation/provenance-versions.js'
import type { DesignResult } from '../../src/generation/types.js'

function canned(temperature = 0.3): DesignResult {
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
    attemptMetadata: [{ tokensInput: 10, tokensOutput: 10, durationMs: 5, validationPassed: true, issues: [], temperature }],
    warnedRules: [],
  }
}

describe('BuildResult.provenance plumbing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('build() dry-run carries real model/settings/runId and content-derived versions', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned(0.4))

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
      model: 'claude-test-model',
      maxTokens: 12345,
    })

    const result = await kairos.build('Test description', { dryRun: true })

    expect(result.provenance).toBeDefined()
    expect(result.provenance?.model).toBe('claude-test-model')
    expect(result.provenance?.maxTokens).toBe(12345)
    expect(result.provenance?.temperature).toBe(0.4)
    expect(typeof result.provenance?.runId).toBe('string')
    expect(result.provenance?.runId.length).toBeGreaterThan(0)
    expect(result.provenance?.kairosVersion).toBe(getKairosVersion())
    expect(result.provenance?.ruleSetVersion).toBe(getRuleSetVersion())
    expect(result.provenance?.promptVersion).toBe(getPromptVersion())
    expect(result.provenance?.nodeCatalogVersion).toEqual(getNodeCatalogVersion())
    expect(result.provenance?.workflowHash).toBe(computeWorkflowHash(result.workflow))
  })

  it('build() (deployed) carries provenance too', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned())
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-1', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description')
    expect(result.provenance).toBeDefined()
    expect(result.provenance?.workflowHash).toBe(computeWorkflowHash(result.workflow))
  })

  it('replace() carries provenance too', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(canned())
    vi.spyOn(N8nProvider.prototype, 'get').mockRejectedValue(new Error('no previous version'))
    vi.spyOn(N8nProvider.prototype, 'update').mockResolvedValue({ workflowId: 'wf-3', name: 'Test Workflow' })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.replace('wf-3', 'Some change')
    expect(result.provenance).toBeDefined()
    expect(result.provenance?.workflowHash).toBe(computeWorkflowHash(result.workflow))
  })

  it('two builds producing workflows that differ only in connections get different workflowHash values', async () => {
    const base = canned()
    const secondNode = { id: '660e8400-e29b-41d4-a716-446655440001', name: 'Second Node', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0] as [number, number], parameters: {} }
    const wired: DesignResult = {
      ...base,
      workflow: { ...base.workflow, nodes: [...base.workflow.nodes, secondNode], connections: { 'Manual Trigger': { main: [[{ node: 'Second Node', type: 'main', index: 0 }]] } } },
    }
    const unwired: DesignResult = { ...wired, workflow: { ...wired.workflow, connections: {} } }

    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValueOnce(wired).mockResolvedValueOnce(unwired)

    const kairos = new Kairos({ anthropicApiKey: 'sk-ant-test', n8nBaseUrl: 'https://fake-n8n.example.com', n8nApiKey: 'fake-key' })

    const first = await kairos.build('First', { dryRun: true })
    const second = await kairos.build('Second', { dryRun: true })

    expect(first.provenance?.workflowHash).not.toBe(second.provenance?.workflowHash)
  })
})
