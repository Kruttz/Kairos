import { describe, it, expect } from 'vitest'
import { diffProcessContracts } from '../../../src/promise/diff.js'
import type { ProcessContract } from '../../../src/promise/types.js'

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'test-contract',
    version: 1,
    clientId: 'test-client',
    name: 'Test Contract',
    description: 'A minimal contract for diff.ts tests.',
    entity: { name: 'Thing', description: 'A thing.' },
    correlationKey: { fieldPath: 'body.id', description: 'The thing id.' },
    promise: { text: 'The thing is handled.' },
    startConditions: [{ id: 'sc1', description: 'A thing arrives.', trigger: 'webhook', initialState: 's1' }],
    states: [{ id: 's1', name: 'Received', description: 'Just arrived.', terminal: false }, { id: 's2', name: 'Done', description: 'Handled.', terminal: true }],
    events: [{ id: 'e1', name: 'Handled', description: 'The thing was handled.' }],
    transitions: [{ id: 't1', fromState: 's1', event: 'e1', toState: 's2' }],
    terminalOutcomes: [{ state: 's2', outcome: 'success', description: 'Handled successfully.' }],
    owners: [{ state: 's1', owner: 'intake' }],
    sla: [{ id: 'sla1', measuredFrom: { state: 's1' }, expectedBy: { state: 's2' }, duration: { amount: 4, unit: 'hours' } }],
    exceptions: [{ id: 'ex1', condition: 'no response', owner: 'intake', suggestedAction: 'follow up' }],
    evidenceRequirements: [{ transitionId: 't1', requiredFields: ['status'], description: 'Marker for t1.' }],
    assumptions: [],
    provenance: { kairosVersion: '0.11.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'active',
    ...overrides,
  }
}

describe('diffProcessContracts -- identity and metadata', () => {
  it('produces no changes for two structurally identical contracts (version bump alone still requires SOME diff scaffolding, not a false positive)', () => {
    const a = makeContract({ version: 1 })
    const b = makeContract({ version: 2 })
    const diff = diffProcessContracts(a, b)
    expect(diff.changes).toEqual([])
    expect(diff.hasBreakingChanges).toBe(false)
    expect(diff.fromVersion).toBe(1)
    expect(diff.toVersion).toBe(2)
    expect(diff.contractId).toBe('test-contract')
  })

  it('cosmetic field changes (name, description, status) are reported but never breaking', () => {
    const a = makeContract({ name: 'Old Name', description: 'old', status: 'draft' })
    const b = makeContract({ name: 'New Name', description: 'new', status: 'active' })
    const diff = diffProcessContracts(a, b)
    expect(diff.hasBreakingChanges).toBe(false)
    expect(diff.changes.map(c => c.path).sort()).toEqual(['description', 'name', 'status'])
    for (const c of diff.changes) expect(c.breaking).toBe(false)
  })
})

describe('diffProcessContracts -- states[]', () => {
  it('a new state is added, non-breaking', () => {
    const a = makeContract()
    const b = makeContract({ states: [...a.states, { id: 's3', name: 'Extra', description: 'new', terminal: false }] })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'states[s3]')!
    expect(change.changeType).toBe('added')
    expect(change.breaking).toBe(false)
    expect(diff.hasBreakingChanges).toBe(false)
  })

  it('removing an existing state is breaking', () => {
    const a = makeContract()
    const b = makeContract({ states: a.states.filter(s => s.id !== 's1') })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'states[s1]')!
    expect(change.changeType).toBe('removed')
    expect(change.breaking).toBe(true)
    expect(diff.hasBreakingChanges).toBe(true)
  })

  it('flipping an existing state\'s terminal flag is breaking', () => {
    const a = makeContract()
    const b = makeContract({ states: a.states.map(s => (s.id === 's1' ? { ...s, terminal: true } : s)) })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'states[s1]')!
    expect(change.breaking).toBe(true)
    expect(change.reason).toContain('terminal flag changed')
  })

  it('editing only a state\'s name/description is non-breaking', () => {
    const a = makeContract()
    const b = makeContract({ states: a.states.map(s => (s.id === 's1' ? { ...s, name: 'Renamed', description: 'edited' } : s)) })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'states[s1]')!
    expect(change.breaking).toBe(false)
  })
})

describe('diffProcessContracts -- transitions[]', () => {
  it('changing fromState/toState/event on an existing transition is breaking', () => {
    const a = makeContract()
    const b = makeContract({ transitions: a.transitions.map(t => (t.id === 't1' ? { ...t, toState: 's1' } : t)) })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'transitions[t1]')!
    expect(change.breaking).toBe(true)
  })

  it('editing only a transition\'s condition text is non-breaking', () => {
    const a = makeContract()
    const b = makeContract({ transitions: a.transitions.map(t => (t.id === 't1' ? { ...t, condition: 'only after 3 attempts' } : t)) })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'transitions[t1]')!
    expect(change.breaking).toBe(false)
  })

  it('removing a transition is breaking', () => {
    const a = makeContract()
    const b = makeContract({ transitions: [] })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'transitions[t1]')!
    expect(change.changeType).toBe('removed')
    expect(change.breaking).toBe(true)
  })
})

