import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runContractHarness, runScenario, buildLedgerEntriesForScenario } from '../../../src/promise/harness.js'
import { generateContractScenarios } from '../../../src/promise/scenario.js'
import { hashCorrelationKeyValue } from '../../../src/promise/ledger.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ContractScenario } from '../../../src/promise/scenario-types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

describe('buildLedgerEntriesForScenario', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const { scenarios } = generateContractScenarios(contract, ['happy_path'])
  const scenario = scenarios[0]!

  it('produces one ProofLedgerEntry per timeline event, hashing the correlation key consistently', () => {
    const entries = buildLedgerEntriesForScenario(scenario)
    expect(entries).toHaveLength(scenario.timeline.length)
    const expectedHash = hashCorrelationKeyValue(scenario.correlationKeyValue)
    for (const e of entries) expect(e.promiseInstanceId).toBe(expectedHash)
  })

  it('orders eventTime chronologically matching the timeline\'s own offset-before-now semantics', () => {
    const now = new Date('2026-07-21T12:00:00.000Z')
    const entries = buildLedgerEntriesForScenario(scenario, now)
    const start = entries.find(e => e.kind === 'instance_start')!
    const evidence = entries.find(e => e.kind === 'evidence')!
    expect(new Date(start.eventTime!).getTime()).toBeLessThan(new Date(evidence.eventTime!).getTime())
    expect(new Date(evidence.eventTime!).getTime()).toBeLessThanOrEqual(now.getTime())
  })

  it('carries evidenceStatus through as the entry\'s own status field, defaulting to observed', () => {
    const { scenarios: missingDataScenarios } = generateContractScenarios(contract, ['missing_data'])
    const entries = buildLedgerEntriesForScenario(missingDataScenarios[0]!)
    const evidenceEntry = entries.find(e => e.kind === 'evidence')!
    expect(evidenceEntry.status).toBe('unverifiable')

    const happyEntries = buildLedgerEntriesForScenario(scenario)
    const happyEvidence = happyEntries.find(e => e.kind === 'evidence')!
    expect(happyEvidence.status).toBe('observed')
  })
})

