import type { TypedAssumption } from '../pack/pack-builder.js'

/**
 * ProcessContract v0 (Phase 0 of docs/plans/process-contract-promise-engine-plan.md).
 *
 * A ProcessContract is a versioned, structured description of a commitment a business makes
 * about a recurring real-world thing -- not a workflow, not a pack, a *promise*. It names: the
 * entity the promise is about, how to tell one instance of that entity apart from another, what
 * "kept" and "broken" mean for it in terms of observable states and deadlines, who is
 * responsible at each stage, and what counts as proof.
 *
 * Deliberately separate from src/pack/pack-builder.ts's PackPlan -- confirmed directly against
 * that type (plan doc §3.1) to have zero concept of entity/state/SLA anywhere in it. PackPlan
 * answers "what workflows should I build"; ProcessContract answers "what is the business
 * committing to, and how do I know if it kept that commitment." A contract *compiles into* a
 * PackPlan (a later phase, not this one) -- it does not extend one.
 *
 * This schema was pressure-tested against a second, deliberately different example (a SaaS
 * incident-response promise, plan doc §4.5b) before being locked in here -- SlaSpec.recurring
 * and ProcessContract.businessCalendar's optionality both exist because that pressure test
 * found real, narrow gaps the original (Empire Homecare-only) draft didn't expose.
 */

export type ContractStatus = 'draft' | 'needs_confirmation' | 'active' | 'deprecated'

export interface ProcessContract {
  id: string
  version: number
  clientId: string
  name: string
  /** Plain-language summary of the commitment -- the sentence a human would say out loud.
   * Not derived from the structured fields below; authored alongside them, since the
   * structured form can express *how* to check the promise but the plain sentence is what a
   * human actually agreed to. */
  description: string

  entity: EntityDefinition
  correlationKey: CorrelationKeySpec
  promise: PromiseStatement

  startConditions: StartCondition[]
  states: ProcessState[]
  events: ProcessEvent[]
  transitions: ProcessTransition[]
  terminalOutcomes: TerminalOutcome[]

  owners: OwnerAssignment[]
  sla: SlaSpec[]
  /** Absent when every SlaSpec/ExpirationRule in this contract uses a wall-clock duration unit
   * ('minutes'/'hours') -- required only when at least one uses a business-calendar-aware unit
   * ('business_hours'/'business_days'), enforced by validateProcessContract() (rule 8), not
   * left as a silently-unused required field on a wall-clock-only contract. Found via the
   * Phase 0 pressure test (plan doc §4.5b) -- a real refinement, not part of the original
   * sketch. */
  businessCalendar?: BusinessCalendarRef

  /** Absent means no pause behavior -- SLA clocks always run once started. Present entries are
   * the only conditions that ever stop a clock; nothing implicit. */
  pauseRules?: PauseRule[]
  /** Absent means no automatic expiration -- an instance can remain open indefinitely with no
   * terminal outcome. Present for contracts where "too old to matter" is itself meaningful. */
  expirationRules?: ExpirationRule[]

  exceptions: ExceptionRule[]
  evidenceRequirements: EvidenceRequirement[]

  /** Reuses PackPlan's exact taxonomy (src/pack/pack-builder.ts's TypedAssumption) rather than
   * inventing a second one -- same three-tier meaning: safe/needs_confirmation/blocking. */
  assumptions: TypedAssumption[]

  provenance: ContractProvenance
  status: ContractStatus
}

export interface EntityDefinition {
  /** Free-text, per-contract name -- "Referral", "Incident", "Support Ticket". Never a fixed
   * enum or a shared cross-client taxonomy (no universal ontology -- plan doc §9.1). */
  name: string
  description: string
}

export interface CorrelationKeySpec {
  /** How one instance is told apart from another -- e.g. "phone number" or "incident ID". A
   * field PATH (dot-notation into the start-condition's own payload shape), not a value -- the
   * value is only known once a real instance starts. Confirmed via the Phase 0 pressure test to
   * generalize equally well to a system-generated ID (a paging system's incident ID) as to a
   * customer-submitted value (a phone number) -- no change needed for that case. */
  fieldPath: string
  /** Human description of what this key actually identifies, for a reviewer who isn't reading
   * the field path in the context of a specific webhook schema. */
  description: string
}

export interface PromiseStatement {
  /** The plain-language commitment. Multiple, independently-tracked promises within one
   * contract are explicitly out of scope for v0 -- this field is deliberately singular. */
  text: string
}

export interface StartCondition {
  id: string
  description: string
  /** How a real occurrence is detected -- deliberately loose in v0 (a description a human/LLM
   * reads, not a formal trigger-matching DSL) since the actual binding to a real webhook/
   * schedule happens at compile time (a later phase), not contract-authoring time. */
  trigger: string
  /** Which ProcessState.id a new promise instance begins in when this condition fires.
   * Explicit, not inferred from a self-loop transition or any other convention -- found missing
   * while writing the deterministic validator's reachability check (rule 3), which genuinely
   * needs a real starting point to compute reachability from. The original sketch modeled
   * "start" as a self-loop transition on the first state (see the Empire Homecare example's
   * pre-fix draft); this field replaces that -- a promise instance simply comes into existence
   * in `initialState`, with no synthetic "start event" needed. */
  initialState: string
}

