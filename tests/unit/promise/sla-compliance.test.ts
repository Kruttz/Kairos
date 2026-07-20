import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkSlaCompliance, buildPromiseComplianceReport } from '../../../src/promise/sla-compliance.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

const INSTANCE = 'instance-hash-abc'

function instanceStart(observedAt: string, initialState = 'received'): ProofLedgerEntry {
  return {
    id: `start:${observedAt}`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: INSTANCE,
    correlationKeyValueHash: INSTANCE,
    kind: 'instance_start',
    initialState,
    observedAt,
    sourceWorkflowId: 'wf-intake',
    sourceExecutionId: `exec-${observedAt}`,
    status: 'observed',
    detail: 'instance started',
  }
}

function evidence(transitionId: string, observedAt: string, status: 'observed' | 'unverifiable' = 'observed'): ProofLedgerEntry {
  return {
    id: `evidence:${transitionId}:${observedAt}`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: INSTANCE,
    correlationKeyValueHash: INSTANCE,
    kind: 'evidence',
    transitionId,
    observedAt,
    sourceWorkflowId: 'wf-processing',
    sourceExecutionId: `exec-${observedAt}`,
    status,
    detail: 'evidence',
  }
}

// America/Denver is UTC-7 (MST, no DST) in January. Monday 2024-01-01 08:00 Denver = 15:00 UTC;
// 17:00 Denver = 00:00 UTC the next day. Chosen so every expected business-hour value below can
// be hand-computed the same way business-calendar.test.ts's own values were.
const MON_8AM = '2024-01-01T15:00:00.000Z' // Mon 08:00 Denver
const MON_10AM = '2024-01-01T17:00:00.000Z' // Mon 10:00 Denver -- 2 business hours after 8am
const MON_1030AM = '2024-01-01T17:30:00.000Z' // Mon 10:30 Denver -- 2.5 business hours after 8am
const TUE_8AM = '2024-01-02T15:00:00.000Z' // Tue 08:00 Denver -- 9 business hours after Mon 8am (a full business day)

describe('checkSlaCompliance -- Empire Homecare\'s own primary SLA (sla-first-contact, 4 business hours)', () => {
  it('healthy: reached expectedBy via direct evidence within the window', () => {
    const contract = empireHomecare()
    // checkSlaCompliance reasons over transitions and ledger entries directly, not over which
    // EvidenceRequirements a contract happens to declare -- so a direct-evidence entry for
    // t-received-to-attempted (toState: contact_attempted) is valid input here even though the
    // real fixture's own poller wouldn't produce one for it today (only t-attempted-to-contacted
    // has a declared EvidenceRequirement). This isolates the "direct toState evidence" path from
    // the indirect fromState-implies-reached path the next tests cover, which IS what the real
    // fixture's poller would actually produce.
    const entries = [instanceStart(MON_8AM), evidence('t-received-to-attempted', MON_10AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(MON_10AM))
    const finding = findings.find(f => f.slaId === 'sla-first-contact')!
    expect(finding.status).toBe('healthy')
    expect(finding.evidence['elapsed']).toBe(2)
  })

  it('drifting: reached expectedBy via indirect (fromState) evidence, but past the deadline -- generic confidence', () => {
    const contract = empireHomecare()
    // t-attempted-to-contacted's fromState is contact_attempted -- proves it was reached, but
    // only as an upper bound, not a precise entry time. This is the ONLY evidence the real
    // fixture's single EvidenceRequirement can produce for this SLA's expectedBy state.
    const entries = [instanceStart(MON_8AM), evidence('t-attempted-to-contacted', TUE_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))
    const finding = findings.find(f => f.slaId === 'sla-first-contact')!
    expect(finding.status).toBe('drifting')
    expect(finding.evidenceQuality).toBe('generic')
    expect(finding.evidence['elapsed']).toBe(9)
  })

  it('healthy: reached expectedBy via indirect evidence, within the deadline', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM), evidence('t-attempted-to-contacted', MON_10AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(MON_10AM))
    const finding = findings.find(f => f.slaId === 'sla-first-contact')!
    expect(finding.status).toBe('healthy')
    // evidenceQuality is only reported on a drifting finding -- a healthy generic-confidence
    // finding is still genuinely healthy (the upper bound already satisfies the deadline).
    expect(finding.evidenceQuality).toBeUndefined()
  })

  it('insufficient_data: still within the 4-hour window, no evidence either way yet', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(MON_1030AM))
    const finding = findings.find(f => f.slaId === 'sla-first-contact')!
    expect(finding.status).toBe('insufficient_data')
    expect(finding.evidence['elapsedSoFar']).toBe(2.5)
  })

  it('drifting: deadline passed with zero evidence either way -- absence itself is the finding, specific confidence', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))
    const finding = findings.find(f => f.slaId === 'sla-first-contact')!
    expect(finding.status).toBe('drifting')
    expect(finding.evidenceQuality).toBe('specific')
    expect(finding.evidence['elapsedSoFar']).toBe(9)
  })

  it('insufficient_data: no clock-start signal at all yet (no instance_start, no other evidence)', () => {
    const contract = empireHomecare()
    // A ledger entry that exists for this instance but tells us nothing about "received".
    const entries = [evidence('t-attempted-to-contacted', MON_10AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(MON_10AM))
    const finding = findings.find(f => f.slaId === 'sla-first-contact')!
    expect(finding.status).toBe('insufficient_data')
    expect(finding.evidence).toEqual({})
  })
})

