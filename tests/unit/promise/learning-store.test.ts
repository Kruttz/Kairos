import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadLearningNotes, upsertLearningNotes, updateLearningNoteStatus, SyntheticNotePromotionError } from '../../../src/promise/learning-store.js'
import type { LearningNote } from '../../../src/promise/learning-types.js'

function makeNote(overrides: Partial<LearningNote> = {}): LearningNote {
  return {
    id: 'test-client-test-contract-test-contract-v1-sla_threshold_hotspot-sla1',
    summary: 'SLA "sla1" drifted in 8 of 10 (80%) evaluated instance(s).',
    recommendedNextAction: 'Review the SLA threshold.',
    provenance: {
      contractId: 'test-contract',
      clientId: 'test-client',
      contractVersion: 1,
      proposalId: 'test-contract-v1-sla_threshold_hotspot-sla1',
      proposalCategory: 'sla_threshold_hotspot',
      decision: 'accepted',
      decisionReason: 'agreed, worth revisiting',
      evidence: [{ kind: 'ledger_entry', id: 'entry-1' }],
      synthetic: false,
    },
    status: 'candidate',
    createdAt: '2026-01-01T00:00:00.000Z',
    history: [],
    ...overrides,
  }
}

function makeSyntheticNote(overrides: Partial<LearningNote> = {}): LearningNote {
  return makeNote({
    id: 'test-client-test-contract-test-contract-v1-harness_mismatch-scenario-1',
    provenance: {
      contractId: 'test-contract',
      clientId: 'test-client',
      contractVersion: 1,
      proposalId: 'test-contract-v1-harness_mismatch-scenario-1',
      proposalCategory: 'harness_mismatch',
      decision: 'accepted',
      evidence: [{ kind: 'harness_scenario', id: 'scenario-1' }],
      synthetic: true,
    },
    ...overrides,
  })
}

let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-learning-store-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('loadLearningNotes', () => {
  it('returns an empty array, not a throw, when nothing was ever generated', async () => {
    expect(await loadLearningNotes('nobody')).toEqual([])
  })
})

