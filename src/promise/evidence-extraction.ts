import { createHash } from 'node:crypto'
import type { ProcessContract, EvidenceRequirement, StartCondition } from './types.js'
import type { ProofLedgerEntry, ProofStatus, PollExecutionOutcome } from './ledger-types.js'
import type { TargetDeploymentRef, EvidenceFieldItem, NormalizedExecution } from './targets/types.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4). Target-neutral evidence extraction -- the exact decision logic ledger.ts's own
 * pre-boundary extractExecutionEvidence() made from raw n8n runData, now operating on an
 * already-normalized NormalizedExecution instead. Zero n8n concept: no runData, no node names,
 * no evidenceNodeName() call anywhere in this file -- that resolution happens entirely inside a
 * target's own EvidenceNormalizer (e.g. src/providers/n8n/evidence.ts) before this module ever
 * sees the data.
 *
 * Never claims more than the evidence supports: a node found with all required fields present is
 * 'observed'; a node found with fields missing is 'unverifiable' (a real, named ambiguity, not
 * silently dropped); no matching evidence at all in a given execution is 'skipped' and produces
 * no ledger entry at all, never a fabricated one -- the exact same discipline the pre-boundary
 * extractor used, preserved here unchanged.
 */

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function hashCorrelationKeyValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** `correlationKey.fieldPath` is documented (types.ts) as relative to "the start-condition's own
 * payload shape" -- i.e. a trigger item's own output fields. */
function readCorrelationKeyFromJson(contract: ProcessContract, fields: Record<string, unknown>): string | undefined {
  const value = readPath(fields, contract.correlationKey.fieldPath)
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number') return String(value)
  return undefined
}

interface FieldExtraction {
  status: ProofStatus
  fields: Record<string, unknown>
  missingFields: string[]
}

function extractFieldsFromJson(ev: EvidenceRequirement, fields: Record<string, unknown>): FieldExtraction {
  const found: Record<string, unknown> = {}
  const missingFields: string[] = []
  for (const field of ev.requiredFields) {
    const value = fields[field]
    if (value === undefined || value === null || value === '') missingFields.push(field)
    else found[field] = value
  }
  return { status: missingFields.length === 0 ? 'observed' : 'unverifiable', fields: found, missingFields }
}

/** Whitelist-safe by construction: built only from EvidenceRequirement.requiredFields and the
 * values already extracted for exactly those fields -- never any other field, never the raw
 * execution payload. */
function buildDetail(ev: EvidenceRequirement, fields: Record<string, unknown>, missingFields: string[]): string {
  const present = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).join(', ')
  if (missingFields.length === 0) return `${ev.description} -- ${present}`
  return `${ev.description} -- present: ${present || '(none)'}; missing: ${missingFields.join(', ')}`
}

/**
 * Ledger identity is (targetId, id), never id alone (plan §6.4). For n8n, byte-identical to
 * every id the pre-boundary extractor ever produced (`${executionRef}:${suffix}`) -- no
 * behavior change. For any future non-n8n target, targetId is folded directly into the id
 * string itself, so two different targets can never collide even if they happen to reuse the
 * same raw executionRef.
 */
export function buildEntryId(deploymentRef: TargetDeploymentRef, executionRef: string, suffix: string): string {
  return deploymentRef.targetId === 'n8n' ? `${executionRef}:${suffix}` : `${deploymentRef.targetId}:${executionRef}:${suffix}`
}

/** extractNormalizedEvidence() owns the sourceItemRef-or-array-index fallback (plan §6.4) --
 * never interpreted by a normalizer, never fabricated when genuinely absent. */
function itemSuffix(item: EvidenceFieldItem, index: number): string {
  return item.sourceItemRef ?? String(index)
}

/**
 * Pure -- the whole extraction decision for one already-normalized execution, no network call.
 * `startCondition` is passed only for a workflow whose ContractWorkflowTrace names a
 * StartCondition (an intake workflow) -- when present, every execution is treated as a new
 * instance beginning in that StartCondition's initialState, and an 'instance_start' entry is
 * recorded from the initiating item's own correlation key.
 */
