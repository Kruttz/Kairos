import type { PromiseInstanceStatus } from './report.js'
import type { ExceptionKind } from './exception-types.js'

/**
 * Contract Scenario Generator (roadmap item 5, docs/plans/intake-scenario-harness-plan.md §5).
 * Types only -- see src/promise/scenario.ts for the generator itself and harness.ts (item 6)
 * for the runner that consumes these.
 */

export type ScenarioCategory =
  | 'happy_path'
  | 'missing_data'
  | 'failure_terminal'
  | 'no_response'
  | 'duplicate_correlation'
  | 'after_hours'
  | 'in_progress'

export interface ScenarioTimelineEvent {
  id: string
  /** Relative to the scenario's own start (real "now" at generation/run time), never a fixed
   * absolute timestamp -- same timing-robustness principle this session's own hand-built
   * synthetic validation already proved out (generous, real-clock-relative offsets so a
   * classification outcome never depends on which real day/time the harness happens to run). */
  offset: { amount: number; unit: 'minutes' | 'hours' | 'days' }
  kind: 'instance_start' | 'evidence'
  /** Required when kind is 'evidence' -- must name a real ProcessContract.transitions[].id that
   * ALSO has a matching EvidenceRequirement. A generated scenario never fabricates evidence for
   * a transition the contract has no EvidenceRequirement for -- real ledger.ts extraction could
   * never produce such an entry either (no marker-node convention exists for it), so a scenario
   * that did would be testing something that can't happen in production. */
  transitionId?: string
  /** Required when kind is 'instance_start' -- must match a real StartCondition.initialState. */
  initialState?: string
  /** Synthetic evidence field values, keyed from the matching EvidenceRequirement.requiredFields
   * -- present only for kind: 'evidence'. */
  fields?: Record<string, string>
  /** Mirrors ProofLedgerEntry.status for this one entry -- defaults to 'observed' (complete)
   * when omitted. 'unverifiable' models ledger.ts's own real outcome for a marker node found
   * with a required field genuinely missing (extractExecutionEvidence, confirmed directly
   * against current code) -- a scenario using this is testing whether downstream classification
   * correctly treats an incomplete entry differently from a complete one, not a hypothetical. */
  evidenceStatus?: 'observed' | 'unverifiable'
}

export interface ScenarioExpectedOutcome {
  /** Reuses report.ts's real PromiseInstanceStatus type -- never a parallel enum. */
  reportStatus: PromiseInstanceStatus
  evidenceQuality?: 'specific' | 'generic'
  expectedExceptionCount: number
  /** Reuses exception-types.ts's real ExceptionKind type. */
  expectedExceptionKinds?: ExceptionKind[]
  /** Why this is the expected outcome, traced against the real classification code path it
   * exercises -- written before the harness is run against it, the same hand-verified-truth-
   * table discipline this session's synthetic validation already proved catches real
   * classification bugs, not just documents an assumption. */
  reasoning: string
}

export interface ContractScenario {
  id: string
  contractId: string
  contractVersion: number
  name: string
  category: ScenarioCategory
  description: string
  /** Always synthetic -- never derived from real client data. Generated scenarios use an
   * obviously-fake pattern (a `.test`-TLD-shaped value or a clearly-labeled synthetic id),
   * matching this whole arc's PII discipline. */
  correlationKeyValue: string
  timeline: ScenarioTimelineEvent[]
  expected: ScenarioExpectedOutcome
  /** Which contract elements this scenario exercises -- same traceability discipline as
   * compile.ts's ContractWorkflowTrace, so a scenario can be audited or regenerated against the
   * exact rule that produced it. */
  sourceElements: string[]
  provenance: {
    generatorVersion: string
    createdAt: string
  }
}

/** A category the generator deliberately did NOT produce a scenario for, and why -- e.g. no
 * `businessCalendar` for 'after_hours', or no evidence-backed path to any success/acceptable
 * terminal state for 'happy_path'. Surfaced explicitly rather than silently omitted, since a
 * missing category can itself be a real, worth-reporting finding about the contract's own
 * evidence-completeness (see docs/plans/intake-scenario-harness-plan.md §5's Shipped note). */
export interface ScenarioGenerationSkip {
  category: ScenarioCategory
  reason: string
}

export interface ScenarioGenerationResult {
  scenarios: ContractScenario[]
  skipped: ScenarioGenerationSkip[]
}
