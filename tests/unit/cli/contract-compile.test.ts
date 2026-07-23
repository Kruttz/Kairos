import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ProcessContract } from '../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.2, §12, §18 row 1). Real subprocess CLI regression coverage for `kairos contract compile`,
 * following the same established idiom as contract-value.test.ts/contract-evolve.test.ts/
 * contract-amend.test.ts -- this command had NO dedicated test file before this phase (confirmed
 * by search); this file both proves the plan-only path is behaviorally unchanged by the Phase 3
 * refactor (same output shape, same exit codes) AND is the strongest automated, credential-free
 * substitute for §18 row 1's own live-checkpoint requirement ("a live --build --dry-run run
 * against a contract with no N8N_BASE_URL set in the environment succeeds"): a real
 * --build --dry-run run against this environment, which has no ANTHROPIC_API_KEY available
 * (confirmed, matching every prior phase's own disclosed live-checkpoint gap), cannot complete
 * -- but CAN prove, without any network call, that the credential check reached
 * ANTHROPIC_API_KEY and exited there, never having read N8N_BASE_URL/N8N_API_KEY at all.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../../src/cli.ts')

let scratchHome: string
let workDir: string

function run(args: string[], envOverrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: scratchHome }
  for (const [k, v] of Object.entries(envOverrides)) env[k] = v
  return spawnSync(TSX, [CLI, ...args], { encoding: 'utf-8', env: env as Record<string, string>, timeout: 20_000 })
}

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'compile-cli-test-contract',
    version: 1,
    clientId: 'compile-cli-test-client',
    name: 'CLI Compile Test Contract',
    description: 'A minimal contract for kairos contract compile CLI tests.',
    entity: { name: 'Referral', description: 'A referral.' },
    correlationKey: { fieldPath: 'body.phone', description: 'The referral phone number.' },
    promise: { text: 'Every referral is contacted within 2 hours.' },
    startConditions: [{ id: 'sc1', description: 'A referral arrives.', trigger: 'webhook', initialState: 'received' }],
    states: [
      { id: 'received', name: 'Received', description: 'Just arrived.', terminal: false },
      { id: 'contacted', name: 'Contacted', description: 'Reached them.', terminal: true },
    ],
    events: [{ id: 'e1', name: 'Contacted', description: 'Reached them.' }],
    transitions: [{ id: 't1', fromState: 'received', event: 'e1', toState: 'contacted' }],
    terminalOutcomes: [{ state: 'contacted', outcome: 'success', description: 'Contacted successfully.' }],
    owners: [],
    sla: [],
    exceptions: [],
    evidenceRequirements: [{ transitionId: 't1', requiredFields: ['status'], description: 'Marker for t1.' }],
    assumptions: [],
    provenance: { kairosVersion: '0.13.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'active',
    ...overrides,
  }
}

async function writeContract(name: string, contract: ProcessContract): Promise<string> {
  const path = join(workDir, name)
  await writeFile(path, JSON.stringify(contract, null, 2), 'utf-8')
  return path
}

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-compile-cli-test-home-'))
  workDir = await mkdtemp(join(tmpdir(), 'kairos-compile-cli-test-work-'))
})

afterEach(async () => {
  await rm(scratchHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

describe('kairos contract compile (plan-only path) -- zero credentials, exercised through the Phase 3 boundary', () => {
  it('compiles and prints the plan with zero credentials set at all (ANTHROPIC_API_KEY/N8N_BASE_URL/N8N_API_KEY all unset)', async () => {
    const path = await writeContract('valid.json', makeContract())
    const r = run(['contract', 'compile', path], { ANTHROPIC_API_KEY: undefined, N8N_BASE_URL: undefined, N8N_API_KEY: undefined })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('CLI Compile Test Contract')
    expect(r.stdout).toContain('Compiled PackPlan')
    expect(r.stdout).toContain('Referral Intake')
  })

  it('--json output preserves the pre-Phase-3 {plan, traceability} shape -- "plan", not "artifact" (a real external compatibility surface, not an internal renaming this refactor should leak)', async () => {
    const path = await writeContract('valid.json', makeContract())
    const r = run(['contract', 'compile', path, '--json'], { ANTHROPIC_API_KEY: undefined, N8N_BASE_URL: undefined, N8N_API_KEY: undefined })
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as { plan?: unknown; artifact?: unknown; traceability?: unknown[] }
    expect(parsed.plan).toBeDefined()
    expect(parsed.artifact).toBeUndefined()
    expect(parsed.traceability).toHaveLength(2)
  })

  it('refuses (exit 2) a contract that fails deterministic validation, with the exact pre-boundary escalation reason text', async () => {
    const contract = makeContract()
    contract.transitions[0]!.toState = 'does_not_exist'
    const path = await writeContract('invalid.json', contract)
    const r = run(['contract', 'compile', path], { ANTHROPIC_API_KEY: undefined, N8N_BASE_URL: undefined, N8N_API_KEY: undefined })
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('validation errors')
    expect(r.stdout).toContain('This ProcessContract fails deterministic validation and cannot be compiled until fixed.')
  })

  it('refuses (exit 2) a contract with a blocking assumption, with the exact pre-boundary escalation reason text', async () => {
    const contract = makeContract({ assumptions: [{ type: 'blocking', text: 'The Google Sheet ID has not been provided.' }] })
    const path = await writeContract('blocked.json', contract)
    const r = run(['contract', 'compile', path], { ANTHROPIC_API_KEY: undefined, N8N_BASE_URL: undefined, N8N_API_KEY: undefined })
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('blocking assumptions')
    expect(r.stdout).toContain('This ProcessContract has blocking assumptions that must be resolved before compiling.')
  })
})

describe('kairos contract compile --build --dry-run -- credential-check ordering (correction 1)', () => {
  it('exits at the ANTHROPIC_API_KEY gate, never having read N8N_BASE_URL/N8N_API_KEY, when all three are unset -- the strongest available substitute in this environment for a real live --build --dry-run run (no ANTHROPIC_API_KEY is available here to complete one)', async () => {
    const path = await writeContract('valid.json', makeContract())
    const r = run(['contract', 'compile', path, '--build', '--dry-run', '--yes'], { ANTHROPIC_API_KEY: undefined, N8N_BASE_URL: undefined, N8N_API_KEY: undefined })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Missing required environment variable: ANTHROPIC_API_KEY')
    expect(r.stderr).not.toContain('N8N_BASE_URL')
    expect(r.stderr).not.toContain('N8N_API_KEY')
  })
})