export function extractNormalizedEvidence(
  contract: ProcessContract,
  execution: NormalizedExecution,
  deploymentRef: TargetDeploymentRef,
  startCondition?: StartCondition,
): { outcomes: PollExecutionOutcome[]; entries: ProofLedgerEntry[] } {
  const startedAt = execution.eventTime ?? ''
  const now = new Date().toISOString()
  // The real-world event time -- falls back to `now` (Kairos's own poll-time clock) only when
  // the target itself reports no event time at all.
  const eventTime = execution.eventTime ?? now

  if (!startCondition && execution.transitionEvidence.length === 0) {
    return {
      outcomes: [{
        executionId: execution.executionRef,
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

  // instance_start: one per resolvable initiating item, not just the first -- a batch intake
  // execution creating N new instances at once.
  if (startCondition) {
    if (execution.initiatingItems.length === 0) {
      outcomes.push({ executionId: execution.executionRef, startedAt, outcome: 'unverifiable', detail: `Start-condition execution, but no trigger data was found at all -- ${noKeyReason}`, attributedToInstance: false })
    }
    execution.initiatingItems.forEach((item, index) => {
      const suffix = itemSuffix(item, index)
      const correlationValue = readCorrelationKeyFromJson(contract, item.fields)
      if (!correlationValue) {
        outcomes.push({ executionId: execution.executionRef, startedAt, outcome: 'unverifiable', detail: `Start-condition execution (item ${suffix}), but ${noKeyReason}`, attributedToInstance: false })
        return
      }
      const promiseInstanceId = hashCorrelationKeyValue(correlationValue)
      const detail = `New ${contract.entity.name} instance began in state "${startCondition.initialState}" (${startCondition.description}).`
      outcomes.push({ executionId: execution.executionRef, startedAt, outcome: 'extracted', detail, attributedToInstance: true })
      entries.push({
        id: buildEntryId(deploymentRef, execution.executionRef, `instance_start:${suffix}`),
        contractId: contract.id,
        contractVersion: contract.version,
        promiseInstanceId,
        correlationKeyValueHash: promiseInstanceId,
        kind: 'instance_start',
        initialState: startCondition.initialState,
        observedAt: now,
        eventTime,
        targetId: deploymentRef.targetId,
        sourceWorkflowId: deploymentRef.targetDeploymentId,
        sourceExecutionId: execution.executionRef,
        status: 'observed',
        detail,
      })
    })
  }

  // evidence: one entry per item found for each already-resolved transition, not just the
  // first. Correlation key resolution per item: first try the SAME item's own fields; falls
  // back to the single initiating item's own key ONLY when there is exactly one initiating item
  // total (byte-identical behavior to before this refactor for the common single-item case);
  // with more than one initiating item and no per-item key on the evidence item itself, there is
  // no reliable, non-guessing way to attribute it, so it is reported unattributed rather than
  // misattributed.
  for (const te of execution.transitionEvidence) {
    const ev = contract.evidenceRequirements.find(r => r.transitionId === te.transitionId)
    // Defensive only -- a well-behaved EvidenceNormalizer never produces a transitionId absent
    // from the contract's own evidenceRequirements (normalizeN8nExecution() only ever iterates
    // contract.evidenceRequirements to build this list in the first place).
    if (!ev) continue

    te.items.forEach((item, index) => {
      const suffix = itemSuffix(item, index)
      let correlationValue = readCorrelationKeyFromJson(contract, item.fields)
      if (!correlationValue && execution.initiatingItems.length === 1) {
        correlationValue = readCorrelationKeyFromJson(contract, execution.initiatingItems[0]!.fields)
      }
      if (!correlationValue) {
        outcomes.push({ executionId: execution.executionRef, startedAt, outcome: 'unverifiable', transitionId: ev.transitionId, detail: `Evidence marker node found for transition "${ev.transitionId}" (item ${suffix}), but ${noKeyReason}`, attributedToInstance: false })
        return
      }
      const promiseInstanceId = hashCorrelationKeyValue(correlationValue)
      const found = extractFieldsFromJson(ev, item.fields)
      const detail = buildDetail(ev, found.fields, found.missingFields)
      outcomes.push({
        executionId: execution.executionRef,
        startedAt,
        outcome: found.status === 'observed' ? 'extracted' : 'unverifiable',
        transitionId: ev.transitionId,
        detail,
        attributedToInstance: true,
      })
      entries.push({
        id: buildEntryId(deploymentRef, execution.executionRef, `${ev.transitionId}:${suffix}`),
        contractId: contract.id,
        contractVersion: contract.version,
        promiseInstanceId,
        correlationKeyValueHash: promiseInstanceId,
        kind: 'evidence',
        transitionId: ev.transitionId,
        observedAt: now,
        eventTime,
        targetId: deploymentRef.targetId,
        sourceWorkflowId: deploymentRef.targetDeploymentId,
        sourceExecutionId: execution.executionRef,
        status: found.status,
        detail,
      })
    })
  }

  return { outcomes, entries }
}
