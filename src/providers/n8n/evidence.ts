import type { EvidenceNormalizer } from '../../promise/targets/execution-history.js'
import type { EvidenceFieldItem, NormalizedExecution, NormalizedTransitionEvidence } from '../../promise/targets/types.js'
import type { ProcessContract } from '../../promise/types.js'
import type { RawExecutionDetail } from './execution-history.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4). Node-name marker-convention interpretation, moved here from compile.ts/ledger.ts (a
 * mechanical relocation, not a rewrite) -- the neutral extractor (evidence-extraction.ts) never
 * calls evidenceNodeName() or knows a node-naming convention exists at all; that resolution now
 * happens entirely inside this n8n-specific normalizer.
 */

export function evidenceNodeName(transitionId: string): string {
  return `Kairos Evidence: ${transitionId}`
}

/** One item found on a node, plus exactly where it came from -- run/branch/item index -- so
 * `sourceItemRef` (below) can carry a stable, unique per-item positional string, exactly as
 * ledger.ts's own pre-boundary extractor used to build entry ids from directly. */
interface RunDataItem {
  json: Record<string, unknown>
  runIndex: number
  branchIndex: number
  itemIndex: number
}

function itemPosition(item: RunDataItem): string {
  return `${item.runIndex}.${item.branchIndex}.${item.itemIndex}`
}

/**
 * ALL items found on a given node across EVERY run and EVERY output branch in this execution's
 * runData -- not just the first run's first branch's first item. n8n's real execution data shape
 * (confirmed against a live production execution, Phase 3 design spike Finding 1):
 * data.resultData.runData[nodeName][runIndex].data.main[branch][item].json.
 *
 * Verbatim logic move from ledger.ts's own pre-boundary allItemsJson() -- a batch-style trigger
 * or a node that runs more than once inside a loop both produce more than one item/run here.
 */
function allItemsJson(runData: Record<string, unknown[]>, nodeName: string): RunDataItem[] {
  const runs = runData[nodeName]
  if (!Array.isArray(runs)) return []
  const results: RunDataItem[] = []
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex] as Record<string, unknown> | undefined
    const data = run?.['data'] as Record<string, unknown> | undefined
    const main = data?.['main'] as unknown[][] | undefined
    if (!Array.isArray(main)) continue
    for (let branchIndex = 0; branchIndex < main.length; branchIndex++) {
      const branch = main[branchIndex]
      if (!Array.isArray(branch)) continue
      for (let itemIndex = 0; itemIndex < branch.length; itemIndex++) {
        const rawItem = branch[itemIndex] as Record<string, unknown> | undefined
        const json = rawItem?.['json'] as Record<string, unknown> | undefined
        if (json) results.push({ json, runIndex, branchIndex, itemIndex })
      }
    }
  }
  return results
}

/** sourceItemRef is always populated for n8n, with the exact run.branch.item positional string
 * -- so extractNormalizedEvidence()'s array-index fallback is never actually taken for n8n,
 * keeping every ledger entry id byte-identical to before this refactor. */
function toEvidenceFieldItems(items: RunDataItem[]): EvidenceFieldItem[] {
  return items.map(item => ({ fields: item.json, sourceItemRef: itemPosition(item) }))
}

/**
 * Contract-aware: parses runData exactly as the pre-boundary extractor's own allItemsJson()/
 * readPath() did (verbatim logic move), resolves evidenceNodeName(ev.transitionId) for each
 * contract.evidenceRequirements entry against the parsed node list, buckets items by
 * transitionId -- only including a transitionId whose node produced at least one item, matching
 * the pre-boundary extractor's own `.filter(items.length > 0)` step exactly. Produces ONLY a
 * NormalizedExecution -- it never constructs a ProofLedgerEntry.id (evidence-extraction.ts's own
 * job).
 */
export function normalizeN8nExecution(contract: ProcessContract, execution: RawExecutionDetail): NormalizedExecution {
  const data = execution.data as Record<string, unknown> | undefined
  const resultData = data?.['resultData'] as Record<string, unknown> | undefined
  const runData = (resultData?.['runData'] as Record<string, unknown[]> | undefined) ?? {}

  // The trigger node is always the first key in runData -- confirmed against real execution data
  // (Phase 3 design spike Finding 1).
  const triggerNodeName = Object.keys(runData)[0]
  const triggerItems = triggerNodeName ? allItemsJson(runData, triggerNodeName) : []

  const transitionEvidence: NormalizedTransitionEvidence[] = contract.evidenceRequirements
    .map((ev): NormalizedTransitionEvidence => ({ transitionId: ev.transitionId, items: toEvidenceFieldItems(allItemsJson(runData, evidenceNodeName(ev.transitionId))) }))
    .filter(te => te.items.length > 0)

  return {
    executionRef: execution.id,
    eventTime: execution.startedAt,
    initiatingItems: toEvidenceFieldItems(triggerItems),
    transitionEvidence,
  }
}

export class N8nEvidenceNormalizer implements EvidenceNormalizer<RawExecutionDetail> {
  readonly targetId = 'n8n'
  normalize(contract: ProcessContract, raw: RawExecutionDetail): NormalizedExecution {
    return normalizeN8nExecution(contract, raw)
  }
}
