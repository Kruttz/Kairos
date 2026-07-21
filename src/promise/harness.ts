import { hashCorrelationKeyValue } from './ledger.js'
import { checkSlaCompliance } from './sla-compliance.js'
import { updateExceptionDesk } from './exception-desk.js'
import { classifyPromiseInstance } from './report.js'
import type { ProcessContract } from './types.js'
import type { ProofLedgerEntry } from './ledger-types.js'
import type { ContractScenario, ScenarioTimelineEvent } from './scenario-types.js'
import type { HarnessResult, ScenarioRunOutcome, HarnessActualOutcome } from './harness-types.js'

/**
 * Kairos Contract Harness / Node Harness v0 (roadmap item 6, docs/plans/
 * intake-scenario-harness-plan.md §6) -- Jordan's own name for this from `Futrure copy.txt` §7,
 * chosen there because "it says exactly what it does: tests the contract."
 *
 * The single load-bearing design rule, stated once here because every other design choice in
 * this module follows from it: this harness calls the REAL, unmodified checkSlaCompliance(),
 * updateExceptionDesk(), and classifyPromiseInstance() functions -- the exact same functions
 * `kairos watch --contracts` and `kairos contract report` call in production. It never
 * reimplements SLA/exception/classification logic. A scenario's `timeline` is turned into a
 * plain in-memory ProofLedgerEntry[] and fed directly to those functions; nothing about this
 * module could ever diverge from what production actually does, because it IS what production
 * does, just fed synthetic evidence instead of a real n8n poll. This is not a new idea invented
 * for this module -- it is the exact pattern this session's own hand-built synthetic
 * contact-form validation already proved works, by hand, once (seed-cases.mts calling
 * appendProofLedgerEntries()/hashCorrelationKeyValue() directly, run-compliance.mts calling
 * checkSlaCompliance()/updateExceptionDesk() directly) -- this module formalizes that one-off
 * script into a permanent, reusable feature.
 *
 * Deliberately pure and offline: no file I/O (never touches ledger-store.ts/exception-store.ts,
 * confirmed unnecessary because checkSlaCompliance()/classifyPromiseInstance() already take
 * plain in-memory ProofLedgerEntry[] arrays, not a file path -- verified directly against
 * current signatures before writing this), no n8n, no network, no LLM call. Fast enough to run
 * in the default `npm test` suite without violating the no-network guard.
 */

const HARNESS_WORKFLOW_ID = 'harness-synthetic-workflow'

function offsetToMs(offset: ScenarioTimelineEvent['offset']): number {
  switch (offset.unit) {
    case 'minutes': return offset.amount * 60_000
    case 'hours': return offset.amount * 60 * 60_000
    case 'days': return offset.amount * 24 * 60 * 60_000
  }
}

function fieldsToDetail(fields: Record<string, string> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return 'evidence -- (no fields)'
  return `evidence -- ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')}`
}

/** Converts one scenario's timeline into a plain ProofLedgerEntry[] -- the exact shape
 * ledger.ts's own extractExecutionEvidence() would have produced from a real execution, built
 * directly instead of extracted from n8n JSON. `now` anchors every offset (see
 * scenario.ts's own doc comment on offset semantics: positive amount = that many units before
 * `now`). */
export function buildLedgerEntriesForScenario(scenario: ContractScenario, now: Date = new Date()): ProofLedgerEntry[] {
  const promiseInstanceId = hashCorrelationKeyValue(scenario.correlationKeyValue)

  return scenario.timeline.map((event): ProofLedgerEntry => {
    const eventTime = new Date(now.getTime() - offsetToMs(event.offset)).toISOString()
    const base = {
      id: `${scenario.id}:${event.id}`,
      contractId: scenario.contractId,
      contractVersion: scenario.contractVersion,
      promiseInstanceId,
      correlationKeyValueHash: promiseInstanceId,
      observedAt: eventTime,
      eventTime,
      sourceWorkflowId: HARNESS_WORKFLOW_ID,
      sourceExecutionId: `${scenario.id}:${event.id}:exec`,
    }

    if (event.kind === 'instance_start') {
      return {
        ...base,
        kind: 'instance_start',
        initialState: event.initialState!,
        status: 'observed',
        detail: `New instance began in state "${event.initialState}".`,
      }
    }

    return {
      ...base,
      kind: 'evidence',
      transitionId: event.transitionId!,
      status: event.evidenceStatus ?? 'observed',
      detail: fieldsToDetail(event.fields),
    }
  })
}

function compareOutcome(scenario: ContractScenario, actual: HarnessActualOutcome): string[] {
  const mismatches: string[] = []
  const expected = scenario.expected

  if (actual.reportStatus !== expected.reportStatus) {
    mismatches.push(`reportStatus: expected "${expected.reportStatus}", got "${actual.reportStatus}" (detail: ${actual.detail})`)
  }
  if (expected.evidenceQuality !== undefined && actual.evidenceQuality !== expected.evidenceQuality) {
    mismatches.push(`evidenceQuality: expected "${expected.evidenceQuality}", got ${actual.evidenceQuality ? `"${actual.evidenceQuality}"` : 'undefined'}`)
  }
  if (actual.exceptionCount !== expected.expectedExceptionCount) {
    mismatches.push(`exceptionCount: expected ${expected.expectedExceptionCount}, got ${actual.exceptionCount}`)
  }
  if (expected.expectedExceptionKinds) {
    const expectedSorted = [...expected.expectedExceptionKinds].sort()
    const actualSorted = [...actual.exceptionKinds].sort()
    if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
      mismatches.push(`exceptionKinds: expected [${expectedSorted.join(', ')}], got [${actualSorted.join(', ')}]`)
    }
  }

  return mismatches
}

/** Runs one scenario through the real evaluation chain and compares the result against its own
 * `expected` field. Never touches disk/network -- existingItems is always [] (a fresh harness
 * run has no prior exception history to refresh against), matching a scenario's own
 * self-contained, single-instance design. */
export function runScenario(contract: ProcessContract, scenario: ContractScenario, now: Date = new Date()): ScenarioRunOutcome {
  const entries = buildLedgerEntriesForScenario(scenario, now)
  const findings = checkSlaCompliance(contract, entries, now)
  const { opened } = updateExceptionDesk(contract, findings, [], now)
  const classification = classifyPromiseInstance(contract, entries, opened, now)

  const actual: HarnessActualOutcome = {
    reportStatus: classification.status,
    exceptionCount: opened.length,
    exceptionKinds: opened.map(i => i.kind),
    detail: classification.detail,
    ...(classification.evidenceQuality ? { evidenceQuality: classification.evidenceQuality } : {}),
  }

  const mismatches = compareOutcome(scenario, actual)

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    passed: mismatches.length === 0,
    expected: scenario.expected,
    actual,
    mismatches,
  }
}

export function runContractHarness(contract: ProcessContract, scenarios: ContractScenario[], now: Date = new Date()): HarnessResult {
  const scenarioResults = scenarios.map(s => runScenario(contract, s, now))
  return {
    contractId: contract.id,
    contractVersion: contract.version,
    scenarioResults,
    passCount: scenarioResults.filter(r => r.passed).length,
    failCount: scenarioResults.filter(r => !r.passed).length,
  }
}
