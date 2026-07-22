import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'
import { upsertContractAmendmentProposals } from '../../../src/promise/evolution-store.js'
import type { ContractAmendmentProposal } from '../../../src/promise/evolution-types.js'

// Same reasoning as contract-evolve.test.ts's own doc comment: real chained spawnSync calls
// (several per test here too) can exceed vitest's default 5000ms under full-suite parallel load.
vi.setConfig({ testTimeout: 60_000 })

/**
 * End-to-end CLI coverage for roadmap item 15 (Self-Tuning Flywheel v0, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §15) -- `kairos learn candidates/list/show/promote/
 * reject`. Real subprocess runs against an isolated $HOME, matching contract-evolve.test.ts's
 * own established idiom (same minimal wall-clock-hours contract fixture, same relative-timestamp
 * ledger seeding, for the same reason: avoiding a multi-year real-"now" gap against fixed
 * calendar-date fixtures). Everything these commands touch is local file I/O, no network/LLM/n8n.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../../src/cli.ts')

let scratchHome: string
let workDir: string
const ORIGINAL_HOME = homedir()

function run(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: scratchHome },
    timeout: 20_000,
  })
}

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'learn-test-contract',
    version: 1,
    clientId: 'learn-test-client',
    name: 'Learn Test Contract',
    description: 'A minimal contract for CLI learn tests -- plain wall-clock hours, no business calendar.',
    entity: { name: 'Referral', description: 'A referral.' },
    correlationKey: { fieldPath: 'body.id', description: 'The referral id.' },
    promise: { text: 'Every referral is contacted within 2 hours.' },
    startConditions: [{ id: 'sc1', description: 'A referral arrives.', trigger: 'webhook', initialState: 'received' }],
    states: [
      { id: 'received', name: 'Received', description: 'Just arrived.', terminal: false },
      { id: 'contact_attempted', name: 'Contact attempted', description: 'A call was made.', terminal: false },
      { id: 'contacted', name: 'Contacted', description: 'Reached the referral.', terminal: false },
      { id: 'scheduled', name: 'Scheduled', description: 'An appointment was booked.', terminal: true },
    ],
    events: [{ id: 'e1', name: 'Contact attempted', description: 'A call was made.' }, { id: 'e2', name: 'Contacted', description: 'Reached them.' }, { id: 'e3', name: 'Scheduled', description: 'An appointment was booked.' }],
    transitions: [
      { id: 't-received-to-attempted', fromState: 'received', event: 'e1', toState: 'contact_attempted' },
      { id: 't-attempted-to-contacted', fromState: 'contact_attempted', event: 'e2', toState: 'contacted' },
      { id: 't-contacted-to-scheduled', fromState: 'contacted', event: 'e3', toState: 'scheduled' },
    ],
    terminalOutcomes: [{ state: 'scheduled', outcome: 'success', description: 'An appointment was booked.' }],
    owners: [{ state: 'received', owner: 'intake coordinator' }],
    sla: [{ id: 'sla-first-contact', measuredFrom: { state: 'received' }, expectedBy: { state: 'contact_attempted' }, duration: { amount: 2, unit: 'hours' } }],
    exceptions: [],
    evidenceRequirements: [{ transitionId: 't-attempted-to-contacted', requiredFields: ['status'], description: 'Marker for contact.' }],
    assumptions: [],
    provenance: { kairosVersion: '0.12.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'active',
    ...overrides,
  }
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
}

function instanceStart(id: string, contractId: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:start`, contractId, contractVersion: 1,
    promiseInstanceId: id, correlationKeyValueHash: id, kind: 'instance_start', initialState: 'received',
    observedAt, sourceWorkflowId: 'wf-intake', sourceExecutionId: `exec-${id}-start`, status: 'observed', detail: 'instance started',
  }
}

function evidenceEntry(id: string, contractId: string, transitionId: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:${transitionId}`, contractId, contractVersion: 1,
    promiseInstanceId: id, correlationKeyValueHash: id, kind: 'evidence', transitionId,
    observedAt, sourceWorkflowId: 'wf-processing', sourceExecutionId: `exec-${id}-${transitionId}`, status: 'observed', detail: 'evidence',
  }
}

/** 8 of 10 instances drift past sla-first-contact's 2-hour deadline, 2 stay healthy -- same
 * 8/10 shape as contract-evolve.test.ts's own seedDriftingLedger(). */
