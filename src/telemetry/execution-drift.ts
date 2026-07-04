import type { ExecutionTrace } from '../library/types.js'

/**
 * Runtime execution drift for a deployed workflow — distinct from the unrelated
 * DriftReport in pattern-analyzer.ts, which tracks validator-rule-coverage drift.
 * This compares a workflow's most recent execution against its own trace history
 * to flag "this deployed workflow now behaves differently than it used to."
 */
export interface ExecutionDriftReport {
  hasDrift: boolean
  /** False when fewer than 2 traces exist — nothing to compare the latest run against */
  sufficientData: boolean
  /** Nodes erroring in the latest run that never errored in any prior recorded run */
  newlyErroringNodes: string[]
  /** Present when the latest run's duration is more than 2x the historical average */
  durationAnomaly: { latestMs: number; baselineAvgMs: number; ratio: number } | null
  /** Nodes that ran in every prior recorded run but are absent from the latest run */
  missingCoreNodes: string[]
  /** Nodes in the latest run that never appeared in any prior recorded run */
  newNodes: string[]
}

const DURATION_ANOMALY_RATIO = 2.0
// Guard against noise on trivially fast baselines, where small absolute differences
// produce large, meaningless ratios (e.g. 5ms -> 12ms reads as "2.4x slower").
const MIN_BASELINE_MS_FOR_DURATION_CHECK = 100

/**
 * Compares the most recent trace (traces[0], per mergeTraces' descending sort)
 * against the historical baseline (the rest) to flag runtime drift.
 */
export function detectExecutionDrift(traces: ExecutionTrace[]): ExecutionDriftReport {
  const empty: ExecutionDriftReport = {
    hasDrift: false,
    sufficientData: false,
    newlyErroringNodes: [],
    durationAnomaly: null,
    missingCoreNodes: [],
    newNodes: [],
  }

  if (traces.length < 2) return empty

  const [latest, ...baseline] = traces as [ExecutionTrace, ...ExecutionTrace[]]

  const historicalErroredNames = new Set(
    baseline.flatMap(t => t.erroredNodes.map(e => e.name)),
  )
  const newlyErroringNodes = latest.erroredNodes
    .map(e => e.name)
    .filter(name => !historicalErroredNames.has(name))

  let durationAnomaly: ExecutionDriftReport['durationAnomaly'] = null
  const baselineDurations = baseline
    .map(t => t.durationMs)
    .filter((d): d is number => d !== null)
  if (latest.durationMs !== null && baselineDurations.length > 0) {
    const baselineAvgMs = baselineDurations.reduce((sum, d) => sum + d, 0) / baselineDurations.length
    if (baselineAvgMs >= MIN_BASELINE_MS_FOR_DURATION_CHECK) {
      const ratio = latest.durationMs / baselineAvgMs
      if (ratio > DURATION_ANOMALY_RATIO) {
        durationAnomaly = { latestMs: latest.durationMs, baselineAvgMs, ratio }
      }
    }
  }

  // A "core" node is one that ran in every single historical trace — consistent
  // enough that its absence now is a meaningful signal, not just a conditional branch.
  const coreNodes = baseline.length > 0
    ? baseline[0]!.executedNodes.filter(name => baseline.every(t => t.executedNodes.includes(name)))
    : []
  const latestExecutedSet = new Set(latest.executedNodes)
  const missingCoreNodes = coreNodes.filter(name => !latestExecutedSet.has(name))

  const historicalExecutedNames = new Set(baseline.flatMap(t => t.executedNodes))
  const newNodes = latest.executedNodes.filter(name => !historicalExecutedNames.has(name))

  const hasDrift = newlyErroringNodes.length > 0
    || durationAnomaly !== null
    || missingCoreNodes.length > 0
    || newNodes.length > 0

  return {
    hasDrift,
    sufficientData: true,
    newlyErroringNodes,
    durationAnomaly,
    missingCoreNodes,
    newNodes,
  }
}
