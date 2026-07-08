import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowPackResult } from './pack-builder.js'
import type { N8nWorkflow } from '../types/workflow.js'
import { computeRiskFindings, fetchWorkflowJson, slugifyWorkflowName, type BundleManifest, type BundleProvenance } from './pack-bundle.js'
import { findSheetNodes } from './pack-wirer.js'
import { findWebhookTrigger } from '../utils/webhook-verify.js'
import type { N8nApiClient } from '../providers/n8n/index.js'
import { getRuleSetVersion, getPromptVersion, getNodeCatalogVersion } from '../validation/provenance-versions.js'

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'info'

export interface PreflightCheck {
  id: string
  label: string
  status: CheckStatus
  /** Present on fail/warn/skip -- why, and (for skip) what would resolve it. */
  detail?: string
}

export type PreflightVerdict = 'GO' | 'GO WITH WARNINGS' | 'NO-GO' | 'BLOCKED'

export interface PreflightResult {
  packName: string
  businessContext: string
  verdict: PreflightVerdict
  checks: PreflightCheck[]
  /** Names of workflows found (via --live) to have a webhook trigger -- populated only when
   * --live was passed; consumed by Phase 3's --bundle-dir test-artifact check, not rendered
   * as a check of its own here. */
  webhookShapedWorkflows?: string[]
  /** What Kairos considers "current" at the moment this preflight ran -- always computed,
   * regardless of --live/--bundle-dir, since these are properties of the running Kairos
   * install, not something that needs a live n8n fetch. Compared against a --bundle-dir's
   * stored manifest provenance (if present) in the bundle-manifest check below. */
  provenance: BundleProvenance
}

export interface PreflightOptions {
  live?: boolean
  client?: N8nApiClient
  bundleDir?: string
}

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  warn: '⚠',
  skip: '⊘',
  info: 'ℹ',
}

/**
 * Runs the full preflight checklist against a saved pack. Offline checks (this phase) never
 * touch n8n -- everything comes from the saved pack JSON. An escalated pack (never built at
 * all) does NOT short-circuit the checklist the way generateRiskReport() does: every
 * per-workflow check still renders, explicitly marked 'skip' with "N/A -- pack never built"
 * rather than naively reporting a pass because pack.workflows happens to be empty. A checklist
 * that silently looks all-green on a pack that was never generated would be actively misleading.
 */
