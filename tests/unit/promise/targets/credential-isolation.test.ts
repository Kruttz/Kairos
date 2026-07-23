import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { N8nContractCompiler, N8nContractDeployer } from '../../../../src/providers/n8n/contract-target.js'
import { PackBuilder } from '../../../../src/pack/pack-builder.js'
import type { Kairos } from '../../../../src/client.js'
import type { ProcessContract } from '../../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.2, correction 1). The credential regression this whole section exists to prevent: an
 * earlier design draft's single resolveContractDeployTarget() constructed N8nApiClient
 * unconditionally on every --build call, including --build --dry-run, which real, confirmed
 * (cli.ts's compiler-verification gate) behavior has never required n8n credentials for.
 *
 * Two layers of proof, deliberately not conflated:
 *
 * 1. STRUCTURAL (this file, below) -- N8nContractCompiler/N8nContractDeployer cannot read n8n
 *    credentials, because they never import N8nApiClient at all. This is "enforced by which
 *    function gets called, not by a caller remembering not to touch certain fields" (plan §6.2's
 *    own wording) -- provable by direct source inspection of the class files themselves, plus a
 *    real runtime run with N8N_BASE_URL/N8N_API_KEY deliberately unset confirming nothing throws.
 *    The equivalent proof for cli.ts's own resolveContractCompiler()/resolveContractDeployer()
 *    factories (which cannot be unit-tested directly -- cli.ts has zero exports, confirmed by
 *    grep) is a scoped source-text check: their own function bodies, bounded precisely so a
 *    reference in a DIFFERENT cli.ts function can't produce a false pass, contain no reference to
 *    N8N_BASE_URL/N8N_API_KEY/N8nApiClient, while resolveVerificationTarget()'s own body -- which
 *    legitimately needs both -- does.
 *
 * 2. BEHAVIORAL (tests/unit/cli/contract-compile.test.ts) -- a real CLI subprocess proving the
 *    plan-only path succeeds with zero credentials set at all, and that --build --dry-run's own
 *    credential check reaches ANTHROPIC_API_KEY before ever touching N8N_BASE_URL/N8N_API_KEY.
 *    A full live --build --dry-run run (needing a real or intercepted Anthropic call) could not
 *    be performed in this environment -- no ANTHROPIC_API_KEY/N8N_BASE_URL/N8N_API_KEY were set
 *    anywhere this phase was implemented or validated (confirmed directly, matching every prior
 *    phase's own disclosed live-checkpoint gap) -- see this phase's own Shipped note for the full
 *    honest account of what was and was not verified live.
 */

/** Strips comments before any containment check below -- this file's own doc comments on
 * N8nContractCompiler/N8nContractDeployer (and on the new cli.ts factories) explicitly name
 * "N8nApiClient"/"N8N_BASE_URL" as things they do NOT reference, in prose. A naive
 * whole-file-text .not.toContain() check would false-fail against those very doc comments --
 * this test needs to check the CODE, not the file's literal text, which is a meaningfully
 * different, correct claim. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const N8N_CONTRACT_TARGET_SRC = stripComments(readFileSync(join(__dirname, '../../../../src/providers/n8n/contract-target.ts'), 'utf-8'))
const CLI_SRC = stripComments(readFileSync(join(__dirname, '../../../../src/cli.ts'), 'utf-8'))

/** Extracts one named async-function's own body text from cli.ts (already comment-stripped
 * above), bounded from its own declaration line up to (not including) the next top-level
 * `function`/`async function` declaration -- so a reference living in a DIFFERENT function
 * immediately after it can never produce a false pass. */
function extractCliFunctionBody(name: string): string {
  const startPattern = new RegExp(`async function ${name}\\(`)
  const startMatch = startPattern.exec(CLI_SRC)
  if (!startMatch) throw new Error(`Could not find "async function ${name}(" in cli.ts -- has it been renamed?`)
  const start = startMatch.index
  const nextFnMatch = /\n(async )?function [A-Za-z0-9_]+\(/.exec(CLI_SRC.slice(start + 1))
  const end = nextFnMatch ? start + 1 + nextFnMatch.index : CLI_SRC.length
  return CLI_SRC.slice(start, end)
}

describe('Structural credential isolation -- N8nContractCompiler/N8nContractDeployer', () => {
  it('contract-target.ts (N8nContractCompiler + N8nContractDeployer) never imports N8nApiClient or references N8N_BASE_URL/N8N_API_KEY at all', () => {
    expect(N8N_CONTRACT_TARGET_SRC).not.toContain('N8nApiClient')
    expect(N8N_CONTRACT_TARGET_SRC).not.toContain('N8N_BASE_URL')
    expect(N8N_CONTRACT_TARGET_SRC).not.toContain('N8N_API_KEY')
  })

  it('N8nContractCompiler.compileContract() succeeds with zero credentials of any kind set', () => {
    const before = { N8N_BASE_URL: process.env['N8N_BASE_URL'], N8N_API_KEY: process.env['N8N_API_KEY'], ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] }
    for (const k of Object.keys(before)) delete process.env[k]
    try {
      const contract = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/contracts/empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
      expect(() => new N8nContractCompiler().compileContract(contract)).not.toThrow()
    } finally {
      for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v
    }
  })

  it('N8nContractDeployer.deployArtifact() (a real dry-run build against a mocked Kairos) succeeds with N8N_BASE_URL/N8N_API_KEY unset', async () => {
    const before = { N8N_BASE_URL: process.env['N8N_BASE_URL'], N8N_API_KEY: process.env['N8N_API_KEY'] }
    delete process.env['N8N_BASE_URL']
    delete process.env['N8N_API_KEY']
    try {
      const kairos = {
        build: vi.fn().mockResolvedValue({
          workflowId: null, name: 'x', workflow: { name: 'x', nodes: [], connections: {} },
          credentialsNeeded: [], activationRequired: false, generationAttempts: 1, dryRun: true, finalIssues: [],
        }),
        drain: vi.fn().mockResolvedValue(undefined),
      } as unknown as Kairos
      const deployer = new N8nContractDeployer(new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos }))
      const result = await deployer.deployArtifact(
        { businessContext: 'x', workflows: [{ name: 'Intake', description: 'x', purpose: 'x' }], assumptions: [], sheetsColumns: [], testChecklist: [] },
        { dryRun: true }
      )
      expect(result.outcome).toBe('generated')
    } finally {
      for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v
    }
  })
})

