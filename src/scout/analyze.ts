import { readCsvFile, detectColumnRoles } from './csv-source.js'
import { runOpportunityChecks } from './checks.js'
import type { ColumnHints, OpportunityReport } from './types.js'

/**
 * Operations Scout v0 (roadmap item 14, docs/plans/contract-evolution-ops-roadmap-plan.md §3,
 * item 14). `analyzeCsvFile()` is the only export the rest of this item depends on -- reads one
 * CSV file (explicit, human-supplied path, never auto-discovered), resolves column roles, runs
 * every check, and assembles the report.
 */

const DISCLAIMER = 'Based on column-name heuristics and fixed thresholds against one file, at one point in time -- not a confirmed diagnosis. Every finding here is a candidate for human review, not a proven business failure. See each finding\'s own caveats for what specifically limits it.'

export async function analyzeCsvFile(path: string, hints: ColumnHints = {}, now: Date = new Date()): Promise<OpportunityReport> {
  const { headers, rows } = await readCsvFile(path)
  const columnRoles = detectColumnRoles(headers, hints)
  const { findings, skipped } = runOpportunityChecks(headers, rows, columnRoles, path, now)

  return {
    source: { type: 'csv', path },
    generatedAt: now.toISOString(),
    rowCount: rows.length,
    columnRoles,
    findings,
    skipped,
    disclaimer: DISCLAIMER,
  }
}

const CHECK_LABELS: Record<string, string> = {
  STALE_ROWS: 'Stale rows',
  STUCK_STATUS: 'Stuck status',
  MISSING_OWNER: 'Missing owner',
  MISSING_NEXT_ACTION: 'Missing next action',
  DUPLICATE_RECORDS: 'Duplicate records',
  LONG_GAPS_BETWEEN_TIMESTAMPS: 'Long gaps between timestamps',
  UNCLOSED_LOOPS: 'Unclosed loops',
  POSSIBLE_HANDOFF_DELAY: 'Possible handoff delay',
  REPEATED_MANUAL_STATUS_VALUES: 'Repeated manual status values',
  CANDIDATE_PROCESS_NAME: 'Candidate process name',
}

/** Rendered-text formatter -- the structured OpportunityReport above is the source of truth
 * (available via --json); this is a separate, later step, matching every other
 * formatResult()-style renderer already established in this codebase (chaos/sandbox-run.ts's
 * own formatChaosSandboxRunResult(), etc.). */
export function generateOpportunityReport(report: OpportunityReport): string {
  const lines: string[] = []
  lines.push(`Operations Scout — ${report.source.path}`)
  lines.push('─'.repeat(50))
  lines.push(`${report.rowCount} data row(s) analyzed, generated ${report.generatedAt}`)
  lines.push('')

  const roleEntries = Object.entries(report.columnRoles)
  if (roleEntries.length > 0) {
    lines.push('Column roles:')
    for (const [role, resolved] of roleEntries) {
      if (!resolved) continue
      lines.push(`  ${role}: "${resolved.column}" (${resolved.source})`)
    }
    lines.push('')
  }

  if (report.findings.length === 0) {
    lines.push('No findings.')
  } else {
    for (const f of report.findings) {
      lines.push(`[${f.confidence}] ${CHECK_LABELS[f.checkId] ?? f.checkId} — ${f.id}`)
      lines.push(`  ${f.suspectedFailureMode}`)
      if (f.evidenceRowRefs.length > 0) lines.push(`  Rows (0-indexed): ${f.evidenceRowRefs.slice(0, 20).join(', ')}${f.evidenceRowRefs.length > 20 ? `, ... (${f.evidenceRowRefs.length} total)` : ''}`)
      lines.push(`  Next step: ${f.recommendedNextStep}`)
      if (f.possibleProcessContractSeed) lines.push(`  Possible ProcessContract seed: ${f.possibleProcessContractSeed}`)
      for (const c of f.caveats) lines.push(`  Caveat: ${c}`)
      lines.push('')
    }
  }

  if (report.skipped.length > 0) {
    lines.push('Not attempted (see reasons):')
    for (const s of report.skipped) lines.push(`  - ${CHECK_LABELS[s.checkId] ?? s.checkId}: ${s.reason}`)
    lines.push('')
  }

  lines.push(`Disclaimer: ${report.disclaimer}`)

  return lines.join('\n')
}