describe('diffProcessContracts -- sla[] -- the plan\'s own worked example (duration change is non-breaking)', () => {
  it('changing only an SLA\'s duration amount is non-breaking', () => {
    const a = makeContract()
    const b = makeContract({ sla: a.sla.map(s => (s.id === 'sla1' ? { ...s, duration: { amount: 6, unit: 'hours' as const } } : s)) })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'sla[sla1]')!
    expect(change.changeType).toBe('modified')
    expect(change.breaking).toBe(false)
    expect(diff.hasBreakingChanges).toBe(false)
  })

  it('changing an SLA\'s measuredFrom is breaking', () => {
    const a = makeContract()
    const b = makeContract({ sla: a.sla.map(s => (s.id === 'sla1' ? { ...s, measuredFrom: { event: 'e1' } } : s)) })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'sla[sla1]')!
    expect(change.breaking).toBe(true)
  })

  it('adding a new SLA is non-breaking', () => {
    const a = makeContract()
    const b = makeContract({ sla: [...a.sla, { id: 'sla2', measuredFrom: { state: 's1' }, expectedBy: { state: 's2' }, duration: { amount: 1, unit: 'hours' } }] })
    const diff = diffProcessContracts(a, b)
    expect(diff.hasBreakingChanges).toBe(false)
  })
})

describe('diffProcessContracts -- evidenceRequirements[] -- conservatively always breaking', () => {
  it('adding a new EvidenceRequirement is breaking', () => {
    const a = makeContract()
    const b = makeContract({ evidenceRequirements: [...a.evidenceRequirements, { transitionId: 't2', requiredFields: ['x'], description: 'new' }] })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'evidenceRequirements[t2]')!
    expect(change.breaking).toBe(true)
  })

  it('modifying an existing EvidenceRequirement\'s requiredFields is breaking', () => {
    const a = makeContract()
    const b = makeContract({ evidenceRequirements: [{ transitionId: 't1', requiredFields: ['status', 'note'], description: 'Marker for t1.' }] })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'evidenceRequirements[t1]')!
    expect(change.breaking).toBe(true)
  })
})

describe('diffProcessContracts -- global fields', () => {
  it('changing correlationKey.fieldPath is breaking', () => {
    const a = makeContract()
    const b = makeContract({ correlationKey: { ...a.correlationKey, fieldPath: 'body.email' } })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'correlationKey.fieldPath')!
    expect(change.breaking).toBe(true)
  })

  it('changing businessCalendar is breaking', () => {
    const a = makeContract({ businessCalendar: { timezone: 'America/New_York', weeklyHours: [{ day: 'mon', start: '09:00', end: '17:00' }] } })
    const b = makeContract({ businessCalendar: { timezone: 'America/Chicago', weeklyHours: [{ day: 'mon', start: '09:00', end: '17:00' }] } })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'businessCalendar')!
    expect(change.breaking).toBe(true)
  })
})

describe('diffProcessContracts -- owners[]/pauseRules[]/exceptions[] -- uniformly non-breaking', () => {
  it('owner reassignment is non-breaking', () => {
    const a = makeContract()
    const b = makeContract({ owners: [{ state: 's1', owner: 'someone-else' }] })
    const diff = diffProcessContracts(a, b)
    expect(diff.hasBreakingChanges).toBe(false)
  })

  it('removing an ExceptionRule is non-breaking (ExceptionDeskItem never references an ExceptionRule id directly)', () => {
    const a = makeContract()
    const b = makeContract({ exceptions: [] })
    const diff = diffProcessContracts(a, b)
    const change = diff.changes.find(c => c.path === 'exceptions[ex1]')!
    expect(change.changeType).toBe('removed')
    expect(change.breaking).toBe(false)
  })
})

describe('diffProcessContracts -- a realistic multi-field amendment', () => {
  it('correctly separates breaking from compatible changes in one diff, matching the plan\'s own worked example shape', () => {
    const a = makeContract()
    const b = makeContract({
      sla: a.sla.map(s => (s.id === 'sla1' ? { ...s, duration: { amount: 2, unit: 'hours' as const } } : s)), // non-breaking
      owners: [{ state: 's1', owner: 'new-owner' }], // non-breaking
      transitions: a.transitions.map(t => (t.id === 't1' ? { ...t, toState: 's1' } : t)), // breaking
    })
    const diff = diffProcessContracts(a, b)
    expect(diff.hasBreakingChanges).toBe(true)
    const breaking = diff.changes.filter(c => c.breaking)
    const compatible = diff.changes.filter(c => !c.breaking)
    expect(breaking.map(c => c.path)).toEqual(['transitions[t1]'])
    expect(compatible.map(c => c.path).sort()).toEqual(['owners[s1]', 'sla[sla1]'])
  })
})
