import type {
  ProcessContract, ProcessState, ProcessTransition, StartCondition, SlaSpec,
  ExpirationRule, TerminalOutcome, EvidenceRequirement, ProcessEvent,
} from './types.js'
import type { ContractDiff, ContractDiffChange } from './diff-types.js'

/**
 * Contract Amendment/Diff (roadmap item 12, docs/plans/contract-evolution-ops-roadmap-plan.md
 * §3, item 12). Pure, deterministic, no I/O -- `diffProcessContracts()` is the only export the
 * rest of this item depends on; everything else here is a private helper.
 *
 * **The breaking-change principle this whole module encodes**: a change is breaking iff it could
 * cause EXISTING ProofLedgerEntry/ExceptionDeskItem records -- recorded under the OLD version --
 * to be misinterpreted against the NEW contract shape, either because an id/string an old record
 * references no longer means the same thing, or because a global computation (elapsed-time via
 * businessCalendar, correlation-key hashing) would now produce a different result for data that
 * was already recorded. This is the exact risk `cli.ts`'s own existing
 * `checkContractVersionConflict()` warning already names in prose ("stateReachSignals() would
 * simply stop matching those ids against the new contract shape") -- this module makes that
 * judgment mechanical and field-by-field instead of an all-or-nothing warning.
 *
 * Field-by-field classification (confirmed against the real ProcessContract shape, types.ts,
 * not assumed):
 * - states[]: id removed, or an existing id's `terminal` flag changed -- BREAKING (changes
 *   whether an entry's recorded initialState/transition-target is interpreted as terminal).
 *   Added id, or name/description edited -- non-breaking.
 * - transitions[]: id removed, or an existing id's fromState/toState/event changed -- BREAKING
 *   (redefines what the id, which old evidence's own transitionId references, actually means).
 *   Added id, or only `condition` edited -- non-breaking.
 * - startConditions[]: id removed, or an existing id's initialState/trigger changed -- BREAKING
 *   (changes what a StartCondition id means for instance_start extraction). description-only
 *   edits -- non-breaking.
 * - terminalOutcomes[]: keyed by `state` (its own natural key, not a separate id field) -- state
 *   removed, or an existing state's `outcome` value changed -- BREAKING (a kept/failure/
 *   acceptable reclassification is about as breaking as this schema can express). description
 *   edits -- non-breaking.
 * - sla[]: id removed, or an existing id's measuredFrom/expectedBy changed -- BREAKING (redefines
 *   which state-reach signals the id compares). `duration`/`recurring` changed on an otherwise-
 *   unchanged id -- explicitly NON-breaking (the plan's own worked example: an SLA duration
 *   number changing is exactly the case Contract Evolution's proposals are meant to drive, and
 *   must not be gated as breaking or that whole feature has no non-breaking path to land on).
 * - expirationRules[]: id removed, or an existing id's state/expiresTo changed -- BREAKING.
 *   `after` duration changed on an otherwise-unchanged id -- non-breaking, same reasoning as sla.
 * - evidenceRequirements[]: keyed by `transitionId` (its own natural key) -- ANY add/remove/
 *   modify -- BREAKING, conservatively. This is directly load-bearing for compiled-workflow
 *   wiring (compiler-verify.ts's whole job is checking marker nodes match these) and for
 *   evidenceQuality scoring in report.ts -- a narrower rule was considered and rejected as not
 *   worth the added complexity for how rarely this array changes in practice.
 * - correlationKey.fieldPath, businessCalendar -- ANY change -- BREAKING. Both are global: the
 *   first is read by extractExecutionEvidence() for every entry, old and new alike; the second
 *   is read live by checkSlaCompliance() on every report/poll run, meaning an old, already-
 *   terminal instance's own SLA verdict could change the instant this field changes, not just
 *   future instances'.
 * - owners[], pauseRules[], exceptions[] -- non-breaking, uniformly. None of these are read
 *   anywhere in evidence extraction or compliance computation by id-reference from a
 *   ProofLedgerEntry/ExceptionDeskItem (confirmed against ledger.ts/sla-compliance.ts/
 *   exception-desk.ts) -- ExceptionDeskItem's own slaId/expirationRuleId/transitionId fields
 *   reference SLA/expiration-rule/transition ids directly, never an ExceptionRule id, so
 *   ExceptionRule changes carry no evidence-reinterpretation risk today.
 * - name, description, entity, promise.text, status, assumptions, provenance -- non-breaking,
 *   uniformly informational/cosmetic.
 */

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function diffScalarField(path: string, from: unknown, to: unknown, breaking: boolean, reason: string): ContractDiffChange[] {
  if (deepEqual(from, to)) return []
  return [{ path, changeType: 'modified', from, to, breaking, reason }]
}

