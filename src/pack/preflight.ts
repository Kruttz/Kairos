import type { WorkflowPackResult } from './pack-builder.js'
import { computeRiskFindings } from './pack-bundle.js'
import type { N8nApiClient } from '../providers/n8n/index.js'

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
export async function runPreflight(pack: WorkflowPackResult, _options: PreflightOptions = {}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []
  const findings = computeRiskFindings(pack)
  const isEscalated = pack.escalation !== undefined

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

  const verdict = computeVerdict(checks, isEscalated)

  return {
    packName: pack.packName,
    businessContext: pack.businessContext,
    verdict,
    checks,
  }
}

function computeVerdict(checks: PreflightCheck[], isEscalated: boolean): PreflightVerdict {
  if (isEscalated) return 'BLOCKED'
  if (checks.some((c) => c.status === 'fail')) return 'NO-GO'
  if (checks.some((c) => c.status === 'warn')) return 'GO WITH WARNINGS'
  return 'GO'
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
