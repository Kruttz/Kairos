import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeContractForAmendments } from '../../../src/promise/evolution.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'
import type { ExceptionDeskItem } from '../../../src/promise/exception-types.js'
import type { HarnessResult } from '../../../src/promise/harness-types.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.8). AmendmentEvidenceRef.targetId propagation: `kind: 'ledger_entry'` refs carry it,
 * threaded from the source ProofLedgerEntry.targetId (itself optional -- absent on a legacy
 * entry, and left absent here too, never fabricated). `kind: 'exception_item'` refs never carry
 * it at all -- ExceptionDeskItem has no targetId field to read one from. `kind: 'harness_scenario'`
 * refs never carry it either -- no real deployment/execution concept to begin with.
 */

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

// America/Denver is UTC-7 (MST, no DST) in January -- same fixture-time convention
// evolution.test.ts/sla-compliance.test.ts already established for this exact contract.
const MON_8AM = '2024-01-01T15:00:00.000Z'
const TUE_8AM = '2024-01-02T15:00:00.000Z'
const NOW = new Date(TUE_8AM)

function instanceStart(id: string, observedAt: string, targetId?: string): ProofLedgerEntry {
  return {
    id: `${id}:start`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: id,
    correlationKeyValueHash: id,
    kind: 'instance_start',
    initialState: 'received',
    observedAt,
    ...(targetId ? { targetId } : {}),
    sourceWorkflowId: 'wf-intake',
    sourceExecutionId: `exec-${id}-start`,
    status: 'observed',
    detail: 'instance started',
  }
}

function evidenceEntry(id: string, transitionId: string, observedAt: string, targetId?: string): ProofLedgerEntry {
  return {
    id: `${id}:${transitionId}`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: id,
    correlationKeyValueHash: id,
    kind: 'evidence',
    transitionId,
    observedAt,
    ...(targetId ? { targetId } : {}),
    sourceWorkflowId: 'wf-processing',
    sourceExecutionId: `exec-${id}-${transitionId}`,
    status: 'observed',
    detail: 'evidence',
  }
}

/** 8 drifting + 2 healthy instances, exactly evolution.test.ts's own driftingFixture() shape,
 * with every entry carrying targetId: 'n8n' -- the "new entries always populate provenance" case. */
function driftingFixtureWithTargetId(): ProofLedgerEntry[] {
  const entries: ProofLedgerEntry[] = []
  for (let i = 0; i < 8; i++) {
    const id = `drift-${i}`
    entries.push(instanceStart(id, MON_8AM, 'n8n'), evidenceEntry(id, 't-received-to-attempted', TUE_8AM, 'n8n'))
  }
  for (let i = 0; i < 2; i++) {
    const id = `healthy-${i}`
    entries.push(instanceStart(id, MON_8AM, 'n8n'), evidenceEntry(id, 't-received-to-attempted', MON_8AM, 'n8n'))
  }
  return entries
}

/** The identical shape, but with NO targetId anywhere -- simulating every entry predating this
 * phase (a legacy ledger). */
function driftingFixtureLegacy(): ProofLedgerEntry[] {
  const entries: ProofLedgerEntry[] = []
  for (let i = 0; i < 8; i++) {
    const id = `drift-${i}`
    entries.push(instanceStart(id, MON_8AM), evidenceEntry(id, 't-received-to-attempted', TUE_8AM))
  }
  for (let i = 0; i < 2; i++) {
    const id = `healthy-${i}`
    entries.push(instanceStart(id, MON_8AM), evidenceEntry(id, 't-received-to-attempted', MON_8AM))
  }
  return entries
}

describe('AmendmentEvidenceRef.targetId propagation', () => {
  it('kind: "ledger_entry" refs carry targetId "n8n" when every source ProofLedgerEntry has it (sla_threshold_hotspot, real ledgerEntryIds threading through detectRateHotspot())', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixtureWithTargetId(), [], undefined, NOW)
    const hotspot = proposals.find(p => p.category === 'sla_threshold_hotspot')
    expect(hotspot).toBeDefined()
    const ledgerRefs = hotspot!.evidence.filter(e => e.kind === 'ledger_entry')
    expect(ledgerRefs.length).toBeGreaterThan(0)
    expect(ledgerRefs.every(e => e.targetId === 'n8n')).toBe(true)
  })

  it('kind: "ledger_entry" refs carry targetId "n8n" via the direct sampleEvidence path too (unreached_state)', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixtureWithTargetId(), [], undefined, NOW)
    const unreached = proposals.find(p => p.category === 'unreached_state' && p.affectedElementId === 'scheduled')
    expect(unreached).toBeDefined()
    const ledgerRefs = unreached!.evidence.filter(e => e.kind === 'ledger_entry')
    expect(ledgerRefs.length).toBeGreaterThan(0)
    expect(ledgerRefs.every(e => e.targetId === 'n8n')).toBe(true)
  })

  it('kind: "ledger_entry" refs have NO targetId (absent, not fabricated) when the source ProofLedgerEntry has none -- a legacy, pre-Phase-4 ledger', () => {
    const contract = empireHomecare()
    const proposals = analyzeContractForAmendments(contract, driftingFixtureLegacy(), [], undefined, NOW)
    const hotspot = proposals.find(p => p.category === 'sla_threshold_hotspot')
    expect(hotspot).toBeDefined()
    const ledgerRefs = hotspot!.evidence.filter(e => e.kind === 'ledger_entry')
    expect(ledgerRefs.length).toBeGreaterThan(0)
    for (const ref of ledgerRefs) expect(ref.targetId).toBeUndefined()
  })

  it('kind: "exception_item" refs never carry a fabricated targetId, even when the corroborating entries themselves have one', () => {
    const contract = empireHomecare()
    const exception: ExceptionDeskItem = {
      id: 'exc-1', contractId: 'empire-homecare-referral-intake', promiseInstanceId: 'drift-0', kind: 'missed_sla',
      status: 'resolved', owner: 'intake coordinator', nextAction: 'follow up', reason: 'SLA missed',
      evidence: [], slaId: 'sla-first-contact', detectedAt: TUE_8AM, updatedAt: TUE_8AM, history: [],
    }
    const proposals = analyzeContractForAmendments(contract, driftingFixtureWithTargetId(), [exception], undefined, NOW)
    const hotspot = proposals.find(p => p.category === 'sla_threshold_hotspot')!
    const exceptionRefs = hotspot.evidence.filter(e => e.kind === 'exception_item')
    expect(exceptionRefs.length).toBeGreaterThan(0)
    for (const ref of exceptionRefs) expect(ref.targetId).toBeUndefined()
  })

  it('kind: "harness_scenario" refs never carry a targetId -- no real deployment/execution concept to begin with', () => {
    const contract = empireHomecare()
    const harnessResult: HarnessResult = {
      passCount: 0,
      failCount: 1,
      scenarioResults: [{
        scenarioId: 'scenario-1', scenarioName: 'A mismatched scenario', category: 'happy_path',
        passed: false, mismatches: ['expected state X, got Y'],
      }],
    }
    const proposals = analyzeContractForAmendments(contract, [], [], harnessResult, NOW)
    const mismatch = proposals.find(p => p.category === 'harness_mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch!.evidence).toEqual([{ kind: 'harness_scenario', id: 'scenario-1' }])
    expect(mismatch!.evidence[0]!.targetId).toBeUndefined()
  })
})
