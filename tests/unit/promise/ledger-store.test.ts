import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  appendProofLedgerEntries,
  getProofLedgerEntries,
  loadContractPollWatermark,
  saveContractPollWatermark,
} from '../../../src/promise/ledger-store.js'
import type { ProofLedgerEntry, ContractPollWatermark } from '../../../src/promise/ledger-types.js'

const CLIENT_A = 'empire-homecare'
const CLIENT_B = 'a-different-client'

function makeEntry(overrides: Partial<ProofLedgerEntry> = {}): ProofLedgerEntry {
  return {
    id: 'exec-1:t-attempted-to-contacted',
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: 'abc123',
    correlationKeyValueHash: 'abc123',
    kind: 'evidence',
    transitionId: 't-attempted-to-contacted',
    observedAt: '2026-07-20T09:00:00.000Z',
    sourceWorkflowId: 'wf-1',
    sourceExecutionId: 'exec-1',
    status: 'observed',
    detail: 'callOutcome=no_answer, callTimestamp=t1',
    ...overrides,
  }
}

// Same test-isolation discipline as store.test.ts/snapshot.test.ts -- never let test data leak
// into the real ~/.kairos/ directory.
let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-ledger-store-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('appendProofLedgerEntries / getProofLedgerEntries', () => {
  it('round-trips entries appended in one call', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'empire-homecare-referral-intake', [makeEntry(), makeEntry({ id: 'exec-2:t-attempted-to-contacted', sourceExecutionId: 'exec-2' })])
    const entries = await getProofLedgerEntries(CLIENT_A, 'empire-homecare-referral-intake')
    expect(entries.map(e => e.sourceExecutionId)).toEqual(['exec-1', 'exec-2'])
  })

  it('accumulates across multiple append calls (append-only, never overwritten)', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: 'e1' })])
    await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: 'e2' })])
    const entries = await getProofLedgerEntries(CLIENT_A, 'c1')
    expect(entries.map(e => e.id)).toEqual(['e1', 'e2'])
  })

  it('a no-op append (empty array) never creates the file', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'c1', [])
    const entries = await getProofLedgerEntries(CLIENT_A, 'c1')
    expect(entries).toEqual([])
  })

  it('the ledger file is chmod 600', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry()])
    const path = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1', 'ledger.jsonl')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('getProofLedgerEntries returns an empty array, not a throw, when nothing was ever written', async () => {
    expect(await getProofLedgerEntries(CLIENT_A, 'nobody-ever-wrote-here')).toEqual([])
  })

  it('respects the limit, keeping the most recent entries', async () => {
    for (let i = 0; i < 5; i++) await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: `e${i}`, sourceExecutionId: `e${i}` })])
    const entries = await getProofLedgerEntries(CLIENT_A, 'c1', 2)
    expect(entries.map(e => e.sourceExecutionId)).toEqual(['e3', 'e4'])
  })

  it('ledgers are scoped per contractId', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'contract-a', [makeEntry({ contractId: 'contract-a' })])
    await appendProofLedgerEntries(CLIENT_A, 'contract-b', [makeEntry({ contractId: 'contract-b' })])
    expect(await getProofLedgerEntries(CLIENT_A, 'contract-a')).toHaveLength(1)
    expect(await getProofLedgerEntries(CLIENT_A, 'contract-b')).toHaveLength(1)
  })

  // Finding 1 fix (supplemental measurement-integrity audit, 2026-07-20) -- the whole point of
  // this fix. contractId alone (deriveContractId() is just a slug of the contract's own name) has
  // no cross-client uniqueness guarantee -- two different clients naming a contract the same way
  // must NOT share a ledger file. This is the exact regression this fix closes.
  it('SECURITY: two different clientIds with the SAME contractId write and read fully isolated ledgers', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'shared-contract-id', [makeEntry({ contractId: 'shared-contract-id', sourceExecutionId: 'client-a-exec', promiseInstanceId: 'client-a-instance' })])
    await appendProofLedgerEntries(CLIENT_B, 'shared-contract-id', [makeEntry({ contractId: 'shared-contract-id', sourceExecutionId: 'client-b-exec', promiseInstanceId: 'client-b-instance' })])

    const aEntries = await getProofLedgerEntries(CLIENT_A, 'shared-contract-id')
    const bEntries = await getProofLedgerEntries(CLIENT_B, 'shared-contract-id')

    expect(aEntries).toHaveLength(1)
    expect(aEntries[0]!.sourceExecutionId).toBe('client-a-exec')
    expect(bEntries).toHaveLength(1)
    expect(bEntries[0]!.sourceExecutionId).toBe('client-b-exec')
    // Neither client's read ever contains the other's data, by construction (different files).
    expect(aEntries.map(e => e.sourceExecutionId)).not.toContain('client-b-exec')
    expect(bEntries.map(e => e.sourceExecutionId)).not.toContain('client-a-exec')
  })

  it('writes files under <clientId>/<contractId>/, not <contractId>/ alone', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry()])
    const scopedPath = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1', 'ledger.jsonl')
    const unscopedPath = join(scratchHome, '.kairos', 'promise-ledger', 'c1', 'ledger.jsonl')
    await expect(stat(scopedPath)).resolves.toBeDefined()
    await expect(stat(unscopedPath)).rejects.toThrow()
  })

  // P0 measurement-integrity fix (2026-07-20): a single corrupted JSONL line must not discard
  // every valid entry in the same file -- the exact regression this fix targets.
  it('skips a single corrupted line and still returns every valid entry', async () => {
    await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: 'e1', sourceExecutionId: 'e1' })])
    const path = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1', 'ledger.jsonl')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(path, 'not valid json at all\n', 'utf-8')
    await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: 'e2', sourceExecutionId: 'e2' })])

    const entries = await getProofLedgerEntries(CLIENT_A, 'c1')
    expect(entries.map(e => e.sourceExecutionId)).toEqual(['e1', 'e2'])
  })

  // P0 measurement-integrity fix (2026-07-20): two concurrent pollers (e.g. a watch tick and a
  // manual `kairos ledger poll` overlapping) must not lose either one's entries to a race.
  it('concurrent appends from two racing callers both survive', async () => {
    await Promise.all([
      appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: 'race-a', sourceExecutionId: 'race-a' })]),
      appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: 'race-b', sourceExecutionId: 'race-b' })]),
    ])
    const entries = await getProofLedgerEntries(CLIENT_A, 'c1')
    expect(entries.map(e => e.sourceExecutionId).sort()).toEqual(['race-a', 'race-b'])
  })
})

