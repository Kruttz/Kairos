import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateContractScenarios } from '../../../../src/promise/scenario.js'
import { extractNormalizedEvidence } from '../../../../src/promise/evidence-extraction.js'
import { normalizeN8nExecution, evidenceNodeName } from '../../../../src/providers/n8n/evidence.js'
import { InMemoryContractTarget } from '../../../../src/promise/targets/in-memory/adapter.js'
import { checkSlaCompliance } from '../../../../src/promise/sla-compliance.js'
import { updateExceptionDesk } from '../../../../src/promise/exception-desk.js'
import { buildPromiseReportData } from '../../../../src/promise/report.js'
import { analyzeContractForAmendments } from '../../../../src/promise/evolution.js'
import { deriveLearningNotesFromProposals } from '../../../../src/promise/learning.js'
import { buildAutomationValueReport } from '../../../../src/promise/value-report.js'
import type { RawExecutionDetail } from '../../../../src/providers/n8n/execution-history.js'
import type { ProcessContract } from '../../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../../src/promise/ledger-types.js'
import type { ContractAmendmentProposal } from '../../../../src/promise/evolution-types.js'
import type { ContractScenario, ScenarioTimelineEvent } from '../../../../src/promise/scenario-types.js'
import type { TargetDeploymentRef } from '../../../../src/promise/targets/types.js'

/**
 * Execution Substrate Boundary v0, Phase 5 (docs/plans/execution-substrate-boundary-plan.md §7,
 * conformance suite #2). Cross-target report parity: a full, real, generator-produced set of
 * ProofLedgerEntry[] is built via two independent paths -- n8n raw execution ->
 * normalizeN8nExecution() -> extractNormalizedEvidence() under a REAL n8n ref, and
 * InMemoryContractTarget.seedExecution() -> .normalize() -> extractNormalizedEvidence() under a
 * REAL in-memory-test ref -- and fed through every real, unmodified downstream function this arc
 * names: checkSlaCompliance(), updateExceptionDesk(), buildPromiseReportData(),
 * analyzeContractForAmendments(), deriveLearningNotesFromProposals(),
 * buildAutomationValueReport(). Every one of the six is asserted to produce equivalent BUSINESS
 * output, and every one of the two paths' own ledger/proposal provenance is separately asserted
 * to carry the CORRECT, DIFFERENT target identity end to end -- this suite proves both "different
 * targets produce genuinely different, correctly-attributed provenance" and "downstream business
 * logic is indifferent to which target produced equivalent evidence," not just the second alone
 * (which a same-ref test, like evidence-conformance.test.ts's own, cannot distinguish from "the
 * ref was never really exercised").
 *
 * "Equivalent business output," precisely: every real entry/proposal id, targetId, and
 * sourceWorkflowId differs BY CONSTRUCTION between the two paths now (a real n8n ref vs. a real
 * in-memory-test ref, never held artificially constant) -- expected, asserted directly, then
 * normalized away (alongside `createdAt`/`observedAt`, both wall-clock at construction time) via
 * one generic redaction pass before the six functions' own results are compared. See
 * evidence-conformance.test.ts's own doc comment for why `EvidenceFieldItem.sourceItemRef` (and
 * therefore each entry id's own trailing suffix) is never expected to match byte-for-byte either
 * way, target-identity aside.
 */

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

function offsetToMs(offset: ScenarioTimelineEvent['offset']): number {
  switch (offset.unit) {
    case 'minutes': return offset.amount * 60_000
    case 'hours': return offset.amount * 60 * 60_000
    case 'days': return offset.amount * 24 * 60 * 60_000
  }
}

function nestedFields(path: string, value: string): Record<string, unknown> {
  const parts = path.split('.')
  const root: Record<string, unknown> = {}
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {}
    cur[parts[i]!] = next
    cur = next
  }
  cur[parts[parts.length - 1]!] = value
  return root
}

function scenarioEventToRawN8n(contract: ProcessContract, scenario: ContractScenario, event: ScenarioTimelineEvent, now: Date): RawExecutionDetail {
  const eventTime = new Date(now.getTime() - offsetToMs(event.offset)).toISOString()
  const executionRef = `${scenario.id}:${event.id}`
  const correlationFields = nestedFields(contract.correlationKey.fieldPath, scenario.correlationKeyValue)
  const fields = event.kind === 'instance_start' ? correlationFields : { ...correlationFields, ...(event.fields ?? {}) }
  const nodeName = event.kind === 'instance_start' ? 'Webhook: Intake' : evidenceNodeName(event.transitionId!)
  return {
    id: executionRef,
    startedAt: eventTime,
    data: { version: 1, resultData: { runData: { [nodeName]: [{ data: { main: [[{ json: fields, pairedItem: { item: 0 } }]] } }] } } },
  }
}

