import type {
  ProcessContract,
  ProcessTransition,
  EvidenceRequirement,
  TerminalOutcome,
  StartCondition,
  SlaSpec,
} from './types.js'
import type {
  ContractScenario,
  ScenarioCategory,
  ScenarioTimelineEvent,
  ScenarioGenerationResult,
  ScenarioGenerationSkip,
} from './scenario-types.js'

/**
 * Contract Scenario Generator (roadmap item 5, docs/plans/intake-scenario-harness-plan.md §5).
 *
 * Deterministic, template-driven, no LLM call -- for the identical reason compile.ts has none: a
 * second LLM pass between an already-validated contract and its own test scenarios would
 * reintroduce "a new, higher-stakes place to be wrong" one layer downstream, for no real benefit
 * -- every fact this module needs is already structured data sitting on the contract.
 *
 * The single most important, load-bearing design constraint here, found by reading
 * sla-compliance.ts/ledger.ts directly rather than assumed: a generated scenario NEVER
 * fabricates an 'evidence' timeline event for a transition the contract has no
 * EvidenceRequirement for. Real ledger.ts extraction can only ever produce a ledger entry for a
 * transition that has a matching EvidenceRequirement (compile.ts's evidenceNodeName() marker
 * convention only exists for those) -- a scenario that invented evidence for an un-evidenced
 * transition would be testing a shape of data that could never occur in real operation. A direct
 * consequence, confirmed against both checked-in fixtures while designing this module: neither
 * `tests/fixtures/contracts/empire-homecare-referral-intake.json` nor
 * `saas-p1-incident-response.json` has an EvidenceRequirement covering the transition into its
 * own success (or, for Empire, any) terminal outcome -- meaning `happy_path`/`failure_terminal`
 * scenarios are genuinely NOT generatable for either fixture as currently authored. This is
 * surfaced as an explicit, reasoned `ScenarioGenerationSkip`, not silently omitted or faked --
 * it is itself a real finding about those fixtures' own evidence-completeness, exactly the class
 * of gap this whole arc exists to catch.
 */

const GENERATOR_VERSION = '0.1.0'

function syntheticCorrelationValue(contract: ProcessContract, category: ScenarioCategory): string {
  return `scenario-${category}@${contract.id}.kairos-scenario.test`
}

function syntheticFieldValue(fieldName: string): string {
  return `synthetic-${fieldName}`
}

function firstStartCondition(contract: ProcessContract): StartCondition | null {
  return contract.startConditions[0] ?? null
}

/** A transition that both leads to `stateId` AND has a matching EvidenceRequirement -- the only
 * shape of transition real ledger.ts extraction could ever produce an 'evidence' entry for that
 * confirms reaching `stateId`. Returns null when no such transition exists, which is itself the
 * finding for several categories below. */
function evidenceBackedTransitionInto(contract: ProcessContract, stateId: string): { transition: ProcessTransition; evidenceRequirement: EvidenceRequirement } | null {
  for (const t of contract.transitions) {
    if (t.toState !== stateId) continue
    const ev = contract.evidenceRequirements.find(e => e.transitionId === t.id)
    if (ev) return { transition: t, evidenceRequirement: ev }
  }
  return null
}

function evidenceFieldsFor(ev: EvidenceRequirement, opts: { omitOne?: boolean } = {}): Record<string, string> {
  const fields: Record<string, string> = {}
  ev.requiredFields.forEach((f, i) => {
    if (opts.omitOne && i === 0) return // deliberately missing -- see 'missing_data' category
    fields[f] = syntheticFieldValue(f)
  })
  return fields
}

function instanceStartEvent(id: string, offsetDays: number, initialState: string): ScenarioTimelineEvent {
  return { id, offset: { amount: offsetDays, unit: 'days' }, kind: 'instance_start', initialState }
}

