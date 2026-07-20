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

/** n8n's real execution data shape (confirmed against a live production execution, Phase 3
 * spike Finding 1): data.resultData.runData[nodeName][runIndex].data.main[branch][item].json. */
function firstItemJson(runData: Record<string, unknown[]>, nodeName: string): Record<string, unknown> | undefined {
  const runs = runData[nodeName]
  if (!Array.isArray(runs) || runs.length === 0) return undefined
  const run = runs[0] as Record<string, unknown> | undefined
  const data = run?.['data'] as Record<string, unknown> | undefined
  const main = data?.['main'] as unknown[][] | undefined
  const firstBranch = main?.[0]
  const firstItem = firstBranch?.[0] as Record<string, unknown> | undefined
  return firstItem?.['json'] as Record<string, unknown> | undefined
}

export function hashCorrelationKeyValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** The trigger node is always the first key in runData -- confirmed against real execution data
 * (Phase 3 spike Finding 1: a schedule-triggered execution's own trigger node was literally the
 * first entry) rather than needing a second naming convention just for correlation-key capture.
 * `correlationKey.fieldPath` is documented (types.ts) as relative to "the start-condition's own
 * payload shape" -- i.e. the trigger node's own output. */
function extractCorrelationKeyValue(contract: ProcessContract, runData: Record<string, unknown[]>): string | undefined {
  const nodeNames = Object.keys(runData)
  const triggerNodeName = nodeNames[0]
  if (!triggerNodeName) return undefined
  const triggerJson = firstItemJson(runData, triggerNodeName)
  if (!triggerJson) return undefined
  const value = readPath(triggerJson, contract.correlationKey.fieldPath)
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number') return String(value)
  return undefined
}

interface FieldExtraction {
  status: ProofStatus
  fields: Record<string, unknown>
  missingFields: string[]
}

function extractEvidenceFields(ev: EvidenceRequirement, runData: Record<string, unknown[]>): FieldExtraction | null {
  const json = firstItemJson(runData, evidenceNodeName(ev.transitionId))
  if (!json) return null // Not present in this execution -- 'skipped', not a failure.

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

  const matches = contract.evidenceRequirements
    .map(ev => ({ ev, found: extractEvidenceFields(ev, runData) }))
    .filter((x): x is { ev: EvidenceRequirement; found: FieldExtraction } => x.found !== null)

  if (!startCondition && matches.length === 0) {
    return {
      outcomes: [{
        executionId: execution.id,
        startedAt,
        outcome: 'skipped',
        detail: 'No evidence-marker node found in this execution -- not relevant to any EvidenceRequirement in this contract.',
      }],
      entries: [],
    }
  }

  const correlationValue = extractCorrelationKeyValue(contract, runData)
  const now = new Date().toISOString()

  if (!correlationValue) {
    const reason = `the correlation key (${contract.correlationKey.fieldPath}) could not be read from this execution's trigger data -- no ledger entry written without a known promise instance.`
    const outcomes: PollExecutionOutcome[] = []
    if (startCondition) {
      outcomes.push({ executionId: execution.id, startedAt, outcome: 'unverifiable', detail: `Start-condition execution, but ${reason}` })
    }
    for (const { ev } of matches) {
      outcomes.push({ executionId: execution.id, startedAt, outcome: 'unverifiable', transitionId: ev.transitionId, detail: `Evidence marker node found for transition "${ev.transitionId}", but ${reason}` })
    }
    return { outcomes, entries: [] }
  }

  const promiseInstanceId = hashCorrelationKeyValue(correlationValue)
  const outcomes: PollExecutionOutcome[] = []
  const entries: ProofLedgerEntry[] = []

  if (startCondition) {
    const detail = `New ${contract.entity.name} instance began in state "${startCondition.initialState}" (${startCondition.description}).`
    outcomes.push({ executionId: execution.id, startedAt, outcome: 'extracted', detail })
    entries.push({
      id: `${execution.id}:instance_start`,
      contractId: contract.id,
      contractVersion: contract.version,
      promiseInstanceId,
      correlationKeyValueHash: promiseInstanceId,
      kind: 'instance_start',
      initialState: startCondition.initialState,
      observedAt: now,
      sourceWorkflowId: n8nWorkflowId,
      sourceExecutionId: execution.id,
      status: 'observed',
      detail,
    })
  }

  for (const { ev, found } of matches) {
    const detail = buildDetail(ev, found.fields, found.missingFields)
    outcomes.push({
      executionId: execution.id,
      startedAt,
      outcome: found.status === 'observed' ? 'extracted' : 'unverifiable',
      transitionId: ev.transitionId,
      detail,
    })
    entries.push({
      id: `${execution.id}:${ev.transitionId}`,
      contractId: contract.id,
      contractVersion: contract.version,
      promiseInstanceId,
      correlationKeyValueHash: promiseInstanceId,
      kind: 'evidence',
      transitionId: ev.transitionId,
      observedAt: now,
      sourceWorkflowId: n8nWorkflowId,
      sourceExecutionId: execution.id,
      status: found.status,
      detail,
    })
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

  const newest = summaries[0]
  const newWatermark: ContractPollWatermark = newest
    ? {
        contractId: contract.id,
        n8nWorkflowId,
        lastProcessedExecutionId: newest.id,
        lastProcessedStartedAt: newest.startedAt ?? (watermark?.lastProcessedStartedAt ?? ''),
        updatedAt: new Date().toISOString(),
      }
    : (watermark ?? {
        contractId: contract.id,
        n8nWorkflowId,
        lastProcessedExecutionId: '',
        lastProcessedStartedAt: '',
        updatedAt: new Date().toISOString(),
      })

  return {
    contractId: contract.id,
    n8nWorkflowId,
    executionsChecked: ordered.length,
    entries,
    outcomes,
    newWatermark,
    // Only meaningful once there was a prior watermark to compare against -- a contract's very
    // first poll always processes "everything", which isn't a gap, it's the starting point.
    possibleGap: watermark !== null && summaries.length > 0 && newOnes.length === summaries.length,
  }
}