describe('runScenario / runContractHarness -- website-contact-form-ack (primary fixture)', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const { scenarios } = generateContractScenarios(contract)

  it('every generated scenario passes against the real evaluation chain', () => {
    const result = runContractHarness(contract, scenarios)
    const failures = result.scenarioResults.filter(r => !r.passed)
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([])
    expect(result.passCount).toBe(scenarios.length)
    expect(result.failCount).toBe(0)
  })

  it('happy_path genuinely calls checkSlaCompliance/updateExceptionDesk/classifyPromiseInstance -- not a parallel evaluator', () => {
    const happyPath = scenarios.find(s => s.category === 'happy_path')!
    const outcome = runScenario(contract, happyPath)
    expect(outcome.actual.reportStatus).toBe('kept')
    expect(outcome.actual.detail).toContain('acknowledged')
    expect(outcome.passed).toBe(true)
  })

  it('P0-2 REGRESSION GUARD: missing_data (an evidence entry marked unverifiable, a required field genuinely missing) classifies as "unverifiable", never a confident "kept" -- confirming stateReachSignals()/classifyPromiseInstance() now honor ProofLedgerEntry.status', () => {
    // This scenario is exactly what found the original gap live (2026-07-21): before the fix,
    // current production code treated an 'unverifiable'-status entry identically to a complete
    // 'observed' one everywhere in the SLA/classification chain, producing a confident 'kept'
    // for evidence that was explicitly recorded as incomplete. Fixed same-day in
    // sla-compliance.ts (stateReachSignals()/checkSlaForInstance()/
    // checkRecurringSlaForInstance()/checkExpirationRuleForInstance()) and report.ts
    // (classifyPromiseInstance()) -- see docs/plans/intake-scenario-harness-plan.md §6's Shipped
    // note for the full writeup. This test now asserts the CORRECTED behavior and guards against
    // ever silently regressing back to the original bug.
    const missingData = scenarios.find(s => s.category === 'missing_data')!
    const outcome = runScenario(contract, missingData)
    expect(outcome.actual.reportStatus).toBe('unverifiable')
    expect(outcome.actual.detail).toContain('unverifiable')
    expect(outcome.passed).toBe(true)
  })

  it('a deliberately wrong expected outcome is correctly caught as a mismatch, proving the harness discriminates', () => {
    const happyPath = scenarios.find(s => s.category === 'happy_path')!
    const wrongExpectation: ContractScenario = { ...happyPath, expected: { ...happyPath.expected, reportStatus: 'missed', expectedExceptionCount: 5 } }
    const outcome = runScenario(contract, wrongExpectation)
    expect(outcome.passed).toBe(false)
    expect(outcome.mismatches.length).toBeGreaterThan(0)
    expect(outcome.mismatches.some(m => m.includes('reportStatus'))).toBe(true)
    expect(outcome.mismatches.some(m => m.includes('exceptionCount'))).toBe(true)
  })

  it('duplicate_correlation classification comes from the real ambiguity stopgap (Finding 3), not a special-cased harness shortcut', () => {
    const dup = scenarios.find(s => s.category === 'duplicate_correlation')!
    const outcome = runScenario(contract, dup)
    expect(outcome.actual.reportStatus).toBe('unverifiable')
    expect(outcome.actual.detail).toContain('separate "instance started" records')
  })

  it('EXCEPTIONDESK BOUNDARY REGRESSION GUARD: a fast terminal failure (failure_terminal, reached in minutes) is correctly classified "missed" but opens ZERO ExceptionDesk items -- ExceptionDesk only reacts to time-based SLA/expiration drift, never to a terminal outcome reached quickly', () => {
    // This is the exact real system boundary this session's own earlier synthetic validation
    // first demonstrated by hand (Case C: a submission flagged "missing info" within minutes)
    // and which the v0.12.0 docs audit subsequently documented in the README and CLI --help as
    // a real, non-obvious operational gotcha, not a bug: updateExceptionDesk() only ever opens
    // an item for a 'drifting' PromiseComplianceFinding (a time-based SLA/expiration miss), and
    // a terminal outcome reached quickly, well within any SLA/expiration window, never produces
    // one -- checkSlaCompliance() correctly reports 'healthy'/'insufficient_data' for every
    // finding in that case, not 'drifting'. This test locks that boundary in as permanent,
    // automatic regression coverage instead of a one-off hand-verified exercise.
    const failureTerminal = scenarios.find(s => s.category === 'failure_terminal')!
    const outcome = runScenario(contract, failureTerminal)
    expect(outcome.actual.reportStatus).toBe('missed')
    expect(outcome.actual.exceptionCount).toBe(0)
    expect(outcome.actual.exceptionKinds).toEqual([])
    expect(outcome.passed).toBe(true)
  })
})

describe('runContractHarness -- empire-homecare-referral-intake (contrasting fixture)', () => {
  const contract = loadFixture('empire-homecare-referral-intake.json')
  const { scenarios } = generateContractScenarios(contract)

  it('every generated (non-skipped) scenario passes', () => {
    const result = runContractHarness(contract, scenarios)
    expect(result.failCount).toBe(0)
    expect(result.passCount).toBe(scenarios.length)
  })

  it('no_response opens exactly one exception, not two -- the real checkExpirationRuleForInstance() correctly reports insufficient_data for exp-no-answer, since it targets "contact_attempted", never entered here', () => {
    const noResponse = scenarios.find(s => s.category === 'no_response')!
    const outcome = runScenario(contract, noResponse)
    expect(outcome.actual.exceptionCount).toBe(1)
    expect(outcome.actual.exceptionKinds).toEqual(['missed_sla'])
  })
})

describe('runContractHarness -- an intentionally empty scenario list', () => {
  it('returns a clean, zero-count result rather than erroring', () => {
    const contract = loadFixture('website-contact-form-ack.json')
    const result = runContractHarness(contract, [])
    expect(result.scenarioResults).toEqual([])
    expect(result.passCount).toBe(0)
    expect(result.failCount).toBe(0)
  })
})
