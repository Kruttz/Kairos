import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateContractScenarios, ALL_SCENARIO_CATEGORIES } from '../../../src/promise/scenario.js'
import type { ProcessContract } from '../../../src/promise/types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

describe('generateContractScenarios -- website-contact-form-ack (evidence-complete fixture)', () => {
  const contract = loadFixture('website-contact-form-ack.json')

  it('generates all 7 categories with none skipped', () => {
    const { scenarios, skipped } = generateContractScenarios(contract)
    expect(scenarios.map(s => s.category).sort()).toEqual([...ALL_SCENARIO_CATEGORIES].sort())
    expect(skipped).toEqual([])
  })

  it('happy_path targets the success terminal via its evidence-backed transition', () => {
    const { scenarios } = generateContractScenarios(contract, ['happy_path'])
    const s = scenarios[0]!
    expect(s.expected.reportStatus).toBe('kept')
    expect(s.expected.evidenceQuality).toBe('specific')
    expect(s.timeline.some(e => e.kind === 'evidence' && e.transitionId === 't-received-to-acknowledged')).toBe(true)
  })

  it('never fabricates evidence for a transition without a matching EvidenceRequirement', () => {
    const { scenarios } = generateContractScenarios(contract)
    const evidenceTransitionIds = new Set(contract.evidenceRequirements.map(e => e.transitionId))
    for (const s of scenarios) {
      for (const event of s.timeline) {
        if (event.kind === 'evidence') {
          expect(evidenceTransitionIds.has(event.transitionId!)).toBe(true)
        }
      }
    }
  })

  it('missing_data omits exactly one required field and marks the entry unverifiable', () => {
    const { scenarios } = generateContractScenarios(contract, ['missing_data'])
    const s = scenarios[0]!
    const evidenceEvent = s.timeline.find(e => e.kind === 'evidence')!
    expect(evidenceEvent.evidenceStatus).toBe('unverifiable')
    const ev = contract.evidenceRequirements.find(e => e.transitionId === evidenceEvent.transitionId)!
    expect(Object.keys(evidenceEvent.fields ?? {}).length).toBe(ev.requiredFields.length - 1)
  })

  it('missing_data predicts unverifiable, not a confident kept -- the P0-2 measurement-integrity fix (2026-07-21)', () => {
    // Before the fix, unverifiable evidence for a transition into a success terminal outcome
    // predicted (and the real code produced) a confident 'kept'. classifyPromiseInstance() now
    // explicitly checks signal verifiability and returns 'unverifiable' instead -- this
    // generator's own prediction must match the corrected behavior, not the original bug.
    const { scenarios } = generateContractScenarios(contract, ['missing_data'])
    const s = scenarios[0]!
    expect(s.expected.reportStatus).toBe('unverifiable')
    expect(s.expected.evidenceQuality).toBeUndefined()
  })

  it('no_response predicts one exception per SLA AND per ExpirationRule measured/targeted from the initial state', () => {
    // website-contact-form-ack has both sla-ack-1bh (measuredFrom: received) and
    // exp-received-stuck (state: received) -- both apply directly to the start state, so both
    // should drift and both should be counted, unlike a contract whose expiration rule targets
    // a later state (see the Empire Homecare test below).
    const { scenarios } = generateContractScenarios(contract, ['no_response'])
    const s = scenarios[0]!
    expect(s.expected.expectedExceptionCount).toBe(2)
    expect(s.expected.expectedExceptionKinds?.sort()).toEqual(['missed_sla', 'stuck'])
  })

  it('duplicate_correlation produces exactly two instance_start events under the same correlation key', () => {
    const { scenarios } = generateContractScenarios(contract, ['duplicate_correlation'])
    const s = scenarios[0]!
    const starts = s.timeline.filter(e => e.kind === 'instance_start')
    expect(starts).toHaveLength(2)
    // correlationKeyValue is scenario-level (one value per scenario) -- the ambiguity comes from
    // two instance_start entries sharing it, not from two different values.
    expect(s.correlationKeyValue).toBeTruthy()
  })

  it('after_hours is only generated because businessCalendar is present, and starts genuinely outside weeklyHours', () => {
    const { scenarios } = generateContractScenarios(contract, ['after_hours'])
    const s = scenarios[0]!
    const start = s.timeline.find(e => e.kind === 'instance_start')!
    const evidence = s.timeline.find(e => e.kind === 'evidence')!
    // start's offset (days before now) must be strictly larger than evidence's own -- start
    // happened further in the past than the evidence that follows it.
    const startMs = start.offset.unit === 'days' ? start.offset.amount * 86_400_000 : start.offset.amount
    const evidenceMs = evidence.offset.unit === 'minutes' ? evidence.offset.amount * 60_000 : evidence.offset.amount * 3_600_000
    expect(startMs).toBeGreaterThan(evidenceMs)
  })

  it('every generated scenario uses an obviously-synthetic correlation key value', () => {
    const { scenarios } = generateContractScenarios(contract)
    for (const s of scenarios) {
      expect(s.correlationKeyValue).toContain('.kairos-scenario.test')
    }
  })

  it('respects a --categories-style subset filter', () => {
    const { scenarios, skipped } = generateContractScenarios(contract, ['happy_path', 'in_progress'])
    expect(scenarios.map(s => s.category).sort()).toEqual(['happy_path', 'in_progress'])
    expect(skipped).toEqual([])
  })
})

