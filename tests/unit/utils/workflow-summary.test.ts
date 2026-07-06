import { describe, it, expect } from 'vitest'
import { summarizeWorkflow } from '../../../src/utils/workflow-summary.js'
import type { N8nWorkflow, N8nNode } from '../../../src/types/workflow.js'
import type { CredentialRequirement } from '../../../src/types/result.js'
import type { ValidationIssue } from '../../../src/validation/types.js'

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
  return { name: 'Test Workflow', nodes, connections: {} }
}

describe('summarizeWorkflow', () => {
  it('describes a webhook -> Slack workflow', () => {
    const wf = workflow([
      node({ id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook' }),
      node({ id: '2', name: 'Notify Team', type: 'n8n-nodes-base.slack' }),
    ])
    const summary = summarizeWorkflow(wf, [], [])
    expect(summary).toContain('"Test Workflow"')
    expect(summary).toContain('Trigger: "Webhook Trigger"')
    expect(summary).toContain('receives an incoming webhook')
    expect(summary).toContain('"Notify Team"')
    expect(summary).toContain('sends a Slack message')
  })

  it('describes a schedule -> email workflow', () => {
    const wf = workflow([
      node({ id: '1', name: 'Every Morning', type: 'n8n-nodes-base.scheduleTrigger' }),
      node({ id: '2', name: 'Send Digest', type: 'n8n-nodes-base.emailSend' }),
    ])
    const summary = summarizeWorkflow(wf, [], [])
    expect(summary).toContain('runs on a schedule')
    expect(summary).toContain('sends an email')
  })

  it('reports no trigger node found when there is none', () => {
    const wf = workflow([node({ id: '1', name: 'Only Step', type: 'n8n-nodes-base.set' })])
    const summary = summarizeWorkflow(wf, [], [])
    expect(summary).toContain('No trigger node found.')
  })

  it('falls back to the raw type for an unrecognized node, without inventing a description', () => {
    const wf = workflow([
      node({ id: '1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }),
      node({ id: '2', name: 'Do Something Odd', type: 'n8n-nodes-base.someBrandNewNodeType' }),
    ])
    const summary = summarizeWorkflow(wf, [], [])
    expect(summary).toContain('uses someBrandNewNodeType')
  })

  it('includes credentials needed, reusing the data verbatim', () => {
    const wf = workflow([node({ id: '1', name: 'Trigger', type: 'n8n-nodes-base.webhook' })])
    const creds: CredentialRequirement[] = [
      { service: 'Slack', credentialType: 'slackApi', description: 'Needed to post messages' },
    ]
    const summary = summarizeWorkflow(wf, creds, [])
    expect(summary).toContain('Credentials needed:')
    expect(summary).toContain('Slack (slackApi): Needed to post messages')
  })

  it('includes warn-severity issues verbatim and excludes error-severity ones', () => {
    const wf = workflow([node({ id: '1', name: 'Trigger', type: 'n8n-nodes-base.webhook' })])
    const issues: ValidationIssue[] = [
      { rule: 126, severity: 'warn', message: 'Node "X" has ID "node-1" which is not a valid UUID v4' },
      { rule: 1, severity: 'error', message: 'Workflow name is required' },
    ]
    const summary = summarizeWorkflow(wf, [], issues)
    expect(summary).toContain('Warnings (1):')
    expect(summary).toContain('not a valid UUID v4')
    expect(summary).not.toContain('Workflow name is required')
  })

  it('omits the credentials and warnings sections entirely when there are none', () => {
    const wf = workflow([node({ id: '1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' })])
    const summary = summarizeWorkflow(wf, [], [])
    expect(summary).not.toContain('Credentials needed:')
    expect(summary).not.toContain('Warnings')
  })

  it('handles multiple trigger nodes', () => {
    const wf = workflow([
      node({ id: '1', name: 'Webhook In', type: 'n8n-nodes-base.webhook' }),
      node({ id: '2', name: 'Also On Schedule', type: 'n8n-nodes-base.scheduleTrigger' }),
    ])
    const summary = summarizeWorkflow(wf, [], [])
    expect(summary).toContain('Trigger: "Webhook In"')
    expect(summary).toContain('Trigger: "Also On Schedule"')
  })
})