async function seedDriftingLedger(clientId: string, contractId: string): Promise<void> {
  const entries: ProofLedgerEntry[] = []
  for (let i = 0; i < 8; i++) {
    entries.push(instanceStart(`drift-${i}`, contractId, hoursAgo(10)), evidenceEntry(`drift-${i}`, contractId, 't-received-to-attempted', hoursAgo(1)))
  }
  for (let i = 0; i < 2; i++) {
    entries.push(instanceStart(`healthy-${i}`, contractId, hoursAgo(3)), evidenceEntry(`healthy-${i}`, contractId, 't-received-to-attempted', hoursAgo(2.9)))
  }
  const dir = join(scratchHome, '.kairos', 'promise-ledger', clientId, contractId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
}

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-learn-cli-test-home-'))
  workDir = await mkdtemp(join(tmpdir(), 'kairos-learn-cli-test-work-'))
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

async function importTestContract(clientId = 'learn-test-client', contractId = 'learn-test-contract'): Promise<void> {
  const contract = makeContract({ id: contractId, clientId })
  const path = join(workDir, `${clientId}-${contractId}.json`)
  await writeFile(path, JSON.stringify(contract), 'utf-8')
  const r = run(['contract', 'import', path, '--client-id', clientId, '--json'])
  expect(r.status).toBe(0)
}

/** Runs evolve run/accept (or reject) against the default fixture contract, returning the
 * accepted/rejected sla_threshold_hotspot proposal's id. */
async function acceptOrRejectHotspot(decision: 'accept' | 'reject', reason: string): Promise<string> {
  await importTestContract()
  await seedDriftingLedger('learn-test-client', 'learn-test-contract')
  run(['contract', 'evolve', 'run', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
  const proposals = JSON.parse(run(['contract', 'evolve', 'list', 'learn-test-contract', '--client-id', 'learn-test-client', '--json']).stdout)
  const proposalId = proposals.find((p: { category: string }) => p.category === 'sla_threshold_hotspot').id
  run(['contract', 'evolve', decision, 'learn-test-contract', proposalId, '--client-id', 'learn-test-client', '--reason', reason, '--json'])
  return proposalId
}

describe('kairos learn candidates -- notes only from decided proposals', () => {
  it('an accepted proposal produces a candidate note with full provenance', async () => {
    const proposalId = await acceptOrRejectHotspot('accept', 'worth reviewing')

    const r = run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.generated).toHaveLength(1)
    const note = parsed.generated[0]
    expect(note.status).toBe('candidate')
    expect(note.provenance.decision).toBe('accepted')
    expect(note.provenance.decisionReason).toBe('worth reviewing')
    expect(note.provenance.proposalId).toBe(proposalId)
    expect(note.provenance.contractId).toBe('learn-test-contract')
    expect(note.provenance.clientId).toBe('learn-test-client')
    expect(note.provenance.proposalCategory).toBe('sla_threshold_hotspot')
    expect(note.provenance.synthetic).toBe(false)
    expect(note.provenance.evidence.length).toBeGreaterThan(0)
  })

  it('a rejected proposal also produces a candidate note, decision: rejected', async () => {
    await acceptOrRejectHotspot('reject', 'not a real issue')

    const parsed = JSON.parse(run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json']).stdout)
    expect(parsed.generated).toHaveLength(1)
    expect(parsed.generated[0].provenance.decision).toBe('rejected')
    expect(parsed.generated[0].provenance.decisionReason).toBe('not a real issue')
  })

  it('a still-undecided ("proposed") proposal produces no note', async () => {
    await importTestContract()
    await seedDriftingLedger('learn-test-client', 'learn-test-contract')
    run(['contract', 'evolve', 'run', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    // Never accept/reject.
    const parsed = JSON.parse(run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json']).stdout)
    expect(parsed.generated).toEqual([])
  })

  it('re-running candidates refreshes the same note per proposal, never duplicates it', async () => {
    const proposalId = await acceptOrRejectHotspot('accept', 'worth reviewing')

    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])

    const listed = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)
    const matching = listed.filter((n: { provenance: { proposalId: string } }) => n.provenance.proposalId === proposalId)
    expect(matching).toHaveLength(1)
  })

  it('a promoted note keeps its status across a re-run of candidates -- never reset to candidate', async () => {
    await acceptOrRejectHotspot('accept', 'worth reviewing')
    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    const noteId = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)[0].id
    run(['learn', 'promote', noteId, '--client-id', 'learn-test-client', '--json'])

    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    const listed = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)
    expect(listed.find((n: { id: string }) => n.id === noteId).status).toBe('promoted')
  })
})

describe('kairos learn show', () => {
  it('shows one note in full, including evidence and status-change history', async () => {
    await acceptOrRejectHotspot('accept', 'worth reviewing')
    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    const noteId = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)[0].id

    const shown = run(['learn', 'show', noteId, '--client-id', 'learn-test-client', '--json'])
    expect(shown.status).toBe(0)
    const detail = JSON.parse(shown.stdout)
    expect(detail.id).toBe(noteId)
    expect(detail.provenance.evidence.length).toBeGreaterThan(0)
    expect(detail.history).toEqual([])
  })

  it('refuses (exit 1) for a nonexistent note id', async () => {
    await importTestContract()
    const r = run(['learn', 'show', 'nope', '--client-id', 'learn-test-client'])
    expect(r.status).toBe(1)
  })
})

