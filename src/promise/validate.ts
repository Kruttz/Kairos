import type { ProcessContract, ProcessState } from './types.js'

/**
 * ProcessContract v0's deterministic validator -- the contract-schema sibling of
 * src/validation/validator.ts's 131-rule workflow validator, scoped to a completely different
 * object shape (a state machine, not an n8n workflow). No LLM call, no network, pure and fast --
 * same trust profile as the workflow validator (docs/plans/process-contract-promise-engine-plan.md
 * §4.4).
 *
 * Implemented as a flat function, not a class, matching src/reliability/drift/checks.ts's own
 * precedent (a set of narrow, pure, evidence-driven checks) rather than N8nValidator's
 * stateful-class shape -- this validator needs no constructor config, so the simpler shape is
 * the right one, not a copy of a pattern built for a different need.
 *
 * The exact rule list here is more granular than the plan doc's original 9-item sketch (§4.4) --
 * writing the real reference-integrity checks surfaced that OwnerAssignment.state,
 * ExpirationRule.state/expiresTo, and EvidenceRequirement.transitionId all needed their own
 * dangling-reference checks too, which the original sketch's "SlaSpec + ExceptionRule +
 * EvidenceRequirement" wording didn't actually cover (ExceptionRule, checked directly against
 * its own type, has no state/event/transition-reference field at all -- only free-text
 * condition/owner/suggestedAction). The plan doc's §4.4 is updated to match what's actually
 * implemented here, not the other way around.
 */

export interface ContractValidationIssue {
  rule: number
  severity: 'error' | 'warn'
  message: string
  /** Which part of the contract this issue is about -- a state id, transition id, SLA id, etc.
   * Absent for contract-wide issues (e.g. "no success outcome exists anywhere"). */
  path?: string
}

function err(issues: ContractValidationIssue[], rule: number, message: string, path?: string): void {
  const issue: ContractValidationIssue = { rule, severity: 'error', message }
  if (path !== undefined) issue.path = path
  issues.push(issue)
}

/** Rule 1: every ProcessTransition.fromState/toState references a real ProcessState.id. */
function checkTransitionStateRefs(contract: ProcessContract, stateIds: Set<string>, issues: ContractValidationIssue[]): void {
  for (const t of contract.transitions) {
    if (!stateIds.has(t.fromState)) err(issues, 1, `Transition "${t.id}" references unknown fromState "${t.fromState}"`, t.id)
    if (!stateIds.has(t.toState)) err(issues, 1, `Transition "${t.id}" references unknown toState "${t.toState}"`, t.id)
  }
}

/** Rule 2: every ProcessTransition.event references a real ProcessEvent.id. */
function checkTransitionEventRefs(contract: ProcessContract, eventIds: Set<string>, issues: ContractValidationIssue[]): void {
  for (const t of contract.transitions) {
    if (!eventIds.has(t.event)) err(issues, 2, `Transition "${t.id}" references unknown event "${t.event}"`, t.id)
  }
}

/** Rule 3: every StartCondition.initialState references a real ProcessState.id, and every
 * state is reachable from some initialState via zero or more transitions. Computed together
 * since reachability needs a validated set of real starting points to search from -- an
 * initialState that doesn't exist can't seed a meaningful reachability search. */
function checkStartAndReachability(contract: ProcessContract, stateIds: Set<string>, issues: ContractValidationIssue[]): void {
  const validStarts: string[] = []
  for (const sc of contract.startConditions) {
    if (!stateIds.has(sc.initialState)) {
      err(issues, 3, `Start condition "${sc.id}" references unknown initialState "${sc.initialState}"`, sc.id)
    } else {
      validStarts.push(sc.initialState)
    }
  }

  const reachable = new Set<string>(validStarts)
  const adjacency = new Map<string, string[]>()
  for (const t of contract.transitions) {
    if (!adjacency.has(t.fromState)) adjacency.set(t.fromState, [])
    adjacency.get(t.fromState)!.push(t.toState)
  }
  // An ExpirationRule's state -> expiresTo is a real way to enter a state, not just an explicit
  // ProcessTransition -- found live against the Empire Homecare fixture itself: no_answer is
  // only ever reached via expiration (contact_attempted expires to it after 24 business hours),
  // never via a ProcessTransition, and the reachability check originally missed it entirely.
  for (const rule of contract.expirationRules ?? []) {
    if (!adjacency.has(rule.state)) adjacency.set(rule.state, [])
    adjacency.get(rule.state)!.push(rule.expiresTo)
  }
  const queue = [...validStarts]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next)
        queue.push(next)
      }
    }
  }

  for (const state of contract.states) {
    if (!reachable.has(state.id)) {
      err(issues, 3, `State "${state.id}" is unreachable -- no path from any StartCondition.initialState reaches it`, state.id)
    }
  }
}

