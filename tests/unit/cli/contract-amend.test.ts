import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'

/**
 * End-to-end CLI coverage for roadmap item 12 (Contract Amendment/Diff, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 12) -- `kairos contract amend/diff/versions`,
 * run as a real subprocess against a real, isolated $HOME (matching cli.test.ts's own established
 * `spawnSync` idiom), never mocked. Everything these three commands touch is purely local file
 * I/O -- no network, no LLM, no n8n -- so a real subprocess run is cheap and exercises the actual
 * CLI dispatch/flag-parsing/exit-code behavior, not just the underlying module functions
 * (already covered directly in tests/unit/promise/store.test.ts, diff.test.ts, registry.test.ts).
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../../src/cli.ts')

let scratchHome: string

function run(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: scratchHome },
    timeout: 15_000,
  })
}

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'amend-test-contract',
    version: 1,
    clientId: 'amend-test-client',
    name: 'Amend Test Contract',
    description: 'A minimal contract for CLI amend/diff/versions tests.',
    entity: { name: 'Thing', description: 'A thing.' },
    correlationKey: { fieldPath: 'body.id', description: 'The thing id.' },
    promise: { text: 'The thing is handled.' },
    startConditions: [{ id: 'sc1', description: 'A thing arrives.', trigger: 'webhook', initialState: 's1' }],
    states: [{ id: 's1', name: 'Received', description: 'Just arrived.', terminal: false }, { id: 's2', name: 'Done', description: 'Handled.', terminal: true }],
    events: [{ id: 'e1', name: 'Handled', description: 'The thing was handled.' }],
    transitions: [{ id: 't1', fromState: 's1', event: 'e1', toState: 's2' }],
    terminalOutcomes: [{ state: 's2', outcome: 'success', description: 'Handled successfully.' }],
    owners: [],
    sla: [{ id: 'sla1', measuredFrom: { state: 's1' }, expectedBy: { state: 's2' }, duration: { amount: 4, unit: 'hours' } }],
    exceptions: [],
    evidenceRequirements: [{ transitionId: 't1', requiredFields: ['status'], description: 'Marker for t1.' }],
    assumptions: [],
    provenance: { kairosVersion: '0.11.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'active',
    ...overrides,
  }
}

async function writeContractFile(dir: string, name: string, contract: ProcessContract): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(contract, null, 2), 'utf-8')
  return path
}

/** Directly seeds a ProofLedger entry (bypassing a real n8n poll, matching this test's own
 * offline-only scope) so buildPromiseReportData() classifies a real in_progress instance --
 * needed to exercise the active-instance version-pinning gate without a live sandbox. */
async function seedInProgressLedgerEntry(clientId: string, contract: ProcessContract): Promise<void> {
  const dir = join(scratchHome, '.kairos', 'promise-ledger', clientId, contract.id)
  await mkdir(dir, { recursive: true })
  const entry: ProofLedgerEntry = {
    id: 'exec-1:instance_start',
    contractId: contract.id,
    contractVersion: contract.version,
    promiseInstanceId: 'a'.repeat(64),
    correlationKeyValueHash: 'a'.repeat(64),
    kind: 'instance_start',
    initialState: 's1',
    observedAt: new Date().toISOString(),
    sourceWorkflowId: 'wf-1',
    sourceExecutionId: 'exec-1',
    status: 'observed',
    detail: 'New Thing instance began in state "s1".',
  }
  await writeFile(join(dir, 'ledger.jsonl'), JSON.stringify(entry) + '\n', 'utf-8')
}

let workDir: string

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-amend-cli-test-home-'))
  workDir = await mkdtemp(join(tmpdir(), 'kairos-amend-cli-test-work-'))
})

