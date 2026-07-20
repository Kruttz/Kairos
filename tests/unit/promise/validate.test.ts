import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateProcessContract } from '../../../src/promise/validate.js'
import type { ProcessContract } from '../../../src/promise/types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

function empireHomecare(): ProcessContract {
  return loadFixture('empire-homecare-referral-intake.json')
}

function saasIncident(): ProcessContract {
  return loadFixture('saas-p1-incident-response.json')
}

describe('validateProcessContract', () => {
  describe('positive fixtures — two structurally different real-world contracts', () => {
    it('the Empire Homecare referral-intake contract validates clean', () => {
      const issues = validateProcessContract(empireHomecare())
      expect(issues.filter(i => i.severity === 'error')).toEqual([])
    })

    it('the SaaS P1 incident-response contract validates clean -- proves the schema generalizes, not just the Empire Homecare shape', () => {
      const issues = validateProcessContract(saasIncident())
      expect(issues.filter(i => i.severity === 'error')).toEqual([])
    })
  })

  describe('rule 1/2 — dangling transition references', () => {
    it('rejects a transition with an unknown fromState', () => {
      const contract = empireHomecare()
      contract.transitions[0]!.fromState = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 1 && i.message.includes('does_not_exist'))).toBe(true)
    })

    it('rejects a transition with an unknown toState', () => {
      const contract = empireHomecare()
      contract.transitions[0]!.toState = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 1 && i.message.includes('does_not_exist'))).toBe(true)
    })

    it('rejects a transition with an unknown event', () => {
      const contract = empireHomecare()
      contract.transitions[0]!.event = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 2 && i.message.includes('does_not_exist'))).toBe(true)
    })
  })

  describe('rule 3 — start conditions and reachability', () => {
    it('rejects a StartCondition.initialState that references an unknown state', () => {
      const contract = empireHomecare()
      contract.startConditions[0]!.initialState = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 3 && i.message.includes('initialState'))).toBe(true)
    })

    it('rejects an unreachable state -- one with no transition path from any initialState', () => {
      const contract = empireHomecare()
      contract.states.push({ id: 'orphan', name: 'Orphan', description: 'Never entered by anything.', terminal: false })
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 3 && i.message.includes('"orphan"') && i.message.includes('unreachable'))).toBe(true)
    })

    it('the initialState itself always counts as reachable, even with zero outgoing transitions found yet', () => {
      const contract = empireHomecare()
      contract.transitions = []
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 3 && i.message.includes('"received"'))).toBe(false)
    })
  })

  describe('rule 4 — terminal-state consistency (both directions)', () => {
    it('rejects a terminal: true state that still has an outgoing transition', () => {
      const contract = empireHomecare()
      contract.transitions.push({ id: 't-bad', fromState: 'scheduled', event: 'call_attempted', toState: 'contacted' })
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 4 && i.message.includes('outgoing transition'))).toBe(true)
    })

    it('rejects a TerminalOutcome that references a state not flagged terminal: true', () => {
      const contract = empireHomecare()
      contract.terminalOutcomes.push({ state: 'contacted', outcome: 'success', description: 'bad -- contacted is not terminal' })
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 4 && i.message.includes('not flagged terminal'))).toBe(true)
    })

    it('rejects a terminal: true state with no matching TerminalOutcome entry', () => {
      const contract = empireHomecare()
      contract.states.push({ id: 'orphan_terminal', name: 'Orphan Terminal', description: 'Flagged terminal, no outcome.', terminal: true })
      // Give it a transition in so it isn't ALSO flagged unreachable (rule 3) -- isolate rule 4.
      contract.transitions.push({ id: 't-to-orphan', fromState: 'contacted', event: 'appointment_scheduled', toState: 'orphan_terminal' })
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 4 && i.message.includes('no TerminalOutcome entry'))).toBe(true)
    })
  })

  describe('rule 5 — cross-references (SLA, owners, expiration, evidence requirements)', () => {
    it('rejects an SlaSpec.measuredFrom.state referencing an unknown state', () => {
      const contract = empireHomecare()
      contract.sla[0]!.measuredFrom = { state: 'does_not_exist' }
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 5 && i.message.includes('measuredFrom'))).toBe(true)
    })

    it('rejects an SlaSpec.expectedBy.state referencing an unknown state', () => {
      const contract = empireHomecare()
      contract.sla[0]!.expectedBy = { state: 'does_not_exist' }
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 5 && i.message.includes('expectedBy'))).toBe(true)
    })

    it('rejects an OwnerAssignment.state referencing an unknown state', () => {
      const contract = empireHomecare()
      contract.owners[0]!.state = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 5 && i.message.includes('Owner assignment'))).toBe(true)
    })

    it('rejects an ExpirationRule.state referencing an unknown state', () => {
      const contract = empireHomecare()
      contract.expirationRules![0]!.state = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 5 && i.message.includes('Expiration rule') && i.message.includes('does_not_exist'))).toBe(true)
    })

    it('rejects an ExpirationRule.expiresTo referencing an unknown state', () => {
      const contract = empireHomecare()
      contract.expirationRules![0]!.expiresTo = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 5 && i.message.includes('expiresTo'))).toBe(true)
    })

    it('rejects an EvidenceRequirement.transitionId referencing an unknown transition', () => {
      const contract = empireHomecare()
      contract.evidenceRequirements[0]!.transitionId = 'does_not_exist'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 5 && i.message.includes('Evidence requirement'))).toBe(true)
    })
  })

  describe('rule 6 — correlation key field path', () => {
    it('rejects an empty fieldPath', () => {
      const contract = empireHomecare()
      contract.correlationKey.fieldPath = ''
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 6)).toBe(true)
    })

    it('rejects a syntactically invalid dot-path', () => {
      const contract = empireHomecare()
      contract.correlationKey.fieldPath = 'body..phone'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 6)).toBe(true)
    })

    it('accepts a well-formed multi-segment dot-path', () => {
      const contract = empireHomecare()
      contract.correlationKey.fieldPath = 'body.referral.phone'
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 6)).toBe(false)
    })
  })

  describe('rule 7 — at least one success outcome', () => {
    it('rejects a contract with zero success terminal outcomes', () => {
      const contract = empireHomecare()
      contract.terminalOutcomes = contract.terminalOutcomes.map(o => o.outcome === 'success' ? { ...o, outcome: 'acceptable' as const } : o)
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 7)).toBe(true)
    })
  })

  describe('rule 8 — business-calendar consistency (found via the pressure test)', () => {
    it('rejects a business_hours SLA with no businessCalendar present', () => {
      const contract = empireHomecare()
      delete contract.businessCalendar
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 8 && i.message.includes('businessCalendar is absent'))).toBe(true)
    })

    it('rejects a populated businessCalendar when nothing actually needs it', () => {
      const contract = saasIncident()
      // Force every duration to wall-clock so the calendar becomes genuinely unused.
      for (const sla of contract.sla) sla.duration = { amount: sla.duration.amount, unit: 'minutes' }
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 8 && i.message.includes('no SlaSpec or ExpirationRule'))).toBe(true)
    })

    it('the SaaS incident contract -- mixing wall-clock and business-days SLAs in one contract -- is accepted with its calendar present', () => {
      const issues = validateProcessContract(saasIncident())
      expect(issues.some(i => i.rule === 8)).toBe(false)
    })
  })

  describe('rule 9 — recurring.whileInState references (found via the pressure test)', () => {
    it('accepts the SaaS contract\'s real recurring SLA', () => {
      const issues = validateProcessContract(saasIncident())
      expect(issues.some(i => i.rule === 9)).toBe(false)
    })

    it('rejects a recurring.whileInState referencing an unknown state', () => {
      const contract = saasIncident()
      const recurringSla = contract.sla.find(s => s.recurring)!
      recurringSla.recurring = { whileInState: 'does_not_exist' }
      const issues = validateProcessContract(contract)
      expect(issues.some(i => i.rule === 9 && i.message.includes('does_not_exist'))).toBe(true)
    })
  })
})
