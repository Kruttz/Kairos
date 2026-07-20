import { describe, it, expect, vi } from 'vitest'
import { planProcessContract, type AnthropicMessagesClient } from '../../../src/promise/plan.js'

function mockClient(responseText: string): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: responseText }] }),
    },
  }
}

// A minimal, otherwise-valid draft matching what a real model response would look like --
// deliberately small (2 states, 1 transition, 1 terminal outcome) rather than a full
// Empire-Homecare-sized draft, since these tests are about planProcessContract()'s own
// plumbing (parsing, coercion, Kairos-owned field overwrites, validator wiring), not about
// re-proving the validator itself (already covered by validate.test.ts).
function validDraftResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'Test Contract',
    description: 'A thing is handled promptly.',
    entity: { name: 'Thing', description: 'A thing.' },
    correlationKey: { fieldPath: 'body.id', description: 'The thing id.' },
    promise: { text: 'The thing is handled.' },
    startConditions: [{ id: 'sc1', description: 'A thing arrives.', trigger: 'webhook', initialState: 's1' }],
    states: [
      { id: 's1', name: 'Received', description: 'Just arrived.', terminal: false },
      { id: 's2', name: 'Done', description: 'Handled.', terminal: true },
    ],
    events: [{ id: 'e1', name: 'Handled', description: 'The thing was handled.' }],
    transitions: [{ id: 't1', fromState: 's1', event: 'e1', toState: 's2' }],
    terminalOutcomes: [{ state: 's2', outcome: 'success', description: 'Handled successfully.' }],
    owners: [{ state: 's1', owner: 'coordinator' }],
    sla: [{ id: 'sla1', measuredFrom: { state: 's1' }, expectedBy: { state: 's2' }, duration: { amount: 1, unit: 'hours' } }],
    exceptions: [],
    evidenceRequirements: [],
    assumptions: [],
    ...overrides,
  })
}

describe('planProcessContract', () => {
  it('drafts a valid contract and marks it ready to proceed', async () => {
    const result = await planProcessContract(
      { description: 'Handle things promptly.', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(validDraftResponse()),
    )

    expect(result.readyToProceed).toBe(true)
    expect(result.validationIssues.filter(i => i.severity === 'error')).toEqual([])
    expect(result.contract.status).toBe('draft')
    expect(result.contract.name).toBe('Test Contract')
  })

  it('strips markdown code fences before parsing', async () => {
    const fenced = '```json\n' + validDraftResponse() + '\n```'
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(fenced),
    )
    expect(result.contract.name).toBe('Test Contract')
  })

  it('overwrites Kairos-owned fields even if the model response includes its own', async () => {
    const response = validDraftResponse({
      id: 'model-invented-id',
      clientId: 'model-invented-client',
      version: 999,
      provenance: { kairosVersion: 'fake', authoredBy: 'human', createdAt: 'fake', updatedAt: 'fake' },
      status: 'active',
    })
    const result = await planProcessContract(
      { description: 'x', clientId: 'real-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )

    expect(result.contract.clientId).toBe('real-client')
    expect(result.contract.version).toBe(1)
    expect(result.contract.provenance.authoredBy).toBe('llm_assisted')
    expect(result.contract.provenance.kairosVersion).not.toBe('fake')
    expect(result.contract.id).not.toBe('model-invented-id')
    // status is Kairos-owned too, computed from validation/blocking-assumption outcome, not
    // trusted from the model even though the model tried to claim 'active'.
    expect(result.contract.status).toBe('draft')
  })

  it('derives the contract id from the drafted name via the same slugify utility PackBuilder uses', async () => {
    const response = validDraftResponse({ name: 'Empire Homecare Referral Intake!' })
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )
    expect(result.contract.id).toBe('empire-homecare-referral-intake')
  })

  it('flags a structurally invalid draft as needing review, not silently usable', async () => {
    // Dangling transition reference -- a real validator error.
    const response = validDraftResponse({
      transitions: [{ id: 't1', fromState: 's1', event: 'e1', toState: 'does_not_exist' }],
    })
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )

    expect(result.readyToProceed).toBe(false)
    expect(result.validationIssues.some(i => i.severity === 'error')).toBe(true)
    expect(result.contract.status).toBe('needs_confirmation')
    // The draft is still returned, fully -- never withheld, per Codex's explicit instruction
    // ("return a review/escalation result rather than pretending it is usable" -- not "return
    // nothing").
    expect(result.contract.name).toBe('Test Contract')
  })

  it('flags a draft with a blocking assumption as needing review, even if it validates clean', async () => {
    const response = validDraftResponse({
      assumptions: [{ type: 'blocking', text: 'SLA duration not specified -- confirm with the business.' }],
    })
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )

    expect(result.readyToProceed).toBe(false)
    expect(result.validationIssues.filter(i => i.severity === 'error')).toEqual([])
    expect(result.contract.status).toBe('needs_confirmation')
    expect(result.contract.assumptions).toEqual([{ type: 'blocking', text: 'SLA duration not specified -- confirm with the business.' }])
  })

  it('a needs_confirmation (non-blocking) assumption alone does not block readyToProceed', async () => {
    const response = validDraftResponse({
      assumptions: [{ type: 'needs_confirmation', text: 'Assumed a 1-hour SLA -- confirm this is right.' }],
    })
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )
    expect(result.readyToProceed).toBe(true)
    expect(result.contract.status).toBe('draft')
  })

  it('coerces missing or malformed array fields to empty arrays rather than crashing', async () => {
    const response = validDraftResponse({ owners: 'not-an-array', exceptions: undefined })
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )
    expect(result.contract.owners).toEqual([])
    expect(result.contract.exceptions).toEqual([])
  })

  it('normalizes legacy string-only assumptions the same way PackBuilder.plan() does', async () => {
    const response = validDraftResponse({ assumptions: ['A bare string assumption, no type.'] })
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )
    expect(result.contract.assumptions).toEqual([{ type: 'needs_confirmation', text: 'A bare string assumption, no type.' }])
  })

  it('falls back to a generic name when the model omits one entirely', async () => {
    const response = validDraftResponse({ name: undefined })
    const result = await planProcessContract(
      { description: 'x', clientId: 'test-client', anthropicApiKey: 'fake-key' },
      mockClient(response),
    )
    expect(result.contract.name).toBe('Untitled Contract')
  })
})
