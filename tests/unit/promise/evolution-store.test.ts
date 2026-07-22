import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadContractAmendmentProposals, upsertContractAmendmentProposals, updateProposalStatus } from '../../../src/promise/evolution-store.js'
import type { ContractAmendmentProposal } from '../../../src/promise/evolution-types.js'

function makeProposal(overrides: Partial<ContractAmendmentProposal> = {}): ContractAmendmentProposal {
  return {
    id: 'test-contract-v1-sla_threshold_hotspot-sla1',
    contractId: 'test-contract',
    clientId: 'test-client',
    contractVersion: 1,
    category: 'sla_threshold_hotspot',
    summary: 'SLA "sla1" drifted in 8 of 10 (80%) evaluated instance(s).',
    affectedElementId: 'sla1',
    evidence: [{ kind: 'ledger_entry', id: 'entry-1' }],
    occurrenceCount: 8,
    sampleSize: 10,
    confidence: 'high',
    recommendedNextAction: 'Review the SLA threshold.',
    status: 'proposed',
    createdAt: '2026-01-01T00:00:00.000Z',
    history: [],
    ...overrides,
  }
}

let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-evolution-store-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('loadContractAmendmentProposals', () => {
  it('returns an empty array, not a throw, when nothing was ever generated', async () => {
    expect(await loadContractAmendmentProposals('nobody', 'nothing')).toEqual([])
  })
})

describe('upsertContractAmendmentProposals', () => {
  it('saves fresh proposals that did not exist before', async () => {
    const proposal = makeProposal()
    const merged = await upsertContractAmendmentProposals('test-client', 'test-contract', [proposal])
    expect(merged).toEqual([proposal])
    const loaded = await loadContractAmendmentProposals('test-client', 'test-contract')
    expect(loaded).toEqual([proposal])
  })

  it('the saved file is chmod 600', async () => {
    await upsertContractAmendmentProposals('test-client', 'test-contract', [makeProposal()])
    const path = join(scratchHome, '.kairos', 'promise-ledger', 'test-client', 'test-contract', 'amendment-proposals.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('refreshes detection-derived fields (summary/occurrenceCount/sampleSize/confidence/evidence) on re-detection of the SAME id', async () => {
    const original = makeProposal({ occurrenceCount: 8, sampleSize: 10, confidence: 'high' })
    await upsertContractAmendmentProposals('test-client', 'test-contract', [original])

    const refreshed = makeProposal({ occurrenceCount: 9, sampleSize: 12, confidence: 'high', summary: 'SLA "sla1" drifted in 9 of 12 (75%) evaluated instance(s).' })
    const merged = await upsertContractAmendmentProposals('test-client', 'test-contract', [refreshed])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.occurrenceCount).toBe(9)
    expect(merged[0]!.sampleSize).toBe(12)
  })

  it('the single most important invariant: preserves an existing human status decision, never resets it back to \'proposed\' on re-detection', async () => {
    const original = makeProposal()
    await upsertContractAmendmentProposals('test-client', 'test-contract', [original])
    await updateProposalStatus('test-client', 'test-contract', original.id, 'accepted', 'yep, this is real')

    // The same hotspot gets detected again (e.g. a second `kairos contract evolve run`) --
    // status must stay 'accepted', history must stay intact, even though detection-derived
    // fields refresh.
    const reDetected = makeProposal({ occurrenceCount: 9, sampleSize: 11 })
    const merged = await upsertContractAmendmentProposals('test-client', 'test-contract', [reDetected])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.status).toBe('accepted')
    expect(merged[0]!.history).toHaveLength(1)
    expect(merged[0]!.history[0]!.reason).toBe('yep, this is real')
    expect(merged[0]!.occurrenceCount).toBe(9) // still refreshed
  })

  it('preserves createdAt and appliedToVersion across re-detection', async () => {
    const original = makeProposal({ createdAt: '2026-01-01T00:00:00.000Z' })
    await upsertContractAmendmentProposals('test-client', 'test-contract', [original])
    await updateProposalStatus('test-client', 'test-contract', original.id, 'applied', undefined, 2)

    const reDetected = makeProposal({ createdAt: '2026-06-01T00:00:00.000Z' })
    const merged = await upsertContractAmendmentProposals('test-client', 'test-contract', [reDetected])
    expect(merged[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(merged[0]!.appliedToVersion).toBe(2)
  })

  it('leaves a previously-stored proposal untouched (not deleted) when it is not re-detected this run', async () => {
    const stale = makeProposal({ id: 'a-hotspot-that-went-away' })
    await upsertContractAmendmentProposals('test-client', 'test-contract', [stale])
    const merged = await upsertContractAmendmentProposals('test-client', 'test-contract', []) // nothing detected this run
    expect(merged).toEqual([stale])
  })

  it('accumulates multiple distinct proposals across separate runs', async () => {
    await upsertContractAmendmentProposals('test-client', 'test-contract', [makeProposal({ id: 'proposal-a' })])
    const merged = await upsertContractAmendmentProposals('test-client', 'test-contract', [makeProposal({ id: 'proposal-b' })])
    expect(merged.map(p => p.id).sort()).toEqual(['proposal-a', 'proposal-b'])
  })
})

describe('updateProposalStatus -- the reject path, audited and stored', () => {
  it('appends a real ProposalStatusChange to history and updates status', async () => {
    const proposal = makeProposal()
    await upsertContractAmendmentProposals('test-client', 'test-contract', [proposal])

    const updated = await updateProposalStatus('test-client', 'test-contract', proposal.id, 'rejected', 'staff say this is intentional')
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('rejected')
    expect(updated!.history).toHaveLength(1)
    expect(updated!.history[0]!.from).toBe('proposed')
    expect(updated!.history[0]!.to).toBe('rejected')
    expect(updated!.history[0]!.actor).toBe('human')
    expect(updated!.history[0]!.reason).toBe('staff say this is intentional')

    const loaded = await loadContractAmendmentProposals('test-client', 'test-contract')
    expect(loaded[0]!.status).toBe('rejected')
    expect(loaded[0]!.history).toHaveLength(1)
  })

  it('returns null, not a throw, when the proposal id does not exist', async () => {
    const result = await updateProposalStatus('test-client', 'test-contract', 'nonexistent-id', 'rejected')
    expect(result).toBeNull()
  })

  it('accumulates multiple status changes in history across separate calls', async () => {
    const proposal = makeProposal()
    await upsertContractAmendmentProposals('test-client', 'test-contract', [proposal])
    await updateProposalStatus('test-client', 'test-contract', proposal.id, 'accepted', 'looks real')
    const updated = await updateProposalStatus('test-client', 'test-contract', proposal.id, 'applied', undefined, 2)
    expect(updated!.history).toHaveLength(2)
    expect(updated!.history[0]!.to).toBe('accepted')
    expect(updated!.history[1]!.to).toBe('applied')
    expect(updated!.appliedToVersion).toBe(2)
  })
})