function evidenceEvent(
  id: string,
  offsetMinutes: number,
  ev: EvidenceRequirement,
  opts: { status?: 'observed' | 'unverifiable'; omitOne?: boolean } = {},
): ScenarioTimelineEvent {
  return {
    id,
    offset: { amount: offsetMinutes, unit: 'minutes' },
    kind: 'evidence',
    transitionId: ev.transitionId,
    fields: evidenceFieldsFor(ev, { omitOne: opts.omitOne ?? false }),
    ...(opts.status ? { evidenceStatus: opts.status } : {}),
  }
}

// Generous, real-clock-relative offsets -- same timing-robustness principle this session's own
// hand-built synthetic validation already proved catches real classification bugs without being
// fragile to exactly when the harness happens to run. "Recent" (minutes ago) is safely within
// any realistic SLA duration this codebase's fixtures use (shortest known: 15 minutes); "long
// ago" (60 days) is safely past any realistic SLA/expiration duration even in business-time
// terms, regardless of weekends/holidays.
// Every offset below is a POSITIVE "this many units before now" value -- the harness (Phase 6)
// converts each to an absolute timestamp as `now - offset`, so a SMALLER offset always means
// closer to (more recent than) a larger one. instance_start at ~12 minutes before now, evidence
// at ~5 minutes before now, is therefore evidence arriving ~7 minutes AFTER start -- comfortably
// within any realistic SLA duration this codebase's fixtures use (shortest known: 15 minutes).
const RECENT_START_OFFSET_DAYS = 0.008 // ~12 minutes, expressed in days for instance_start's own offset unit
const RECENT_EVIDENCE_OFFSET_MINUTES = 5 // ~5 minutes before now -- after the ~12-minutes-before-now start
// 60 calendar days was the first value tried here -- correct, but a real performance finding
// surfaced while writing this module's own tests: businessMinutesBetween() (business-calendar.ts)
// walks minute-by-minute and constructs a fresh Intl.DateTimeFormat PER MINUTE (not cached), so a
// 60-day span means an 86,400-iteration walk for every SLA/expiration check this scenario
// triggers -- measured at several real seconds across this module's own test suite. The longest
// initial-state-measured SLA across all three checked-in fixtures is Empire Homecare's 4
// business_hours, which resolves within at most a few real calendar days even from a Friday
// afternoon start; 7 calendar days is still a wide, safe margin (nearly double worst case) while
// cutting the minute-walk to ~10,080 iterations, fast enough for the default `npm test` suite.
const LONG_PAST_OFFSET_DAYS = 7

function successOrAcceptableTerminals(contract: ProcessContract): TerminalOutcome[] {
  return contract.terminalOutcomes.filter(o => o.outcome === 'success' || o.outcome === 'acceptable')
}

function failureTerminals(contract: ProcessContract): TerminalOutcome[] {
  return contract.terminalOutcomes.filter(o => o.outcome === 'failure')
}

function generateHappyPath(contract: ProcessContract): ContractScenario | ScenarioGenerationSkip {
  const sc = firstStartCondition(contract)
  if (!sc) return { category: 'happy_path', reason: 'Contract has no startConditions at all.' }

  for (const outcome of successOrAcceptableTerminals(contract)) {
    const backed = evidenceBackedTransitionInto(contract, outcome.state)
    if (!backed) continue
    return {
      id: `${contract.id}-happy-path`,
      contractId: contract.id,
      contractVersion: contract.version,
      name: 'Happy path',
      category: 'happy_path',
      description: `A new ${contract.entity.name} reaches terminal state "${outcome.state}" (${outcome.outcome}) with complete, timely evidence.`,
      correlationKeyValue: syntheticCorrelationValue(contract, 'happy_path'),
      timeline: [
        instanceStartEvent('start', RECENT_START_OFFSET_DAYS, sc.initialState),
        evidenceEvent('evidence-1', RECENT_EVIDENCE_OFFSET_MINUTES, backed.evidenceRequirement, { status: 'observed' }),
      ],
      expected: {
        reportStatus: 'kept',
        evidenceQuality: 'specific',
        expectedExceptionCount: 0,
        reasoning: `classifyPromiseInstance()'s terminal-outcome loop finds a 'specific' signal for "${outcome.state}" (a direct evidence entry whose transition's toState matches it) with no drifting findings and no pause rules -- returns 'kept' (report.ts, the toState-match branch). No exception opens because checkSlaCompliance() sees the SLA satisfied well within its window.`,
      },
      sourceElements: [`startCondition:${sc.id}`, `terminalOutcome:${outcome.state}`, `transition:${backed.transition.id}`, `evidenceRequirement:${backed.transition.id}`],
      provenance: { generatorVersion: GENERATOR_VERSION, createdAt: new Date().toISOString() },
    }
  }

  return {
    category: 'happy_path',
    reason: `No terminalOutcome with outcome 'success' or 'acceptable' is reachable via a transition that has a matching EvidenceRequirement. Real ledger.ts extraction could never confirm this contract's happy path was reached -- this is a real gap in the contract's own evidence-completeness, not a limitation of the generator.`,
  }
}