const FIXED_OBSERVED_AT = '2026-07-20T12:00:00.000Z'
const N8N_REF: TargetDeploymentRef = { targetId: 'n8n', targetDeploymentId: 'wf-real-n8n-workflow' }
const IN_MEMORY_REF: TargetDeploymentRef = { targetId: 'in-memory-test', targetDeploymentId: 'in-memory-workflow-1' }

/** The full, real entry set for the n8n path, across every real generator-produced scenario and
 * timeline event -- extracted under a REAL n8n TargetDeploymentRef (never an arbitrary/shared
 * one), so every resulting entry's own targetId/sourceWorkflowId is genuinely n8n's own.
 * observedAt pinned to a fixed value (a real, independent wall-clock-timing race, not a
 * business-logic concern -- see the redaction pass below). */
function buildEntriesViaN8n(contract: ProcessContract, scenarios: ContractScenario[], now: Date): ProofLedgerEntry[] {
  const entries: ProofLedgerEntry[] = []
  for (const scenario of scenarios) {
    for (const event of scenario.timeline) {
      const startCondition = event.kind === 'instance_start' ? contract.startConditions.find(sc => sc.initialState === event.initialState) : undefined
      const raw = scenarioEventToRawN8n(contract, scenario, event, now)
      const normalized = normalizeN8nExecution(contract, raw)
      const { entries: e } = extractNormalizedEvidence(contract, normalized, N8N_REF, startCondition)
      entries.push(...e.map(entry => ({ ...entry, observedAt: FIXED_OBSERVED_AT })))
    }
  }
  return entries
}

/** The identical sweep via InMemoryContractTarget instead, extracted under a REAL
 * in-memory-test TargetDeploymentRef -- the adapter's own internal per-(scenario,event)
 * deployment-id bucketing (`fetchRef` below) is a test-infrastructure detail for
 * seeding/fetching distinct executions from the adapter; it is deliberately NOT the ref passed
 * to extractNormalizedEvidence() itself, which instead uses ONE fixed IN_MEMORY_REF throughout,
 * mirroring how a real poll uses one constant ref for every execution of one registered
 * workflow. */
async function buildEntriesViaInMemory(contract: ProcessContract, scenarios: ContractScenario[], now: Date): Promise<ProofLedgerEntry[]> {
  const entries: ProofLedgerEntry[] = []
  const adapter = new InMemoryContractTarget()
  for (const scenario of scenarios) {
    for (const event of scenario.timeline) {
      const startCondition = event.kind === 'instance_start' ? contract.startConditions.find(sc => sc.initialState === event.initialState) : undefined
      const deploymentId = `dep-${scenario.id}-${event.id}`
      adapter.seedExecution(deploymentId, { ...scenario, timeline: [event] }, contract, now)
      const fetchRef = { targetId: adapter.targetId, targetDeploymentId: deploymentId }
      const list = await adapter.listExecutions(fetchRef, 20)
      const raw = await adapter.fetchExecution(fetchRef, list[0]!.id)
      const normalized = adapter.normalize(contract, raw)
      const { entries: e } = extractNormalizedEvidence(contract, normalized, IN_MEMORY_REF, startCondition)
      entries.push(...e.map(entry => ({ ...entry, observedAt: FIXED_OBSERVED_AT })))
    }
  }
  return entries
}

/** Every real id this run produced, mapped to a stable, positional placeholder -- built once per
 * path's own entries, in entry order, so `<ENTRY_0>` always means "the first entry this path
 * produced," regardless of what its own real id string happens to be. */
function idPlaceholderMap(entries: ProofLedgerEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  entries.forEach((e, i) => map.set(e.id, `<ENTRY_${i}>`))
  return map
}

/** Keys this suite normalizes away before comparing business results -- expected
 * target-specific provenance (`targetId`, `sourceWorkflowId` -- a real deployment reference) and
 * wall-clock timestamps computed fresh at construction time (`createdAt`: evolution.ts's own
 * proposal construction stamps `new Date().toISOString()` directly, NOT the injected `now`, a
 * real timing race found while writing this suite -- distinct from, though the same class as,
 * Phase 4's own closeout finding for `observedAt`, which is separately pinned to
 * FIXED_OBSERVED_AT before any downstream function runs; blanked again here regardless, for
 * defense in depth). */