function makeWatermark(overrides: Partial<ContractPollWatermark> = {}): ContractPollWatermark {
  return {
    contractId: 'empire-homecare-referral-intake',
    n8nWorkflowId: 'wf-1',
    lastProcessedExecutionId: 'exec-5',
    lastProcessedStartedAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T09:05:00.000Z',
    ...overrides,
  }
}

describe('saveContractPollWatermark / loadContractPollWatermark', () => {
  it('round-trips a watermark', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark())
    const loaded = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', 'wf-1')
    expect(loaded).toEqual(makeWatermark())
  })

  it('returns null, not a throw, when nothing was ever saved', async () => {
    expect(await loadContractPollWatermark(CLIENT_A, 'nobody', 'nothing')).toBeNull()
  })

  it('re-saving the same (contract, workflow) pair overwrites', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ lastProcessedExecutionId: 'exec-5' }))
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ lastProcessedExecutionId: 'exec-9' }))
    const loaded = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', 'wf-1')
    expect(loaded!.lastProcessedExecutionId).toBe('exec-9')
  })

  it('stores multiple workflows for the same contract independently, side by side', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ n8nWorkflowId: 'wf-intake', lastProcessedExecutionId: 'e-intake' }))
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ n8nWorkflowId: 'wf-escalation', lastProcessedExecutionId: 'e-escalation' }))

    const intake = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', 'wf-intake')
    const escalation = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', 'wf-escalation')
    expect(intake!.lastProcessedExecutionId).toBe('e-intake')
    expect(escalation!.lastProcessedExecutionId).toBe('e-escalation')
  })

  it('the watermarks file is chmod 600', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark())
    const path = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'empire-homecare-referral-intake', 'watermarks.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('a corrupted watermarks file is treated as empty, not a throw', async () => {
    const dir = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'watermarks.json'), '{not valid json', 'utf-8')
    expect(await loadContractPollWatermark(CLIENT_A, 'c1', 'wf-1')).toBeNull()
  })

  // Finding 1 fix (supplemental measurement-integrity audit, 2026-07-20): the same contractId
  // under two different clients must have fully independent watermarks -- otherwise client B's
  // poll progress could suppress evidence client A's own poll should have picked up, or vice
  // versa.
  it('SECURITY: two different clientIds with the SAME contractId have fully isolated watermarks', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ contractId: 'shared-contract-id', lastProcessedExecutionId: 'client-a-exec' }))
    await saveContractPollWatermark(CLIENT_B, makeWatermark({ contractId: 'shared-contract-id', lastProcessedExecutionId: 'client-b-exec' }))

    const a = await loadContractPollWatermark(CLIENT_A, 'shared-contract-id', 'wf-1')
    const b = await loadContractPollWatermark(CLIENT_B, 'shared-contract-id', 'wf-1')
    expect(a!.lastProcessedExecutionId).toBe('client-a-exec')
    expect(b!.lastProcessedExecutionId).toBe('client-b-exec')
  })

  // P0 measurement-integrity fix (2026-07-20): two concurrent pollers for different workflows on
  // the same contract must not lose either one's watermark update to a race.
  it('concurrent watermark saves for different workflows on the same contract both survive', async () => {
    await Promise.all([
      saveContractPollWatermark(CLIENT_A, makeWatermark({ n8nWorkflowId: 'wf-a', lastProcessedExecutionId: 'exec-a' })),
      saveContractPollWatermark(CLIENT_A, makeWatermark({ n8nWorkflowId: 'wf-b', lastProcessedExecutionId: 'exec-b' })),
    ])
    const a = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', 'wf-a')
    const b = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', 'wf-b')
    expect(a!.lastProcessedExecutionId).toBe('exec-a')
    expect(b!.lastProcessedExecutionId).toBe('exec-b')
  })
})
