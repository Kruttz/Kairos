import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileToPackPlan } from '../../../src/promise/compile.js'
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

describe('compileToPackPlan', () => {
  describe('Empire Homecare — the primary checkpoint contract', () => {
    it('compiles with no escalation', () => {
      const result = compileToPackPlan(empireHomecare())
      expect(result.escalation).toBeUndefined()
    })

    it('produces exactly three workflows: intake, processing, SLA escalation', () => {
      const result = compileToPackPlan(empireHomecare())
      expect(result.plan.workflows.map(w => w.name)).toEqual([
        'Referral Intake',
        'Referral Processing & Outcome Logging',
        'Referral SLA Escalation',
      ])
    })

    it('the intake workflow description mentions the trigger and correlation key', () => {
      const result = compileToPackPlan(empireHomecare())
      const intake = result.plan.workflows.find(w => w.name === 'Referral Intake')!
      expect(intake.description).toContain('New row in the referral intake Google Sheet')
      expect(intake.description).toContain('body.phone')
      expect(intake.description).toContain('received')
    })

    it('the processing workflow description covers every transition and evidence requirement', () => {
      const result = compileToPackPlan(empireHomecare())
      const processing = result.plan.workflows.find(w => w.name === 'Referral Processing & Outcome Logging')!
      expect(processing.description).toContain('Call Attempted')
      expect(processing.description).toContain('callOutcome')
      expect(processing.description).toContain('callTimestamp')
      expect(processing.description).toContain('scheduled')
      expect(processing.description).toContain('declined')
    })

    it('the escalation workflow description covers the SLA, expiration rule, and exception', () => {
      const result = compileToPackPlan(empireHomecare())
      const escalation = result.plan.workflows.find(w => w.name === 'Referral SLA Escalation')!
      expect(escalation.description).toContain('4 business_hours')
      expect(escalation.description).toContain('24 business_hours')
      expect(escalation.description).toContain('no_answer')
      expect(escalation.description).toContain('intake coordinator')
      expect(escalation.description).toContain('America/Denver')
    })

    it('produces traceability entries mapping each workflow to real contract element ids', () => {
      const result = compileToPackPlan(empireHomecare())
      expect(result.traceability).toEqual([
        { workflowName: 'Referral Intake', sourceElements: ['startCondition:sc-intake', 'state:received', 'correlationKey'] },
        {
          workflowName: 'Referral Processing & Outcome Logging',
          sourceElements: [
            'transition:t-received-to-attempted',
            'transition:t-attempted-to-contacted',
            'transition:t-contacted-to-scheduled',
            'transition:t-contacted-to-declined',
            'evidenceRequirement:t-attempted-to-contacted',
          ],
        },
        {
          workflowName: 'Referral SLA Escalation',
          sourceElements: ['sla:sla-first-contact', 'expirationRule:exp-no-answer', 'exception:exc-missed-first-contact'],
        },
      ])
    })

    it('carries the contract\'s own assumptions forward and appends a compiled-from provenance note', () => {
      const result = compileToPackPlan(empireHomecare())
      expect(result.plan.assumptions).toContainEqual({
        type: 'needs_confirmation',
        text: 'Assumed a 3-attempt cap before expiring to no_answer -- confirm this matches Empire\'s real call policy.',
      })
      const note = result.plan.assumptions.find(a => a.text.includes('compiled from ProcessContract'))
      expect(note).toEqual({
        type: 'safe',
        text: 'This pack was compiled from ProcessContract "Referral Intake & Contact" (id: empire-homecare-referral-intake, v1). Edit the contract and recompile rather than hand-editing this plan.',
      })
    })

    it('generates a test checklist entry per compiled workflow', () => {
      const result = compileToPackPlan(empireHomecare())
      expect(result.plan.testChecklist.map(c => c.workflow)).toEqual(result.plan.workflows.map(w => w.name))
    })
  })

  describe('SaaS P1 incident response — secondary pressure test, proves this generalizes', () => {
    it('compiles with no escalation', () => {
      const result = compileToPackPlan(saasIncident())
      expect(result.escalation).toBeUndefined()
    })

    it('still produces an SLA Escalation workflow even though the contract has no expirationRules, only sla entries', () => {
      const result = compileToPackPlan(saasIncident())
      const escalation = result.plan.workflows.find(w => w.name === 'Incident SLA Escalation')
      expect(escalation).toBeDefined()
      expect(escalation!.description).toContain('sla-ack')
      expect(escalation!.description).toContain('Recurs every 30 minutes')
    })

    it('names workflows after the contract\'s own entity name, not a hardcoded one', () => {
      const result = compileToPackPlan(saasIncident())
      expect(result.plan.workflows.map(w => w.name)).toEqual([
        'Incident Intake',
        'Incident Processing & Outcome Logging',
        'Incident SLA Escalation',
      ])
    })
  })

  describe('refusal to compile', () => {
    it('refuses when the contract fails deterministic validation, and returns an empty plan', () => {
      const contract = empireHomecare()
      contract.transitions[0]!.toState = 'does_not_exist'
      const result = compileToPackPlan(contract)

      expect(result.escalation).toBeDefined()
      expect(result.escalation!.source).toBe('validation_errors')
      expect(result.escalation!.questions.some(q => q.includes('does_not_exist'))).toBe(true)
      expect(result.plan.workflows).toEqual([])
      expect(result.traceability).toEqual([])
    })

    it('refuses when the contract has a blocking assumption, even if otherwise valid', () => {
      const contract = empireHomecare()
      contract.assumptions.push({ type: 'blocking', text: 'The Google Sheet ID has not been provided.' })
      const result = compileToPackPlan(contract)

      expect(result.escalation).toBeDefined()
      expect(result.escalation!.source).toBe('blocking_assumptions')
      expect(result.escalation!.questions).toEqual(['The Google Sheet ID has not been provided.'])
      expect(result.plan.workflows).toEqual([])
    })

    it('prioritizes validation_errors over blocking_assumptions when both are present', () => {
      const contract = empireHomecare()
      contract.transitions[0]!.toState = 'does_not_exist'
      contract.assumptions.push({ type: 'blocking', text: 'Also missing something.' })
      const result = compileToPackPlan(contract)
      expect(result.escalation!.source).toBe('validation_errors')
    })
  })

  describe('structural edge cases', () => {
    it('omits the SLA Escalation workflow entirely when the contract has neither sla nor expirationRules', () => {
      const contract = empireHomecare()
      contract.sla = []
      delete contract.expirationRules
      // Removing the SLA/expiration machinery also removes the only path into the terminal
      // "no_answer" state (via the expiration rule), which would otherwise make it unreachable
      // (rule 3) -- drop that terminal state and its outcome so the contract stays valid, since
      // this test is about the escalation-workflow omission, not re-proving rule 3. Same for
      // businessCalendar -- rule 8 requires it be absent once nothing needs a business-hours
      // duration unit anymore.
      contract.states = contract.states.filter(s => s.id !== 'no_answer')
      contract.terminalOutcomes = contract.terminalOutcomes.filter(o => o.state !== 'no_answer')
      delete contract.businessCalendar

      const result = compileToPackPlan(contract)
      expect(result.escalation).toBeUndefined()
      expect(result.plan.workflows.map(w => w.name)).toEqual(['Referral Intake', 'Referral Processing & Outcome Logging'])
    })

    it('numbers intake workflows when a contract has more than one StartCondition', () => {
      const contract = empireHomecare()
      contract.startConditions.push({
        id: 'sc-phone-referral',
        description: 'A referral is phoned in directly',
        trigger: 'Inbound phone call logged by reception',
        initialState: 'received',
      })

      const result = compileToPackPlan(contract)
      const intakeNames = result.plan.workflows.map(w => w.name).filter(n => n.startsWith('Referral Intake'))
      expect(intakeNames).toEqual(['Referral Intake 1', 'Referral Intake 2'])
    })
  })
})
