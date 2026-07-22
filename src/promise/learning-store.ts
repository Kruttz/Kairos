import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '../utils/file-lock.js'
import type { LearningNote, LearningNoteStatus } from './learning-types.js'

/**
 * Self-Tuning Flywheel v0 persistence (roadmap item 15). Storage is scoped to the CLIENT, not
 * one contract -- unlike evolution-store.ts's own per-contract amendment-proposals.json, a
 * learning note is meant to accumulate across every contract a client has, since a pattern
 * learned from one contract's evidence is a client-level fact, not something meaningfully scoped
 * to just the one contract it happened to be first observed on. `~/.kairos/promise-ledger/
 * <clientId>/learning-notes.json` is the first client-level (not contract-level) file under this
 * directory -- deliberately a sibling of the existing per-contract subdirectories, never nested
 * inside one, confirmed empty/unused at this level before choosing the path. Never crosses a
 * client boundary: there is no code path anywhere in this file, or anywhere in this whole
 * module, that reads more than one clientId's directory in a single call -- guardrail: "no
 * cross-client/global learning."
 */

function clientLearningDir(clientId: string): string {
  return join(homedir(), '.kairos', 'promise-ledger', clientId)
}

function learningNotesPath(clientId: string): string {
  return join(clientLearningDir(clientId), 'learning-notes.json')
}

export async function loadLearningNotes(clientId: string): Promise<LearningNote[]> {
  try {
    const raw = await readFile(learningNotesPath(clientId), 'utf-8')
    return JSON.parse(raw) as LearningNote[]
  } catch {
    return []
  }
}

async function writeAll(clientId: string, notes: LearningNote[]): Promise<void> {
  const dir = clientLearningDir(clientId)
  await mkdir(dir, { recursive: true })
  const path = learningNotesPath(clientId)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(notes, null, 2) + '\n', 'utf-8')
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, path)
}

/**
 * Merges freshly-derived notes (from `deriveLearningNotesFromProposals()`, always
 * `status: 'candidate'`, fresh `createdAt`/empty `history`) into whatever's already stored,
 * keyed by the note's own deterministic id. For an id that already exists: `status`/`history`/
 * `createdAt` are PRESERVED -- a human's prior promote/reject decision on a note is never reset
 * back to 'candidate' just because `learn candidates` was re-run -- but `summary`/
 * `recommendedNextAction`/`provenance` are refreshed, so a note reflects the latest state of its
 * source proposal even while its own review status stays exactly what a human left it at.
 * Mirrors evolution-store.ts's own upsertContractAmendmentProposals() exactly, same reasoning --
 * this is the answer to "duplicate candidate notes are deduped or preserved intentionally": a
 * re-run refreshes the same note, it never appends a second one for the same proposal.
 */
export async function upsertLearningNotes(clientId: string, freshlyDerived: LearningNote[]): Promise<LearningNote[]> {
  const path = learningNotesPath(clientId)
  await mkdir(clientLearningDir(clientId), { recursive: true })
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const existing = await loadLearningNotes(clientId)
    const byId = new Map(existing.map(n => [n.id, n]))

    for (const fresh of freshlyDerived) {
      const prior = byId.get(fresh.id)
      if (prior) {
        byId.set(fresh.id, { ...fresh, status: prior.status, history: prior.history, createdAt: prior.createdAt })
      } else {
        byId.set(fresh.id, fresh)
      }
    }

    const merged = [...byId.values()]
    await writeAll(clientId, merged)
    return merged
  } finally {
    await releaseLock()
  }
}

export class SyntheticNotePromotionError extends Error {
  constructor(noteId: string) {
    super(`Learning note "${noteId}" is derived entirely from synthetic (harness-only) evidence and can never be promoted -- see its own provenance.synthetic field.`)
    this.name = 'SyntheticNotePromotionError'
  }
}

/** Returns null, not a throw, when no note with this id exists -- matches evolution-store.ts's
 * own updateProposalStatus() "not found" convention. Throws SyntheticNotePromotionError -- a
 * distinct, structural refusal, never silently ignored -- if `to === 'promoted'` and the note's
 * own provenance.synthetic is true, BEFORE any write happens. This is the one guardrail
 * enforcement point for the whole module: every caller (CLI included) goes through this
 * function, so there is no path to a promoted synthetic note anywhere in this codebase. */
export async function updateLearningNoteStatus(
  clientId: string,
  noteId: string,
  to: LearningNoteStatus,
  reason?: string,
): Promise<LearningNote | null> {
  const path = learningNotesPath(clientId)
  await mkdir(clientLearningDir(clientId), { recursive: true })
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const existing = await loadLearningNotes(clientId)
    const index = existing.findIndex(n => n.id === noteId)
    if (index === -1) return null

    const current = existing[index]!
    if (to === 'promoted' && current.provenance.synthetic) {
      throw new SyntheticNotePromotionError(noteId)
    }

    const updated: LearningNote = {
      ...current,
      status: to,
      history: [...current.history, { ts: new Date().toISOString(), from: current.status, to, actor: 'human', ...(reason ? { reason } : {}) }],
    }
    existing[index] = updated
    await writeAll(clientId, existing)
    return updated
  } finally {
    await releaseLock()
  }
}
