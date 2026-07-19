import type { ExecutionTrace } from '../../library/types.js'

/**
 * Named drift checks (D1-D9 per docs/plans/reliability-suite-plan.md Phase 1). Each check is
 * a narrow, evidence-driven, pure function -- validator-rule style, not ML/statistical
 * anomaly detection. D1-D4 port the existing detectExecutionDrift() signals (see
 * telemetry/execution-drift.ts, kept unchanged and still used by `kairos trace`/MCP) into
 * individually named, individually testable checks. D5-D9 are new.
 */

export type DriftCheckId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9'

export type DriftSeverity = 'info' | 'warning' | 'critical'

/**
 * Four distinct states, never conflated:
 * - 'insufficient_data' -- not enough history YET to evaluate. Temporary: will resolve to one
 *   of the other three states once more traces/executions accumulate.
 * - 'not_applicable' -- this check fundamentally does not apply to this workflow, permanently
 *   (not a "wait for more data" situation). E.g. D9 when the workflow was never built by
 *   Kairos; D8 when payload capture was never enabled; D6 when the workflow's own trigger
 *   pattern is genuinely irregular (no meaningful "expected cadence" to violate).
 * - 'healthy' -- the check ran, had what it needed, found no drift.
 * - 'drifting' -- the check ran, had what it needed, found drift. severity is only
 *   meaningful in this state.
 */
export type DriftCheckStatus = 'insufficient_data' | 'not_applicable' | 'healthy' | 'drifting'

/**
 * Present only on checks built from error classification (D1) -- absent on checks with no
 * classification-confidence dimension (duration/node-set/hash comparisons are just numbers
 * or strings, nothing to be under- or over-confident about).
 *
 * 'specific' -- every drifting-relevant error carried an httpCode and/or a real name beyond a
 * bare exception; Kairos can say *what kind* of failure this is.
 * 'generic' -- at least one relevant error had no classification beyond 'UnknownError';
 * Kairos can say a node started erroring, but not confidently why. Conservative by design:
 * if any part of the evidence is uncertain, the whole finding is treated as uncertain rather
 * than reporting a false-confident average. diagnose.ts must not fabricate a cause for a
 * 'generic'-quality finding -- see reliability-suite-plan.md 6.3.
 */
export type DriftEvidenceQuality = 'specific' | 'generic'

export interface DriftCheckFinding {
  id: DriftCheckId
  status: DriftCheckStatus
  severity: DriftSeverity
  summary: string
  evidence: Record<string, unknown>
  evidenceQuality?: DriftEvidenceQuality
}

function insufficientData(id: DriftCheckId, why: string): DriftCheckFinding {
  return { id, status: 'insufficient_data', severity: 'info', summary: why, evidence: {} }
}

