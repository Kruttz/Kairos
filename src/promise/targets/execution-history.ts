import { GuardError } from '../../errors/guard-error.js'
import type { ProcessContract } from '../types.js'
import type { TargetId, TargetDeploymentRef, NormalizedExecution } from './types.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4). Fetches a target's execution history and normalizes one raw execution into neutral
 * evidence -- the two halves of what pollWorkflowEvidence() (src/promise/ledger.ts) needed n8n's
 * own API shape for directly before this phase.
 */

export interface ExecutionHistorySource<TRawExecution = unknown> {
  readonly targetId: TargetId
  /** MUST return executions newest-first and MUST respect `limit` (return at most `limit`
   * items) -- callers (specifically pollWorkflowEvidence()'s watermark/possibleGap logic)
   * depend on both being true, not just usually true. */
  listExecutions(ref: TargetDeploymentRef, limit: number): Promise<Array<{ id: string; startedAt: string | null }>>
  fetchExecution(ref: TargetDeploymentRef, executionId: string): Promise<TRawExecution>
}

export interface EvidenceNormalizer<TRawExecution = unknown> {
  readonly targetId: TargetId
  /** Contract-aware -- needs contract.evidenceRequirements to resolve node names (or whatever a
   * given target's own marker convention is) into transitionIds BEFORE the neutral extractor
   * ever sees the data. Produces a NormalizedExecution only -- it does NOT construct a
   * ProofLedgerEntry.id; that responsibility belongs to the neutral extractor
   * (src/promise/evidence-extraction.ts), the only layer that both knows the target identity and
   * builds entry ids at all. */
  normalize(contract: ProcessContract, raw: TRawExecution): NormalizedExecution
}

/** Defense-in-depth beyond each individual adapter method's own ref.targetId guard: catches a
 * WIRING mistake -- e.g. an n8n history source accidentally paired with a non-n8n ref or
 * normalizer -- at one clear orchestration point, with a single error naming all three
 * component target ids, rather than three separate, less-diagnostic per-method throws. */
export function assertConsistentTargetIds(ref: TargetDeploymentRef, historySource: ExecutionHistorySource, normalizer: EvidenceNormalizer): void {
  if (ref.targetId !== historySource.targetId || ref.targetId !== normalizer.targetId) {
    throw new GuardError(`Target id mismatch: ref="${ref.targetId}", historySource="${historySource.targetId}", normalizer="${normalizer.targetId}" -- these must all agree.`)
  }
}
