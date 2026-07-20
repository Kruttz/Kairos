import type { ProcessContract } from './types.js'
import type { PromiseComplianceFinding } from './sla-compliance.js'
import type { ExceptionDeskItem, ExceptionKind, ExceptionStatus, ExceptionStatusChange } from './exception-types.js'

/**
 * ExceptionDesk v0 open/update logic (Phase 4). Pure -- given the latest compliance findings and
 * the exceptions already on file, decides what to open or update. No I/O here; exception-store.ts
 * owns persistence, cli.ts/watch loop own wiring.
 *
 * Only 'drifting' findings ever open or touch an exception (Codex: "Open ExceptionDesk items
 * only for concrete missed/stuck/ambiguous promise instances") -- insufficient_data,
 * not_applicable, and healthy never do, matching the 4-state discipline exactly. Opening is
 * automatic (actor: 'auto'); nothing else about an item's lifecycle is -- see exception-types.ts.
 */

function classifyFinding(finding: PromiseComplianceFinding): ExceptionKind {
  if (finding.kind === 'expiration') return 'stuck'
  // kind === 'sla'. A drifting finding built on 'generic' (indirect) evidence is real, but the
  // exact timing is inferred, not directly observed -- surfaced as its own kind so a reviewer
  // sees the lower confidence in the classification itself, not just buried in a field.
  return finding.evidenceQuality === 'generic' ? 'ambiguous_evidence' : 'missed_sla'
}

function relevantStateFor(contract: ProcessContract, finding: PromiseComplianceFinding): string | undefined {
  if (finding.kind === 'sla') return contract.sla.find(s => s.id === finding.slaId)?.expectedBy.state
  return contract.expirationRules?.find(r => r.id === finding.expirationRuleId)?.state
}

/** Owner: a direct OwnerAssignment lookup only, never invented. nextAction: reuses the
 * contract's own ExceptionRule.suggestedAction only when the contract declares exactly one --
 * the common v0 case (Empire Homecare has one). With more than one declared, nothing picks one
 * over another by a guess (the schema has no id-based link between ExceptionRule and
 * SlaSpec/ExpirationRule to resolve that ambiguity honestly) -- a neutral, finding-derived
 * instruction is used instead. This is a real, named v0 simplification, not a hidden gap. */
function deriveOwnerAndAction(contract: ProcessContract, finding: PromiseComplianceFinding): { owner: string; nextAction: string } {
  const state = relevantStateFor(contract, finding)
  const ownerFromState = state ? contract.owners.find(o => o.state === state)?.owner : undefined

  if (contract.exceptions.length === 1) {
    return { owner: ownerFromState ?? contract.exceptions[0]!.owner, nextAction: contract.exceptions[0]!.suggestedAction }
  }

  const nextAction = finding.kind === 'sla'
    ? `Confirm whether "${state ?? 'the expected state'}" has actually been reached for this instance, and log the outcome.`
    : `Confirm whether this instance has moved past "${state ?? 'its current state'}", and log the outcome or escalate manually.`

  return { owner: ownerFromState ?? '(no owner declared for this state)', nextAction }
}

function evidenceRefs(finding: PromiseComplianceFinding): string[] {
  const refs: string[] = []
  for (const [key, value] of Object.entries(finding.evidence)) {
    refs.push(`${key}=${String(value)}`)
  }
  return refs
}

function exceptionKey(finding: PromiseComplianceFinding): string {
  return finding.kind === 'sla' ? `sla:${finding.slaId}` : `expiration:${finding.expirationRuleId}`
}

/** One item per (contractId, promiseInstanceId, sla-or-expiration-rule) -- stable across ticks
 * so a re-detection updates the same item rather than opening a duplicate. */
function findExistingItem(items: ExceptionDeskItem[], finding: PromiseComplianceFinding): ExceptionDeskItem | undefined {
  return items.find(i =>
    i.contractId === finding.contractId &&
    i.promiseInstanceId === finding.promiseInstanceId &&
    (finding.kind === 'sla' ? i.slaId === finding.slaId : i.expirationRuleId === finding.expirationRuleId)
  )
}

export interface ExceptionDeskUpdateResult {
  opened: ExceptionDeskItem[]
  /** An existing item whose underlying finding still applies -- refreshed (updatedAt, reason,
   * evidence) but its status/history untouched. A human-resolved item that later drifts again is
   * deliberately NOT silently reopened here (see reopenOnRecurrence below) -- resolution is a
   * human judgment call this module never overrides on its own. */
  refreshed: ExceptionDeskItem[]
}

/**
 * Compares this tick's compliance findings against exceptions already on file and returns what
 * to open (brand new) or refresh (still-open items whose underlying condition persists). Never
 * mutates `existingItems` -- returns new objects; the caller decides how to persist them.
 */
export function updateExceptionDesk(
  contract: ProcessContract,
  findings: PromiseComplianceFinding[],
  existingItems: ExceptionDeskItem[],
  now: Date = new Date(),
): ExceptionDeskUpdateResult {
  const nowIso = now.toISOString()
  const opened: ExceptionDeskItem[] = []
  const refreshed: ExceptionDeskItem[] = []

  for (const finding of findings) {
    if (finding.status !== 'drifting') continue

    const existing = findExistingItem(existingItems, finding)
    if (!existing) {
      const { owner, nextAction } = deriveOwnerAndAction(contract, finding)
      const openEvent: ExceptionStatusChange = { ts: nowIso, from: null, to: 'open', actor: 'auto', reason: finding.summary }
      opened.push({
        id: `${finding.contractId}:${finding.promiseInstanceId}:${exceptionKey(finding)}`,
        contractId: finding.contractId,
        promiseInstanceId: finding.promiseInstanceId,
        kind: classifyFinding(finding),
        status: 'open',
        owner,
        nextAction,
        reason: finding.summary,
        evidence: evidenceRefs(finding),
        ...(finding.slaId ? { slaId: finding.slaId } : {}),
        ...(finding.expirationRuleId ? { expirationRuleId: finding.expirationRuleId } : {}),
        detectedAt: nowIso,
        updatedAt: nowIso,
        history: [openEvent],
      })
      continue
    }

    // A resolved item never gets silently reopened by continued drift -- if a human closed it,
    // a NEW drifting signal for the same instance is either the human's action not having
    // registered yet in the ledger, or a genuinely new occurrence; either way, deciding to reopen
    // it is a human call (`kairos exceptions list` will still surface the fresh finding via a
    // brand-new item only once the old one's own key no longer matches, e.g. a version bump --
    // v0 does not attempt to distinguish these automatically).
    if (existing.status === 'resolved') continue

    refreshed.push({ ...existing, reason: finding.summary, evidence: evidenceRefs(finding), updatedAt: nowIso })
  }

  return { opened, refreshed }
}

/** The ONLY way an item's status ever changes to something other than 'open' -- always
 * actor: 'human', matching Codex's guardrail literally: "no auto-resolution." cli.ts's
 * `kairos exceptions ack`/`resolve` are the only callers. */
export function applyHumanStatusChange(item: ExceptionDeskItem, to: ExceptionStatus, now: Date = new Date(), reason?: string): ExceptionDeskItem {
  const change: ExceptionStatusChange = { ts: now.toISOString(), from: item.status, to, actor: 'human', ...(reason ? { reason } : {}) }
  return { ...item, status: to, updatedAt: now.toISOString(), history: [...item.history, change] }
}
