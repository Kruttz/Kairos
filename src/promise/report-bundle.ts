import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getKairosVersion } from '../validation/provenance-versions.js'
import { generatePromiseReport } from './report.js'
import { generateAutomationValueReport } from './value-report.js'
import type { PromiseReportData } from './report.js'
import type { AutomationValueReport } from './value-types.js'

/**
 * Promise Report bundle writing (Phase 5) -- reuses pack-bundle.ts's own artifact/manifest
 * pattern (a manifest.json recording exactly what was written, when, with what provenance) as a
 * standalone writer rather than extending writeBundle() itself. A ProcessContract's report has
 * no dependency on a saved WorkflowPackResult existing at all (most contracts in this arc's own
 * checkpoints were compiled with --dry-run, never producing a persisted pack) -- forcing this
 * into writeBundle()'s pack-specific signature would either require one to exist or bolt on an
 * awkward optional cross-reference. A separate, parallel writer following the identical
 * idiom -- not pack-bundle.ts's own code -- is the more conservative choice, the same "don't
 * touch already-shipped, already-tested code when a parallel piece works just as well" discipline
 * Phase 4 already used for kairos watch --contracts (kept reliability/watch/loop.ts untouched).
 */

export interface PromiseReportManifest {
  generatedAt: string
  contractId: string
  contractName: string
  files: Array<{ artifact: string; path: string }>
  provenance: { kairosVersion: string }
}

export async function writePromiseReport(data: PromiseReportData, outDir: string): Promise<PromiseReportManifest> {
  await mkdir(outDir, { recursive: true })

  const reportPath = join(outDir, 'promise-report.md')
  await writeFile(reportPath, generatePromiseReport(data), 'utf-8')
  await chmod(reportPath, 0o600)

  const manifest: PromiseReportManifest = {
    generatedAt: data.generatedAt,
    contractId: data.contractId,
    contractName: data.contractName,
    files: [{ artifact: 'promise-report.md', path: reportPath }],
    provenance: { kairosVersion: getKairosVersion() },
  }

  const manifestPath = join(outDir, 'promise-report-manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await chmod(manifestPath, 0o600)

  return manifest
}

/** Automation P&L / Value Report bundle writing (roadmap item 13, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 13) -- identical idiom to
 * `writePromiseReport()` above, a separate artifact (`automation-value-report.md`) rather than
 * replacing it, since a value report's own Observed section is meant to be a strict superset of
 * `promise-report.md`'s content, not a competing rendering of the same data. */
export interface AutomationValueReportManifest {
  generatedAt: string
  contractId: string
  contractName: string
  hasEstimatedValue: boolean
  files: Array<{ artifact: string; path: string }>
  provenance: { kairosVersion: string }
}

export async function writeAutomationValueReport(report: AutomationValueReport, outDir: string): Promise<AutomationValueReportManifest> {
  await mkdir(outDir, { recursive: true })

  const reportPath = join(outDir, 'automation-value-report.md')
  await writeFile(reportPath, generateAutomationValueReport(report), 'utf-8')
  await chmod(reportPath, 0o600)

  const manifest: AutomationValueReportManifest = {
    generatedAt: report.observed.generatedAt,
    contractId: report.observed.contractId,
    contractName: report.observed.contractName,
    hasEstimatedValue: report.estimatedValue !== undefined,
    files: [{ artifact: 'automation-value-report.md', path: reportPath }],
    provenance: { kairosVersion: getKairosVersion() },
  }

  const manifestPath = join(outDir, 'automation-value-report-manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await chmod(manifestPath, 0o600)

  return manifest
}
