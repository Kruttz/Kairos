/**
 * ExceptionDesk v0 (Phase 4, docs/plans/process-contract-promise-engine-plan.md §7). Types only
 * -- see src/promise/exception-desk.ts for the open/update logic and
 * src/promise/exception-store.ts for persistence.
 *
 * Codex's explicit guardrail, the single most important one for this whole module: "ExceptionDesk
 * v0 should have human resolution only -- no auto-resolution and no workflow edits." Detection
 * (opening/updating an item from a compliance finding) is automatic; every status change away
 * from 'open' is a human action, always -- there is no --auto mode here at all, a deliberately
 * stricter posture than even the reliability suite's own repair-apply ladder (which at least
 * earned a narrow gated --auto after proving itself over several phases).
 */

export type ExceptionKind = 'stuck' | 'missed_sla' | 'ambiguous_evidence' | 'expired'
export type ExceptionStatus = 'open' | 'acknowledged' | 'resolved'

export interface ExceptionStatusChange {
  ts: string
  from: ExceptionStatus | null
  to: ExceptionStatus
  /** 'auto' is reserved for the detection event that OPENS an item (from a compliance
   * 'drifting' finding) -- every other transition is 'human'. There is no third value; a
   * hypothetical future auto-resolution mode is explicitly out of scope for v0, not just
   * unimplemented. */
  actor: 'auto' | 'human'
  reason?: string
}

export interface ExceptionDeskItem {
  id: string
  contractId: string
  /** The hashed correlation key value -- ProofLedgerEntry.promiseInstanceId, never the raw
   * value. Codex's explicit requirement ("hashed correlation key") -- this module never touches
   * a raw correlation key at all, it only ever sees the already-hashed id compliance findings
   * carry. */
  promiseInstanceId: string
  kind: ExceptionKind
  status: ExceptionStatus

  /** From the contract's own OwnerAssignment for the relevant state -- never invented. Falls
   * back to an explicit "no owner declared" string rather than guessing, so a human reading this
   * knows the contract itself has a real gap, not that Kairos failed to look. */
  owner: string
  /** Advisory text only -- never auto-executed. Reuses the contract's own ExceptionRule.
   * suggestedAction when the contract declares exactly one (the common v0 case, e.g. Empire
   * Homecare); with more than one declared, no rule is picked over another by a guess -- a
   * neutral, finding-derived instruction is used instead (see exception-desk.ts). */
  nextAction: string
  /** Human-readable why this was opened -- the compliance finding's own summary, not
   * re-derived/reworded. */
  reason: string
  /** Ledger entry ids (or, for an absence-based finding, a plain description of what's missing)
   * cited as this item's supporting evidence -- traceable back to ProofLedger, never a raw
   * payload dump. */
  evidence: string[]

  slaId?: string
  expirationRuleId?: string
  transitionId?: string

  detectedAt: string
  updatedAt: string
  history: ExceptionStatusChange[]
}
