import { describe, it, expect } from 'vitest'
import { deriveLearningNotesFromProposals } from '../../../src/promise/learning.js'
import type { ContractAmendmentProposal, ProposalStatus } from '../../../src/promise/evolution-types.js'

const NOW = new Date('2026-07-22T00:00:00.000Z')

function makeProposal(overrides: Partial<ContractAmendmentProposal> = {}): ContractAmendmentProposal {
  return {
    id: 'contract-a-v1-sla_threshold_hotspot-sla1',
    contractId: 'contract-a',
    clientId: 'client-a',
    contractVersion: 1,
    category: 'sla_threshold_hotspot',
    summary: 'SLA "sla1" drifted in 8 of 10 (80%) evaluated instance(s).',
    affectedElementId: 'sla1',
    evidence: [{ kind: 'ledger_entry', id: 'entry-1' }, { kind: 'exception_item', id: 'exc-1' }],
    occurrenceCount: 8,
    sampleSize: 10,
    confidence: 'high',
    recommendedNextAction: 'Review the SLA threshold.',
    status: 'proposed',
    createdAt: '2026-01-01T00:00:00.000Z',
    history: [],
    ...overrides,
  }
}

function decided(status: ProposalStatus, reason?: string): ContractAmendmentProposal {
  return makeProposal({
    status,
    history: [{ ts: '2026-01-02T00:00:00.000Z', from: 'proposed', to: status, actor: 'human', ...(reason ? { reason } : {}) }],
  })
}

describe('deriveLearningNotesFromProposals -- v0 scope: only decided proposals produce a note', () => {
  it('an accepted proposal creates a candidate learning note', () => {
    const notes = deriveLearningNotesFromProposals([decided('accepted', 'agreed, worth revisiting')], NOW)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.status).toBe('candidate')
    expect(notes[0]!.provenance.decision).toBe('accepted')
    expect(notes[0]!.provenance.decisionReason).toBe('agreed, worth revisiting')
    expect(notes[0]!.createdAt).toBe(NOW.toISOString())
    expect(notes[0]!.history).toEqual([])
  })

  it('a rejected proposal creates a candidate learning note', () => {
    const notes = deriveLearningNotesFromProposals([decided('rejected', 'not a real issue')], NOW)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.provenance.decision).toBe('rejected')
    expect(notes[0]!.provenance.decisionReason).toBe('not a real issue')
  })

  it('an applied proposal counts as decision: accepted -- at least as strong a signal as accepted alone', () => {
    const notes = deriveLearningNotesFromProposals([decided('applied')], NOW)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.provenance.decision).toBe('accepted')
  })

  it('a still-proposed (undecided) proposal produces no note', () => {
    expect(deriveLearningNotesFromProposals([makeProposal({ status: 'proposed', history: [] })], NOW)).toEqual([])
  })

  it('a decision with no --reason given produces a note with no decisionReason field at all', () => {
    const notes = deriveLearningNotesFromProposals([decided('accepted')], NOW)
    expect(notes[0]!.provenance.decisionReason).toBeUndefined()
    expect('decisionReason' in notes[0]!.provenance).toBe(false)
  })
})

describe('deriveLearningNotesFromProposals -- provenance traces back to the source proposal', () => {
  it('copies contractId/clientId/contractVersion/proposalId/category/summary/recommendedNextAction/evidence verbatim', () => {
    const p = decided('accepted', 'ok')
    const notes = deriveLearningNotesFromProposals([p], NOW)
    const note = notes[0]!
    expect(note.provenance.contractId).toBe(p.contractId)
    expect(note.provenance.clientId).toBe(p.clientId)
    expect(note.provenance.contractVersion).toBe(p.contractVersion)
    expect(note.provenance.proposalId).toBe(p.id)
    expect(note.provenance.proposalCategory).toBe(p.category)
    expect(note.summary).toBe(p.summary)
    expect(note.recommendedNextAction).toBe(p.recommendedNextAction)
    expect(note.provenance.evidence).toEqual(p.evidence)
  })

  it('note id is deterministic from (clientId, contractId, proposalId) -- stable across re-derivation', () => {
    const p = decided('accepted')
    const a = deriveLearningNotesFromProposals([p], NOW)[0]!
    const b = deriveLearningNotesFromProposals([p], new Date('2026-08-01T00:00:00.000Z'))[0]!
    expect(a.id).toBe(b.id)
  })
})

describe('deriveLearningNotesFromProposals -- synthetic evidence guardrail (structural, not proposal-supplied)', () => {
  it('a harness_mismatch proposal (all evidence harness_scenario) is flagged synthetic: true', () => {
    const p = decided('accepted', undefined)
    const harnessProposal = { ...p, category: 'harness_mismatch' as const, evidence: [{ kind: 'harness_scenario' as const, id: 'scenario-1' }], confidence: 'low' as const }
    const notes = deriveLearningNotesFromProposals([harnessProposal], NOW)
    expect(notes[0]!.provenance.synthetic).toBe(true)
  })

  it('a real-evidence proposal (ledger_entry/exception_item only) is flagged synthetic: false', () => {
    const notes = deriveLearningNotesFromProposals([decided('accepted')], NOW)
    expect(notes[0]!.provenance.synthetic).toBe(false)
  })

  it('mixed real + synthetic evidence is NOT flagged synthetic -- real evidence present is enough (a case evolution.ts never actually produces today, but the derivation logic is defensive either way)', () => {
    const p = decided('accepted')
    const mixed = { ...p, evidence: [{ kind: 'ledger_entry' as const, id: 'entry-1' }, { kind: 'harness_scenario' as const, id: 'scenario-1' }] }
    const notes = deriveLearningNotesFromProposals([mixed], NOW)
    expect(notes[0]!.provenance.synthetic).toBe(false)
  })

  it('an empty evidence array is flagged synthetic: true (fail-closed, even though this should never happen per evolution.ts\'s own invariant)', () => {
    const p = decided('accepted')
    const empty = { ...p, evidence: [] }
    const notes = deriveLearningNotesFromProposals([empty], NOW)
    expect(notes[0]!.provenance.synthetic).toBe(true)
  })
})

describe('deriveLearningNotesFromProposals -- multiple proposals', () => {
  it('processes a mix of decided and undecided proposals, producing one note per decided proposal only', () => {
    const proposals = [
      decided('accepted'),
      makeProposal({ id: 'p2', status: 'proposed', history: [] }),
      { ...decided('rejected'), id: 'p3', affectedElementId: 'sla2' },
    ]
    const notes = deriveLearningNotesFromProposals(proposals, NOW)
    expect(notes).toHaveLength(2)
    expect(new Set(notes.map(n => n.id)).size).toBe(2)
  })
})