function generateFailureTerminal(contract: ProcessContract): ContractScenario | ScenarioGenerationSkip {
  const sc = firstStartCondition(contract)
  if (!sc) return { category: 'failure_terminal', reason: 'Contract has no startConditions at all.' }

  for (const outcome of failureTerminals(contract)) {
    const backed = evidenceBackedTransitionInto(contract, outcome.state)
    if (!backed) continue
    return {
      id: `${contract.id}-failure-terminal`,
      contractId: contract.id,
      contractVersion: contract.version,
      name: 'Failure terminal path',
      category: 'failure_terminal',
      description: `A new ${contract.entity.name} reaches failure terminal state "${outcome.state}" via direct evidence.`,
      correlationKeyValue: syntheticCorrelationValue(contract, 'failure_terminal'),
      timeline: [
        instanceStartEvent('start', RECENT_START_OFFSET_DAYS, sc.initialState),
        evidenceEvent('evidence-1', RECENT_EVIDENCE_OFFSET_MINUTES, backed.evidenceRequirement, { status: 'observed' }),
      ],
      expected: {
        reportStatus: 'missed',
        evidenceQuality: 'specific',
        expectedExceptionCount: 0,
        reasoning: `classifyPromiseInstance()'s terminal-outcome loop returns 'missed' immediately once it finds a signal for a terminal state whose outcome.outcome === 'failure' (report.ts) -- unconditional on any SLA finding. No exception opens: checkSlaCompliance() only opens exceptions for a 'drifting' SLA/expiration finding, and reaching this terminal quickly, well within any SLA window, produces a 'healthy' finding, not 'drifting'.`,
      },
      sourceElements: [`startCondition:${sc.id}`, `terminalOutcome:${outcome.state}`, `transition:${backed.transition.id}`, `evidenceRequirement:${backed.transition.id}`],
      provenance: { generatorVersion: GENERATOR_VERSION, createdAt: new Date().toISOString() },
    }
  }

  return {
    category: 'failure_terminal',
    reason: `No terminalOutcome with outcome 'failure' is reachable via a transition that has a matching EvidenceRequirement -- real ledger.ts extraction could never confirm this contract's failure path was reached via direct evidence. (A failure terminal reached only through an ExpirationRule, like Empire Homecare's "no_answer", is exercised by the 'no_response' category instead -- expiration never writes a ledger entry.)`,
  }
}

/** SLA entries measured directly from the start condition's own initial state -- the only SLAs
 * guaranteed to have a 'specific' clock-start signal (the automatic instance_start entry) with
 * zero further evidence. An event-measured SLA never fires here (no evidence ever posts the
 * event) and stays 'insufficient_data', not 'drifting' -- deliberately excluded from this count. */
function slasMeasuredFromInitialState(contract: ProcessContract, initialState: string): SlaSpec[] {
  return contract.sla.filter(s => 'state' in s.measuredFrom && s.measuredFrom.state === initialState)
}

