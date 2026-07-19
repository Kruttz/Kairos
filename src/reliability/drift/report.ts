import type { ExecutionTrace } from '../../library/types.js'
import {
  checkD1NewlyErroringNodes,
  checkD2DurationAnomaly,
  checkD3MissingCoreNodes,
  checkD4NewNodes,
  checkD5ErrorRateDrift,
  checkD6CadenceDrift,
  checkD7PerNodeDurationAnomaly,
  checkD8PayloadSchemaDrift,
  checkD9BuildVsLiveDrift,
  type DriftCheckFinding,
  type DriftCheckId,
  type PayloadShape,
} from './checks.js'
import { diagnoseAll, type DriftDiagnosis, type DriftDiagnosisContext } from './diagnose.js'

export interface RunAllChecksInputs {
  traces: ExecutionTrace[]
  /** D8 -- absent (the normal case today; capture is Phase 2) reports not_applicable honestly
   * rather than skipping the check silently. */
  latestPayloadShape?: PayloadShape
  baselinePayloadShape?: PayloadShape
  /** D9 -- absent (the normal case for a library-tracked workflow; provenance currently only
   * lives in pack-export results, not the general library) reports not_applicable honestly. */
  originalBuildHash?: string
  liveExportHash?: string
}

/** Runs all nine named checks against the same inputs. Order matches D1-D9 numbering. */
export function runAllChecks(inputs: RunAllChecksInputs): DriftCheckFinding[] {
  return [
    checkD1NewlyErroringNodes(inputs.traces),
    checkD2DurationAnomaly(inputs.traces),
    checkD3MissingCoreNodes(inputs.traces),
    checkD4NewNodes(inputs.traces),
    checkD5ErrorRateDrift(inputs.traces),
    checkD6CadenceDrift(inputs.traces),
    checkD7PerNodeDurationAnomaly(inputs.traces),
    checkD8PayloadSchemaDrift(inputs.latestPayloadShape, inputs.baselinePayloadShape),
    checkD9BuildVsLiveDrift(inputs.originalBuildHash, inputs.liveExportHash ?? ''),
  ]
}

export interface DriftCheckReport {
  workflowId: string
  workflowName?: string
  traceCount: number
  /** 'DRIFTING' iff at least one finding has status 'drifting' -- insufficient_data and
   * not_applicable never contribute to the verdict, matching the CLI's exit-code contract
   * (kairos-cli.ts: exit 1 only for real drifting). */
  verdict: 'HEALTHY' | 'DRIFTING'
  findings: DriftCheckFinding[]
  diagnoses: DriftDiagnosis[]
}

export function buildDriftCheckReport(
  context: DriftDiagnosisContext,
  inputs: RunAllChecksInputs,
): DriftCheckReport {
  const findings = runAllChecks(inputs)
  const diagnoses = diagnoseAll(findings, context)
  return {
    workflowId: context.workflowId,
    ...(context.workflowName ? { workflowName: context.workflowName } : {}),
    traceCount: inputs.traces.length,
    verdict: findings.some(f => f.status === 'drifting') ? 'DRIFTING' : 'HEALTHY',
    findings,
    diagnoses,
  }
}

const CHECK_LABELS: Record<DriftCheckId, string> = {
  D1: 'Newly-erroring nodes',
  D2: 'Duration anomaly (workflow-level)',
  D3: 'Missing core nodes',
  D4: 'New nodes',
  D5: 'Error-rate drift (windowed)',
  D6: 'Cadence drift / silent-stop',
  D7: 'Per-node duration anomaly',
  D8: 'Payload-schema drift',
  D9: 'Build-vs-live structural drift',
}