function notApplicable(id: DriftCheckId, why: string, evidence: Record<string, unknown> = {}): DriftCheckFinding {
  return { id, status: 'not_applicable', severity: 'info', summary: why, evidence }
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
  const drifting = newlyErroring.length > 0

  // Conservative: if ANY newly-erroring node lacks specific classification, the whole
  // finding is 'generic' -- never average toward false confidence.
  const evidenceQuality: DriftEvidenceQuality | undefined = drifting
    ? (newlyErroring.every(e => e.errorType !== 'UnknownError' || e.httpCode !== undefined) ? 'specific' : 'generic')
    : undefined

  return {
    id: 'D1',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'critical' : 'info',
    summary: drifting
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
    return notApplicable(
      'D2',
      `Baseline average (${baselineAvgMs.toFixed(1)}ms) is too fast to check reliably -- small absolute differences would read as large, meaningless ratios. Will not become applicable with more data at this speed.`,
      { baselineAvgMs },
    )
  }

  const ratio = latest.durationMs / baselineAvgMs
  const drifting = ratio > DURATION_ANOMALY_RATIO

  return {
    id: 'D2',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'warning' : 'info',
    summary: drifting
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
  const drifting = missingCoreNodes.length > 0

  return {
    id: 'D3',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'critical' : 'info',
    summary: drifting
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
  const drifting = newNodes.length > 0

  return {
    id: 'D4',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'warning' : 'info',
    summary: drifting
      ? `${newNodes.length} node(s) ran in the latest run that never appeared in any prior recorded run: ${newNodes.join(', ')}.`
      : 'No new nodes appeared in the latest run.',
    evidence: { newNodes },
  }
}

const MIN_TRACES_FOR_WINDOWED_CHECKS = 6
const ERROR_RATE_DRIFT_THRESHOLD = 0.25 // 25 percentage points, recent window vs older window

/**
 * D5 -- windowed error-rate drift. Distinct from D1: D1 catches a single node erroring for
 * the first time (a point event); D5 catches gradual degradation across many runs that D1
 * would miss entirely if no single node crosses from "never errored" to "errored" -- e.g. an
 * error rate creeping from 5% to 40% while the *set* of erroring nodes stays the same.
 *
 * Splits the trace history (most-recent-first, per mergeTraces' sort contract) into a recent
 * half and an older half, compares error rate between them. Needs enough traces for both
 * halves to be meaningful -- MIN_TRACES_FOR_WINDOWED_CHECKS, not just the 2 that suffice for
 * a single-point comparison.
 */
export function checkD5ErrorRateDrift(traces: ExecutionTrace[]): DriftCheckFinding {
  if (traces.length < MIN_TRACES_FOR_WINDOWED_CHECKS) {
    return insufficientData(
      'D5',
      `Fewer than ${MIN_TRACES_FOR_WINDOWED_CHECKS} traces recorded -- not enough to split into a meaningful recent-vs-older window comparison.`,
    )
  }

  const mid = Math.floor(traces.length / 2)
  const recentWindow = traces.slice(0, mid)
  const olderWindow = traces.slice(mid)

  const errorRate = (window: ExecutionTrace[]): number =>
    window.filter(t => t.status === 'error').length / window.length

  const recentErrorRate = errorRate(recentWindow)
  const olderErrorRate = errorRate(olderWindow)
  const delta = recentErrorRate - olderErrorRate
  const drifting = delta >= ERROR_RATE_DRIFT_THRESHOLD

  return {
    id: 'D5',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'warning' : 'info',
    summary: drifting
      ? `Error rate has risen from ${(olderErrorRate * 100).toFixed(0)}% to ${(recentErrorRate * 100).toFixed(0)}% across the recorded window -- a gradual degradation, not necessarily tied to any single node.`
      : `Error rate is stable (${(olderErrorRate * 100).toFixed(0)}% -> ${(recentErrorRate * 100).toFixed(0)}%).`,
    evidence: {
      recentErrorRate,
      olderErrorRate,
      delta,
      recentWindowSize: recentWindow.length,
      olderWindowSize: olderWindow.length,
    },
  }
}

const MIN_TRACES_FOR_CADENCE = 3
const CADENCE_COEFFICIENT_OF_VARIATION_LIMIT = 1.5 // above this, gaps are too irregular to have a meaningful "expected" cadence
const SILENT_STOP_RATIO_THRESHOLD = 3.0

/**
 * D6 -- cadence drift / silent-stop. The scariest failure class for a client: a workflow that
 * quietly stopped firing produces no error to alert on, just silence. Detectable only by
 * comparing "time since the last execution" against how often this workflow has historically
 * run.
 *
 * Has a genuine not_applicable case, distinct from insufficient_data: some workflows are
 * legitimately irregular (ad hoc manually-triggered, event-driven with no expected rhythm) --
 * for those, there is no meaningful "expected cadence" to violate, and flagging silence would
 * be a false signal, not a cautious one. Measured via coefficient of variation on historical
 * gaps between executions: high CoV means the workflow's own history shows no real rhythm to
 * begin with, and more data won't fix that -- it's a property of the workflow, not the
 * dataset size.
 *
 * `now` is an explicit parameter (defaulting to real current time) rather than reading
 * Date.now() internally, so this stays a pure, testable function like every other check here.
 */
export function checkD6CadenceDrift(traces: ExecutionTrace[], now: Date = new Date()): DriftCheckFinding {
  if (traces.length < MIN_TRACES_FOR_CADENCE) {
    return insufficientData(
      'D6',
      `Fewer than ${MIN_TRACES_FOR_CADENCE} traces recorded -- not enough executions to establish a cadence baseline.`,
    )
  }

  // traces[0] is most recent per mergeTraces' descending-sort contract.
  const sorted = [...traces].sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
  const gaps: number[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    gaps.push(new Date(sorted[i]!.recordedAt).getTime() - new Date(sorted[i + 1]!.recordedAt).getTime())
  }

  const meanGapMs = gaps.reduce((sum, g) => sum + g, 0) / gaps.length
  const variance = gaps.reduce((sum, g) => sum + (g - meanGapMs) ** 2, 0) / gaps.length
  const stdDevMs = Math.sqrt(variance)
  const coefficientOfVariation = meanGapMs > 0 ? stdDevMs / meanGapMs : Infinity

  if (coefficientOfVariation > CADENCE_COEFFICIENT_OF_VARIATION_LIMIT) {
    return notApplicable(
      'D6',
      'Historical execution gaps are too irregular to establish a meaningful expected cadence -- this workflow appears to run ad hoc rather than on a rhythm, so silent-stop detection does not apply to it.',
      { coefficientOfVariation, meanGapMs },
    )
  }

  const medianGapMs = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!
  const gapSinceLatestMs = now.getTime() - new Date(sorted[0]!.recordedAt).getTime()
  const ratio = medianGapMs > 0 ? gapSinceLatestMs / medianGapMs : 0
  const drifting = ratio > SILENT_STOP_RATIO_THRESHOLD

  return {
    id: 'D6',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'critical' : 'info',
    summary: drifting
      ? `No execution recorded in ${(gapSinceLatestMs / 60000).toFixed(0)} minutes -- ${ratio.toFixed(1)}x the median gap between runs (${(medianGapMs / 60000).toFixed(1)} min). This workflow may have silently stopped firing.`
      : `Time since last execution (${(gapSinceLatestMs / 60000).toFixed(1)} min) is within normal range of the median gap (${(medianGapMs / 60000).toFixed(1)} min).`,
    evidence: { gapSinceLatestMs, medianGapMs, ratio, coefficientOfVariation },
  }
}

/**
 * D7 -- per-node duration anomaly. D2 at node granularity: a workflow's total duration can
 * look normal while one specific node has quietly gotten much slower (offset by another node
 * getting faster, or simply too small a fraction of total time for D2's workflow-level ratio
 * to notice).
 *
 * Has a real not_applicable case: if no baseline trace recorded any per-node duration data at
 * all (e.g. an n8n version/execution mode that doesn't report executionTime), there is
 * nothing for this check to compare against, permanently -- not a "wait for more traces"
 * situation.
 */
export function checkD7PerNodeDurationAnomaly(traces: ExecutionTrace[]): DriftCheckFinding {
  if (traces.length < 2) return insufficientData('D7', 'Fewer than 2 traces recorded -- no per-node baseline to compare against.')

  const [latest, ...baseline] = traces as [ExecutionTrace, ...ExecutionTrace[]]
  const anyBaselineDurationData = baseline.some(t => Object.keys(t.nodeDurations).length > 0)
  if (!anyBaselineDurationData) {
    return notApplicable('D7', 'No baseline trace recorded any per-node duration data -- nothing to compare against.')
  }

  const anomalousNodes: Array<{ name: string; latestMs: number; baselineAvgMs: number; ratio: number }> = []

  for (const [nodeName, latestMs] of Object.entries(latest.nodeDurations)) {
    const baselineDurationsForNode = baseline
      .map(t => t.nodeDurations[nodeName])
      .filter((d): d is number => d !== undefined)
    if (baselineDurationsForNode.length === 0) continue // new node -- D4's job, not D7's

    const baselineAvgMs = baselineDurationsForNode.reduce((sum, d) => sum + d, 0) / baselineDurationsForNode.length
    if (baselineAvgMs < MIN_BASELINE_MS_FOR_DURATION_CHECK) continue // same noise guard as D2, per-node

    const ratio = latestMs / baselineAvgMs
    if (ratio > DURATION_ANOMALY_RATIO) {
      anomalousNodes.push({ name: nodeName, latestMs, baselineAvgMs, ratio })
    }
  }

  const drifting = anomalousNodes.length > 0

  return {
    id: 'D7',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'warning' : 'info',
    summary: drifting
      ? `${anomalousNodes.length} node(s) running significantly slower than their own historical average: ${anomalousNodes.map(n => `${n.name} (${n.ratio.toFixed(1)}x)`).join(', ')}.`
      : 'All nodes with duration history are running within normal range of their own baseline.',
    evidence: { anomalousNodes },
  }
}

/** A flattened field-path -> simple type-tag shape, e.g. {"body.customerName": "string"}. */
export type PayloadShape = Record<string, string>

/**
 * D8 -- payload-schema drift. Explicitly capture-dependent (docs/plans/reliability-suite-plan.md
 * C3/C6): only meaningful once `kairos replay capture` has been opted into for a workflow.
 * Capture itself (replay/capture.ts) is Phase 2 scope, not built yet -- this check function is
 * built now, complete and tested, so Phase 2 only has to wire real captured shapes in rather
 * than design the comparison logic under time pressure later.
 *
 * The canonical not_applicable case for this whole arc: until capture is enabled, this check
 * does not apply -- not because of missing traces (more executions won't fix it), but because
 * the feature it depends on was never turned on. Reported as not_applicable, not
 * insufficient_data, so a user reading a report understands *why* nothing is being checked.
 */
export function checkD8PayloadSchemaDrift(
  latestPayloadShape: PayloadShape | undefined,
  baselinePayloadShape: PayloadShape | undefined,
): DriftCheckFinding {
  if (!latestPayloadShape || !baselinePayloadShape) {
    return notApplicable(
      'D8',
      'Payload capture is not enabled for this workflow -- run `kairos replay capture` to enable payload-schema drift detection.',
    )
  }

  const baselineKeys = Object.keys(baselinePayloadShape)
  const latestKeys = Object.keys(latestPayloadShape)
  const missingKeys = baselineKeys.filter(k => !latestKeys.includes(k))
  const newKeys = latestKeys.filter(k => !baselineKeys.includes(k))
  const typeChangedKeys = baselineKeys
    .filter(k => latestKeys.includes(k) && baselinePayloadShape[k] !== latestPayloadShape[k])
    .map(k => ({ key: k, from: baselinePayloadShape[k]!, to: latestPayloadShape[k]! }))

  // Missing/type-changed fields are the likely-breaking cases; a purely additive new field
  // (an optional field a client started sending) is reported but does not drive the verdict.
  const drifting = missingKeys.length > 0 || typeChangedKeys.length > 0

  return {
    id: 'D8',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'warning' : 'info',
    summary: drifting
      ? `Latest payload shape differs from the established baseline: ${missingKeys.length} field(s) missing, ${typeChangedKeys.length} field(s) changed type. This is a heuristic inference from captured payloads, not a verified contract -- see the field-extraction DISCLAIMER precedent in pack/webhook-schema.ts.`
      : 'Latest payload shape matches the established baseline (heuristic, from captured payloads).',
    evidence: { missingKeys, newKeys, typeChangedKeys },
  }
}

/**
 * D9 -- build-vs-live structural drift. Consumes the originalBuildHash/liveExportHash hook
 * the Delivery Bundle already shipped (0.11.0, pack-bundle.ts) rather than computing hashes
 * itself -- a pure comparison, decoupled from how the caller obtained either value (a pack
 * file's provenance, a live n8n fetch through computeWorkflowHash(), etc.).
 *
 * Has a genuine not_applicable case, distinct from insufficient_data: when there's no
 * original build hash on record (the workflow predates provenance tracking, or was never
 * built by Kairos at all), that is permanent -- no amount of waiting produces a build hash
 * for a workflow Kairos never built.
 */
export function checkD9BuildVsLiveDrift(
  originalBuildHash: string | undefined,
  liveExportHash: string,
): DriftCheckFinding {
  if (originalBuildHash === undefined) {
    return notApplicable(
      'D9',
      'No original build hash on record -- this workflow predates provenance tracking or was not built by Kairos.',
    )
  }

  const drifting = originalBuildHash !== liveExportHash

  return {
    id: 'D9',
    status: drifting ? 'drifting' : 'healthy',
    severity: drifting ? 'warning' : 'info',
    summary: drifting
      ? 'The deployed workflow no longer matches what Kairos originally built -- it was likely hand-edited in n8n since deployment.'
      : 'The deployed workflow still matches what Kairos originally built.',
    evidence: { originalBuildHash, liveExportHash },
  }
}