/** ExpirationRules whose OWN state IS the start condition's initial state -- an unusual but real
 * shape (found while live-verifying this generator against the website-contact-form-ack
 * fixture, whose exp-received-stuck rule targets "received" itself, unlike Empire Homecare's
 * equivalent rule which targets a LATER state). checkExpirationRuleForInstance()'s own
 * enterSignals check is satisfied by the same instance_start entry that satisfies an SLA's
 * clock-start -- so a rule targeting the initial state drifts right alongside any SLA measured
 * from it, not only after a later state is (never) reached. Excluded when the rule targets any
 * other state, since instance_start alone gives it no enterSignals at all (stays
 * 'insufficient_data', matching Empire Homecare's own real behavior, confirmed live below). */
function expirationRulesOnInitialState(contract: ProcessContract, initialState: string) {
  return (contract.expirationRules ?? []).filter(r => r.state === initialState)
}

function generateNoResponse(contract: ProcessContract): ContractScenario | ScenarioGenerationSkip {
  const sc = firstStartCondition(contract)
  if (!sc) return { category: 'no_response', reason: 'Contract has no startConditions at all.' }

  const applicableSlas = slasMeasuredFromInitialState(contract, sc.initialState)
  const applicableExpirationRules = expirationRulesOnInitialState(contract, sc.initialState)
  if (applicableSlas.length === 0 && applicableExpirationRules.length === 0) {
    return {
      category: 'no_response',
      reason: `No SlaSpec or ExpirationRule is measured/targeted directly from this contract's own initial state ("${sc.initialState}") -- there is nothing that would confidently drift from a bare instance_start with zero further evidence.`,
    }
  }

  const expectedExceptionCount = applicableSlas.length + applicableExpirationRules.length

  return {
    id: `${contract.id}-no-response`,
    contractId: contract.id,
    contractVersion: contract.version,
    name: 'No response / SLA miss',
    category: 'no_response',
    description: `A new ${contract.entity.name} starts and receives zero further evidence, well past every SLA/expiration rule measured or targeted from its own initial state.`,
    correlationKeyValue: syntheticCorrelationValue(contract, 'no_response'),
    timeline: [instanceStartEvent('start', LONG_PAST_OFFSET_DAYS, sc.initialState)],
    expected: {
      reportStatus: 'missed',
      evidenceQuality: 'specific',
      expectedExceptionCount,
      expectedExceptionKinds: [
        ...applicableSlas.map((): 'missed_sla' => 'missed_sla'),
        ...applicableExpirationRules.map((): 'stuck' => 'stuck'),
      ],
      reasoning: `checkSlaForInstance() falls to its "deadline passed, zero evidence the expected state was ever reached" branch (sla-compliance.ts) for each of ${applicableSlas.length} SLA(s) measured from "${sc.initialState}", and checkExpirationRuleForInstance() drifts for each of ${applicableExpirationRules.length} ExpirationRule(s) targeting "${sc.initialState}" directly (its enterSignals is satisfied by the same instance_start entry) -- both unconditionally 'drifting' once the deadline has passed with zero evidence. updateExceptionDesk() opens one 'missed_sla' item per drifting SLA finding and one 'stuck' item per drifting expiration finding. classifyPromiseInstance() reaches no terminal state at all (zero evidence past intake) and falls to its own "if (drifting.length > 0) return missed" branch.`,
    },
    sourceElements: [`startCondition:${sc.id}`, ...applicableSlas.map(s => `sla:${s.id}`), ...applicableExpirationRules.map(r => `expirationRule:${r.id}`)],
    provenance: { generatorVersion: GENERATOR_VERSION, createdAt: new Date().toISOString() },
  }
}

