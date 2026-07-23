import { createHash } from 'node:crypto'
import { evidenceNodeName } from './compile.js'
import type { ProcessContract, EvidenceRequirement, StartCondition } from './types.js'
import type {
  ProofLedgerEntry,
  ProofStatus,
  ContractPollWatermark,
  PollExecutionOutcome,
  PollContractResult,
  PollableN8nClient,
} from './ledger-types.js'

/**
 * ProofLedger v0 extraction/poll logic (Phase 3, docs/plans/process-contract-promise-engine-plan.md
 * §6, decided by the §6.0 design-verification spike). Deterministic, no LLM call -- reads real
 * n8n execution data (already fetched with `includeData: true`, confirmed necessary by the
 * spike's Finding 2) and extracts only what the contract's own EvidenceRequirement.requiredFields
 * whitelist names, from the exact node `compile.ts`'s evidenceNodeName() convention instructs the
 * generator to produce -- confirmed empirically against a real generation call (Phase 3
 * implementation checkpoint) to actually appear in a real compiled workflow's node list.
 *
 * Never claims more than the evidence supports: a node found with all required fields present is
 * 'observed'; a node found with fields missing is 'unverifiable' (a real, named ambiguity, not
 * silently dropped); no matching node at all in a given execution is 'skipped' (the normal case
 * for a multi-transition workflow -- most executions only touch one transition) and produces no
 * ledger entry at all, never a fabricated one.
 */

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** One item found on a node, plus exactly where it came from -- run/branch/item index --
 * (P0 measurement-integrity fix, 2026-07-20, fix #2) so callers can build a stable, unique
 * per-item id rather than colliding on `${executionId}:${transitionId}` the way a first-item-only
 * read never had to worry about. */
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
 * runData -- not just the first run's first branch's first item (P0 measurement-integrity fix,
 * 2026-07-20, fix #2). n8n's real execution data shape (confirmed against a live production
 * execution, Phase 3 spike Finding 1):
 * data.resultData.runData[nodeName][runIndex].data.main[branch][item].json.
 *
 * A batch-style trigger (e.g. "read every new Sheet row in one execution") or a node that runs
 * more than once inside a loop both produce more than one item/run here -- the original
 * single-item read (`runData[nodeName][0].data.main[0][0].json`) silently dropped every item but
 * the very first, with zero signal anything was lost.
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

export function hashCorrelationKeyValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** `correlationKey.fieldPath` is documented (types.ts) as relative to "the start-condition's own
 * payload shape" -- i.e. a trigger item's own output. Pure, per-item (P0 measurement-integrity
 * fix, 2026-07-20, fix #2) -- callers decide which item's json to read this from. */
function readCorrelationKeyFromJson(contract: ProcessContract, json: Record<string, unknown>): string | undefined {
  const value = readPath(json, contract.correlationKey.fieldPath)
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number') return String(value)
  return undefined
}

interface FieldExtraction {
  status: ProofStatus
  fields: Record<string, unknown>
  missingFields: string[]
}

function extractFieldsFromJson(ev: EvidenceRequirement, json: Record<string, unknown>): FieldExtraction {
  const fields: Record<string, unknown> = {}
  const missingFields: string[] = []
  for (const field of ev.requiredFields) {
    const value = json[field]
    if (value === undefined || value === null || value === '') missingFields.push(field)
    else fields[field] = value
  }
  return { status: missingFields.length === 0 ? 'observed' : 'unverifiable', fields, missingFields }
}

/** Whitelist-safe by construction (§6.2/§9.4): built only from EvidenceRequirement.requiredFields
 * and the values already extracted for exactly those fields -- never any other field on the node,
 * never the raw execution payload. */
function buildDetail(ev: EvidenceRequirement, fields: Record<string, unknown>, missingFields: string[]): string {
  const present = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).join(', ')
  if (missingFields.length === 0) return `${ev.description} -- ${present}`
  return `${ev.description} -- present: ${present || '(none)'}; missing: ${missingFields.join(', ')}`
}

export interface RawExecutionDetail {
  id: string
  startedAt: string | null
  data?: unknown
}

/**
 * Pure -- the whole extraction decision for one already-fetched execution, no network call.
 * Separated from pollWorkflowEvidence() the same way replay/runner.ts split
 * buildSnapshotFromExecution (pure, tested) from replayOnePayload (network, live-checkpointed) --
 * this is the part unit tests exercise directly with synthetic execution data shaped like the
 * real thing confirmed in the Phase 3 spike.
 *
 * `startCondition` is passed only for a workflow whose ContractWorkflowTrace names a
 * StartCondition (an intake workflow, Phase 2's compiler) -- when present, every execution is
 * treated as a new instance beginning in that StartCondition's initialState, and an
 * 'instance_start' entry is recorded from the trigger's own correlation key. This is the fix for
 * a real gap Phase 4 found while being built (not predicted in Phase 3): without it, an SlaSpec
 * measured from a contract's own initial state -- Empire Homecare's own primary SLA included --
 * has no clock-start signal anywhere in the ledger to evaluate against.
 */
