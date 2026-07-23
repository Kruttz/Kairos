import { normalizeN8nExecution } from '../providers/n8n/evidence.js'
import type { RawExecutionDetail } from '../providers/n8n/execution-history.js'
import { assertConsistentTargetIds } from './targets/execution-history.js'
import type { ExecutionHistorySource, EvidenceNormalizer } from './targets/execution-history.js'
import type { TargetDeploymentRef } from './targets/types.js'
import { extractNormalizedEvidence, hashCorrelationKeyValue } from './evidence-extraction.js'
import type { ProcessContract, StartCondition } from './types.js'
import type {
  ProofLedgerEntry,
  ContractPollWatermark,
  PollExecutionOutcome,
  PollContractResult,
} from './ledger-types.js'

/**
 * ProofLedger v0 poll orchestration (Phase 3, docs/plans/process-contract-promise-engine-plan.md
 * §6, decided by the §6.0 design-verification spike). Deterministic extraction, no LLM call.
 *
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4): pollWorkflowEvidence() itself is now target-neutral -- it takes an
 * ExecutionHistorySource/EvidenceNormalizer pair and a TargetDeploymentRef rather than an
 * n8n-specific PollableN8nClient and a bare n8nWorkflowId string. The actual extraction decision
 * logic (what counts as observed/unverifiable/skipped, correlation-key resolution, multi-item
 * handling) moved verbatim to the target-neutral src/promise/evidence-extraction.ts;
 * node-name/runData parsing moved to src/providers/n8n/evidence.ts's normalizeN8nExecution().
 *
 * `extractExecutionEvidence()` and `hashCorrelationKeyValue()` remain exported from this exact
 * file, under these exact names, as backward-compatible facades -- src/reliability/replay/
 * contract-outcome.ts and src/reliability/chaos/contract-outcome.ts (both explicitly out of
 * scope for this whole arc, per the plan's own non-goals) call extractExecutionEvidence()
 * directly with n8n-shaped RawExecutionDetail data from live sandbox executions, and
 * src/promise/harness.ts calls hashCorrelationKeyValue() directly. Both facades delegate
 * entirely to the new neutral machinery underneath; neither is a second, diverging
 * implementation.
 */

export { hashCorrelationKeyValue }
export type { RawExecutionDetail }

/**
 * Backward-compatible facade over the new neutral extraction path, preserving its exact
 * pre-boundary signature and behavior for every existing caller that cannot be touched this
 * phase (src/reliability/replay/contract-outcome.ts, src/reliability/chaos/contract-outcome.ts)
 * plus this module's own pre-existing test suite. Internally: normalizeN8nExecution() (n8n's own
 * runData parsing and evidenceNodeName() resolution) followed by extractNormalizedEvidence()
 * (target-neutral extraction, entry-id construction via buildEntryId()).
 */
export function extractExecutionEvidence(
  contract: ProcessContract,
  execution: RawExecutionDetail,
  n8nWorkflowId: string,
  startCondition?: StartCondition,
): { outcomes: PollExecutionOutcome[]; entries: ProofLedgerEntry[] } {
  const normalized = normalizeN8nExecution(contract, execution)
  return extractNormalizedEvidence(contract, normalized, { targetId: 'n8n', targetDeploymentId: n8nWorkflowId }, startCondition)
}

/** True for a ContractWorkflowTrace.sourceElements entry naming a StartCondition (compile.ts
 * prefixes these exactly `startCondition:<id>`) -- the signal pollWorkflowEvidence() uses to
 * decide whether a given registered workflow is this contract's intake workflow. */
function findStartCondition(contract: ProcessContract, sourceElements: string[]): StartCondition | undefined {
  const prefix = 'startCondition:'
  const scId = sourceElements.find(s => s.startsWith(prefix))?.slice(prefix.length)
  return scId ? contract.startConditions.find(sc => sc.id === scId) : undefined
}