interface KeyedArrayDiffOptions<T> {
  pathPrefix: string
  keyOf: (item: T) => string
  /** Returns a non-empty reason string if the change between two same-key items counts as
   * breaking, or undefined if it's non-breaking (a modification still happened -- just a safe
   * one). Not called for added/removed items, which have their own fixed reason text below. */
  structuralChangeReason: (from: T, to: T) => string | undefined
  addedIsBreaking: boolean
  removedIsBreaking: boolean
  addedReason: string
  removedReason: string
}

function diffKeyedArray<T>(from: T[], to: T[], opts: KeyedArrayDiffOptions<T>): ContractDiffChange[] {
  const changes: ContractDiffChange[] = []
  const fromByKey = new Map(from.map(item => [opts.keyOf(item), item]))
  const toByKey = new Map(to.map(item => [opts.keyOf(item), item]))

  for (const [key, toItem] of toByKey) {
    const fromItem = fromByKey.get(key)
    if (!fromItem) {
      changes.push({ path: `${opts.pathPrefix}[${key}]`, changeType: 'added', to: toItem, breaking: opts.addedIsBreaking, reason: opts.addedReason })
      continue
    }
    if (deepEqual(fromItem, toItem)) continue
    const structuralReason = opts.structuralChangeReason(fromItem, toItem)
    changes.push({
      path: `${opts.pathPrefix}[${key}]`,
      changeType: 'modified',
      from: fromItem,
      to: toItem,
      breaking: structuralReason !== undefined,
      reason: structuralReason ?? 'Only non-structural fields changed (e.g. description, duration amount, condition text) -- does not change how existing recorded evidence for this id is interpreted.',
    })
  }
  for (const [key, fromItem] of fromByKey) {
    if (!toByKey.has(key)) {
      changes.push({ path: `${opts.pathPrefix}[${key}]`, changeType: 'removed', from: fromItem, breaking: opts.removedIsBreaking, reason: opts.removedReason })
    }
  }
  return changes
}

function diffEvents(from: ProcessEvent[], to: ProcessEvent[]): ContractDiffChange[] {
  // event ids are not read anywhere by a ProofLedgerEntry/ExceptionDeskItem directly -- a
  // ProcessTransition carries its own `event` string inline, so a change to that string is
  // already caught (and correctly classified breaking) by diffTransitions() above. This array's
  // own add/remove/name/description changes are non-breaking, but must still appear in the diff
  // -- silently omitting a whole top-level field would make `contract diff` an incomplete diff.
  return diffKeyedArray(from, to, {
    pathPrefix: 'events',
    keyOf: e => e.id,
    structuralChangeReason: () => undefined,
    addedIsBreaking: false,
    removedIsBreaking: false,
    addedReason: 'A new event does not affect how any existing evidence is interpreted.',
    removedReason: 'Event ids are not referenced directly by any ProofLedgerEntry/ExceptionDeskItem -- a transition\'s own event string is what matters, and that is diffed separately.',
  })
}

function diffStates(from: ProcessState[], to: ProcessState[]): ContractDiffChange[] {
  return diffKeyedArray(from, to, {
    pathPrefix: 'states',
    keyOf: s => s.id,
    structuralChangeReason: (a, b) => (a.terminal !== b.terminal ? `terminal flag changed from ${a.terminal} to ${b.terminal} -- changes whether an entry reaching this state is interpreted as an outcome.` : undefined),
    addedIsBreaking: false,
    removedIsBreaking: true,
    addedReason: 'A new state does not affect how any existing evidence is interpreted.',
    removedReason: 'Existing evidence may reference this state id (as an instance_start initialState or a transition target) -- removing it leaves that evidence unanchored.',
  })
}

