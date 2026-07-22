/**
 * Contract Evolution v0 (roadmap item 11, docs/plans/contract-evolution-ops-roadmap-plan.md §3,
 * item 11). Types only -- see src/promise/evolution.ts for the pure detection logic and
 * src/promise/evolution-store.ts for persistence.
 *
 * Treats ProcessContract as a hypothesis, not permanent truth (Codex's own framing, adopted
 * verbatim): this module never changes a contract. It only ever produces
 * `ContractAmendmentProposal`s -- evidence-linked suggestions a human reviews. Accepting a
 * proposal does not apply anything either; it only marks intent. The actual change always flows
 * through Item 12's `kairos contract amend` (diff -> validate -> confirm -> archive), via
 * `--from-proposal`, which is the only thing in this codebase allowed to write a new contract
 * version. `applied` (below) is set only once that has genuinely happened.
 */

export type AmendmentCategory =
  | 'sla_threshold_hotspot'    // an SlaSpec drifts far more often than a simple, documented threshold
  | 'expiration_rule_hotspot'  // an ExpirationRule fires (produces an 'expired' exception) far more often than the threshold
  | 'unreached_state'          // a non-start ProcessState with zero observed evidence ever reaching it
  | 'unused_transition'        // an evidence-backed ProcessTransition never observed in the evidence at all
  | 'high_miss_rate'           // a whole-contract signal: a high proportion of instances classified 'missed' (Promise Report outcomes)
  | 'harness_mismatch'         // a generated scenario's expected outcome doesn't match Kairos's own evaluation -- synthetic-only, always low confidence

export type AmendmentEvidenceRefKind = 'ledger_entry' | 'exception_item' | 'harness_scenario'

export interface AmendmentEvidenceRef {
  kind: AmendmentEvidenceRefKind
  id: string
}

export type ProposalStatus = 'proposed' | 'accepted' | 'rejected' | 'applied'

export interface ProposalStatusChange {
  ts: string
  from: ProposalStatus | null
  to: ProposalStatus
  /** Every transition here is a human action -- there is no 'auto' actor anywhere in this type,
   * a deliberately stricter posture than even ExceptionDesk's own history (which at least lets
   * 'auto' OPEN an item). A proposal is never auto-accepted/auto-rejected/auto-applied at any
   * confidence level. */
  actor: 'human'
  reason?: string
}

export interface ContractAmendmentProposal {
  id: string
  contractId: string
  clientId: string
  /** The version this was computed against -- entries/exceptions used to generate it were
   * filtered to exactly this version (see evolution.ts's own doc comment for why). If the live
   * contract's own version has since moved on, this proposal is stale -- computed live by the
   * store/CLI layer when listing, never persisted as a boolean that could silently go wrong. */
  contractVersion: number
  category: AmendmentCategory
  /** Plain-language rationale -- e.g. "SLA 'sla-contact-attempt' drifted in 8 of 10 (80%)
   * evaluated instances this window, well above the 30% threshold." Always cites the real
   * numbers, never just an adjective. */
  summary: string
  /** The SlaSpec/ExpirationRule/ProcessState/ProcessTransition id this concerns, or the
   * contract's own id for a whole-contract category (high_miss_rate), or a scenario id for
   * harness_mismatch. */
  affectedElementId: string
  /** Never empty -- a proposal with no evidence refs is a bug, not a valid proposal (enforced by
   * evolution.ts itself, not just documented here). */
  evidence: AmendmentEvidenceRef[]
  occurrenceCount: number
  /** Total real evaluations/instances the occurrenceCount was measured against -- always shown
   * alongside the count, never a bare percentage on its own. */
  sampleSize: number
  /** Evidence-graded by sample size + how far above threshold the rate is -- never "AI
   * judgment." harness_mismatch proposals are always 'low', unconditionally (see evolution.ts). */
  confidence: 'low' | 'medium' | 'high'
  /** A general, plain-language suggestion of what to look at -- e.g. "Review whether
   * sla-contact-attempt's 4-hour deadline is realistic, or whether staffing during this window
   * needs to change." NEVER a specific replacement value (e.g. never "change 4 hours to 2 hours")
   * -- that would require value inference from unstructured data this v0 deliberately does not
   * attempt (see evolution.ts's own doc comment). */
  recommendedNextAction: string
  status: ProposalStatus
  createdAt: string
  history: ProposalStatusChange[]
  /** Present only once status reaches 'applied' -- which real contract version resulted from
   * `kairos contract amend --from-proposal`, so this record traces all the way through to a
   * real amendment, not just an intent. */
  appliedToVersion?: number
}
