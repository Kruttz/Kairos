import type { ExecutionTrace } from '../../library/types.js'

/**
 * Named drift checks (D1-D9 per docs/plans/reliability-suite-plan.md Phase 1). Each check is
 * a narrow, evidence-driven, pure function -- validator-rule style, not ML/statistical
 * anomaly detection. D1-D4 port the existing detectExecutionDrift() signals (see
 * telemetry/execution-drift.ts, kept unchanged and still used by `kairos trace`/MCP) into
 * individually named, individually testable checks. D9 is new, consuming the
 * originalBuildHash/liveExportHash hook the Delivery Bundle already shipped (0.11.0).
 *
 * D5-D8 (windowed error-rate, cadence, per-node duration, payload-schema) are not in this
 * module yet -- they need drift/baseline.ts's windowed baseline model, built next.
 */

export type DriftCheckId = 'D1' | 'D2' | 'D3' | 'D4' | 'D9'

export type DriftSeverity = 'info' | 'warning' | 'critical'

/**
 * Present only on checks built from error classification (D1) -- absent on checks with no
 * classification-confidence dimension (duration/node-set/hash comparisons are just numbers
 * or strings, nothing to be under- or over-confident about).
 *
 * 'specific' -- every fired-on error carried an httpCode and/or a real name beyond a bare
 * exception; Kairos can say *what kind* of failure this is.
 * 'generic' -- at least one fired-on error had no classification beyond 'UnknownError';
 * Kairos can say a node started erroring, but not confidently why. Conservative by design:
 * if any part of the evidence is uncertain, the whole finding is treated as uncertain rather
 * than reporting a false-confident average. diagnose.ts must not fabricate a cause for a
 * 'generic'-quality finding -- see reliability-suite-plan.md 6.3.
 */
export type DriftEvidenceQuality = 'specific' | 'generic'

export interface DriftCheckFinding {
  id: DriftCheckId
  /** False when there isn't enough history to evaluate this check at all -- distinct from a
   * check that ran and found nothing (fired: false). Never silently treated as "healthy". */
  sufficientData: boolean
  fired: boolean
  severity: DriftSeverity
  summary: string
  evidence: Record<string, unknown>
  evidenceQuality?: DriftEvidenceQuality
}

function insufficientData(id: DriftCheckId, why: string): DriftCheckFinding {
  return {
    id,
    sufficientData: false,
    fired: false,
    severity: 'info',
    summary: why,
    evidence: {},
  }
}

/**
 * D1 -- newly-erroring nodes. Ports detectExecutionDrift()'s signal, adding evidenceQuality
 * (see S1 finding in reliability-suite-plan.md): a node erroring for the first time is
 * reported with different confidence depending on whether the error carried a classifiable
 * name/httpCode or fell back to UnknownError.
 */
export function checkD1NewlyErroringNodes(traces: ExecutionTrace[]): DriftCheckFinding {
  if (traces.length < 2) return insufficientData('D1', 'Fewer than 2 traces recorded -- nothing to compare the latest run against.')

  const [latest, ...baseline] = traces as [ExecutionTrace, ...ExecutionTrace[]]
  const historicalErroredNames = new Set(baseline.flatMap(t => t.erroredNodes.map(e => e.name)))
  const newlyErroring = latest.erroredNodes.filter(e => !historicalErroredNames.has(e.name))
  const fired = newlyErroring.length > 0

  // Conservative: if ANY newly-erroring node lacks specific classification, the whole
  // finding is 'generic' -- never average toward false confidence.
  const evidenceQuality: DriftEvidenceQuality | undefined = fired
    ? (newlyErroring.every(e => e.errorType !== 'UnknownError' || e.httpCode !== undefined) ? 'specific' : 'generic')
    : undefined

  return {
    id: 'D1',
    sufficientData: true,
    fired,
    severity: fired ? 'critical' : 'info',
    summary: fired
      ? `${newlyErroring.length} node(s) erroring that never errored in prior recorded runs: ${newlyErroring.map(e => e.name).join(', ')}.`
      : 'No nodes are erroring that did not also error historically.',
    evidence: { newlyErroringNodes: newlyErroring },
    ...(evidenceQuality ? { evidenceQuality } : {}),
  }
}

const DURATION_ANOMALY_RATIO = 2.0
const MIN_BASELINE_MS_FOR_DURATION_CHECK = 100

