# Kairos Process Contract / Promise Engine — Implementation Plan (v0)

**Date:** 2026-07-19 (written same day as the reliability-suite arc's closeout review, in the same session — see `docs/plans/reliability-suite-plan.md` for that arc's full history and the standing conventions this plan inherits).

**Status: ALL PHASES SHIPPED. Phase 0 SHIPPED 2026-07-19 (schema + deterministic validator + minimal storage). Phase 1 SHIPPED 2026-07-20 (LLM-assisted authoring + CLI + real-model checkpoint). Phase 2 SHIPPED 2026-07-20 (deterministic PackPlan compiler + CLI + real build-pipeline checkpoint). Phase 3 SHIPPED 2026-07-20 (design-verification spike + both required prerequisites + ProofLedger v0 implementation + CLI + real live-account checkpoint). Phase 4 SHIPPED 2026-07-20 (business-calendar arithmetic + SLA compliance monitor + ExceptionDesk v0 + CLI + `kairos watch --contracts` + real live-account checkpoint). Phase 5 SHIPPED 2026-07-20 (Promise Report v0 + CLI + a real, previously-unknown getKairosVersion() dist-bundle bug found and fixed along the way). Promise Engine v0's full loop -- contract → compile → workflows → ledger → SLA monitor → exceptions → report -- is real, not aspirational; every arrow has shipped code and a real checkpoint behind it.** Per Codex's explicit approvals: Phase 0 — *"Plan reviewed. Direction approved. Start Phase 0 only... Do not implement Phase 1-5 yet."* Phase 1 — *"Phase 0 accepted. Start Phase 1 only: LLM-assisted ProcessContract authoring... Please take your time and do one step at a time."* Phase 2 — *"Phase 1 accepted. Start Phase 2 only: compile ProcessContract to PackPlan... Phase 2 should not try to prove the workflows fulfill the contract yet. It should only produce a better PackPlan from the contract. Proof comes later with ProofLedger."* Phase 3 spike — *"Phase 2 accepted. Start Phase 3, but begin with a design-verification spike only before implementation... Do not implement ProofLedger yet until this spike writes down the decision."* Phase 3 implementation — *"Phase 3 design spike accepted. Proceed with ProofLedger v0 implementation, but only after handling the two prerequisites in the design."* Phase 4 — *"Phase 3 accepted. Start Phase 4 only: SLA compliance monitor + ExceptionDesk v0... This is where Kairos starts saying whether a promise is at risk/missed and opening exceptions, so keep it conservative... handle business calendars carefully. If calendar logic is nontrivial, start with simple documented rules and avoid overclaiming precision."* Phase 5 — *"Promise reporting is the right next phase. This turns the Promise Engine into something client-facing... Phase 4 accepted. Start Phase 5 only: promise-report.md Delivery Bundle artifact... After Phase 5, the Promise Engine v0 arc has a full loop: contract → compile → workflows → ledger → SLA monitor → exceptions → report. That's the thing we wanted."* Phase 0's own scope was pressure-tested against a second, deliberately different example before any type was locked in (§4.5b), and two more real, previously-hidden gaps (`StartCondition.initialState`; `ExpirationRule` edges missing from the reachability check) were found while actually implementing the validator against real fixtures, not while designing it on paper — both fixed and recorded where they were found, not folded silently into the original text. Phase 1's real-model checkpoint caught a genuine LLM-authoring mistake live (an unreachable terminal state in the SaaS draft) — direct, unstaged proof that the validator+escalation gate does its job on real model output, not just synthetic tests. Phase 2's compiler is deterministic (a real judgment call made during implementation, recorded in §10's Phase 2 entry) and its real checkpoint ran the compiled Empire Homecare plan through the actual, unmodified `Kairos.build()` pipeline end to end — all 3 workflows generated cleanly on the first attempt. Phase 3's spike verified the polling decision against **real production execution data** on Jordan's own n8n.cloud instance (read-only only), confirming n8n's Executions API returns full per-node field-level data via `includeData=true` — the load-bearing technical fact the whole decision rests on. Phase 3's implementation then solved both prerequisites Codex required before authorizing it — an evidence-node naming convention (`evidenceNodeName()`, confirmed against a real generation call to actually appear in a real compiled workflow) and a multi-execution poll watermark (`ContractPollWatermark`, confirmed live to prevent reprocessing) — and its own checkpoint ran the real poller against real, live n8n execution data on Jordan's account (read-only only) end to end. Phase 4's business-calendar arithmetic is deliberately simple (minute-granularity, `Intl.DateTimeFormat`-based, `business_days` a named simplification, not calendar-date counting) per Codex's own caution against overclaiming precision, and its real checkpoint ran a live `kairos watch --contracts` tick against Jordan's real n8n account end to end — correctly computed 9.02 real business hours elapsed, correctly opened a real `ExceptionDeskItem` with the correct owner/nextAction pulled directly from the contract, and correctly kept a human-resolved item resolved on a second live tick despite the underlying SLA still reading `DRIFTING`. Phase 5's `classifyPromiseInstance()` rolls up per-instance ProofLedger evidence into five honest states (not the four originally requested -- `in_progress` was a real gap found while building it), reuses `sla-compliance.ts`'s own `stateReachSignals()` directly rather than a second copy of terminal-state-reachability logic, and structurally enforces "never count unverifiable as kept" (a terminal state reached only via indirect evidence is a separate branch, not a lower-confidence flavor of "kept"). Its own real checkpoint, run purely locally (no network calls at all, unlike every earlier phase's checkpoint) against a realistic 5-instance mixed scenario, correctly classified 4 of 5 rollup states -- including correctly *overriding* a stale open exception to `missed` once the ledger evidence itself proved the SLA had genuinely broken, rather than just trusting the exception's own recorded status -- and, along the way, found a real, previously-unknown bug pre-dating this whole arc: `getKairosVersion()` silently reported `'unknown'` when the built `dist/cli.cjs` artifact was invoked directly (tsup's CJS build shims `import.meta` to `{}`). The arc's own closeout `npm pack` + fresh-install check then precisely re-scoped it: the actual published CLI (`bin.kairos` → the ESM `dist/cli.js`) was never affected, confirmed by generating a real report through the real installed binary; the real, narrower reach is CJS `require()` library consumers and direct `dist/cli.cjs` invocation, not every `kairos pack export --bundle` CLI run as first (incorrectly) recorded. See §10's Phase 0 through Phase 5 entries, §6.0, §7.1, and §5.6, for the full build/spike records. **A dedicated P0 measurement-integrity audit (2026-07-20, pre-publish, after the closeout above) then asked a sharper question than "does it work": "how could this confidently report the wrong business outcome?" — found six real, distinct ways it could, all six fixed in one scoped pass before any version bump. See §14 for the full audit and fix record. A supplemental audit of currently-shipped code (not future/deferred items) then found a release-blocking client-isolation gap in ProofLedger/ExceptionDesk storage (Finding 1) — fixed the same session; two further findings (2 and 3) were named but deliberately left unfixed pending reassessment. See §15. Findings 2 (registration silently dropped previously-tracked workflows on a partial rebuild) and 3 (correlation-key reuse merging a new instance into an old closed one) were then reassessed and both fixed, same session, before live validation — see §16. **A live release-validation pass then ran against real n8n/Anthropic infrastructure using a disposable test contract — every checklist item verified except a fresh webhook-triggered execution (blocked by an n8n.cloud API-activation limitation, not a code defect); no code changed. 7 disposable n8n workflow ids remain in the real account pending an explicit disposal decision. See §17.**

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

### 5.3 → Monitors (SHIPPED 2026-07-20)

`checkSlaCompliance()` (`src/promise/sla-compliance.ts`), styled identically to `src/reliability/drift/checks.ts`'s existing D1-D9 functions: pure, evidence-driven, returning the same `insufficient_data`/`not_applicable`/`healthy`/`drifting` shape (§3.2) — here meaning: not enough ProofLedger evidence yet to evaluate / this instance's SLA doesn't apply (e.g., already exited that state) / within deadline / past deadline with no qualifying evidence. `buildPromiseComplianceReport()` sits alongside (not merged into) `buildDriftCheckReport()` — a promise-compliance check is conceptually parallel to a drift check, not a tenth drift check, since it operates over promise instances, not workflow execution history.

**Two real deviations from this section's original sketch, made during implementation and named honestly, not silently reconciled:** (1) wired into `kairos watch` via a new, separate `--contracts` flag in `cli.ts`, not into `src/reliability/watch/loop.ts`'s own tick function -- keeping `loop.ts` (already shipped, already heavily tested, drift-specific) completely untouched was a deliberate risk-reduction choice, matching Codex's own "keep it conservative" instruction for this phase; the two check types run side by side in one watch loop rather than one merged loop. (2) compliance ticks are not written to `reliability-audit.jsonl` -- ExceptionDeskItem's own persistent `history` array already serves the equivalent "what happened and why, over time" record for anything that actually became an exception; a lighter per-tick audit entry for ticks that found nothing new would be a reasonable future addition but wasn't built here, since nothing in Codex's actual Phase 4 scope message required it.

### 5.4 → Replay/chaos scenarios

**Explicitly scoped OUT of v0** (§9.6, §10's phase table, §11 risks). A ProcessContract's states/events are a real, valuable future source of new chaos payload classes ("customer replies with an ambiguous message," "duplicate intake for the same correlation key," "SLA deadline passes with zero evidence") — but this is genuinely new engineering on top of `src/reliability/chaos/payloads.ts`'s existing enumeration, not a straightforward reuse the way §5.1-§5.3 are. Named here so the connection is documented and not forgotten, deferred to a phase after v0's core loop (ProcessContract → compile → ProofLedger → ExceptionDesk) is proven.

### 5.5 → Exception routing

ExceptionDesk itself — §7.

### 5.6 → Reports (SHIPPED 2026-07-20)

`promise-report.md` (`src/promise/report.ts`/`report-bundle.ts`), a client-facing artifact aggregating ProofLedger + ExceptionDesk data for a contract over a time window. **One real deviation from this section's original sketch, made during implementation and named honestly:** written by a new, standalone `writePromiseReport()` reusing `pack-bundle.ts`'s own artifact/manifest *pattern* (a manifest.json recording exactly what was written, when, with what provenance), not `writeBundle()`/`BundleManifest` themselves -- a ProcessContract's report has no dependency on a saved `WorkflowPackResult` existing at all (most contracts in this arc's own checkpoints were compiled `--dry-run`, never producing one), so extending `writeBundle()`'s pack-specific signature would either require one to exist or bolt on an awkward optional cross-reference. Exposed as `kairos contract report`, its own contract subcommand, not folded into `kairos pack export --bundle`'s flag surface.

Counts five states, not the four originally sketched (kept/at-risk/missed/unverifiable): `classifyPromiseInstance()` found a real gap while being built -- an instance with no terminal outcome, no drifting SLA/expiration finding, and no open exception is genuinely "still active, nothing wrong yet," which honestly fits none of the original four. Misclassifying every in-flight instance into one of them would be less honest than naming the real fifth case (`in_progress`), so it is counted and reported separately, not folded silently into any of the requested four. **Carries the same mandatory DISCLAIMER discipline already established for `test-payloads.json`/`contract.openapi.json`** (§3.7): a real, always-computed disclaimer (never omitted just because the numbers look clean) whenever a meaningful share of instances are `unverifiable`/`in_progress`, or when a classification relied on indirect (generic-confidence) evidence, or when the window has no evidence at all. A terminal state reached only through indirect evidence is classified `unverifiable`, a structurally separate branch from `kept` -- "never count unverifiable as kept" is enforced by the branch structure itself, not just a comment.

---

## 6. ProofLedger v0

### 6.0 Phase 3 design-verification spike (2026-07-20) — how does evidence get from a compiled workflow back to Kairos

**Scope of this spike, per Codex's explicit instruction:** *"Do not jump straight into building the ledger/writeback system without a small design spike first... Do not implement ProofLedger yet until this spike writes down the decision."* Nothing in `src/promise/` changed as a result of this spike — no `ledger.ts`, no `ledger-types.ts`. This section records the comparison, the real evidence gathered against it, and the decision, so implementation (a separate, later go-ahead) starts from a verified foundation rather than an assumption.

**Method:** rather than reasoning about n8n's API from memory or documentation, this spike re-used Jordan's real, live n8n.cloud instance (the one already configured in `N8N_BASE_URL`/`N8N_API_KEY`, distinct from the disposable Docker sandbox used by chaos/replay checkpoints, which was not available in this environment) to inspect **real production execution data** — read-only (`GET /workflows`, `GET /executions`, `GET /executions/:id?includeData=true`) only; nothing was created, triggered, modified, or deployed on that account for this spike. This directly follows the same discipline every prior phase in this arc has used: verify by building/checking against something real, not just by design review.

**Finding 1 (the load-bearing one): n8n's real Executions API returns full per-node field-level data, not just structure — confirmed against a real execution, not assumed.** Fetching a real, live Empire Homecare execution (`GET /executions/1527?includeData=true`, the "Empire Homecare - Weekly Google Business Post" workflow) returned, per node, exactly the real field names each node actually produced — e.g. the "Pick Weekly Topic" node's output carried `topic`/`weekNumber`; the "Generate Post with Claude" node's carried `model`/`content`/`usage`; the trigger node carried full `timestamp`/`Readable date`/`Day of week`/etc. The shape is `data.resultData.runData[nodeName][runIndex].data.main[branchIndex][itemIndex].json[fieldName]` — real key-value pairs, not the item-count-only summary `src/telemetry/execution-tracer.ts`'s `parseExecutionTrace()` deliberately extracts today (see Finding 3). This confirms the core technical premise of a polling design: **the data ProofLedger needs already exists in every execution n8n records; nothing new has to be added to a compiled workflow to make it retrievable.**

**Finding 2: this exact API already burned Kairos once, and the fix is directly relevant here.** `src/providers/n8n/api-client.ts`'s `getExecution()` (lines 169-187) carries a comment recording a real, previously-shipped bug: n8n's API silently omits the `data` field entirely unless `?includeData=true` is passed explicitly — found via a live checkpoint in the reliability-suite arc, not caught by any type check (`ExecutionDetail.data` was typed as if always present). Every poll-based evidence extraction in Phase 3 must explicitly request `includeData: true` (already the client's default, but worth restating as a concrete implementation requirement, not an assumption) — this is not a hypothetical risk, it is a bug this exact codebase already shipped and fixed once.

**Finding 3: reading real field VALUES (not just counts) is a genuinely new capability for this codebase, which is precisely why the whitelist guardrail matters.** `execution-tracer.ts`'s `parseExecutionTrace()` — the only code today that reads inside `data.resultData.runData` — deliberately stops at counting items ("Count items from the main output path (privacy-safe: count only, not values)"). The real execution inspected in Finding 1 makes concrete *why* that line was written: a real node's output can carry an entire Claude-generated post body, full API response metadata, or a customer's raw contact info. Reading indiscriminately would be a real privacy problem, not a theoretical one. `EvidenceRequirement.requiredFields` (already in the Phase 0 schema, `src/promise/types.ts`) is the correct, already-existing mechanism to keep this narrow: for a given node, read *only* the named fields the contract explicitly whitelists, nothing else, ever — "can't leak because it can't exist in the type," the same discipline Phase 5's `WhitelistedPattern` already proved (§3.4).

**Finding 4: `--scrub`'s own documented limits are the argument for whitelist-only, not broad-capture-plus-redaction.** `src/reliability/replay/capture.ts`'s `--scrub` flag explicitly documents itself as best-effort — secret-*shaped* pattern matching only, and says plainly it will not catch a customer's name or phone number (lines 24-27). This is directly relevant: if broad-payload capture were the design, "redact it after the fact" is not a real privacy guarantee in this codebase today, confirmed by its own existing honesty about the same problem elsewhere. Reading only pre-declared, per-contract whitelisted fields (Finding 3) avoids ever needing that guarantee in the first place.

**Finding 5: polling is not a new pattern for this codebase — it is the pattern, used four times already.** `execution-tracer.ts` (`fetchLatestTrace`), `replay/capture.ts`, `replay/runner.ts`, and `watch/loop.ts` all already read n8n execution data exclusively via `N8nApiClient.getExecutions()`/`getExecution()` — the same two methods this spike used directly. A poll-based ProofLedger extends an already-proven, already-tested integration surface. A webhook/listener approach would be the *first* inbound-facing component in Kairos's history — no existing precedent for hosting it, authenticating it, or testing it.

**Finding 6 (a real gap, not solved by this spike): node-level traceability from a contract element to a real generated node is not yet possible, and needs a naming convention, not a heuristic.** Phase 2's `compileToPackPlan()` tells the generator, in prose, which fields to log for which transition (`src/promise/compile.ts`'s `buildProcessingWorkflow()`) — but nothing constrains what the LLM-authored codegen actually *names* the resulting node, and `PackWorkflowResult` (`src/pack/pack-builder.ts`) does not retain the generated workflow JSON once building completes (only `workflowId`/`deployed`/etc.) — the full node list is only ever recoverable by calling `getWorkflow(id)` back against n8n directly. A poll-based ProofLedger reading "the field named `callOutcome` on *some* node" has no reliable way to know which node that is without one of: (a) a required, predictable node-naming convention enforced at generation time (e.g., the generation prompt requiring a node literally named `Evidence: t-attempted-to-contacted` wherever an `EvidenceRequirement` applies), or (b) fragile heuristic matching against `EvidenceRequirement.requiredFields`' names post-hoc. This spike recommends (a), named here as a real, concrete prerequisite for Phase 3 implementation, not assumed solved.

**Finding 7 (a real gap): a "latest execution only" fetch is insufficient for ProofLedger's correctness needs, unlike drift detection's.** `watch/loop.ts`'s existing tick loop calls `fetchLatestTrace()` (`getExecutions(id, {limit: 1})`) — sufficient for drift detection, which only needs to know the workflow's *current* health. ProofLedger needs every qualifying execution between polls (e.g., all three of Empire Homecare's contact attempts, not just the most recent) — missing any of them produces a false `unverifiable` for an event that genuinely happened, exactly the dishonest-degradation failure mode this whole arc's guardrails exist to prevent. A ProofLedger poller needs its own fetch (`getExecutions(id, {limit: N})`, N meaningfully greater than 1) plus a per-contract "last processed execution id/timestamp" watermark to avoid gaps or reprocessing — a genuinely new mechanism, not a direct reuse of `fetchLatestTrace` as written today.

**Finding 8: webhook-triggered production executions could not be directly inspected — none exist yet in the real account checked.** Every webhook-triggered workflow found (`Webhook POST — Return {status: ok}`, `AI-Powered Support Ticket Router`, `Empire Homecare - New Customer Welcome Sequence`, others) had zero recorded executions. This spike could not empirically re-confirm that a webhook trigger node's own output `json` carries `body`/`headers`/`query` the same way the schedule-triggered example (Finding 1) carried its own node's fields — this is extremely well-established, standard n8n platform behavior (not a Kairos-specific claim), so it is treated as a reasonable, low-risk assumption rather than a verified finding, and named explicitly as the one piece of this spike not backed by a live example.

**Comparison, against Codex's exact evaluation criteria:**

| Criterion | 1. Poll execution data | 2. Kairos-local webhook/listener | 3. Hybrid | 4. Simpler n8n-native option |
|---|---|---|---|---|
| Reliability | High — n8n persists execution history; a missed poll cycle catches up next time (Finding 7's watermark). | Lower for v0 — evidence is lost if the listener is unreachable when a workflow POSTs, unless every generated workflow adds its own retry logic (new generation-time requirement). | Inherits webhook's fragility for the "push" half. | N/A — no such option found (see below). |
| Privacy/PII posture | Read-only pull of exactly what's already recorded; whitelist-by-contract (Finding 3) keeps extraction narrow regardless of how much n8n stores. | Same whitelist discipline could apply, but adds a second attack surface (an exposed endpoint receiving business data) that pure polling never creates. | Same added surface as webhook. | N/A |
| Local-only vs. hosted | Zero new infrastructure — reuses the exact `N8N_BASE_URL`/`N8N_API_KEY` every other command already requires (Finding 5). | Requires an always-reachable process — direct tension with the "no new hosted service" guardrail (§9.2/§9.5) Codex has restated twice now (once in Phase 0's approval, again in this message). | Requires the listener half regardless. | N/A |
| Compatibility with sandbox/replay | Directly reuses the same `getExecutions`/`getExecution` calls chaos/replay already use (Finding 5) — natural to gate on "only poll workflows explicitly registered against a contract," so ephemeral sandbox executions are never mistaken for real evidence. | Would need the sandbox's disposable workflows to also carry the callback node, and a running listener during every sandbox test — meaningfully more sandbox setup. | Inherits webhook's added sandbox burden. | N/A |
| How it works for real deployed workflows | Confirmed directly, live (Finding 1) — no changes needed to a workflow beyond what Phase 2 already generates, modulo Finding 6's naming convention. | Requires adding a new outbound HTTP Request node to every generated workflow, plus auth/secret management for it — new generation-time surface Phase 2 doesn't have today. | Same addition as webhook. | N/A |
| Contract traceability | Needs Finding 6's naming convention either way — this is orthogonal to poll vs. push, not solved by choosing webhook instead. | Same open item. | Same open item. | N/A |
| Operator setup burden | None beyond what's already required (n8n API credentials Kairos already needs for every command). | A new service to run, expose, and keep alive — real, ongoing operator burden for something framed as a CLI tool, not a platform. | Same as webhook. | N/A |
| Failure modes | Transient poll failure → `insufficient_data`-equivalent this cycle, recovers next cycle; never fabricates or silently drops evidence n8n still has. | Listener down at POST time → that evidence is gone unless the workflow itself retries; a crashed workflow execution before reaching the callback node never reports at all. | Same failure mode for the push half. | N/A |
| Testability | Reuses the exact mocked-`N8nApiClient` test pattern already proven across `replay/capture.test.ts`, `watch/loop.test.ts`, etc. — no new test infrastructure. | Requires standing up (or heavily mocking) an actual HTTP server in tests — new test infrastructure for v0. | Same new infrastructure needed for the push half. | N/A |

**Option 4 (n8n execution metadata, simpler than either) was genuinely considered and found not to be a separate option — it *is* option 1.** There is no lighter-weight n8n-native mechanism than the Executions API itself; `getExecutions()`/`getExecution({includeData: true})` (Finding 1) already is the simplest path available. n8n's execution-list webhooks/subscriptions were also considered but amount to the *push* model (option 2) wearing n8n's UI instead of Kairos's own — same hosted-listener requirement, same guardrail tension, not actually simpler.

**Decision: polling/extraction from n8n execution data, matching Jordan's stated leaning, now empirically verified rather than assumed.** For ProofLedger v0: no new hosted service, no new listener, no new node added to compiled workflows beyond Finding 6's naming convention. A poller (new code, not built in this spike) will `getExecutions(workflowId, {limit: N})` for each n8n workflow explicitly registered against a `ProcessContract` (closing Finding 6's node-traceability gap and Phase 2's own unpersisted-mapping gap — recording `n8nWorkflowId → {contractId, ContractWorkflowTrace}` durably is now a confirmed Phase 3 prerequisite, not optional), read only the fields named in the matching `EvidenceRequirement.requiredFields` from nodes matching the naming convention, hash the extracted correlation key (§9.4, reusing `src/utils/workflow-hash.ts`'s existing `createHash('sha256')` pattern — no new hashing mechanism needed), and append `observed`/`unverifiable`-status `ProofLedgerEntry` rows (§6.2, unchanged by this spike) to the same append-only-JSONL idiom `reliability/watch/audit.ts` already proves out (§6.3, also unchanged). The natural home for the poll loop is a sibling to `runWatchTick()` (`reliability/watch/loop.ts`) — reusing its existing tick/audit/best-effort-failure conventions — wired into `kairos watch` per the original plan (§5.3), not a new standalone always-on process.

**Explicitly not decided by this spike, left for Phase 3's own first implementation task:** the exact node-naming convention's syntax (Finding 6); where the `n8nWorkflowId → contract` registration happens (a new `kairos contract compile --build` side effect, vs. a separate `kairos contract register` command); the exact poll cadence and watermark storage shape (Finding 7).

---

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

### 7.1 Schema (SHIPPED 2026-07-20 -- evolved from the original sketch below, both by Codex's own newer explicit field list and by implementation; original kept struck through for the historical record, not silently rewritten)

**As shipped (`src/promise/exception-types.ts`):**

```typescript
export type ExceptionKind = 'stuck' | 'missed_sla' | 'ambiguous_evidence' | 'expired'
export type ExceptionStatus = 'open' | 'acknowledged' | 'resolved' // no 'expired_unresolved' -- see below

export interface ExceptionStatusChange {
  ts: string
  from: ExceptionStatus | null
  to: ExceptionStatus
  actor: 'auto' | 'human' // 'auto' only for the opening event -- everything else is human, always
  reason?: string
}

export interface ExceptionDeskItem {
  id: string
  contractId: string
  promiseInstanceId: string // the hashed correlation key -- Codex's explicit requirement
  kind: ExceptionKind
  status: ExceptionStatus
  owner: string             // direct OwnerAssignment lookup, never invented, never optional --
                             // an honest "(no owner declared for this state)" string instead
  nextAction: string
  reason: string             // NEW vs. the original sketch -- Codex: "Include ... reason ..."
  evidence: string[]         // NEW -- Codex: "Include ... evidence ..."
  slaId?: string              // NEW -- Codex: "Include ... SLA/transition id ..."
  expirationRuleId?: string   // NEW
  transitionId?: string       // NEW
  detectedAt: string
  updatedAt: string
  history: ExceptionStatusChange[]
}
```

**What changed from the original sketch, and why:** `reason`/`evidence`/`slaId`/`expirationRuleId`/`transitionId` are additions Codex asked for explicitly in the Phase 4 scope message, not present in the original design. `detectedAt`/`currentState`/`slaDeadline`/`elapsedVsSla` from the original sketch were folded into `reason` (a single human-readable narrative, e.g. "SLA X missed: N business_hours have passed...") plus the structured `evidence` array, rather than kept as four separate, overlapping derived fields -- one honest narrative plus its structured backing, not several partial views of the same fact. `ExceptionStatus` dropped `expired_unresolved`: v0's lifecycle is deliberately just `open`/`acknowledged`/`resolved`, matching Codex's "no auto-resolution" guardrail literally -- an *automatic* transition into `expired_unresolved` would itself be a form of autonomous status change, the exact thing this whole module exists to avoid.

**Original sketch, for the historical record:**

```typescript
// src/promise/exception-types.ts (proposed, 2026-07-19 -- superseded by the schema above)

export interface ExceptionDeskItem {
  id: string
  contractId: string
  promiseInstanceId: string
  kind: ExceptionKind
  detectedAt: string
  currentState: string
  slaDeadline?: string
  elapsedVsSla?: string
  owner?: string
  status: ExceptionStatus
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

**Phase 2 — SHIPPED 2026-07-20. Compilation to `PackPlan` (§5.1), reusing `PackBuilder.build()` unchanged.**
- `compileToPackPlan(contract: ProcessContract): CompileToPackPlanResult` (`src/promise/compile.ts`), where `CompileToPackPlanResult = { plan: PackPlan, traceability: ContractWorkflowTrace[], escalation?: CompileEscalationInfo }`.
- **A real design decision made during implementation, not settled by this document:** deterministic, not LLM-based. §5.1's original wording ("the resulting `PackPlan.workflows[]` build descriptions are still generated exactly the way they are today, through `Kairos.build()`") was genuinely ambiguous on a re-read at implementation time — it could be read as "compileToPackPlan() itself still calls an LLM, just with a tighter prompt" or as "compileToPackPlan() is deterministic; the LLM call this sentence refers to is Kairos.build()'s own unavoidable per-workflow n8n-JSON generation step, which this phase doesn't touch." Resolved in favor of the second reading, for reasons stronger than just picking one: (1) "compiler" is the framing this whole arc has used since Codex's first message — a deterministic mechanical translation is the literal embodiment of that, whereas a second LLM authoring pass would just be another planning call under a new name; (2) it avoids reintroducing, one layer downstream, the exact "LLM-authored contracts can be wrong in a new, higher-stakes way" risk §11 already names for contract authoring itself; (3) it makes traceability (an explicit Phase 2 scope item) exact and mechanical rather than an LLM's paraphrase of the contract. No Anthropic call happens anywhere in `compile.ts`.
- Derives up to three `WorkflowPlan`s per contract, each with a `ContractWorkflowTrace` citing the exact contract element ids it came from: one per `StartCondition` (intake — trigger, correlation key, initial state), one aggregate workflow covering every `ProcessTransition` and `EvidenceRequirement` (processing + outcome logging), and one covering every `SlaSpec`/`ExpirationRule`/`ExceptionRule`/`BusinessCalendarRef`/`PauseRule` (SLA escalation) — omitted entirely when a contract has neither `sla` nor `expirationRules`. `PackPlan`'s own shape is completely untouched (no new fields) so `PackBuilder.build()` consumes it exactly as it always has; traceability is a separate, additive structure returned alongside the plan, not bolted onto `WorkflowPlan`.
- Refuses to compile (returns `plan.workflows: []` plus an `escalation` mirroring `PackBuilder.build()`'s own blocked-early-return shape) when the contract fails Phase 0's validator (`source: 'validation_errors'`) or still has a `blocking`-type assumption (`source: 'blocking_assumptions'`) — validation errors take priority when both are present, since structural correctness is checked before business-completeness. No generation spend either way.
- `kairos contract compile <file.json> [--build] [--dry-run] [--activate] [--yes] [--despite-blocking] [--json]` (`handleContractCompile` in `cli.ts`). Without `--build`, only prints the compiled plan and its traceability. With `--build`, reuses the literal `PackBuilder`/`Kairos.build()` call path `kairos build-pack` already uses — same interactive `[y/N]` confirmation, same escalation/exit-2 convention, same `~/.kairos/packs/<name>.json` save via `printPackResult()` — genuinely the same code path, not a parallel one built to look similar.
- 16 new unit tests (`tests/unit/promise/compile.test.ts`) against both real fixtures (workflow names/descriptions/traceability for Empire Homecare; generalization for the SaaS contract, including the escalation workflow still being produced from `sla` alone with no `expirationRules` present) plus escalation-priority and structural-edge-case coverage (no SLA/expirationRules at all; multiple `StartCondition`s numbering intake workflows). Test suite grown 1651 → 1667.
- **Checkpoint — done, live, real (unmodified) `Kairos.build()` calls, not just unit tests, not a mocked pipeline.** `kairos contract compile` on the real Empire Homecare fixture, print-only, matched §5.1's own hand-sketched 3-workflow example almost exactly. `--build --dry-run` then ran the compiled plan through the actual generation/validation pipeline end to end: all 3 workflows generated successfully on the first attempt each (`generationAttempts: 1`, no `error` on any), with only `warn`-severity validator findings (missing webhook auth, no `errorWorkflow` configured, a `to` address the contract's free-text `owner` role can't supply — all expected, none blocking), and sensible inferred credentials (Google Sheets, Gmail/SMTP, PostgreSQL). Direct, live proof that the compiler's deterministically-assembled descriptions are detailed enough for the existing, completely unmodified codegen to succeed without any special-casing for contract-derived input. The SaaS contract (secondary pressure test only, per Codex's explicit instruction, not built/deployed) also compiled cleanly, including a `t-updating-self-loop` transition correctly becoming part of the processing workflow's description — proof the compiler generalizes rather than being Empire-Homecare-shaped. Separately confirmed live that `negative-unreachable-state.json` is correctly refused (`exit 2`, `source: 'validation_errors'`, the real Rule 3 message) before any generation is attempted.
- Per Codex's explicit caution, honored throughout: this phase produces a PackPlan and, optionally, builds real workflows from it — it does not attempt to verify or prove those workflows fulfill the contract once built. That proof is ProofLedger's job (Phase 3, unstarted).

**Phase 3 — SHIPPED 2026-07-20. ProofLedger v0 (§6). The riskiest, most novel phase — flagged honestly, not hidden in the middle of a phase list.**
- **Design-verification spike SHIPPED 2026-07-20 (§6.0) — decision made before any implementation.** Per Codex's explicit instruction ("Do not jump straight into building the ledger/writeback system without a small design spike first... Do not implement ProofLedger yet until this spike writes down the decision"), this sub-step compared all four approaches Codex named (poll, Kairos-local webhook/listener, hybrid, simpler n8n-native option) against nine evaluation criteria, verified against **real production execution data** on Jordan's actual n8n.cloud instance (read-only only — nothing created, triggered, or deployed). **Decision: polling/extraction from n8n execution data** (§6.0), matching Jordan's stated leaning, now empirically confirmed rather than assumed — no new hosted service, no new listener.
- **The two prerequisites Codex required before authorizing implementation, both solved:**
  - *Evidence-node naming convention* (§6.0 Finding 6): `src/promise/compile.ts`'s `evidenceNodeName(transitionId)` — `buildProcessingWorkflow()`'s generation description now instructs the LLM-based codegen to name the exact node that sets an `EvidenceRequirement`'s fields `"Kairos Evidence: <transitionId>"`. **Verified against a real generation call, not just asserted:** a real dry-run `Kairos.build()` call on the compiled Empire Homecare "Processing" description produced a node literally named `Kairos Evidence: t-attempted-to-contacted` — confirming the LLM honors an explicit naming instruction. The generator also independently invented its own `"Set Evidence: ..."`-named nodes for transitions with no `EvidenceRequirement`, using a different string — confirming the marker is specific enough not to collide with look-alikes.
  - *Multi-execution poll watermark* (§6.0 Finding 7): `ContractPollWatermark` (`src/promise/ledger-types.ts`) tracks the last-processed execution per (contractId, n8nWorkflowId) by `startedAt` (n8n execution ids were confirmed numeric/increasing in the spike's real data, but that format isn't part of n8n's documented contract — `startedAt`, ISO 8601 and always present, is the actual comparison key used). `pollWorkflowEvidence()` fetches every execution newer than the watermark, not just the latest; a `possibleGap` flag reports honestly when an entire fetched page was new (the fetch limit may have been smaller than the real gap), rather than silently assuming completeness.
- `src/promise/ledger-types.ts` (types), `src/promise/ledger.ts` (`extractExecutionEvidence()` — pure, no network; `pollWorkflowEvidence()` — the network-touching orchestrator), `src/promise/ledger-store.ts` (append-only-JSONL entries + a small watermarks JSON map, both chmod 600, nested under `~/.kairos/promise-ledger/<contractId>/` — a deliberate refinement over §6.3's original flat-file sketch, made room for the watermarks file alongside the ledger).
- `src/promise/registry.ts` — a real, necessary supporting piece the spike named but Codex's two prerequisites didn't explicitly enumerate: `ContractWorkflowRegistration` durably records which real n8n workflow ids implement a contract, since nothing before this recorded that mapping once a compiled workflow was actually deployed. Auto-populated by `kairos contract compile --build` (unless `--dry-run` or escalated) by cross-referencing the real build's returned workflow ids against Phase 2's own `ContractWorkflowTrace`.
- `kairos ledger poll <contract-id> --client-id <slug> [--limit <n>] [--json]` and `kairos ledger show <contract-id> [--instance <id>] [--json]` (`cli.ts`). `poll` is read-only against n8n (`getExecutions`/`getExecution` only, never a write) and reports a clear extracted/unverifiable/skipped breakdown per workflow plus the `possibleGap` warning — satisfying Codex's explicit CLI/report requirement verbatim.
- Extraction never overclaims: a marker node found with every required field present is `observed`; found with a field missing is `unverifiable` (named, not silently dropped, and still written as a real entry); no marker node in a given execution at all is `skipped` and produces **no ledger entry**, never a fabricated one — matching "no ProofLedger claims beyond evidence available in n8n executions" exactly. The correlation key is read from the first node in `runData` (the trigger — confirmed empirically in the spike, no second naming convention needed for it) and hashed (sha256, reusing `utils/workflow-hash.ts`'s existing pattern) before it ever becomes `promiseInstanceId`/`correlationKeyValueHash` — the raw value is never persisted.
- 35 new tests: 1 added to `compile.test.ts` for the naming convention (16 → 17), 16 in the new `ledger.test.ts` (extraction/poll logic against synthetic execution data shaped exactly like the real data confirmed in the spike), 13 in the new `ledger-store.test.ts`, 5 in the new `registry.test.ts`. Test suite grown 1667 → 1702.
- **Checkpoint — done, live, real (read-only) calls against Jordan's actual n8n.cloud account, not just unit tests.** `kairos ledger poll` was run for real against a real, already-executed production workflow (`Empire Homecare - Weekly Google Business Post`) registered (for checkpoint purposes only) against the Empire Homecare referral contract — a deliberate mismatch, since that real workflow doesn't implement the referral contract's transitions, chosen specifically to prove the real pipeline (real `N8nApiClient` calls, real watermark persistence, real CLI rendering) behaves safely against real data without needing to deploy or trigger anything new on a live account: correctly reported `0 extracted, 0 unverifiable, 1 skipped`, wrote zero ledger entries. Polling again immediately after correctly reported `0 executions checked` — live, empirical proof the watermark prevents reprocessing. Error paths (missing args, an unregistered contract) confirmed to fail cleanly. All checkpoint artifacts removed from `~/.kairos/` afterward — this was verification, not a durable registration.

**Phase 4 — SHIPPED 2026-07-20. SLA compliance monitor + ExceptionDesk v0 (§5.3, §7).**
- `src/promise/business-calendar.ts` -- a real, necessary foundation not named as its own line item in the original plan, built because Codex's own caution ("handle business calendars carefully... start with simple documented rules and avoid overclaiming precision") turned out to require actual arithmetic, not just a schema field. Minute-granularity walk between two timestamps against `BusinessCalendarRef.weeklyHours`, timezone/DST correctness from `Intl.DateTimeFormat`'s own database rather than hand-rolled offsets. `business_days` is a named simplification -- this calendar's average open-day length, not calendar-date counting -- documented as such, not hidden. 15 tests with hand-computed expected values.
- `src/promise/ledger-types.ts`/`ledger.ts` extended with a new `instance_start` entry kind -- a real gap found while building this phase, not predicted by Phase 3: without evidence of when an instance entered its `StartCondition.initialState`, an SLA measured from that state (Empire Homecare's own primary SLA included) has no clock-start signal at all. No new marker-node convention needed -- an intake workflow's own trigger already fires exactly once per new instance by construction (Phase 2's own real checkpoint already confirmed this). 8 new tests.
- `checkSlaCompliance()`/`buildPromiseComplianceReport()` (`src/promise/sla-compliance.ts`) -- styled directly on `drift/checks.ts`'s own D1-D9 checks, same `insufficient_data`/`not_applicable`/`healthy`/`drifting` model reused verbatim. Two confidence tiers for "did this instance reach state X" (mirroring D1's `evidenceQuality`): 'specific' (an `instance_start` entry, or direct `toState` evidence) and 'generic' (an evidence entry whose transition's `fromState` is the state -- proves it was passed through, but only as a conservative upper bound, not a precise timestamp). Absence past a deadline with zero evidence is itself the finding -- the exact D6 "absence is itself the evidence" pattern this plan named for this scenario back in §6.5. Kept structurally separate from `DriftCheckFinding` -- no shared type -- per Codex's explicit "do not conflate workflow drift with promise failure" guardrail. 18 tests, including one honestly-documented real limitation found while testing: Empire Homecare's own fixture has only one `EvidenceRequirement`, which makes its `ExpirationRule` structurally unable to report a genuine "stuck" finding (the only evidence of reaching `contact_attempted` is the same transition that also proves leaving it) -- a real property of what that contract currently declares, not a bug.
- `src/promise/exception-types.ts`/`exception-desk.ts`/`exception-store.ts` -- **the schema evolved from §7.1's original sketch, both by Codex's own newer explicit requirement list and by implementation.** Added: `reason`, `evidence: string[]`, `slaId`/`expirationRuleId`/`transitionId` (Codex: "Include owner, next action, reason, evidence, contract id, hashed correlation key, SLA/transition id, status lifecycle, and audit/history"). Dropped `expired_unresolved` from `ExceptionStatus` -- v0's lifecycle is deliberately just `open`/`acknowledged`/`resolved`, matching "no auto-resolution" literally (an automatic transition into `expired_unresolved` would itself be a kind of autonomous status change). `detectedAt`/`currentState`/`slaDeadline`/`elapsedVsSla` from the original sketch folded into `reason`/`evidence` instead of kept as separate fields -- one human-readable narrative plus structured evidence, not four separate derived-but-overlapping fields. Owner is always a direct `OwnerAssignment` lookup, never invented; `nextAction` reuses the contract's own `ExceptionRule.suggestedAction` only when exactly one is declared (the schema has no id-based link from an `ExceptionRule` to a specific `SlaSpec`/`ExpirationRule` to resolve ambiguity honestly otherwise) -- a real, named v0 simplification. There is no `--auto` mode anywhere in this module, stricter than even the reliability suite's own repair-apply ladder. 17 new tests.
- `src/reliability/watch/notify.ts`'s `invokeOnDriftHook()` widened from `result: WatchTickResult` to `result: unknown` -- a pure type-level change (the body only ever `JSON.stringify`s it), letting `kairos watch --contracts`'s own exception alerts reuse the exact spawn/timeout/EPIPE-safety mechanism (a real, previously-hard-won bug fix from the reliability-suite closeout) instead of risking a second, unproven copy. All 14 existing tests unaffected.
- `kairos exceptions list/show/ack/resolve` (`cli.ts`) -- list/show are pure reads; ack/resolve are the *only* way an item's status ever changes.
- `kairos watch --contracts <contract-id>[,...] --client-id <slug> [--on-exception <cmd>]` -- per Codex's explicit scope ("Integrate with kairos watch only as detect/report/notify, not repair"): each tick polls new evidence for every workflow registered against each named contract (`pollWorkflowEvidence()`, unchanged), evaluates compliance, opens/refreshes exceptions, reports, and alerts. Both `--workflows` and `--contracts` can run in the same loop. `--on-exception` is a separate flag from `--on-drift` -- reusing one flag for both would itself be a form of drift/promise conflation at the CLI level, even with the data kept separate underneath.
- 56 new tests total across this phase's pieces (15 business-calendar, 6 instance_start, 18 SLA compliance, 9 exception-desk, 8 exception-store; the `invokeOnDriftHook()` widening added no new tests, its own 14 existing ones confirmed unaffected). Test suite grown 1702 → 1758.
- **Checkpoint — done, live, real (read-only against n8n) calls, not a mocked pipeline.** Docker was unavailable in this environment (the disposable sandbox couldn't be used, same constraint as Phase 3's spike), so this checkpoint reused the exact same real, already-executed, unrelated n8n workflow Phase 3's own approved checkpoint used (`Empire Homecare - Weekly Google Business Post`) registered against the real Empire Homecare contract, plus one hand-constructed `instance_start` ledger entry (timestamped 3 real calendar days in the past, so any real wall-clock "now" is unambiguously past the 4-business-hour deadline -- no faked clock needed) simulating what a real intake execution would have produced. `kairos watch --contracts ... --once`, run for real: correctly computed 9.02 real business hours elapsed (America/Denver, weekday/weekend-aware), correctly reported the SLA as `DRIFTING`, and correctly auto-opened a real `ExceptionDeskItem` -- `owner: 'on-call rep'` (the real, direct `OwnerAssignment` for `contact_attempted`, not `received`'s owner) and `nextAction` reused verbatim from the contract's own single `ExceptionRule.suggestedAction`. `kairos exceptions list`/`show` rendered it correctly; `ack` then `resolve`, both via the real CLI with `--reason`, produced a correct three-entry history (`auto` open, `human` ack, `human` resolve). Re-running the same live watch tick afterward correctly reported the underlying SLA as still `DRIFTING` (Kairos never hides the raw finding) while the exception item itself stayed `resolved` -- live, empirical proof a human resolution is never silently overridden by continued drift. All checkpoint artifacts removed from `~/.kairos/` afterward.

**Phase 5 — SHIPPED 2026-07-20. Reports (§5.6).**
- `src/promise/report.ts` -- `classifyPromiseInstance()` (five states, not four -- `in_progress` a real gap found while building, see §5.6), `buildPromiseReportData()`, `generatePromiseReport()`. Reuses `stateReachSignals()` from `sla-compliance.ts` directly (exported for this) rather than a second copy of terminal-state-reachability logic.
- `src/promise/report-bundle.ts` -- `writePromiseReport()`, a standalone writer reusing `pack-bundle.ts`'s artifact/manifest *pattern*, not `writeBundle()` itself (§5.6's own real deviation, explained there).
- `kairos contract report <contract-id> --client-id <slug> [--from <date>] [--to <date>] [--bundle <dir>] [--json]` (`cli.ts`) -- purely local, no network calls at all (unlike `kairos ledger poll`/`kairos watch --contracts`, both of which touch n8n).
- 24 new tests (19 `report.ts`, 5 `report-bundle.ts`) against the real Empire Homecare fixture, including two deliberately hand-constructed hard cases: an instance reaching a success terminal only via indirect evidence (`unverifiable`, not `kept`), and one reaching a success terminal *after* its own SLA had already drifted (`missed`, not `kept`). Test suite grown 1758 → 1783 (including the one unrelated real bug fixed along the way, below).
- **A real, pre-existing bug found and fixed via this phase's own checkpoint, not predicted -- then precisely re-scoped by the arc's own closeout `npm pack` check (2026-07-20, see below):** `getKairosVersion()` (`src/validation/provenance-versions.ts`) reported `'unknown'` when the built `dist/cli.cjs` artifact was invoked directly -- tsup's CJS build shims `import.meta` to a bare `{}`, so `import.meta.url` is `undefined` there. **A real `npm pack` + fresh-install check during the arc's closeout pass confirmed the actual published CLI is unaffected** -- `bin.kairos` resolves to the ESM `dist/cli.js`, where `import.meta.url` is never shimmed; a report generated through the real installed binary in a clean scratch install returned the correct version. The bug is real, but narrower than first recorded here: it affects a `require('@kairos-sdk/core')` consumer (the documented CJS `exports` condition, `dist/index.cjs`) inspecting `BuildProvenance` or calling `writeBundle()`/`writePromiseReport()` themselves, and anyone directly invoking `dist/cli.cjs` rather than the published `kairos` bin -- not every real `kairos pack export --bundle` CLI run, as originally (incorrectly) stated when this was first found. Fixed with a `process.argv[1]` fallback, plus a real hardening (`findKairosPackageJson` now verifies `name === '@kairos-sdk/core'` on any candidate, closing a latent gap the new fallback could otherwise have made worse for a CJS library consumer). Both call sites (CLI + library) benefit from one fix, at the correct, narrower severity.
- **Checkpoint — done, live, real (purely local, no network) CLI invocations, not just unit tests.** A realistic mixed scenario (5 promise instances hand-constructed to hit 4 of the 5 rollup states with real, hand-verified business-hour arithmetic) was run through the real `kairos contract report` binary: correctly classified 1 kept (direct evidence), 2 missed (one from a stale open exception the classifier correctly *re-evaluated from the ledger itself* rather than trusting the exception's own status -- proving the rollup never just defers to ExceptionDesk state), 1 unverifiable (indirect evidence only), 1 in_progress. `--bundle <dir>` wrote real `promise-report.md`/`promise-report-manifest.json` files (chmod 600, confirmed) -- the same live run that surfaced and confirmed the `getKairosVersion()` fix above. `--json` and `--from`/`--to` window filtering (including a future `--from` correctly zeroing out all instances) both confirmed live. All checkpoint artifacts removed from `~/.kairos/` afterward.
- **With this phase shipped, Promise Engine v0's full loop is real, not aspirational: contract → compile → workflows → ledger → SLA monitor → exceptions → report.** Every arrow in that chain has shipped code and a real checkpoint behind it (Phase 0-5, this document's own §10).

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

---

## 13. Closeout follow-ups (post-arc, pre-publish)

Findings and fixes made during the arc's own closeout/release-readiness pass (2026-07-20, after all six phases above had already shipped), before any version bump or publish. Recorded here rather than folded silently into the phase entries above, since they weren't found during a phase's own build — they were found by deliberately trying to use the finished thing end to end.

**Rough Edge #1 — `kairos contract compile <file.json>` never persisted the contract, closing the gap with `kairos contract import` (SHIPPED).** Found during a live end-to-end demo of the full loop (`contract plan → compile → build --dry-run → ledger poll → watch --contracts → exceptions → report`): only `kairos contract plan` ever saved a `ProcessContract` into the local store; `compile` (even `--build`) only ever read the given file. A contract obtained any other way — hand-authored, or drafted then edited outside Kairos — had no path into `ledger poll`/`watch --contracts`/`contract report` afterward. Fixed with a dedicated `kairos contract import <file.json> --client-id <slug>` command, not a `compile --save` flag (an explicit preference stated when this fix was authorized: compiling and persisting are different concerns, and a separate command makes it obvious a file is being adopted into the local store rather than silently mutating disk as a side effect of an otherwise read-only compile step). Same validation/blocking-assumption gate as `compile` (exit 2, nothing written, on either); `--client-id` must exactly match the contract's own `clientId` field (refuses rather than silently importing into the wrong client's namespace); provenance/version/status are preserved exactly as given, never rewritten — importing an existing contract is not authoring a new one. Verified live: refusal on a client-id mismatch, refusal on a validation error, refusal on a blocking assumption, a successful import with provenance preserved byte-for-byte, and the full `import → real build's registration → ledger poll → watch --contracts → contract report` chain composing cleanly end to end against real (read-only) n8n data, confirmed again through a genuinely fresh `npm pack` install using the real published `kairos` bin.

**A second, precision fix made alongside it:** `kairos contract report --from/--to` compares plain ISO 8601 strings lexicographically against event timestamps, with no calendar-aware parsing — a bare date (`2026-07-20`) is therefore an *exclusive* boundary against a full timestamp (`"2026-07-20T09:00:00Z"` sorts after `"2026-07-20"` as a string), so `--to 2026-07-20` does **not** include events later that same day. This was a real, undocumented footgun — the README's own example used exactly this pattern (`--to 2026-07-31`, intending "all of July") and has been corrected. Documented explicitly in the CLI help and README rather than changed, per the closeout's own explicit scope ("document the date format," not "redesign the filtering") — an operator who wants an inclusive end-of-day bound now knows to pass the following day or a full timestamp.

**`getKairosVersion()`'s dist-bundle bug (found during Phase 5, §10) was re-scoped more precisely during this same closeout pass**, after a real `npm pack` + fresh-install check: the actual published CLI (`bin.kairos` → the ESM `dist/cli.js`) was never affected, since `import.meta.url` is never shimmed there — only a CJS `require('@kairos-sdk/core')` consumer or direct `dist/cli.cjs` invocation hit it. The fix itself (already shipped in Phase 5) is unchanged and correct for the paths it actually affects; only the recorded severity was corrected, in the CHANGELOG, this document, the source comment, and memory — a real instance of this arc's own "verify by building, not just by design" discipline catching an overstatement in a *previous* finding, not just a new bug.

---

## 14. P0 measurement-integrity audit and fix pass (2026-07-20, pre-publish)

After §13's closeout, a deliberately sharper question was asked before any version bump: not "does the full loop work end to end" (already proven), but *"how could Promise Reports / ProofLedger / SLA compliance / ExceptionDesk confidently report the wrong business outcome?"* — 11 named areas audited against real source, five confirmed as release blockers, one borderline, three "soon," two "later" (already-named, accepted risks). All six blocking/near-blocking findings fixed in one scoped pass, in priority order, before this arc's version was allowed to bump.

### 14.1 The eleven areas, as audited (before any fix)

1. **Event-time vs. poll-time — BLOCKER.** `ProofLedgerEntry` had no field for the real event time at all; `observedAt` (poll time) drove every SLA elapsed-time computation. A same-batch poll could report near-zero elapsed time on a genuinely late response; a backfill after a gap could report a huge elapsed time on a genuinely on-time one.
2. **Multi-item/cardinality evidence extraction — BLOCKER.** Extraction read exactly `runData[node][0].data.main[0][0].json` — first run, first branch, first item — silently dropping every other item in a batch execution.
3. **Watermark/gap/backfill safety — SOON, partially mitigated.** `possibleGap` + a CLI warning already existed for "fetch limit smaller than the real gap." Unmitigated: n8n's own execution-retention pruning data before Kairos ever polls it — invisible, no flag catches it. Documented, not code-changed (out of this pass's scope).
4. **Missing/misnamed evidence nodes — LATER.** A missing node correctly produces `skipped`, not fabricated evidence (working as designed). Gap: nothing verifies at build time that the generated workflow's node name actually matches `evidenceNodeName()`'s convention. Deferred — a post-build verification check is real, separate engineering.
5. **Pause rules in SLA compliance — BLOCKER.** `PauseRule` is a real schema field the authoring LLM actively proposes, but the SLA elapsed-time arithmetic had zero awareness of it.
6. **Correlation-key privacy — SOON, borderline.** Unsalted `SHA-256` of a low-entropy value (Empire Homecare's real correlation key IS a phone number) is reversible via brute force by anyone with ledger-file access. Deferred to the next pass (salted/HMAC hash) — not tiny enough for this one.
7. **PII in whitelisted evidence — SOON.** `EvidenceRequirement.requiredFields` is free-text, author-controlled; nothing checks whether a whitelisted field name itself looks like PII. Deferred (a validator warn-rule) — not tiny enough for this pass.
8. **JSON/JSONL storage concurrency — BLOCKER, practically likely, not theoretical.** `kairos watch --contracts` (continuous by design) and `kairos exceptions ack`/`resolve` (human, interactive) run concurrently as the *expected* usage pattern, not an edge case, and raced on the same unlocked file.
9. **Prose conditions not deterministically enforced — LATER, already named.** Confirmed as the concrete instantiation of a risk §9.7/§11 already named explicitly, not a new surprise. No new fix.
10. **Contract version migration — BLOCKER.** `store.ts` has no versioning semantics (a documented Phase 0 limitation) — silently overwrites `<id>.json` in place, which can orphan historical ledger evidence after a routine contract edit.
11. **Workflow health vs. promise health cohesion — BLOCKER-adjacent.** The architectural separation itself (promise compliance never depends on `DriftCheckStatus`) is correct and unchanged. Gap: an execution whose evidence was expected but whose correlation key couldn't be read produced zero ledger entries at all — invisible to both the numerator and denominator of every count.

### 14.2 Fix order and what shipped (Codex's own explicit priority order, followed exactly)

**1. Storage concurrency / JSONL resilience (area 8).** New `src/utils/file-lock.ts` — the same O_EXCL cross-process advisory-lock algorithm `src/library/file-library.ts`'s own `acquireLock()` already used, extracted as a standalone, reusable utility (not copied a second time) so `exception-store.ts` and `ledger-store.ts` could both use it. A real bug was found and fixed *while building this fix*: the very first version acquired the lock before ensuring its own parent directory existed, so `open(lockPath, 'wx')` threw `ENOENT` on any contract's first-ever write, which the retry loop misread as ordinary lock contention and busy-spun until the timeout — caught by the new tests actually timing out, not by inspection. Fixed with an explicit `ENOENT`-vs-`EEXIST` distinction (fail fast and loud on the former) plus ensuring the directory exists before the lock is ever acquired. `getProofLedgerEntries()` now parses each JSONL line independently. Writes go through temp-file-then-atomic-rename (the same idiom `file-library.ts`'s own `persist()` already pairs with its lock). New tests: a real concurrency test with two racing `Promise.all` writers (a human resolve + a watch-tick refresh for *different* items) proving both survive; a corrupted-single-line-among-valid-lines test; four dedicated `file-lock.ts` unit tests including the `ENOENT` fail-fast regression guard itself.

**2. Event-time vs. poll-time (area 1).** New optional `ProofLedgerEntry.eventTime`, populated from `execution.startedAt` (already available in `extractExecutionEvidence`'s own parameters, previously threaded only into the transient `PollExecutionOutcome`, never persisted) — falls back to `observedAt` only when n8n itself reports a null `startedAt`. `sla-compliance.ts`'s `StateReachSignal.observedAt` field was renamed to `.eventTime` (confirmed via grep to be entirely internal to that module, safe to rename) and repointed to read `entry.eventTime ?? entry.observedAt` everywhere. `report.ts`'s window filtering does the same. New tests deliberately construct entries where `observedAt` and `eventTime` would produce *opposite* verdicts if the wrong field were used — the sharpest possible regression guard.

**3. Pause rules (area 5) — the "mark unsupported" option, not full pause tracking, per Codex's own explicit either/or.** `PromiseComplianceStatus` gained a fifth value, `unverifiable` (mirroring Phase 5's own precedent of adding `in_progress` beyond a literal four-state request when a genuinely distinct case is found). A new `applyPauseRuleCaveat()` intercepts *only* `healthy`/`drifting` verdicts (the two that assert a completed, confident time-based judgment) on any contract declaring `pauseRules`, downgrading them to `unverifiable` with an explanatory summary; `insufficient_data`/`not_applicable` pass through unchanged since they assert nothing a pause could invalidate. `report.ts`'s `classifyPromiseInstance()` was extended so a pause-affected finding also prevents the overall instance classification from confidently landing on `kept` or a suppressed-drift `missed`. A contract-level disclaimer is always shown in `promise-report.md` when any `pauseRules` are declared, regardless of whether this run happened to trigger one. `PromiseComplianceReport.verdict` gained a third value, `UNVERIFIABLE`, and a real duplicate-logic bug was found and fixed along the way: `cli.ts`'s `watch --contracts` handler had its own separate, un-fixed `drifting ? 'DRIFTING' : 'HEALTHY'` computation and its own icon logic that didn't know about the new status — now both reuse the single exported `complianceVerdict()` rather than a second, driftable copy.

**4. Contract version overwrite guard (area 10).** `store.ts` itself was deliberately left unchanged (its own doc comment already says policy belongs at a higher layer) — the guard lives in `cli.ts`. `kairos contract import` now refuses (exit 2, nothing written) to overwrite a contract at a different version unless `--confirm-version-change` is passed. `kairos contract plan` surfaces the same conflict as a loud warning rather than a refusal, deliberately, since that command's own established design already promises to "always save the draft, never withhold it" — a hard refusal there would have fought a previously-shipped, correct behavior rather than fixing a new bug. Verified live end to end against a real scratch `HOME`: refusal without the flag (confirmed the stored file was untouched), success with `--confirm-version-change`, and an exact-version re-save correctly *not* treated as a conflict.

**5. Invisible-failure blind spot (area 11).** New `PollExecutionOutcome.attributedToInstance` distinguishes a real (attributed) `unverifiable` entry — missing fields, but a known instance — from an execution whose evidence was expected but whose correlation key couldn't be resolved at all (unattributed, zero ledger entries, previously invisible). `PollContractResult.unattributedCount` and a new, additive `ContractPollWatermark.cumulativeUnattributedCount` (running total, carried forward across polls) let `kairos ledger poll` warn per-poll and `kairos contract report` warn cumulatively without re-polling — `buildPromiseReportData()` gained an optional `unattributedExecutionCount` parameter (supplied by `cli.ts`, summed across every workflow registered to the contract) so the pure report-building function stays IO-free while still surfacing a real, caller-supplied signal as its own field and its own always-shown-when-nonzero disclaimer.

**6. Cardinality / first-item-only extraction (area 2) — the largest single change.** A new `allItemsJson()` replaces the old `firstItemJson()`, iterating every run × every output branch × every item rather than hard-coding `[0][0]` of the first run. Correlation-key resolution is now genuinely per-item: for an evidence-node item, the correlation key is read directly off *that item's own json* first (since an n8n Set/Edit Fields node normally passes through unset input fields, so a per-item key usually survives to the evidence node unchanged in the natural batch/loop shape) — falling back to a single trigger item's own key only when there is exactly one trigger item total in the execution, which preserves byte-identical behavior for the common single-item case (confirmed: all 27 pre-existing `ledger.test.ts` tests passed unchanged except one detail-text wording assertion). When more than one trigger item exists and an evidence item carries no key of its own, it is reported unattributed rather than guessed at — never misattributed to the wrong instance. Entry ids gained a stable `run.branch.item` position suffix to stay unique across items in the same execution (no prior test asserted an exact id format, confirmed by grep before making this change). Six new tests cover: a multi-item batch trigger producing N `instance_start` entries; a partial-batch where some items lack a correlation key (resolvable ones still extract, others report unattributed;  a batch evidence node where each item carries its own key, correctly attributed per item, not conflated; the single-trigger-item fallback still working; the fallback correctly refusing to guess with more than one trigger item; and a node that ran across multiple n8n *runs* (not just multiple items in one run), confirming both cardinality dimensions this fix addresses.

### 14.3 Verification

Every fix has new, targeted regression tests — several (the `file-lock.ts` `ENOENT` bug, the `cli.ts` duplicate-verdict-logic bug) were themselves found *while building the fix*, not predicted in the audit, matching this whole arc's own "verify by building, not just by design" discipline applied one more time, reflexively, to its own remediation work. Full suite: 1783 → 1820 tests (37 new), all green throughout, typecheck/lint clean after every individual fix, not just at the end. `npm run build` + `npm pack` + a fresh-install smoke test re-run after all six landed, confirming the real installed `kairos --help` shows the new `--confirm-version-change` flag and the CLI still starts cleanly without the optional `@anthropic-ai/sdk` peer dependency present.

**Empire Homecare validation, honestly scoped: local-only, not live.** `N8N_BASE_URL`/`N8N_API_KEY` are not present in this environment's shell — unlike every earlier live checkpoint in this whole arc (which ran against Jordan's real n8n.cloud account, read-only), this pass could not make a real API call. Instead, a scratch script exercised the real, unmodified Empire Homecare fixture (`tests/fixtures/contracts/empire-homecare-referral-intake.json`) through the actual (post-fix) `extractExecutionEvidence()` → `checkSlaCompliance()` → `classifyPromiseInstance()` → `buildPromiseReportData()` → `generatePromiseReport()` pipeline, with synthetic (clearly-labeled, not fabricated-as-real) execution data standing in for what a real poll would return — a batch 2-referral intake execution (fix #2), evidence with a real `eventTime` distinct from poll time (fix #1), a pause-rule-declared variant of the same contract downgrading to `unverifiable` rather than falsely `healthy` (fix #5), and a full report render. All 9 checks passed. This proves the six fixes compose correctly against the real contract shape and did not regress the existing pipeline — it does **not** prove they behave correctly against genuinely live n8n execution data, npm-cloud API response shapes, or a real multi-item Sheets-batch trigger's actual JSON structure, which only a live checkpoint (as every earlier phase in this arc required) can confirm. Recommend a real live checkpoint against Jordan's n8n.cloud account before publish, once credentials are available in-session.

No new feature arc was started alongside this pass, per Codex's own explicit instruction — Intake Interview, Contract Evolution, Scenario Generation, and any platform adapter all remain untouched, exactly where §9/§11's guardrails left them.

---

## 15. Supplemental measurement-integrity audit and Finding 1 fix (2026-07-20, same session, pre-publish)

After §14's fix pass, a deliberately different audit was requested: not the future/deferred items §14.1 already named, but a check of **currently shipped code only** across ten surface areas (contract plan/import/validate/compile/build; registry/workflow registration; ProofLedger polling/extraction/storage/show; SLA compliance/report classification; ExceptionDesk lifecycle + `watch --contracts`; report generation/bundle output; clientId isolation and file paths; file permissions/local data custody; version/provenance consistency; installed CLI parity), against the same focus question §14 used: *"Can current shipped code produce a confidently wrong or misleading Promise Report, lose user data, mix clients, or break a normal operator flow?"*

### 15.1 What the audit found

Three real findings, plus three smaller ones, all in currently-shipped code (no future features involved):

1. **Finding 1 — release blocker, fixed same session (this section).** `ledger-store.ts` and `exception-store.ts` keyed every path by `contractId` alone (`~/.kairos/promise-ledger/<contractId>/...`), with no `clientId` anywhere — unlike `store.ts`/`registry.ts`, which correctly scope by `<clientId>/<contractId>/`. Since `deriveContractId()` is just a slug of the contract's own name, two different clients naming a contract similarly would silently share ledger/exception files. Three commands (`ledger show`, all of `exceptions list`/`show`/`ack`/`resolve`) didn't even accept `--client-id`. `kairos contract report` — the flagship client deliverable — could show a report mixing two clients' data.
2. **Finding 2 — soon, blocker-adjacent, NOT fixed this pass (Codex's own scope: "do not fix Findings 2–6 yet unless required by this change").** `saveContractWorkflowRegistration()` fully overwrites the registration on every successful `--build`, silently dropping any workflow not part of that build's successful output — a partial rebuild failure permanently stops `ledger poll` from tracking a still-live workflow, with no warning.
3. **Finding 3 — soon, NOT fixed this pass.** `hashCorrelationKeyValue()` has no time dimension — a reused correlation key value (e.g. the same phone number calling in again after a prior referral already closed) merges a brand-new instance's evidence into an old, already-terminal instance's history, risking a confidently wrong classification for a currently-active promise.
4. Three smaller findings (a TOCTOU race in the Finding-10-fix's own version-conflict guard; `store.ts`/`registry.ts` not using the temp-then-rename atomic write the P0 pass added elsewhere; an exit-code inconsistency between `contract validate` and `contract compile`/`import`) — all "later," none fixed this pass.

Areas checked with nothing found: `contract plan`'s clientId handling (confirmed Kairos-owned, never LLM-controlled); `registry.ts`'s own path scoping (already correct); file permissions (`chmod 0o600` consistent everywhere); installed CLI parity (dist confirmed current); report-bundle provenance divergence (deliberate, matches an already-established pattern from `pack-bundle.ts`).

### 15.2 Finding 1 fix (this section's own deliverable)

**Scope, exactly as instructed:** thread `clientId` through `ledger-store.ts`/`exception-store.ts`; store files under `<clientId>/<contractId>/...`; update every CLI call site; add `--client-id` to `ledger show`/`exceptions list`/`show`/`ack`/`resolve`; refuse clearly (not silently fall back to unscoped storage) when `--client-id` is missing; decide and document upgrade behavior for old unscoped data (conservative: no auto-migration).

**Design decisions made while implementing:**
- `clientId` was added as a **required parameter**, not an optional one with an unscoped fallback — this structurally eliminates the possibility of "silently using unscoped storage" (Codex's own explicit requirement) rather than relying on a runtime check that could be forgotten at a future call site. TypeScript itself now refuses to compile any call site that omits it.
- `ContractPollWatermark` (`ledger-types.ts`) was deliberately **not** given a `clientId` field. `saveContractPollWatermark()` takes it as a separate parameter instead. `ledger.ts` (`pollWorkflowEvidence()`/`extractExecutionEvidence()`) is a pure, deterministic evidence-extraction module with no storage or client concept at all today, and stays that way — `clientId` is purely a storage-layer concern, entering only at `ledger-store.ts`'s own functions, matching Codex's literal scope ("thread clientId through ledger-store.ts and exception-store.ts," not `ledger.ts`).
- No `clientId` field was added to `ProofLedgerEntry` or `ExceptionDeskItem` either — isolation is achieved entirely by file-path separation, which is sufficient to satisfy every one of Codex's four required proofs (see §15.3) without widening the persisted-data schema, keeping this fix's blast radius to exactly the storage and CLI layers named in scope.
- Every function's `clientId` parameter comes **first** (before `contractId`), matching `store.ts`/`registry.ts`'s own existing parameter order for consistency across the four storage modules.

**Files changed:** `src/promise/ledger-store.ts`, `src/promise/exception-store.ts` (full rewrite of path construction and every exported function's signature), `src/cli.ts` (17 call sites updated across `handleContractReport`, `handleLedgerPoll`, `handleLedgerShow`, `handleExceptionsList`, `handleExceptionsShow`, `handleExceptionsSetStatus`, `runContractComplianceTick` (`watch --contracts`), plus 4 usage/help-text blocks).

**Upgrade/migration decision, made and documented as instructed:** conservative, no auto-migration. Data written under the old unscoped `~/.kairos/promise-ledger/<contractId>/` path by a pre-fix build is left exactly where it is — not deleted, not moved, simply no longer read. Checked directly (not assumed): this environment's own `~/.kairos/promise-ledger/` was confirmed **empty** before this fix shipped, consistent with this whole session's standing discipline of cleaning up every live-checkpoint artifact afterward — there was no real orphaned data to migrate in practice. Documented in README.md and CHANGELOG.md for the general case (this software has never been published, so the real-world blast radius of "no auto-migration" is currently limited to local development data, not any real end user).

### 15.3 Verification — all four of Codex's required proofs, confirmed

1. **Two different clientIds with the same contractId write/read isolated ledgers** — `ledger-store.test.ts`, two new dedicated tests (`SECURITY: two different clientIds with the SAME contractId write and read fully isolated ledgers`; the same for watermarks), plus a live checkpoint (below).
2. **Exceptions are isolated by clientId** — `exception-store.test.ts`, two new dedicated tests, including one proving a resolve on one client's item under a shared `contractId` never touches the other client's same-id item (`SECURITY: resolving an item under one clientId never touches the other client's item with the same contractId`).
3. **CLI requires/client-scopes `ledger show` and exception commands** — a live, local (no network, no live n8n — consistent with "no live validation" for this pass) checkpoint against a real installed `dist/cli.js` and a scratch `HOME`: all five commands (`ledger show`, `exceptions list`/`show`/`ack`/`resolve`) confirmed to refuse cleanly, exit 1, with the new explicit message, when `--client-id` is omitted.
4. **`contract report` for one client cannot see another client's ledger/exception data** — the sharpest live checkpoint: two clients (`client-a`, `client-b`) imported the identical contract shape under the identical `contractId` (`referral-intake`); real ledger entries and exception items seeded via the actual (now client-scoped) store functions, one instance per client; `kairos contract report referral-intake --client-id client-a` and `--client-id client-b` run side by side through the real installed binary — each report showed exactly 1 total instance, the correct owner name, and zero trace of the other client's data. On-disk structure confirmed to be exactly `~/.kairos/promise-ledger/<client-id>/<contract-id>/{ledger.jsonl,exceptions.json}`, matching `store.ts`/`registry.ts`'s own convention precisely.

6 new automated tests (3 in `ledger-store.test.ts`, 3 in `exception-store.test.ts`). Full suite, typecheck, lint, and docs-drift all green after the fix. `npm run build` succeeded; the live checkpoint above ran against that fresh build. No live n8n validation was performed (per Codex's own explicit "no live validation" instruction for this pass) — the checkpoint above is local-only, proving CLI/storage-layer correctness without touching real n8n data, the same class of verification already accepted for the `--confirm-version-change` guard in §14.2.

Findings 2 and 3 were deliberately left unfixed this pass, per Codex's own explicit instruction ("do not fix Findings 2–6 yet unless required by this change") — neither was required to fix Finding 1, and neither was touched.

---

## 16. Findings 2 and 3 — reassessment and fix (2026-07-20, same session, before live validation)

A dedicated reassessment was requested before live validation: confirm current behavior against real code, classify severity, explain impact specifically on Empire Homecare's *first* shadow validation, propose the smallest safe fix, list tests/checkpoints. Both were then approved for implementation, with an explicit preference stated for Finding 2 (refuse by default, not warn-and-proceed) and an explicit scope boundary for Finding 3 (the ambiguity stopgap only, not full time-windowing/re-identification).

### 16.1 Finding 2 — reassessment

Re-traced against the current code (unaffected by the Finding 1 fix): `handleContractCompile`'s `--build` path filters `buildResult.workflows` to `workflowId !== null && !w.error`, then `saveContractWorkflowRegistration()` (`registry.ts`) does a bare `writeFile()` — no read, no merge. A rebuild with one transient generation failure among several silently drops that workflow's registration entirely, even though its previously-deployed n8n workflow is still live. Classified: **soon-but-fix-before-validation**, not a hard release blocker in the corruption/mixing sense Finding 1 was, but directly relevant to the imminent validation — a first build can't trigger it (nothing to overwrite yet), but real client onboarding is rarely one clean build; it's build → discover a business-rule mismatch (Empire's own fixture already carries a `needs_confirmation` assumption about the 3-attempt cap, exactly the kind of thing that gets resolved and triggers a rebuild) → fix → rebuild, which is precisely the pattern this bug needs.

### 16.2 Finding 2 — fix

Codex's explicit preferred behavior: refuse by default, add an override flag, do not just warn-and-proceed, keep scoped to registration behavior (no registry storage redesign).

**Shipped:** `computeDroppedWorkflows(existingWorkflows, newWorkflowNames)` — a new, pure, exported function in `registry.ts` (no I/O), diffing the previous registration's workflow *names* (the stable, deterministic identity `compile.ts` produces — not `n8nWorkflowId`, which can legitimately change across a real redeploy) against the new build's successful set. `handleContractCompile`'s `--build` path now loads the existing registration before saving, computes the diff, and — if anything would be dropped and `--confirm-registration-drop` wasn't passed — refuses (exit 2), printing exactly which workflow(s) would be dropped and their prior `n8nWorkflowId`, then exits without touching the registration file at all. The already-built pack itself is unaffected (the build already happened by this point in the function) — only the registration *write* is gated, so `ledger poll`/`contract report` keep relying on whatever was previously registered for the affected workflow(s) until the operator explicitly confirms. `registry.ts`'s storage shape itself — no merge, no versioning, no partial-write logic — is completely unchanged, exactly as scoped.

### 16.3 Finding 3 — reassessment

Re-traced precisely: `hashCorrelationKeyValue()` (`ledger.ts`) is stateless SHA-256, no time dimension. `buildPromiseReportData()` groups `instanceEntries` purely by `promiseInstanceId` across the full (or windowed) history. `classifyPromiseInstance()`'s terminal-outcome loop calls `stateReachSignals()`, which sorts earliest-first and returns on the first match — an old, already-closed occurrence's terminal outcome wins over a brand-new, still-open one sharing the same correlation key, with zero signal anything was ambiguous. Classified: **soon, and specifically confirmed NOT a threat to the literal first shadow-validation run** — the bug's precondition is *pre-existing* closed-instance history under the same key, and Empire Homecare has none yet (Kairos hasn't been polling their account long enough for a referral to have both closed and had a repeat call). Real risk begins with ongoing/repeat-cycle operation, not this specific validation. Confirmed directly against the fixture (not assumed): Empire's real correlation key is `body.phone`, so the scenario is concrete, not hypothetical, once real history accumulates.

### 16.4 Finding 3 — fix

Codex's explicit scope: the ambiguity stopgap only, not full time-windowing/re-identification.

**Shipped:** `classifyPromiseInstance()` (`report.ts`) now checks, first and unconditionally (before any terminal-outcome, drifting, or pause-rule logic), whether `instanceEntries` contains more than one `kind: 'instance_start'` entry. A second `instance_start` is direct, structural proof of a genuinely new occurrence — Phase 4's own design records it exactly once per real intake execution, so it is never a data artifact. When found, the instance classifies as `unverifiable` with an explicit detail naming the count and the likely cause ("the same phone number used for a new referral after a prior one already closed"), rather than returning whichever terminal outcome `stateReachSignals()` happened to find first. Checked unconditionally, ahead of every other branch, including the failure-terminal-outcome case — a confident `missed` could just as easily belong to the wrong (older) occurrence as a confident `kept` could. Composes with zero additional wiring at the report level: `unverifiable` is the same `PromiseInstanceStatus` already counted in `instanceCounts` and covered by the existing generic "N instance(s)... are unverifiable" disclaimer — confirmed by a dedicated `buildPromiseReportData` test, not just asserted.

### 16.5 Verification

11 new tests: 5 in `registry.test.ts` (`computeDroppedWorkflows` — clean rebuild/no drop, partial rebuild/exact drop named, first-build/nothing to drop, changed `n8nWorkflowId` for a still-present name is not a drop, total wipe reports everything dropped) and 6 in `report.test.ts` (the exact "old terminal outcome + newer `instance_start` under the same key" scenario requested, a case where the old occurrence would otherwise have been `missed` too — ambiguity still wins, exact count named in the detail text, a single-`instance_start` regression guard proving normal classification is completely unaffected, a zero-`instance_start` regression guard, and the `buildPromiseReportData`-level composition test). Full suite (1826 → 1837), typecheck, lint, docs-drift all green. `npm run build` + `npm pack` + fresh-install smoke test re-run, confirming `--confirm-registration-drop` appears in the real installed CLI's help.

**Honestly scoped gap: Finding 2's full CLI-integrated behavior was not live-checkpointed this pass.** The refusal/override logic only executes inside a real, non-dry-run `--build` (a `--dry-run` build skips the registration block entirely, before ever reaching this code), which needs live n8n + Anthropic — out of scope for this session's explicit "no live validation" constraint. Verified instead via thorough unit coverage of the pure `computeDroppedWorkflows()` diff logic (which is the entire decision, the CLI wiring around it is a direct, simple translation of that result into a refuse-or-proceed branch) plus careful code review and a real fresh-install check that the new flag and help text are correct. Recommend exercising the actual refuse → `--confirm-registration-drop` → succeed sequence with a real two-build cycle as part of the live validation pass that follows this one.

---

## 17. Live release-validation pass (2026-07-21, same session, the gap named at the end of §16 closed)

Real `N8N_BASE_URL`/`N8N_API_KEY`/`ANTHROPIC_API_KEY` were available this session (`.env`). A disposable, clearly-labeled contract (`kairos-validation-probe`, clientId `kairos-validation-test`, entity "TestWidget", contract name literally prefixed "DISPOSABLE - DO NOT USE FOR REAL DATA") was authored by hand and used for every write-capable check below — Empire Homecare's real production workflows were never triggered, only read via GET.

**Verified, real, live:**
- **Connectivity + real execution shape** — read-only `getExecutions`/`getExecution` against the same pre-existing checkpoint workflow (`IfxKaA1MYZ4Xs3eI`) reused across this whole arc's earlier checkpoints. Confirmed the trigger-node-first assumption and `execution.startedAt` presence still hold against current live data.
- **`eventTime` extraction (fix #1), partially** — `extractExecutionEvidence()` run directly against that real execution's raw JSON correctly took the unattributed path (fix #11) since the correlation key genuinely doesn't resolve for that unrelated workflow — proves `execution.startedAt` threading and the unattributed/`attributedToInstance: false` mechanism both work against real data. Did **not** get a full positive match (a real extracted entry with populated `eventTime`) — see the webhook limitation below.
- **`skipped` outcome (real data)** — the same real execution, run with no `startCondition` and evidence requirements that don't match any real node name, correctly produced `outcome: 'skipped'`, zero entries.
- **Full real build → register → poll → report cycle** — `contract validate` → `contract import` → `contract compile --build --yes` deployed 3 real, disposable n8n workflows (Intake/Processing/Escalation, all named "TestWidget..."), registered correctly (first build, nothing to drop). `kairos ledger poll` against the real registered workflow ids correctly reported 0 executions/0 entries/no errors. `kairos contract report` produced clean, readable, honest output ("No promise instances have any recorded evidence... nothing to summarize").
- **Finding 2's refuse/override path, fully, with two real rebuilds** — edited the contract to drop its only SLA (removing the Escalation workflow from the compiled plan) and rebuilt for real: refused (confirmed exit code 2, not just visual inspection), named exactly `"TestWidget SLA Escalation" (was: Fz1pctfWiIb1TJ8I)`, and confirmed the on-disk registration file was byte-for-byte untouched (still v1, still all 3 original workflows) after the refusal. Rebuilt again with `--confirm-registration-drop`: succeeded (exit code 0), printed the exact drop warning, and the registration file correctly updated to 2 workflows. This closes the exact gap §16 named as unverified.
- **Client isolation, reconfirmed on current `dist`** — `ledger show`/`exceptions list` still refuse cleanly without `--client-id` on the freshly-rebuilt binary; the whole disposable-contract cycle above ran entirely under a distinct `kairos-validation-test` clientId with no cross-contamination.
- **Full test suite reconfirmed** — 1837/1837 green (no source changed this pass, so this is a confirmation, not a new baseline).

**Not fully verified, honestly disclosed — an n8n.cloud limitation, not a code defect:** activating the disposable Intake workflow via the REST API (`activateWorkflow`) did not register its production webhook route — `POST /webhook/testwidget-intake` returned a 404 "not registered" even after confirming `active: true` via a read-back and a full deactivate/reactivate cycle. This is a known class of n8n.cloud behavior (webhook route registration sometimes requires activation through the editor UI, not just the REST API) — not something this codebase's own code touches. Consequence: no genuinely fresh, webhook-triggered execution was obtained this pass, so **(a)** a full positive-path `eventTime` match against brand-new real data, and **(b)** multi-item/cardinality behavior against real (not synthetic) execution data, remain verified only via the existing comprehensive unit-test suite (built against the exact JSON shape the Phase 3 spike confirmed against real data), not a fresh live trigger. Both are recommended as a manual follow-up (trigger the same disposable workflow's webhook via the n8n editor UI, or via `n8n-nodes-base`'s own "test webhook" listen mode) whenever convenient — not a blocker, since the underlying extraction mechanism (`execution.startedAt` → `eventTime`, `allItemsJson()`'s shape assumptions) is unchanged from what the Phase 3 spike already confirmed against real data, and every other real-data check above passed cleanly.

**Cleanup:** all local `~/.kairos/` artifacts from this validation (contract, registration, ledger/watermark files, the saved pack) were deleted afterward, confirmed empty by a final directory scan. The disposable Intake workflow's activation was reverted (deactivated) since it was never successfully triggered. **Real n8n workflow ids created this pass, left in place pending explicit disposal confirmation** (7 total, all clearly named "TestWidget..." under the disposable "Kairos Validation Probe" contract, none touching Empire Homecare's real workflows): `Z2fKOUxXYvyEcrdU`, `2I8ocZXOqEsWmzjd`, `Fz1pctfWiIb1TJ8I` (first build); `f2GzIDZITx0NDWMu`, `Irn5ACbI1HWMfsmX` (refused-registration rebuild, orphaned in n8n but never registered in Kairos); `D8KF1GWtGdDMz7HI`, `g4cO0MGLtmy1FTSr` (the override rebuild, currently registered). Deleting real account content wasn't treated as pre-authorized by "create disposable workflows for validation" — left for an explicit decision.

No code was changed this pass. `npm pack`/fresh-install smoke test and full lint/typecheck were not re-run (nothing changed since §16's own clean run) — the full test suite was re-run anyway as cheap extra insurance before this report.

Following this pass: the disposable "TestWidget" workflow set was deleted from n8n in two rounds (the 7 explicitly listed above, plus 2 more discovered during final cleanup — a second registration-drop-refusal re-run, done purely "to confirm the real exit code," had silently deployed an unreported extra pair; disclosed honestly and deleted only after explicit confirmation, each verified by name before deletion and by a 404 read-back after). `package.json`/`package-lock.json` were then bumped to `0.12.0` and this file's own CHANGELOG entry retitled from `[Unreleased]`, with a dedicated release commit — not published, not pushed, both deliberately held for a separate decision.

---

## 18. Synthetic end-to-end validation (2026-07-21, after the v0.12.0 release commit, no code changed)

True Empire Homecare shadow validation needs real event traffic, which doesn't exist yet. As a stand-in, a fully synthetic but realistic scenario was designed and run to exercise the complete Promise Engine loop — contract → seeded evidence → SLA compliance → ExceptionDesk → report — end to end against a scenario the code was never specifically tuned for.

**Scenario:** "Every website contact form submission should be acknowledged within 1 business hour, assigned to an owner, and escalated if required contact info is missing or no acknowledgment happens on time." A small `ProcessContract` (`website-contact-form-ack`) was authored for this, entirely disposable, under a dedicated `clientId` (`synthetic-validation`) and isolated from any real client's namespace.

**Method, in order:** a human truth table (`truth-table.md`) was written first, before running any code, naming the expected `contract report` status, evidence quality, and ExceptionDesk item count for each of 5 cases — the standard discipline used throughout this arc to keep a validation honest rather than a post-hoc rationalization. Timestamps were chosen as generous, real-wall-clock-relative offsets ("2 days ago," "5 minutes ago") rather than fixed dates, so the result doesn't depend on the exact day/time the validation happens to run. Evidence was then seeded directly via the real, unmodified `appendProofLedgerEntries()`/`hashCorrelationKeyValue()` functions (`seed-cases.mts`) — not reimplemented or simulated logic — using clearly-fake `.test`-TLD correlation keys (RFC 2606 reserved for testing). The real `checkSlaCompliance()`/`updateExceptionDesk()`/`upsertExceptionDeskItems()` functions were then run directly (`run-compliance.mts`) — the exact same logic `runContractComplianceTick()` (the implementation behind `kairos watch --contracts`) calls internally, minus the live n8n poll step itself, which isn't needed since evidence was seeded directly rather than polled.

**The 5 cases and outcome, against the truth table:**
- **Case A (kept)** — submitted 2 days ago, acknowledged 20 real minutes later with complete evidence. Classified `kept`, `evidenceQuality: specific`, 0 exceptions. **Matched.**
- **Case B (missed, SLA + expiration breach)** — submitted 5 days ago, no further evidence at all. Classified `missed`, `evidenceQuality: specific`, **2** ExceptionDesk items opened (one `missed_sla`, one `stuck` — the SLA and the ExpirationRule are separate exception keys that drift independently). **Matched.**
- **Case C (missing info, quick failure)** — submitted 10 minutes ago, flagged `missing_info` 5 minutes after submission. Classified `missed` via the failure-terminal-outcome path, `evidenceQuality: specific`, **0** ExceptionDesk items — the real system boundary now documented explicitly in the README and CLI help (see §19): ExceptionDesk only reacts to time-based SLA/expiration drift, and only ~10 minutes had elapsed, so both the SLA and ExpirationRule findings were independently `insufficient_data`/`not_applicable`. **Matched** — this case specifically exists to demonstrate the boundary is real and correctly non-alarming, not a bug.
- **Case D (in progress)** — submitted 5 minutes ago, no further evidence. Classified `in_progress`, 0 exceptions. **Matched.**
- **Case E (unverifiable, Finding 3's ambiguity stopgap)** — two separate `instance_start` entries under the same correlation key (3 and 1 minutes ago), simulating the same visitor submitting the form twice. Classified `unverifiable` via the unconditional first-check added in §16.4, 0 exceptions (both entries recent enough that the underlying SLA finding was independently `insufficient_data` too, keeping this case isolated to testing only the ambiguity check). **Matched.**

**Result: zero mismatches against the pre-written truth table.** No raw PII in any ledger/report output beyond the intentionally fake `.test`-TLD emails, only hashed instance ids. No production workflows or real client data touched anywhere in this pass — purely local, under an isolated scratch working area. No code changed as a result of this validation; it exercised existing, already-shipped logic.

**Conclusion:** this is real, if partial, positive evidence for v0.12.0's release-readiness — the full pipeline produces correct classifications end to end on a scenario distinct from every fixture the code was built and tested against, with an experimentally-confirmed boundary (Case C) rather than an assumed one. It does not replace a true Empire Homecare shadow validation against real event traffic, which remains the recommended next step before using Promise Reports in a real client-facing capacity.

---

## 19. Final docs/scope audit before pushing v0.12.0 (2026-07-21, same session, no product code changed)

Before pushing, a dedicated pass checked whether README, `package.json`, `CHANGELOG.md`, and CLI help text still accurately describe Kairos after the Reliability Suite + Promise Engine v0 arcs, specifically watching for stale positioning and any "proof"/"guarantee" overclaiming.

**Findings:**
- **README's top-level positioning (line 7) mentioned only the Reliability Suite** — zero mention of Promise Engine v0 anywhere in the opening description, despite it being a major, later-shipped capability. Fixed: the opening paragraph now names both.
- **No discoverable section header for Promise Engine anywhere in the 1494-line README** — all of it lived as inline bash comments inside the giant `## CLI` code block. Fixed: added a standalone `## Promise Engine v0 (ProcessContract → ProofLedger → ExceptionDesk)` section (placed before `## CLI`) with a short loop overview and the four caveats below, linked from the "what Kairos does" table.
- **`package.json`'s `description`/`keywords` were fully stale** — described only "LLM-powered n8n workflow generation," nothing about reliability or Promise Engine capabilities, the first thing shown on the npm registry page. Fixed: both updated (5 new keywords: `reliability`, `drift-detection`, `chaos-testing`, `sla-monitoring`, `process-contract`).
- **The "what Kairos does and does not do" table had a Promise Engine row but lacked specific caveats.** Fixed: added two rows to the "does not guarantee" column — evidence-graded-not-a-guarantee, and the ExceptionDesk time-based-only boundary.
- **The ExceptionDesk time-based-only boundary (demonstrated concretely by §18's Case C) was undocumented anywhere user-facing** — README's CLI reference block and `cli.ts`'s own `--help` output both described ExceptionDesk's mechanics thoroughly but never stated this boundary. Fixed in both: an explicit "IMPORTANT" note naming the exact scenario (a fast terminal failure, reached before any deadline passes, produces no exception item) and pointing to `contract report` for the complete picture.
- **No "evidence-graded, not a guarantee" framing statement existed anywhere top-level** (existing "proof"/"guarantee" language was already appropriately hedged on inspection — no overclaiming found, a good sign). Fixed: added explicitly, both in the new README section and in `cli.ts`'s top `HELP` banner.
- **`cli.ts`'s own `HELP` banner (line 24) was stale**, matching `package.json`'s old description exactly ("LLM-powered n8n workflow generation"). Fixed: rewritten to name the reliability suite, the Promise Engine, and the evidence-graded/n8n-substrate caveats in four lines, kept in sync with the README's opening paragraph.
- **`docs/plans/reliability-suite-plan.md`'s own scope note (line 5) was stale** — it stated Process Contract/Proof Ledger/Exception Desk "have no design/detail in this repo yet," no longer true once Promise Engine v0 shipped as a follow-up arc. Fixed with a one-line dated addendum; the historical record itself was left otherwise untouched.
- **`CHANGELOG.md`'s `[0.12.0]` summary correctly referenced §§14–17 (all written before the release commit) but didn't mention §18's synthetic validation, which happened after the release commit was already made.** Since CHANGELOG conventions track code/behavior changes and the synthetic validation changed no code, a full new entry wasn't warranted — added one sentence noting it occurred and pointing to §18, which carries the full detail.
- Grepped for `n8n is still the initial execution substrate` framing: absent before this pass. Fixed: stated explicitly in the new README section and the `cli.ts` HELP banner.

No product code was changed. Verification (docs-drift, typecheck, lint, full test suite, `npm pack` + fresh-install smoke test) run after all doc edits — see this session's own report for exact results.
