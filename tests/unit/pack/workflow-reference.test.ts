import { describe, it, expect } from 'vitest'
import { toWorkflowReference } from '../../../src/pack/workflow-reference.js'
import { buildWebhookUrl } from '../../../src/utils/webhook-url.js'
import type { BuildResult } from '../../../src/types/result.js'

function makeBuildResult(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    workflowId: 'wf-1',
    name: 'Referral Intake',
    workflow: {
      name: 'Referral Intake',
      nodes: [
        {
          id: 'n1', name: 'Referral Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2,
          position: [0, 0], parameters: { httpMethod: 'POST', path: 'referral-intake' },
          credentials: { httpHeaderAuth: { id: 'c1', name: 'Intake Auth' } },
        },
        {
          id: 'n2', name: 'Notify Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2,
          position: [200, 0], parameters: {},
          credentials: { slackApi: { id: 'c2', name: 'Team Slack' } },
        },
      ],
      connections: { 'Referral Webhook': { main: [[{ node: 'Notify Slack', type: 'main', index: 0 }]] } },
    },
    credentialsNeeded: [],
    activationRequired: true,
    generationAttempts: 1,
    tokensInput: 100,
    tokensOutput: 100,
    dryRun: false,
    summary: 'x',
    finalIssues: [],
    ...overrides,
  }
}

describe('toWorkflowReference', () => {
  it('has no webhookUrl when no base URL is supplied, even for a deployed workflow', () => {
    const ref = toWorkflowReference(makeBuildResult({ dryRun: false }), 'referral-intake')
    expect(ref.webhookUrl).toBeUndefined()
    expect(ref.httpMethod).toBe('POST')
    expect(ref.webhookPath).toBe('referral-intake')
  })

  it('constructs webhookUrl matching buildWebhookUrl exactly when a base URL is supplied and the workflow is deployed', () => {
    const ref = toWorkflowReference(makeBuildResult({ dryRun: false }), 'referral-intake', 'https://n8n.example.com')
    expect(ref.webhookUrl).toBe(buildWebhookUrl('https://n8n.example.com', 'referral-intake'))
  })

  it('deployed: false with workflowId and webhookUrl both absent for a dry-run BuildResult, even with a base URL known', () => {
    const ref = toWorkflowReference(makeBuildResult({ dryRun: true, workflowId: null }), 'referral-intake', 'https://n8n.example.com')
    expect(ref.deployed).toBe(false)
    expect(ref.workflowId).toBeNull()
    expect(ref.webhookUrl).toBeUndefined()
    // Content-level fields remain populated even though nothing was deployed.
    expect(ref.httpMethod).toBe('POST')
    expect(ref.webhookPath).toBe('referral-intake')
  })

  it('deployed: true with workflowId and webhookUrl both populated for a deployed BuildResult', () => {
    const ref = toWorkflowReference(makeBuildResult({ dryRun: false, workflowId: 'wf-42' }), 'referral-intake', 'https://n8n.example.com')
    expect(ref.deployed).toBe(true)
    expect(ref.workflowId).toBe('wf-42')
    expect(ref.webhookUrl).toBe('https://n8n.example.com/webhook/referral-intake')
  })

  it('has no httpMethod/webhookPath/webhookUrl for a workflow with no webhook trigger', () => {
    const noWebhook = makeBuildResult({
      workflow: {
        name: 'Weekly Summary',
        nodes: [{ id: 'n1', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
        connections: {},
      },
    })
    const ref = toWorkflowReference(noWebhook, 'weekly-summary', 'https://n8n.example.com')
    expect(ref.httpMethod).toBeUndefined()
    expect(ref.webhookPath).toBeUndefined()
    expect(ref.webhookUrl).toBeUndefined()
  })

  it('collects deduplicated credential type keys across all nodes', () => {
    const ref = toWorkflowReference(makeBuildResult(), 'referral-intake')
    expect(ref.credentialsUsed.sort()).toEqual(['httpHeaderAuth', 'slackApi'])
  })

  it('collects node names in workflow order', () => {
    const ref = toWorkflowReference(makeBuildResult(), 'referral-intake')
    expect(ref.nodeNames).toEqual(['Referral Webhook', 'Notify Slack'])
  })

  it('carries the passed-in workflowKey and the build result\'s name', () => {
    const ref = toWorkflowReference(makeBuildResult(), 'referral-intake')
    expect(ref.workflowKey).toBe('referral-intake')
    expect(ref.workflowName).toBe('Referral Intake')
  })
})