afterEach(async () => {
  await rm(scratchHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

describe('kairos contract versions -- a never-amended contract', () => {
  it('lists only the live version, no archive', async () => {
    const path = await writeContractFile(workDir, 'v1.json', makeContract())
    const imported = run(['contract', 'import', path, '--client-id', 'amend-test-client', '--json'])
    expect(imported.status).toBe(0)

    const r = run(['contract', 'versions', 'amend-test-contract', '--client-id', 'amend-test-client', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.liveVersion).toBe(1)
    expect(parsed.archived).toEqual([])
  })
})

describe('kairos contract amend -- no-write preview (no --confirm)', () => {
  it('shows the diff and writes nothing -- the live contract stays v1', async () => {
    const v1Path = await writeContractFile(workDir, 'v1.json', makeContract({ version: 1 }))
    expect(run(['contract', 'import', v1Path, '--client-id', 'amend-test-client', '--json']).status).toBe(0)

    const v2 = makeContract({ version: 2, sla: [{ id: 'sla1', measuredFrom: { state: 's1' }, expectedBy: { state: 's2' }, duration: { amount: 2, unit: 'hours' } }] })
    const v2Path = await writeContractFile(workDir, 'v2.json', v2)

    const preview = run(['contract', 'amend', 'amend-test-contract', '--client-id', 'amend-test-client', '--new', v2Path, '--json'])
    expect(preview.status).toBe(0)
    const parsed = JSON.parse(preview.stdout)
    expect(parsed.amended).toBe(false)
    expect(parsed.preview).toBe(true)
    expect(parsed.diff.hasBreakingChanges).toBe(false)

    // Confirm nothing was actually written -- versions still shows only v1 live, no archive.
    const versions = run(['contract', 'versions', 'amend-test-contract', '--client-id', 'amend-test-client', '--json'])
    const versionsParsed = JSON.parse(versions.stdout)
    expect(versionsParsed.liveVersion).toBe(1)
    expect(versionsParsed.archived).toEqual([])
  })
})

describe('kairos contract amend --confirm -- a non-breaking amendment', () => {
  it('archives v1, makes v2 live, and kairos contract diff can compare them afterward', async () => {
    const v1 = makeContract({ version: 1 })
    const v1Path = await writeContractFile(workDir, 'v1.json', v1)
    expect(run(['contract', 'import', v1Path, '--client-id', 'amend-test-client', '--json']).status).toBe(0)

    const v2 = makeContract({ version: 2, sla: [{ id: 'sla1', measuredFrom: { state: 's1' }, expectedBy: { state: 's2' }, duration: { amount: 2, unit: 'hours' } }] })
    const v2Path = await writeContractFile(workDir, 'v2.json', v2)

    const confirmed = run(['contract', 'amend', 'amend-test-contract', '--client-id', 'amend-test-client', '--new', v2Path, '--confirm', '--json'])
    expect(confirmed.status).toBe(0)
    const parsed = JSON.parse(confirmed.stdout)
    expect(parsed.amended).toBe(true)
    expect(parsed.archivedVersion).toBe(1)

    const versions = run(['contract', 'versions', 'amend-test-contract', '--client-id', 'amend-test-client', '--json'])
    const versionsParsed = JSON.parse(versions.stdout)
    expect(versionsParsed.liveVersion).toBe(2)
    expect(versionsParsed.archived.map((r: { contract: { version: number } }) => r.contract.version)).toEqual([1])

    const diff = run(['contract', 'diff', 'amend-test-contract', '--client-id', 'amend-test-client', '--from', '1', '--to', '2', '--json'])
    expect(diff.status).toBe(0)
    const diffParsed = JSON.parse(diff.stdout)
    expect(diffParsed.hasBreakingChanges).toBe(false)
    expect(diffParsed.changes.some((c: { path: string }) => c.path === 'sla[sla1]')).toBe(true)
  })
})

describe('kairos contract amend --confirm -- a breaking amendment', () => {
  it('succeeds when there are no in_progress instances', async () => {
    const v1 = makeContract({ version: 1 })
    const v1Path = await writeContractFile(workDir, 'v1.json', v1)
    expect(run(['contract', 'import', v1Path, '--client-id', 'amend-test-client', '--json']).status).toBe(0)

    // Breaking: transition t1's toState changes.
    const v2 = makeContract({ version: 2, evidenceRequirements: [{ transitionId: 't1', requiredFields: ['status', 'extraField'], description: 'Marker for t1.' }] })
    const v2Path = await writeContractFile(workDir, 'v2.json', v2)

    const confirmed = run(['contract', 'amend', 'amend-test-contract', '--client-id', 'amend-test-client', '--new', v2Path, '--confirm', '--json'])
    expect(confirmed.status).toBe(0)
    const parsed = JSON.parse(confirmed.stdout)
    expect(parsed.amended).toBe(true)
    expect(parsed.diff.hasBreakingChanges).toBe(true)
  })

  it('refuses (exit 2) when a breaking amendment would apply while an instance is in_progress, and succeeds with the explicit override', async () => {
    const v1 = makeContract({ version: 1 })
    const v1Path = await writeContractFile(workDir, 'v1.json', v1)
    expect(run(['contract', 'import', v1Path, '--client-id', 'amend-test-client', '--json']).status).toBe(0)
    await seedInProgressLedgerEntry('amend-test-client', v1)

    const v2 = makeContract({ version: 2, evidenceRequirements: [{ transitionId: 't1', requiredFields: ['status', 'extraField'], description: 'Marker for t1.' }] })
    const v2Path = await writeContractFile(workDir, 'v2.json', v2)

    const refused = run(['contract', 'amend', 'amend-test-contract', '--client-id', 'amend-test-client', '--new', v2Path, '--confirm', '--json'])
    expect(refused.status).toBe(2)
    const refusedParsed = JSON.parse(refused.stdout)
    expect(refusedParsed.amended).toBe(false)
    expect(refusedParsed.refusedBreakingWithActiveInstances).toBe(true)
    expect(refusedParsed.inProgressCount).toBe(1)

    // Confirm nothing was written by the refused attempt.
    const stillV1 = run(['contract', 'versions', 'amend-test-contract', '--client-id', 'amend-test-client', '--json'])
    expect(JSON.parse(stillV1.stdout).liveVersion).toBe(1)

    const overridden = run(['contract', 'amend', 'amend-test-contract', '--client-id', 'amend-test-client', '--new', v2Path, '--confirm', '--confirm-breaking-with-active-instances', '--json'])
    expect(overridden.status).toBe(0)
    expect(JSON.parse(overridden.stdout).amended).toBe(true)
  })
})

describe('kairos contract amend -- validation gate (same as contract import)', () => {
  it('refuses an invalid new contract, writes nothing', async () => {
    const v1 = makeContract({ version: 1 })
    const v1Path = await writeContractFile(workDir, 'v1.json', v1)
    expect(run(['contract', 'import', v1Path, '--client-id', 'amend-test-client', '--json']).status).toBe(0)

    // Invalid: a transition referencing a fromState that doesn't exist in states[].
    const invalid = makeContract({ version: 2, transitions: [{ id: 't1', fromState: 'nonexistent-state', event: 'e1', toState: 's2' }] })
    const invalidPath = await writeContractFile(workDir, 'invalid.json', invalid)

    const r = run(['contract', 'amend', 'amend-test-contract', '--client-id', 'amend-test-client', '--new', invalidPath, '--confirm', '--json'])
    expect(r.status).toBe(2)
    expect(JSON.parse(r.stdout).amended).toBe(false)

    const stillV1 = run(['contract', 'versions', 'amend-test-contract', '--client-id', 'amend-test-client', '--json'])
    expect(JSON.parse(stillV1.stdout).liveVersion).toBe(1)
  })

  it('refuses when the new contract\'s own id does not match the target contract-id (not an amendment of this contract)', async () => {
    const v1 = makeContract({ version: 1 })
    const v1Path = await writeContractFile(workDir, 'v1.json', v1)
    expect(run(['contract', 'import', v1Path, '--client-id', 'amend-test-client', '--json']).status).toBe(0)

    const wrongId = makeContract({ id: 'a-totally-different-contract', version: 2 })
    const wrongIdPath = await writeContractFile(workDir, 'wrong-id.json', wrongId)

    const r = run(['contract', 'amend', 'amend-test-contract', '--client-id', 'amend-test-client', '--new', wrongIdPath, '--confirm'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('same contract id')
  })
})
