import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { N8nWorkflow } from '../types/workflow.js'
import type { N8nApiClient } from '../providers/n8n/index.js'
import type { WorkflowPackResult } from './pack-builder.js'
import type { BuildProvenance } from '../types/result.js'
import { validatePack, type PackValidationIssue } from './pack-validator.js'
import { RULE_MITIGATIONS, RULE_PIPELINE_STAGES } from '../validation/rule-metadata.js'
import { parseExecutionTrace, getSlowestNodes } from '../telemetry/execution-tracer.js'
import { generateTestPayload, generateOpenApiContract } from './webhook-schema.js'
import { generateHandoff } from './pack-exporter.js'
import { computeWorkflowHash } from '../utils/workflow-hash.js'
import { getRuleSetVersion, getPromptTemplateVersion, getPromptProfile, getNodeCatalogVersion, getKairosVersion } from '../validation/provenance-versions.js'

export function slugifyWorkflowName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workflow'
}

/**
 * Fetches a workflow's current live n8n definition and strips it down to the portable
 * N8nWorkflow shape (no n8n-internal fields like id/active/versionId/meta). Returns null
 * on any fetch failure (workflow deleted, n8n unreachable) rather than throwing -- a missing
 * workflow.json for one workflow in a pack should not abort exporting the rest.
 */
export async function fetchWorkflowJson(workflowId: string, client: N8nApiClient): Promise<N8nWorkflow | null> {
  try {
    const response = await client.getWorkflow(workflowId)
    return {
      name: response.name,
      nodes: response.nodes,
      connections: response.connections,
      ...(response.settings ? { settings: response.settings } : {}),
      ...(response.tags ? { tags: response.tags } : {}),
    }
  } catch {
    return null
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmpPath, path)
}

export interface WriteWorkflowJsonResult {
  written: Array<{
    workflowName: string
    path: string
    fetchedAt: string
    /** Hash of the workflow as just fetched live from n8n -- may differ from
     * originalBuildHash if the workflow was hand-edited in n8n, or drifted for any other
     * reason, since it was originally built. */
    liveExportHash: string
    /** This workflow's BuildProvenance.workflowHash from when Kairos originally built it
     * (carried through PackWorkflowResult.provenance) -- absent when the pack predates
     * provenance tracking, or the workflow errored before a build result existed. Comparing
     * this against liveExportHash is how a consumer detects build-vs-live drift; this
     * function only records both values, it doesn't classify or flag drift itself. */
    originalBuildHash?: string
  }>
  skipped: Array<{ workflowName: string; reason: string }>
}

/**
 * Writes one <slug>.workflow.json per workflow in the pack into outDir, fetching each
 * workflow's current definition live from n8n. Workflows with no workflowId, or whose fetch
 * fails, are skipped (reported, not thrown) so one bad workflow doesn't abort the rest.
 * Records fetchedAt per workflow -- this is a live fetch, so the workflow may already differ
 * from what Kairos originally generated (e.g. hand-edited in n8n since); the timestamp makes
 * that staleness checkable rather than silently assumed away.
 */
export async function writeWorkflowJsonFiles(
  workflows: Array<{ name: string; workflowId: string | null; provenance?: BuildProvenance }>,
  client: N8nApiClient,
  outDir: string,
): Promise<WriteWorkflowJsonResult> {
  await mkdir(outDir, { recursive: true })
  const result: WriteWorkflowJsonResult = { written: [], skipped: [] }

  for (const wf of workflows) {
    if (!wf.workflowId) {
      result.skipped.push({ workflowName: wf.name, reason: 'no workflowId (workflow was not deployed)' })
      continue
    }
    const workflow = await fetchWorkflowJson(wf.workflowId, client)
    if (!workflow) {
      result.skipped.push({ workflowName: wf.name, reason: `could not fetch workflow ${wf.workflowId} from n8n` })
      continue
    }
    const fetchedAt = new Date().toISOString()
    const path = join(outDir, `${slugifyWorkflowName(wf.name)}.workflow.json`)
    await writeJsonAtomic(path, workflow)
    result.written.push({
      workflowName: wf.name,
      path,
      fetchedAt,
      liveExportHash: computeWorkflowHash(workflow),
      ...(wf.provenance?.workflowHash ? { originalBuildHash: wf.provenance.workflowHash } : {}),
    })
  }

  return result
}

