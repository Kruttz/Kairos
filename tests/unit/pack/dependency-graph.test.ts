import { describe, it, expect } from 'vitest'
import { assignWorkflowKeys } from '../../../src/pack/dependency-graph.js'
import type { WorkflowPlan } from '../../../src/pack/pack-builder.js'

function makeWorkflow(name: string): WorkflowPlan {
  return { name, description: 'x', purpose: 'x' }
}

describe('assignWorkflowKeys', () => {
  it('assigns a slugified key to a single workflow', () => {
    const [result] = assignWorkflowKeys([makeWorkflow('Missed Call Webhook')])
    expect(result!.workflowKey).toBe('missed-call-webhook')
  })

  it('assigns distinct keys to workflows with distinct names', () => {
    const results = assignWorkflowKeys([makeWorkflow('Referral Intake'), makeWorkflow('Weekly Summary Email')])
    expect(results.map((r) => r.workflowKey)).toEqual(['referral-intake', 'weekly-summary-email'])
  })

  it('appends a numeric suffix when two workflows share a name (dedup case)', () => {
    const results = assignWorkflowKeys([makeWorkflow('Send Confirmation Email'), makeWorkflow('Send Confirmation Email')])
    expect(results.map((r) => r.workflowKey)).toEqual(['send-confirmation-email', 'send-confirmation-email-2'])
  })

  it('increments the suffix correctly for three or more identically-named workflows', () => {
    const results = assignWorkflowKeys([makeWorkflow('Send Email'), makeWorkflow('Send Email'), makeWorkflow('Send Email')])
    expect(results.map((r) => r.workflowKey)).toEqual(['send-email', 'send-email-2', 'send-email-3'])
  })

  it('does not mutate the input array or its elements', () => {
    const input = [makeWorkflow('Referral Intake')]
    const inputCopy = JSON.parse(JSON.stringify(input)) as WorkflowPlan[]
    assignWorkflowKeys(input)
    expect(input).toEqual(inputCopy)
  })

  it('preserves every other field on the workflow', () => {
    const [result] = assignWorkflowKeys([{ name: 'Referral Intake', description: 'Handles referrals', purpose: 'Speed' }])
    expect(result!.description).toBe('Handles referrals')
    expect(result!.purpose).toBe('Speed')
  })
})