describe('upsertLearningNotes', () => {
  it('saves fresh notes that did not exist before', async () => {
    const note = makeNote()
    const merged = await upsertLearningNotes('test-client', [note])
    expect(merged).toEqual([note])
    expect(await loadLearningNotes('test-client')).toEqual([note])
  })

  it('the saved file is chmod 600, at the CLIENT level (not nested under a contractId)', async () => {
    await upsertLearningNotes('test-client', [makeNote()])
    const path = join(scratchHome, '.kairos', 'promise-ledger', 'test-client', 'learning-notes.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('stores notes from multiple contracts under the SAME client together', async () => {
    const noteA = makeNote({ id: 'note-a', provenance: { ...makeNote().provenance, contractId: 'contract-a' } })
    const noteB = makeNote({ id: 'note-b', provenance: { ...makeNote().provenance, contractId: 'contract-b' } })
    const merged = await upsertLearningNotes('test-client', [noteA, noteB])
    expect(merged.map(n => n.provenance.contractId).sort()).toEqual(['contract-a', 'contract-b'])
  })

  it('refreshes summary/recommendedNextAction/provenance on re-derivation of the SAME id', async () => {
    const original = makeNote({ summary: 'old summary' })
    await upsertLearningNotes('test-client', [original])

    const refreshed = makeNote({ summary: 'new summary, source proposal was refreshed' })
    const merged = await upsertLearningNotes('test-client', [refreshed])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.summary).toBe('new summary, source proposal was refreshed')
  })

  it('the dedupe invariant: preserves an existing human status decision (promoted), never resets it back to candidate on re-derivation', async () => {
    const original = makeNote()
    await upsertLearningNotes('test-client', [original])
    await updateLearningNoteStatus('test-client', original.id, 'promoted', 'confirmed real pattern')

    const rederived = makeNote({ summary: 'refreshed summary' })
    const merged = await upsertLearningNotes('test-client', [rederived])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.status).toBe('promoted')
    expect(merged[0]!.history).toHaveLength(1)
    expect(merged[0]!.history[0]!.reason).toBe('confirmed real pattern')
    expect(merged[0]!.summary).toBe('refreshed summary') // still refreshed
  })

  it('preserves createdAt across re-derivation', async () => {
    const original = makeNote({ createdAt: '2026-01-01T00:00:00.000Z' })
    await upsertLearningNotes('test-client', [original])

    const rederived = makeNote({ createdAt: '2026-06-01T00:00:00.000Z' })
    const merged = await upsertLearningNotes('test-client', [rederived])
    expect(merged[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('leaves a previously-stored note untouched (not deleted) when it is not re-derived this run', async () => {
    const stale = makeNote({ id: 'a-note-whose-source-proposal-no-longer-appears' })
    await upsertLearningNotes('test-client', [stale])
    const merged = await upsertLearningNotes('test-client', []) // nothing derived this run
    expect(merged).toEqual([stale])
  })

  it('duplicate candidate notes are deduped: re-deriving the SAME proposal-backed note twice never produces two records', async () => {
    const note = makeNote()
    await upsertLearningNotes('test-client', [note])
    const merged = await upsertLearningNotes('test-client', [note])
    expect(merged).toHaveLength(1)
  })

  it('accumulates multiple distinct notes across separate runs', async () => {
    await upsertLearningNotes('test-client', [makeNote({ id: 'note-a' })])
    const merged = await upsertLearningNotes('test-client', [makeNote({ id: 'note-b' })])
    expect(merged.map(n => n.id).sort()).toEqual(['note-a', 'note-b'])
  })
})

describe('updateLearningNoteStatus -- promote/reject, audited and stored', () => {
  it('appends a real LearningNoteStatusChange to history and updates status on reject', async () => {
    const note = makeNote()
    await upsertLearningNotes('test-client', [note])

    const updated = await updateLearningNoteStatus('test-client', note.id, 'rejected', 'not a useful pattern')
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('rejected')
    expect(updated!.history).toHaveLength(1)
    expect(updated!.history[0]!.from).toBe('candidate')
    expect(updated!.history[0]!.to).toBe('rejected')
    expect(updated!.history[0]!.actor).toBe('human')
    expect(updated!.history[0]!.reason).toBe('not a useful pattern')

    const loaded = await loadLearningNotes('test-client')
    expect(loaded[0]!.status).toBe('rejected')
  })

  it('promotes a non-synthetic note successfully', async () => {
    const note = makeNote()
    await upsertLearningNotes('test-client', [note])
    const updated = await updateLearningNoteStatus('test-client', note.id, 'promoted')
    expect(updated!.status).toBe('promoted')
  })

  it('returns null, not a throw, when the note id does not exist', async () => {
    expect(await updateLearningNoteStatus('test-client', 'nonexistent-id', 'promoted')).toBeNull()
  })

  it('accumulates multiple status changes in history across separate calls', async () => {
    const note = makeNote()
    await upsertLearningNotes('test-client', [note])
    await updateLearningNoteStatus('test-client', note.id, 'rejected', 'first pass: not useful')
    const updated = await updateLearningNoteStatus('test-client', note.id, 'promoted', 'reconsidered, it is useful')
    expect(updated!.history).toHaveLength(2)
    expect(updated!.history[0]!.to).toBe('rejected')
    expect(updated!.history[1]!.to).toBe('promoted')
  })
})

describe('updateLearningNoteStatus -- synthetic-only evidence promotion guardrail', () => {
  it('throws SyntheticNotePromotionError when promoting a note whose provenance.synthetic is true', async () => {
    const note = makeSyntheticNote()
    await upsertLearningNotes('test-client', [note])

    await expect(updateLearningNoteStatus('test-client', note.id, 'promoted')).rejects.toThrow(SyntheticNotePromotionError)
  })

  it('a refused promotion writes nothing -- the note is unchanged on disk after the throw', async () => {
    const note = makeSyntheticNote()
    await upsertLearningNotes('test-client', [note])

    await expect(updateLearningNoteStatus('test-client', note.id, 'promoted')).rejects.toThrow()

    const loaded = await loadLearningNotes('test-client')
    expect(loaded[0]!.status).toBe('candidate')
    expect(loaded[0]!.history).toEqual([])
  })

  it('rejecting a synthetic note (not promoting) is NOT blocked -- the guardrail is specific to promotion only', async () => {
    const note = makeSyntheticNote()
    await upsertLearningNotes('test-client', [note])

    const updated = await updateLearningNoteStatus('test-client', note.id, 'rejected', 'synthetic-only, not real evidence')
    expect(updated!.status).toBe('rejected')
  })
})

describe('client isolation', () => {
  it('notes stored under one clientId never appear when loading a different clientId', async () => {
    await upsertLearningNotes('client-a', [makeNote({ id: 'note-a', provenance: { ...makeNote().provenance, clientId: 'client-a' } })])
    await upsertLearningNotes('client-b', [makeNote({ id: 'note-b', provenance: { ...makeNote().provenance, clientId: 'client-b' } })])

    const notesA = await loadLearningNotes('client-a')
    const notesB = await loadLearningNotes('client-b')
    expect(notesA.map(n => n.id)).toEqual(['note-a'])
    expect(notesB.map(n => n.id)).toEqual(['note-b'])
  })
})