function diffTransitions(from: ProcessTransition[], to: ProcessTransition[]): ContractDiffChange[] {
  return diffKeyedArray(from, to, {
    pathPrefix: 'transitions',
    keyOf: t => t.id,
    structuralChangeReason: (a, b) => {
      if (a.fromState !== b.fromState || a.toState !== b.toState || a.event !== b.event) {
        return `fromState/toState/event changed ("${a.fromState}"->"${a.toState}" on "${a.event}" became "${b.fromState}"->"${b.toState}" on "${b.event}") -- redefines what this transition id means for any evidence already recorded against it.`
      }
      return undefined
    },
    addedIsBreaking: false,
    removedIsBreaking: true,
    addedReason: 'A new transition does not affect how any existing evidence is interpreted.',
    removedReason: 'Existing evidence entries (kind: "evidence") may cite this transitionId directly -- removing it leaves that evidence unanchored, and any EvidenceRequirement for it becomes uncompilable.',
  })
}

function diffStartConditions(from: StartCondition[], to: StartCondition[]): ContractDiffChange[] {
  return diffKeyedArray(from, to, {
    pathPrefix: 'startConditions',
    keyOf: sc => sc.id,
    structuralChangeReason: (a, b) => {
      if (a.initialState !== b.initialState || a.trigger !== b.trigger) {
        return `initialState/trigger changed ("${a.initialState}"/"${a.trigger}" became "${b.initialState}"/"${b.trigger}") -- changes what this start condition means for instance_start extraction and intake-workflow wiring.`
      }
      return undefined
    },
    addedIsBreaking: false,
    removedIsBreaking: true,
    addedReason: 'A new start condition does not affect how any existing evidence is interpreted.',
    removedReason: 'Existing instance_start entries may have been extracted under this start condition id -- removing it changes what future extraction expects, and orphans the old meaning.',
  })
}

function diffTerminalOutcomes(from: TerminalOutcome[], to: TerminalOutcome[]): ContractDiffChange[] {
  return diffKeyedArray(from, to, {
    pathPrefix: 'terminalOutcomes',
    keyOf: t => t.state,
    structuralChangeReason: (a, b) => (a.outcome !== b.outcome ? `outcome changed from "${a.outcome}" to "${b.outcome}" -- a kept/failure/acceptable reclassification for any instance that already reached this state.` : undefined),
    addedIsBreaking: false,
    removedIsBreaking: true,
    addedReason: 'A new terminal outcome does not affect how any existing evidence is interpreted.',
    removedReason: 'An instance that already reached this state was classified using this outcome -- removing it leaves that classification without a defined meaning going forward.',
  })
}

function diffSla(from: SlaSpec[], to: SlaSpec[]): ContractDiffChange[] {
  return diffKeyedArray(from, to, {
    pathPrefix: 'sla',
    keyOf: s => s.id,
    structuralChangeReason: (a, b) => {
      if (!deepEqual(a.measuredFrom, b.measuredFrom) || !deepEqual(a.expectedBy, b.expectedBy)) {
        return `measuredFrom/expectedBy changed -- redefines which state-reach signals this SLA id compares, not just its deadline.`
      }
      return undefined
    },
    addedIsBreaking: false,
    removedIsBreaking: true,
    addedReason: 'A new SLA does not affect how any existing evidence is interpreted.',
    removedReason: 'Existing compliance findings/exceptions may cite this SLA id directly (ExceptionDeskItem.slaId) -- removing it leaves those references without a defined meaning.',
  })
}

function diffExpirationRules(from: ExpirationRule[], to: ExpirationRule[]): ContractDiffChange[] {
  return diffKeyedArray(from, to, {
    pathPrefix: 'expirationRules',
    keyOf: e => e.id,
    structuralChangeReason: (a, b) => (a.state !== b.state || a.expiresTo !== b.expiresTo ? `state/expiresTo changed -- redefines which state this rule watches and what it expires to.` : undefined),
    addedIsBreaking: false,
    removedIsBreaking: true,
    addedReason: 'A new expiration rule does not affect how any existing evidence is interpreted.',
    removedReason: 'Existing exceptions may cite this expiration rule id directly (ExceptionDeskItem.expirationRuleId) -- removing it leaves those references without a defined meaning.',
  })
}

function diffEvidenceRequirements(from: EvidenceRequirement[], to: EvidenceRequirement[]): ContractDiffChange[] {
  // Keyed by transitionId (its own natural key -- EvidenceRequirement has no separate id field).
  // Any add/remove/modify is conservatively breaking -- directly load-bearing for compiled-
  // workflow marker-node wiring (compiler-verify.ts) and evidenceQuality scoring (report.ts).
  return diffKeyedArray(from, to, {
    pathPrefix: 'evidenceRequirements',
    keyOf: e => e.transitionId,
    structuralChangeReason: () => 'Any change to an EvidenceRequirement is treated as breaking -- it directly determines what a compiled workflow\'s marker node must produce and how evidenceQuality is scored, conservatively, regardless of which specific sub-field changed.',
    addedIsBreaking: true,
    removedIsBreaking: true,
    addedReason: 'A new EvidenceRequirement means the compiled workflow for this transition must now produce a marker node that did not exist before -- existing deployed workflows will not satisfy it until recompiled.',
    removedReason: 'Existing evidence entries may have been extracted for this transitionId under the old requirement -- removing it changes what future extraction expects for the same transition.',
  })
}

