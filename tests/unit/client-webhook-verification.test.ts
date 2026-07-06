import { describe, it, expect, vi, afterEach } from 'vitest'
import { Kairos } from '../../src/client.js'
import { N8nProvider } from '../../src/providers/n8n/provider.js'
import { WorkflowDesigner } from '../../src/generation/designer.js'
import type { DesignResult } from '../../src/generation/types.js'
import type { SmokeTestResult } from '../../src/types/result.js'

function cannedDesignResult(triggerType: 'webhook' | 'manual'): DesignResult {
  return {
    workflow: {
      name: 'Test Workflow',
      nodes: [
        {
          id: 'a',
          name: 'Trigger',
          type: triggerType === 'webhook' ? 'n8n-nodes-base.webhook' : 'n8n-nodes-base.manualTrigger',
          typeVersion: 2,
          position: [0, 0],
          parameters: triggerType === 'webhook' ? { path: 'my-hook', httpMethod: 'POST' } : {},
        },
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

describe('Kairos.build() — webhook reachability verification after activate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('populates webhookVerification for a webhook workflow built with activate:true', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult('webhook'))
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-1', name: 'Test Workflow' })
    vi.spyOn(N8nProvider.prototype, 'activate').mockResolvedValue(undefined)
    const checkSpy = vi.spyOn(N8nProvider.prototype, 'checkWebhookReachable').mockResolvedValue({
      reachable: false,
      statusCode: 404,
      detail: 'n8n reports this workflow as active, but its production webhook returned 404 "not registered"...',
    })

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description', { activate: true })

    expect(checkSpy).toHaveBeenCalledTimes(1)
    expect(result.webhookVerification).toEqual({
      reachable: false,
      statusCode: 404,
      detail: expect.stringContaining('not registered'),
    })
    expect(result.summary).toContain('Production webhook NOT reachable')
  })

  it('leaves webhookVerification absent for a non-webhook workflow', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult('manual'))
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-2', name: 'Test Workflow' })
    vi.spyOn(N8nProvider.prototype, 'activate').mockResolvedValue(undefined)
    const checkSpy = vi.spyOn(N8nProvider.prototype, 'checkWebhookReachable').mockResolvedValue(null)

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description', { activate: true })

    expect(checkSpy).toHaveBeenCalledTimes(1)
    expect(result.webhookVerification).toBeUndefined()
  })

  it('does not run the check at all when activate is not requested', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult('webhook'))
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-3', name: 'Test Workflow' })
    const checkSpy = vi.spyOn(N8nProvider.prototype, 'checkWebhookReachable')

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description', { activate: false })

    expect(checkSpy).not.toHaveBeenCalled()
    expect(result.webhookVerification).toBeUndefined()
  })

  it('derives webhookVerification from smokeTest instead of double-probing when smokeTest is also requested', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(cannedDesignResult('webhook'))
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-4', name: 'Test Workflow' })
    vi.spyOn(N8nProvider.prototype, 'activate').mockResolvedValue(undefined)
    const checkSpy = vi.spyOn(N8nProvider.prototype, 'checkWebhookReachable')
    const smokeTestResult: SmokeTestResult = { status: 'passed', triggerType: 'webhook', durationMs: 42 }
    vi.spyOn(N8nProvider.prototype, 'smokeTest').mockResolvedValue(smokeTestResult)

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description', { activate: true, smokeTest: true })

    expect(checkSpy).not.toHaveBeenCalled()
    expect(result.webhookVerification).toEqual({ reachable: true, detail: 'Production webhook responded successfully.' })
    expect(result.summary).toContain('Production webhook verified reachable.')
  })
})
