import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compileToPackPlan } from '../../../src/promise/compile.js'
import type { ProcessContract } from '../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 2 Commit B (docs/plans/execution-substrate-boundary-plan.md
 * §12, correction 10) -- proves the refactored compileToPackPlan() (now delegating through
 * prepareContract()/decomposeContract() in src/promise/decomposition.ts) still produces
 * byte-identical output to the real, unmodified, pre-refactor code that captured these golden
 * files in Phase 2 Commit A.
 *
 * This test can only ever prove CURRENT code's output matches the already-committed fixture
 * content -- it cannot prove, and does not claim to prove, that the fixture was actually captured
 * before the refactor. That ordering is a documented, reviewed two-commit process checkpoint
 * (§12, §15), not something a runtime test can assert from git history.
 *
 * Sweeps every fixture under tests/fixtures/contracts/ -- both the structurally-invalid
 * "negative-" ones and the valid ones -- against its own
 * tests/fixtures/contracts/golden-compile/<name>.expected.json. Commit A captured a golden
 * output for all 10, since compileToPackPlan() runs deterministically on any ProcessContract
 * regardless of validity (an invalid one just produces its own, equally-golden
 * validation_errors escalation).
 *
 * Never modify or regenerate the committed .expected.json files to make this test pass -- a
 * mismatch here means the refactor changed real output and must be investigated, not accepted.
 *
 * Deliberately compares raw serialized TEXT, not parsed-then-toEqual() structural equality --
 * the latter only proves the two objects are deeply equal, which is blind to key-order drift,
 * whitespace/formatting drift, or anything else JSON.parse() normalizes away before comparison.
 * Confirmed directly (not just assumed) that `JSON.stringify(x, null, 2) + '\n'` is the exact
 * serialization the committed golden files use, by round-tripping one through
 * JSON.parse -> JSON.stringify and diffing byte-for-byte against the raw file.
 */

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')
const GOLDEN_DIR = join(FIXTURES_DIR, 'golden-compile')

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
}

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

function loadGoldenRaw(fixtureFileName: string): string {
  const goldenFileName = fixtureFileName.replace(/\.json$/, '.expected.json')
  return readFileSync(join(GOLDEN_DIR, goldenFileName), 'utf-8')
}

describe('compileToPackPlan golden parity -- refactored code vs. Commit A\'s pre-refactor baselines', () => {
  const files = fixtureFiles()

  it('found the escalation-path fixtures and at least one clean fixture -- a sanity check on the sweep itself, not just what it finds', () => {
    expect(files).toContain('empire-homecare-referral-intake.json')
    expect(files).toContain('empire-homecare-referral-intake-blocking-assumption.json')
    expect(files).toContain('negative-empire-homecare-referral-intake-validation-error.json')
  })

  for (const file of files) {
    it(`${file}: matches its Commit A golden output byte-for-byte`, () => {
      const contract = loadFixture(file)
      const result = compileToPackPlan(contract)
      const serialized = JSON.stringify(result, null, 2) + '\n'
      const golden = loadGoldenRaw(file)
      expect(serialized).toBe(golden)
    })
  }
})
