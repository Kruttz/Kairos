import type { PromiseReportData } from './report.js'

/**
 * Automation P&L / Value Report (roadmap item 13, docs/plans/contract-evolution-ops-roadmap-plan.md
 * §3, item 13). Types only -- see src/promise/value-report.ts for the pure computation/render
 * logic.
 *
 * The whole point of this type shape is structural, not just documented: every numeric field on
 * `ImpactAssumptions` is optional with no default anywhere in this codebase, so a value figure
 * literally cannot be computed without a human having entered the specific multiplier it needs.
 * This is the same "human supplies the real-world number, Kairos never guesses it" pattern
 * `generateImpactNotesTemplate()` (pack-exporter.ts) already established -- applied here to
 * recurring Promise Report data instead of a one-time diagnostic-call worksheet. A prior
 * "automatic ROI math" concept (an early "roi-ledger.md" idea) was proposed and explicitly
 * rejected in this codebase's own history for exactly the risk this file's own discipline exists
 * to avoid: fabricated-precision numbers erode trust faster than no numbers at all.
 */

export interface ImpactAssumptions {
  /** All optional, all human-entered, all blank-if-unknown -- never defaulted, inferred, or
   * benchmarked by Kairos itself, from any source. */
  minutesSavedPerKeptInstance?: number
  minutesSavedPerResolvedException?: number
  dollarValuePerResolvedException?: number
  /** An instance that would plausibly have been 'missed' without the exception being caught and
   * resolved -- deliberately keyed to `resolvedExceptionCount`, the same real, already-computed
   * count `PromiseReportData` carries, not a separate invented "avoided misses" count. */
  dollarValuePerAvoidedMiss?: number
  /** Required (and validated as present) only when a dollar-denominated field above is present --
   * never defaulted to a currency Kairos assumes on the human's behalf. */
  currency?: string
  enteredBy?: string
  enteredAt?: string
}

export interface ValueLineItem {
  label: string
  /** Literal, human-readable arithmetic, e.g. "42 resolved exception(s) x 15 min = 630 min" --
   * every value figure this report ever shows carries its own derivation inline, never a bare
   * final number. */
  formula: string
  count: number
  perUnitAssumption: number
  total: number
  unit: 'minutes' | 'hours' | 'currency'
}

export interface AutomationValueReport {
  /** Unchanged `PromiseReportData` -- the Observed section, always present, zero assumptions
   * needed, a strict superset of `kairos contract report`'s own output. */
  observed: PromiseReportData
  /** Present only when at least one ImpactAssumptions field was supplied and produced at least
   * one real line item. */
  estimatedValue?: {
    lineItems: ValueLineItem[]
    assumptionsUsed: ImpactAssumptions
    /** Always present whenever this section exists -- "estimated from assumptions entered by X
     * on Y, not measured directly." Never omitted, regardless of how confident the numbers look. */
    disclaimer: string
  }
}
