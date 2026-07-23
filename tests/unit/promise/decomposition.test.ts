import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decomposeContract, prepareContract } from '../../../src/promise/decomposition.js'
import type { ProcessContract } from '../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 2 (docs/plans/execution-substrate-boundary-plan.md §5) --
 * direct unit coverage for the target-neutral decomposeContract()/prepareContract() pair, kept
 * separate from tests/unit/promise/compile-golden.test.ts (which proves the refactored
 * compileToPackPlan() still matches pre-refactor byte-for-byte output). This file instead proves
 * the two functions' own contract: slot ordering/content, and -- the specific defect correction 2
 * of the plan's revision history exists to prevent -- that both escalation `reason` strings match
 * compile.ts's real, exact text (compile.ts:230,244) byte-for-byte, hardcoded here rather than
 * imported from compile.ts, so a future accidental drift in either file is caught by a literal
 * string mismatch rather than silently passing because both sides changed together.
 */

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

function empireHomecare(): ProcessContract {
  return loadFixture('empire-homecare-referral-intake.json')
}

describe('decomposeContract', () => {
  it('produces one intake slot per StartCondition, in declaration order, plus a processing slot and an escalation slot', () => {
    const { slots } = decomposeContract(empireHomecare())
    expect(slots.map(s => ({ name: s.name, kind: s.kind }))).toEqual([
      { name: 'Referral Intake', kind: 'intake' },
      { name: 'Referral Processing & Outcome Logging', kind: 'processing' },
      { name: 'Referral SLA Escalation', kind: 'escalation' },
    ])
  })

  it('numbers intake slots when a contract has more than one StartCondition', () => {
    const contract = empireHomecare()
    contract.startConditions.push({
      id: 'sc-phone-referral',
      description: 'A referral is phoned in directly',
      trigger: 'Inbound phone call logged by reception',
      initialState: 'received',
    })
    const { slots } = decomposeContract(contract)
    expect(slots.filter(s => s.kind === 'intake').map(s => s.name)).toEqual(['Referral Intake 1', 'Referral Intake 2'])
  })

  it('carries the real contract element ids into each slot\'s sourceElements, and the owning StartCondition id onto its intake slot', () => {
    const { slots } = decomposeContract(empireHomecare())

    const intake = slots.find(s => s.kind === 'intake')!
    expect(intake.sourceElements).toEqual(['startCondition:sc-intake', 'state:received', 'correlationKey'])
    expect(intake.startConditionId).toBe('sc-intake')

    const processing = slots.find(s => s.kind === 'processing')!
    expect(processing.sourceElements).toEqual([
      'transition:t-received-to-attempted',
      'transition:t-attempted-to-contacted',
      'transition:t-contacted-to-scheduled',
      'transition:t-contacted-to-declined',
      'evidenceRequirement:t-attempted-to-contacted',
    ])

    const escalation = slots.find(s => s.kind === 'escalation')!
    expect(escalation.sourceElements).toEqual(['sla:sla-first-contact', 'expirationRule:exp-no-answer', 'exception:exc-missed-first-contact'])
  })

  it('omits the processing slot when the contract has no transitions', () => {
    const contract = empireHomecare()
    contract.transitions = []
    contract.evidenceRequirements = []
    const { slots } = decomposeContract(contract)
    expect(slots.some(s => s.kind === 'processing')).toBe(false)
  })

  it('omits the escalation slot when the contract has neither sla entries nor expirationRules', () => {
    const contract = empireHomecare()
    contract.sla = []
    delete contract.expirationRules
    const { slots } = decomposeContract(contract)
    expect(slots.some(s => s.kind === 'escalation')).toBe(false)
  })

  it('keeps the escalation slot when a contract has expirationRules but no sla entries', () => {
    const contract = empireHomecare()
    contract.sla = []
    const { slots } = decomposeContract(contract)
    expect(slots.some(s => s.kind === 'escalation')).toBe(true)
  })
})

describe('prepareContract', () => {
  it('is "ready" with a full decomposition for a valid, non-blocked contract', () => {
    const result = prepareContract(empireHomecare())
    expect(result.outcome).toBe('ready')
    if (result.outcome !== 'ready') throw new Error('expected ready outcome')
    expect(result.decomposition.slots).toHaveLength(3)
  })

  it('is "blocked" with the exact validation_errors escalation text compile.ts uses, when the contract fails deterministic validation', () => {
    const contract = empireHomecare()
    contract.transitions[0]!.toState = 'does_not_exist'
    const result = prepareContract(contract)
    expect(result.outcome).toBe('blocked')
    if (result.outcome !== 'blocked') throw new Error('expected blocked outcome')
    expect(result.escalation.reason).toBe(
      'This ProcessContract fails deterministic validation and cannot be compiled until fixed. Run `kairos contract validate` for the full list.'
    )
    expect(result.escalation.source).toBe('validation_errors')
    expect(result.escalation.questions.some(q => q.includes('does_not_exist'))).toBe(true)
  })

  it('is "blocked" with the exact blocking_assumptions escalation text compile.ts uses, when the contract has an unresolved blocking assumption', () => {
    const contract = empireHomecare()
    contract.assumptions.push({ type: 'blocking', text: 'The Google Sheet ID has not been provided.' })
    const result = prepareContract(contract)
    expect(result.outcome).toBe('blocked')
    if (result.outcome !== 'blocked') throw new Error('expected blocked outcome')
    expect(result.escalation.reason).toBe(
      'This ProcessContract has blocking assumptions that must be resolved before compiling. Resolve them (edit the contract and re-validate), or compile anyway once they no longer apply.'
    )
    expect(result.escalation.source).toBe('blocking_assumptions')
    expect(result.escalation.questions).toEqual(['The Google Sheet ID has not been provided.'])
  })

  it('prioritizes validation_errors over blocking_assumptions when both are present, matching compile.ts\'s real order', () => {
    const contract = empireHomecare()
    contract.transitions[0]!.toState = 'does_not_exist'
    contract.assumptions.push({ type: 'blocking', text: 'Also missing something.' })
    const result = prepareContract(contract)
    expect(result.outcome).toBe('blocked')
    if (result.outcome !== 'blocked') throw new Error('expected blocked outcome')
    expect(result.escalation.source).toBe('validation_errors')
  })
})