function generateDuplicateCorrelation(contract: ProcessContract): ContractScenario | ScenarioGenerationSkip {
  const sc = firstStartCondition(contract)
  if (!sc) return { category: 'duplicate_correlation', reason: 'Contract has no startConditions at all.' }

  return {
    id: `${contract.id}-duplicate-correlation`,
    contractId: contract.id,
    contractVersion: contract.version,
    name: 'Duplicate / correlation ambiguity',
    category: 'duplicate_correlation',
    description: `The same correlation key value produces two separate "instance started" records -- e.g. the same phone number or email used for a new occurrence after a prior one, or simply submitted twice.`,
    correlationKeyValue: syntheticCorrelationValue(contract, 'duplicate_correlation'),
    timeline: [
      // Both offsets kept recent and close together, deliberately -- this scenario is isolated
      // to testing the ambiguity check alone. If either instance_start were old enough to also
      // drift an SLA, the resulting exception count would depend on that timing too, muddying
      // what this specific scenario is meant to prove (same discipline this session's earlier
      // hand-built synthetic validation used for its own equivalent case).
      instanceStartEvent('start-1', 0.003, sc.initialState), // ~4 minutes ago
      instanceStartEvent('start-2', 0.001, sc.initialState), // ~1 minute ago
    ],
    expected: {
      reportStatus: 'unverifiable',
      expectedExceptionCount: 0,
      reasoning: `classifyPromiseInstance() checks instanceStartCount > 1 first, unconditionally, before any other logic (report.ts, Finding 3's ambiguity stopgap) -- returns 'unverifiable' regardless of what any SLA/expiration finding would otherwise say. No exception opens because both instance_start timestamps are recent enough that the underlying SLA finding is independently 'insufficient_data', not 'drifting' -- keeping this scenario isolated to testing only the ambiguity check itself, not a timing interaction with it.`,
    },
    sourceElements: [`startCondition:${sc.id}`, 'correlationKey'],
    provenance: { generatorVersion: GENERATOR_VERSION, createdAt: new Date().toISOString() },
  }
}

function generateInProgress(contract: ProcessContract): ContractScenario | ScenarioGenerationSkip {
  const sc = firstStartCondition(contract)
  if (!sc) return { category: 'in_progress', reason: 'Contract has no startConditions at all.' }

  return {
    id: `${contract.id}-in-progress`,
    contractId: contract.id,
    contractVersion: contract.version,
    name: 'In progress',
    category: 'in_progress',
    description: `A new ${contract.entity.name} has just started -- no terminal outcome, no drift, nothing wrong yet.`,
    correlationKeyValue: syntheticCorrelationValue(contract, 'in_progress'),
    timeline: [instanceStartEvent('start', RECENT_START_OFFSET_DAYS, sc.initialState)],
    expected: {
      reportStatus: 'in_progress',
      expectedExceptionCount: 0,
      reasoning: `Every SLA/expiration finding measured from "${sc.initialState}" is still within its own window this soon after instance_start -- checkSlaForInstance()/checkExpirationRuleForInstance() both return 'insufficient_data', never 'drifting', so no exception opens. No terminal state has any evidence yet. classifyPromiseInstance() falls through every branch to its final "no issues found so far" default: 'in_progress' (report.ts).`,
    },
    sourceElements: [`startCondition:${sc.id}`],
    provenance: { generatorVersion: GENERATOR_VERSION, createdAt: new Date().toISOString() },
  }
}