/**
 * Pack-level credentials.md: groups every workflow's credentialsNeeded by service, preserving
 * per-credential descriptions (unlike WorkflowPackResult.allCredentials, which dedupes down to
 * just {service, credentialType} and drops description). Pure render, no I/O, no live n8n call.
 */
export function generateCredentialsDoc(pack: WorkflowPackResult): string {
  const lines: string[] = []
  const line = () => lines.push('')

  lines.push(`# ${pack.businessContext} — Required Credentials`)
  line()

  interface ServiceEntry {
    service: string
    credentialType: string
    descriptions: Set<string>
    workflows: Set<string>
  }
  const byService = new Map<string, ServiceEntry>()

  for (const wf of pack.workflows) {
    for (const cred of wf.credentialsNeeded) {
      // JSON.stringify of a tuple, not a delimited string -- a plain-character delimiter
      // (space, or any other single visible character) can collide, e.g. service="Google",
      // credentialType="Sheets OAuth" vs. service="Google Sheets", credentialType="OAuth"
      // would join to the identical string "Google Sheets OAuth" under a space-joined key.
      // JSON.stringify preserves the exact field boundary regardless of what either field
      // contains.
      const key = JSON.stringify([cred.service, cred.credentialType])
      const entry = byService.get(key) ?? { service: cred.service, credentialType: cred.credentialType, descriptions: new Set(), workflows: new Set() }
      if (cred.description) entry.descriptions.add(cred.description)
      entry.workflows.add(wf.name)
      byService.set(key, entry)
    }
  }

  if (byService.size === 0) {
    lines.push('No credentials required — every workflow in this pack runs without external service access.')
    return lines.join('\n')
  }

  lines.push(`This pack needs the following credentials connected in n8n before workflows can run.`)
  line()

  const entries = [...byService.values()].sort((a, b) => a.service.localeCompare(b.service))
  for (const entry of entries) {
    lines.push(`## ${entry.service}`)
    line()
    lines.push(`**Type:** \`${entry.credentialType}\``)
    line()
    if (entry.descriptions.size > 0) {
      for (const desc of entry.descriptions) lines.push(`- ${desc}`)
      line()
    }
    lines.push(`**Needed by:** ${[...entry.workflows].join(', ')}`)
    line()
  }

  lines.push(`## Setup Order`)
  line()
  lines.push(`Connect all credentials above in n8n (Settings → Credentials) before running \`kairos validate-pack\` or activating any workflow — a workflow with a missing credential will fail on its first real execution rather than at setup time.`)

  return lines.join('\n')
}

export type NormalizedSeverity = 'error' | 'warning'

export interface RiskItem {
  severity: NormalizedSeverity
  message: string
  rule?: number
  mitigation?: string | null
  pipelineStage?: string | null
}

export type RiskVerdict = 'BLOCKED' | 'NOT READY' | 'NEEDS ATTENTION' | 'READY'

export interface RiskFindings {
  /** Non-null only when the pack was never built at all (PackBuilder.build() stopped before
   * generating anything). When set, workflowItems/packItems are empty and verdict is 'BLOCKED'. */
  escalation: WorkflowPackResult['escalation'] | null
  workflowItems: Map<string, RiskItem[]>
  packItems: RiskItem[]
  verdict: RiskVerdict
}

const SEVERITY_WEIGHT: Record<NormalizedSeverity, number> = { error: 0, warning: 1 }
function bySeverity(a: RiskItem, b: RiskItem): number {
  return SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity]
}

/**
 * Combines pack-structural risk (validatePack()'s PackValidationIssue[]) with per-workflow
 * validation issues (PackWorkflowResult.finalIssues, enriched with
 * RULE_MITIGATIONS/RULE_PIPELINE_STAGES) into one structured verdict. Pure computation, no I/O,
 * no live n8n call. The shared data source behind both generateRiskReport() (Markdown render)
 * and preflight.ts (checklist render) -- extracted so the two never compute this independently
 * and drift apart. An escalated pack (never built at all) short-circuits to a BLOCKED verdict
 * with empty findings, since pack.workflows is empty and there's nothing to assess.
 */