export function diffProcessContracts(from: ProcessContract, to: ProcessContract): ContractDiff {
  const changes: ContractDiffChange[] = [
    ...diffScalarField('name', from.name, to.name, false, 'Cosmetic -- does not affect evidence interpretation.'),
    ...diffScalarField('description', from.description, to.description, false, 'Cosmetic -- does not affect evidence interpretation.'),
    ...diffScalarField('entity', from.entity, to.entity, false, 'Cosmetic -- does not affect evidence interpretation.'),
    ...diffScalarField(
      'correlationKey.fieldPath', from.correlationKey.fieldPath, to.correlationKey.fieldPath, true,
      'The correlation key field path is read by extractExecutionEvidence() for every entry, old and new alike, and determines how a real payload maps to a promiseInstanceId hash -- changing it is global, not scoped to new instances only.'
    ),
    ...diffScalarField('correlationKey.description', from.correlationKey.description, to.correlationKey.description, false, 'Cosmetic -- does not affect evidence interpretation.'),
    ...diffScalarField('promise.text', from.promise.text, to.promise.text, false, 'Cosmetic -- does not affect evidence interpretation.'),
    ...diffStartConditions(from.startConditions, to.startConditions),
    ...diffStates(from.states, to.states),
    ...diffEvents(from.events, to.events),
    ...diffTransitions(from.transitions, to.transitions),
    ...diffTerminalOutcomes(from.terminalOutcomes, to.terminalOutcomes),
    ...diffKeyedArray(from.owners, to.owners, {
      pathPrefix: 'owners', keyOf: o => o.state, structuralChangeReason: () => undefined,
      addedIsBreaking: false, removedIsBreaking: false,
      addedReason: 'Owner assignment is informational/routing only.', removedReason: 'Owner assignment is informational/routing only.',
    }),
    ...diffSla(from.sla, to.sla),
    ...diffScalarField(
      'businessCalendar', from.businessCalendar, to.businessCalendar, true,
      'checkSlaCompliance() reads businessCalendar live on every report/poll run -- changing it can change the computed SLA verdict for an already-terminal instance, not just future ones.'
    ),
    ...diffKeyedArray(from.pauseRules ?? [], to.pauseRules ?? [], {
      pathPrefix: 'pauseRules', keyOf: p => p.id, structuralChangeReason: () => undefined,
      addedIsBreaking: false, removedIsBreaking: false,
      addedReason: 'Pause rules are not referenced by id from any ProofLedgerEntry/ExceptionDeskItem.', removedReason: 'Pause rules are not referenced by id from any ProofLedgerEntry/ExceptionDeskItem.',
    }),
    ...diffExpirationRules(from.expirationRules ?? [], to.expirationRules ?? []),
    ...diffKeyedArray(from.exceptions, to.exceptions, {
      pathPrefix: 'exceptions', keyOf: e => e.id, structuralChangeReason: () => undefined,
      addedIsBreaking: false, removedIsBreaking: false,
      addedReason: 'ExceptionRule ids are never referenced directly by a ProofLedgerEntry/ExceptionDeskItem (ExceptionDeskItem cites slaId/expirationRuleId/transitionId instead).',
      removedReason: 'ExceptionRule ids are never referenced directly by a ProofLedgerEntry/ExceptionDeskItem (ExceptionDeskItem cites slaId/expirationRuleId/transitionId instead).',
    }),
    ...diffEvidenceRequirements(from.evidenceRequirements, to.evidenceRequirements),
    ...diffScalarField('assumptions', from.assumptions, to.assumptions, false, 'Cosmetic/authoring metadata -- does not affect evidence interpretation.'),
    ...diffScalarField('status', from.status, to.status, false, 'Cosmetic/lifecycle metadata -- does not affect evidence interpretation.'),
  ]

  return {
    contractId: to.id,
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    hasBreakingChanges: changes.some(c => c.breaking),
  }
}