/** Rule 4: a state flagged terminal has no outgoing transitions, and every state referenced by
 * a TerminalOutcome is flagged terminal -- and conversely, every terminal-flagged state is
 * referenced by at least one TerminalOutcome (kept as two directions, not one, so a state
 * marked terminal but never given an outcome -- success/acceptable/failure -- is caught too,
 * not just the reverse mistake). */
function checkTerminalConsistency(contract: ProcessContract, stateById: Map<string, ProcessState>, issues: ContractValidationIssue[]): void {
  const outgoingFrom = new Set(contract.transitions.map(t => t.fromState))
  for (const state of contract.states) {
    if (state.terminal && outgoingFrom.has(state.id)) {
      err(issues, 4, `State "${state.id}" is flagged terminal but has an outgoing transition -- a terminal state cannot transition further`, state.id)
    }
  }

  const outcomeStates = new Set(contract.terminalOutcomes.map(o => o.state))
  for (const outcome of contract.terminalOutcomes) {
    const state = stateById.get(outcome.state)
    if (!state) {
      err(issues, 4, `Terminal outcome references unknown state "${outcome.state}"`, outcome.state)
    } else if (!state.terminal) {
      err(issues, 4, `Terminal outcome references state "${outcome.state}", but that state is not flagged terminal: true`, outcome.state)
    }
  }
  for (const state of contract.states) {
    if (state.terminal && !outcomeStates.has(state.id)) {
      err(issues, 4, `State "${state.id}" is flagged terminal but has no TerminalOutcome entry`, state.id)
    }
  }
}

/** Rule 5: every dangling-reference-shaped field elsewhere in the contract resolves to a real
 * state, event, or transition -- SlaSpec (measuredFrom/expectedBy/recurring.whileInState),
 * OwnerAssignment.state, ExpirationRule (state/expiresTo), EvidenceRequirement.transitionId.
 * ExceptionRule is deliberately not part of this rule -- checked directly against its own type,
 * it has no state/event/transition-reference field at all, only free-text condition/owner/
 * suggestedAction (plan doc §4.3's own comment on ExceptionRule explains why: it never moves a
 * promise instance anywhere by itself). */
function checkCrossReferences(
  contract: ProcessContract,
  stateIds: Set<string>,
  eventIds: Set<string>,
  transitionIds: Set<string>,
  issues: ContractValidationIssue[],
): void {
  for (const sla of contract.sla) {
    if ('state' in sla.measuredFrom && !stateIds.has(sla.measuredFrom.state)) {
      err(issues, 5, `SLA "${sla.id}" measuredFrom references unknown state "${sla.measuredFrom.state}"`, sla.id)
    }
    if ('event' in sla.measuredFrom && !eventIds.has(sla.measuredFrom.event)) {
      err(issues, 5, `SLA "${sla.id}" measuredFrom references unknown event "${sla.measuredFrom.event}"`, sla.id)
    }
    if (!stateIds.has(sla.expectedBy.state)) {
      err(issues, 5, `SLA "${sla.id}" expectedBy references unknown state "${sla.expectedBy.state}"`, sla.id)
    }
    if (sla.recurring && !stateIds.has(sla.recurring.whileInState)) {
      err(issues, 9, `SLA "${sla.id}" recurring.whileInState references unknown state "${sla.recurring.whileInState}"`, sla.id)
    }
  }

  for (const owner of contract.owners) {
    if (!stateIds.has(owner.state)) {
      err(issues, 5, `Owner assignment references unknown state "${owner.state}"`, owner.state)
    }
  }

  for (const rule of contract.expirationRules ?? []) {
    if (!stateIds.has(rule.state)) {
      err(issues, 5, `Expiration rule "${rule.id}" references unknown state "${rule.state}"`, rule.id)
    }
    if (!stateIds.has(rule.expiresTo)) {
      err(issues, 5, `Expiration rule "${rule.id}" expiresTo references unknown state "${rule.expiresTo}"`, rule.id)
    }
  }

  for (const req of contract.evidenceRequirements) {
    if (!transitionIds.has(req.transitionId)) {
      err(issues, 5, `Evidence requirement references unknown transition "${req.transitionId}"`, req.transitionId)
    }
  }
}