export function computeRiskFindings(pack: WorkflowPackResult): RiskFindings {
  if (pack.escalation) {
    return { escalation: pack.escalation, workflowItems: new Map(), packItems: [], verdict: 'BLOCKED' }
  }

  const workflowItems = new Map<string, RiskItem[]>()
  for (const wf of pack.workflows) {
    if (wf.finalIssues === undefined) continue
    workflowItems.set(wf.name, wf.finalIssues.map((issue) => ({
      severity: (issue.severity === 'warn' ? 'warning' : 'error') as NormalizedSeverity,
      message: issue.message,
      rule: issue.rule,
      mitigation: RULE_MITIGATIONS[issue.rule] ?? null,
      pipelineStage: RULE_PIPELINE_STAGES[issue.rule] ?? null,
    })))
  }

  const packIssues: PackValidationIssue[] = validatePack(pack)
  const packItems: RiskItem[] = packIssues.map((issue) => ({ severity: issue.severity, message: issue.message }))

  const allItems = [...workflowItems.values()].flat().concat(packItems)
  const anyError = allItems.some((i) => i.severity === 'error')
  const anyWarning = allItems.some((i) => i.severity === 'warning')
  const verdict: RiskVerdict = anyError ? 'NOT READY' : anyWarning ? 'NEEDS ATTENTION' : 'READY'

  return { escalation: null, workflowItems, packItems, verdict }
}

/**
 * Pack-level risk-report.md: renders computeRiskFindings() as narrative Markdown. Never invents
 * a numeric score -- only a categorical READY / NEEDS ATTENTION / NOT READY / BLOCKED verdict
 * backed by real itemized issues.
 */
export function generateRiskReport(pack: WorkflowPackResult): string {
  const lines: string[] = []
  const line = () => lines.push('')

  lines.push(`# ${pack.businessContext} — Risk Report`)
  line()

  const findings = computeRiskFindings(pack)

  if (findings.escalation) {
    lines.push(`**Overall status:** BLOCKED — build never completed`)
    line()
    lines.push(`This pack has no workflows to assess: generation stopped before anything was built because of unresolved blocking assumptions. Resolve the questions below, then re-run \`kairos build-pack\`.`)
    line()
    lines.push(`**Reason:** ${findings.escalation.reason}`)
    if (findings.escalation.questions.length > 0) {
      line()
      lines.push(`**Open questions:**`)
      for (const q of findings.escalation.questions) lines.push(`- ${q}`)
    }
    return lines.join('\n')
  }

  const { workflowItems, packItems, verdict } = findings

  lines.push(`**Overall status:** ${verdict}`)
  line()
  if (verdict === 'NOT READY') lines.push(`This pack has at least one error-severity issue below — resolve it before activating.`)
  else if (verdict === 'NEEDS ATTENTION') lines.push(`No blocking errors, but the warnings below are worth reviewing before activating.`)
  else lines.push(`No issues found across any workflow or pack-structural check.`)
  line()

  if (packItems.length > 0) {
    lines.push(`## Pack-Level Issues`)
    line()
    for (const item of [...packItems].sort(bySeverity)) {
      lines.push(`- **[${item.severity.toUpperCase()}]** ${item.message}`)
    }
    line()
  }

  lines.push(`## Per-Workflow Findings`)
  line()
  for (const wf of pack.workflows) {
    lines.push(`### ${wf.name}`)
    line()
    if (!workflowItems.has(wf.name)) {
      lines.push(`_No structured validation data available for this workflow (this pack was built before validation data was tracked)._`)
      line()
      continue
    }
    const items = workflowItems.get(wf.name)!
    if (items.length === 0) {
      lines.push(`No issues found.`)
      line()
      continue
    }
    for (const item of [...items].sort(bySeverity)) {
      const stage = item.pipelineStage ? ` (${item.pipelineStage.replace(/_/g, ' ')})` : ''
      lines.push(`- **[${item.severity.toUpperCase()}]** Rule ${item.rule}${stage}: ${item.message}`)
      if (item.mitigation) lines.push(`  - Fix: ${item.mitigation}`)
    }
    line()
  }

  return lines.join('\n')
}