function generateMissingData(contract: ProcessContract): ContractScenario | ScenarioGenerationSkip {
  const sc = firstStartCondition(contract)
  if (!sc) return { category: 'missing_data', reason: 'Contract has no startConditions at all.' }
  if (contract.evidenceRequirements.length === 0) {
    return { category: 'missing_data', reason: 'Contract declares no EvidenceRequirements at all -- there is no marker node convention to model an incomplete entry for.' }
  }

  // Prefer an EvidenceRequirement whose transition leads to a success/acceptable terminal
  // outcome, when one exists -- makes the finding this scenario is built to surface as stark as
  // possible (a confidently WRONG "kept", not just a quieter internal SLA miscalculation). Falls
  // back to the first available EvidenceRequirement otherwise (e.g. Empire Homecare, which has
  // none reaching any terminal state at all -- see generateHappyPath's own doc comment).
  const successStates = new Set(successOrAcceptableTerminals(contract).map(o => o.state))
  const preferred = contract.evidenceRequirements.find(ev => {
    const t = contract.transitions.find(x => x.id === ev.transitionId)
    return t && successStates.has(t.toState)
  })
  const ev = preferred ?? contract.evidenceRequirements[0]!
  const transition = contract.transitions.find(t => t.id === ev.transitionId)
  const targetsSuccessTerminal = preferred !== undefined

  return {
    id: `${contract.id}-missing-data`,
    contractId: contract.id,
    contractVersion: contract.version,
    name: 'Missing required evidence field',
    category: 'missing_data',
    description: `An evidence marker node for transition "${ev.transitionId}" is found in the real execution, but one of its required fields (${ev.requiredFields[0]}) is genuinely missing -- ledger.ts records this as an entry with status: 'unverifiable', not as a complete 'observed' entry, and not as no entry at all.`,
    correlationKeyValue: syntheticCorrelationValue(contract, 'missing_data'),
    timeline: [
      instanceStartEvent('start', RECENT_START_OFFSET_DAYS, sc.initialState),
      evidenceEvent('evidence-1', RECENT_EVIDENCE_OFFSET_MINUTES, ev, { status: 'unverifiable', omitOne: true }),
    ],
    expected: {
      // P0-2 measurement-integrity fix (2026-07-21): stateReachSignals()/classifyPromiseInstance()
      // (and checkSlaForInstance()/checkRecurringSlaForInstance()/checkExpirationRuleForInstance())
      // now explicitly check ProofLedgerEntry.status -- an entry marked 'unverifiable' (a required
      // field genuinely missing) no longer counts as confirmed reach anywhere. This scenario is
      // exactly what first caught the PRE-fix gap live (an unverifiable entry producing a
      // confident 'kept'/'healthy'); its expected outcome now reflects the CORRECTED behavior --
      // see docs/plans/intake-scenario-harness-plan.md §6's Shipped note for the full history.
      reportStatus: 'unverifiable',
      expectedExceptionCount: 0,
      reasoning: targetsSuccessTerminal
        ? `The evidence entry's transition leads directly to a success/acceptable terminal outcome, but its only signal is marked evidenceStatus: 'unverifiable' (a required field missing) -- classifyPromiseInstance()'s terminal-outcome loop now checks signals[0].verifiable explicitly and returns 'unverifiable' rather than 'kept' when no verifiable signal exists for that state.`
        : `The evidence entry's transition ("${transition?.id}") does not lead to any terminal outcome in this contract, but its only signal is marked evidenceStatus: 'unverifiable' -- checkSlaForInstance() now returns its own 'unverifiable' PromiseComplianceStatus rather than confidently computing elapsed time from an unconfirmed timestamp, and classifyPromiseInstance()'s outer fallback (unverifiableFindings.length > 0) surfaces that as the instance's own classification.`,
    },
    sourceElements: [`startCondition:${sc.id}`, `evidenceRequirement:${ev.transitionId}`],
    provenance: { generatorVersion: GENERATOR_VERSION, createdAt: new Date().toISOString() },
  }
}

/** Finds a closed instant (outside `calendar.weeklyHours`) AND the very next moment business
 * hours resume after it -- paired, not independent, because the whole point of this scenario is
 * "started while closed, handled shortly after reopening," and computing the reopen moment
 * independently of the closed instant (e.g. relative to real "now" instead) risks accidentally
 * spanning several real business days in between, which is exactly a bug this generator's own
 * live verification against a real fixture caught (2026-07-21): using a flat "5 minutes before
 * now" for the reopen evidence event let 13+ business hours land in between whenever "now"
 * happened to be several real days after the chosen closed day.
 *
 * Picks a day-of-week not covered by `weeklyHours` at noon UTC as the closed instant (a plain,
 * safely-outside-hours instant -- this only needs to land outside the declared open windows, not
 * model a specific timezone precisely), then walks forward day by day to the next day that IS in
 * `weeklyHours`, reopening at that day's own declared `start` time. Falls back to "2 hours before
 * today's earliest start" / "today's earliest start" for the unusual case where a contract
 * declares hours on all seven days (no closed day exists to pick). */
