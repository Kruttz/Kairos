import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { N8nContractCompiler } from '../../../../src/providers/n8n/contract-target.js'
import { compileToPackPlan } from '../../../../src/promise/compile.js'
import type { ProcessContract } from '../../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.2). N8nContractCompiler is a thin wrapper around the existing, unmodified
 * compileToPackPlan() -- these tests prove the wrapping itself is faithful (same artifact, same
 * traceability, same escalation, just reshaped under the neutral ContractCompiler vocabulary),
 * not compileToPackPlan()'s own compilation logic, which tests/unit/promise/compile.test.ts and
 * tests/unit/promise/compile-golden.test.ts already cover directly.
 */

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

function empireHomecare(): ProcessContract {
  return loadFixture('empire-homecare-referral-intake.json')
}

describe('N8nContractCompiler', () => {
  it('declares targetId "n8n"', () => {
    expect(new N8nContractCompiler().targetId).toBe('n8n')
  })

  it('maps compileToPackPlan()\'s "plan" field to "artifact", with identical content, for a valid contract', () => {
    const contract = empireHomecare()
    const direct = compileToPackPlan(contract)
    const wrapped = new N8nContractCompiler().compileContract(empireHomecare())
    expect(wrapped.artifact).toEqual(direct.plan)
    expect(wrapped.traceability).toEqual(direct.traceability)
    expect(wrapped.escalation).toBeUndefined()
  })

  it('carries an escalation through unchanged when validation fails', () => {
    const contract = empireHomecare()
    contract.transitions[0]!.toState = 'does_not_exist'
    const direct = compileToPackPlan(contract)
    const wrapped = new N8nContractCompiler().compileContract(contract)
    expect(wrapped.escalation).toEqual(direct.escalation)
    expect(wrapped.escalation?.source).toBe('validation_errors')
    expect(wrapped.artifact).toEqual(direct.plan)
    expect(wrapped.traceability).toEqual([])
  })

  it('carries an escalation through unchanged when a blocking assumption exists', () => {
    const contract = empireHomecare()
    contract.assumptions.push({ type: 'blocking', text: 'The Google Sheet ID has not been provided.' })
    const direct = compileToPackPlan(contract)
    const wrapped = new N8nContractCompiler().compileContract(contract)
    expect(wrapped.escalation).toEqual(direct.escalation)
    expect(wrapped.escalation?.source).toBe('blocking_assumptions')
  })

  it('never calls the Anthropic API or reads N8N_BASE_URL/N8N_API_KEY -- compileContract() is a pure function of its argument', () => {
    const before = { N8N_BASE_URL: process.env['N8N_BASE_URL'], N8N_API_KEY: process.env['N8N_API_KEY'], ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] }
    delete process.env['N8N_BASE_URL']
    delete process.env['N8N_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      expect(() => new N8nContractCompiler().compileContract(empireHomecare())).not.toThrow()
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