/** Rule 6: correlationKey.fieldPath is a non-empty, syntactically valid dot-path. Structural
 * check only -- v0 cannot confirm the path actually exists in a real payload until a later
 * (compilation) phase. */
function checkCorrelationKeyPath(contract: ProcessContract, issues: ContractValidationIssue[]): void {
  const path = contract.correlationKey.fieldPath
  if (!path || path.trim().length === 0) {
    err(issues, 6, 'correlationKey.fieldPath must be a non-empty field path')
    return
  }
  const segments = path.split('.')
  const validSegment = /^[A-Za-z_][A-Za-z0-9_]*$/
  if (segments.some(s => !validSegment.test(s))) {
    err(issues, 6, `correlationKey.fieldPath "${path}" is not a valid dot-path (each segment must look like a plain identifier)`)
  }
}

/** Rule 7: at least one terminal outcome has outcome: 'success' -- a contract with no possible
 * success path is almost certainly an authoring mistake, not a real business intent. */
function checkHasSuccessOutcome(contract: ProcessContract, issues: ContractValidationIssue[]): void {
  if (!contract.terminalOutcomes.some(o => o.outcome === 'success')) {
    err(issues, 7, 'No terminal outcome has outcome: "success" -- this contract has no path to a kept promise at all')
  }
}

const BUSINESS_CALENDAR_UNITS = new Set(['business_hours', 'business_days'])

/** Rule 8: businessCalendar is present if and only if some SlaSpec/ExpirationRule actually
 * needs it (uses a business_hours/business_days duration unit) -- found via the Phase 0
 * pressure test (plan doc §4.5b) against a contract that deliberately mixes wall-clock and
 * business-calendar-aware SLAs in one contract. */
function checkBusinessCalendarConsistency(contract: ProcessContract, issues: ContractValidationIssue[]): void {
  const needsCalendar = contract.sla.some(s => BUSINESS_CALENDAR_UNITS.has(s.duration.unit))
    || (contract.expirationRules ?? []).some(r => BUSINESS_CALENDAR_UNITS.has(r.after.unit))

  if (needsCalendar && !contract.businessCalendar) {
    err(issues, 8, 'A SlaSpec or ExpirationRule uses a business_hours/business_days duration unit, but businessCalendar is absent')
  }
  if (!needsCalendar && contract.businessCalendar) {
    err(issues, 8, 'businessCalendar is present, but no SlaSpec or ExpirationRule uses a business-calendar-aware duration unit -- remove it, or use it')
  }
}

export function validateProcessContract(contract: ProcessContract): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = []

  const stateIds = new Set(contract.states.map(s => s.id))
  const eventIds = new Set(contract.events.map(e => e.id))
  const transitionIds = new Set(contract.transitions.map(t => t.id))
  const stateById = new Map(contract.states.map(s => [s.id, s]))

  checkTransitionStateRefs(contract, stateIds, issues)
  checkTransitionEventRefs(contract, eventIds, issues)
  checkStartAndReachability(contract, stateIds, issues)
  checkTerminalConsistency(contract, stateById, issues)
  checkCrossReferences(contract, stateIds, eventIds, transitionIds, issues)
  checkCorrelationKeyPath(contract, issues)
  checkHasSuccessOutcome(contract, issues)
  checkBusinessCalendarConsistency(contract, issues)

  return issues
}