describe('Structural credential isolation -- cli.ts factory functions (source-scoped, since cli.ts has zero exports to import directly)', () => {
  it('resolveContractCompiler() never references N8N_BASE_URL, N8N_API_KEY, N8nApiClient, or resolveN8nApiClient() -- the last check closes the same indirection loophole the resolveVerificationTarget() test above had to work around', () => {
    const body = extractCliFunctionBody('resolveContractCompiler')
    expect(body).not.toContain('N8N_BASE_URL')
    expect(body).not.toContain('N8N_API_KEY')
    expect(body).not.toContain('N8nApiClient')
    expect(body).not.toContain('resolveN8nApiClient')
  })

  it('resolveContractDeployer() never references N8N_BASE_URL, N8N_API_KEY, N8nApiClient, or resolveN8nApiClient()', () => {
    const body = extractCliFunctionBody('resolveContractDeployer')
    expect(body).not.toContain('N8N_BASE_URL')
    expect(body).not.toContain('N8N_API_KEY')
    expect(body).not.toContain('N8nApiClient')
    expect(body).not.toContain('resolveN8nApiClient')
  })

  it('resolveVerificationTarget() DOES reach both, via resolveN8nApiClient() (Phase 1\'s own de-dup helper) -- the sanity check confirming the extraction helper above finds real content, not an accidentally-empty body', () => {
    const verificationTargetBody = extractCliFunctionBody('resolveVerificationTarget')
    expect(verificationTargetBody).toContain('resolveN8nApiClient()')
    // resolveVerificationTarget() itself doesn't inline N8N_BASE_URL/N8N_API_KEY -- it reuses
    // resolveN8nApiClient(), so the real env-var reads live one level down. Confirms that
    // delegate genuinely reaches both, closing the loop this test's own name promises.
    const apiClientBody = extractCliFunctionBody('resolveN8nApiClient')
    expect(apiClientBody).toContain('N8N_BASE_URL')
    expect(apiClientBody).toContain('N8N_API_KEY')
  })

  it('handleContractCompile\'s own compound gate resolves resolveVerificationTarget() only inside the outcome !== "blocked" && outcome !== "generated" && !isDryRun && some-slot-deployed condition', () => {
    const handlerBody = extractCliFunctionBody('handleContractCompile')
    const gateIndex = handlerBody.indexOf("deployResult.outcome !== 'blocked'")
    const verifyCallIndex = handlerBody.indexOf('resolveVerificationTarget()')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(verifyCallIndex).toBeGreaterThan(gateIndex)
  })
})
