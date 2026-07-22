import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getKairosVersion } from '../validation/provenance-versions.js'
import { generateOpportunityReport } from './analyze.js'
import type { OpportunityReport } from './types.js'

/**
 * Operations Scout v0 (roadmap item 14, docs/plans/contract-evolution-ops-roadmap-plan.md §3,
 * item 14). Bundle writing -- identical idiom to `promise/report-bundle.ts`'s own
 * `writePromiseReport()`/`writeAutomationValueReport()` (write-to-temp-then-write pattern not
 * needed here, since this is a one-shot write, never a read-modify-write cycle; chmod 600 +
 * manifest match those two exactly).
 */

export interface OpportunityReportManifest {
  generatedAt: string
  sourceFile: string
  findingCount: number
  files: Array<{ artifact: string; path: string }>
  provenance: { kairosVersion: string }
}

export async function writeOpportunityReport(report: OpportunityReport, outDir: string): Promise<OpportunityReportManifest> {
  await mkdir(outDir, { recursive: true })

  const reportPath = join(outDir, 'opportunity-report.md')
  await writeFile(reportPath, generateOpportunityReport(report), 'utf-8')
  await chmod(reportPath, 0o600)

  const jsonPath = join(outDir, 'opportunity-report.json')
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf-8')
  await chmod(jsonPath, 0o600)

  const manifest: OpportunityReportManifest = {
    generatedAt: report.generatedAt,
    sourceFile: report.source.path,
    findingCount: report.findings.length,
    files: [
      { artifact: 'opportunity-report.md', path: reportPath },
      { artifact: 'opportunity-report.json', path: jsonPath },
    ],
    provenance: { kairosVersion: getKairosVersion() },
  }

  const manifestPath = join(outDir, 'opportunity-report-manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await chmod(manifestPath, 0o600)

  return manifest
}
