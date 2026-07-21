import { checkSlaCompliance, stateReachSignals } from './sla-compliance.js'
import type { ProcessContract } from './types.js'
import type { ProofLedgerEntry } from './ledger-types.js'
import type { ExceptionDeskItem } from './exception-types.js'

/**
 * Promise Report v0 (Phase 5, docs/plans/process-contract-promise-engine-plan.md §5.6). The
 * final piece of Promise Engine v0's own loop: contract -> compile -> workflows -> ledger -> SLA
 * monitor -> exceptions -> report. Client-facing, generated from ProcessContract + ProofLedger +
 * ExceptionDesk data only -- no new computation beyond what those three already produce, no new
 * evidence extraction, no new claims.
 *
 * Guardrails honored throughout, by construction: no fake ROI math (every number here is a real
 * count or a real elapsed-time value, never a dollar figure or "hours saved" estimate this
 * codebase has no basis to compute); no raw PII (every identifier is either a hashed
 * promiseInstanceId or evidence text ProofLedger's own whitelist-by-contract discipline already
 * guarantees is safe -- report.ts introduces no new field access into raw execution data at
 * all); no dashboard (a markdown file, written once per invocation, not a live view); no
 * autonomous decisions (purely descriptive -- nothing here triggers or resolves anything).
 */

/**
 * Five states, not Codex's literal four -- 'in_progress' was a real gap found while building
 * this: an instance that hasn't reached a terminal outcome, has no drifting finding, and has no
 * open exception is genuinely "still active, nothing wrong yet," which is neither 'kept' (the
 * promise isn't fulfilled yet) nor 'unverifiable' (there's no ambiguity, it's just not done) nor
 * 'at_risk' (nothing has actually been flagged). Misclassifying every in-flight instance into one
 * of the four requested buckets would be less honest than naming the real fifth case -- named and
 * counted separately in the report, not silently folded into any of Codex's four.
 */
export type PromiseInstanceStatus = 'kept' | 'at_risk' | 'missed' | 'unverifiable' | 'in_progress'

export interface PromiseInstanceClassification {
  status: PromiseInstanceStatus
  detail: string
  /** Present for 'kept'/'missed'/'unverifiable' -- absent for 'at_risk'/'in_progress', which
   * aren't built from a single piece of confirming/disconfirming evidence the way the other
   * three are. */
  evidenceQuality?: 'specific' | 'generic'
}

/**
 * The whole point of this function, stated plainly per Codex's own guardrail: "never count
 * unverifiable as kept." A terminal state reached only via indirect (generic-confidence)
 * evidence is classified 'unverifiable', a structurally separate branch from 'kept' -- not a
 * lower-confidence flavor of it.
 */