const PROVENANCE_KEYS = new Set(['targetId', 'sourceWorkflowId'])
const VOLATILE_KEYS = new Set(['createdAt', 'observedAt'])

/** Walks any JSON-shaped value, replacing every string that exactly matches a known real id with
 * its stable positional placeholder, and blanking any PROVENANCE_KEYS/VOLATILE_KEYS field
 * regardless of its value -- generic on purpose, so it normalizes expected differences no matter
 * how deeply a given downstream function's own result shape embeds them (a bare
 * ProofLedgerEntry[], a nested AmendmentEvidenceRef.targetId/.id, an ExceptionDeskItem.evidence[]
 * string list), without this test needing to special-case each of the six functions' own shape. */
function redact(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value
  if (Array.isArray(value)) return value.map(v => redact(v, idMap))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = (PROVENANCE_KEYS.has(k) || VOLATILE_KEYS.has(k)) ? '<REDACTED>' : redact(v, idMap)
    }
    return out
  }
  return value
}

/** Pure mirror of evolution-store.ts's own updateProposalStatus() data transformation (that
 * function itself does real file I/O -- reading/writing ~/.kairos/contracts/.../proposals.json
 * -- inappropriate for this pure unit test; this reproduces only its in-memory shape change).
 * `ts` is a fixed string, never `new Date()`, so applying this to both paths' proposal arrays
 * introduces no timing race of its own. */
function withDecision(proposal: ContractAmendmentProposal, to: 'accepted' | 'rejected', ts: string): ContractAmendmentProposal {
  return { ...proposal, status: to, history: [...proposal.history, { ts, from: proposal.status, to, actor: 'human' as const }] }
}

