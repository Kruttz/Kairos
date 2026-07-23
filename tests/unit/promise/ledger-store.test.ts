import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, writeFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  appendProofLedgerEntries,
  getProofLedgerEntries,
  loadContractPollWatermark,
  saveContractPollWatermark,
} from '../../../src/promise/ledger-store.js'
import type { ProofLedgerEntry, ContractPollWatermark } from '../../../src/promise/ledger-types.js'
import { targetRefKey } from '../../../src/promise/targets/types.js'

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

  // Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
  // §6.4, §9): ProofLedgerEntry.targetId is new and optional -- old entries written before this
  // phase never had this field on disk at all. No migration, no backfill: this proves the read
  // path handles a genuinely legacy-shaped line (targetId entirely absent, not merely undefined)
  // exactly as it always has, alongside a new-shaped entry that does carry it, in the same file.
  it('a legacy entry with no targetId field at all on disk remains readable, unchanged, alongside a new entry that has one', async () => {
    const legacyLine = JSON.stringify(makeEntry({ id: 'legacy-1', sourceExecutionId: 'legacy-1' })) + '\n'
    const dir = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ledger.jsonl'), legacyLine, 'utf-8')
    expect(legacyLine).not.toContain('targetId') // sanity check on the fixture itself

    await appendProofLedgerEntries(CLIENT_A, 'c1', [makeEntry({ id: 'new-1', sourceExecutionId: 'new-1', targetId: 'n8n' })])

    const entries = await getProofLedgerEntries(CLIENT_A, 'c1')
    expect(entries.map(e => e.id)).toEqual(['legacy-1', 'new-1'])
    expect(entries[0]!.targetId).toBeUndefined()
    expect(entries[1]!.targetId).toBe('n8n')
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
  const targetDeploymentId = overrides.targetDeploymentId ?? overrides.n8nWorkflowId ?? 'wf-1'
  return {
    contractId: 'empire-homecare-referral-intake',
    targetId: 'n8n',
    targetDeploymentId,
    n8nWorkflowId: targetDeploymentId,
    lastProcessedExecutionId: 'exec-5',
    lastProcessedStartedAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T09:05:00.000Z',
    ...overrides,
  }
}

const N8N_REF = { targetId: 'n8n', targetDeploymentId: 'wf-1' }

describe('saveContractPollWatermark / loadContractPollWatermark', () => {
  it('round-trips a watermark', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark())
    const loaded = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', N8N_REF)
    expect(loaded).toEqual(makeWatermark())
  })

  it('returns null, not a throw, when nothing was ever saved', async () => {
    expect(await loadContractPollWatermark(CLIENT_A, 'nobody', { targetId: 'n8n', targetDeploymentId: 'nothing' })).toBeNull()
  })

  it('re-saving the same (contract, workflow) pair overwrites', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ lastProcessedExecutionId: 'exec-5' }))
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ lastProcessedExecutionId: 'exec-9' }))
    const loaded = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', N8N_REF)
    expect(loaded!.lastProcessedExecutionId).toBe('exec-9')
  })

  it('stores multiple workflows for the same contract independently, side by side', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ targetDeploymentId: 'wf-intake', n8nWorkflowId: 'wf-intake', lastProcessedExecutionId: 'e-intake' }))
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ targetDeploymentId: 'wf-escalation', n8nWorkflowId: 'wf-escalation', lastProcessedExecutionId: 'e-escalation' }))

    const intake = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', { targetId: 'n8n', targetDeploymentId: 'wf-intake' })
    const escalation = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', { targetId: 'n8n', targetDeploymentId: 'wf-escalation' })
    expect(intake!.lastProcessedExecutionId).toBe('e-intake')
    expect(escalation!.lastProcessedExecutionId).toBe('e-escalation')
  })

  it('the watermarks file is chmod 600', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark())
    const path = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'empire-homecare-referral-intake', 'watermarks.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  // Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
  // §6.6, correction 12 from the fourth review round -- applied to watermarks the same way as
  // registrations): the write is temp-file-then-rename; no .tmp file lingers after a save.
  it('writes via temp-file-then-rename -- no .tmp file is left behind after a normal save', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark())
    const dir = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'empire-homecare-referral-intake')
    const entries = await readdir(dir)
    expect(entries).toEqual(['watermarks.json'])
    expect(entries.some(f => f.endsWith('.tmp'))).toBe(false)
  })

  it('a corrupted watermarks file is treated as empty, not a throw', async () => {
    const dir = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'watermarks.json'), '{not valid json', 'utf-8')
    expect(await loadContractPollWatermark(CLIENT_A, 'c1', N8N_REF)).toBeNull()
  })

  // Finding 1 fix (supplemental measurement-integrity audit, 2026-07-20): the same contractId
  // under two different clients must have fully independent watermarks -- otherwise client B's
  // poll progress could suppress evidence client A's own poll should have picked up, or vice
  // versa.
  it('SECURITY: two different clientIds with the SAME contractId have fully isolated watermarks', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ contractId: 'shared-contract-id', lastProcessedExecutionId: 'client-a-exec' }))
    await saveContractPollWatermark(CLIENT_B, makeWatermark({ contractId: 'shared-contract-id', lastProcessedExecutionId: 'client-b-exec' }))

    const a = await loadContractPollWatermark(CLIENT_A, 'shared-contract-id', N8N_REF)
    const b = await loadContractPollWatermark(CLIENT_B, 'shared-contract-id', N8N_REF)
    expect(a!.lastProcessedExecutionId).toBe('client-a-exec')
    expect(b!.lastProcessedExecutionId).toBe('client-b-exec')
  })

  // P0 measurement-integrity fix (2026-07-20): two concurrent pollers for different workflows on
  // the same contract must not lose either one's watermark update to a race.
  it('concurrent watermark saves for different workflows on the same contract both survive', async () => {
    await Promise.all([
      saveContractPollWatermark(CLIENT_A, makeWatermark({ targetDeploymentId: 'wf-a', n8nWorkflowId: 'wf-a', lastProcessedExecutionId: 'exec-a' })),
      saveContractPollWatermark(CLIENT_A, makeWatermark({ targetDeploymentId: 'wf-b', n8nWorkflowId: 'wf-b', lastProcessedExecutionId: 'exec-b' })),
    ])
    const a = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', { targetId: 'n8n', targetDeploymentId: 'wf-a' })
    const b = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', { targetId: 'n8n', targetDeploymentId: 'wf-b' })
    expect(a!.lastProcessedExecutionId).toBe('exec-a')
    expect(b!.lastProcessedExecutionId).toBe('exec-b')
  })
})

// Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
// §6.7) -- the four compatibility tests the accepted plan names explicitly, plus the collision
// test carried over from the plan's own §6.6/§6.7 discussion.
describe('watermark target-aware compatibility (Execution Substrate Boundary v0, Phase 1)', () => {
  it('1: a fixture legacy watermarks.json (bare keys only) loads correctly via the legacy-key branch', async () => {
    const dir = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'legacy-contract')
    await mkdir(dir, { recursive: true })
    const legacyRaw = {
      'wf-legacy': {
        contractId: 'legacy-contract',
        n8nWorkflowId: 'wf-legacy',
        lastProcessedExecutionId: 'exec-9',
        lastProcessedStartedAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:05:00.000Z',
      },
    }
    await writeFile(join(dir, 'watermarks.json'), JSON.stringify(legacyRaw, null, 2) + '\n', 'utf-8')

    const loaded = await loadContractPollWatermark(CLIENT_A, 'legacy-contract', { targetId: 'n8n', targetDeploymentId: 'wf-legacy' })
    expect(loaded).not.toBeNull()
    expect(loaded!.targetId).toBe('n8n')
    expect(loaded!.targetDeploymentId).toBe('wf-legacy')
    expect(loaded!.n8nWorkflowId).toBe('wf-legacy')
    expect(loaded!.lastProcessedExecutionId).toBe('exec-9')
  })

  it('2: a fresh save for an n8n target writes both keys; a subsequent load finds it via either path', async () => {
    await saveContractPollWatermark(CLIENT_A, makeWatermark({ targetDeploymentId: 'wf-dual', n8nWorkflowId: 'wf-dual', lastProcessedExecutionId: 'exec-dual' }))

    const path = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'empire-homecare-referral-intake', 'watermarks.json')
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
    // Both the exact legacy bare key AND the exact composite key are present -- asserted
    // independently. (A prior draft asserted this via
    // `Object.keys(raw).some(k => k.startsWith('n8n%3A') || k.includes('wf-dual'))`, an OR-any
    // check that could pass from the legacy 'wf-dual' key ALONE -- 'wf-dual'.includes('wf-dual')
    // is trivially true -- even if the composite-key write were completely broken or absent, so
    // it never actually proved the dual-write.)
    const compositeKey = targetRefKey({ targetId: 'n8n', targetDeploymentId: 'wf-dual' })
    expect(Object.keys(raw)).toContain('wf-dual')
    expect(Object.keys(raw)).toContain(compositeKey)

    const viaComposite = await loadContractPollWatermark(CLIENT_A, 'empire-homecare-referral-intake', { targetId: 'n8n', targetDeploymentId: 'wf-dual' })
    expect(viaComposite!.lastProcessedExecutionId).toBe('exec-dual')
  })

  it('3: two synthetic targets whose (targetId, targetDeploymentId) would collide under naive string concatenation produce two independently-loadable, non-colliding entries', async () => {
    // { targetId: 'foo', targetDeploymentId: 'bar:baz' } vs. { targetId: 'foo:bar', targetDeploymentId: 'baz' }
    // -- naive `${targetId}:${targetDeploymentId}` concatenation would produce the IDENTICAL
    // string "foo:bar:baz" for both. targetRefKey()'s encodeURIComponent-based escaping must
    // keep them distinct.
    await saveContractPollWatermark(CLIENT_A, {
      contractId: 'collision-contract',
      targetId: 'foo',
      targetDeploymentId: 'bar:baz',
      lastProcessedExecutionId: 'exec-a',
      lastProcessedStartedAt: '2026-07-20T09:00:00.000Z',
      updatedAt: '2026-07-20T09:00:00.000Z',
    })
    await saveContractPollWatermark(CLIENT_A, {
      contractId: 'collision-contract',
      targetId: 'foo:bar',
      targetDeploymentId: 'baz',
      lastProcessedExecutionId: 'exec-b',
      lastProcessedStartedAt: '2026-07-20T09:00:00.000Z',
      updatedAt: '2026-07-20T09:00:00.000Z',
    })

    const a = await loadContractPollWatermark(CLIENT_A, 'collision-contract', { targetId: 'foo', targetDeploymentId: 'bar:baz' })
    const b = await loadContractPollWatermark(CLIENT_A, 'collision-contract', { targetId: 'foo:bar', targetDeploymentId: 'baz' })
    expect(a!.lastProcessedExecutionId).toBe('exec-a')
    expect(b!.lastProcessedExecutionId).toBe('exec-b')
  })

  it('4: staleness -- when an old binary updates the legacy bare key with a NEWER updatedAt than the composite key, the newer one wins', async () => {
    const dir = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'stale-contract')
    await mkdir(dir, { recursive: true })
    // Built via targetRefKey() itself, not hand-spelled -- a prior draft hand-spelled this key as
    // 'n8n%3Awf-stale', which is WRONG: targetRefKey() only percent-encodes the two components
    // individually, never the literal ':' delimiter between them (confirmed directly against the
    // real implementation and by the 'escapes a literal ":"' test above, which expects
    // 'n8n:has%3Acolon', not 'n8n%3Ahas%3Acolon'). Because the wrong key was seeded, the real
    // composite-key lookup found nothing, `composite` was `undefined`, and the function silently
    // fell through to the legacy-bare-key-only branch -- meaning this test previously passed for
    // the WRONG reason: it never actually exercised the "both keys exist, compare updatedAt,
    // newer wins" branch its own name and comment claim to test at all.
    const compositeKey = targetRefKey({ targetId: 'n8n', targetDeploymentId: 'wf-stale' })
    // Simulate: a phase-aware binary already wrote both keys (stale, t1)...
    const seeded = {
      [compositeKey]: {
        contractId: 'stale-contract', targetId: 'n8n', targetDeploymentId: 'wf-stale', n8nWorkflowId: 'wf-stale',
        lastProcessedExecutionId: 'exec-old', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: '2026-07-20T09:00:00.000Z',
      },
      // ...then an OLD binary (unaware of composite keys) polled again and wrote ONLY the bare
      // key, with a genuinely newer updatedAt (t2 > t1).
      'wf-stale': {
        contractId: 'stale-contract', n8nWorkflowId: 'wf-stale',
        lastProcessedExecutionId: 'exec-new', lastProcessedStartedAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-20T10:00:00.000Z',
      },
    }
    await writeFile(join(dir, 'watermarks.json'), JSON.stringify(seeded, null, 2) + '\n', 'utf-8')

    // Sanity check that both keys really are present under the file this test actually wrote,
    // so a future refactor of targetRefKey() can't silently make this fixture wrong again
    // without a visible failure right here.
    const rawWritten = JSON.parse(await readFile(join(dir, 'watermarks.json'), 'utf-8')) as Record<string, unknown>
    expect(Object.keys(rawWritten)).toContain(compositeKey)
    expect(Object.keys(rawWritten)).toContain('wf-stale')

    const loaded = await loadContractPollWatermark(CLIENT_A, 'stale-contract', { targetId: 'n8n', targetDeploymentId: 'wf-stale' })
    // Must return the NEWER (bare-keyed) entry, not blindly prefer the composite key.
    expect(loaded!.lastProcessedExecutionId).toBe('exec-new')
  })
})