export function classifyPromiseInstance(
  contract: ProcessContract,
  instanceEntries: ProofLedgerEntry[],
  instanceExceptions: ExceptionDeskItem[],
  now: Date = new Date(),
): PromiseInstanceClassification {
  const findings = checkSlaCompliance(contract, instanceEntries, now)
  const drifting = findings.filter(f => f.status === 'drifting')
  // P0 measurement-integrity fix (2026-07-20): a finding sla-compliance.ts downgraded from
  // healthy/drifting to 'unverifiable' because this contract declares pause rules it can't yet
  // account for (applyPauseRuleCaveat). Codex's explicit instruction: "do not compute normal SLA
  // kept/missed numbers while ignoring pauses" -- so this instance's own classification must not
  // confidently claim 'kept' (or 'missed' from a suppressed drift) either, once at least one of
  // its findings couldn't be confidently determined.
  const pauseAffected = findings.filter(f => f.status === 'unverifiable')

  for (const outcome of contract.terminalOutcomes) {
    const signals = stateReachSignals(contract, instanceEntries, outcome.state)
    if (signals.length === 0) continue
    const confidence = signals[0]!.confidence

    if (outcome.outcome === 'failure') {
      return { status: 'missed', detail: `Reached terminal state "${outcome.state}" (${outcome.outcome}): ${outcome.description}`, evidenceQuality: confidence }
    }
    if (drifting.length > 0) {
      return {
        status: 'missed',
        detail: `Reached terminal state "${outcome.state}" (${outcome.outcome}), but ${drifting.length} SLA/expiration finding(s) drifted along the way: ${drifting[0]!.summary}`,
        evidenceQuality: 'specific',
      }
    }
    if (pauseAffected.length > 0) {
      return {
        status: 'unverifiable',
        detail: `Reached terminal state "${outcome.state}" (${outcome.outcome}), but this contract declares pause rule(s) that Kairos's SLA compliance checking does not yet account for in v0 -- cannot confidently confirm the promise's timing commitments were met along the way: ${pauseAffected[0]!.summary}`,
      }
    }
    if (confidence === 'generic') {
      return {
        status: 'unverifiable',
        detail: `Reached terminal state "${outcome.state}" (${outcome.outcome}) only via indirect evidence -- cannot confidently confirm the promise was kept.`,
        evidenceQuality: 'generic',
      }
    }
    return { status: 'kept', detail: `Reached terminal state "${outcome.state}" (${outcome.outcome}): ${outcome.description}`, evidenceQuality: 'specific' }
  }

  if (drifting.length > 0) {
    const worst = drifting[0]!
    return { status: 'missed', detail: worst.summary, evidenceQuality: worst.evidenceQuality ?? 'specific' }
  }

  if (pauseAffected.length > 0) {
    return {
      status: 'unverifiable',
      detail: `This instance has SLA/expiration finding(s) affected by this contract's declared pause rule(s), which Kairos's SLA compliance checking does not yet account for in v0: ${pauseAffected[0]!.summary}`,
    }
  }

  const hasOpenException = instanceExceptions.some(e => e.status === 'open' || e.status === 'acknowledged')
  if (hasOpenException) {
    return { status: 'at_risk', detail: 'Has an open or acknowledged exception that has not been resolved yet.' }
  }

  return { status: 'in_progress', detail: 'Still active -- no terminal outcome reached yet, and no issues found so far.' }
}

export interface PromiseReportWindow {
  from?: string
  to?: string
}

export interface PromiseReportInstanceSummary {
  promiseInstanceId: string
  status: PromiseInstanceStatus
  detail: string
  evidenceQuality?: 'specific' | 'generic'
}

export interface PromiseReportOpenException {
  id: string
  kind: string
  status: 'open' | 'acknowledged'
  owner: string
  nextAction: string
  promiseInstanceId: string
  detectedAt: string
}

export interface PromiseReportData {
  contractId: string
  contractName: string
  contractVersion: number
  clientId: string
  promiseText: string
  contractStatus: string
  provenance: ProcessContract['provenance']
  generatedAt: string
  window: PromiseReportWindow
  totalInstances: number
  instanceCounts: Record<PromiseInstanceStatus, number>
  instances: PromiseReportInstanceSummary[]
  openExceptionCount: number
  acknowledgedExceptionCount: number
  resolvedExceptionCount: number
  openExceptions: PromiseReportOpenException[]
  evidenceQualityBreakdown: { specific: number; generic: number }
  /** Executions where evidence was expected but couldn't be attributed to any promise instance
   * (P0 measurement-integrity fix, 2026-07-20, fix #11 -- the "invisible-failure blind spot") --
   * these are NOT counted anywhere in `instanceCounts`/`totalInstances` above, since there is no
   * instance id to count them against. Supplied by the caller (cli.ts sums
   * ContractPollWatermark.cumulativeUnattributedCount across every workflow registered to this
   * contract) since this module stays pure/no-IO -- 0 when the caller doesn't have this data.
   * Always shown as a disclaimer when non-zero, so this report never implies its counts are a
   * complete picture of every execution that ever ran. */
  unattributedExecutionCount: number
  /** Plain-language caveats about what this report can and can't actually prove -- always
   * computed, never omitted just because the numbers look fine. Codex's explicit guardrail: "if
   * evidence is incomplete, say so plainly." */
  disclaimers: string[]
}

function inWindow(ts: string, window: PromiseReportWindow): boolean {
  if (window.from && ts < window.from) return false
  if (window.to && ts > window.to) return false
  return true
}