describe('generateContractScenarios -- empire-homecare-referral-intake (a real, evidence-incomplete fixture)', () => {
  const contract = loadFixture('empire-homecare-referral-intake.json')

  it('skips happy_path, failure_terminal, and after_hours -- none has an EvidenceRequirement reaching any terminal outcome', () => {
    const { scenarios, skipped } = generateContractScenarios(contract)
    expect(scenarios.map(s => s.category).sort()).toEqual(['duplicate_correlation', 'in_progress', 'missing_data', 'no_response'])
    expect(skipped.map(s => s.category).sort()).toEqual(['after_hours', 'failure_terminal', 'happy_path'])
    for (const sk of skipped) expect(sk.reason.length).toBeGreaterThan(0)
  })

  it('no_response predicts exactly one exception (the SLA only) -- the ExpirationRule targets a LATER state, not the initial one', () => {
    // Empire's exp-no-answer targets "contact_attempted", not "received" (the start state) --
    // a bare instance_start alone never satisfies its enterSignals, so it stays
    // insufficient_data, not drifting, and must NOT be counted here.
    const { scenarios } = generateContractScenarios(contract, ['no_response'])
    const s = scenarios[0]!
    expect(s.expected.expectedExceptionCount).toBe(1)
    expect(s.expected.expectedExceptionKinds).toEqual(['missed_sla'])
  })

  it('missing_data falls back to the only EvidenceRequirement available, which does not reach any terminal state, and (P0-2 fix) still predicts unverifiable, not a confident in_progress/healthy', () => {
    const { scenarios } = generateContractScenarios(contract, ['missing_data'])
    const s = scenarios[0]!
    expect(s.expected.reportStatus).toBe('unverifiable')
    expect(s.expected.evidenceQuality).toBeUndefined()
  })
})

describe('generateContractScenarios -- saas-p1-incident-response (second contrasting fixture)', () => {
  const contract = loadFixture('saas-p1-incident-response.json')

  it('skips happy_path/failure_terminal/after_hours for the same evidence-completeness reason as Empire Homecare', () => {
    const { skipped } = generateContractScenarios(contract)
    expect(skipped.map(s => s.category).sort()).toEqual(['after_hours', 'failure_terminal', 'happy_path'])
  })

  it('no_response counts only sla-ack (measured from "raised") -- sla-status-updates is event-measured and sla-postmortem measures from a later state', () => {
    const { scenarios } = generateContractScenarios(contract, ['no_response'])
    const s = scenarios[0]!
    expect(s.expected.expectedExceptionCount).toBe(1)
    expect(s.sourceElements).toContain('sla:sla-ack')
    expect(s.sourceElements).not.toContain('sla:sla-status-updates')
    expect(s.sourceElements).not.toContain('sla:sla-postmortem')
  })
})

describe('generateContractScenarios -- contracts with nothing to generate', () => {
  it('skips every category with a clear reason when there are no startConditions at all', () => {
    const contract = loadFixture('website-contact-form-ack.json')
    const empty: ProcessContract = { ...contract, startConditions: [] }
    const { scenarios, skipped } = generateContractScenarios(empty)
    expect(scenarios).toEqual([])
    expect(skipped).toHaveLength(ALL_SCENARIO_CATEGORIES.length)
    for (const sk of skipped) expect(sk.reason).toContain('startConditions')
  })
})
