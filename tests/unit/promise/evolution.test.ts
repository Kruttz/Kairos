import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeContractForAmendments } from '../../../src/promise/evolution.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'
import type { ExceptionDeskItem } from '../../../src/promise/exception-types.js'
import type { HarnessResult } from '../../../src/promise/harness-types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

// America/Denver is UTC-7 (MST, no DST) in January -- same fixture-time convention
// sla-compliance.test.ts already established for this exact contract.
const MON_8AM = '2024-01-01T15:00:00.000Z' // Mon 08:00 Denver
const MON_10AM = '2024-01-01T17:00:00.000Z' // Mon 10:00 Denver -- 2 business hours after 8am (within the 4h SLA)
const TUE_8AM = '2024-01-02T15:00:00.000Z' // Tue 08:00 Denver -- 9 business hours after Mon 8am (past the 4h SLA)
const NOW = new Date(TUE_8AM)

function instanceStart(id: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:start`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: id,
    correlationKeyValueHash: id,
    kind: 'instance_start',
    initialState: 'received',
    observedAt,
    sourceWorkflowId: 'wf-intake',
    sourceExecutionId: `exec-${id}-start`,
    status: 'observed',
    detail: 'instance started',
  }
}

function evidenceEntry(id: string, transitionId: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:${transitionId}`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: id,
    correlationKeyValueHash: id,
    kind: 'evidence',
    transitionId,
    observedAt,
    sourceWorkflowId: 'wf-processing',
    sourceExecutionId: `exec-${id}-${transitionId}`,
    status: 'observed',
    detail: 'evidence',
  }
}

/** 10 distinct instances: 8 drift past the 4-business-hour sla-first-contact deadline (evidence
 * for t-received-to-attempted arrives Tuesday, 9 business hours later), 2 stay healthy (evidence
 * arrives Monday 10am, 2 business hours later) -- Codex's own worked example shape ("8 of 10
 * drifted... confidence: high"). None of these ever touch t-attempted-to-contacted (the contract's
 * only evidence-backed transition) or any state beyond contact_attempted, so this single fixture
 * also naturally exercises unreached_state/unused_transition/high_miss_rate. */
function driftingFixture(): ProofLedgerEntry[] {
  const entries: ProofLedgerEntry[] = []
  for (let i = 0; i < 8; i++) {
    const id = `drift-${i}`
    entries.push(instanceStart(id, MON_8AM), evidenceEntry(id, 't-received-to-attempted', TUE_8AM))
  }
  for (let i = 0; i < 2; i++) {
    const id = `healthy-${i}`
    entries.push(instanceStart(id, MON_8AM), evidenceEntry(id, 't-received-to-attempted', MON_10AM))
  }
  return entries
}

describe('analyzeContractForAmendments -- sla_threshold_hotspot (Codex\'s own worked example)', () => {
  it('flags sla-first-contact as a hotspot when 8 of 10 instances drift, with confidence high', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    const hotspot = proposals.find(p => p.category === 'sla_threshold_hotspot' && p.affectedElementId === 'sla-first-contact')
    expect(hotspot).toBeDefined()
    expect(hotspot!.occurrenceCount).toBe(8)
    expect(hotspot!.sampleSize).toBe(10)
    expect(hotspot!.confidence).toBe('high')
    expect(hotspot!.evidence.length).toBeGreaterThan(0)
    expect(hotspot!.evidence.every(e => e.kind === 'ledger_entry' || e.kind === 'exception_item')).toBe(true)
  })

  it('does not flag a quiet SLA -- a fixture where the SAME sla stays entirely healthy produces no hotspot', () => {
    const contract = empireHomecare()
    const entries: ProofLedgerEntry[] = []
    for (let i = 0; i < 5; i++) {
      const id = `all-healthy-${i}`
      entries.push(instanceStart(id, MON_8AM), evidenceEntry(id, 't-received-to-attempted', MON_10AM))
    }
    const proposals = analyzeContractForAmendments(contract, entries, [], undefined, NOW)
    expect(proposals.find(p => p.category === 'sla_threshold_hotspot')).toBeUndefined()
  })

  it('never generates a proposal with an empty evidence array (invariant)', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    for (const p of proposals) expect(p.evidence.length).toBeGreaterThan(0)
  })

  it('corroborates with a matching ExceptionDeskItem when one cites the same slaId', () => {
    const contract = empireHomecare()
    const exception: ExceptionDeskItem = {
      id: 'exc-1', contractId: 'empire-homecare-referral-intake', promiseInstanceId: 'drift-0', kind: 'missed_sla',
      status: 'resolved', owner: 'intake coordinator', nextAction: 'follow up', reason: 'SLA missed',
      evidence: [], slaId: 'sla-first-contact', detectedAt: TUE_8AM, updatedAt: TUE_8AM, history: [],
    }
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [exception], undefined, NOW)
    const hotspot = proposals.find(p => p.category === 'sla_threshold_hotspot')!
    expect(hotspot.evidence.some(e => e.kind === 'exception_item' && e.id === 'exc-1')).toBe(true)
  })
})