export interface ProcessState {
  id: string
  name: string
  description: string
  /** True for exactly the states also listed in terminalOutcomes below -- kept as a separate,
   * explicit boolean (not inferred from terminalOutcomes membership) so the deterministic
   * validator can catch a state that's flagged terminal here but never actually reachable via
   * any transition, and vice versa -- two different validation failures, not conflated into
   * one. */
  terminal: boolean
}

export interface ProcessEvent {
  id: string
  name: string
  description: string
}

export interface ProcessTransition {
  id: string
  fromState: string
  event: string
  toState: string
  /** Optional guard description -- e.g. "only after the 3rd call_no_answer event". v0 keeps
   * this as a human/LLM-readable condition, not a formal boolean expression language (deferred
   * -- plan doc §9.7). */
  condition?: string
}

export interface TerminalOutcome {
  state: string
  /** Whether reaching this state means the promise was kept, or that it wasn't, or that it's an
   * acceptable-but-not-ideal resolution (e.g. "declined" -- the promise to *attempt* contact was
   * kept even though the customer said no). Three explicit values, not a boolean, because
   * collapsing "declined" and "never reached" into the same "not success" bucket would be
   * dishonest about two very different situations. */
  outcome: 'success' | 'acceptable' | 'failure'
  description: string
}

export interface OwnerAssignment {
  /** The state this owner is responsible for while an instance sits in it. */
  state: string
  /** Free-text role/name -- "intake coordinator", "on-call engineer". Not a user-directory
   * binding in v0 (deferred -- plan doc §9.8: real identity/notification integration). */
  owner: string
}

export interface SlaSpec {
  id: string
  /** The transition (by fromState) or event this deadline is measured from. */
  measuredFrom: { state: string } | { event: string }
  /** The state (or terminal outcome) this deadline expects to be reached by. */
  expectedBy: { state: string }
  /** Duration in business-calendar time for 'business_hours'/'business_days', or plain
   * wall-clock time for 'minutes'/'hours' -- confirmed via the Phase 0 pressure test that a
   * single contract can legitimately mix both kinds (a 24/7 acknowledgment SLA alongside a
   * business-days post-incident-report SLA in the same incident-response contract). */
  duration: { amount: number; unit: 'minutes' | 'hours' | 'business_hours' | 'business_days' }
  /** Absent (the default, and the only shape Empire Homecare's own example needs) means a
   * single deadline. Present means the same deadline re-arms every `duration` after the
   * previous instance of it is met, for as long as the promise instance remains in
   * `whileInState` -- e.g. "a status update at least every 30 minutes while the incident
   * remains open." Found necessary by the Phase 0 pressure test against a SaaS
   * incident-response contract (plan doc §4.5b) -- Empire Homecare's referral-intake never
   * needed this, so the gap wasn't visible until a genuinely different example was worked
   * through. Kept deliberately minimal: no cron-style cadence expressions, no per-recurrence
   * variable duration -- just "the same fixed interval, repeated, while a condition holds." */
  recurring?: { whileInState: string }
}

export interface BusinessCalendarRef {
  /** v0: a named, simple weekly-hours + holiday-list spec, not a shared calendar service
   * integration (deferred -- plan doc §9.9). timezone is required -- an SLA computed in the
   * wrong timezone is worse than no SLA at all. */
  timezone: string
  weeklyHours: Array<{ day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; start: string; end: string }>
  holidays?: string[] // ISO dates
}

export interface PauseRule {
  id: string
  /** Human/LLM-readable condition under which the SLA clock stops -- e.g. "customer explicitly
   * requested a callback next week". v0 does not attempt automatic detection of pause
   * conditions from raw data -- pausing is always a deliberate, evidenced action. */
  condition: string
  resumeCondition: string
}

export interface ExpirationRule {
  id: string
  /** The state this rule applies to. */
  state: string
  after: { amount: number; unit: SlaSpec['duration']['unit'] }
  /** Which terminal outcome an expired instance transitions to. */
  expiresTo: string
}

export interface ExceptionRule {
  id: string
  /** Human-readable trigger condition -- e.g. "no contact-attempt evidence 4 business hours
   * after intake". Deliberately has no state-transition side effect of its own -- firing an
   * exception routes to ExceptionDesk (a later phase) but never moves a promise instance
   * anywhere by itself. Confirmed via the Phase 0 pressure test (an incident-response SLA miss
   * must not silently terminate an ongoing incident) that this decoupling from
   * ExpirationRule is correct and load-bearing, not incidental. */
  condition: string
  owner: string
  /** Advisory only -- never auto-executed (no autonomous business decisions -- plan doc §9.3).
   * The exact text an ExceptionDesk item's nextAction would be seeded from, in a later phase. */
  suggestedAction: string
}

export interface EvidenceRequirement {
  /** The transition this requirement applies to. */
  transitionId: string
  /** The ONLY fields ProofLedger (a later phase) would ever be allowed to capture for this
   * transition -- whitelist-by-construction, not a scrub-after-the-fact list. Not enforced by
   * anything in Phase 0 (there is no ProofLedger yet) -- recorded on the contract now so the
   * schema doesn't need to change when that phase exists. */
  requiredFields: string[]
  description: string
}

export interface ContractProvenance {
  kairosVersion: string
  authoredBy: 'human' | 'llm_assisted'
  /** Present only when authoredBy === 'llm_assisted' -- same shape/purpose as
   * src/types/result.ts's BuildProvenance, scoped to contract authorship instead of workflow
   * generation. Absent in Phase 0, since there is no LLM authoring path yet (a later phase). */
  model?: string
  promptTemplateVersion?: string
  createdAt: string
  updatedAt: string
}