export async function runPreflight(pack: WorkflowPackResult, options: PreflightOptions = {}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []
  const findings = computeRiskFindings(pack)
  const isEscalated = pack.escalation !== undefined
  const live = options.live === true && options.client !== undefined
  const provenance: BundleProvenance = {
    ruleSetVersion: getRuleSetVersion(),
    promptVersion: getPromptVersion(),
    nodeCatalogVersion: getNodeCatalogVersion(),
  }

  // 1. Escalation
  if (pack.escalation) {
    checks.push({
      id: 'escalation',
      label: 'Pack build completed',
      status: 'fail',
      detail: `${pack.escalation.reason}${pack.escalation.questions.length > 0 ? ` Open questions: ${pack.escalation.questions.join('; ')}` : ''}`,
    })
  } else {
    checks.push({ id: 'escalation', label: 'Pack build completed', status: 'pass' })
  }

  // 2. Unresolved blocking assumptions -- independent of escalation: a pack built with
  // buildDespiteBlocking: true has workflows but can still carry unresolved blocking
  // assumptions that pack.escalation (only set when the pack was never built at all) won't catch.
  if (isEscalated) {
    checks.push({ id: 'blocking-assumptions', label: 'No unresolved blocking assumptions', status: 'skip', detail: 'N/A -- pack never built' })
  } else {
    const blocking = pack.assumptions.filter((a) => a.type === 'blocking')
    checks.push(blocking.length > 0
      ? { id: 'blocking-assumptions', label: 'No unresolved blocking assumptions', status: 'fail', detail: blocking.map((a) => a.text).join('; ') }
      : { id: 'blocking-assumptions', label: 'No unresolved blocking assumptions', status: 'pass' })
  }

  // 3. Pack-structural validation (duplicate names, unsafe_activation, schedule_conflict)
  if (isEscalated) {
    checks.push({ id: 'pack-validation', label: 'Pack-structural validation', status: 'skip', detail: 'N/A -- pack never built' })
  } else {
    const packErrors = findings.packItems.filter((i) => i.severity === 'error')
    const packWarnings = findings.packItems.filter((i) => i.severity === 'warning')
    if (packErrors.length > 0) {
      checks.push({ id: 'pack-validation', label: 'Pack-structural validation', status: 'fail', detail: packErrors.map((i) => i.message).join('; ') })
    } else if (packWarnings.length > 0) {
      checks.push({ id: 'pack-validation', label: 'Pack-structural validation', status: 'warn', detail: packWarnings.map((i) => i.message).join('; ') })
    } else {
      checks.push({ id: 'pack-validation', label: 'Pack-structural validation', status: 'pass' })
    }
  }

  // 4. All workflows deployed
  if (isEscalated) {
    checks.push({ id: 'undeployed-workflows', label: 'All workflows deployed', status: 'skip', detail: 'N/A -- pack never built' })
  } else {
    const undeployed = pack.workflows.filter((wf) => !wf.deployed)
    checks.push(undeployed.length > 0
      ? { id: 'undeployed-workflows', label: 'All workflows deployed', status: 'fail', detail: `Not deployed: ${undeployed.map((wf) => wf.name).join(', ')}` }
      : { id: 'undeployed-workflows', label: 'All workflows deployed', status: 'pass' })
  }

  // 5 & 6. Error/warning-severity finalIssues, from the same computeRiskFindings() workflowItems
  // used by generateRiskReport() -- this is where Rule 59 (missing webhook auth) surfaces
  // automatically as a warning, with zero new logic needed here.
  if (isEscalated) {
    checks.push({ id: 'error-issues', label: 'No error-severity validation issues', status: 'skip', detail: 'N/A -- pack never built' })
    checks.push({ id: 'warning-issues', label: 'No warning-severity validation issues', status: 'skip', detail: 'N/A -- pack never built' })
  } else {
    const allWorkflowItems = [...findings.workflowItems.entries()].flatMap(([name, items]) => items.map((i) => ({ ...i, workflow: name })))
    const errorItems = allWorkflowItems.filter((i) => i.severity === 'error')
    const warningItems = allWorkflowItems.filter((i) => i.severity === 'warning')
    checks.push(errorItems.length > 0
      ? { id: 'error-issues', label: 'No error-severity validation issues', status: 'fail', detail: errorItems.map((i) => `${i.workflow}: ${i.message}`).join('; ') }
      : { id: 'error-issues', label: 'No error-severity validation issues', status: 'pass' })
    checks.push(warningItems.length > 0
      ? { id: 'warning-issues', label: 'No warning-severity validation issues', status: 'warn', detail: warningItems.map((i) => `${i.workflow}: ${i.message}`).join('; ') }
      : { id: 'warning-issues', label: 'No warning-severity validation issues', status: 'pass' })
  }

  // 7. Credential checklist -- informational only. The offline pack JSON can never confirm
  // these are actually connected in n8n (that's the --live check); this is a reminder list.
  if (isEscalated) {
    checks.push({ id: 'credentials-checklist', label: 'Credentials to connect before launch', status: 'skip', detail: 'N/A -- pack never built' })
  } else {
    const seen = new Set<string>()
    const services: string[] = []
    for (const wf of pack.workflows) {
      for (const cred of wf.credentialsNeeded) {
        const key = `${cred.service} ${cred.credentialType}`
        if (!seen.has(key)) { seen.add(key); services.push(`${cred.service} (${cred.credentialType})`) }
      }
    }
    checks.push(services.length > 0
      ? { id: 'credentials-checklist', label: 'Credentials to connect before launch', status: 'info', detail: services.join(', ') }
      : { id: 'credentials-checklist', label: 'Credentials to connect before launch', status: 'info', detail: 'None required' })
  }

  // 8 & 9. Placeholder credential IDs, and a best-effort Google Sheets ID signal -- both need
  // a live fetch. Fetched once per workflow, shared across both checks (and check 10's webhook
  // enumeration) rather than re-fetching per check.
  let webhookShapedWorkflows: string[] | undefined
  if (isEscalated) {
    checks.push({ id: 'placeholder-credentials', label: 'No placeholder/unwired credential IDs', status: 'skip', detail: 'N/A -- pack never built' })
    checks.push({ id: 'sheets-ids', label: 'Google Sheets IDs set', status: 'skip', detail: 'N/A -- pack never built' })
  } else if (!live) {
    checks.push({ id: 'placeholder-credentials', label: 'No placeholder/unwired credential IDs', status: 'skip', detail: 'N/A -- needs --live' })
    checks.push({ id: 'sheets-ids', label: 'Google Sheets IDs set', status: 'skip', detail: 'N/A -- needs --live' })
  } else {
    const liveData = await fetchLiveWorkflowData(pack, options.client!)

    const unwiredCreds: string[] = []
    const credFetchFailures: string[] = []
    const emptySheetIds: string[] = []
    const unverifiedSheetIds: string[] = []
    const sheetFetchFailures: string[] = []
    const webhookShaped: string[] = []

    for (const [name, data] of liveData) {
      if (data.fetchError) {
        credFetchFailures.push(`${name} (${data.fetchError})`)
        sheetFetchFailures.push(`${name} (${data.fetchError})`)
        continue
      }
      if (!data.workflow) continue // not deployed -- already covered by the undeployed-workflows check

      for (const node of data.workflow.nodes) {
        if (!node.credentials) continue
        for (const [credType, ref] of Object.entries(node.credentials)) {
          if (!ref.id || ref.id === 'placeholder-id') {
            unwiredCreds.push(`${name} → "${node.name}" (${credType})`)
          }
        }
      }

      for (const sheetNode of findSheetNodes(data.workflow)) {
        if (!sheetNode.currentDocId) emptySheetIds.push(`${name} → "${sheetNode.nodeName}"`)
        else unverifiedSheetIds.push(`${name} → "${sheetNode.nodeName}"`)
      }

      if (findWebhookTrigger(data.workflow)) webhookShaped.push(name)
    }

    if (unwiredCreds.length > 0) {
      const suffix = credFetchFailures.length > 0 ? ` | Could not verify: ${credFetchFailures.join('; ')}` : ''
      checks.push({ id: 'placeholder-credentials', label: 'No placeholder/unwired credential IDs', status: 'fail', detail: `Unwired: ${unwiredCreds.join('; ')}${suffix}` })
    } else if (credFetchFailures.length > 0) {
      checks.push({ id: 'placeholder-credentials', label: 'No placeholder/unwired credential IDs', status: 'warn', detail: `Could not verify: ${credFetchFailures.join('; ')}` })
    } else {
      checks.push({ id: 'placeholder-credentials', label: 'No placeholder/unwired credential IDs', status: 'pass' })
    }

    // The Sheets check must never render a bare pass when it found real values to (not fully)
    // verify -- there's no placeholder-literal convention for Sheet IDs the way there is for
    // credentials, so a non-empty value is only ever "not obviously wrong," never confirmed.
    if (emptySheetIds.length > 0) {
      const suffix = sheetFetchFailures.length > 0 ? ` | Could not verify: ${sheetFetchFailures.join('; ')}` : ''
      checks.push({ id: 'sheets-ids', label: 'Google Sheets IDs set', status: 'fail', detail: `Not set: ${emptySheetIds.join('; ')}${suffix}` })
    } else if (unverifiedSheetIds.length > 0) {
      checks.push({ id: 'sheets-ids', label: 'Google Sheets IDs set', status: 'pass', detail: `${unverifiedSheetIds.length} Sheet ID(s) present but unverified -- no placeholder marker exists for this field, confirm manually: ${unverifiedSheetIds.join('; ')}` })
    } else if (sheetFetchFailures.length > 0) {
      checks.push({ id: 'sheets-ids', label: 'Google Sheets IDs set', status: 'warn', detail: `Could not verify: ${sheetFetchFailures.join('; ')}` })
    } else {
      checks.push({ id: 'sheets-ids', label: 'Google Sheets IDs set', status: 'pass' })
    }

    webhookShapedWorkflows = webhookShaped
  }

  // 11. Test-artifact presence -- knowing WHICH workflows are webhook-shaped requires --live
  // (the live node graph), so this check's meaning depends on whether --live was also passed,
  // not just whether --bundle-dir was. Never claim a count we don't actually have.
  if (isEscalated) {
    checks.push({ id: 'test-artifacts', label: 'Test artifacts generated for webhook workflows', status: 'skip', detail: 'N/A -- pack never built' })
  } else if (!live) {
    checks.push({ id: 'test-artifacts', label: 'Test artifacts generated for webhook workflows', status: 'skip', detail: 'Webhook artifact checks require --live' })
  } else if (!options.bundleDir) {
    const n = webhookShapedWorkflows?.length ?? 0
    checks.push(n > 0
      ? { id: 'test-artifacts', label: 'Test artifacts generated for webhook workflows', status: 'info', detail: `${n} webhook-shaped workflow(s) found -- pass --bundle-dir to check for generated test artifacts` }
      : { id: 'test-artifacts', label: 'Test artifacts generated for webhook workflows', status: 'pass', detail: 'No webhook-shaped workflows found' })
  } else {
    const missing: string[] = []
    for (const name of webhookShapedWorkflows ?? []) {
      const slug = slugifyWorkflowName(name)
      const testPayloadsExists = await fileExists(join(options.bundleDir, `${slug}.test-payloads.json`))
      const openApiExists = await fileExists(join(options.bundleDir, `${slug}.contract.openapi.json`))
      if (!testPayloadsExists) missing.push(`${name} (missing test-payloads.json)`)
      if (!openApiExists) missing.push(`${name} (missing contract.openapi.json)`)
    }
    // Non-blocking at most GO WITH WARNINGS -- these are already-heuristic, best-effort
    // artifacts (Delivery Bundle Phase 5/6); their absence shouldn't be treated as more
    // serious than the artifacts themselves claim to be.
    checks.push(missing.length > 0
      ? { id: 'test-artifacts', label: 'Test artifacts generated for webhook workflows', status: 'warn', detail: missing.join('; ') }
      : { id: 'test-artifacts', label: 'Test artifacts generated for webhook workflows', status: 'pass' })
  }

  // 12. Bundle manifest freshness -- purely informational, not a go/no-go check. Only rendered
  // at all when --bundle-dir was actually given (there's nothing to report otherwise).
  if (options.bundleDir) {
    const manifestPath = join(options.bundleDir, 'bundle-manifest.json')
    try {
      const raw = await readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(raw) as BundleManifest
      const skipSummary = manifest.skipped.length > 0
        ? ` ${manifest.skipped.length} artifact(s) were skipped during generation: ${manifest.skipped.map((s) => `${s.artifact}${s.workflowName ? ` (${s.workflowName})` : ''} -- ${s.reason}`).join('; ')}`
        : ''
      // Absent on a bundle written before this field existed -- "unknown," not a mismatch.
      const provenanceSummary = manifest.provenance === undefined
        ? ' Bundle predates provenance tracking -- cannot compare against current rules/catalog/prompt.'
        : manifest.provenance.ruleSetVersion === provenance.ruleSetVersion
          && manifest.provenance.promptVersion === provenance.promptVersion
          && JSON.stringify(manifest.provenance.nodeCatalogVersion) === JSON.stringify(provenance.nodeCatalogVersion)
          ? ' Bundle was generated under the same rule-set/prompt/catalog versions as current.'
          : ' Bundle was generated under different rule-set/prompt/catalog versions than current -- re-exporting may pick up different behavior.'
      checks.push({ id: 'bundle-manifest', label: 'Bundle manifest', status: 'info', detail: `Last generated: ${manifest.generatedAt}.${skipSummary}${provenanceSummary}` })
    } catch (err) {
      checks.push({ id: 'bundle-manifest', label: 'Bundle manifest', status: 'warn', detail: `Could not read bundle-manifest.json at ${options.bundleDir}: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const verdict = computeVerdict(checks, isEscalated)

  return {
    packName: pack.packName,
    businessContext: pack.businessContext,
    verdict,
    checks,
    provenance,
    ...(webhookShapedWorkflows !== undefined ? { webhookShapedWorkflows } : {}),
  }
}

interface LiveWorkflowData {
  /** null when the workflow was never deployed (no workflowId) or its live fetch failed. */
  workflow: N8nWorkflow | null
  /** Set only when there WAS a workflowId but the fetch itself failed (n8n unreachable,
   * workflow deleted) -- distinct from "never deployed," which isn't a fetch failure. */
  fetchError: string | null
}

/** Fetches each deployed workflow's current n8n state once, shared across every --live check
 * (placeholder credentials, Sheets IDs, webhook enumeration) rather than re-fetching per check. */
async function fetchLiveWorkflowData(pack: WorkflowPackResult, client: N8nApiClient): Promise<Map<string, LiveWorkflowData>> {
  const result = new Map<string, LiveWorkflowData>()
  for (const wf of pack.workflows) {
    if (!wf.workflowId) {
      result.set(wf.name, { workflow: null, fetchError: null })
      continue
    }
    const workflow = await fetchWorkflowJson(wf.workflowId, client)
    result.set(wf.name, { workflow, fetchError: workflow ? null : `could not fetch workflow ${wf.workflowId} from n8n` })
  }
  return result
}

function computeVerdict(checks: PreflightCheck[], isEscalated: boolean): PreflightVerdict {
  if (isEscalated) return 'BLOCKED'
  if (checks.some((c) => c.status === 'fail')) return 'NO-GO'
  if (checks.some((c) => c.status === 'warn')) return 'GO WITH WARNINGS'
  return 'GO'
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** Renders a PreflightResult as a scannable checklist -- one line per check, not narrative prose. */
export function formatPreflightChecklist(result: PreflightResult): string {
  const lines: string[] = []
  lines.push(`# ${result.businessContext} — Preflight`)
  lines.push('')
  lines.push(`**Verdict: ${result.verdict}**`)
  lines.push('')
  for (const check of result.checks) {
    const icon = STATUS_ICON[check.status]
    const line = `${icon} ${check.label}`
    lines.push(check.detail ? `${line} — ${check.detail}` : line)
  }
  return lines.join('\n')
}