describe('analyzeContractForAmendments -- "no proposal when evidence is too weak"', () => {
  it('produces zero proposals when the sample size is below the minimum (2 instances, both drifting)', () => {
    const contract = empireHomecare()
    const entries: ProofLedgerEntry[] = []
    for (let i = 0; i < 2; i++) {
      const id = `too-few-${i}`
      entries.push(instanceStart(id, MON_8AM), evidenceEntry(id, 't-received-to-attempted', TUE_8AM))
    }
    const proposals = analyzeContractForAmendments(contract, entries, [], undefined, NOW)
    expect(proposals).toEqual([])
  })

  it('produces zero proposals for a contract with no evidence at all', () => {
    const contract = empireHomecare()
    expect(analyzeContractForAmendments(contract, [], [], undefined, NOW)).toEqual([])
  })
})

describe('analyzeContractForAmendments -- unreached_state / unused_transition (repeated never-reached states, ProofLedger-pattern evidence)', () => {
  it('flags a state that no evidence ever transitions into', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    const scheduled = proposals.find(p => p.category === 'unreached_state' && p.affectedElementId === 'scheduled')
    expect(scheduled).toBeDefined()
    expect(scheduled!.sampleSize).toBe(10)
  })

  it('does NOT flag "received" -- it is a StartCondition initialState, not an unreached state', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    expect(proposals.find(p => p.category === 'unreached_state' && p.affectedElementId === 'received')).toBeUndefined()
  })

  it('does NOT flag "contact_attempted" once real evidence targets it', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    expect(proposals.find(p => p.category === 'unreached_state' && p.affectedElementId === 'contact_attempted')).toBeUndefined()
  })

  it('flags the only evidence-backed transition (t-attempted-to-contacted) as unused when never observed', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    const unused = proposals.find(p => p.category === 'unused_transition' && p.affectedElementId === 't-attempted-to-contacted')
    expect(unused).toBeDefined()
  })

  it('does not flag unused_transition once that transition IS observed', () => {
    const contract = empireHomecare()
    const entries = driftingFixture()
    entries.push(instanceStart('with-contact', MON_8AM), evidenceEntry('with-contact', 't-attempted-to-contacted', MON_10AM))
    const proposals = analyzeContractForAmendments(contract, entries, [], undefined, NOW)
    expect(proposals.find(p => p.category === 'unused_transition')).toBeUndefined()
  })
})

describe('analyzeContractForAmendments -- high_miss_rate (Promise Report outcomes)', () => {
  it('flags a whole-contract high miss rate when the same drifting fixture reaches classifyPromiseInstance\'s "missed" branch', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    const highMiss = proposals.find(p => p.category === 'high_miss_rate')
    expect(highMiss).toBeDefined()
    expect(highMiss!.affectedElementId).toBe(contract.id)
    expect(highMiss!.occurrenceCount).toBe(8)
    expect(highMiss!.sampleSize).toBe(10)
  })
})

describe('analyzeContractForAmendments -- harness_mismatch (synthetic-only, always low confidence)', () => {
  function fakeHarnessResult(passed: boolean): HarnessResult {
    return {
      contractId: 'empire-homecare-referral-intake',
      contractVersion: 1,
      scenarioResults: [{
        scenarioId: 'empire-homecare-referral-intake-happy-path',
        scenarioName: 'Happy path',
        category: 'happy_path',
        passed,
        expected: { reportStatus: 'kept', expectedExceptionCount: 0, reasoning: 'x' },
        actual: { reportStatus: passed ? 'kept' : 'missed', exceptionCount: 0, exceptionKinds: [], detail: 'x' },
        mismatches: passed ? [] : ['reportStatus: expected "kept", got "missed"'],
      }],
      passCount: passed ? 1 : 0,
      failCount: passed ? 0 : 1,
    }
  }

  it('produces a harness_mismatch proposal, always confidence low, when a scenario fails', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, [], [], fakeHarnessResult(false), NOW)
    const mismatch = proposals.find(p => p.category === 'harness_mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch!.confidence).toBe('low')
    expect(mismatch!.evidence).toEqual([{ kind: 'harness_scenario', id: 'empire-homecare-referral-intake-happy-path' }])
  })

  it('produces nothing when the harness result has no failing scenarios', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, [], [], fakeHarnessResult(true), NOW)
    expect(proposals.find(p => p.category === 'harness_mismatch')).toBeUndefined()
  })

  it('produces nothing when no harness result is passed at all -- "if available" is genuinely optional', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, [], [], undefined, NOW)
    expect(proposals.find(p => p.category === 'harness_mismatch')).toBeUndefined()
  })
})

describe('analyzeContractForAmendments -- version filtering', () => {
  it('ignores entries recorded under a different contractVersion than the one being analyzed', () => {
    const contract = empireHomecare() // version: 1
    const staleEntries = driftingFixture().map(e => ({ ...e, contractVersion: 2 }))
    const proposals = analyzeContractForAmendments(contract, staleEntries, [], undefined, NOW)
    expect(proposals).toEqual([])
  })

  it('every proposal is stamped with the contract version it was computed against', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixture(), [], undefined, NOW)
    for (const p of proposals) expect(p.contractVersion).toBe(contract.version)
  })
})

describe('analyzeContractForAmendments -- determinism', () => {
  it('produces the exact same proposal ids on repeated calls against the same evidence -- required for evolution-store.ts\'s own upsert-by-id to work', () => {
    const contract = empireHomecare()
    const fixture = driftingFixture()
    const first = analyzeContractForAmendments(contract, fixture, [], undefined, NOW)
    const second = analyzeContractForAmendments(contract, fixture, [], undefined, NOW)
    expect(first.map(p => p.id).sort()).toEqual(second.map(p => p.id).sort())
  })
})