describe('Cross-target report parity -- equivalent normalized evidence produces equivalent downstream results, under genuinely different target refs', () => {
  const contract = empireHomecare()
  const now = new Date('2026-07-20T12:00:00.000Z')
  const { scenarios } = generateContractScenarios(contract, undefined, now)

  it('found real scenarios to build a real ledger from -- a sanity check on the sweep itself', () => {
    expect(scenarios.length).toBeGreaterThan(0)
  })

  it('each path\'s own entries carry the correct, different target provenance end to end', async () => {
    const n8nEntries = buildEntriesViaN8n(contract, scenarios, now)
    const inMemoryEntries = await buildEntriesViaInMemory(contract, scenarios, now)

    expect(n8nEntries.length).toBeGreaterThan(0)
    expect(n8nEntries.every(e => e.targetId === 'n8n' && e.sourceWorkflowId === 'wf-real-n8n-workflow')).toBe(true)
    expect(inMemoryEntries.every(e => e.targetId === 'in-memory-test' && e.sourceWorkflowId === 'in-memory-workflow-1')).toBe(true)
  })

  it('checkSlaCompliance(), updateExceptionDesk(), buildPromiseReportData(), analyzeContractForAmendments(), deriveLearningNotesFromProposals(), and buildAutomationValueReport() all produce equivalent, genuinely non-vacuous business results given equivalent normalized evidence from two DIFFERENT real targets', async () => {
    const n8nEntries = buildEntriesViaN8n(contract, scenarios, now)
    const inMemoryEntries = await buildEntriesViaInMemory(contract, scenarios, now)
    expect(n8nEntries.length).toBe(inMemoryEntries.length)

    const n8nIdMap = idPlaceholderMap(n8nEntries)
    const inMemoryIdMap = idPlaceholderMap(inMemoryEntries)

    // 1. checkSlaCompliance() -- non-vacuous: this fixture's own no_response/missing_data
    // scenarios genuinely drift/go-unverifiable against Empire Homecare's real SLA.
    const n8nFindings = checkSlaCompliance(contract, n8nEntries, now)
    const inMemoryFindings = checkSlaCompliance(contract, inMemoryEntries, now)
    expect(n8nFindings.length).toBeGreaterThan(0)
    expect(redact(n8nFindings, n8nIdMap)).toEqual(redact(inMemoryFindings, inMemoryIdMap))

    // 2. updateExceptionDesk() -- non-vacuous: the no_response scenario's own drifting SLA
    // finding genuinely opens a real exception for this fixture/scenario set.
    const n8nExceptionResult = updateExceptionDesk(contract, n8nFindings, [], now)
    const inMemoryExceptionResult = updateExceptionDesk(contract, inMemoryFindings, [], now)
    expect(n8nExceptionResult.opened.length).toBeGreaterThan(0)
    expect(redact(n8nExceptionResult, n8nIdMap)).toEqual(redact(inMemoryExceptionResult, inMemoryIdMap))

    const n8nOpenedExceptions = n8nExceptionResult.opened
    const inMemoryOpenedExceptions = inMemoryExceptionResult.opened

    // 3. buildPromiseReportData() -- non-vacuous: 4 distinct scenario instances.
    const n8nReport = buildPromiseReportData(contract, n8nEntries, n8nOpenedExceptions, {}, now)
    const inMemoryReport = buildPromiseReportData(contract, inMemoryEntries, inMemoryOpenedExceptions, {}, now)
    expect(n8nReport.instances.length).toBeGreaterThan(0)
    expect(redact(n8nReport, n8nIdMap)).toEqual(redact(inMemoryReport, inMemoryIdMap))

    // 4. analyzeContractForAmendments() -- non-vacuous: this fixture's own never-reached
    // terminal states genuinely produce real unreached_state proposals. Provenance assertion:
    // each path's own kind: 'ledger_entry' evidence refs cite the CORRECT, DIFFERENT targetId.
    const n8nProposals = analyzeContractForAmendments(contract, n8nEntries, n8nOpenedExceptions, undefined, now)
    const inMemoryProposals = analyzeContractForAmendments(contract, inMemoryEntries, inMemoryOpenedExceptions, undefined, now)
    expect(n8nProposals.length).toBeGreaterThan(0)
    expect(n8nProposals.length).toBe(inMemoryProposals.length)
    const n8nLedgerRefs = n8nProposals.flatMap(p => p.evidence.filter(e => e.kind === 'ledger_entry'))
    const inMemoryLedgerRefs = inMemoryProposals.flatMap(p => p.evidence.filter(e => e.kind === 'ledger_entry'))
    expect(n8nLedgerRefs.length).toBeGreaterThan(0)
    expect(n8nLedgerRefs.every(r => r.targetId === 'n8n')).toBe(true)
    expect(inMemoryLedgerRefs.every(r => r.targetId === 'in-memory-test')).toBe(true)
    expect(redact(n8nProposals, n8nIdMap)).toEqual(redact(inMemoryProposals, inMemoryIdMap))

    // 5. deriveLearningNotesFromProposals() -- deriveDecision() (learning.ts) returns null for
    // status: 'proposed' (nobody has looked at it yet), so freshly-generated proposals alone
    // produce zero notes by design, not a bug -- accepting/rejecting a symmetric subset on BOTH
    // paths (a pure mirror of evolution-store.ts's own updateProposalStatus() transformation,
    // never real file I/O) is required to exercise this function's own real logic at all.
    const decisionTs = '2026-07-21T00:00:00.000Z'
    const n8nDecidedProposals = n8nProposals.map((p, i) => withDecision(p, i % 2 === 0 ? 'accepted' : 'rejected', decisionTs))
    const inMemoryDecidedProposals = inMemoryProposals.map((p, i) => withDecision(p, i % 2 === 0 ? 'accepted' : 'rejected', decisionTs))
    const n8nLearningNotes = deriveLearningNotesFromProposals(n8nDecidedProposals, now)
    const inMemoryLearningNotes = deriveLearningNotesFromProposals(inMemoryDecidedProposals, now)
    expect(n8nLearningNotes.length).toBeGreaterThan(0)
    expect(n8nLearningNotes.length).toBe(n8nDecidedProposals.length) // every decided proposal produces a note
    expect(redact(n8nLearningNotes, n8nIdMap)).toEqual(redact(inMemoryLearningNotes, inMemoryIdMap))

    // 6. buildAutomationValueReport() -- non-vacuous: minutesLineItem()'s own documented design
    // ("count > 0 never gates whether a line item appears") means a supplied assumption always
    // produces a visible line, even a "0 x N = 0" one -- both minutesSaved assumptions below are
    // supplied, so 2 real line items are expected regardless of this fixture's own counts.
    const assumptions = { minutesSavedPerKeptInstance: 5, minutesSavedPerResolvedException: 10, currency: 'USD', enteredBy: 'test', enteredAt: '2026-01-01T00:00:00.000Z' }
    const n8nValueReport = buildAutomationValueReport(n8nReport, assumptions)
    const inMemoryValueReport = buildAutomationValueReport(inMemoryReport, assumptions)
    expect(n8nValueReport.estimatedValue?.lineItems.length ?? 0).toBeGreaterThan(0)
    expect(redact(n8nValueReport, n8nIdMap)).toEqual(redact(inMemoryValueReport, inMemoryIdMap))
  })
})
