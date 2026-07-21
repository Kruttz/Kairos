import type { PromiseInstanceStatus } from './report.js'
import type { ExceptionKind } from './exception-types.js'
import type { ScenarioCategory, ScenarioExpectedOutcome } from './scenario-types.js'

/**
 * Kairos Contract Harness / Node Harness v0 (roadmap item 6, docs/plans/
 * intake-scenario-harness-plan.md §6). Types only -- see src/promise/harness.ts for the runner.
 */

export interface HarnessActualOutcome {
  reportStatus: PromiseInstanceStatus
  evidenceQuality?: 'specific' | 'generic'
  exceptionCount: number
  exceptionKinds: ExceptionKind[]
  /** The classification's own human-readable detail text (report.ts's
   * PromiseInstanceClassification.detail) -- carried through so a mismatch report can quote
   * exactly what the real code said, not just which enum value it returned. */
  detail: string
}

export interface ScenarioRunOutcome {
  scenarioId: string
  scenarioName: string
  category: ScenarioCategory
  passed: boolean
  expected: ScenarioExpectedOutcome
  actual: HarnessActualOutcome
  /** Human-readable, one entry per field that differed -- empty when passed. */
  mismatches: string[]
}

export interface HarnessResult {
  contractId: string
  contractVersion: number
  scenarioResults: ScenarioRunOutcome[]
  passCount: number
  failCount: number
}
