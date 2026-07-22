import type { ContractAmendmentProposal } from './evolution-types.js'
import type { LearningNote, LearningNoteDecision } from './learning-types.js'

/**
 * Self-Tuning Flywheel v0 (roadmap item 15). Pure, deterministic, no I/O --
 * `deriveLearningNotesFromProposals()` is the only export the rest of this item depends on.
 *
 * v0 scope (Codex's own framing): "focus on accepted/rejected Contract Evolution proposals
 * first." Only a proposal with a real human decision produces a note -- status 'proposed'
 * (nobody has looked at it yet) produces nothing, matching this whole arc's own "never treat an
 * undecided signal as settled" discipline. `applied` counts as `decision: 'accepted'` -- it IS
 * an accepted proposal, just one that has additionally gone all the way through Item 12's own
 * amend gate; a note derived from it is at least as strong a learning signal as a merely
 * `accepted` one, never weaker.
 *
 * The one deliberate scope decision made here, not in the roadmap's own most literal wording:
 * this v0 builds notes ONLY from Contract Evolution proposal decisions, not directly from raw
 * repeated ProofLedger/ExceptionDesk/Promise Report patterns (Codex's own scope named that as
 * optional -- "if already easy to read"). Every one of those evidence sources already flows INTO
 * a Contract Evolution proposal today (evolution.ts's own detectSlaAndExpirationHotspots/
 * detectUnreachedStates/detectUnusedTransitions/detectHighMissRate) -- a second, parallel
 * extraction straight from raw evidence would either duplicate that logic or risk producing a
 * "learning" the corresponding proposal doesn't already reflect, undermining the "Item 11
 * produces proposals, Item 15 records decisions about them" framing Codex gave as the core idea.
 * Deferred, not rejected -- worth reconsidering only once real proposal-decision notes are in
 * use and a genuine gap is felt.
 */

function deriveDecision(status: ContractAmendmentProposal['status']): LearningNoteDecision | null {
  if (status === 'accepted' || status === 'applied') return 'accepted'
  if (status === 'rejected') return 'rejected'
  return null // 'proposed' -- no human decision yet, no note
}

function noteId(clientId: string, contractId: string, proposalId: string): string {
  return `${clientId}-${contractId}-${proposalId}`
}

export function deriveLearningNotesFromProposals(proposals: ContractAmendmentProposal[], now: Date = new Date()): LearningNote[] {
  const notes: LearningNote[] = []
  for (const p of proposals) {
    const decision = deriveDecision(p.status)
    if (!decision) continue

    // Current `status` is always kept in sync with the most recent history append
    // (evolution-store.ts's own updateProposalStatus() sets both in the same write), so the
    // last history entry is always the one that produced this decision.
    const lastChange = p.history[p.history.length - 1]
    const synthetic = p.evidence.length === 0 || p.evidence.every(e => e.kind === 'harness_scenario')

    notes.push({
      id: noteId(p.clientId, p.contractId, p.id),
      summary: p.summary,
      recommendedNextAction: p.recommendedNextAction,
      provenance: {
        contractId: p.contractId,
        clientId: p.clientId,
        contractVersion: p.contractVersion,
        proposalId: p.id,
        proposalCategory: p.category,
        decision,
        ...(lastChange?.reason ? { decisionReason: lastChange.reason } : {}),
        evidence: p.evidence,
        synthetic,
      },
      status: 'candidate',
      createdAt: now.toISOString(),
      history: [],
    })
  }
  return notes
}
