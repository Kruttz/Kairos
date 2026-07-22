import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'

/**
 * End-to-end CLI coverage for roadmap item 13 (Automation P&L / Value Report, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 13) -- `kairos contract value`. Real subprocess
 * runs against an isolated $HOME (matching contract-amend.test.ts/contract-evolve.test.ts's own
 * established idiom) -- everything this command touches is local file I/O, no network/LLM/n8n.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../../src/cli.ts')

let scratchHome: string
let workDir: string

function run(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: scratchHome },
    timeout: 20_000,
  })
}

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'value-test-contract',
    version: 1,
    clientId: 'value-test-client',
    name: 'Value Test Contract',
    description: 'A minimal contract for CLI value-report tests.',
    entity: { name: 'Referral', description: 'A referral.' },
    correlationKey: { fieldPath: 'body.id', description: 'The referral id.' },
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
    sla: [{ id: 'sla1', measuredFrom: { state: 'received' }, expectedBy: { state: 'contacted' }, duration: { amount: 2, unit: 'hours' } }],
    exceptions: [],
    evidenceRequirements: [{ transitionId: 't1', requiredFields: ['status'], description: 'Marker for t1.' }],
    assumptions: [],
    provenance: { kairosVersion: '0.11.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'active',
    ...overrides,
  }
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
}

function instanceStart(id: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:start`, contractId: 'value-test-contract', contractVersion: 1,
    promiseInstanceId: id, correlationKeyValueHash: id, kind: 'instance_start', initialState: 'received',
    observedAt, sourceWorkflowId: 'wf-intake', sourceExecutionId: `exec-${id}-start`, status: 'observed', detail: 'instance started',
  }
}

function evidenceEntry(id: string, transitionId: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:${transitionId}`, contractId: 'value-test-contract', contractVersion: 1,
    promiseInstanceId: id, correlationKeyValueHash: id, kind: 'evidence', transitionId,
    observedAt, sourceWorkflowId: 'wf-processing', sourceExecutionId: `exec-${id}-${transitionId}`, status: 'observed', detail: 'evidence',
  }
}

/** 3 instances reach 'contacted' well within the 2h SLA -- real, real 'kept' classifications, so
 * instanceCounts.kept > 0 for the value-line-item tests below. */
async function seedKeptLedger(clientId: string, contractId: string): Promise<void> {
  const entries: ProofLedgerEntry[] = []
  for (let i = 0; i < 3; i++) {
    entries.push(instanceStart(`kept-${i}`, hoursAgo(1)), evidenceEntry(`kept-${i}`, 't1', hoursAgo(0.5)))
  }
  const dir = join(scratchHome, '.kairos', 'promise-ledger', clientId, contractId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
}

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-value-cli-test-home-'))
  workDir = await mkdtemp(join(tmpdir(), 'kairos-value-cli-test-work-'))
})

afterEach(async () => {
  await rm(scratchHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

async function importTestContract(): Promise<void> {
  const contract = makeContract()
  const path = join(workDir, 'contract.json')
  await writeFile(path, JSON.stringify(contract), 'utf-8')
  const r = run(['contract', 'import', path, '--client-id', 'value-test-client', '--json'])
  expect(r.status).toBe(0)
}

describe('kairos contract value -- no assumptions', () => {
  it('produces only the Observed section, with no dollar/time value figures anywhere', async () => {
    await importTestContract()
    await seedKeptLedger('value-test-client', 'value-test-contract')

    const r = run(['contract', 'value', 'value-test-contract', '--client-id', 'value-test-client', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.estimatedValue).toBeUndefined()
    expect(parsed.observed.instanceCounts.kept).toBe(3)
  })

  it('the rendered text output has no "Estimated Value" section', async () => {
    await importTestContract()
    await seedKeptLedger('value-test-client', 'value-test-contract')
    const r = run(['contract', 'value', 'value-test-contract', '--client-id', 'value-test-client'])
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('Estimated Value')
  })
})

describe('kairos contract value -- with --assumptions', () => {
  it('produces an Estimated Value section with correctly-computed line items', async () => {
    await importTestContract()
    await seedKeptLedger('value-test-client', 'value-test-contract')

    const assumptionsPath = join(workDir, 'assumptions.json')
    await writeFile(assumptionsPath, JSON.stringify({ minutesSavedPerKeptInstance: 20, enteredBy: 'Jordan' }), 'utf-8')

    const r = run(['contract', 'value', 'value-test-contract', '--client-id', 'value-test-client', '--assumptions', assumptionsPath, '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.estimatedValue).toBeDefined()
    expect(parsed.estimatedValue.lineItems).toHaveLength(1)
    expect(parsed.estimatedValue.lineItems[0].count).toBe(3)
    expect(parsed.estimatedValue.lineItems[0].total).toBe(60)
    expect(parsed.estimatedValue.disclaimer).toContain('Jordan')
  })

  it('refuses (exit 1, nothing printed) when a dollar assumption has no currency', async () => {
    await importTestContract()
    const assumptionsPath = join(workDir, 'assumptions.json')
    await writeFile(assumptionsPath, JSON.stringify({ dollarValuePerResolvedException: 50 }), 'utf-8')

    const r = run(['contract', 'value', 'value-test-contract', '--client-id', 'value-test-client', '--assumptions', assumptionsPath])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('currency is required')
  })

  it('succeeds when a dollar assumption is paired with a currency', async () => {
    await importTestContract()
    await seedKeptLedger('value-test-client', 'value-test-contract')
    const assumptionsPath = join(workDir, 'assumptions.json')
    await writeFile(assumptionsPath, JSON.stringify({ dollarValuePerResolvedException: 50, currency: 'USD' }), 'utf-8')

    const r = run(['contract', 'value', 'value-test-contract', '--client-id', 'value-test-client', '--assumptions', assumptionsPath, '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.estimatedValue).toBeDefined()
  })
})

describe('kairos contract value --bundle', () => {
  it('writes automation-value-report.md and a manifest', async () => {
    await importTestContract()
    await seedKeptLedger('value-test-client', 'value-test-contract')
    const bundleDir = join(workDir, 'bundle')

    const r = run(['contract', 'value', 'value-test-contract', '--client-id', 'value-test-client', '--bundle', bundleDir])
    expect(r.status).toBe(0)

    const reportContent = await readFile(join(bundleDir, 'automation-value-report.md'), 'utf-8')
    expect(reportContent).toContain('Promise Report')
    const manifest = JSON.parse(await readFile(join(bundleDir, 'automation-value-report-manifest.json'), 'utf-8'))
    expect(manifest.contractId).toBe('value-test-contract')
    expect(manifest.hasEstimatedValue).toBe(false)
  })
})
