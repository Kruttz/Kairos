import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'

/**
 * End-to-end CLI coverage for roadmap item 11 (Contract Evolution v0, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 11) -- `kairos contract evolve
 * run/list/show/accept/reject`, plus the accept -> amend --from-proposal bridge into Item 12's
 * own gate. Real subprocess runs against an isolated $HOME (matching contract-amend.test.ts's
 * own established idiom) -- everything these commands touch is local file I/O, no network/LLM/n8n.
 *
 * Uses a small hand-built contract with a plain wall-clock-hours SLA (unit: 'hours'), not a
 * business_hours one, and timestamps relative to Date.now() rather than fixed calendar dates --
 * deliberately, not incidentally: `handleContractEvolve`'s own `run` subcommand evaluates
 * compliance against the REAL current time (correct real-world behavior -- "what's my compliance
 * status as of right now"), and a business_hours SLA's elapsed-time math walks real calendar time
 * minute-by-minute (business-calendar.ts). A fixed-date fixture (e.g. reusing evolution.test.ts's
 * own 2024 dates) would open a multi-YEAR gap against the real "now" a live subprocess run
 * actually uses -- confirmed live to take 90+ seconds even after fixing the real Intl.
 * DateTimeFormat performance bug this same gap exposed (business-calendar.ts's own doc comment),
 * because `analyzeContractForAmendments()` calls checkSlaCompliance()-shaped logic multiple times
 * internally (once directly, again per-instance via buildPromiseReportData()) and each multi-year
 * businessMinutesBetween() call, even fixed, still costs real seconds. Real client data will
 * never have this problem (recent activity, not multi-year-old dormant instances) -- this test
 * fixture avoids it by construction (relative timestamps, wall-clock units) rather than by
 * relying on that assumption holding under test.
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
    id: 'evolve-test-contract',
    version: 1,
    clientId: 'evolve-test-client',
    name: 'Evolve Test Contract',
    description: 'A minimal contract for CLI evolve tests -- plain wall-clock hours, no business calendar.',
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
    id: `${id}:start`, contractId: 'evolve-test-contract', contractVersion: 1,
    promiseInstanceId: id, correlationKeyValueHash: id, kind: 'instance_start', initialState: 'received',
    observedAt, sourceWorkflowId: 'wf-intake', sourceExecutionId: `exec-${id}-start`, status: 'observed', detail: 'instance started',
  }
}

function evidenceEntry(id: string, transitionId: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:${transitionId}`, contractId: 'evolve-test-contract', contractVersion: 1,
    promiseInstanceId: id, correlationKeyValueHash: id, kind: 'evidence', transitionId,
    observedAt, sourceWorkflowId: 'wf-processing', sourceExecutionId: `exec-${id}-${transitionId}`, status: 'observed', detail: 'evidence',
  }
}

/** 8 of 10 instances drift past sla-first-contact's 2-hour deadline (10 hours elapsed), 2 stay
 * healthy (0.1 hours elapsed) -- same 8/10 shape as evolution.test.ts's own driftingFixture(),
 * but relative to real "now" and using plain wall-clock hours, per this file's own doc comment. */
async function seedDriftingLedger(clientId: string, contractId: string): Promise<void> {
  const entries: ProofLedgerEntry[] = []
  for (let i = 0; i < 8; i++) {
    entries.push(instanceStart(`drift-${i}`, hoursAgo(10)), evidenceEntry(`drift-${i}`, 't-received-to-attempted', hoursAgo(1)))
  }
  for (let i = 0; i < 2; i++) {
    entries.push(instanceStart(`healthy-${i}`, hoursAgo(3)), evidenceEntry(`healthy-${i}`, 't-received-to-attempted', hoursAgo(2.9)))
  }
  const dir = join(scratchHome, '.kairos', 'promise-ledger', clientId, contractId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
}

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-evolve-cli-test-home-'))
  workDir = await mkdtemp(join(tmpdir(), 'kairos-evolve-cli-test-work-'))
})