export function extractExecutionEvidence(
  contract: ProcessContract,
  execution: RawExecutionDetail,
  n8nWorkflowId: string,
  startCondition?: StartCondition,
): { outcomes: PollExecutionOutcome[]; entries: ProofLedgerEntry[] } {
  const startedAt = execution.startedAt ?? ''
  const data = execution.data as Record<string, unknown> | undefined
  const resultData = data?.['resultData'] as Record<string, unknown> | undefined
  const runData = (resultData?.['runData'] as Record<string, unknown[]> | undefined) ?? {}
  const now = new Date().toISOString()
  // The real-world event time (P0 measurement-integrity fix, 2026-07-20) -- n8n's own
  // execution.startedAt, when it reported one. Falls back to `now` (Kairos's own poll-time
  // clock) only in the rare case n8n's API returns a null startedAt -- never worse than the
  // pre-fix behavior (which always used poll time), and correct whenever n8n's timestamp is
  // present, which the Phase 3 design spike confirmed is the normal case.
  const eventTime = execution.startedAt ?? now

  // The trigger node is always the first key in runData -- confirmed against real execution data
  // (Phase 3 spike Finding 1). ALL of its items (P0 measurement-integrity fix, 2026-07-20, fix
  // #2) -- a batch-style trigger returning multiple rows/items in one execution is a real,
  // structurally supported shape, not just the common single-item case.
  const triggerNodeName = Object.keys(runData)[0]
  const triggerItems = triggerNodeName ? allItemsJson(runData, triggerNodeName) : []

  const matches = contract.evidenceRequirements
    .map(ev => ({ ev, items: allItemsJson(runData, evidenceNodeName(ev.transitionId)) }))
    .filter((x): x is { ev: EvidenceRequirement; items: RunDataItem[] } => x.items.length > 0)

  if (!startCondition && matches.length === 0) {
    return {
      outcomes: [{
        executionId: execution.id,
        startedAt,
        outcome: 'skipped',
        detail: 'No evidence-marker node found in this execution -- not relevant to any EvidenceRequirement in this contract.',
        attributedToInstance: false,
      }],
      entries: [],
    }
  }

  const outcomes: PollExecutionOutcome[] = []
  const entries: ProofLedgerEntry[] = []
  const noKeyReason = `the correlation key (${contract.correlationKey.fieldPath}) could not be read -- no ledger entry written without a known promise instance.`

  // instance_start: one per resolvable trigger item, not just the first (P0 measurement-integrity
  // fix, 2026-07-20, fix #2) -- a batch intake execution creating N new instances at once.
  if (startCondition) {
    if (triggerItems.length === 0) {
      outcomes.push({ executionId: execution.id, startedAt, outcome: 'unverifiable', detail: `Start-condition execution, but no trigger data was found at all -- ${noKeyReason}`, attributedToInstance: false })
    }
    for (const item of triggerItems) {
      const correlationValue = readCorrelationKeyFromJson(contract, item.json)
      if (!correlationValue) {
        outcomes.push({ executionId: execution.id, startedAt, outcome: 'unverifiable', detail: `Start-condition execution (item ${itemPosition(item)}), but ${noKeyReason}`, attributedToInstance: false })
        continue
      }
      const promiseInstanceId = hashCorrelationKeyValue(correlationValue)
      const detail = `New ${contract.entity.name} instance began in state "${startCondition.initialState}" (${startCondition.description}).`
      outcomes.push({ executionId: execution.id, startedAt, outcome: 'extracted', detail, attributedToInstance: true })
      entries.push({
        id: `${execution.id}:instance_start:${itemPosition(item)}`,
        contractId: contract.id,
        contractVersion: contract.version,
        promiseInstanceId,
        correlationKeyValueHash: promiseInstanceId,
        kind: 'instance_start',
        initialState: startCondition.initialState,
        observedAt: now,
        eventTime,
        sourceWorkflowId: n8nWorkflowId,
        sourceExecutionId: execution.id,
        status: 'observed',
        detail,
      })
    }
  }

  // evidence: one entry per item found at the marker node, not just the first (P0
  // measurement-integrity fix, 2026-07-20, fix #2). Correlation key resolution per item: first
  // try reading it directly off the SAME item's own json (an n8n Set/Edit Fields node normally
  // passes through unset input fields, so a per-item correlation key usually survives to the
  // evidence node unchanged) -- this is what actually makes multi-item attribution possible.
  // Falls back to the single trigger item's own key ONLY when there is exactly one trigger item
  // total (byte-identical behavior to before this fix for the common single-item case); with more
  // than one trigger item and no per-item key on the evidence node itself, there is no reliable,
  // non-guessing way to attribute it, so it is reported unattributed rather than misattributed.
  for (const { ev, items } of matches) {
    for (const item of items) {
      let correlationValue = readCorrelationKeyFromJson(contract, item.json)
      if (!correlationValue && triggerItems.length === 1) {
        correlationValue = readCorrelationKeyFromJson(contract, triggerItems[0]!.json)
      }
      if (!correlationValue) {
        outcomes.push({ executionId: execution.id, startedAt, outcome: 'unverifiable', transitionId: ev.transitionId, detail: `Evidence marker node found for transition "${ev.transitionId}" (item ${itemPosition(item)}), but ${noKeyReason}`, attributedToInstance: false })
        continue
      }
      const promiseInstanceId = hashCorrelationKeyValue(correlationValue)
      const found = extractFieldsFromJson(ev, item.json)
      const detail = buildDetail(ev, found.fields, found.missingFields)
      outcomes.push({
        executionId: execution.id,
        startedAt,
        outcome: found.status === 'observed' ? 'extracted' : 'unverifiable',
        transitionId: ev.transitionId,
        detail,
        attributedToInstance: true,
      })
      entries.push({
        id: `${execution.id}:${ev.transitionId}:${itemPosition(item)}`,
        contractId: contract.id,
        contractVersion: contract.version,
        promiseInstanceId,
        correlationKeyValueHash: promiseInstanceId,
        kind: 'evidence',
        transitionId: ev.transitionId,
        observedAt: now,
        eventTime,
        sourceWorkflowId: n8nWorkflowId,
        sourceExecutionId: execution.id,
        status: found.status,
        detail,
      })
    }
  }

  return { outcomes, entries }
}

