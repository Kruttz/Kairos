import type { AmendmentCategory, AmendmentEvidenceRef } from './evolution-types.js'

/**
 * Self-Tuning Flywheel v0 (roadmap item 15, docs/plans/contract-evolution-ops-roadmap-plan.md §3,
 * item 15). Types only -- see learning.ts for pure derivation logic and learning-store.ts for
 * persistence.
 *
 * Core idea (Codex's own framing, adopted verbatim): Item 11 produces ContractAmendmentProposals;
 * a human accepts or rejects each one (Item 11's own audit trail). Item 15 records THAT DECISION
 * as a LearningNote -- evidence a real human judged a real detected pattern, either way. A human
 * may later explicitly "promote" a note, but promotion only ever flips this note's own local
 * status -- it never mutates a prompt, a validator rule, a contract, or a workflow. There is no
 * code path anywhere in this module that writes to any file outside its own learning-notes.json.
 */

export type LearningNoteDecision = 'accepted' | 'rejected'

/** A note's own review status -- deliberately a different axis from the source proposal's
 * `decision` below. `decision` records what a human did to the CONTRACT proposal (accept/reject
 * that specific amendment); `status` records what a human has done to THIS NOTE as a candidate
 * unit of learning -- is this pattern itself worth remembering/promoting, independent of whether
 * the underlying proposal was accepted or rejected. A rejected proposal can still be a real,
 * promotable learning (e.g. "this hotspot fires often but the fix isn't a contract change"). */
export type LearningNoteStatus = 'candidate' | 'promoted' | 'rejected'

export interface LearningNoteStatusChange {
  ts: string
  from: LearningNoteStatus | null
  to: LearningNoteStatus
  /** Every transition is a human action, mirroring evolution-types.ts's own
   * ProposalStatusChange -- there is no 'auto' actor anywhere in this type. Promotion is never
   * automatic. */
  actor: 'human'
  reason?: string
}

export interface LearningNoteProvenance {
  contractId: string
  clientId: string
  contractVersion: number
  proposalId: string
  proposalCategory: AmendmentCategory
  /** What the human did to the SOURCE proposal (Item 11's own audit trail) -- copied at
   * derivation time, refreshed on every re-run in case the human's decision on the underlying
   * proposal has since changed (see learning.ts). */
  decision: LearningNoteDecision
  decisionReason?: string
  /** Copied verbatim from the source proposal at derivation time -- never re-derived. */
  evidence: AmendmentEvidenceRef[]
  /** Structural, computed -- true iff EVERY evidence ref above has kind 'harness_scenario' (the
   * only kind evolution.ts's own harness_mismatch category ever produces), OR there is no
   * evidence at all (fail-closed: an evidence-less note should never be promotable either, even
   * though evolution.ts's own invariant means this case shouldn't occur in practice). This is
   * the guardrail value: never a human-settable field, always recomputed from the real evidence
   * kinds, so it cannot be promoted around by mistake or by a human mislabeling something. */
  synthetic: boolean
}

export interface LearningNote {
  /** Deterministic: derived from (clientId, contractId, proposalId) only -- NOT the decision, so
   * if a human's decision on the underlying proposal later changes (proposed -> accepted ->
   * rejected is possible today via evolve accept/reject, with no guard against re-issuing a
   * different status), re-running `learn candidates` refreshes this SAME note's provenance
   * rather than creating a second note for the same proposal (learning-store.ts's own upsert,
   * mirroring evolution-store.ts's exact reasoning). */
  id: string
  /** Copied verbatim from the source proposal's own summary/recommendedNextAction -- never
   * regenerated or paraphrased, so a note never says anything the original evidence-graded
   * proposal didn't already say. */
  summary: string
  recommendedNextAction: string
  provenance: LearningNoteProvenance
  status: LearningNoteStatus
  createdAt: string
  history: LearningNoteStatusChange[]
}