/** Mirrors telemetry/execution-tracer.ts's fetchLatestTrace(), but against an already-constructed
 * N8nApiClient instance rather than raw credentials -- pack-bundle.ts's other functions all take
 * a client instance so a single client can be reused across an entire --bundle export. */
async function fetchLatestTraceViaClient(workflowId: string, client: N8nApiClient) {
  try {
    const executions = await client.getExecutions(workflowId, { limit: 1 })
    if (executions.length === 0) return null
    const detail = await client.getExecution(executions[0]!.id)
    return parseExecutionTrace(detail)
  } catch {
    return null
  }
}

/**
 * Pack-level monitoring-plan.md: for each deployed workflow, its current active/inactive
 * status and its single latest execution's status/duration/slowest-nodes (a live fetch, not
 * a stored history), plus a static weekly checklist. Deliberately does NOT claim a drift
 * comparison happened -- that requires StoredWorkflow.executionTraces history that pack
 * export has no access to (that's the library's stored record, not derivable from one live
 * fetch) -- says so explicitly rather than rendering an empty/misleading drift section.
 * Requires a live n8n connection (workflow status + execution history), unlike credentials.md/risk-report.md.
 */
export async function generateMonitoringPlan(pack: WorkflowPackResult, client: N8nApiClient): Promise<string> {
  const lines: string[] = []
  const line = () => lines.push('')

  lines.push(`# ${pack.businessContext} — Monitoring Plan`)
  line()
  lines.push(`What to check periodically for each workflow in this pack.`)
  line()

  for (const wf of pack.workflows) {
    lines.push(`## ${wf.name}`)
    line()

    if (!wf.workflowId) {
      lines.push(`_Not deployed — nothing to monitor yet._`)
      line()
      continue
    }

    let active: boolean | null = null
    try {
      const response = await client.getWorkflow(wf.workflowId)
      active = response.active
    } catch {
      lines.push(`_Could not reach n8n to check this workflow (unreachable, or the workflow was deleted since this pack was built)._`)
      line()
      continue
    }

    lines.push(`**Status:** ${active ? 'Active' : 'Inactive'}`)
    line()

    const trace = await fetchLatestTraceViaClient(wf.workflowId, client)
    if (!trace) {
      lines.push(`No execution history yet — run \`kairos trace record ${wf.workflowId}\` after this workflow has executed at least once in production.`)
      line()
      continue
    }

    const durationSuffix = trace.durationMs !== null ? `, ${trace.durationMs}ms` : ''
    lines.push(`**Latest execution:** ${trace.status} (${trace.executedNodes.length} nodes, ${trace.erroredNodes.length} errors${durationSuffix})`)
    const slowest = getSlowestNodes(trace.nodeDurations, 3)
    if (slowest.length > 0) {
      lines.push(`**Slowest nodes this run:** ${slowest.map((s) => `${s.name} (${s.ms}ms)`).join(', ')}`)
    }
    line()
    lines.push(`_Insufficient history for drift comparison here — run \`kairos trace record ${wf.workflowId}\` periodically to build trend history and catch regressions._`)
    line()
  }

  lines.push(`## Weekly Checklist`)
  line()
  lines.push(`- [ ] Check the n8n Executions tab for failures across all workflows in this pack`)
  lines.push(`- [ ] Run \`kairos trace record <workflow-id>\` for each active workflow to build drift-detection history`)
  lines.push(`- [ ] Run \`kairos patterns\` to check pattern-level health across all Kairos builds`)
  lines.push(`- [ ] Rotate credentials before expiration (n8n Settings → Credentials)`)

  return lines.join('\n')
}

export interface WriteTestPayloadsResult {
  written: Array<{ workflowName: string; path: string; fetchedAt: string }>
  skipped: Array<{ workflowName: string; reason: string }>
}