/** True for a ContractWorkflowTrace.sourceElements entry naming a StartCondition (Phase 2's
 * compile.ts prefixes these exactly `startCondition:<id>`) -- the signal pollWorkflowEvidence()
 * uses to decide whether a given registered workflow is this contract's intake workflow. */
function findStartCondition(contract: ProcessContract, sourceElements: string[]): StartCondition | undefined {
  const prefix = 'startCondition:'
  const scId = sourceElements.find(s => s.startsWith(prefix))?.slice(prefix.length)
  return scId ? contract.startConditions.find(sc => sc.id === scId) : undefined
}

/**
 * Fetches new executions for one compiled workflow since the last watermark and extracts
 * evidence from each. Read-only against n8n -- getExecutions/getExecution only, never a write.
 *
 * n8n's `/executions` list is confirmed (Phase 3 spike, real execution ids returned in
 * descending order) to return most-recent-first -- relied on here, not re-derived, matching
 * fetchLatestTrace()'s own existing assumption (execution-tracer.ts) that index 0 is the latest.
 *
 * `sourceElements` -- the registered workflow's own ContractWorkflowTrace.sourceElements
 * (registry.ts) -- lets this function recognize an intake workflow and record 'instance_start'
 * entries for it (see extractExecutionEvidence()). Defaults to [] for callers (mostly tests) that
 * don't have a registration to hand it -- meaning no instance_start entries, never a crash.
 */
export async function pollWorkflowEvidence(
  contract: ProcessContract,
  n8nWorkflowId: string,
  client: PollableN8nClient,
  watermark: ContractPollWatermark | null,
  limit = 20,
  sourceElements: string[] = [],
): Promise<PollContractResult> {
  const summaries = await client.getExecutions(n8nWorkflowId, { limit })
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
    const detail = await client.getExecution(summary.id, { includeData: true })
    const result = extractExecutionEvidence(contract, detail, n8nWorkflowId, startCondition)
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

  // Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
  // §6.4, §6.7): targetId/targetDeploymentId are dual-written alongside the still-required
  // n8nWorkflowId parameter below -- this function's own signature stays n8n-specific until
  // Phase 4's ExecutionHistorySource/EvidenceNormalizer refactor; only the RESULT shapes
  // (ContractPollWatermark, PollContractResult) gain the canonical fields this phase,
  // mechanically, so every other Promise Engine module can already read them everywhere else in
  // the codebase without waiting for Phase 4.
  const newest = summaries[0]
  const newWatermark: ContractPollWatermark = newest
    ? {
        contractId: contract.id,
        targetId: 'n8n',
        targetDeploymentId: n8nWorkflowId,
        n8nWorkflowId,
        lastProcessedExecutionId: newest.id,
        lastProcessedStartedAt: newest.startedAt ?? (watermark?.lastProcessedStartedAt ?? ''),
        updatedAt: new Date().toISOString(),
        cumulativeUnattributedCount,
      }
    : (watermark ?? {
        contractId: contract.id,
        targetId: 'n8n',
        targetDeploymentId: n8nWorkflowId,
        n8nWorkflowId,
        lastProcessedExecutionId: '',
        lastProcessedStartedAt: '',
        updatedAt: new Date().toISOString(),
        cumulativeUnattributedCount,
      })

  return {
    contractId: contract.id,
    targetId: 'n8n',
    targetDeploymentId: n8nWorkflowId,
    n8nWorkflowId,
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