/** D2 -- workflow-level duration anomaly. Ports detectExecutionDrift()'s signal as-is. */
export function checkD2DurationAnomaly(traces: ExecutionTrace[]): DriftCheckFinding {
  if (traces.length < 2) return insufficientData('D2', 'Fewer than 2 traces recorded -- no baseline duration to compare against.')

  const [latest, ...baseline] = traces as [ExecutionTrace, ...ExecutionTrace[]]
  const baselineDurations = baseline.map(t => t.durationMs).filter((d): d is number => d !== null)

  if (latest.durationMs === null || baselineDurations.length === 0) {
    return insufficientData('D2', 'Latest run or baseline is missing duration data.')
  }

  const baselineAvgMs = baselineDurations.reduce((sum, d) => sum + d, 0) / baselineDurations.length
  if (baselineAvgMs < MIN_BASELINE_MS_FOR_DURATION_CHECK) {
    return {
      id: 'D2',
      sufficientData: true,
      fired: false,
      severity: 'info',
      summary: `Baseline average (${baselineAvgMs.toFixed(1)}ms) is too fast to check reliably -- small absolute differences would read as large, meaningless ratios.`,
      evidence: { baselineAvgMs },
    }
  }

  const ratio = latest.durationMs / baselineAvgMs
  const fired = ratio > DURATION_ANOMALY_RATIO

  return {
    id: 'D2',
    sufficientData: true,
    fired,
    severity: fired ? 'warning' : 'info',
    summary: fired
      ? `Latest run took ${latest.durationMs}ms, ${ratio.toFixed(1)}x the historical average of ${baselineAvgMs.toFixed(1)}ms.`
      : `Latest run duration (${latest.durationMs}ms) is within normal range of the historical average (${baselineAvgMs.toFixed(1)}ms).`,
    evidence: { latestMs: latest.durationMs, baselineAvgMs, ratio },
  }
}

/** D3 -- missing core nodes. Ports detectExecutionDrift()'s signal as-is. */
export function checkD3MissingCoreNodes(traces: ExecutionTrace[]): DriftCheckFinding {
  if (traces.length < 2) return insufficientData('D3', 'Fewer than 2 traces recorded -- no baseline node set to compare against.')

  const [latest, ...baseline] = traces as [ExecutionTrace, ...ExecutionTrace[]]
  // A "core" node ran in every single historical trace -- consistent enough that its absence
  // now is a meaningful signal, not just a conditional branch that happened not to fire.
  const coreNodes = baseline.length > 0
    ? baseline[0]!.executedNodes.filter(name => baseline.every(t => t.executedNodes.includes(name)))
    : []
  const latestExecutedSet = new Set(latest.executedNodes)
  const missingCoreNodes = coreNodes.filter(name => !latestExecutedSet.has(name))
  const fired = missingCoreNodes.length > 0

  return {
    id: 'D3',
    sufficientData: true,
    fired,
    severity: fired ? 'critical' : 'info',
    summary: fired
      ? `${missingCoreNodes.length} node(s) that ran in every prior recorded run are absent from the latest run: ${missingCoreNodes.join(', ')}.`
      : 'All historically-consistent nodes ran in the latest run.',
    evidence: { missingCoreNodes, coreNodes },
  }
}

/** D4 -- new nodes. Ports detectExecutionDrift()'s signal as-is. */
export function checkD4NewNodes(traces: ExecutionTrace[]): DriftCheckFinding {
  if (traces.length < 2) return insufficientData('D4', 'Fewer than 2 traces recorded -- no baseline node set to compare against.')

  const [latest, ...baseline] = traces as [ExecutionTrace, ...ExecutionTrace[]]
  const historicalExecutedNames = new Set(baseline.flatMap(t => t.executedNodes))
  const newNodes = latest.executedNodes.filter(name => !historicalExecutedNames.has(name))
  const fired = newNodes.length > 0

  return {
    id: 'D4',
    sufficientData: true,
    fired,
    severity: fired ? 'warning' : 'info',
    summary: fired
      ? `${newNodes.length} node(s) ran in the latest run that never appeared in any prior recorded run: ${newNodes.join(', ')}.`
      : 'No new nodes appeared in the latest run.',
    evidence: { newNodes },
  }
}

/**
 * D9 -- build-vs-live structural drift. Consumes the originalBuildHash/liveExportHash hook
 * the Delivery Bundle already shipped (0.11.0, pack-bundle.ts) rather than computing hashes
 * itself -- a pure comparison, decoupled from how the caller obtained either value (a pack
 * file's provenance, a live n8n fetch through computeWorkflowHash(), etc.).
 *
 * Unlike D1-D4, this needs no trace history -- it's a single-point-in-time comparison, so
 * "insufficient data" doesn't apply the same way. When there's no original build hash on
 * record (the workflow predates provenance tracking, or was never built by Kairos), the
 * check reports sufficientData: false rather than guessing.
 */
export function checkD9BuildVsLiveDrift(
  originalBuildHash: string | undefined,
  liveExportHash: string,
): DriftCheckFinding {
  if (originalBuildHash === undefined) {
    return insufficientData('D9', 'No original build hash on record -- this workflow predates provenance tracking or was not built by Kairos.')
  }

  const fired = originalBuildHash !== liveExportHash

  return {
    id: 'D9',
    sufficientData: true,
    fired,
    severity: fired ? 'warning' : 'info',
    summary: fired
      ? 'The deployed workflow no longer matches what Kairos originally built -- it was likely hand-edited in n8n since deployment.'
      : 'The deployed workflow still matches what Kairos originally built.',
    evidence: { originalBuildHash, liveExportHash },
  }
}
