import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validateProcessContract } from '../../src/promise/validate.js'
import { generateContractScenarios } from '../../src/promise/scenario.js'
import { runContractHarness } from '../../src/promise/harness.js'
import type { ProcessContract } from '../../src/promise/types.js'

/**
 * Contract Harness Golden Integration Test (roadmap item 9, docs/plans/
 * intake-scenario-harness-plan.md §9). Proves the FULL contract -> generate scenarios -> run
 * harness -> assert-all-pass chain stays correct TOGETHER, not only piece by piece --
 * complementing tests/unit/promise/scenario.test.ts and harness.test.ts, which test each layer
 * with specific, hand-picked assertions per fixture.
 *
 * Deliberately sweeps every VALID fixture under tests/fixtures/contracts/ (anything not
 * prefixed "negative-" -- those are deliberately invalid contracts that exist only to prove
 * validateProcessContract() itself rejects them, tested by validate.test.ts, never meant to
 * reach a generator or harness). This means a new fixture added to that directory in the
 * future is automatically covered here with zero new test code -- the one property none of the
 * other, per-fixture-named tests in scenario.test.ts/harness.test.ts have.
 */

const FIXTURES_DIR = join(__dirname, '../fixtures/contracts')

function validFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('negative-'))
    .sort()
}

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

describe('Contract Harness golden integration -- every valid checked-in fixture', () => {
  const files = validFixtureFiles()

  it('found at least the three fixtures this arc is built around -- a sanity check on the sweep itself, not just what it finds', () => {
    expect(files).toContain('website-contact-form-ack.json')
    expect(files).toContain('empire-homecare-referral-intake.json')
    expect(files).toContain('saas-p1-incident-response.json')
  })

  for (const file of validFixtureFiles()) {
    it(`${file}: passes deterministic validation, and every scenario the generator produces (if any) passes the real harness`, () => {
      const contract = loadFixture(file)

      const validationIssues = validateProcessContract(contract)
      const errors = validationIssues.filter(i => i.severity === 'error')
      expect(errors, `${file} failed validation: ${JSON.stringify(errors)}`).toEqual([])

      const { scenarios, skipped } = generateContractScenarios(contract)
      // A fixture is allowed to skip every category (structurally valid but evidence-incomplete,
      // e.g. Empire Homecare/SaaS -- see scenario.test.ts's own dedicated skip-reason tests) --
      // what this golden test guards is that whatever DOES get generated always passes, never
      // that every fixture generates every category.
      for (const sk of skipped) {
        expect(sk.reason.length, `${file} skipped ${sk.category} with an empty reason`).toBeGreaterThan(0)
      }

      const result = runContractHarness(contract, scenarios)
      expect(result.failCount, `${file}: ${JSON.stringify(result.scenarioResults.filter(r => !r.passed), null, 2)}`).toBe(0)
      expect(result.passCount).toBe(scenarios.length)
    })
  }

  it('the website-contact-form-ack fixture specifically produces zero skips -- it is this arc\'s evidence-complete fixture, and a future change that broke that would be a real regression', () => {
    const contract = loadFixture('website-contact-form-ack.json')
    const { skipped } = generateContractScenarios(contract)
    expect(skipped).toEqual([])
  })

  it('Empire Homecare and the SaaS incident-response fixture specifically still skip happy_path/failure_terminal/after_hours -- the real evidence-completeness gap found by this arc, preserved as a permanent regression assertion, not silently fixed or forgotten', () => {
    for (const file of ['empire-homecare-referral-intake.json', 'saas-p1-incident-response.json']) {
      const contract = loadFixture(file)
      const { skipped } = generateContractScenarios(contract)
      const skippedCategories = skipped.map(s => s.category).sort()
      expect(skippedCategories, file).toEqual(['after_hours', 'failure_terminal', 'happy_path'])
    }
  })
})