/**
 * Writes one <slug>.test-payloads.json per webhook-shaped workflow into outDir. Non-webhook
 * workflows are skipped silently (no file, no error -- the artifact simply doesn't apply);
 * workflows with no workflowId or a failed n8n fetch are skipped with a reason, same
 * graceful-degradation contract as writeWorkflowJsonFiles(). Records fetchedAt per workflow,
 * same reasoning as writeWorkflowJsonFiles() -- the fields were inferred from a live fetch.
 */
export async function writeTestPayloadFiles(
  workflows: Array<{ name: string; workflowId: string | null }>,
  client: N8nApiClient,
  outDir: string,
): Promise<WriteTestPayloadsResult> {
  await mkdir(outDir, { recursive: true })
  const result: WriteTestPayloadsResult = { written: [], skipped: [] }

  for (const wf of workflows) {
    if (!wf.workflowId) {
      result.skipped.push({ workflowName: wf.name, reason: 'no workflowId (workflow was not deployed)' })
      continue
    }
    const workflow = await fetchWorkflowJson(wf.workflowId, client)
    if (!workflow) {
      result.skipped.push({ workflowName: wf.name, reason: `could not fetch workflow ${wf.workflowId} from n8n` })
      continue
    }
    const payload = generateTestPayload(workflow)
    if (!payload) {
      result.skipped.push({ workflowName: wf.name, reason: 'no webhook trigger (not applicable)' })
      continue
    }
    const fetchedAt = new Date().toISOString()
    const path = join(outDir, `${slugifyWorkflowName(wf.name)}.test-payloads.json`)
    await writeJsonAtomic(path, payload)
    result.written.push({ workflowName: wf.name, path, fetchedAt })
  }

  return result
}

/**
 * Writes one <slug>.contract.openapi.json per webhook-shaped workflow into outDir. Same
 * graceful-degradation contract as writeTestPayloadFiles() -- non-webhook workflows skipped
 * silently (not applicable), fetch failures reported and skipped, nothing aborts the rest.
 */
export async function writeOpenApiFiles(
  workflows: Array<{ name: string; workflowId: string | null }>,
  client: N8nApiClient,
  outDir: string,
): Promise<WriteTestPayloadsResult> {
  await mkdir(outDir, { recursive: true })
  const result: WriteTestPayloadsResult = { written: [], skipped: [] }

  for (const wf of workflows) {
    if (!wf.workflowId) {
      result.skipped.push({ workflowName: wf.name, reason: 'no workflowId (workflow was not deployed)' })
      continue
    }
    const workflow = await fetchWorkflowJson(wf.workflowId, client)
    if (!workflow) {
      result.skipped.push({ workflowName: wf.name, reason: `could not fetch workflow ${wf.workflowId} from n8n` })
      continue
    }
    const contract = generateOpenApiContract(workflow)
    if (!contract) {
      result.skipped.push({ workflowName: wf.name, reason: 'no webhook trigger (not applicable)' })
      continue
    }
    const fetchedAt = new Date().toISOString()
    const path = join(outDir, `${slugifyWorkflowName(wf.name)}.contract.openapi.json`)
    await writeJsonAtomic(path, contract)
    result.written.push({ workflowName: wf.name, path, fetchedAt })
  }

  return result
}

/**
 * What Kairos considered "current" at the moment this bundle was written -- lets a later
 * re-check classify an older bundle as built under the same rules/catalog/prompt or a
 * materially different one. See src/validation/provenance-versions.ts for how each field is
 * derived (all content-derived, never a manually bumped constant).
 */
export interface BundleProvenance {
  kairosVersion: string
  ruleSetVersion: string
  /** Hash of the static base system prompt template only -- see
   * getPromptTemplateVersion() in provenance-versions.ts for why. */
  promptTemplateVersion: string
  /** Which KAIROS_PROMPT_PROFILE was active at export time. */
  promptProfile: string
  nodeCatalogVersion: Record<string, string>
}