function findAfterHoursWindow(calendar: NonNullable<ProcessContract['businessCalendar']>, now: Date): { closedInstant: Date; nextOpenInstant: Date } {
  const openDays = new Set(calendar.weeklyHours.map(w => w.day))
  const dayOrder: Array<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'> = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const closedDay = dayOrder.find(d => !openDays.has(d))

  if (closedDay) {
    const targetIndex = dayOrder.indexOf(closedDay)
    const closedInstant = new Date(now)
    for (let back = 1; back <= 7; back++) {
      closedInstant.setUTCDate(now.getUTCDate() - back)
      if (closedInstant.getUTCDay() === targetIndex) {
        closedInstant.setUTCHours(12, 0, 0, 0)
        break
      }
    }

    const nextOpenInstant = new Date(closedInstant)
    for (let forward = 1; forward <= 7; forward++) {
      nextOpenInstant.setTime(closedInstant.getTime())
      nextOpenInstant.setUTCDate(closedInstant.getUTCDate() + forward)
      const dayHours = calendar.weeklyHours.find(w => w.day === dayOrder[nextOpenInstant.getUTCDay()])
      if (dayHours) {
        const [h, m] = dayHours.start.split(':').map(Number)
        nextOpenInstant.setUTCHours(h ?? 9, (m ?? 0) + 15, 0, 0) // 15 minutes into the open window
        // A sparse calendar (few open days per week) combined with an unlucky "now" can walk
        // `forward` past today before finding an open day, landing nextOpenInstant in the
        // future relative to `now` -- every offset this generator produces must be a positive
        // "before now" value (see the offset-semantics comment above RECENT_START_OFFSET_DAYS),
        // so step back whole weeks (the weekly pattern repeats exactly) until it safely isn't.
        while (nextOpenInstant.getTime() > now.getTime()) {
          nextOpenInstant.setUTCDate(nextOpenInstant.getUTCDate() - 7)
        }
        return { closedInstant, nextOpenInstant }
      }
    }
    // Unreachable in practice (a valid contract's businessCalendar always has at least one open
    // day, enforced by the deterministic validator) -- fall through to the all-seven-days path
    // below only if it somehow is.
  }

  // All seven days declared open (or the loop above genuinely found nothing) -- the closed
  // instant is just before today's earliest start, reopening later the same day.
  const earliestStart = calendar.weeklyHours.map(w => w.start).sort()[0] ?? '09:00'
  const [h, m] = earliestStart.split(':').map(Number)
  const closedInstant = new Date(now)
  closedInstant.setUTCHours((h ?? 9) - 2, m ?? 0, 0, 0)
  const nextOpenInstant = new Date(now)
  nextOpenInstant.setUTCHours(h ?? 9, (m ?? 0) + 15, 0, 0)
  return { closedInstant, nextOpenInstant }
}