describe('checkSlaCompliance -- expiration rule (exp-no-answer, 24 business hours in contact_attempted)', () => {
  it('insufficient_data: no evidence yet that the instance ever reached contact_attempted', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(MON_10AM))
    const finding = findings.find(f => f.expirationRuleId === 'exp-no-answer')!
    expect(finding.status).toBe('insufficient_data')
  })

  it('not_applicable: the real fixture\'s only path to "reached contact_attempted" evidence is the same transition that also proves it was exited -- an honest structural limitation, not a bug', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM), evidence('t-attempted-to-contacted', MON_10AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))
    const finding = findings.find(f => f.expirationRuleId === 'exp-no-answer')!
    expect(finding.status).toBe('not_applicable')
  })

  it('drifting: genuinely stuck -- reached contact_attempted (via a distinct EvidenceRequirement added for this test) with no exit evidence, past the 24-business-hour window', () => {
    const contract = empireHomecare()
    // Add a second EvidenceRequirement so entering contact_attempted can be evidenced separately
    // from leaving it -- the real fixture doesn't declare one, which is exactly why the test
    // above reports not_applicable instead. This isolates the expiration rule's own "genuinely
    // stuck" logic from that real, separate limitation.
    contract.evidenceRequirements.push({ transitionId: 't-received-to-attempted', requiredFields: ['attemptedAt'], description: 'When the first attempt was logged.' })
    const entries = [instanceStart(MON_8AM), evidence('t-received-to-attempted', MON_10AM)]
    // 24 business hours after Mon 10am Denver -- roughly 3 business days later (9hrs Mon + 9hrs
    // Tue + 6hrs Wed puts us past 24), well past the window regardless of the exact date used.
    const farLater = new Date('2024-01-04T18:00:00.000Z') // Thu 11:00 Denver
    const findings = checkSlaCompliance(contract, entries, farLater)
    const finding = findings.find(f => f.expirationRuleId === 'exp-no-answer')!
    expect(finding.status).toBe('drifting')
    expect(finding.evidence['expiresTo']).toBe('no_answer')
  })

  it('not_applicable: instance genuinely exited contact_attempted via a real transition', () => {
    const contract = empireHomecare()
    contract.evidenceRequirements.push({ transitionId: 't-received-to-attempted', requiredFields: ['attemptedAt'], description: 'entry evidence' })
    const entries = [
      instanceStart(MON_8AM),
      evidence('t-received-to-attempted', MON_10AM), // entered contact_attempted
      evidence('t-attempted-to-contacted', TUE_8AM), // exited it
    ]
    const findings = checkSlaCompliance(contract, entries, new Date('2024-01-04T18:00:00.000Z'))
    const finding = findings.find(f => f.expirationRuleId === 'exp-no-answer')!
    expect(finding.status).toBe('not_applicable')
  })
})