/**
 * Fetches new executions for one deployed workflow since the last watermark and extracts
 * evidence from each, via the target-neutral ExecutionHistorySource/EvidenceNormalizer pair the
 * caller supplies (n8n today: N8nExecutionHistorySource/N8nEvidenceNormalizer,
 * src/providers/n8n/). Read-only against the target -- listExecutions/fetchExecution only, never
 * a write.
 *
 * `sourceElements` -- the registered workflow's own ContractWorkflowTrace.sourceElements
 * (registry.ts) -- lets this function recognize an intake workflow and record 'instance_start'
 * entries for it (see extractNormalizedEvidence()). Defaults to [] for callers (mostly tests)
 * that don't have a registration to hand it -- meaning no instance_start entries, never a crash.
 */
export async function pollWorkflowEvidence(
  contract: ProcessContract,
  ref: TargetDeploymentRef,
  historySource: ExecutionHistorySource,
  normalizer: EvidenceNormalizer,
  watermark: ContractPollWatermark | null,
  limit = 20,
  sourceElements: string[] = [],
): Promise<PollContractResult> {
  assertConsistentTargetIds(ref, historySource, normalizer)

  const summaries = await historySource.listExecutions(ref, limit)
  const startCondition = findStartCondition(contract, sourceElements)

  const isNew = (s: { id: string; startedAt: string | null }): boolean => {
    if (!watermark) return true
    const startedAt = s.startedAt ?? ''
    if (startedAt > watermark.lastProcessedStartedAt) return true
    if (startedAt === watermark.lastProcessedStartedAt && s.id !== watermark.lastProcessedExecutionId) return true
    return false
  }

  const newOnes = summaries.filter(isNew)
  const ordered = [...newOnes].reverse() // oldest-to-newest, so the ledger reads chronologically

  const outcomes: PollExecutionOutcome[] = []
  const entries: ProofLedgerEntry[] = []

  for (const summary of ordered) {
    const raw = await historySource.fetchExecution(ref, summary.id)
    const normalized = normalizer.normalize(contract, raw)
    const result = extractNormalizedEvidence(contract, normalized, ref, startCondition)
    outcomes.push(...result.outcomes)
    entries.push(...result.entries)
  }

  // The invisible-failure blind spot (P0 measurement-integrity fix, 2026-07-20, fix #11):
  // evidence was expected (outcome !== 'skipped') but couldn't be attached to any promise
  // instance -- these executions would otherwise vanish from promise-report.md's counts with no
  // trace. Carried forward cumulatively on the watermark so `kairos contract report` can warn
  // about them without re-polling.
  const unattributedCount = outcomes.filter(o => o.outcome !== 'skipped' && !o.attributedToInstance).length
  const cumulativeUnattributedCount = (watermark?.cumulativeUnattributedCount ?? 0) + unattributedCount

  // Execution Substrate Boundary v0, Phase 1/4 (docs/plans/execution-substrate-boundary-plan.md
  // §6.4, §6.7): targetId/targetDeploymentId are canonical, generic across targets; the legacy
  // n8nWorkflowId alias is dual-written only for targetId === 'n8n'.
  const n8nAlias = ref.targetId === 'n8n' ? { n8nWorkflowId: ref.targetDeploymentId } : {}
  const newest = summaries[0]
  const newWatermark: ContractPollWatermark = newest
    ? {
        contractId: contract.id,
        targetId: ref.targetId,
        targetDeploymentId: ref.targetDeploymentId,
        ...n8nAlias,
        lastProcessedExecutionId: newest.id,
        lastProcessedStartedAt: newest.startedAt ?? (watermark?.lastProcessedStartedAt ?? ''),
        updatedAt: new Date().toISOString(),
        cumulativeUnattributedCount,
      }
    : (watermark ?? {
        contractId: contract.id,
        targetId: ref.targetId,
        targetDeploymentId: ref.targetDeploymentId,
        ...n8nAlias,
        lastProcessedExecutionId: '',
        lastProcessedStartedAt: '',
        updatedAt: new Date().toISOString(),
        cumulativeUnattributedCount,
      })

  return {
    contractId: contract.id,
    targetId: ref.targetId,
    targetDeploymentId: ref.targetDeploymentId,
    ...n8nAlias,
    executionsChecked: ordered.length,
    entries,
    outcomes,
    newWatermark,
    // Only meaningful once there was a prior watermark to compare against -- a contract's very
    // first poll always processes "everything", which isn't a gap, it's the starting point.
    possibleGap: watermark !== null && summaries.length > 0 && newOnes.length === summaries.length,
    unattributedCount,
  }
}