export interface BundleManifest {
  generatedAt: string
  packName: string
  files: Array<{
    artifact: string
    workflowName?: string
    path: string
    fetchedAt?: string
    /** Only present on workflow.json entries -- hash of the workflow as just fetched live
     * from n8n at export time. */
    liveExportHash?: string
    /** Only present on workflow.json entries, and only when the pack recorded build-time
     * provenance for that workflow -- hash of the workflow as Kairos originally built it.
     * Comparing this against liveExportHash is how build-vs-live drift is detected;
     * writeBundle() only records both values, it doesn't classify drift itself. */
    originalBuildHash?: string
  }>
  skipped: Array<{ artifact: string; workflowName?: string; reason: string }>
  /** Absent only on manifests deserialized from a bundle written before this field existed --
   * treat that case as "provenance unknown," never as an error. */
  provenance?: BundleProvenance
}

/**
 * Writes the full client deliverable set into outDir: pack-level handoff.md/credentials.md/
 * risk-report.md/monitoring-plan.md, plus per-workflow workflow.json/test-payloads.json/
 * contract.openapi.json (the latter two only for webhook-shaped workflows). Composes the
 * existing generate-doc and write-files functions rather than duplicating their logic. One failing
 * piece never aborts the rest -- every skip is recorded, with why, in bundle-manifest.json.
 */
export async function writeBundle(pack: WorkflowPackResult, client: N8nApiClient, outDir: string): Promise<BundleManifest> {
  await mkdir(outDir, { recursive: true })
  const manifest: BundleManifest = {
    generatedAt: new Date().toISOString(),
    packName: pack.packName,
    files: [],
    skipped: [],
    provenance: {
      kairosVersion: getKairosVersion(),
      ruleSetVersion: getRuleSetVersion(),
      promptTemplateVersion: getPromptTemplateVersion(),
      promptProfile: getPromptProfile(),
      nodeCatalogVersion: getNodeCatalogVersion(),
    },
  }

  const handoffPath = join(outDir, 'handoff.md')
  await writeFile(handoffPath, generateHandoff(pack), 'utf-8')
  manifest.files.push({ artifact: 'handoff.md', path: handoffPath })

  const credentialsPath = join(outDir, 'credentials.md')
  await writeFile(credentialsPath, generateCredentialsDoc(pack), 'utf-8')
  manifest.files.push({ artifact: 'credentials.md', path: credentialsPath })

  const riskReportPath = join(outDir, 'risk-report.md')
  await writeFile(riskReportPath, generateRiskReport(pack), 'utf-8')
  manifest.files.push({ artifact: 'risk-report.md', path: riskReportPath })

  try {
    const monitoringPlanPath = join(outDir, 'monitoring-plan.md')
    await writeFile(monitoringPlanPath, await generateMonitoringPlan(pack, client), 'utf-8')
    manifest.files.push({ artifact: 'monitoring-plan.md', path: monitoringPlanPath })
  } catch (err) {
    manifest.skipped.push({ artifact: 'monitoring-plan.md', reason: `failed to generate: ${err instanceof Error ? err.message : String(err)}` })
  }

  const perWorkflowResults: Array<[string, WriteWorkflowJsonResult | WriteTestPayloadsResult]> = [
    ['workflow.json', await writeWorkflowJsonFiles(pack.workflows, client, outDir)],
    ['test-payloads.json', await writeTestPayloadFiles(pack.workflows, client, outDir)],
    ['contract.openapi.json', await writeOpenApiFiles(pack.workflows, client, outDir)],
  ]
  for (const [artifact, result] of perWorkflowResults) {
    for (const w of result.written) {
      // Only writeWorkflowJsonFiles()'s results carry these (test-payloads.json/
      // contract.openapi.json are derived artifacts, not the workflow definition itself).
      const liveExportHash = 'liveExportHash' in w ? w.liveExportHash : undefined
      const originalBuildHash = 'originalBuildHash' in w ? w.originalBuildHash : undefined
      manifest.files.push({
        artifact, workflowName: w.workflowName, path: w.path, fetchedAt: w.fetchedAt,
        ...(liveExportHash ? { liveExportHash } : {}),
        ...(originalBuildHash ? { originalBuildHash } : {}),
      })
    }
    for (const s of result.skipped) manifest.skipped.push({ artifact, workflowName: s.workflowName, reason: s.reason })
  }

  const manifestPath = join(outDir, 'bundle-manifest.json')
  await writeJsonAtomic(manifestPath, manifest)

  return manifest
}
