import { describe, it, expect, vi, afterEach } from 'vitest'
import { Kairos } from '../../src/client.js'
import { N8nProvider } from '../../src/providers/n8n/provider.js'
import { WorkflowDesigner } from '../../src/generation/designer.js'
import { DeployActivationError } from '../../src/errors/deploy-activation-error.js'
import type { DesignResult } from '../../src/generation/types.js'
import type { ILogger } from '../../src/utils/logger.js'

const CANNED_DESIGN_RESULT: DesignResult = {
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
  attemptMetadata: [{ tokensInput: 10, tokensOutput: 10, durationMs: 5, validationPassed: true, issues: [] }],
  warnedRules: [],
}

function makeSpyLogger(): ILogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('Kairos.build() — H5 activation failure surfaces a structured DeployActivationError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws DeployActivationError with workflowId and the original error as cause when activate() fails', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(CANNED_DESIGN_RESULT)
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-123', name: 'Test Workflow' })
    const activationError = new Error('n8n returned 500 activating the workflow')
    vi.spyOn(N8nProvider.prototype, 'activate').mockRejectedValue(activationError)

    const logger = makeSpyLogger()
    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
      logger,
    })

    await expect(kairos.build('Test description', { activate: true })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(DeployActivationError)
      const e = err as DeployActivationError
      expect(e.workflowId).toBe('wf-123')
      expect(e.cause).toBe(activationError)
      return true
    })

    expect(logger.info).toHaveBeenCalledWith('Workflow deployed to n8n', { workflowId: 'wf-123', name: 'Test Workflow' })
  })

  it('does not throw DeployActivationError when activate is not requested', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(CANNED_DESIGN_RESULT)
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-456', name: 'Test Workflow' })
    const activateSpy = vi.spyOn(N8nProvider.prototype, 'activate').mockRejectedValue(new Error('should never be called'))

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description', { activate: false })
    expect(result.workflowId).toBe('wf-456')
    expect(activateSpy).not.toHaveBeenCalled()
  })

  it('does not throw DeployActivationError when activation succeeds', async () => {
    vi.spyOn(WorkflowDesigner.prototype, 'design').mockResolvedValue(CANNED_DESIGN_RESULT)
    vi.spyOn(N8nProvider.prototype, 'deploy').mockResolvedValue({ workflowId: 'wf-789', name: 'Test Workflow' })
    vi.spyOn(N8nProvider.prototype, 'activate').mockResolvedValue(undefined)

    const kairos = new Kairos({
      anthropicApiKey: 'sk-ant-test',
      n8nBaseUrl: 'https://fake-n8n.example.com',
      n8nApiKey: 'fake-key',
    })

    const result = await kairos.build('Test description', { activate: true })
    expect(result.workflowId).toBe('wf-789')
  })
})
