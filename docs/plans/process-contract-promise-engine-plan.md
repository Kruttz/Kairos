# Kairos Process Contract / Promise Engine — Implementation Plan (v0)

**Date:** 2026-07-19 (written same day as the reliability-suite arc's closeout review, in the same session — see `docs/plans/reliability-suite-plan.md` for that arc's full history and the standing conventions this plan inherits).

**Status: Phase 0 SHIPPED 2026-07-19 (schema + deterministic validator + minimal storage). Phase 1 SHIPPED 2026-07-20 (LLM-assisted authoring + CLI + real-model checkpoint). Phases 2-5 remain planning only — not built, not started.** Per Codex's explicit approvals: Phase 0 — *"Plan reviewed. Direction approved. Start Phase 0 only... Do not implement Phase 1-5 yet."* Phase 1 — *"Phase 0 accepted. Start Phase 1 only: LLM-assisted ProcessContract authoring... Please take your time and do one step at a time."* Phase 0's own scope was pressure-tested against a second, deliberately different example before any type was locked in (§4.5b), and two more real, previously-hidden gaps (`StartCondition.initialState`; `ExpirationRule` edges missing from the reachability check) were found while actually implementing the validator against real fixtures, not while designing it on paper — both fixed and recorded where they were found, not folded silently into the original text. Phase 1's real-model checkpoint caught a genuine LLM-authoring mistake live (an unreachable terminal state in the SaaS draft) — direct, unstaged proof that the validator+escalation gate does its job on real model output, not just synthetic tests. See §10's Phase 0 and Phase 1 entries for the full build records.

**Sponsor framing (Codex, 2026-07-19), quoted because it is the thesis this entire plan serves:**
> *"Kairos should become a compiler/runtime for verifiable business promises. Workflows are compiled output, not the source of truth."*
> *"Because the next arc is bigger and more foundational than another CLI feature. It changes Kairos's source of truth from workflow pack to business process / promise contract. If designed wrong, Kairos could become overcomplicated fast. So the first step should be a plan, not code."*

---

## 1. Executive summary

Today, Kairos's entire reliability suite (drift, replay, chaos, watch, repair, patterns) answers one question: **"did the workflow behave?"** — structurally: did its node set change, did errors start appearing, does the live JSON match what Kairos built. That question is answered with real rigor (nine named drift checks, sandbox-verified replay, adversarial chaos payloads, an unattended watch loop, gated self-healing) — but it is a question about *code*, not about the *business*.