export function formatDriftCheckReport(report: DriftCheckReport): string {
  const lines: string[] = []
  lines.push(`Drift check: ${report.workflowName ?? report.workflowId} (${report.traceCount} trace(s) on record)`)
  lines.push(`Verdict: ${report.verdict}`)
  lines.push('')

  for (const finding of report.findings) {
    const symbol = finding.status === 'drifting' ? '⚠' : finding.status === 'healthy' ? '✓' : '·'
    lines.push(`${symbol} ${finding.id} ${CHECK_LABELS[finding.id]} -- ${finding.status.toUpperCase()}`)
    lines.push(`    ${finding.summary}`)
  }

  if (report.diagnoses.length > 0) {
    lines.push('')
    lines.push('Diagnosis:')
    for (const d of report.diagnoses) {
      lines.push(`  ${d.checkId} [${d.severity}] ${d.causeStatement}`)
      if (d.affectedNodes?.length) lines.push(`    Affected node(s): ${d.affectedNodes.join(', ')}`)
      lines.push(`    Confidence: ${d.confidence}  |  Repair class: ${d.repairClass}`)
      lines.push(`    Recommended: ${d.recommendedAction}`)
    }
  }

  return lines.join('\n')
}

export interface DriftBaselineReport {
  workflowId: string
  workflowName?: string
  traceCount: number
  oldestTraceAt?: string
  newestTraceAt?: string
  /** Checks that ran with real data (status healthy or drifting) -- "here's what Kairos can
   * currently evaluate for this workflow." */
  captured: Array<{ id: DriftCheckId; label: string; status: DriftCheckFinding['status'] }>
  /** Checks that did not produce a real verdict (insufficient_data or not_applicable), with
   * the check's own reason -- explicit per Jordan/Codex, 2026-07-19: baseline must clearly
   * say what was captured and what was skipped, not silently omit the skipped half. */
  skipped: Array<{ id: DriftCheckId; label: string; status: DriftCheckFinding['status']; reason: string }>
}

export function buildDriftBaselineReport(
  context: DriftDiagnosisContext,
  inputs: RunAllChecksInputs,
): DriftBaselineReport {
  const findings = runAllChecks(inputs)
  const sortedByTime = [...inputs.traces].sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())

  const captured: DriftBaselineReport['captured'] = []
  const skipped: DriftBaselineReport['skipped'] = []
  for (const f of findings) {
    if (f.status === 'healthy' || f.status === 'drifting') {
      captured.push({ id: f.id, label: CHECK_LABELS[f.id], status: f.status })
    } else {
      skipped.push({ id: f.id, label: CHECK_LABELS[f.id], status: f.status, reason: f.summary })
    }
  }

  return {
    workflowId: context.workflowId,
    ...(context.workflowName ? { workflowName: context.workflowName } : {}),
    traceCount: inputs.traces.length,
    ...(sortedByTime[0] ? { oldestTraceAt: sortedByTime[0].recordedAt } : {}),
    ...(sortedByTime[sortedByTime.length - 1] ? { newestTraceAt: sortedByTime[sortedByTime.length - 1]!.recordedAt } : {}),
    captured,
    skipped,
  }
}

export function formatDriftBaselineReport(report: DriftBaselineReport): string {
  const lines: string[] = []
  lines.push(`Drift baseline: ${report.workflowName ?? report.workflowId}`)
  lines.push(`Traces on record: ${report.traceCount}${report.oldestTraceAt ? ` (${report.oldestTraceAt} .. ${report.newestTraceAt})` : ''}`)
  lines.push('')
  lines.push(`Captured (${report.captured.length}/9 checks have real data to evaluate):`)
  if (report.captured.length === 0) lines.push('  (none yet)')
  for (const c of report.captured) lines.push(`  ✓ ${c.id} ${c.label}`)
  lines.push('')
  lines.push(`Skipped (${report.skipped.length}/9 checks -- not enough data, or not applicable):`)
  if (report.skipped.length === 0) lines.push('  (none)')
  for (const s of report.skipped) lines.push(`  · ${s.id} ${s.label} [${s.status}] -- ${s.reason}`)
  return lines.join('\n')
}