describe('kairos learn promote -- only changes note status, never contract/prompt/rule/workflow state', () => {
  it('promote flips status, appends an audited history entry, and leaves the contract byte-identical', async () => {
    await acceptOrRejectHotspot('accept', 'worth reviewing')
    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    const before = run(['contract', 'versions', 'learn-test-contract', '--client-id', 'learn-test-client', '--json']).stdout

    const noteId = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)[0].id
    const promoted = run(['learn', 'promote', noteId, '--client-id', 'learn-test-client', '--reason', 'confirmed real pattern', '--json'])
    expect(promoted.status).toBe(0)
    const parsed = JSON.parse(promoted.stdout)
    expect(parsed.status).toBe('promoted')
    expect(parsed.history).toHaveLength(1)
    expect(parsed.history[0]).toMatchObject({ from: 'candidate', to: 'promoted', actor: 'human', reason: 'confirmed real pattern' })

    const after = run(['contract', 'versions', 'learn-test-contract', '--client-id', 'learn-test-client', '--json']).stdout
    expect(after).toBe(before)
  })

  it('reject requires --reason, and records it', async () => {
    await acceptOrRejectHotspot('accept', 'worth reviewing')
    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    const noteId = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)[0].id

    const missingReason = run(['learn', 'reject', noteId, '--client-id', 'learn-test-client'])
    expect(missingReason.status).toBe(1)

    const rejected = run(['learn', 'reject', noteId, '--client-id', 'learn-test-client', '--reason', 'not a real pattern', '--json'])
    expect(rejected.status).toBe(0)
    expect(JSON.parse(rejected.stdout).status).toBe('rejected')
    expect(JSON.parse(rejected.stdout).history[0].reason).toBe('not a real pattern')
  })
})

describe('kairos learn promote -- synthetic-only evidence guardrail', () => {
  it('a note derived entirely from harness_mismatch (synthetic) evidence can never be promoted', async () => {
    await importTestContract()
    process.env['HOME'] = scratchHome
    const syntheticProposal: ContractAmendmentProposal = {
      id: 'learn-test-contract-v1-harness_mismatch-scenario-1',
      contractId: 'learn-test-contract',
      clientId: 'learn-test-client',
      contractVersion: 1,
      category: 'harness_mismatch',
      summary: 'Generated scenario "happy path" did not match Kairos\'s own evaluation.',
      affectedElementId: 'scenario-1',
      evidence: [{ kind: 'harness_scenario', id: 'scenario-1' }],
      occurrenceCount: 1,
      sampleSize: 1,
      confidence: 'low',
      recommendedNextAction: 'Review the scenario by hand.',
      status: 'proposed',
      createdAt: new Date().toISOString(),
      history: [],
    }
    await upsertContractAmendmentProposals('learn-test-client', 'learn-test-contract', [syntheticProposal])

    const accepted = run(['contract', 'evolve', 'accept', 'learn-test-contract', syntheticProposal.id, '--client-id', 'learn-test-client', '--json'])
    expect(accepted.status).toBe(0)

    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    const listed = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)
    const note = listed.find((n: { provenance: { proposalId: string } }) => n.provenance.proposalId === syntheticProposal.id)
    expect(note.provenance.synthetic).toBe(true)

    const promoted = run(['learn', 'promote', note.id, '--client-id', 'learn-test-client'])
    expect(promoted.status).toBe(1)
    expect(promoted.stderr).toContain('synthetic')

    // The refusal must not have changed anything.
    const reloaded = JSON.parse(run(['learn', 'show', note.id, '--client-id', 'learn-test-client', '--json']).stdout)
    expect(reloaded.status).toBe('candidate')
    expect(reloaded.history).toEqual([])
  })

  it('a note with real, non-synthetic evidence is promotable (control case for the guardrail above)', async () => {
    await acceptOrRejectHotspot('accept', 'worth reviewing')
    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])
    const note = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)[0]
    expect(note.provenance.synthetic).toBe(false)

    const promoted = run(['learn', 'promote', note.id, '--client-id', 'learn-test-client', '--json'])
    expect(promoted.status).toBe(0)
    expect(JSON.parse(promoted.stdout).status).toBe('promoted')
  })
})

describe('kairos learn list -- client isolation', () => {
  it('notes from one client never appear when listing another', async () => {
    await acceptOrRejectHotspot('accept', 'worth reviewing') // seeds learn-test-client
    run(['learn', 'candidates', 'learn-test-contract', '--client-id', 'learn-test-client', '--json'])

    await importTestContract('other-client', 'other-contract') // a second, unrelated client -- no proposals, no notes
    const listedOther = JSON.parse(run(['learn', 'list', '--client-id', 'other-client', '--json']).stdout)
    expect(listedOther).toEqual([])

    const listedOriginal = JSON.parse(run(['learn', 'list', '--client-id', 'learn-test-client', '--json']).stdout)
    expect(listedOriginal.length).toBeGreaterThan(0)
    expect(listedOriginal.every((n: { provenance: { clientId: string } }) => n.provenance.clientId === 'learn-test-client')).toBe(true)
  })
})

describe('kairos learn -- help text uses conservative, non-guarantee language', () => {
  it('prints usage and exits 1 with no arguments, describing decisions as never automatic', async () => {
    const r = run(['learn'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Usage: kairos learn candidates')
    expect(r.stderr).toContain('never automatic')
    expect(r.stderr).toContain('never changes a prompt')
  })
})