This plan proposes the layer above that: **"was the business promise kept?"** — e.g., not "did the missed-call-text-back workflow's structure drift" but "did every missed call actually get a text back within 5 minutes, and were the ones that didn't escalated to a human?" Kairos cannot answer that question today, because nothing in the codebase has a structured notion of an "entity" (a specific referral, a specific missed call), a "promise" (a commitment with a deadline), or a "terminal outcome" (was this instance's obligation actually discharged). `PackPlan` — the closest existing concept — is a flat list of workflow build specs with no state, no time, no entities, and no notion of a kept-vs-broken promise. Verified directly against `src/pack/pack-builder.ts` (§3 below).

The proposal: a new, explicit layer — **ProcessContract** (the promise, structured and versioned), **ProofLedger** (what was actually observed against that promise, honestly graded), and **ExceptionDesk** (what to do about the promises that are stuck, missed, or ambiguous) — that *compiles into* the existing workflow/reliability/delivery infrastructure rather than replacing any of it. Workflows remain the execution substrate. The reliability suite remains the structural-health layer. This is a new layer on top, not a rewrite of what exists.

**This plan is planning only.** Every phase below is scoped, sequenced, and checkpointed the same way the reliability-suite arc was — but none of it is built. The single most important design decision this document makes is **where ProcessContract must NOT try to be everything at once** (§9, guardrails) — the sponsor's own warning ("could become overcomplicated fast") is treated as the primary risk to design against, not a throwaway caveat.

---

## 2. When

Now — planning only. Codex's explicit sequencing: reliability-suite closeout accepted, npm publish deliberately withheld pending separate approval, and this plan is the *next* piece of work, but design-first. No `ProcessContract`/`ProofLedger`/`ExceptionDesk` code, no CLI wiring, no schema implementation — this document is the entire deliverable for this pass. Implementation begins only after this plan is reviewed and a go-ahead is given, phase by phase, matching exactly how the reliability suite itself was built (plan reviewed and approved → Phase 0 → checkpoint → Phase 1 → ...).

---

## 3. Design-verification pass — what the current codebase actually does (read directly, not from memory)

This section exists because the reliability-suite arc's own single most valuable discipline was "re-verify the actual current code before designing against it, rather than trusting an old sketch or memory" — that discipline caught real, load-bearing corrections in nearly every phase of that arc (Phase 3's `Kairos.replace()` finding, Phase 5's `exampleMessages` finding, and more). Applied here, before any of §4-§8 below were written:

### 3.1 `PackPlan` is workflow-shaped, not promise-shaped

Read directly from `src/pack/pack-builder.ts`:

```typescript
export interface PackPlan {
  businessContext: string
  workflows: WorkflowPlan[]
  assumptions: TypedAssumption[]
  sheetsColumns: Array<{ sheet: string; columns: string[] }>
  testChecklist: Array<{ workflow: string; steps: string[] }>
}
```

`WorkflowPlan` is `{ name, description, purpose, workflowKey?, dependsOn? }` — a natural-language build description per workflow, plus an optional same-pack dependency declaration. `PackBuilder.plan()` produces this from one LLM call against a fixed prompt template (`PLAN_PROMPT`) that literally instructs the model to "Generate a list of 4-8 n8n workflows." There is no field anywhere in `PackPlan`, `WorkflowPlan`, `PackWorkflowResult`, or `WorkflowPackResult` for: an entity, a correlation key, a state, an event, a transition, a terminal outcome, an SLA, a business calendar, or an owner. `assumptions` (`TypedAssumption[]`, `{type: 'safe'|'needs_confirmation'|'blocking', text}`) is the *only* structured concept PackPlan has that ProcessContract can directly reuse (§4.1).

**This is the concrete evidence for why ProcessContract must be a separate type, not an extension of `PackPlan`:** `PackPlan` answers "what workflows should I build," a question with a *workflow-shaped* answer (a list of build descriptions). ProcessContract must answer "what is the business committing to, and how do I know if it kept that commitment," a question with a *state-machine-shaped* answer (entities, states, transitions, deadlines, evidence). Bolting the second onto the first would either weaken `PackPlan` (adding fields most workflows-only builds never use) or produce a type that lies about being one thing while doing two unrelated jobs — the same reasoning that kept the Delivery Bundle's "Contract Pack" naming away from colliding with `WorkflowPackResult`'s own "pack" concept (`docs/plans/reliability-suite-plan.md` §10.0 references this precedent from a prior phase). ProcessContract is upstream of `PackPlan`, not a variant of it: a contract *compiles into* a `PackPlan` (§5.1), it does not extend one.

### 3.2 The reliability suite's 4-state honesty discipline is the load-bearing pattern to reuse, not reinvent

Read directly from `src/reliability/drift/checks.ts`:

```typescript
export type DriftCheckStatus = 'insufficient_data' | 'not_applicable' | 'healthy' | 'drifting'
```

Four states, "never conflated" (the module's own comment). `insufficient_data` is temporary (not enough history *yet*); `not_applicable` is permanent (this check fundamentally doesn't apply to this workflow); `healthy`/`drifting` are the only two states with an actual verdict. Separately, `src/reliability/drift/diagnose.ts` layers a **confidence-tiered causal language** on top (`'high' → "Likely caused by: X"`, `'medium' → "Possible cause: X"`, `'low' → "Observed symptom; cause unknown."` — the low-confidence tier explicitly never surfaces a cause, "the exact overclaiming this module exists to prevent," per its own comment) and a `DriftEvidenceQuality` dimension (`'specific'|'generic'`) distinguishing well-classified evidence from ambiguous evidence.

**ProofLedger's status model (§6) is a direct, deliberate descendant of this exact pattern**, not a new invention — see §6.1 for the mapping. This matters for the plan's credibility: the reliability suite spent six phases proving this 4-state, confidence-tiered, never-overclaim discipline works in production. Reusing it for ProofLedger is the single highest-confidence design decision in this whole document, because it is not a bet — it is already validated.

### 3.3 `ExecutionTrace` is deliberately structural-only — and ProofLedger cannot inherit that constraint unmodified

Read directly from `src/library/types.ts`:

```typescript
export interface ExecutionTrace {
  recordedAt: string
  executionId: string
  status: 'success' | 'error' | 'waiting' | 'running' | 'canceled'
  durationMs: number | null
  executedNodes: string[]
  erroredNodes: Array<{ name: string; errorType: string; httpCode?: string }>
  itemCount: number
  nodeDurations: Record<string, number>
}
```

Every field here is structural (which nodes ran, whether they errored, how long they took) — deliberately, by design, "never data values" (confirmed by the module's own comments elsewhere and the whole reliability suite's G3 payload-privacy guardrail). This is correct for what the reliability suite needed: "did the workflow's *behavior* drift" never requires knowing *what a customer said*.

ProofLedger cannot copy this constraint verbatim. "The referral was contacted" or "the customer declined" is not a structural fact about node execution — it is a **business-meaningful value**. This is a real, load-bearing tension the plan must resolve explicitly (§9.4), not paper over: ProofLedger evidence sometimes needs to capture the *outcome*, not just the *shape*, of an execution. The resolution is whitelist-by-construction (the same principle Phase 5's `WhitelistedPattern` already proved out for community pattern sharing, §9.4) applied to a new domain: a ProcessContract's own `evidenceRequirements` (§4.9) explicitly declares, per transition, the *only* fields ProofLedger is ever allowed to capture — nothing implicit, nothing inferred from a raw payload.

### 3.4 Client memory is a flat knowledge store, not a state machine — a related but distinct concept

Read directly from `src/memory/types.ts`: `MemoryNode` (`{id, source, type: 'preference'|'history'|'incident'|'reference', confidence, tags, description, body}`), retrieved via BM25+embedding hybrid search (`src/memory/retrieval.ts`). This is a per-client, unstructured, retrieval-oriented knowledge base — it answers "what do we already know about this client" for prompt-injection purposes. It has no notion of an entity instance, a state, or a deadline. ProcessContract is not built on top of client memory and does not extend `MemoryNode` — but the two connect in one direction only (§7.2): a client's `ProcessContract`s and significant `ExceptionDesk` history are natural candidates to *surface through* memory retrieval (e.g., "this client's referral-intake SLA is 4 business hours" becoming a retrievable `reference`-type memory node), the same way Phase D's audit trail already informs future generation without memory itself modeling the contract.

### 3.5 `BuildProvenance` is the direct model for `ContractProvenance`

Read directly from `src/types/result.ts`: `BuildProvenance` (`kairosVersion, model, maxTokens, temperature, runId, ruleSetVersion, promptTemplateVersion, promptProfile, nodeCatalogVersion`) — every field answers "what, exactly, produced this artifact, so a later drift/audit question has a real answer." ProcessContract's own `provenance` field (§4.11) follows the identical shape and purpose, scoped to contract authorship instead of workflow generation.

### 3.6 The audit-ledger pattern (`reliability-audit.jsonl`) is the direct model for ProofLedger's storage

Read directly from `src/reliability/watch/audit.ts`: append-only JSONL, a discriminated union of entry `kind`s, timestamped, best-effort writes that never block or fail the calling operation, read back only by the one narrow decision that legitimately needs history (`apply.ts`'s auto-mode one-attempt-per-cause gate) — otherwise purely a human-facing record. ProofLedger (§6) reuses this exact storage pattern, not a new one — same conventions `pattern-audit.jsonl` (Phase D) already established independently, meaning this is now the *third* independent instance of the same append-only-ledger idiom in this codebase. Three independent, successful uses of the same pattern is strong evidence it is the right one for a fourth.

### 3.7 The Delivery Bundle's artifact-and-manifest pattern is the direct model for promise reporting

Read directly from `src/pack/pack-bundle.ts`: `BundleManifest` (`{generatedAt, packName, files: [...], skipped: [...], provenance}`), `writeBundle()` composing already-existing per-artifact generator functions, one failing artifact never aborting the rest, every skip recorded with a reason. A new `promise-report.md` artifact (§5.6) is a straightforward, low-risk *addition* to this existing, already-proven system — not a new reporting mechanism.

### 3.8 `EscalationInfo` (Phase A) and `PatternAuditEntry` (Phase D) are the direct models for ExceptionDesk

Read directly from `src/pack/pack-builder.ts`: `EscalationInfo` (`{reason, questions, source: 'blocking_assumptions'}`) — "here is why, here are the exact questions to resolve," returned *instead of* building anything, stopping before any spend. And from `src/telemetry/pattern-analyzer.ts`: `PatternAuditEntry` (`{ts, rule, from, to, actor: 'auto'|'human', evidence?, reason?}`) — an append-only, typed state-transition history. ExceptionDesk (§7) is these two ideas combined and applied to a promise instance instead of a pack-build or a pattern: "here's what's stuck and why" (Phase A's shape) with an auditable status lifecycle (Phase D's shape).

### 3.9 Confirmed: no naming collisions

`grep` against `src/cli.ts` confirms no existing command surface named `contract`, `ledger`, `exceptions`, or `promise` — the natural CLI verbs this plan would eventually need (`kairos contract ...`, `kairos ledger ...`, `kairos exceptions ...`) are free.

### 3.10 What this pass changed from the sponsor's own framing

Nothing structural — the sponsor's framing ("compiler/runtime for verifiable business promises," "workflows are compiled output") survives this pass intact and is adopted as the plan's thesis (§1). What this pass adds, beyond the framing, is *precisely which existing modules the compiler targets* (§5) and *which existing pattern each new concept is a proven descendant of* (§3.2, §3.6, §3.8) — turning "build a promise compiler" from a green-field proposal into a scoped extension of six already-shipped, already-proven subsystems.

---

## 4. ProcessContract v0 — what it is, and its schema

### 4.1 Definition

A **ProcessContract** is a versioned, structured description of a commitment a business makes about a recurring real-world thing — not a workflow, not a pack, a *promise*. It names: the *entity* the promise is about, how to tell one instance of that entity apart from another, what "kept" and "broken" mean for it in terms of observable states and deadlines, who is responsible at each stage, and what counts as proof.

A ProcessContract does not describe *how* n8n implements it. That is the compiler's job (§5), not the contract's.

### 4.2 Running example — used throughout this entire document (per Codex's explicit request for one narrow real-client example)

**Empire Homecare's referral-intake/contact promise** (matches Jordan's real target vertical, already the documented focus of Kairos's current DME-automation work):

> *"Every referral will be contacted within 4 business hours of intake, and the outcome will be logged. If a referral has not been reached after 3 attempts within 24 business hours, it is escalated to a human."*

This single example is used to ground every schema field below, every compilation target in §5, every ProofLedger entry shape in §6, and the one ExceptionDesk scenario walked through in §7 — deliberately, so the plan is validated against one coherent, realistic case end to end rather than described only in the abstract.

### 4.3 Schema (TypeScript interfaces, styled to match this codebase's existing conventions exactly — discriminated unions, honest-absence comments, no speculative fields)

```typescript
// src/promise/types.ts (proposed location — see §8, "Where")

export type ContractStatus = 'draft' | 'needs_confirmation' | 'active' | 'deprecated'

export interface ProcessContract {
  id: string
  version: number
  clientId: string
  name: string
  /** Plain-language summary of the commitment -- the sentence a human would say out loud.
   * E.g. "Every referral is contacted within 4 business hours." Not derived from the
   * structured fields below; authored alongside them, since the structured form can express
   * *how* to check the promise but the plain sentence is what a human actually agreed to. */
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
   * ('business_hours'/'business_days'), enforced by the deterministic validator (§4.4), not
   * left as a silently-unused required field on a wall-clock-only contract. Found via the
   * Phase 0 pressure test (§4.5b) -- a real refinement, not part of the original sketch. */
  businessCalendar?: BusinessCalendarRef

  /** Absent means no pause behavior -- SLA clocks always run once started. Present entries are
   * the only conditions that ever stop a clock; nothing implicit. */
  pauseRules?: PauseRule[]
  /** Absent means no automatic expiration -- an instance can remain open indefinitely with no
   * terminal outcome. Present for contracts where "too old to matter" is itself meaningful
   * (the referral-intake example: unreached after 24 business hours). */
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
  /** Free-text, per-contract name -- "Referral", "Missed Call", "Support Ticket". Never a
   * fixed enum or a shared cross-client taxonomy (§9.1 -- no universal ontology). */
  name: string
  description: string
}

export interface CorrelationKeySpec {
  /** How one instance is told apart from another -- e.g. "phone number" or "intake form
   * submission ID". A field PATH (dot-notation into the start-condition's own payload shape),
   * not a value -- the value is only known once a real instance starts (§6.2). */
  fieldPath: string
  /** Human description of what this key actually identifies, for a reviewer who isn't reading
   * the field path in the context of a specific webhook schema. */
  description: string
}

export interface PromiseStatement {
  /** The plain-language commitment (may duplicate ProcessContract.description verbatim for a
   * simple contract, or be more specific -- e.g. multiple promises within one contract are
   * explicitly out of scope for v0, see §9.6). */
  text: string
}

export interface StartCondition {
  id: string
  description: string
  /** How a real occurrence is detected -- deliberately loose in v0 (a description a human/LLM
   * reads, not a formal trigger-matching DSL) since the actual binding to a real webhook/
   * schedule happens at compile time (§5.1), not contract-authoring time. */
  trigger: string
  /** Which ProcessState.id a new promise instance begins in when this condition fires.
   * Explicit, not inferred from a self-loop transition or any other convention -- found missing
   * while implementing the deterministic validator's reachability check (§4.4 rule 3), which
   * genuinely needs a real starting point to compute reachability from. Replaces this plan's
   * original self-loop-as-implicit-start modeling (§4.5's first draft) -- a promise instance
   * simply comes into existence in `initialState`, no synthetic "start event" needed. */
  initialState: string
}

export interface ProcessState {
  id: string
  name: string
  description: string
  /** True for exactly the states also listed in terminalOutcomes below -- kept as a separate,
   * explicit boolean (not inferred from terminalOutcomes membership) so the deterministic
   * validator (§4.4) can catch a state that's flagged terminal here but never actually
   * reachable via any transition, and vice versa -- two different validation failures, not
   * conflated into one. */
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
   * this as a human/LLM-readable condition, not a formal boolean expression language (§9.7,
   * deferred: a real guard-expression DSL is real, separate engineering). */
  condition?: string
}

export interface TerminalOutcome {
  state: string
  /** Whether reaching this state means the promise was kept, or that it wasn't, or that it's
   * an acceptable-but-not-ideal resolution (e.g. "declined" -- the promise to *attempt* contact
   * was kept even though the customer said no). Three explicit values, not a boolean, because
   * collapsing "declined" and "never reached" into the same "not success" bucket would be
   * dishonest about two very different situations. */
  outcome: 'success' | 'acceptable' | 'failure'
  description: string
}

export interface OwnerAssignment {
  /** The state this owner is responsible for while an instance sits in it. */
  state: string
  /** Free-text role/name -- "intake coordinator", "on-call rep". Not a user-directory binding
   * in v0 (§9.8, deferred: real identity/notification integration). */
  owner: string
}

export interface SlaSpec {
  id: string
  /** The transition (by fromState) or event this deadline is measured from. */
  measuredFrom: { state: string } | { event: string }
  /** The state (or terminal outcome) this deadline expects to be reached by. */
  expectedBy: { state: string }
  /** Duration in business-calendar time (see businessCalendar below) -- e.g. "4 business
   * hours". Stored as a duration spec, not a raw number of ms, so the calendar-aware
   * arithmetic (§5.3) has enough to actually compute a real deadline against real business
   * hours/holidays, not just wall-clock time. */
  duration: { amount: number; unit: 'minutes' | 'hours' | 'business_hours' | 'business_days' }
  /** Absent (the default, and the only shape Empire Homecare's own example needs) means a
   * single deadline. Present means the same deadline re-arms every `duration` after the
   * previous instance of it is met, for as long as the promise instance remains in
   * `whileInState` -- e.g. "a status update at least every 30 minutes while the incident
   * remains open." Found necessary by the Phase 0 pressure test (§4.5b) against a SaaS
   * incident-response contract -- Empire Homecare's referral-intake never needed this, so the
   * gap wasn't visible until a genuinely different example was worked through. Kept
   * deliberately minimal: no cron-style cadence expressions, no per-recurrence variable
   * duration -- just "the same fixed interval, repeated, while a condition holds." */
  recurring?: { whileInState: string }
}

export interface BusinessCalendarRef {
  /** v0: a named, simple weekly-hours + holiday-list spec, not a shared calendar service
   * integration (§9.9, deferred). timezone is required -- an SLA computed in the wrong
   * timezone is worse than no SLA at all. */
  timezone: string
  weeklyHours: Array<{ day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; start: string; end: string }>
  holidays?: string[] // ISO dates
}

export interface PauseRule {
  id: string
  /** Human/LLM-readable condition under which the SLA clock stops -- e.g. "customer explicitly
   * requested a callback next week". v0 does not attempt automatic detection of pause
   * conditions from raw data (§9.7) -- pausing is always a deliberate, evidenced action. */
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
   * after intake". Maps to ExceptionKind at detection time (§7.1), not authored as an enum
   * here, since the same rule text can legitimately produce different exception kinds
   * depending on which state the instance was actually in when the rule fired. */
  condition: string
  owner: string
  /** Advisory only -- never auto-executed (§9.3). The exact text an ExceptionDesk item's
   * nextAction is seeded from. */
  suggestedAction: string
}

export interface EvidenceRequirement {
  /** The transition this requirement applies to. */
  transitionId: string
  /** The ONLY fields ProofLedger is ever allowed to capture for this transition -- whitelist-
   * by-construction (§3.3, §9.4), not a scrub-after-the-fact list. */
  requiredFields: string[]
  description: string
}

export interface ContractProvenance {
  kairosVersion: string
  authoredBy: 'human' | 'llm_assisted'
  /** Present only when authoredBy === 'llm_assisted' -- same shape/purpose as
   * BuildProvenance (§3.5), scoped to contract authorship instead of workflow generation. */
  model?: string
  promptTemplateVersion?: string
  createdAt: string
  updatedAt: string
}
```

### 4.4 The deterministic validator (v0's own "131-rule validator," scoped to contracts)

A `ProcessContract` is well-formed only if (all deterministic, no LLM call, styled after `src/validation/validator.ts`'s own rule-by-rule structure, and directly analogous to `src/pack/dependency-graph.ts`'s existing cycle-detection/topological-sort passes over a *different* graph — workflow dependencies rather than state transitions, same class of problem):

1. Every `ProcessTransition.fromState`/`toState` references a real `ProcessState.id`.
2. Every `ProcessTransition.event` references a real `ProcessEvent.id`.
3. Every state is reachable from at least one `StartCondition.initialState` via zero or more transitions **or `ExpirationRule` edges** (an initial state is trivially reachable from itself; unreachable states are a real authoring bug, not a stylistic nit — an unreachable state can never be entered, so any owner/SLA/exception rule attached to it is dead code). Every `StartCondition.initialState` references a real `ProcessState.id`. **Found live against the Empire Homecare fixture itself, not designed in advance:** `no_answer` is only ever entered via `ExpirationRule.expiresTo` (§4.3), never via an explicit `ProcessTransition` — the reachability check's first implementation only walked the transitions graph and incorrectly flagged a real, legitimately-reachable state as dead. Fixed by treating each `ExpirationRule.state → expiresTo` pair as a real edge in the same reachability graph.
4. Every state flagged `terminal: true` has no outgoing transitions (a "terminal" state that can still transition is a contradiction), and every state referenced in `terminalOutcomes` is flagged `terminal: true` (keeps §4.3's deliberate double-bookkeeping honest — see the comment on `ProcessState.terminal`).
5. **(Corrected while implementing, from the original sketch's "SlaSpec + ExceptionRule + EvidenceRequirement" wording)** Every `SlaSpec.measuredFrom`/`expectedBy`, `OwnerAssignment.state`, `ExpirationRule.state`/`expiresTo`, and `EvidenceRequirement.transitionId` reference real states/events/transitions. `ExceptionRule` is *not* part of this rule — checked directly against its own type, it has no state/event/transition-reference field at all, only free-text `condition`/`owner`/`suggestedAction` (deliberately: it never moves a promise instance anywhere by itself, see §4.3's own comment on the field).
6. `correlationKey.fieldPath` is a non-empty, syntactically valid dot-path (structural check only — v0 cannot confirm the path actually exists in a real payload until compile time, §5.1).
7. At least one terminal outcome has `outcome: 'success'` (a contract with no possible success path is almost certainly an authoring mistake, not a real business intent — flagged as an error, not silently accepted).
8. **(Added post-pressure-test, §4.5b)** If any `SlaSpec`/`ExpirationRule` uses a `business_hours`/`business_days` duration unit, `businessCalendar` must be present; if `businessCalendar` is absent, no `SlaSpec`/`ExpirationRule` may use a business-calendar-aware unit. The two conditions are checked together, not independently, so a contract can never end up with a calendar-aware SLA and no calendar to compute it against, nor a populated calendar nobody actually needed.
9. **(Added post-pressure-test, §4.5b)** `SlaSpec.recurring.whileInState`, when present, references a real `ProcessState.id`.

**Outcome:** a `validateProcessContract(contract): ContractValidationIssue[]` function, exit-code-gated the same way `kairos validate-pack` already is. This ships in Phase 0 (§10) with zero LLM involvement — pure, fast, fully deterministic, the same trust profile as the existing 131-rule validator.

### 4.5 Applying the schema to the running example (Empire Homecare)

- **Entity:** `{name: "Referral", description: "A person referred to Empire Homecare for DME services"}`
- **Correlation key:** `{fieldPath: "body.phone", description: "The referral's phone number, as submitted on the intake form"}`
- **States:** `received` (terminal: false) → `contact_attempted` (terminal: false) → `contacted` (terminal: false, an intermediate success-path state, not terminal itself since it still needs an outcome) → `scheduled` (terminal: true), `declined` (terminal: true), `no_answer` (terminal: true, reached via expiration, §4.3's `ExpirationRule`)
- **Start condition:** `{trigger: "New row in the referral intake Google Sheet / webhook POST from the intake form", initialState: "received"}` — a new instance comes into existence directly in `received`; no synthetic "start event" needed (§4.3's `StartCondition.initialState`, added while implementing the reachability validator — see that field's own comment for why).
- **Events:** `call_attempted`, `call_answered`, `call_no_answer`, `customer_declined`, `appointment_scheduled`
- **Transitions:** `received + call_attempted → contact_attempted`, `contact_attempted + call_answered → contacted`, `contacted + appointment_scheduled → scheduled`, `contacted + customer_declined → declined`
- **Terminal outcomes:** `scheduled` (success), `declined` (acceptable — the promise to *attempt* contact was kept even though the answer was no), `no_answer` (failure)
- **Owners:** `{state: "received", owner: "intake coordinator"}`, `{state: "contact_attempted", owner: "on-call rep"}`
- **SLA:** `{measuredFrom: {state: "received"}, expectedBy: {state: "contact_attempted"}, duration: {amount: 4, unit: "business_hours"}}`
- **Business calendar:** Mon-Fri 8am-5pm, America/Denver (Empire's real hours)
- **Expiration rule:** `{state: "contact_attempted", after: {amount: 24, unit: "business_hours"}, expiresTo: "no_answer"}`
- **Exception rule:** `{condition: "no contact-attempt evidence 4 business hours after intake", owner: "intake coordinator", suggestedAction: "Call the referral immediately and log the outcome."}`
- **Evidence requirements:** `{transitionId: "contact_attempted→contacted", requiredFields: ["callOutcome", "callTimestamp"], description: "The call log entry recording the attempt's result."}`

This is deliberately worked through in full here, not left abstract, so §5-§7 below can each show exactly what they do *to this same contract* rather than re-explaining the domain each time.

### 4.5b Pressure test: a second, deliberately contrasting example (Codex's explicit instruction — worked through *before* §4.3's schema above was finalized, not after)

Codex's own framing for this step: *"Before finalizing the Phase 0 schema, sketch one non-homecare/non-referral example to test whether the schema is too Empire-specific. It does not need to compile or build yet — just use it to pressure-test the model."* This section is that pressure test, done honestly — it records what the schema got right on the first try, and the one real gap it found, rather than only the parts that confirm the original design.

**The example: a SaaS company's P1 (critical) incident-response promise**, chosen specifically to differ from Empire Homecare's referral-intake along several axes at once — a system-generated (not customer-submitted) correlation key, a 24/7 (not business-hours) SLA sitting in the *same contract* as a business-hours SLA, and a recurring obligation rather than a single deadline:

> *"Every P1 incident is acknowledged by an on-call engineer within 15 minutes of being raised, 24/7. While the incident remains open, a status update is posted at least every 30 minutes until it is resolved. Every P1 is followed by a post-incident report within 3 business days of resolution."*

Worked through field by field against §4.3's schema *as originally drafted, before this section's own findings were folded back in above* (the diffs described below are what changed §4.3 already has applied — this section explains *why*, not just *what*):

- **Entity/correlation key:** `{name: "Incident", ...}`, `{fieldPath: "body.incidentId", description: "The unique ID assigned by the paging system (e.g. PagerDuty) when the incident is created"}`. **Confirmed correct, no change:** `CorrelationKeySpec` is just "a field path into a payload" — it does not care whether the value is customer-submitted (a phone number) or system-generated (a paging-system ID). The abstraction already generalizes.
- **States/events/transitions:** `raised → acknowledged → open_updating → resolved → postmortem_complete` (terminal, success), with `open_updating` looping on itself via repeated `status_update_posted` events, and a `downgraded` terminal (acceptable) if severity drops below P1 before resolution. **Confirmed correct, no change:** this maps cleanly onto `ProcessState`/`ProcessTransition` with zero new fields — a genuine, meaningful self-loop (an update event that keeps the instance in the same state) is representable exactly the same way an ordinary transition is, no special case needed.
- **SLA #1 (ack within 15 minutes, 24/7):** `{measuredFrom: {state: "raised"}, expectedBy: {state: "acknowledged"}, duration: {amount: 15, unit: "minutes"}}`. **Confirmed correct, no change:** this is exactly what the plain `'minutes'`/`'hours'` (wall-clock, non-business-hours) units in `SlaSpec.duration.unit` were already designed for — a real, working example of a 24/7 SLA that must NOT be computed against business hours, sitting in the schema's own type since the original draft.
- **SLA #3 (post-incident report within 3 business days):** `{measuredFrom: {state: "resolved"}, expectedBy: {state: "postmortem_complete"}, duration: {amount: 3, unit: "business_days"}}`. **Confirmed correct, no change:** the business-calendar-aware unit works exactly as designed — and, combined with SLA #1 above, proves a *single contract* can legitimately mix wall-clock and business-calendar-aware SLAs, which the original schema already technically allowed (`SlaSpec[]`, each with its own `duration.unit`) but which Empire Homecare's own example (uniformly business-hours) never actually exercised.
- **Exception on a missed ack SLA:** the natural instinct is "if ack is late, the promise is broken, expire the instance" — but a real P1 that's acknowledged *late* is still an ongoing incident that still needs to be acknowledged; it must not silently stop being tracked. Checked directly against the schema: `ExceptionRule` (§4.3) has no state-transition side effect of its own — firing an exception routes to ExceptionDesk (§7) but does not move the instance anywhere, and `ExpirationRule` is a *fully separate*, optional mechanism. **Confirmed correct, no change** — but this is a genuinely useful confirmation the Empire Homecare example alone didn't surface clearly, since there both mechanisms fired together at the same 24-hour boundary and could easily have been mistaken for coupled. This second example proves they're independent, which is exactly the behavior a real incident-response contract needs (raise the alarm; don't stop tracking the incident).
- **SLA #2 (a status update at least every 30 minutes while open) — THE REAL GAP.** This is not a single deadline from one point to another; it's a recurring obligation that re-applies for as long as the instance sits in one state. §4.3's `SlaSpec` as originally drafted (`measuredFrom → expectedBy`, once) has no way to express "and then again, and then again, until the incident resolves." **This is a genuine, real gap the pressure test was specifically for.**

**The decision, made here rather than deferred:** add one small, optional field — `SlaSpec.recurring?: { whileInState: string }` (full type + rationale now folded into §4.3 above) — rather than either silently leaving the gap unaddressed or building a general cadence/cron sub-language. The scope is deliberately narrow: a fixed interval, repeated, while a named state holds. No variable intervals, no cron expressions, no per-recurrence conditions. This is exactly the same "add exactly what a real example needs, nothing speculative" discipline the whole plan's §9 guardrails already commit to — the pressure test is what makes that discipline verifiable rather than aspirational.

**A smaller, secondary finding, also folded into §4.3:** `businessCalendar` was originally a required field on every `ProcessContract`. This example's SLA #1/#2 are wall-clock and never reference the calendar at all — only SLA #3 does. Made `businessCalendar` optional, with §4.4's validator (rule 8, added here) enforcing the real constraint precisely: present if and only if some `SlaSpec`/`ExpirationRule` actually needs it, rather than a required field that's sometimes structurally unused.

**What this pressure test did *not* find:** no change was needed to `EntityDefinition`, `ProcessState`, `ProcessEvent`, `ProcessTransition`, `TerminalOutcome`, `OwnerAssignment`, `ExceptionRule`, or `EvidenceRequirement` — all five carried over to a structurally different domain (system alerting vs. customer intake; 24/7 vs. business-hours; recurring vs. one-shot) without modification. That is a meaningfully positive signal about the schema's actual shape, not just an absence of problems — five of seven non-trivial structural concepts generalized on the first attempt, and the two that didn't (`SlaSpec`, `businessCalendar`) needed small, narrow, additive fixes, not a redesign. This is the outcome §9's "don't over-engineer, but do pressure-test before locking the schema" instruction was aiming for.

---

## 5. How ProcessContract compiles into existing Kairos infrastructure

This is the "compiler" half of the sponsor's framing, made concrete against the actual modules that exist today (§3).

### 5.1 → Workflows (via `PackPlan`, reusing `PackBuilder` unchanged underneath)

A new `compileToPackPlan(contract: ProcessContract): PackPlan` function. **This does not replace `PackBuilder.plan()`'s LLM call — it replaces the free-form prompt with a tightly-constrained one**, and the resulting `PackPlan.workflows[]` build descriptions are still generated exactly the way they are today, through `Kairos.build()`, with the full existing validation/retry/provenance machinery unchanged.

Concretely, for the Empire Homecare example, `compileToPackPlan()` would produce a `PackPlan` whose `WorkflowPlan[]` build descriptions are derived from the contract's own state clusters, not invented by the LLM from scratch:
- A "Referral Intake Capture" workflow build description generated from `startConditions` + the `received` state + the correlation key requirement ("every workflow must read/write `body.phone` as a stable identifier" is injected as an explicit generation constraint, the same way `priorContext`/`WorkflowReference` already inject cross-workflow chaining context today, §3.1's `dependsOn` mechanism reused for a new purpose).
- A "Referral Contact + Outcome Logging" workflow build description generated from the `contact_attempted → {contacted, declined}` transitions and the `EvidenceRequirement` for that transition (the description explicitly instructs the generator to log `callOutcome`/`callTimestamp`, since that's what §6's ProofLedger will need to read back).
- A "Referral SLA Escalation" workflow build description generated from the `SlaSpec` + `ExpirationRule` + `ExceptionRule` — a schedule-triggered workflow that checks for `received` instances past their 4-business-hour deadline with no `contacted` evidence.

The dependency-declaration mechanism `PackBuilder` already has (`dependsOn`, `resolveBuildOrder()`, `WorkflowReference`/`priorContext`) is reused as-is to chain these three workflows' generation, exactly the way an unrelated multi-workflow pack already chains today (§3.1). **No new workflow-generation engine is built.** The correlation key, evidence requirements, and SLA become structured *inputs to the existing prompt-construction pipeline*, not a new pipeline.

### 5.2 → Tests

Reuses `src/pack/webhook-schema.ts`'s existing `generateTestPayload()`/`extractWebhookFieldRefs()` machinery for single-execution field-shape fixtures (unchanged, no new work). **New, beyond what exists today:** a promise-instance-shaped fixture — a *sequence* of events over simulated time, not a single execution — e.g. a synthetic "referral received, never contacted, 24 business hours pass" fixture that exercises the expiration path end to end. This is a genuinely new fixture *shape* (today's `test-payloads.json` is single-shot; a promise-instance fixture is a scripted mini-timeline), scoped to Phase 4/5 (§10), not v0's Phase 0-3.

### 5.3 → Monitors

A new `checkSlaCompliance()` function, styled identically to `src/reliability/drift/checks.ts`'s existing D1-D9 functions: pure, evidence-driven, returning the same `insufficient_data`/`not_applicable`/`healthy`/`drifting` shape (§3.2) — here meaning: not enough ProofLedger evidence yet to evaluate / this instance's SLA doesn't apply (e.g., already terminal) / within deadline / past deadline with no qualifying evidence. This produces a `buildPromiseComplianceReport()` alongside (not merged into) `buildDriftCheckReport()` — a promise-compliance check is conceptually parallel to a drift check, not a tenth drift check, since it operates over promise instances, not workflow execution history. Wired into `kairos watch`'s existing tick loop (`src/reliability/watch/loop.ts`) as an additional per-target check type, reusing the exact same audit-ledger write path (`reliability-audit.jsonl`, §3.6) rather than a parallel logging mechanism.

### 5.4 → Replay/chaos scenarios

**Explicitly scoped OUT of v0** (§9.6, §10's phase table, §11 risks). A ProcessContract's states/events are a real, valuable future source of new chaos payload classes ("customer replies with an ambiguous message," "duplicate intake for the same correlation key," "SLA deadline passes with zero evidence") — but this is genuinely new engineering on top of `src/reliability/chaos/payloads.ts`'s existing enumeration, not a straightforward reuse the way §5.1-§5.3 are. Named here so the connection is documented and not forgotten, deferred to a phase after v0's core loop (ProcessContract → compile → ProofLedger → ExceptionDesk) is proven.

### 5.5 → Exception routing

ExceptionDesk itself — §7.

### 5.6 → Reports

A new Delivery Bundle artifact, `promise-report.md`, added to `src/pack/pack-bundle.ts`'s existing artifact set (§3.7) via the same `writeBundle()`/`BundleManifest` pattern already proven across six existing artifacts. Aggregates ProofLedger entries for a contract over a time window into a client-facing summary: how many instances, how many kept/acceptable/failed, how many still open, how many exceptions raised and resolved. **Carries the same mandatory DISCLAIMER discipline already established for `test-payloads.json`/`contract.openapi.json`** (§3.7): if most evidence for a contract is `unverifiable` (§6.1), the report must say so plainly, never round `unverifiable` up into an implied "probably fine."

---

## 6. ProofLedger v0

### 6.1 The status model — a direct, explicit descendant of the reliability suite's 4-state discipline

```typescript
// src/promise/ledger-types.ts (proposed)

export type ProofStatus = 'observed' | 'asserted' | 'verified' | 'unverifiable'
```

Mapped explicitly against `DriftCheckStatus` (§3.2), because the parallel is the point, not a coincidence:

| ProofLedger | Meaning | Nearest `DriftCheckStatus` analogue |
|---|---|---|
| `observed` | Kairos's own instrumentation directly recorded this signal (a compiled workflow reported an event structurally) — high confidence, but not independent confirmation of real-world truth. | `healthy`/`drifting` (the check ran, had what it needed) |
| `asserted` | A human or an LLM-derived judgment claims this happened, with no independent structural confirmation (e.g., a coordinator manually marks "contacted" in a form). | closest to `diagnose.ts`'s `medium`-confidence tier — a claim, not a fact |
| `verified` | Independently corroborated by a second, different signal (e.g., the customer replied confirming the appointment). The strongest tier — rare in practice, never fabricated to make a report look better. | — (stronger than anything the reliability suite currently asserts; new territory, used sparingly) |
| `unverifiable` | Kairos genuinely cannot tell. The honest default for anything ambiguous. | `insufficient_data` — temporary/permanent distinction applies here too (§6.4) |

This table is the single most important design decision in this document to get right, because it is the mechanism that prevents ProofLedger from ever overclaiming "the promise was kept" when the evidence doesn't support it — which is precisely the failure mode that would make Kairos's promise-tracking *worse than useless* (a false "kept" is more dangerous to a business than an honest "we don't know").

### 6.2 Schema

```typescript
export interface ProofLedgerEntry {
  id: string
  contractId: string
  contractVersion: number
  /** One per real-world entity instance -- e.g. one specific referral. Assigned the first time
   * a StartCondition fires for a given correlationKeyValue under this contract. */
  promiseInstanceId: string
  /** The actual extracted correlation key value for this instance (e.g. the real phone
   * number). Hashed at rest by default (§9.4) -- raw value only ever held in memory during
   * the single write, never persisted unhashed unless the contract's evidenceRequirements
   * explicitly whitelists the raw correlation key as needed evidence. */
  correlationKeyValueHash: string

  kind: 'event' | 'evidence'
  /** Present when kind === 'event': which named ProcessEvent this entry claims occurred. */
  eventId?: string
  fromState?: string
  toState?: string

  /** When Kairos itself recorded this entry -- its own clock, always present. */
  observedAt: string
  /** When the event is believed to have actually happened in the real world, if knowably
   * different from observedAt (e.g. a call logged five minutes after it happened). Absent
   * when unknown -- never defaulted to observedAt silently, since that would fabricate
   * precision the evidence doesn't have. */
  occurredAt?: string

  sourceWorkflowId?: string
  /** Binds to n8n's own execution ID -- the same identity ExecutionTrace.executionId already
   * uses (§3.3), so a ProofLedger entry and a drift-check trace for the same real n8n
   * execution can be cross-referenced without a second ID scheme. */
  sourceExecutionId?: string

  status: ProofStatus
  /** Mirrors DriftEvidenceQuality's exact naming and philosophy (§3.2) -- present only when
   * status is 'observed' or 'asserted' (a 'verified' entry is unambiguous by definition; an
   * 'unverifiable' entry has no evidence to grade the quality of). */
  evidenceQuality?: 'specific' | 'generic'

  /** Human-readable, whitelist-safe summary -- e.g. "Call attempted, outcome: no answer."
   * Built ONLY from the contract's own EvidenceRequirement.requiredFields for this
   * transition (§4.3, §9.4) -- structurally incapable of containing anything the contract
   * didn't explicitly whitelist, the same "can't leak because it can't exist in the type"
   * discipline Phase 5's WhitelistedPattern already proved (§3.4, plan doc
   * reliability-suite-plan.md §10.2). */
  detail: string
}
```

### 6.3 Storage

`~/.kairos/promise-ledger/<contractId>.jsonl` — append-only JSONL, `chmod 600`, one file per contract (not one giant file, mirroring `captures/<clientId>/<workflowId>/` and `snapshots/<workflowId>/`'s existing per-scope directory convention rather than inventing a new one). Same write discipline as `reliability-audit.jsonl` (§3.6): best-effort, a ledger-write failure never breaks the compiled workflow's own execution or the calling operation.

### 6.4 A real, load-bearing open design question, named honestly rather than hidden

`insufficient_data` in the drift-check model resolves itself automatically once more executions accumulate. `unverifiable` in ProofLedger may or may not resolve — some evidence gaps are genuinely permanent (Kairos will likely never be able to verify "the customer felt heard"), and some are temporary (a call log that arrives five minutes late). v0 does not attempt to distinguish these two cases automatically; every `unverifiable` entry is treated as potentially permanent until superseded by a later `observed`/`asserted`/`verified` entry for the same transition. This is a real limitation, named here rather than glossed over — see §11.

### 6.5 Applied to the running example

A real referral's timeline in ProofLedger might read: the instance is created in `received` per its `StartCondition` (no event entry needed for this — coming into existence is not itself an observation) → `{kind: 'evidence', eventId: 'call_attempted', status: 'observed', detail: 'Call attempted, outcome: no answer.'}` (twice more, per the 3-attempt exception rule) → if a 4th attempt never comes and 24 business hours pass with no `contacted`/`declined` event, **no new ProofLedger entry is ever fabricated** — the *absence* of an expected entry, evaluated against the SLA (§5.3), is what `checkSlaCompliance()` reports as drifting, exactly the same "absence is itself the evidence" pattern D6 (cadence drift/silent-stop) already uses today.

---

## 7. ExceptionDesk v0

### 7.1 Schema

```typescript
// src/promise/exception-types.ts (proposed)

export type ExceptionKind = 'stuck' | 'missed_sla' | 'ambiguous_evidence' | 'expired'
export type ExceptionStatus = 'open' | 'acknowledged' | 'resolved' | 'expired_unresolved'

export interface ExceptionStatusChange {
  ts: string
  from: ExceptionStatus | null
  to: ExceptionStatus
  /** Mirrors PatternAuditEntry's actor field exactly (§3.8) -- 'auto' is reserved for the
   * detection event that OPENS an item; every other transition in v0 is 'human', since
   * ExceptionDesk v0 has no autonomous resolution mode at all (§9.3). */
  actor: 'auto' | 'human'
  reason?: string
}

export interface ExceptionDeskItem {
  id: string
  contractId: string
  promiseInstanceId: string
  kind: ExceptionKind
  detectedAt: string
  currentState: string
  slaDeadline?: string
  /** Human-readable, e.g. "2.5 business hours overdue" -- computed, not stored as a raw
   * duration a reader would have to do arithmetic on themselves. */
  elapsedVsSla?: string
  /** From the contract's own OwnerAssignment for currentState -- never invented, absent if
   * the contract has no owner mapped to this state. */
  owner?: string
  status: ExceptionStatus
  /** Advisory text only -- seeded from the triggering ExceptionRule.suggestedAction, never
   * auto-executed (§9.3). Same "propose, never apply automatically" posture as
   * repair/propose.ts's own rationale field. */
  nextAction: string
  history: ExceptionStatusChange[]
}
```

### 7.2 Detection → routing → resolution, walked through on the running example

A referral enters `received` at 9:00am Tuesday. `checkSlaCompliance()` (§5.3), running as part of a `kairos watch` tick, evaluates it against the 4-business-hour SLA. At 1:00pm Tuesday (the deadline), if no `contacted`/`declined` ProofLedger entry exists for this instance, the check reports `drifting`, and a new `ExceptionDeskItem` is created: `{kind: 'missed_sla', currentState: 'received', owner: 'intake coordinator', nextAction: 'Call the referral immediately and log the outcome.', status: 'open'}` (auto-opened, per the `actor: 'auto'` allowance in §7.1 — detection is automatic, resolution never is). This surfaces via `kairos exceptions list` (and, if `kairos watch --on-drift` is wired, the existing shell-hook notification path, §3.6, reused unchanged) — a human acts (calls the referral), logs the outcome, which produces a new `observed` ProofLedger entry, which the next `watch` tick sees, closing the SLA violation, at which point a human (not Kairos) marks the `ExceptionDeskItem` `resolved` via `kairos exceptions resolve <id>`.

**No workflow is ever edited, and no autonomous action is ever taken, as a result of this whole sequence.** This is the single most important guardrail in this entire plan (§9.3) — repeated here because it is easy to accidentally violate once ExceptionDesk exists and the temptation to "just auto-retry the call workflow" appears.

### 7.3 Relationship to Phase 3's repair-apply

Deliberately kept separate, not merged. Phase 3's `repair apply` fixes *workflow structure* (a hand-edited node set restored to what Kairos built) — a mechanical, deterministic, narrowly-scoped write. An ExceptionDesk item is about *business process state* (a referral that hasn't been called) — there is no workflow-structure fix for that; the fix is a phone call. Conflating the two would either weaken repair's own tight D9-only scope or produce an ExceptionDesk that pretends it can "repair" something only a human can actually do. They may eventually share plumbing (both could theoretically feed the same notification/escalation surface) but never share the write-path/apply-ladder machinery (§9.3).

---

## 8. Connection to existing Kairos pieces — the compiler's actual wiring, module by module

| Existing piece | Connection |
|---|---|
| **PackBuilder / PackPlan** | `compileToPackPlan()` (§5.1) produces a `PackPlan`, unchanged downstream — `PackBuilder.build()` runs exactly as it does today. No fork, no parallel build path. |
| **Client memory** | One-directional: a contract's key facts (SLA, owner names) are natural candidates to become retrievable `reference`-type `MemoryNode`s (§3.4) so future generation for the same client sees them. Memory is never the contract's storage — `ProcessContract` gets its own store (§4, §8's "Where"). |
| **Reliability suite (drift/replay/chaos/watch/repair)** | `checkSlaCompliance()` (§5.3) is a sibling to `buildDriftCheckReport()`, wired into the same `watch` loop and audit ledger. Chaos/replay integration explicitly deferred (§5.4, §9.6). Repair/rollback are never invoked by anything in this plan (§7.3). |
| **Telemetry/audit** | ProofLedger (§6.3) and ExceptionDesk's status history (§7.1) both reuse the exact append-only-JSONL idiom `reliability-audit.jsonl`/`pattern-audit.jsonl` already established (§3.6) — a fourth instance of a three-times-proven pattern, not a new one. A new `TelemetryEvent` type (`promise_evaluated` or similar, following `RepairCompletedData`'s exact style, §3.6's sibling table in `telemetry/types.ts`) is a natural small addition once Phase 3+ ships, not required for Phase 0. |
| **Delivery Bundle** | `promise-report.md` (§5.6) is a new artifact in the existing `writeBundle()`/`BundleManifest` system (§3.7). |
| **Validator (131 rules)** | Not extended — ProcessContract gets its *own* deterministic validator (§4.4), a sibling to the workflow validator, not a 132nd rule bolted onto it (different object shape entirely). |

---

## 9. Guardrails — what this arc explicitly must not become

The sponsor's own warning ("If designed wrong, Kairos could become overcomplicated fast") is treated as the primary risk this section exists to manage, not a caveat to mention once and move past.

### 9.1 No universal ontology

`EntityDefinition.name`, `ProcessState.name`, `ProcessEvent.name` are free-text, per-contract — never a shared, fixed taxonomy Kairos maintains across clients. This is not a stylistic preference; it is a direct response to a real, previously-identified risk. The external-repo research comparison (`project_kairos_external_research` memory, 2026-07-08) named *"platformization by a thousand registries"* as the single biggest strategic danger a framework-shaped expansion of Kairos could fall into — building a cross-client "referral" or "appointment" ontology is exactly that pattern. Every contract defines its own vocabulary; Kairos never infers or enforces a shared one.

### 9.2 No big dashboard

Reports are files (`promise-report.md`, `kairos exceptions list` CLI output, `kairos ledger show` CLI output) — never a hosted UI, never a service Kairos operates. Matches C5 ("no hosted infra") exactly, the same cross-cutting guardrail that already governs the entire reliability suite.

### 9.3 No autonomous business decisions

Restated as concretely as possible because it is the guardrail most likely to erode under real-world pressure ("just auto-call them again" feels obviously helpful in the moment): **ExceptionDesk v0 has no `--auto` mode at all** — not even the narrow, whitelisted, one-attempt-per-cause `--auto` Phase 3's repair-apply eventually earned after proving itself. An ExceptionDesk item is always opened automatically (detection is mechanical) and always resolved by a human (§7.1's `actor` field). If an autonomous resolution mode is ever justified, it is a distinct, later, separately-approved phase — not assumed here, not designed here, explicitly named as deferred (§9.3, §11).

### 9.4 No hidden PII sharing

Two distinct mechanisms, both required, neither sufficient alone:
1. **Whitelist-by-construction at the schema level** (§4.3, §6.2): `ProofLedgerEntry.detail` can only ever be built from a contract's own `EvidenceRequirement.requiredFields` — there is no code path that dumps a raw payload into a ledger entry, the same "can't leak because it can't exist in the type" property Phase 5's `WhitelistedPattern` already proved (`reliability-suite-plan.md` §10.2).
2. **Correlation keys hashed at rest by default** (§6.2) — the raw value (a real phone number, a real name) exists only transiently during a single write, never persisted unhashed unless a contract's own `EvidenceRequirement` explicitly whitelists it (an unusual, deliberate case, not the default).

A new, enforced module-boundary test — `src/promise/` must never import from `src/reliability/community/` (and vice versa), and `kairos patterns share`'s export path must never be reachable from anything in `src/promise/` — mirroring `tests/unit/reliability/module-boundaries.test.ts`'s exact existing pattern (§3.6's sibling precedent), added in Phase 0 (§10) alongside the schema itself, not bolted on later. Community pattern sharing (Phase 5) exports *validator-rule* patterns; nothing about a real business's real promise instances should ever be reachable from that path, structurally, from day one.

### 9.5 No new hosted execution engine

`compileToPackPlan()` produces workflows that run in the user's own real n8n instance, exactly like every workflow Kairos builds today. Kairos does not become a second orchestration runtime alongside n8n — "runtime for verifiable business promises" (the sponsor's framing) means Kairos *tracks and verifies* promise state, not that Kairos executes business logic itself. The actual state transitions happen because real n8n workflows run and report back (§5.1, §6) — Kairos is the ledger and the compiler, not a second execution engine.

### 9.6 Explicit v0 scope narrowing (named here, detailed in §10/§11)

- One promise per contract (a contract with multiple, independently-tracked promises for the same entity is a real future need, not v0 — the `PromiseStatement` field is deliberately singular).
- One correlation key per contract (multi-key/composite-key entities deferred).
- No cross-entity processes (a promise that spans two different entity types with two different correlation keys — e.g. "referral" and "the resulting appointment" as linked-but-distinct entities — is real and common, and explicitly not v0).
- No chaos/replay scenario generation from contract states (§5.4) until the core loop (contract → compile → ledger → exception desk) is proven.
- No guard-expression DSL for `ProcessTransition.condition`/`PauseRule.condition` — human/LLM-readable text in v0, not a formal boolean language (§9.7 below expands this).

### 9.7 Deferred: formal condition/guard language

`condition`/`suggestedAction`/`trigger` fields throughout §4.3's schema are natural-language text in v0, evaluated by an LLM at compile time (turned into real workflow logic) but never re-evaluated programmatically at runtime by Kairos itself. A real guard-expression language (so Kairos itself, not just the compiled workflow, could evaluate "has this been attempted 3 times") is a genuine, separate piece of engineering, deferred.

### 9.8 Deferred: identity/notification integration

`OwnerAssignment.owner` and `ExceptionRule.owner` are free-text labels in v0 (`"intake coordinator"`), not bound to a real user directory, Slack handle, or notification channel. `kairos exceptions list` is the v0 interface; real owner *notification* (as opposed to a human periodically checking a CLI list) reuses `watch`'s existing `--on-drift`-style shell-hook mechanism (§3.6) rather than a new integration, but that wiring itself is a later phase, not v0.

### 9.9 Deferred: shared/external business-calendar integration

`BusinessCalendarRef` (§4.3) is a small, self-contained, per-contract spec in v0 — not an integration with an external calendar service (Google Calendar, a shared holiday API). A wrong or stale calendar spec produces a wrong SLA deadline; this is named as a real risk (§11), not solved by v0.

---

## 10. Phased implementation plan (planning only — none of this is built yet)

Sequenced and checkpointed the same way the reliability-suite arc was: each phase re-verifies its own assumptions against the actual code at that point (not this document, which will be stale by the time later phases start — the reliability suite's own §6.1/§7.1/§8.0/§10.0 design-verification passes are the model to repeat, not skip).

**Phase 0 — SHIPPED 2026-07-19. Schema + deterministic validator + minimal storage only. No LLM authoring, no compilation, no ledger, no exception desk, no workflow reporting/listener, no dashboard, no autonomous decisions, no hosted service (Codex's guardrail list, restated verbatim as this phase's own scope boundary, and honored throughout — none of those six things exist anywhere in what shipped).**
- Pressure-tested a second, deliberately non-homecare/non-referral example against the schema *before* locking the types (§4.5b) — a real gap found and fixed narrowly (`SlaSpec.recurring`), plus `businessCalendar` made conditionally-required.
- **Two more real, previously-hidden gaps found while actually implementing the validator against real fixtures — neither predicted by the pressure test, both fixed and recorded where found, not folded silently into the earlier sections:**
  - `StartCondition` had no field connecting it to a real starting `ProcessState` at all — the original sketch modeled "start" as an implicit self-loop transition, which the reachability check has no way to treat as a real starting point without guessing at a convention. Added `StartCondition.initialState: string`; removed the now-redundant self-loop from the Empire Homecare example (§4.5) in favor of it.
  - The reachability check's first real run, against the Empire Homecare fixture itself, incorrectly flagged `no_answer` as unreachable — it's only ever entered via `ExpirationRule.expiresTo`, never an explicit `ProcessTransition`, and the check only walked the transitions graph. Fixed by treating expiration edges as real paths in the same reachability search (§4.4 rule 3).
  - Also corrected: rule 5's original wording (`SlaSpec` + `ExceptionRule` + `EvidenceRequirement`) was inaccurate — `ExceptionRule` has no reference field at all (free text only, by design), while `OwnerAssignment.state` and `ExpirationRule.state`/`expiresTo` did need checking and the original list omitted them.
- `src/promise/types.ts` — the final, twice-corrected schema.
- `src/promise/validate.ts` — `validateProcessContract()`, 9 rule numbers (matching §4.4), implemented as narrow pure functions per rule group.
- `src/promise/store.ts` — `saveProcessContract()`/`loadProcessContract()`/`listProcessContracts()`, mirroring `reliability/repair/snapshot.ts`'s own small save/list/load precedent. No versioning/update semantics — a real, deliberate Phase 0 limitation, not an oversight.
- `kairos contract validate <file.json> [--json]` CLI command, wired into `cli.ts` following `handleValidatePack`'s own rendering conventions. `contract plan`/`compile` print a clear "not built yet, Phase 0 only" message instead of a generic unknown-subcommand error.
- Two positive fixtures, both real, type-checked, committed files: `tests/fixtures/contracts/empire-homecare-referral-intake.json` (§4.5) and `saas-p1-incident-response.json` (§4.5b) — both validate clean, proving the schema against two structurally different domains, not just the one it was originally designed around.
- Five negative fixtures, each violating exactly one rule, committed as real files (not just in-test mutations) so `kairos contract validate` has real broken files to reject: `negative-unreachable-state.json` (rule 3), `negative-dangling-transition.json` (rule 1 — and see below, a real finding about this one), `negative-terminal-with-outgoing-transition.json` (rule 4), `negative-no-success-outcome.json` (rule 7), `negative-missing-business-calendar.json` (rule 8).
- **A third real finding, from writing the fixtures' own tests:** `negative-dangling-transition.json` genuinely, correctly cascades beyond rule 1. Empire Homecare's fixture is a strictly linear chain — breaking the one transition connecting `received` to everything downstream doesn't just trip rule 1, it also correctly orphans every state only reachable through that edge (`contact_attempted`, `contacted`, `scheduled`, `declined`, and `no_answer` via the now-unreachable `contact_attempted`'s own expiration rule). Not predicted in advance; found by running the real test against the real fixture. Confirms rule 3 does genuine transitive graph analysis, not a shallow direct-edge check.
- The module-boundary firewall test (`src/promise/` ⟷ `reliability/community/`, bidirectional) shipped in this same phase, not later — the privacy guardrail exists before there's real data to violate it, the identical discipline `module-boundaries.test.ts` itself was built with.
- 44 new tests (33 validator, 8 store, 3 module-boundary), test suite grown from 1597 to 1641. Full suite green throughout, one commit per step (7 commits total for Phase 0).
- **Checkpoint — done, live, real CLI invocations, not just unit tests:** both positive fixtures validate clean via the real `kairos contract validate` binary, in both rendered-text and `--json` modes; all five negative fixtures are rejected with the correct, specific rule and message (including the real cascading case, confirmed live to match the unit test's prediction exactly); every error path (missing file argument, nonexistent file, `contract plan`/`compile`, an unknown subcommand) fails cleanly with a clear message and exit 1; `--help` renders the new command and its guardrail-referencing help text correctly.

**Phase 1 — SHIPPED 2026-07-20. LLM-assisted contract authoring from a raw description.**
- `planProcessContract(input: PlanProcessContractInput, anthropicClient?: AnthropicMessagesClient): Promise<PlanContractResult>` (`src/promise/plan.ts`), mirroring `PackBuilder.plan()`'s shape (§3.1) exactly — one Anthropic call, markdown-fence stripping, `JSON.parse`, light array coercion, and `normalizeAssumptions()` reused verbatim from `pack-builder.ts` (exported specifically for this, zero logic change) for the same safe/needs_confirmation/blocking taxonomy. Unlike `PackBuilder`, there is no separate plan/build split — validation and the blocking-assumption check happen in the same call that drafts the contract, per Codex's own instruction ("run the deterministic validator on the draft... return a review/escalation result rather than pretending it is usable").
- Fields the LLM is never trusted to author: `id`, `version`, `clientId`, `provenance`, `status` — always overwritten by `planProcessContract` even if a response includes its own values (proven directly by a dedicated unit test that feeds the mock model exactly these fields and asserts they're discarded).
- The Anthropic client is injectable (`AnthropicMessagesClient`, a narrow purpose-built interface matching only `messages.create()`), mirroring `apply.ts`'s `runReplayFn` precedent from the reliability suite's Phase 3 — lets tests mock the LLM call entirely rather than needing the real network (blocked in this suite anyway by `no-network-guard.ts`).
- `kairos contract plan "<business description>" --client-id <slug> [--json]` CLI command (`handleContractPlan` in `cli.ts`), mirroring `handleContract`'s existing `validate` rendering style (rule number + message + path) for validator issues, and `build-pack`'s own escalation convention for assumptions (blocking/needs-confirmation bullets) and exit code (2, not 1 — distinguishes "needs a human" from a hard failure). The draft is always saved to `~/.kairos/contracts/<client-id>/<id>.json` via Phase 0's `saveProcessContract()`, and always shown in full, even when it needs review — never withheld, matching the guardrail verbatim.
- 10 new unit tests (`tests/unit/promise/plan.test.ts`) covering: a clean draft marked ready; markdown-fence stripping; Kairos-owned field overwrite even when the model tries to supply its own; contract-id derivation via the same `slugifyWorkflowName` utility `PackBuilder` uses; a structurally invalid draft (dangling transition) correctly flagged `needs_confirmation`/`readyToProceed: false` while still being returned in full; a blocking assumption alone (clean validation) still blocking; a `needs_confirmation`-only assumption *not* blocking; malformed/missing array fields coerced to `[]` instead of crashing; legacy bare-string assumptions normalized the same way `PackBuilder.plan()` does; a missing `name` falling back to `'Untitled Contract'`. Test suite grown 1641 → 1651, full suite green throughout.
- **A real prompt-design flaw caught before any model call, not via a failure:** the first draft of the JSON template embedded instructional text *as the value* of four optional fields (`recurring`, `businessCalendar`, `pauseRules`, `expirationRules`), e.g. `"businessCalendar": "OPTIONAL -- include ONLY if..."` — which would have taught the model the wrong JSON shape by example. Caught on self-review before running anything; fixed by removing those four fields from the template entirely and adding a separate prose paragraph explaining exactly when and how to add each one.
- **Checkpoint — done, live, two real (not mocked) Anthropic calls, not just unit tests.** Ran `planProcessContract()` for real against a plain-language paraphrase of the Empire Homecare promise (not the pre-structured §4.5 JSON — the actual test was whether authoring from a paragraph produces something close to §4.5, which it did) and, separately, a plain-language SaaS P1 incident-response description as the second sanity check:
  - **Empire Homecare:** validated clean (0 validator issues) on the first real model call. The drafted schema — entity `Referral`, `body.referralId` correlation key, 7 states, 14 transitions, two business-hours SLAs (4h first-contact / 24h resolution), an `expirationRules` auto-escalation edge, three-way terminal outcomes (`success`/`acceptable`×2) — is a close, human-judged-reasonable reading of §4.5, produced from a paragraph with no structural hints. `readyToProceed: false` only because of one genuinely reasonable `blocking` assumption (whether the 24h/3-attempt interaction is a hard deadline independent of attempt count, or purely attempt-triggered) — a real ambiguity in the input description, correctly surfaced rather than silently guessed at, exactly the intended behavior.
  - **SaaS P1 incident:** surfaced a genuine, previously-unseen LLM-authoring mistake, live: the model defined `closed_escalation_resolved` as a distinct terminal state/outcome (meant to separately track incidents resolved *after* escalating to secondary on-call) but never wired an actual transition into it from anywhere reachable — every real resolution path merges through `resolved → closed_success` regardless of whether escalation happened. Phase 0's Rule 3 reachability check caught this correctly and immediately (`Rule 3: State "closed_escalation_resolved" is unreachable`), and `planProcessContract` correctly refused to mark the draft `readyToProceed`. This is the single most important confirmation Phase 1 could produce: proof, on real (not synthetic) model output, that "deterministic validation + human review own acceptance" (Codex's own guardrail) actually catches a real mistake rather than being a theoretical safety net that never fires. Two further genuine `blocking` assumptions were also correctly raised (unclear system-of-record for incident creation/correlation key; no expiration rule for an incident that's never resolved).
  - Both full drafts and their `PlanContractResult`s are preserved as scratch files from the checkpoint run (not committed as fixtures — these are ad hoc real-model outputs, not the deterministic Phase 0 fixtures, and would go stale/non-reproducible if committed as if they were).

**Phase 2 — Compilation to `PackPlan` (§5.1), reusing `PackBuilder.build()` unchanged.**
- `compileToPackPlan(contract: ProcessContract): PackPlan`.
- `kairos contract compile <contract.json>` → produces and (optionally) builds a real `WorkflowPackResult` via existing infrastructure.
- **Checkpoint:** compile the Empire Homecare contract, build it against a real disposable sandbox (reusing the reliability suite's own sandbox manager, §3 of `reliability-suite-plan.md` — no new sandbox infrastructure), manually confirm the resulting workflows genuinely implement the contract's states/transitions (this check is manual/human judgment in Phase 2 — automated verification that a compiled workflow correctly implements a contract is real, separate work, not assumed solved here).

**Phase 3 — ProofLedger v0 (§6). The riskiest, most novel phase — flagged honestly, not hidden in the middle of a phase list.**
- `src/promise/ledger.ts`, `src/promise/ledger-types.ts`.
- The genuinely new engineering: compiled workflows need a mechanism to report structured events *back* to Kairos (today, every reliability-suite module only ever *reads* from n8n — nothing existing requires an n8n workflow to proactively call out with business-event data). Candidate approaches to evaluate at this phase's own design-verification step (not decided here): (a) a dedicated webhook endpoint the compiled workflows POST to, requiring Kairos to run a small local/hosted listener (tension with §9.2/§9.5's "no new hosted service" guardrail — needs real resolution, not hand-waved); (b) a polling model where Kairos periodically reads execution data n8n already stores (reuses `fetchLatestTrace()`'s existing pattern, §3 of the reliability suite, no new listener, but coarser-grained and possibly missing evidence n8n itself doesn't retain); (c) a hybrid. **This design choice is explicitly not made in this document** — it is Phase 3's own first task, done with the same rigor as every other phase's design-verification pass, because getting it wrong is expensive to unwind later.
- `kairos ledger show <contract-id> <instance-id> [--json]`.
- **Checkpoint:** run the compiled Empire Homecare workflows against a real sandbox with synthetic referral events end to end; confirm ProofLedger correctly records `observed`/`asserted`/`unverifiable` status per event, and confirm an absent expected event produces no fabricated entry (§6.5).

**Phase 4 — SLA compliance monitor + ExceptionDesk v0 (§5.3, §7).**
- `checkSlaCompliance()`, `buildPromiseComplianceReport()`, wired into `kairos watch`.
- `src/promise/exception-types.ts`, `src/promise/exception-desk.ts`.
- `kairos exceptions list/ack/resolve`.
- **Checkpoint:** induce a real SLA violation (a synthetic referral with no contact-attempt evidence past the deadline) against the sandbox; confirm it surfaces as an `ExceptionDeskItem` with the correct owner/`nextAction`; separately confirm a compliant instance never false-positives (the exact same "prove the negative case too" discipline every drift check shipped with, §1's D1-D9 precedent).

**Phase 5 — Reports.**
- `promise-report.md` artifact (§5.6), `writeBundle()` integration.
- **Checkpoint:** generate a real report from a realistic mix of kept/acceptable/failed/still-open instances; confirm the DISCLAIMER language is honest when evidence quality is mostly `unverifiable` or `asserted` rather than `observed`/`verified` — the report must never imply more certainty than the underlying ledger actually supports.

**Explicitly not phased at all yet (§9.6, §11):** replay/chaos promise-instance scenario generation; cross-entity/multi-correlation-key contracts; ExceptionDesk autonomous resolution; a formal guard-expression language; real identity/notification integration; external business-calendar integration; multi-tenant contract libraries.

---

## 11. Risks and honest unknowns

- **Evidence-quality ceiling.** Many real promises are partially or fully unverifiable from workflow execution data alone ("the customer felt heard" has no structural signal at all). `unverifiable` will likely be the *modal* status for a meaningful fraction of real contracts, especially early. This is honest, not a bug — but it means promise-report.md's value proposition for a real client needs to be pitched carefully: "here's what we can actually prove, and here's what we genuinely can't tell," not "here's whether the promise was kept."
- **Schema over-fit to one example.** Designing every field in §4.3 against a single (Empire Homecare) example risks a schema that's secretly narrower than it looks. Before Phase 0 ships, a second, structurally *different* example should be sketched (not built) as a design sanity check — e.g. a contract with no SLA at all, or an entity that can have multiple simultaneous open instances that interact (explicitly the kind of case §9.6 defers, but the schema should at least be checked against it conceptually before Phase 0 locks the types in).
- **Scope creep into a general BPM platform.** The single biggest named danger (§9.1), worth restating as a risk, not just a guardrail: every phase boundary in §10 is a real stopping point, the same discipline that kept the reliability suite from sprawling across six phases. A ProcessContract that quietly grows a visual editor, a shared ontology, or a notification service because "it would obviously be useful" is the failure mode this whole document exists to prevent.
- **LLM-authored contracts can be wrong in a new, higher-stakes way.** A wrong *workflow* (today's failure mode) breaks one automation. A wrong *process model* (an SLA that doesn't match the real business, a "terminal" outcome that isn't actually terminal) could make Kairos confidently report a promise as kept when the business's real commitment was different — a more consequential failure than a broken workflow, because it's a false statement about the business itself, not just a technical malfunction. Mitigated by the assumptions/blocking-escalation pattern (§4.3, reused from PackPlan) and by Phase 0's validator, but this is a new class of risk worth naming explicitly, not assumed away by reusing an existing pattern.
- **The Phase 3 "how does a workflow report back to Kairos" question is the single largest unresolved technical risk in this plan.** Named explicitly in §10's Phase 3 description rather than glossed over: every existing reliability-suite module only ever reads from n8n. Getting compiled workflows to proactively report structured business events is new, and the three candidate approaches sketched in §10 have a real tension with the "no new hosted service" guardrail (§9.2, §9.5) that Phase 3 must resolve concretely, not hand-wave.
- **Business-calendar correctness is a silent-failure risk.** A wrong timezone or a missed holiday in `BusinessCalendarRef` produces a wrong SLA deadline that looks perfectly normal in the UI/reports — no error, no exception, just a quietly incorrect number. Worth a dedicated correctness check when Phase 0's validator ships (structural validation only catches malformed calendars, not wrong-but-well-formed ones), named here so it isn't forgotten by the time Phase 0 is actually implemented.

---

## 12. Outcomes — what "done" looks like for v0

When Phases 0-5 ship (each with its own real checkpoint, matching the reliability suite's own definition-of-done discipline: design-verification pass → build → tests → live checkpoint → plan doc updated with real findings → one commit per logical piece):

Kairos can take a plain-language business promise, turn it into a structured, versioned, human-reviewable `ProcessContract`; compile that contract into real, deployed n8n workflows using its existing generation and validation infrastructure unchanged; observe those workflows' real executions and honestly grade what it can and can't prove about whether the promise was kept, instance by instance; surface the promises that are stuck, missed, or ambiguous to the right human with a clear next action, never resolving anything autonomously; and produce a client-facing report that says, plainly, how many promises were kept, how many weren't, and how much of that judgment Kairos can actually stand behind.

That is the difference between "did the workflow behave" and "was the business promise kept" — built as a layer on top of six already-proven subsystems, not a rewrite of any of them, with every genuinely new and risky piece (§11) named honestly rather than discovered later.

**This document is the entire deliverable for this pass. No code exists yet for any part of it.**