afterEach(async () => {
  await rm(scratchHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

async function importTestContract(): Promise<void> {
  const contract = makeContract()
  const path = join(workDir, 'contract.json')
  await writeFile(path, JSON.stringify(contract), 'utf-8')
  const r = run(['contract', 'import', path, '--client-id', 'evolve-test-client', '--json'])
  expect(r.status).toBe(0)
}

describe('kairos contract evolve run -- proposal generated from real structured evidence', () => {
  it('produces a sla_threshold_hotspot proposal when 8 of 10 instances drift', async () => {
    await importTestContract()
    await seedDriftingLedger('evolve-test-client', 'evolve-test-contract')

    const r = run(['contract', 'evolve', 'run', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    const hotspot = parsed.generated.find((p: { category: string }) => p.category === 'sla_threshold_hotspot')
    expect(hotspot).toBeDefined()
    expect(hotspot.confidence).toBe('high')
    expect(hotspot.status).toBe('proposed')
    expect(hotspot.evidence.length).toBeGreaterThan(0)
  })

  it('no proposal when evidence is too weak (empty ledger)', async () => {
    await importTestContract()
    const r = run(['contract', 'evolve', 'run', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.generated).toEqual([])
  })

  it('re-running against the same evidence refreshes rather than duplicates proposals', async () => {
    await importTestContract()
    await seedDriftingLedger('evolve-test-client', 'evolve-test-contract')

    run(['contract', 'evolve', 'run', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])
    run(['contract', 'evolve', 'run', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])

    const listed = run(['contract', 'evolve', 'list', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])
    const proposals = JSON.parse(listed.stdout)
    const hotspots = proposals.filter((p: { category: string }) => p.category === 'sla_threshold_hotspot')
    expect(hotspots).toHaveLength(1)
  })
})

describe('kairos contract evolve list/show', () => {
  it('list shows every stored proposal; show shows one in detail with evidence and history', async () => {
    await importTestContract()
    await seedDriftingLedger('evolve-test-client', 'evolve-test-contract')
    run(['contract', 'evolve', 'run', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])

    const listed = run(['contract', 'evolve', 'list', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])
    const proposals = JSON.parse(listed.stdout)
    expect(proposals.length).toBeGreaterThan(0)

    const proposalId = proposals[0].id
    const shown = run(['contract', 'evolve', 'show', 'evolve-test-contract', proposalId, '--client-id', 'evolve-test-client', '--json'])
    expect(shown.status).toBe(0)
    const detail = JSON.parse(shown.stdout)
    expect(detail.id).toBe(proposalId)
    expect(detail.evidence.length).toBeGreaterThan(0)
  })

  it('show refuses (exit 1) for a nonexistent proposal id', async () => {
    await importTestContract()
    const r = run(['contract', 'evolve', 'show', 'evolve-test-contract', 'nope', '--client-id', 'evolve-test-client'])
    expect(r.status).toBe(1)
  })
})

describe('kairos contract evolve reject -- audited and stored', () => {
  it('records status + a real history entry, never touches the contract', async () => {
    await importTestContract()
    await seedDriftingLedger('evolve-test-client', 'evolve-test-contract')
    run(['contract', 'evolve', 'run', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])
    const listed = JSON.parse(run(['contract', 'evolve', 'list', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json']).stdout)
    const proposalId = listed[0].id

    const rejected = run(['contract', 'evolve', 'reject', 'evolve-test-contract', proposalId, '--client-id', 'evolve-test-client', '--reason', 'staff confirm this is intentional', '--json'])
    expect(rejected.status).toBe(0)
    const parsed = JSON.parse(rejected.stdout)
    expect(parsed.status).toBe('rejected')
    expect(parsed.history).toHaveLength(1)
    expect(parsed.history[0].to).toBe('rejected')
    expect(parsed.history[0].actor).toBe('human')
    expect(parsed.history[0].reason).toBe('staff confirm this is intentional')

    // Confirm this is genuinely persisted, not just this run's own output.
    const reloaded = JSON.parse(run(['contract', 'evolve', 'show', 'evolve-test-contract', proposalId, '--client-id', 'evolve-test-client', '--json']).stdout)
    expect(reloaded.status).toBe('rejected')

    // And confirm the contract itself was never touched.
    const versions = JSON.parse(run(['contract', 'versions', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json']).stdout)
    expect(versions.liveVersion).toBe(1)
    expect(versions.archived).toEqual([])
  })
})

describe('kairos contract evolve accept -- the bridge into Item 12\'s own amendment/diff/version gate', () => {
  it('accept records intent only; the real change flows through contract amend --from-proposal, which marks the proposal applied', async () => {
    await importTestContract()
    await seedDriftingLedger('evolve-test-client', 'evolve-test-contract')
    run(['contract', 'evolve', 'run', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json'])
    const listed = JSON.parse(run(['contract', 'evolve', 'list', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json']).stdout)
    const proposalId = listed.find((p: { category: string }) => p.category === 'sla_threshold_hotspot').id

    const accepted = run(['contract', 'evolve', 'accept', 'evolve-test-contract', proposalId, '--client-id', 'evolve-test-client', '--reason', 'agreed, worth revisiting', '--json'])
    expect(accepted.status).toBe(0)
    expect(JSON.parse(accepted.stdout).status).toBe('accepted')

    // Accepting alone must NOT touch the contract.
    const versionsAfterAccept = JSON.parse(run(['contract', 'versions', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json']).stdout)
    expect(versionsAfterAccept.liveVersion).toBe(1)

    // A human hand-authors the new contract (a non-breaking SLA duration change, per Item 12's
    // own worked example of what this v0 is for) and applies it via amend --from-proposal.
    const v1 = makeContract()
    const v2: ProcessContract = { ...v1, version: 2, sla: v1.sla.map(s => (s.id === 'sla-first-contact' ? { ...s, duration: { amount: 4, unit: 'hours' as const } } : s)) }
    const v2Path = join(workDir, 'v2.json')
    await writeFile(v2Path, JSON.stringify(v2), 'utf-8')

    const amended = run(['contract', 'amend', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--new', v2Path, '--confirm', '--from-proposal', proposalId, '--json'])
    expect(amended.status).toBe(0)
    const amendedParsed = JSON.parse(amended.stdout)
    expect(amendedParsed.amended).toBe(true)
    expect(amendedParsed.linkedProposal.status).toBe('applied')
    expect(amendedParsed.linkedProposal.appliedToVersion).toBe(2)

    // The proposal's own stored record now shows the full lifecycle: proposed -> accepted -> applied.
    const finalProposal = JSON.parse(run(['contract', 'evolve', 'show', 'evolve-test-contract', proposalId, '--client-id', 'evolve-test-client', '--json']).stdout)
    expect(finalProposal.status).toBe('applied')
    expect(finalProposal.appliedToVersion).toBe(2)
    expect(finalProposal.history.map((h: { to: string }) => h.to)).toEqual(['accepted', 'applied'])

    const versionsAfterAmend = JSON.parse(run(['contract', 'versions', 'evolve-test-contract', '--client-id', 'evolve-test-client', '--json']).stdout)
    expect(versionsAfterAmend.liveVersion).toBe(2)
    expect(versionsAfterAmend.archived).toHaveLength(1)
  })
})