describe('checkSlaCompliance -- recurring SLAs (structural completeness, not part of Empire Homecare\'s own contract)', () => {
  function recurringContract(): ProcessContract {
    const contract = empireHomecare()
    contract.sla.push({
      id: 'sla-recurring-checkin',
      measuredFrom: { state: 'contact_attempted' },
      expectedBy: { state: 'contacted' },
      duration: { amount: 60, unit: 'minutes' },
      recurring: { whileInState: 'contact_attempted' },
    })
    return contract
  }

  it('healthy: recent evidence within the recurring cadence', () => {
    const contract = recurringContract()
    contract.evidenceRequirements.push({ transitionId: 't-received-to-attempted', requiredFields: ['x'], description: 'entry' })
    const entries = [instanceStart(MON_8AM), evidence('t-received-to-attempted', MON_10AM)]
    const findings = checkSlaCompliance(contract, entries, new Date('2024-01-01T17:30:00.000Z')) // 30 min after MON_10AM
    const finding = findings.find(f => f.slaId === 'sla-recurring-checkin')!
    expect(finding.status).toBe('healthy')
  })

  it('drifting: too long since the last evidence while still in whileInState', () => {
    const contract = recurringContract()
    contract.evidenceRequirements.push({ transitionId: 't-received-to-attempted', requiredFields: ['x'], description: 'entry' })
    const entries = [instanceStart(MON_8AM), evidence('t-received-to-attempted', MON_10AM)]
    const findings = checkSlaCompliance(contract, entries, new Date('2024-01-01T19:00:00.000Z')) // 2 hours after MON_10AM, > 60min
    const finding = findings.find(f => f.slaId === 'sla-recurring-checkin')!
    expect(finding.status).toBe('drifting')
  })

  it('not_applicable: instance already exited whileInState', () => {
    const contract = recurringContract()
    contract.evidenceRequirements.push({ transitionId: 't-received-to-attempted', requiredFields: ['x'], description: 'entry' })
    const entries = [instanceStart(MON_8AM), evidence('t-received-to-attempted', MON_10AM), evidence('t-attempted-to-contacted', TUE_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date('2024-01-04T18:00:00.000Z'))
    const finding = findings.find(f => f.slaId === 'sla-recurring-checkin')!
    expect(finding.status).toBe('not_applicable')
  })
})

describe('checkSlaCompliance -- multi-instance handling', () => {
  it('evaluates each promise instance independently', () => {
    const contract = empireHomecare()
    const otherInstance = 'instance-hash-xyz'
    const entries: ProofLedgerEntry[] = [
      instanceStart(MON_8AM), // INSTANCE -- will be drifting (no further evidence, far-future now)
      { ...instanceStart(MON_10AM), promiseInstanceId: otherInstance, correlationKeyValueHash: otherInstance }, // healthy so far
    ]
    const findings = checkSlaCompliance(contract, entries, new Date(MON_1030AM))
    const forInstance = findings.filter(f => f.promiseInstanceId === INSTANCE && f.slaId === 'sla-first-contact')
    const forOther = findings.filter(f => f.promiseInstanceId === otherInstance && f.slaId === 'sla-first-contact')
    expect(forInstance).toHaveLength(1)
    expect(forOther).toHaveLength(1)
    expect(forInstance[0]!.status).toBe('insufficient_data') // 2.5h elapsed, within 4h window
    expect(forOther[0]!.status).toBe('insufficient_data') // only 30min elapsed
  })

  it('ignores entries for a different contract entirely', () => {
    const contract = empireHomecare()
    const entries: ProofLedgerEntry[] = [{ ...instanceStart(MON_8AM), contractId: 'some-other-contract' }]
    const findings = checkSlaCompliance(contract, entries, new Date(MON_10AM))
    expect(findings).toEqual([])
  })
})

describe('buildPromiseComplianceReport', () => {
  it('reports DRIFTING when any finding is drifting', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const report = buildPromiseComplianceReport(contract, entries, new Date(TUE_8AM))
    expect(report.verdict).toBe('DRIFTING')
    expect(report.contractId).toBe(contract.id)
    expect(report.contractName).toBe(contract.name)
    expect(report.instanceCount).toBe(1)
  })

  it('reports HEALTHY when nothing is drifting', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const report = buildPromiseComplianceReport(contract, entries, new Date(MON_1030AM))
    expect(report.verdict).toBe('HEALTHY') // insufficient_data/not_applicable never drive the verdict
  })

  it('counts distinct instances correctly across multiple entries per instance', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM), evidence('t-attempted-to-contacted', MON_10AM)]
    const report = buildPromiseComplianceReport(contract, entries, new Date(MON_10AM))
    expect(report.instanceCount).toBe(1)
  })
})