export function buildPromiseReportData(
  contract: ProcessContract,
  allEntries: ProofLedgerEntry[],
  allExceptions: ExceptionDeskItem[],
  window: PromiseReportWindow = {},
  now: Date = new Date(),
  /** Sum of ContractPollWatermark.cumulativeUnattributedCount across every workflow registered
   * to this contract (P0 measurement-integrity fix, 2026-07-20, fix #11) -- supplied by the
   * caller (cli.ts), since this function stays pure/no-IO. 0 when the caller doesn't supply it
   * (e.g. existing callers/tests predating this fix), which degrades gracefully to "nothing
   * known to warn about," never a false claim either way. */
  unattributedExecutionCount = 0,
): PromiseReportData {
  // Window filtering prefers eventTime (the real n8n execution's own startedAt) over observedAt
  // (P0 measurement-integrity fix, 2026-07-20) -- a "show me July" report should include an
  // event that happened in July even if Kairos didn't poll for it until August, and should NOT
  // include an event that happened in June just because a backfilled poll discovered it in July.
  const windowedEntries = allEntries.filter(e => e.contractId === contract.id && inWindow(e.eventTime ?? e.observedAt, window))
  const windowedExceptions = allExceptions.filter(e => e.contractId === contract.id && inWindow(e.detectedAt, window))

  const instanceIds = [...new Set(windowedEntries.map(e => e.promiseInstanceId))]

  const instanceCounts: Record<PromiseInstanceStatus, number> = { kept: 0, missed: 0, at_risk: 0, unverifiable: 0, in_progress: 0 }
  const instances: PromiseReportInstanceSummary[] = []
  let specificCount = 0
  let genericCount = 0

  for (const promiseInstanceId of instanceIds) {
    const instanceEntries = windowedEntries.filter(e => e.promiseInstanceId === promiseInstanceId)
    const instanceExceptions = windowedExceptions.filter(e => e.promiseInstanceId === promiseInstanceId)
    const classification = classifyPromiseInstance(contract, instanceEntries, instanceExceptions, now)
    instanceCounts[classification.status]++
    if (classification.evidenceQuality === 'specific') specificCount++
    if (classification.evidenceQuality === 'generic') genericCount++
    instances.push({ promiseInstanceId, ...classification })
  }

  const openItems = windowedExceptions.filter((e): e is ExceptionDeskItem & { status: 'open' | 'acknowledged' } => e.status === 'open' || e.status === 'acknowledged')
  const resolvedCount = windowedExceptions.filter(e => e.status === 'resolved').length

  const disclaimers: string[] = []
  const uncertain = instanceCounts.unverifiable + instanceCounts.in_progress
  if (instanceIds.length > 0 && uncertain > 0) {
    const pct = Math.round((uncertain / instanceIds.length) * 100)
    disclaimers.push(
      `${uncertain} of ${instanceIds.length} instance(s) (${pct}%) are 'unverifiable' or still 'in_progress' -- this report shows only what ProofLedger's recorded evidence can currently prove, never a guarantee about every referral's real-world status.`
    )
  }
  if (instanceIds.length === 0) {
    disclaimers.push('No promise instances have any recorded evidence in this window -- there is nothing to summarize beyond exception counts below.')
  }
  if (genericCount > 0) {
    disclaimers.push(
      `${genericCount} classification(s) above rely on indirect (generic-confidence) evidence -- inferred from a later transition, not a direct observation of the state being entered. See each instance's own detail for which ones.`
    )
  }
  // P0 measurement-integrity fix (2026-07-20): always shown when the contract declares any
  // pauseRules, regardless of whether any instance actually classified 'unverifiable' this run --
  // a structural limitation of this contract's shape, not a per-run finding.
  if (contract.pauseRules?.length) {
    disclaimers.push(
      `This contract declares ${contract.pauseRules.length} pause rule(s) (e.g. "${contract.pauseRules[0]!.condition}"). Kairos's SLA compliance checking does not yet account for paused time in v0 -- any SLA/expiration determination that would otherwise be healthy or drifting is instead reported as 'unverifiable', since elapsed time may include a paused span that should not count against the deadline.`
    )
  }
  // P0 measurement-integrity fix (2026-07-20, fix #11): the counts above are NOT a complete
  // picture of every execution that ever ran -- this many had evidence expected but no readable
  // correlation key, so they never became a ledger entry and are absent from both the numerator
  // and denominator of instanceCounts. Shown unconditionally when non-zero, matching the
  // pause-rule disclaimer's own "always surface a real structural limitation" discipline.
  if (unattributedExecutionCount > 0) {
    disclaimers.push(
      `${unattributedExecutionCount} execution(s) across this contract's registered workflows had evidence expected but no readable correlation key -- no ledger entry exists for them, and they are NOT counted anywhere above. Run "kairos ledger poll" for detail on which executions.`
    )
  }

  return {
    contractId: contract.id,
    contractName: contract.name,
    contractVersion: contract.version,
    clientId: contract.clientId,
    promiseText: contract.promise.text,
    contractStatus: contract.status,
    provenance: contract.provenance,
    generatedAt: now.toISOString(),
    window,
    totalInstances: instanceIds.length,
    instanceCounts,
    instances,
    openExceptionCount: openItems.filter(e => e.status === 'open').length,
    acknowledgedExceptionCount: openItems.filter(e => e.status === 'acknowledged').length,
    resolvedExceptionCount: resolvedCount,
    openExceptions: openItems.map(e => ({
      id: e.id, kind: e.kind, status: e.status, owner: e.owner, nextAction: e.nextAction,
      promiseInstanceId: e.promiseInstanceId, detectedAt: e.detectedAt,
    })),
    evidenceQualityBreakdown: { specific: specificCount, generic: genericCount },
    unattributedExecutionCount,
    disclaimers,
  }
}

