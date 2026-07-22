/**
 * Contract Amendment/Diff (roadmap item 12, docs/plans/contract-evolution-ops-roadmap-plan.md
 * §3, item 12). Types only -- see src/promise/diff.ts for the pure comparison logic.
 */

export type ContractDiffChangeType = 'added' | 'removed' | 'modified'

export interface ContractDiffChange {
  /** A field-path into ProcessContract, e.g. "sla[sla-contact-attempt].duration.amount" or
   * "states[missing_info]" (whole-entry added/removed, no sub-path). Human-readable, not a
   * formal JSON Pointer -- this codebase has no other JSON-diff consumer to standardize
   * against yet. */
  path: string
  changeType: ContractDiffChangeType
  from?: unknown
  to?: unknown
  /** True when this change could cause EXISTING ProofLedgerEntry/ExceptionDeskItem records
   * (recorded under the OLD version) to be misinterpreted against the NEW contract shape -- see
   * diff.ts's own doc comment for the exact principle and the full field-by-field classification
   * table. False for everything else (new ids added, description/text/owner edits, numeric
   * duration/amount changes on an otherwise-unchanged SLA/expiration rule). */
  breaking: boolean
  /** One-line plain-language reason breaking is true/false for this specific change -- always
   * present so a human reviewing `kairos contract diff`/`kairos contract amend` never has to
   * infer the classification's own logic themselves. */
  reason: string
}

export interface ContractDiff {
  contractId: string
  fromVersion: number
  toVersion: number
  changes: ContractDiffChange[]
  hasBreakingChanges: boolean
}
