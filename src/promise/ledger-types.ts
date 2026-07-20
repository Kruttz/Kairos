/**
 * ProofLedger v0 (Phase 3, docs/plans/process-contract-promise-engine-plan.md §6). Types only --
 * see src/promise/ledger.ts for the extraction/poll logic and src/promise/ledger-store.ts for
 * persistence.
 *
 * Built only after the Phase 3 design-verification spike (§6.0) wrote down its decision:
 * polling/extraction from n8n execution data, no new hosted service or listener. This module
 * implements that decision, plus the two prerequisites Codex named explicitly before
 * authorizing implementation: an evidence-node naming convention (src/promise/compile.ts's
 * `evidenceNodeName()`) and a multi-execution poll watermark (`ContractPollWatermark` below).
 */

/** Direct, explicit descendant of the reliability suite's DriftCheckStatus 4-state discipline
 * (plan doc §3.2/§6.1) -- the single most load-bearing naming choice in this whole arc, since it
 * is the mechanism that prevents ProofLedger from ever overclaiming "kept" when the evidence
 * doesn't support it. v0's poller (ledger.ts) only ever produces 'observed' or 'unverifiable' --
 * 'asserted' (a human/LLM judgment with no structural confirmation) and 'verified' (independent
 * corroboration by a second signal) are reserved for a later phase; automated extraction from a
 * single execution's own structural data is squarely 'observed' when complete, 'unverifiable'
 * when not, never stronger than that. */
export type ProofStatus = 'observed' | 'asserted' | 'verified' | 'unverifiable'

export interface ProofLedgerEntry {
  id: string
  contractId: string
  contractVersion: number
  /** One per real-world entity instance. v0 uses the hashed correlation key value directly as
   * this id -- correlationKey's entire job is already "how one instance is told apart from
   * another" (src/promise/types.ts), so a separate id-assignment/sequence mechanism would be
   * redundant, not more correct. */
  promiseInstanceId: string
  /** SHA-256 of the real correlation key value, reusing src/utils/workflow-hash.ts's existing
   * createHash('sha256') pattern rather than a new hashing mechanism. The raw value is never
   * persisted -- only ever held in memory during a single extraction. */
  correlationKeyValueHash: string

  /** 'evidence' -- extracted from an EvidenceRequirement's marker node (Phase 3). 'instance_start'
   * -- added in Phase 4: the first time a correlation key is seen on a workflow whose
   * ContractWorkflowTrace names a StartCondition, recorded automatically (no marker node needed
   * -- an intake workflow's own trigger already fires exactly once per new instance by
   * construction, confirmed in Phase 2's real checkpoint). Solves a real gap Phase 4's compliance
   * checker found while being built, not predicted in advance: without SOME evidence of when an
   * instance entered its StartCondition.initialState, an SlaSpec measured from that state (e.g.
   * Empire Homecare's own primary 4-business-hour SLA) has no clock-start signal to evaluate
   * against at all. A plain 'event' kind (an earlier design-doc sketch, §6.2) is deliberately not
   * used for this -- 'instance_start' names the specific, narrow thing it actually represents. */
  kind: 'evidence' | 'instance_start'
  /** Which EvidenceRequirement.transitionId this entry was extracted for -- present only for
   * kind: 'evidence'. */
  transitionId?: string
  /** Which ProcessState.id (a StartCondition.initialState) this instance began in -- present
   * only for kind: 'instance_start'. */
  initialState?: string

  /** When Kairos itself recorded this entry -- its own clock, always present. */
  observedAt: string

  /** Which compiled n8n workflow this entry came from. */
  sourceWorkflowId: string
  /** Binds to n8n's own execution id, the same identity ExecutionTrace.executionId already uses
   * -- a ProofLedger entry and a drift-check trace for the same real execution can be
   * cross-referenced without a second id scheme. */
  sourceExecutionId: string

  status: ProofStatus
  /** Human-readable, whitelist-safe summary built ONLY from the contract's own
   * EvidenceRequirement.requiredFields for this transition -- structurally incapable of
   * containing anything the contract didn't explicitly whitelist ("can't leak because it can't
   * exist in the type", the same discipline Phase 5's WhitelistedPattern already proved). */
  detail: string
}

/** Prerequisite 2 (Codex, 2026-07-20): "ProofLedger cannot only read latest execution... it
 * needs 'last processed execution id/time' per workflow/contract so evidence is not missed or
 * double-counted." One watermark per (contractId, n8nWorkflowId) pair -- a contract can compile
 * to more than one workflow (src/promise/compile.ts), and each is polled independently. */
export interface ContractPollWatermark {
  contractId: string
  n8nWorkflowId: string
  /** Comparison key. n8n execution ids were confirmed numeric/increasing in the Phase 3 spike's
   * real data, but that format isn't part of n8n's documented public contract -- startedAt (ISO
   * 8601, always present, safely string-comparable) is the actual ordering signal this module
   * relies on. lastProcessedExecutionId is kept alongside it only as an exact-duplicate
   * tie-breaker for the rare case of two executions sharing one startedAt timestamp. */
  lastProcessedExecutionId: string
  lastProcessedStartedAt: string
  updatedAt: string
}

/** Per-execution outcome, returned to the caller (CLI/report) but never itself written to the
 * ledger -- Codex's explicit requirement: "CLI/report should clearly say what was extracted,
 * skipped, or unverifiable." 'skipped' is the normal case (most executions of a multi-transition
 * workflow don't touch every transition) and is deliberately never persisted as a ledger entry --
 * only 'extracted'/'unverifiable' outcomes produce a real ProofLedgerEntry. */
export interface PollExecutionOutcome {
  executionId: string
  startedAt: string
  outcome: 'extracted' | 'skipped' | 'unverifiable'
  /** Present when outcome is 'extracted' or 'unverifiable' -- absent for 'skipped' (nothing
   * matched any EvidenceRequirement in this execution at all). */
  transitionId?: string
  detail: string
}

export interface PollContractResult {
  contractId: string
  n8nWorkflowId: string
  executionsChecked: number
  entries: ProofLedgerEntry[]
  outcomes: PollExecutionOutcome[]
  newWatermark: ContractPollWatermark
  /** True only when every execution this poll fetched was new relative to the prior watermark --
   * meaning the fetch limit may have been smaller than the real gap since the last poll, and
   * some evidence between polls could have been silently missed. Never set to false just because
   * nothing looked wrong; this is an honest "the page was fully new" signal, not a confidence
   * claim. Always false on a contract's first-ever poll (nothing to have missed yet). */
  possibleGap: boolean
}

/** The two n8n API methods ledger.ts actually calls, typed narrowly rather than as the full
 * N8nApiClient -- mirrors every other injectable-for-tests interface in this arc (plan.ts's
 * AnthropicMessagesClient, apply.ts's runReplayFn) so tests can supply a mock without needing to
 * satisfy N8nApiClient's much larger real surface. */
export interface PollableN8nClient {
  getExecutions(workflowId: string, filter?: { limit?: number }): Promise<Array<{ id: string; startedAt: string | null }>>
  getExecution(id: string, options?: { includeData?: boolean }): Promise<{ id: string; startedAt: string | null; data?: unknown }>
}