const STATUS_LABELS: Record<PromiseInstanceStatus, string> = {
  kept: 'Kept',
  missed: 'Missed',
  at_risk: 'At risk',
  unverifiable: 'Unverifiable',
  in_progress: 'In progress',
}

export function generatePromiseReport(data: PromiseReportData): string {
  const lines: string[] = []
  const line = () => lines.push('')

  lines.push(`# Promise Report — ${data.contractName}`)
  line()
  lines.push(`**Contract:** \`${data.contractId}\` v${data.contractVersion} (client: ${data.clientId}, status: ${data.contractStatus})`)
  lines.push(`**Promise:** ${data.promiseText}`)
  lines.push(`**Generated:** ${data.generatedAt}`)
  lines.push(`**Time window:** ${data.window.from ?? '(beginning of record)'} to ${data.window.to ?? '(now)'}`)
  lines.push(`**Provenance:** authored by ${data.provenance.authoredBy}${data.provenance.model ? ` (${data.provenance.model})` : ''}, Kairos ${data.provenance.kairosVersion}`)
  line()

  lines.push(`## Summary`)
  line()
  lines.push(`| Status | Count |`)
  lines.push(`|---|---|`)
  for (const status of ['kept', 'at_risk', 'missed', 'unverifiable', 'in_progress'] as const) {
    lines.push(`| ${STATUS_LABELS[status]} | ${data.instanceCounts[status]} |`)
  }
  lines.push(`| **Total instances** | **${data.totalInstances}** |`)
  line()
  lines.push(`Open exceptions: ${data.openExceptionCount}   Acknowledged: ${data.acknowledgedExceptionCount}   Resolved: ${data.resolvedExceptionCount}`)
  line()
  lines.push(`Evidence quality: ${data.evidenceQualityBreakdown.specific} classification(s) from direct evidence, ${data.evidenceQualityBreakdown.generic} from indirect (inferred) evidence.`)
  line()

  if (data.disclaimers.length > 0) {
    lines.push(`## Disclaimers`)
    line()
    for (const d of data.disclaimers) lines.push(`> ${d}`)
    line()
  }

  lines.push(`## Open Exceptions — Owner / Action Summary`)
  line()
  if (data.openExceptions.length === 0) {
    lines.push(`No open or acknowledged exceptions in this window.`)
  } else {
    lines.push(`| Owner | Kind | Status | Next Action | Instance | Detected |`)
    lines.push(`|---|---|---|---|---|---|`)
    for (const e of data.openExceptions) {
      lines.push(`| ${e.owner} | ${e.kind} | ${e.status} | ${e.nextAction} | ${e.promiseInstanceId.slice(0, 12)}... | ${e.detectedAt} |`)
    }
  }
  line()

  lines.push(`## Per-Instance Detail`)
  line()
  if (data.instances.length === 0) {
    lines.push(`No instances recorded in this window.`)
  } else {
    for (const i of data.instances) {
      lines.push(`- **${STATUS_LABELS[i.status]}** (instance \`${i.promiseInstanceId.slice(0, 12)}...\`${i.evidenceQuality ? `, ${i.evidenceQuality} evidence` : ''}): ${i.detail}`)
    }
  }

  return lines.join('\n')
}