function generateAfterHours(contract: ProcessContract, now: Date = new Date()): ContractScenario | ScenarioGenerationSkip {
  if (!contract.businessCalendar) {
    return { category: 'after_hours', reason: 'Contract declares no businessCalendar -- every SLA/expiration duration is plain wall-clock time, so there is no "after hours" concept to test.' }
  }
  const sc = firstStartCondition(contract)
  if (!sc) return { category: 'after_hours', reason: 'Contract has no startConditions at all.' }

  for (const outcome of successOrAcceptableTerminals(contract)) {
    const backed = evidenceBackedTransitionInto(contract, outcome.state)
    if (!backed) continue

    const { closedInstant, nextOpenInstant } = findAfterHoursWindow(contract.businessCalendar, now)
    const msPerDay = 24 * 60 * 60 * 1000
    const startOffsetDays = (now.getTime() - closedInstant.getTime()) / msPerDay
    const evidenceOffsetMinutes = (now.getTime() - nextOpenInstant.getTime()) / 60_000

    return {
      id: `${contract.id}-after-hours`,
      contractId: contract.id,
      contractVersion: contract.version,
      name: 'After-hours submission',
      category: 'after_hours',
      description: `A new ${contract.entity.name} arrives outside this contract's declared business hours, then is handled promptly (15 minutes in) once business hours resume -- almost no BUSINESS time should have elapsed even though real wall-clock time did.`,
      correlationKeyValue: syntheticCorrelationValue(contract, 'after_hours'),
      timeline: [
        instanceStartEvent('start', startOffsetDays, sc.initialState),
        evidenceEvent('evidence-1', evidenceOffsetMinutes, backed.evidenceRequirement, { status: 'observed' }),
      ],
      expected: {
        reportStatus: 'kept',
        evidenceQuality: 'specific',
        expectedExceptionCount: 0,
        reasoning: `The instance starts outside declared weeklyHours; elapsedInDurationUnits() (business-calendar.ts) computes elapsed time using ONLY open business minutes for any business_hours/business_days-unit SLA, so the closed-hours span before evidence arrives does not count against the deadline. Reaches "${outcome.state}" via specific evidence -- classifyPromiseInstance() returns 'kept', the same as the happy_path scenario, proving business-calendar-aware timing specifically (not just that a recent, wall-clock-tiny gap looks fine).`,
      },
      sourceElements: [`startCondition:${sc.id}`, `terminalOutcome:${outcome.state}`, `transition:${backed.transition.id}`, 'businessCalendar'],
      provenance: { generatorVersion: GENERATOR_VERSION, createdAt: new Date().toISOString() },
    }
  }

  return {
    category: 'after_hours',
    reason: `Contract has a businessCalendar, but (same constraint as 'happy_path') no terminalOutcome with outcome 'success' or 'acceptable' is reachable via an EvidenceRequirement-backed transition -- there is no way to demonstrate a confident 'kept' classification to contrast against business-hours timing.`,
  }
}

// `now` is optional and only actually read by generateAfterHours() (the one category whose
// output depends on real day-of-week arithmetic) -- every other generator's own timeline
// offsets are relative numbers, converted to absolute timestamps later by the harness's own
// `now`, so they don't need it. A function declaring fewer parameters than a type calls for is
// structurally assignable to it in TypeScript (extra call-site arguments are simply ignored),
// so the other six generators are left with their original single-parameter signatures rather
// than each carrying an unused `now` parameter.
const CATEGORY_GENERATORS: Record<ScenarioCategory, (contract: ProcessContract, now?: Date) => ContractScenario | ScenarioGenerationSkip> = {
  happy_path: generateHappyPath,
  missing_data: generateMissingData,
  failure_terminal: generateFailureTerminal,
  no_response: generateNoResponse,
  duplicate_correlation: generateDuplicateCorrelation,
  after_hours: generateAfterHours,
  in_progress: generateInProgress,
}

export const ALL_SCENARIO_CATEGORIES: ScenarioCategory[] = [
  'happy_path',
  'missing_data',
  'failure_terminal',
  'no_response',
  'duplicate_correlation',
  'after_hours',
  'in_progress',
]

function isSkip(result: ContractScenario | ScenarioGenerationSkip): result is ScenarioGenerationSkip {
  return !('id' in result)
}

/** `now` is optional (defaults to real "now") and threaded through only to generateAfterHours()
 * -- exposed here so tests can inject a fixed instant and prove day-of-week independence
 * deterministically, rather than depending on which real day `npm test` happens to run on. */
export function generateContractScenarios(contract: ProcessContract, categories: ScenarioCategory[] = ALL_SCENARIO_CATEGORIES, now: Date = new Date()): ScenarioGenerationResult {
  const scenarios: ContractScenario[] = []
  const skipped: ScenarioGenerationSkip[] = []

  for (const category of categories) {
    const result = CATEGORY_GENERATORS[category](contract, now)
    if (isSkip(result)) skipped.push(result)
    else scenarios.push(result)
  }

  return { scenarios, skipped }
}
