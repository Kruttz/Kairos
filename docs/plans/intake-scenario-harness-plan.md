# Intake, Scenario Generation & Contract Harness — Implementation Plan (Roadmap Items 4–10)

**Status: PLANNING ONLY. No code has been written against this plan.** This document is the deliverable itself, per explicit instruction: design the next arc before touching implementation.

**Date:** 2026-07-21, immediately after v0.12.0 (Reliability Suite + Promise Engine v0) shipped to GitHub and npm.

**Scope:** Roadmap items 4–10, as named explicitly in this session:
4. Intake Interview v0
5. Contract Scenario Generator
6. Kairos Contract Harness / Node Harness v0
7. Replay Upgrade with expected business outcomes
8. Chaos Upgrade with business-level scenarios
9. ProofLedger/ExceptionDesk Harness Tests
10. Contract Compiler Verification

Sourced from two documents Jordan supplied for full context before planning — `/Users/jordankrutman/Desktop/Futrure copy.txt` ("Kairos Future Direction Report," the deepest technical treatment of the Contract Harness idea, §§1–14) and `/Users/jordankrutman/Desktop/FutureForKairos.txt` (a longer thread of exchanges with Codex tracing the same idea from "automation reliability engine" through "business promise compiler," ending in an explicit numbered priority order). Both were read in full before any of this plan was written. Every codebase claim below was verified directly against current source — `src/promise/`, `src/reliability/`, `src/pack/`, `src/cli.ts`, and the relevant test suites — not recalled from memory or from the plan docs' own prior descriptions of themselves.

---

## 0. How to read this document

Each of the seven items (§4–§10 below, numbered to match the roadmap, not restarted at zero) has the same eleven subsections, in the same order, per the explicit request: What it is, Why it matters, How it connects to existing modules, Files/subsystems affected, Data models/types needed, CLI/API surface, Tests/checkpoints, Guardrails, What not to build yet, Risks/open questions, Definition of done. §1–§3 are cross-cutting context read once, up front, that every phase section then assumes. §11–§16 close the document: how the seven phases connect into one loop, recommended build order, guardrails restated in one place, a global "not yet" list, cross-phase risks, and a whole-arc definition of done.

---

## 1. Where this fits in the roadmap

Both source documents converge on the same three-layer framing of what Kairos is becoming:

```text
Today:        AI workflow delivery engine for n8n
Near-term:     automation reliability / SRE layer      <- v0.12.0, just shipped
Long-term:     business process / promise engine        <- Promise Engine v0, also just shipped
Next:          verify the promise engine's own outputs, and capture business logic correctly
               at the source, before broadening further  <- THIS PLAN (items 4-10)
```

Codex's own numbered priority list, at the end of `FutureForKairos.txt`, after live validation / v0.12.0 / Empire shadow validation (items 1–3, already handled or in progress in prior sessions):

```text
4. Intake Interview v0
5. Scenario Generation from Contract
6. Contract Evolution + Amendment/Diff
7. Automation P&L
8. Operations Scout
9. Self-Tuning Flywheel
10. Platform Adapter
11. Dashboard/Portal
```

Today's request narrows and re-numbers items 4–10 differently — it pulls the **Kairos Contract Harness** thread specifically out of `Futrure copy.txt` §7–§10 (the deepest, most concrete technical proposal in either document) and turns it into five concrete phases (5–9 below), bracketed by Intake Interview (4, unchanged from Codex's own list) and Contract Compiler Verification (10, a gap this plan's own codebase research surfaced independently — see §10). **Contract Evolution, Automation P&L, Operations Scout, Self-Tuning Flywheel, Platform Adapter, and Dashboard/Portal are all explicitly out of scope for this plan** — they remain on the longer-term roadmap, untouched, exactly where Codex's list already put them.

This re-scoping is sound: every one of the five harness-arc phases (5–9) is prerequisite infrastructure for Contract Evolution ("ProofLedger + ExceptionDesk patterns → Kairos notices repeated mismatch → suggest contract amendment") to ever be trustworthy — you cannot responsibly suggest amending a contract based on evidence patterns until you have proven, mechanically and repeatably, that your evidence-evaluation logic itself is correct. That proof is exactly what items 5–9 build.

---

## 2. The core architectural shift this arc makes

`Futrure copy.txt` states the thesis precisely, and it is worth quoting directly because it is the single most important constraint on everything below:

> **Kairos should not become "Node instead of n8n." Kairos should become a hybrid business-process reliability engine where n8n is the visual/execution substrate and Node.js is the agent-native validation, simulation, testing, and eventually optional runtime layer.**

Concretely, today's architecture (verified against real code, not the plan docs' own prior description of themselves):

```text
Business description
   |
ProcessContract               (src/promise/types.ts)
   |
compileToPackPlan()           (src/promise/compile.ts -- deterministic, no LLM call)
   |
PackPlan (prose WorkflowPlan descriptions)
   |
PackBuilder.build() / Kairos.build()   (LLM call -- generates real n8n JSON from prose)
   |
n8n workflows (deployed)
   |
n8n executions
   |
pollWorkflowEvidence()        (src/promise/ledger.ts -- extracts ProofLedgerEntry from execution JSON)
   |
checkSlaCompliance()          (src/promise/sla-compliance.ts -- pure function over ProofLedgerEntry[])
   |
updateExceptionDesk()         (src/promise/exception-desk.ts -- pure function over findings)
   |
buildPromiseReportData()      (src/promise/report.ts -- pure function, classifyPromiseInstance() per instance)
   |
promise-report.md
```

The gap this whole arc targets: **everything from `compileToPackPlan()` through `Kairos.build()` is non-deterministic (one real LLM call), and nothing today checks, before or independent of a live n8n execution, whether the LLM actually generated a workflow that structurally satisfies what the contract requires.** A workflow can deploy cleanly, run without error, and still be wrong — the exact "workflow ran green but was wrong" failure mode both source documents name explicitly (`Futrure copy.txt` §8, verified concretely by this session's own npm-publish and live-validation history: n8n's own webhook-activation quirks, evidence-node naming discipline that depends entirely on the LLM following `compile.ts`'s prose instructions correctly).

The fix is not a Node.js runtime that replaces n8n execution. It is a **Node.js verification layer that sits alongside n8n at every stage**:

```text
ProcessContract
   |
Contract Scenario Generator (5)  -- synthetic business situations, deterministic, traceable
   |
   +--> Kairos Contract Harness (6) -- runs scenarios through the REAL promise-evaluation
   |      functions in-memory, no n8n, proves the evaluation logic is self-consistent
   |
   +--> Chaos Upgrade (8) -- turns scenarios into real webhook payloads, replayed through
   |      a real n8n sandbox, proves the GENERATED WORKFLOW handles them correctly
   |
   +--> Replay Upgrade (7) -- extends existing structural replay diffs with a business-
   |      outcome check using the SAME evidence-extraction code ProofLedger uses in prod
   |
   +--> ProofLedger/ExceptionDesk Harness Tests (9) -- turns 5+6 into permanent, checked-in
          regression coverage, so a future change to sla-compliance.ts/exception-desk.ts/
          report.ts cannot silently break promise evaluation again

Contract Compiler Verification (10) -- a separate, structural check that the workflows
  compileToPackPlan()/Kairos.build() actually produced contain what the contract requires
  (an evidence node per EvidenceRequirement, a correlation-key field reference), independent
  of any of the above -- catches the gap at build time, not weeks later in a promise report.

Intake Interview (4) -- upstream of all of it: the contract these five phases verify is
  only as good as how it was captured in the first place.
```

The load-bearing design principle, true across every phase below and stated once here rather than seven times: **the harness and its extensions call the real, already-shipped, pure functions (`checkSlaCompliance`, `updateExceptionDesk`, `classifyPromiseInstance`, `buildPromiseReportData`, `extractExecutionEvidence`) directly. Nothing in this plan reimplements promise-evaluation logic a second time.** This is not a new idea invented for this plan — it is the exact pattern this session's own synthetic contact-form validation already proved works, by hand, once (`seed-cases.mts` built `ProofLedgerEntry[]` directly with real fake data and called `checkSlaCompliance`/`updateExceptionDesk` directly; `run-compliance.mts` did the same for the report layer). §6 below formalizes that one-off script into a real, permanent feature. That the manual version already worked, with zero mismatches against a hand-written truth table, is real evidence this architecture is sound before a single line of the formalized version is written.

---

## 3. Cross-cutting foundations

### 3.1 The shared `ContractScenario` type

Phases 5 through 9 all revolve around one shared artifact. Defining it once here avoids five slightly-different reinventions across phase sections below.

```ts
// src/promise/scenario-types.ts (new)

export type ScenarioCategory =
  | 'happy_path'
  | 'missing_data'
  | 'duplicate_entity'
  | 'late_response'
  | 'no_response'
  | 'after_hours'
  | 'pause_resume'
  | 'expired'

export interface ScenarioTimelineEvent {
  id: string
  /** Relative to the scenario's own start, not a fixed timestamp -- reuses SlaSpec.duration's
   * exact {amount, unit} shape for consistency with the rest of ProcessContract, and mirrors
   * the "generous, real-clock-relative offset" timing-robustness principle this session's own
   * synthetic validation established (daysAgo(n)/minutesAgo(n)) so a generated scenario's
   * classification outcome doesn't depend on what day/time it happens to run. */
  offset: { amount: number; unit: 'minutes' | 'hours' | 'days' }
  kind: 'instance_start' | 'evidence'
  /** Required when kind is 'evidence' -- must match a real ProcessContract.transitions[].id. */
  transitionId?: string
  /** Required when kind is 'instance_start' -- must match a real StartCondition.initialState. */
  initialState?: string
  /** Synthetic evidence field values -- keys should be drawn from the matching
   * EvidenceRequirement.requiredFields, values always obviously fake. */
  fields?: Record<string, string>
}

export interface ScenarioExpectedOutcome {
  /** Reuses report.ts's real PromiseInstanceStatus type -- never a parallel enum. */
  reportStatus: PromiseInstanceStatus
  /** Reuses report.ts's real PromiseInstanceClassification['evidenceQuality'] type. */
  evidenceQuality?: 'specific' | 'generic'
  expectedExceptionCount: number
  /** Reuses exception-types.ts's real ExceptionKind type. */
  expectedExceptionKinds?: ExceptionKind[]
  /** Why this is the expected outcome -- written in the same hand-verified-truth-table style
   * as this session's own synthetic validation, since that document already proved this style
   * of reasoning catches real classification bugs, not just documents an assumption. */
  reasoning: string
}

export interface ContractScenario {
  id: string
  contractId: string
  contractVersion: number
  name: string
  category: ScenarioCategory
  description: string
  /** Always synthetic. Never derived from real client data -- enforced by convention (an
   * obviously-fake pattern, matching this session's `.test`-TLD discipline) and checked by a
   * dedicated test (see §5's Tests/checkpoints), not left as an unenforced house style. */
  correlationKeyValue: string
  timeline: ScenarioTimelineEvent[]
  expected: ScenarioExpectedOutcome
  /** Same traceability discipline as compile.ts's ContractWorkflowTrace -- which contract
   * elements this scenario exercises, so a scenario can be regenerated or audited against the
   * exact rule that produced it. */
  sourceElements: string[]
  provenance: {
    generatorVersion: string
    createdAt: string
  }
}
```

### 3.2 Reuse discipline

No phase below reimplements: SLA/expiration evaluation (`checkSlaCompliance`), exception lifecycle (`updateExceptionDesk`), promise classification (`classifyPromiseInstance`/`buildPromiseReportData`), evidence extraction from raw n8n execution JSON (`extractExecutionEvidence`), or correlation-key hashing (`hashCorrelationKeyValue`). Every phase that needs one of these calls the real, exported function from `src/promise/`. Where a phase needs to run one of these functions against **synthetic, in-memory data instead of real n8n execution data**, the function signatures already support this without any change: `checkSlaCompliance(contract, entries: ProofLedgerEntry[], now)`, `classifyPromiseInstance(contract, instanceEntries: ProofLedgerEntry[], instanceExceptions, now)`, and `updateExceptionDesk(contract, findings, existingItems, now)` all already take **plain in-memory arrays**, not a file path or a live poll. Only `ledger-store.ts`/`exception-store.ts` touch disk, and this plan's harness (§6) deliberately never calls them — a concrete, verified design finding from reading the real code today, not an assumption.

### 3.3 New module boundaries

Two of these phases (7, 8) need `src/reliability/` to read from `src/promise/` for the first time — a cross-boundary import that does not exist anywhere in the codebase today. `tests/unit/reliability/module-boundaries.test.ts` currently enforces a firewall between `src/reliability/community/` and `src/promise/` (bidirectional, zero exceptions) and a separate firewall protecting `src/reliability/community/` from `src/reliability/replay/capture.ts` and `src/memory/`. It says nothing about `src/reliability/replay/` or `src/reliability/chaos/` importing `src/promise/`, because until this arc, nothing needed to.

This plan proposes the new boundary be **narrow and explicit, not a blanket opening**: `src/reliability/replay/` and `src/reliability/chaos/` may import the **pure, already-exported** functions from `src/promise/ledger.ts` (`extractExecutionEvidence`, `evidenceNodeName`) and read `src/promise/types.ts`/`scenario-types.ts` — never `src/promise/ledger-store.ts`, `exception-store.ts`, or `store.ts` (the file-backed persistence layer), and never write to any `~/.kairos/promise-ledger/` or `~/.kairos/contracts/` path directly. A new test, symmetric to the existing community/↔promise/ firewall, should assert this exact shape: `reliability/replay/` and `reliability/chaos/` may import from `promise/ledger.js`, `promise/types.js`, `promise/scenario-types.js` (an explicit allow-list of three files, not "may import promise/"), and must never import `promise/ledger-store.js`, `promise/exception-store.js`, or `promise/store.js`. This keeps replay/chaos read-only with respect to promise-engine storage — they can classify what a sandbox execution *would* mean without ever persisting that classification as if it were real production evidence, which would be a genuinely dangerous confusion (a chaos-test execution's synthetic ProofLedgerEntry must never end up mixed into a client's real ledger file).

### 3.4 PII and timing discipline

Every synthetic scenario, fixture, and generated payload in this entire arc must use obviously-fake data — reusing this session's own `.test`-TLD-email / clearly-labeled-disposable-workflow conventions, never a real client's real field values, even as a "realistic-looking" example. Timeline offsets are always relative to real wall-clock "now" at generation/run time (never hardcoded absolute dates), matching the timing-robustness principle proven in this session's synthetic validation.

### 3.5 Testing discipline

`tests/unit/no-network-guard.test.ts` proves the full suite runs with real `fetch` blocked. Every phase's default `npm test` coverage must respect this — anything requiring a live n8n sandbox, a real Anthropic API call, or real network access is a **live checkpoint**, run manually and reported, never added to the default suite. This mirrors every phase in the Reliability Suite and Promise Engine v0 arcs before this one; nothing new is being introduced here, just carried forward.

---

## 4. Phase 4 — Intake Interview v0

### What it is

A multi-turn, LLM-guided conversational flow that captures messy business logic through structured, branching questions and produces (or refines) a `ProcessContract` — replacing today's one-shot `kairos contract plan "<description>"` (a single LLM call in `src/promise/plan.ts` that must infer an entire state machine, SLA set, and exception list from one paragraph) with an iterative session that asks the specific questions both source documents name explicitly: *What starts the process? What counts as done? What can go wrong? Who owns each exception? What deadlines matter? What systems hold evidence? What happens if data is missing? What happens if the customer replies late? What happens if the same person appears twice? What should never be automated?*

### Why it matters

Both source documents rank this as the single highest-leverage next feature, independent of everything else in this plan — `FutureForKairos.txt`'s own final line: *"The most important next strategic feature is still Intake Interview v0. Everything else depends on understanding the business process correctly."* Verified directly against `plan.ts`: today's one-shot draft asks an LLM to infer `states`/`transitions`/`sla`/`exceptions`/`owners` from a single free-text description in one pass. Real business logic is branchy in ways a paragraph rarely captures completely — and every phase downstream of a contract (compile, scenario generation, harness, replay, chaos, ledger, report) inherits whatever the contract got wrong at authoring time. A cheap, high-quality fix at the source is worth more than sophistication anywhere downstream of it.

### How it connects to existing modules

Builds directly on `planProcessContract()`'s existing pattern (`src/promise/plan.ts`) — one Anthropic call per turn instead of one call total, same `AnthropicMessagesClient` injectable-for-tests interface, same non-negotiable rule Codex stated when Phase 1 was built and which still applies here verbatim: *run the deterministic validator on the draft; if invalid or blocking assumptions exist, return a review/escalation result rather than pretending it's usable.* The session's output is a `ProcessContract` conforming to the **exact same, unmodified** `src/promise/types.ts` schema — Intake Interview is a new *authoring path* into that schema, never a schema change. Fields Kairos owns and never lets the model author (`id`, `version`, `clientId`, `provenance`, `status`) stay exactly as locked-down as `plan.ts` already keeps them.

### Files/subsystems likely affected

- **NEW** `src/promise/intake.ts` — session state machine, question sequencing, turn-by-turn contract refinement.
- **NEW** `src/promise/intake-types.ts` — `IntakeSession`, `IntakeTurn`, `IntakeQuestionCategory`.
- **MODIFY** `src/cli.ts` — new `kairos contract intake` command family.
- **MODIFY** `src/promise/store.ts` (or a small sibling module) — session persistence, so an interview can be paused and resumed rather than requiring one unbroken terminal session.
- **Possibly** `src/mcp-server.ts` — an MCP-tool-shaped surface for chat-based hosts (Claude Code, Claude Desktop), since a blocking terminal REPL is a poor fit for that surface and Kairos already ships `kairos-mcp`. Flagged as an open design question below, not committed to.

### Data models/types needed

```ts
export type IntakeQuestionCategory =
  | 'trigger' | 'terminal' | 'branch' | 'owner' | 'sla' | 'evidence'
  | 'missing_data' | 'late_response' | 'duplicate' | 'do_not_automate'

export interface IntakeTurn {
  id: string
  askedAt: string
  question: string
  questionCategory: IntakeQuestionCategory
  answer?: string
  answeredAt?: string
}

export interface IntakeSession {
  id: string
  clientId: string
  status: 'in_progress' | 'ready_for_review' | 'abandoned'
  turns: IntakeTurn[]
  /** Refined after every turn -- never treated as final until a human explicitly runs
   * `contract import`, the exact same promotion gate every other authoring path already uses. */
  draftContract: Partial<ProcessContract>
  createdAt: string
  updatedAt: string
}
```

### CLI/API surface

- `kairos contract intake start --client-id <slug> [--resume <session-id>]` — one question per turn, printed to stdout, answer read from stdin.
- `kairos contract intake status <session-id> --client-id <slug> [--json]` — progress and current draft completeness.
- On completion, writes the draft exactly where `contract plan` writes today (`~/.kairos/contracts/<client-id>/<id>.json`), running the same `validateProcessContract()` gate, same `draft`/`needs_confirmation` status split.

### Tests/checkpoints

- Unit tests against an injected mock `AnthropicMessagesClient`, driving a scripted turn sequence, asserting the resulting draft's shape and that validation runs at the end.
- A resumability test: start, stop mid-session, resume, confirm state is intact and no turn is repeated or lost.
- A **live checkpoint** (not a unit test) with a real `ANTHROPIC_API_KEY`: run one full interview for a synthetic scenario (reusing the website-contact-form scenario from this session's own synthetic validation gives a ready-made, already-understood target) and confirm the resulting contract passes `validateProcessContract()` with no manual JSON editing.

### Guardrails

- Never skip `validateProcessContract()`. Never auto-import or auto-activate a contract from an interview — a human runs `contract import` explicitly, same as every other path. No autonomous inference of an unstated business rule (e.g., never invent an SLA duration; if unanswered, record it as a `needs_confirmation` assumption, exactly like `plan.ts`'s one-shot draft already does).

### What not to build yet

No voice/phone intake. No multi-user/collaborative sessions. No auto-drafting a full contract from an uploaded SOP or document (that is closer to "Operations Scout," explicitly deferred in both source documents, not part of this plan). No branching-question DSL — a fixed, curated question bank plus LLM-authored follow-up text, never a formal decision-tree language (the "no guard DSL unless tiny and necessary" guardrail applies directly here).

### Risks/open questions

Terminal REPL vs. MCP tool-call surface — genuinely open, needs a decision before implementation, not during it. How much should the LLM be allowed to generate dynamic follow-up questions vs. stick to the fixed bank — fully fixed is safer and easier to test deterministically; fully dynamic is more powerful but harder to regression-test. Session resumability is real state-management complexity — worth asking explicitly whether v0 truly needs it or can require one sitting first, and add resumability once real usage shows it's needed.

### Definition of done

A human runs `kairos contract intake start`, answers a guided question set about a real or synthetic business process, and receives a `ProcessContract` draft that passes `validateProcessContract()` with zero manual JSON editing — checkpointed live against at least one real business description, and shown (even informally) to need no more manual contract editing afterward than today's one-shot `contract plan` needs for an equally messy description.

### Shipped (2026-07-21)

Built as designed above, with two real refinements found only once real code and a real live checkpoint existed:

- **Synthesis reuses `planProcessContract()` completely unmodified**, rather than a separate synthesis function as first sketched — the full Q&A transcript (plus any refinement-round follow-ups) is itself rendered as one plain-text `description` string and passed straight into `plan.ts`'s existing prompt/parse/validate pipeline. Zero new prompt template, zero new JSON-coercion code; this feature inherits every future improvement to `plan.ts`'s own prompt for free. `src/promise/intake.ts`, `intake-types.ts`, `intake-store.ts` (new); `src/cli.ts` (`kairos contract intake start`/`status`).
- **MCP surface deliberately not built this pass** — `src/mcp-server.ts` is architected around a "host LLM generates, Kairos validates, zero Anthropic key needed" model, structurally different from intake's own synthesis step (which needs Kairos's own Anthropic call, exactly like `contract plan`). Reconciling the two is a real design question, left open rather than guessed at under a "smallest useful" scope.
- **A real, live-checkpointed run** (scripted 11-answer interview for a synthetic vendor-invoice-processing scenario, deliberately different from every other fixture in this codebase, run against real Anthropic infrastructure in an isolated scratch `HOME`) exercised the full loop end to end, including **both** refinement-round failure modes for real, not hypothetically: round 1 hit a genuine blocking assumption (an ambiguous correlation-key extraction mechanism), round 2 hit a genuine validator error the model itself introduced (a terminal state with an outgoing transition), and round 3 converged clean — independently re-confirmed by a second, separate call to `validateProcessContract()` outside the session's own tracking. Final draft: 9 states, 17 transitions, 2 SLAs, 6 exceptions, owner assignments matching the scripted answers exactly.
- **A real timing finding from that checkpoint**: each synthesis call took ~70–90 seconds wall-clock (three rounds, ~4 minutes total) — long enough that a human with no feedback would reasonably assume the process had hung (this happened during debugging: a first checkpoint attempt was killed at the 2-minute mark on that assumption, before debug timing proved it was still correctly in flight). Fixed with a small, honest `onSynthesisStart` progress callback ("Drafting from your answers... this typically takes 60-90 seconds"), printed before every synthesis/refinement call in the real CLI.
- 22 new tests (`tests/unit/promise/intake.test.ts`, `intake-store.test.ts`) covering the question bank, transcript building, follow-up generation, full orchestration (including resuming mid-fixed-questions and resuming mid-refinement-round with a partially-answered follow-up batch), and session isolation/persistence. Full suite 1837 → 1859, typecheck/lint/docs-drift clean, verified against the real built binary (`--help`, usage errors, exit codes, `intake status` against an unknown session).

---

## 5. Phase 5 — Contract Scenario Generator

### What it is

Given a validated `ProcessContract`, deterministically generate a set of `ContractScenario` objects (§3.1) — synthetic instances of the entity moving through the contract's states, covering the specific edge-case categories both source documents name: happy path, missing data, duplicate entity, late response, no response, after-hours event, pause/resume, and expiration. This formalizes, as a real generator, exactly what this session's own synthetic contact-form validation did by hand once (`seed-cases.mts` + `truth-table.md`, five hand-written cases with a hand-written expected outcome for each).

### Why it matters

This is the artifact every later phase in this arc (6, 7, 8, 9) consumes. Hand-writing scenarios per contract, the way this session did once as a validation exercise, doesn't scale past a single demo — the entire value proposition of a Contract Harness depends on scenarios being generated automatically and consistently *from the contract's own structure*, the same way `compileToPackPlan()` already deterministically walks a contract's structure to produce workflow descriptions rather than requiring a human to hand-write each `WorkflowPlan`.

### How it connects to existing modules

Structurally mirrors `src/promise/compile.ts`: a deterministic walk over `contract.states`/`transitions`/`exceptions`/`sla`/`expirationRules`/`pauseRules`, generating one scenario per interesting combination, carrying the exact same `sourceElements: string[]` traceability discipline `ContractWorkflowTrace` already established for workflows. No Anthropic call in the core generator, for the identical reason `compile.ts` has none: every fact needed is already structured data sitting on the contract, and a second LLM pass between a validated contract and its test scenarios would reintroduce exactly the class of "a new, higher-stakes place to be wrong" risk the plan doc for Promise Engine v0 already named and avoided once (§11 of `process-contract-promise-engine-plan.md`).

### Files/subsystems likely affected

- **NEW** `src/promise/scenario.ts` — `generateContractScenarios(contract: ProcessContract): ContractScenario[]`, one generator function per `ScenarioCategory`.
- **NEW** `src/promise/scenario-types.ts` — as drafted in §3.1.
- **MODIFY** `src/cli.ts` — `kairos contract scenarios generate <file.json> [--categories <list>] [--out <dir>] [--json]`.
- **Possibly** a persistence convention alongside every other per-contract path already in place: `~/.kairos/contracts/<client-id>/<contract-id>/scenarios/<scenario-id>.json`.

### Data models/types needed

The `ContractScenario`/`ScenarioTimelineEvent`/`ScenarioExpectedOutcome` types from §3.1, plus the category taxonomy — a **fixed enum with one template-driven generator function per category**, never LLM-invented categories:

- `happy_path` — one instance per `StartCondition`, walking the expected transition chain to a `success` `TerminalOutcome` comfortably inside every applicable SLA.
- `missing_data` — one per `EvidenceRequirement`, omitting a required field.
- `duplicate_entity` — two `instance_start` timeline entries under the same `correlationKeyValue` — this is exactly Case E from this session's synthetic validation (Finding 3's ambiguity stopgap), now generated automatically instead of hand-written.
- `late_response` / `no_response` — walks toward an SLA breach (`at_risk` / `missed`), the second omitting the eventual evidence entirely.
- `after_hours` — generated only when `contract.businessCalendar` is present; a start event timestamped outside `weeklyHours`, reusing `src/promise/business-calendar.ts`'s own logic to compute a genuinely-outside-hours offset rather than guessing.
- `pause_resume` — generated only when `contract.pauseRules` is present.
- `expired` — generated only when `contract.expirationRules` is present; a state held past its `after` duration with no qualifying transition.

### CLI/API surface

`kairos contract scenarios generate <file.json> [--categories <list>] [--out <dir>] [--json]`. Output: one JSON file per scenario, plus a human-readable summary table (name, category, expected status/exception count) — deliberately reusing the truth-table.md *style* from this session's synthetic validation as the canonical human-readable format, since that format already proved itself as something a human can verify by eye before trusting the generator's output.

### Tests/checkpoints

Golden-fixture tests against two deliberately different contracts — the Empire-referral-shaped fixture and the incident-response pressure-test contract `src/promise/types.ts`'s own doc comments reference (Phase 0's pressure test, plan doc §4.5b) — asserting the exact expected scenario set and count per category, a strong regression guard against silent generator drift. A "categories respect contract capability" test: confirm zero `after_hours` scenarios are generated when `businessCalendar` is absent, zero `pause_resume` when `pauseRules` is absent — mirroring exactly how `compile.ts`'s `buildEscalationWorkflow` already conditionally includes calendar/pause text only when the fields are present.

### Guardrails

Every `correlationKeyValue` must be obviously synthetic (the `.test`-TLD convention or an equally unambiguous pattern) — never derived from real client data, since generator output may be committed to a repo or shared as a fixture. Every scenario carries `sourceElements` traceability. No fabricated ROI/value language anywhere in generated output.

### What not to build yet

No scenario generation informed by real historical `ProofLedger` history (that needs real execution history to mine from — a materially different, later idea, closer to a future "scenario mining" capability, not v0). No exhaustive combinatorial enumeration of every possible state × SLA × exception combination — a curated, bounded set per category, matching the deliberate restraint `compile.ts` already shows (three workflow types, not one per contract element).

### Risks/open questions

Should timeline offsets be business-hours-aware (via `business-calendar.ts`) or simple wall-clock-relative? A contract with `businessCalendar` genuinely needs the former for `after_hours`/business-days-SLA scenarios to mean anything; a contract without one should stay simple. How many scenarios per category is "enough" before the output becomes noise a human stops reading carefully? Needs a sensible per-category cap, configurable, not unlimited generation.

### Definition of done

`kairos contract scenarios generate` produces a deterministic, fully-traceable, fully-synthetic scenario set for any valid `ProcessContract`, covering at minimum `happy_path` + `missing_data` + `duplicate_entity` + `late_response`/`no_response`, matching — in rigor and in spirit — the hand-built synthetic validation truth table from this session, but generated rather than hand-written.

### Shipped (2026-07-21)

Built as the paired arc with Phase 6 (§6's own Shipped note has the harness-side detail; this note covers generation). `src/promise/scenario-types.ts` (new), `src/promise/scenario.ts` (new) — `generateContractScenarios(contract, categories?)`, one function per category matching Codex's exact 7-item v0 list (happy_path, missing_data, failure_terminal, no_response, duplicate_correlation, after_hours, in_progress), each returning either a `ContractScenario` or a reasoned `ScenarioGenerationSkip`. `kairos contract scenarios generate <file.json> [--categories <list>] [--out <dir>] [--json]` wired into `cli.ts`.

**The single most load-bearing design rule, confirmed correct only after reading real code directly (not assumed): a generated scenario never fabricates an 'evidence' timeline event for a transition without a matching `EvidenceRequirement`.** Real `ledger.ts` extraction could never produce such an entry either — `compile.ts`'s `evidenceNodeName()` marker-node convention only exists for evidence-requirement-tagged transitions. This rule, applied honestly, produced the single biggest surprise of this whole phase:

**A real, significant finding about both other checked-in fixtures' own evidence-completeness**, discovered by generating scenarios against them, not assumed in advance: neither `tests/fixtures/contracts/empire-homecare-referral-intake.json` nor `saas-p1-incident-response.json` has an `EvidenceRequirement` covering *any* transition into *any* terminal outcome — meaning `happy_path`, `failure_terminal`, and `after_hours` are genuinely **not generatable** for either fixture as currently authored, correctly reported as skips with a stated reason rather than faked. Concretely: Empire Homecare's only `EvidenceRequirement` covers `t-attempted-to-contacted` (a transition into the non-terminal state `contacted`); its `scheduled`/`declined`/`no_answer` terminal states have zero evidence coverage. SaaS's two `EvidenceRequirement`s (`t-raised-to-ack`, `t-updating-self-loop`) are both on non-terminal-producing transitions too. **In real operation, as currently specified, neither contract could ever produce a confident `kept` classification for its own success path** — a genuine, previously-undiscovered specification gap in two fixtures that have been used throughout this whole project's own test suite since Phase 0, surfaced only because a generator now exists that has to honestly ask "which transition would real evidence for this actually come from" for every scenario it builds. This is exactly the class of finding both source documents' whole thesis is built around. A third, purpose-built fixture (`website-contact-form-ack.json`, promoted from this session's own earlier hand-built synthetic validation, already proven evidence-complete) was added to `tests/fixtures/contracts/` specifically so all 7 categories have at least one real, checked-in fixture that can demonstrate every one of them — Empire Homecare and the SaaS contract remain as deliberately contrasting, partially-skipped fixtures, their own skips now a permanent regression assertion (see harness.test.ts's own tests) rather than a one-off observation.

**Two real bugs were found and fixed in the generator itself** (not production code) via this phase's own design-verification discipline — generate scenarios, run them through the real harness, and treat any surprise as a bug until proven otherwise, rather than trusting hand-derived expectations blindly:
1. `no_response`'s expected exception count originally only counted `SlaSpec`s measured from the start state, missing that an `ExpirationRule` whose own `state` *also* equals the start state drifts too (found live against `website-contact-form-ack.json`, whose `exp-received-stuck` rule targets `received` itself, unlike Empire Homecare's equivalent rule which targets a later state) — fixed by also counting `ExpirationRule`s targeting the initial state.
2. `after_hours`'s evidence-event timing was computed independently of the closed-instant it was supposed to follow (a flat "5 minutes before now" instead of "shortly after the calendar reopens following the closed instant"), which could span several real business days depending on what day the harness happened to run, breaking the very business-hours-awareness the scenario exists to prove — fixed by pairing a `closedInstant`/`nextOpenInstant` computation together, with a safety guard (step back whole weeks) for the edge case of a sparse calendar where the naive forward walk could land in the future relative to "now."

Both bugs were caught by immediately running generated output through the real harness before trusting any hand-written expectation, not by code review alone — direct evidence this phase's own "verify live, don't just reason" discipline (carried from every earlier phase in this arc) catches real defects in new code, not only in the code being tested.

15 new unit tests (`tests/unit/promise/scenario.test.ts`), full suite 1867 → 1893 (combined with Phase 6's own 11), typecheck/lint/docs-drift clean, verified against the real built binary.

---

## 6. Phase 6 — Kairos Contract Harness (Node Harness v0)

### What it is

A deterministic, fully offline Node.js runner that takes a `ContractScenario` (Phase 5) and computes its expected `ProofLedgerEntry[]` in memory, then runs that array through the **real, unmodified** `checkSlaCompliance()` → `updateExceptionDesk()` → `classifyPromiseInstance()` → `buildPromiseReportData()` chain, comparing the result against the scenario's `expected` outcome. This is `Futrure copy.txt` §7's "Kairos Contract Harness v0" — Jordan's own favorite name from that document, chosen there specifically because *"it says exactly what it does: tests the contract"* — now formalized as a real module rather than the one-off scratch scripts (`seed-cases.mts`, `run-compliance.mts`) this session used once, by hand, to prove the same approach works.

### Why it matters

This is the technical crux of the whole arc. `Futrure copy.txt`'s own closing recommendation: *"The highest-leverage new technical idea is: Kairos Contract Harness... That is the bridge between what Kairos is now and what it can become."* It turns promise-evaluation logic (`sla-compliance.ts`/`exception-desk.ts`/`report.ts`) into something regression-testable without needing live n8n for every check — and this session already has direct, load-bearing evidence the approach works technically, because the manual version of it produced zero mismatches against a hand-written truth table across five genuinely different cases, including one (Case C) that surfaced a real, previously-undocumented system boundary (ExceptionDesk's time-based-only reaction) that is now part of the shipped v0.12.0 documentation.

### How it connects to existing modules

Calls the same functions the synthetic validation called directly, verified today against real current signatures: `checkSlaCompliance(contract, entries: ProofLedgerEntry[], now)`, `complianceVerdict(findings)` (`sla-compliance.ts`); `updateExceptionDesk(contract, findings, existingItems, now)` (`exception-desk.ts`); `classifyPromiseInstance(contract, instanceEntries, instanceExceptions, now)` and `buildPromiseReportData(...)` (`report.ts`); `hashCorrelationKeyValue(value)` (`ledger.ts`). **A concrete design finding from today's codebase reading, worth stating explicitly because it materially simplifies this phase**: every one of these functions already takes plain in-memory arrays, never a file path or a live poll. This means the harness never needs to touch `ledger-store.ts`/`exception-store.ts`, never needs a scratch `HOME`/filesystem-isolation trick the way this session's synthetic validation did (that script specifically exercised the storage layer too, which the harness does not need to do — see §9 for where storage-layer testing belongs instead). The harness is a thin, pure-function test rig, not a second storage-backed system.

### Files/subsystems likely affected

- **NEW** `src/promise/harness.ts` — `runContractHarness(contract: ProcessContract, scenarios: ContractScenario[]): HarnessResult`.
- **NEW** `src/promise/harness-types.ts` — `HarnessResult`, `ScenarioRunOutcome`.
- **MODIFY** `src/cli.ts` — `kairos contract harness run <file.json> [--scenarios <dir-or-file>] [--json]`.

### Data models/types needed

```ts
export interface ScenarioRunOutcome {
  scenarioId: string
  scenarioName: string
  category: ScenarioCategory
  passed: boolean
  actual: {
    reportStatus: PromiseInstanceStatus
    evidenceQuality?: 'specific' | 'generic'
    exceptionCount: number
    exceptionKinds: ExceptionKind[]
  }
  expected: ScenarioExpectedOutcome
  mismatches: string[]
}

export interface HarnessResult {
  contractId: string
  contractVersion: number
  scenarioResults: ScenarioRunOutcome[]
  passCount: number
  failCount: number
}
```

### CLI/API surface

`kairos contract harness run <contract-file.json> [--scenarios <dir-or-file>] [--json]` — fully offline, no n8n, no network, exits 1 if any scenario fails (matching `preflight`'s own scriptable exit-code convention), 0 if every scenario passes. When `--scenarios` is omitted, auto-generates via Phase 5 first, so the two phases chain naturally as one command for the common case.

### Tests/checkpoints

Unit tests directly porting the exact scenario set from this session's synthetic validation (Cases A through E) as a golden fixture — since that scenario was already hand-verified against a truth table with zero mismatches, it is a ready-made, high-confidence regression fixture, not a hypothetical one. A deliberate-mismatch test: construct a scenario whose `expected` is wrong on purpose, confirm the harness reports a failure with an accurate mismatch description — proves the harness actually discriminates rather than trivially always passing.

### Guardrails

No n8n, no network, no filesystem writes to `~/.kairos/` by default — pure in-memory, fast, CI-safe. The harness never decides a contract is "correct" in any absolute sense — it only proves internal consistency (does the promise-evaluation logic classify this synthetic evidence the way the contract author expected). It says nothing about whether real n8n execution will actually *produce* that evidence — that is explicitly Phase 7's and Phase 10's job, not this one's, and the harness's own output language should say so plainly (evidence-graded self-consistency check, not a guarantee the workflow behaves this way).

### What not to build yet

No mocked HTTP/API layer, no fake n8n node-execution simulation — the harness works purely at the `ProofLedgerEntry` level and never simulates what a workflow's individual nodes would do. No performance/load-testing angle.

### Risks/open questions

Should `buildPromiseReportData`'s window-filtering (`--from`/`--to`) matter for harness scenarios? Likely not for v0 — scenarios should check classification correctness, not report-window edge cases, which are a separate, narrower concern. Each scenario needs to specify (or the harness needs to infer from the timeline) what "now" should be when `checkSlaCompliance`/`classifyPromiseInstance` evaluate it — mirroring the "generous relative-to-real-now offsets" principle from §3.1/§3.4 for determinism across repeated runs on different days.

### Definition of done

`kairos contract harness run` executes fully offline against any valid `ProcessContract` + scenario set and reproduces — field for field — this session's own synthetic validation truth table when run against an equivalent scenario set, proving the harness is a faithful, permanent formalization of what was already manually validated once by hand.

### Shipped (2026-07-21)

Built exactly to the design already proven by this session's own earlier synthetic validation: `src/promise/harness-types.ts` (new), `src/promise/harness.ts` (new) — `runContractHarness(contract, scenarios, now?)` / `runScenario(contract, scenario, now?)`, both calling the real, unmodified `checkSlaCompliance()`, `updateExceptionDesk()` (with `existingItems: []`, since a fresh harness run has no prior exception history to refresh against), and `classifyPromiseInstance()` — confirmed directly against current signatures before writing this that all three already accept plain in-memory arrays, so the harness never touches `ledger-store.ts`/`exception-store.ts`, never needs file I/O or a scratch-`HOME` isolation trick the way this session's own hand-built validation once did. `kairos contract harness run <file.json> [--scenarios <dir-or-file>] [--json]` wired into `cli.ts`, chaining Phase 5's generator automatically when `--scenarios` is omitted.

**The single most significant finding of this entire paired arc, empirically confirmed (not just reasoned about) via the harness's own `missing_data` scenario against the primary fixture, then FIXED same-day at Codex's explicit direction**: `stateReachSignals()` (`sla-compliance.ts`) and `classifyPromiseInstance()` (`report.ts`) never inspected `ProofLedgerEntry.status` anywhere — an entry with `status: 'unverifiable'` (`ledger.ts`'s own real outcome for a marker node found with a required field genuinely missing) was treated **identically** to a complete `status: 'observed'` entry throughout the entire SLA/exception/classification chain. Concretely, run live against `website-contact-form-ack.json`: an evidence entry for `t-received-to-acknowledged` missing its `ownerAssigned` field, marked `unverifiable`, produced a confident `kept` classification — the exact same result a fully complete entry would produce. Against Empire Homecare's fixture, the same gap showed up more subtly: an incomplete `t-attempted-to-contacted` entry still satisfied `sla-first-contact`'s clock-end condition, turning what should have been an uncertain SLA finding into a confident `healthy` one. This was precisely the "confidently report the wrong business outcome" class of defect the P0 measurement-integrity fix pass (2026-07-20, before this arc) was built to close, and it was missed — `ProofLedgerEntry.status` was added as part of that same fix pass but its `'unverifiable'` value was never actually consulted by any downstream consumer.

**The fix (2026-07-21, same day):** `StateReachSignal` (`sla-compliance.ts`) gained a `verifiable: boolean` field, orthogonal to its existing `confidence` field (`confidence` is about *how* an entry implies reach — direct vs. inferred; `verifiable` is about whether the entry's own evidence is complete). `stateReachSignals()`/`eventSignals()` now set it from `entry.status !== 'unverifiable'` (always `true` for `instance_start`, which has no marker-node/required-fields concept to be incomplete about) and sort verifiable signals before unverifiable ones regardless of timing (`compareSignals()`) — so `signals[0]` is always "the best available evidence," and `signals[0]!.verifiable === false` is a precise, sufficient test for "the ONLY evidence available is unverifiable," never a false positive from an earlier incomplete entry shadowing a later complete one. Every consumer of a `stateReachSignals()` result now checks this explicitly and returns `PromiseComplianceStatus: 'unverifiable'` / `PromiseInstanceStatus: 'unverifiable'` rather than proceeding to a confident verdict: `checkSlaForInstance()` (both the clock-start and clock-end signal), `checkRecurringSlaForInstance()` (the enter signal, **and** its own separate inline "exited" check and cadence-heartbeat computation, which had the identical unchecked-`.status` pattern independently), `checkExpirationRuleForInstance()` (the enter signal, and its own inline "exited" check, same pattern again), and `classifyPromiseInstance()`'s terminal-outcome loop (applied uniformly to every outcome type — a confidently wrong `missed` built on unconfirmed evidence is just as dishonest as a confidently wrong `kept`, not just the success case). `'observed'`/`'asserted'`/`'verified'` entries are completely unaffected — confirmed by dedicated regression tests, not just by absence of a reported failure.

**A second, real bug found while fixing the first one, exposed the moment the primary fix started returning `'unverifiable'` from new code paths**: `classifyPromiseInstance()`'s own fallback messages (`pauseAffected.length > 0`, both inside and after the terminal-outcome loop) hardcoded *"this contract declares pause rule(s) that Kairos's SLA compliance checking does not yet account for"* — text that was accurate when `'unverifiable'` could only ever come from the pause-rule caveat, but became actively misleading once a second, independent cause (unverifiable evidence) could produce the same status. Empire Homecare and the SaaS fixture — neither of which declares any `pauseRules` — showed exactly this false message in live verification before the fix. Renamed `pauseAffected` to `unverifiableFindings` and rewrote both messages to quote the underlying finding's own `summary` (which already names the real cause precisely in every case) instead of asserting a specific cause that may not be true.

**A real finding about test performance, unrelated to correctness**: `businessMinutesBetween()` (`business-calendar.ts`) walks minute-by-minute between two timestamps and constructs a fresh `Intl.DateTimeFormat` instance *per minute* (uncached) — the module's own doc comment asserts this is "well under a second" at realistic SLA scale, which is true, but the `no_response` scenario's first, most-generous-possible offset (60 calendar days, chosen purely for safety margin) produced an 86,400-minute walk per SLA/expiration check, measured at several real seconds across this phase's own test suite (`tests/unit/promise/harness.test.ts` alone: 32.9s). Reduced to 7 calendar days — still nearly double the worst realistic case across all three fixtures (Empire Homecare's longest initial-state-measured SLA is 4 business hours) — cutting the same test file to 3.97s in isolation. Not a production-code defect, but a real, concrete data point for Phase 9's own upcoming "make this part of the default `npm test` suite" work.

A deliberate-mismatch test (construct a scenario whose `expected` is wrong on purpose) confirms the harness actually discriminates rather than trivially always passing. The `missing_data` scenario's own `expected.reportStatus` was updated from `'kept'`/`'in_progress'` (the pre-fix, now-incorrect prediction) to `'unverifiable'` (the corrected, current behavior) in `scenario.ts`, and `harness.test.ts`'s corresponding test was renamed from "THE REAL FINDING" to "P0-2 REGRESSION GUARD," now asserting the fixed behavior and guarding against ever silently regressing back to the original bug. 14 new low-level unit tests were added directly to the pre-existing `sla-compliance.test.ts` (8 tests) and `report.test.ts` (5 tests) suites — reusing their own established fixture/timestamp helpers rather than only testing through the higher-level scenario/harness abstraction — covering every fixed function individually: unverifiable-only signals producing `'unverifiable'`; a later verifiable entry correctly preferred over an earlier unverifiable one (never silently shadowed); `'observed'` entries completely unaffected (explicit regression guard); the two independently-broken inline "exited"/heartbeat checks in the recurring-SLA and expiration-rule functions. Full suite 1893 → 1907, typecheck/lint/docs-drift clean. A broader codebase search (`grep -rn "fromState ===|toState ===|initialState ==="`) confirmed every instance of this bug pattern lived in `sla-compliance.ts` alone and all were fixed — no other file in the codebase matches the pattern.

---

## 7. Phase 7 — Replay Upgrade: expected business outcomes

### What it is

Extends the existing replay/shadow-testing system (`runReplay`/`diffPayloadExecution`, `src/reliability/replay/`) so that, when a workflow is registered against a `ProcessContract`, a replay run additionally checks the *actual* n8n sandbox execution's evidence output against a `ContractScenario`'s expected outcome — not only "did the candidate behave like baseline," but "did the candidate produce the business evidence the contract says it should."

### Why it matters

Directly targets the "workflow ran green but was wrong" problem named explicitly in `Futrure copy.txt` §8. Verified against current code: today's replay (`diffPayloadExecution`) compares two n8n executions structurally against **each other** — node coverage, output shapes, errors, durations — with zero concept of whether either one is business-correct. A workflow that writes `Link` instead of `link`, or leaves a required evidence field empty, passes today's replay as `IDENTICAL` or `BENIGN_VARIANCE` as long as baseline made the identical mistake (or if there is no baseline at all, a first-ever build has nothing to diff against structurally, yet could still be silently wrong).

### How it connects to existing modules

Strictly additive on top of `PayloadDiffResult` — never a replacement for the existing structural diff. Reuses `sandbox/manager.ts`'s `importToSandbox` and `replay/runner.ts`'s `replayOnePayload` for real sandbox execution unchanged, then feeds that execution's raw output through the **same** `extractExecutionEvidence()` (`src/promise/ledger.ts`) the real ProofLedger poller uses in production — so "does this sandbox execution's evidence match expectations" is checked with the exact extraction logic that will run against real traffic later, never a second, parallel parser that could quietly disagree with the first.

### Files/subsystems likely affected

- **MODIFY** `src/reliability/replay/diff.ts` — a new, optional `businessOutcomeCheck` field alongside `PayloadDiffResult`, populated only when the replay run is contract-aware.
- **MODIFY** `src/reliability/replay/runner.ts` — `runReplay()` gains an optional `contract`/`scenario` parameter; when present, calls `extractExecutionEvidence()` against each sandbox execution's raw data and classifies it the way Phase 6's harness classifies synthetic data — except now on real n8n sandbox output.
- **MODIFY** `src/cli.ts` — `kairos replay run <id> --candidate <file> --client-id <slug> --contract <contract-id> [--scenario <id>]`.
- **New cross-boundary import**: `src/reliability/replay/` reading `src/promise/ledger.ts` and `src/promise/types.ts` — see §3.3 for the exact, narrow boundary this requires and the new firewall test it needs.

### Data models/types needed

```ts
export interface BusinessOutcomeCheckResult {
  scenarioId?: string
  expected: ScenarioExpectedOutcome
  /** In-memory only -- never persisted to the real ledger. A sandbox execution's evidence must
   * never be mistaken for, or written alongside, real production ProofLedger data. */
  actualExtractedEntries: ProofLedgerEntry[]
  actualClassification: PromiseInstanceClassification
  matched: boolean
  mismatches: string[]
}
```

### CLI/API surface

`kairos replay run <id> --candidate <file> --client-id <slug> --contract <contract-id> [--live]` — when `--contract` is present and the workflow is already registered against it (reusing `registry.ts`'s existing lookup unchanged), runs the normal structural diff *and* the new business-outcome check, and reports both. **The combined verdict must be the worse of the two** — a clean structural `IDENTICAL` diff must never mask a business-outcome mismatch; this needs to be stated explicitly in the report format, not left implicit.

### Tests/checkpoints

Unit test: a sandbox-execution-snapshot fixture with correct structure but a casing bug in an evidence field (`Link` vs. `link`) — confirm the business-outcome check catches it even though a purely structural diff would call it clean. **Live checkpoint**: reusing this session's own disposable-workflow discipline (a `TestWidget`-prefixed, clearly-disposable registered contract), prove the extraction-from-sandbox-execution path works against a real n8n sandbox execution, not only a hand-built fixture.

### Guardrails

Inherits `assertNotProduction()` completely unchanged — this feature only ever touches the sandbox, never production, exactly like every existing replay/chaos capability. Never invents a second evidence-extraction implementation — reusing `extractExecutionEvidence()` is the single most important correctness guardrail in this phase, since two independent parsers of the same execution JSON could disagree and neither would obviously be right.

### What not to build yet

No automatic contract inference for a workflow that isn't already registered against one — strictly additive to workflows already compiled via Phase 2's existing `compile.ts`/`registry.ts` machinery. No auto-repair triggered by a business-outcome mismatch — report only, same human-in-the-loop discipline `repair propose`/`apply` already enforce for structural drift.

### Risks/open questions

Real captured payloads (`replay capture`, from real production traffic) and Phase-5-generated synthetic scenarios are different inputs with different guarantees — a real captured payload has no pre-written "expected outcome" the way a generated scenario does. These two replay modes (structural-only vs. contract-aware) need to stay clearly distinguished in the CLI surface and the report, not conflated into one code path that quietly behaves differently depending on input.

### Definition of done

`kairos replay run --contract <id>` takes a Phase-5-generated scenario, replays it through a real n8n sandbox, extracts evidence with the exact code the ProofLedger poller uses in production, and correctly flags a deliberately-broken evidence-mapping bug that a purely structural replay diff would have called clean.

### Shipped (2026-07-21)

**A real architectural constraint, found by reading `compile.ts` directly before writing any code, that reshaped this phase's whole scope**: `compile.ts` always splits a contract into separate workflows (intake, processing, SLA-escalation). A single sandbox execution against one workflow's own webhook can only ever produce the evidence *that workflow's own execution* generates. For the intake workflow, that is exactly one thing: an `instance_start` entry (`ledger.ts`'s own `extractExecutionEvidence()`, given a `StartCondition`, records this automatically from the trigger firing — no marker node needed). State-transition evidence (an `EvidenceRequirement` marker node) normally lives in the *separate* processing workflow, which `compile.ts`'s own prose deliberately leaves free to use a non-webhook trigger — meaning it may not even be replay-eligible via the existing `findWebhookTrigger()`-gated mechanism at all. **Scope was set accordingly, stated plainly rather than overclaimed**: this phase checks one real thing — does replaying a scenario's own correlation-key-bearing intake payload against the registered intake workflow produce a real `instance_start` entry with the right initial state and correlation key. It does not attempt to validate a scenario's full `expected` classification (which assumes processing-workflow evidence this replay never touches) — every result carries an explicit, unconditional `scopeCaveat` string saying so.

**Shipped**: `src/reliability/replay/contract-outcome.ts` (new) — `checkScenarioIntakeOutcome()` (the sandbox-owning orchestrator: import → activate → inject a scenario-derived payload via the existing `replayOnePayload()` unchanged → extract real evidence → compare → always clean up) and `evaluateScenarioIntakeOutcome()` (the pure comparison, pulled out specifically so "a passing scenario and a mismatch scenario" could be proven deterministically — the same orchestrator-vs-pure-sub-piece split `runner.ts` already established for `runReplay()`/`replayOnePayload()`). `src/reliability/replay/runner.ts` gained one additive field: `SinglePayloadRunOutcome.rawExecution` (the raw execution `{id, startedAt, data}` `replayOnePayload()` already fetches via `client.getExecution()` — confirmed `includeData` defaults to `true` — but previously discarded after building the shape-only `ReplayExecutionSnapshot`). **A real, load-bearing finding confirmed while reading `diff.ts` before writing anything**: `ReplayExecutionSnapshot`'s own doc comment already says its `outputShape` is "shape only, never real values" — meaning the *existing* structural-diff snapshot could never have been reused for business-outcome checking even before this phase started; `extractExecutionEvidence()` needs real field values, so this phase reads the raw execution data `replayOnePayload()` was already fetching, at zero extra network cost, rather than trying to repurpose the shape-only snapshot. `kairos replay run <id> --candidate <file> --client-id <slug> --contract <file.json> [--scenario <id>]` wired into `cli.ts` as a genuinely separate, independent block from the existing `runReplay()` call (needs no captured payloads at all) — reported as its own "Contract Outcome Check" section, with the combined exit code the worse of the structural and contract-outcome results, per this section's own original design note.

**Module boundary**: a new, narrow, explicit allow-list added to `tests/unit/reliability/module-boundaries.test.ts` — `reliability/replay/` may import exactly `promise/ledger.js`, `promise/ledger-types.js`, `promise/types.js`, `promise/scenario-types.js`, and is asserted to never import the file-backed persistence layer (`promise/ledger-store.js`, `exception-store.js`, `store.js`) or reference a promise-engine storage path literally — so a sandbox execution's synthetic-context evidence can never be mistaken for, or accidentally written alongside, a real client's real ProofLedger files.

**A real bug found and fixed via live testing — not caught by unit tests, because the unit tests exercised `evaluateScenarioIntakeOutcome()` directly with hand-built entries, bypassing the payload-construction step entirely**: the first version of `scenarioIntakePayloadBody()` set the scenario's correlation key at the *full* `contract.correlationKey.fieldPath` (e.g. `"body.email"`) directly on the raw HTTP payload sent to the webhook. But n8n's webhook trigger automatically wraps whatever raw JSON is POSTed under its own output's `.body` key — confirmed directly against a real sandbox execution's `runData` (a debug pass run specifically to inspect this after the first live checkpoint attempt came back with zero extracted entries) — so the real trigger output ended up with the correlation key at `body.body.email`, not `body.email`, and `extractExecutionEvidence()` correctly (and honestly) found nothing, rather than a false match. Fixed by stripping the `"body."` prefix before constructing the raw payload; a `query.`/`headers.`-prefixed correlation key remains a named, honest, deliberately-unhandled v0 limitation (falls back to the literal path) since every checked-in fixture is body-prefixed and it is a materially rarer real shape. Locked in with 3 new regression tests (`scenarioIntakePayloadBody`, directly).

A second, minor, checkpoint-script-only issue (not a product bug): a hand-built minimal test workflow needs a `settings: {}` field for n8n's real `POST /workflows` API to accept it — the `N8nWorkflow` type allows it as optional, but the live API requires it; real `Kairos.build()`-generated workflows always include one, so this was never visible in existing tests.

**Live-checkpointed against a real local n8n sandbox** (never production, matching every existing replay/chaos capability's own `assertNotProduction()` guarantee) with three cases: a passing intake workflow (real webhook injection → real execution → a real, correctly-attributed `instance_start` entry with the right hashed correlation key and initial state → `matched: true`); a workflow with no webhook trigger (`not_webhook_shaped`, no execution attempted); and the *same* real passing execution re-evaluated against a deliberately-wrong expected initial state (`matched: false`, the exact right mismatch message) — proving the comparison logic discriminates correctly against genuinely real, not synthetic, extracted evidence, not only the hand-built fixtures in the unit tests.

9 new unit tests (`tests/unit/reliability/replay/contract-outcome.test.ts`) plus 3 new module-boundary tests, full suite 1915 → 1927, typecheck/lint/docs-drift clean.

---

## 8. Phase 8 — Chaos Upgrade: business-level scenarios

### What it is

A new chaos-payload family, generated from a `ProcessContract`'s own business scenarios (a missing phone number, a duplicate referral, an after-hours arrival, missing insurance info — `Futrure copy.txt` §B's exact list), running **alongside**, never instead of, the existing structurally-derived malformed-payload family (`generateChaosPayloads()`, `src/reliability/chaos/payloads.ts`), which only knows about field paths, not business meaning.

### Why it matters

Today's chaos testing asks "does this workflow crash on garbage input" — valuable, and unchanged by this phase, but blind to "does this workflow handle a *realistic* business edge case correctly." Both source documents are explicit this is materially stronger: business-level chaos exercises the same paths a real, if unlucky, customer would actually trigger, not only an adversary's malformed JSON.

### How it connects to existing modules

Phases 5 and 8 share underlying intent — a `ContractScenario`'s `timeline` already describes a business situation; chaos needs the same situation expressed as a real webhook *payload* (the JSON body a `StartCondition`'s trigger would actually receive), not a `ProofLedgerEntry` timeline. The real new work is one translation function, `scenarioToChaosPayload(contract, scenario): ChaosPayloadVariant`, mapping a scenario's intent onto `contract.correlationKey.fieldPath` and whatever other fields the intake workflow's trigger references — then reusing `runChaosSandbox()`/`classifyChaosPayloadDiff()` completely unchanged for execution, the exact same reuse discipline `generateChaosPayloads()`'s existing output already relies on today.

### Files/subsystems likely affected

- **NEW** `src/reliability/chaos/contract-payloads.ts` — `generateContractChaosPayloads(contract, scenarios): ChaosPayloadVariant[]`, reusing the **existing** `ChaosPayloadVariant` type from `payloads.ts` unchanged, so this output is compatible with the current chaos runner by construction, not a parallel type needing its own handling.
- **MODIFY** `src/cli.ts` — `kairos chaos audit <id> --contract <contract-id>` / `kairos chaos run <id> --contract <contract-id>`, additive to the existing structural payload set by default.
- Same new cross-boundary import consideration as Phase 7 — see §3.3.

### Data models/types needed

No new core types — `ChaosPayloadVariant` is reused as-is. `ChaosPayloadOutcome`/`ChaosSandboxRunResult` (existing, `sandbox-run.ts`) likely need an optional `businessOutcomeCheck` field, the **same shape** Phase 7 introduces on the replay side — worth building as one shared sub-type both phases consume, not two independently-invented near-duplicates.

### CLI/API surface

`kairos chaos audit <id> --contract <contract-id>` — static audit gains business-scenario-derived findings alongside existing field-reference/error-handling findings. `kairos chaos run <id> --contract <contract-id>` — sandbox run executes both payload families, reporting results clearly labeled by origin (`source: 'structural' | 'contract_scenario'`), never merged into one undifferentiated list.

### Tests/checkpoints

Unit test: given the Empire-referral-shaped fixture, confirm `generateContractChaosPayloads` produces a payload matching the `missing_data` scenario with the correlation-key field genuinely absent. **Sandbox-integration checkpoint** (live, not unit): run one contract-derived payload through a real disposable sandbox workflow, confirm `classifyChaosPayloadDiff` still produces a sensible verdict on this new payload source with its existing, unchanged classification logic.

### Guardrails

Identical to existing chaos guardrails — sandbox-only, never production. Identical to Phase 7's evidence-extraction-reuse guardrail whenever checking business-outcome correctness.

### What not to build yet

No adversarial/security-focused business payloads (attempted business-logic exploits) — this phase is about *realistic* edge cases, not hostile ones. That distinction stays clean against the existing malformed/injection-shaped payload family, which remains chaos testing's "hostile" side, untouched by this phase.

### Risks/open questions

Not every `ScenarioCategory` cleanly maps to a single chaos payload. `duplicate_entity` needs two payloads sent close together, not one. `no_response` is not a payload variant at all — it is the *absence* of a second payload over time, which does not fit chaos testing's single-request/response model. This should be named explicitly as a real scoping boundary: **`no_response` and similar time-based-absence scenarios belong to Phase 6 (harness) and Phase 9 (regression tests), not Phase 8 (chaos)** — not every scenario category needs, or should have, a chaos-payload equivalent.

### Definition of done

`kairos chaos run --contract <id>` executes at least the `missing_data` and `after_hours` scenario categories as real sandbox payloads and correctly classifies whether the workflow handled them per the contract's own expected outcome, additive to (never replacing) the existing structural chaos suite.

---

## 9. Phase 9 — ProofLedger/ExceptionDesk Harness Tests

### What it is

Not a new feature — the "make it permanent" phase. Takes Phase 6's harness (already runnable ad hoc against any contract + scenario set) and turns it into first-class, checked-in regression coverage: a fixture library of contracts, their Phase-5-generated (or hand-curated, where useful) scenarios, and expected outcomes, run automatically by `npm test` — exactly the way `tests/unit/promise/report.test.ts`'s existing ambiguity-stopgap tests already work, except contract-driven and scenario-generated instead of hand-written per test case.

### Why it matters

`Futrure copy.txt` §E states the goal exactly: *"Every contract could eventually generate a test suite... npm test → Kairos verifies business logic still works. This is agent-native. Claude Code/Codex can inspect and fix real tests."* Today, `ProofLedger`/SLA/`ExceptionDesk` correctness is proven by hand-written unit tests plus one-off manual exercises like this session's synthetic validation. This phase turns that manual exercise into something that runs on every commit — catching a regression in the promise-evaluation logic automatically, the same way `tests/unit/docs-drift.test.ts` already catches a documentation regression automatically without anyone remembering to check by hand.

### How it connects to existing modules

Directly extends the existing `tests/unit/promise/*.test.ts` suite — not a separate runner, not a new CI job, just more `describe`/`it` blocks driven by Phase 5's generator and Phase 6's harness instead of hand-built fixtures. The very first fixture should be a checked-in, faithful copy of this session's own synthetic validation scenario (Cases A–E) — already hand-verified once, with a real, non-trivial finding (Case C) baked in, making it a high-confidence fixture rather than a hypothetical placeholder.

### Files/subsystems likely affected

- **NEW** `tests/fixtures/contracts/` — checked-in `ProcessContract` JSON fixtures: the Empire-referral-shaped contract, the incident-response pressure-test contract, and the website-contact-form contract from this session's synthetic validation.
- **NEW** `tests/unit/promise/scenario.test.ts` — Phase 5's own unit tests.
- **NEW** `tests/unit/promise/harness.test.ts` — Phase 6's own unit tests.
- **NEW** `tests/integration/contract-harness-golden.test.ts` (alongside the existing `tests/integration/pattern-pipeline.test.ts`) — runs the full contract → generate scenarios → run harness → assert-all-pass loop against every fixture, a single high-value integration test proving the whole Phase 4–6 chain stays correct *together*, not only piece by piece.

### Data models/types needed

None new — pure test infrastructure over Phase 5/6's existing types.

### CLI/API surface

None new — though `kairos contract harness run` (Phase 6) becomes the exact command a human runs to manually reproduce what CI does automatically. Worth stating explicitly: CI and a human's manual debug loop use the *identical* code path, never two different ones that could quietly drift apart.

### Tests/checkpoints

This phase is its own deliverable. Concretely: the full-suite test count should grow visibly, matching this whole project's own convention of citing exact before/after counts (most recently 1826 → 1837 for Findings 2/3; this project is currently at 1837).

### Guardrails

Must respect the no-network guard — automatic by construction, since Phase 6's harness is already pure in-memory with no file I/O and no network calls (§6). Worth confirming explicitly here: this is exactly what makes Phase 9 possible with zero new CI infrastructure.

### What not to build yet

No live-n8n-required tests added to the default `npm test` run — those stay checkpoint-only, matching every other live check across this whole project's history. `npm test` must keep running with zero credentials required.

### Risks/open questions

Fixture drift: if `ProcessContract`'s schema changes in a later phase, checked-in fixture JSON needs updating by hand unless generated by a small script (e.g. `npm run fixtures:regenerate`). Worth deciding explicitly whether that script is built now or deferred until fixture maintenance actually becomes painful.

### Definition of done

`npm test` includes a passing, permanent, contract-driven regression suite that would have mechanically caught, as a real test failure, any of the actual bugs this session's live and synthetic validation passes found by hand — most concretely, Finding 3's ambiguity scenario, ported from a one-off script into a permanent fixture.

### Shipped (2026-07-21)

Most of this phase's originally-planned infrastructure already existed from Phase 5/6's own build (`tests/unit/promise/scenario.test.ts`, `harness.test.ts`, both already running in default `npm test`) — Phase 9's real, additional work was: closing the specific coverage gaps Codex named explicitly, building the one integration test the original §9 sketch called for but Phase 5/6 hadn't gotten to yet, proving non-flakiness with real evidence rather than an assertion, and writing the explicit coverage matrix below.

**New this phase:**
- `tests/integration/contract-harness-golden.test.ts` (new) — sweeps every valid (non-`negative-*`) fixture under `tests/fixtures/contracts/` through validate → generate scenarios → run harness → assert-zero-failures, dynamically discovering fixtures via `readdirSync` rather than naming them individually, so a future fixture added to that directory is automatically covered with zero new test code. Explicitly re-asserts, as its own dedicated regression test, that Empire Homecare and the SaaS fixture still skip exactly `happy_path`/`failure_terminal`/`after_hours` — the real evidence-completeness gap this arc found, now guarded so it can never be silently "fixed" (or re-broken) without a visible, intentional test change.
- An explicit, clearly-named ExceptionDesk time-based-only-boundary regression test (`harness.test.ts`) — the `failure_terminal` scenario (a terminal outcome reached within minutes, well within any SLA window) was already implicitly exercising this via its existing `expectedExceptionCount: 0` assertion, but Codex's explicit "ExceptionDesk opening/non-opening" coverage requirement warranted naming and asserting this specific, previously-hand-verified-only (this session's synthetic validation Case C) system boundary directly, not leaving it as an incidental side effect of a differently-named test.
- **A real non-flakiness proof, not just a claim**: `generateAfterHours()`/`generateContractScenarios()` gained an optional, injectable `now: Date` parameter (defaulting to real "now", zero behavior change for every existing caller) specifically so a new test (`scenario.test.ts`) could run the full generate → build-ledger-entries → run-harness chain against all 7 real calendar weekdays (2024-01-01 through 2024-01-07, Monday through Sunday) as `now`, asserting every single one produces correct, safely-in-the-past, correctly-ordered offsets and a passing harness result. This is the only category with real day-of-week-dependent arithmetic (`findAfterHoursWindow()`); every other category's offsets are day-independent relative numbers. Direct, mechanical evidence of "not flaky" rather than an assumption resting on "the margins are generous enough."
- Full suite 1907 → 1915, typecheck/lint/docs-drift clean.

**Coverage matrix — what Phase 9 covers, and what it deliberately does not:**

| Area | Covered | How |
|---|---|---|
| ProofLedger evidence interpretation | Yes | `buildLedgerEntriesForScenario()` tests: correlation-key hashing, `eventTime` ordering, `evidenceStatus` carry-through (`harness.test.ts`) |
| SLA classification: `healthy` | Yes | `happy_path`, `after_hours` (harness level); direct unit tests (`sla-compliance.test.ts`, pre-existing + new) |
| SLA classification: `drifting` | Yes | `no_response` (harness level, both SLA- and ExpirationRule-caused); direct unit tests |
| SLA classification: `insufficient_data` | Yes (indirectly) | `in_progress`'s resulting report status; not asserted as a raw `PromiseComplianceFinding` at harness level, but is at the direct unit-test level (pre-existing) |
| SLA classification: `not_applicable` | **Harness level: No. Function level: Yes** | None of the 7 v0 scenario categories naturally construct a "genuinely exited" transition sequence; covered only by pre-existing direct `sla-compliance.test.ts` tests |
| SLA classification: `unverifiable` (the P0-2 fix) | Yes, extensively | `missing_data` (harness level) + 14 new direct unit tests (`sla-compliance.test.ts`, `report.test.ts`) covering every fixed function individually, the verifiable-preferred-over-unverifiable shadowing behavior, and the unaffected-`observed` regression guard |
| ExceptionDesk opening | Yes | `no_response` asserts exact `expectedExceptionCount`/`expectedExceptionKinds` |
| ExceptionDesk non-opening (the time-based-only boundary) | Yes, explicitly | New named regression test using `failure_terminal`; also implicit in `happy_path`/`in_progress`/`duplicate_correlation`'s own `expectedExceptionCount: 0` |
| Report classification: `kept` / `missed` / `unverifiable` / `in_progress` | Yes | All four exercised across the 7 scenario categories on the primary fixture |
| Report classification: `at_risk` | **No — a real, structural gap, not an oversight** | `at_risk` requires an exception still `open`/`acknowledged` from a *prior* tick while the *current* tick's findings no longer show it as drifting (the cause resolved, but a human hasn't acknowledged/resolved the exception yet) — this is fundamentally a **multi-tick** scenario. The harness's `runScenario()`/`runContractHarness()` always call `updateExceptionDesk()` with `existingItems: []` (a single, fresh tick) — structurally, `at_risk` can never be produced this way, since `updateExceptionDesk()` only ever opens an item *for* a drifting finding, and a single tick's own findings and its own freshly-opened exceptions can never disagree with each other. Testing `at_risk` for real needs a harness extension that chains two ticks (a first run's `opened`/`refreshed` items fed as `existingItems` into a second), not built in v0 -- named here explicitly as real, deliberate future scope, not glossed over. |
| Recurring SLAs at the scenario/harness level | **No — none of the 3 checked-in fixtures use one** | Covered at the direct `sla-compliance.test.ts` function level only (pre-existing + new P0-2 tests); no scenario category targets `SlaSpec.recurring` specifically |
| Real n8n execution/extraction correctness | **No, by design** | That's `extractExecutionEvidence()` against real n8n execution JSON — the Replay Upgrade's job (roadmap item 7), not the Promise Engine's own evaluation logic this arc tests |
| `buildPromiseReportData`'s `--from`/`--to` window filtering | **No, out of scope for this phase** | Has its own pre-existing, separate test coverage in `report.test.ts`'s `buildPromiseReportData` describe block; not re-tested via the scenario/harness abstraction |
| ExceptionDesk human lifecycle (ack/resolve/reopen) | **No, out of scope for this phase** | Already covered by `exception-desk.test.ts`'s own pre-existing suite; the harness only ever tests automatic *opening*, matching the "human resolution only, no autonomous business decisions" design this whole arc's guardrails require |
| Contract Evolution / platform adapters / dashboards / Node runtime | **No — explicitly out of scope** | Per this whole arc's own standing guardrails, unrelated to Phase 9's actual deliverable |

---

## 10. Phase 10 — Contract Compiler Verification

### What it is

Checks whether the workflows `Kairos.build()` actually generates (real n8n JSON, produced from `compileToPackPlan()`'s prose `WorkflowPlan` descriptions via one LLM call) structurally satisfy what the contract requires — **before deployment**, and independent of any particular execution. This gap was identified directly while reading `compile.ts` for this plan, not assumed from prior sessions: `compile.ts` produces natural-language instructions telling the generation LLM to name a node exactly `Kairos Evidence: <transitionId>` for every `EvidenceRequirement` (`evidenceNodeName()`), but nothing anywhere in the codebase today checks whether the LLM actually did that in the real generated JSON.

### Why it matters

This is the deepest form of the "workflow ran green but was wrong" problem — deeper than Phase 7's runtime check, because it asks whether the *generated structure* can even possibly satisfy the contract, independent of any specific execution. A workflow silently missing its `Kairos Evidence: t-received-to-attempted` node will produce zero ledger entries for that transition **forever**, invisibly, until a human notices an unexpectedly-thin `contract report` weeks later. Catching this at build time is exactly the same discipline the P0 measurement-integrity fix pass (this session, prior to release) already applied throughout — never let a silent gap propagate downstream when it can be caught mechanically at the source.

### How it connects to existing modules

A new, purely static analysis pass over the generated `N8nWorkflow` JSON, structurally similar to `pack-validator.ts`'s existing cross-workflow safety checks and `static-audit.ts`'s existing expression-walking approach. Reuses `extractWebhookFieldRefs()` (`src/pack/webhook-schema.ts` — already shared by both `chaos/payloads.ts` and `pack-validator.ts`) to confirm `correlationKey.fieldPath` is genuinely referenced somewhere in the intake workflow, and a straightforward node-name scan (`workflow.nodes.some(n => n.name === evidenceNodeName(transitionId))`) for every `EvidenceRequirement`. No LLM call, no sandbox execution — matching `compile.ts`'s own "deterministic, no Anthropic call" design principle exactly, for the identical reason: a second LLM pass checking the first LLM pass's output would not be meaningfully more trustworthy, only more expensive.

### Files/subsystems likely affected

- **NEW** `src/promise/compiler-verify.ts` — `verifyCompiledWorkflows(contract, traceability: ContractWorkflowTrace[], workflows: N8nWorkflow[]): CompilerVerificationResult`.
- **MODIFY** `src/cli.ts` — `handleContractCompile`'s `--build` path (the same function Finding 2's registration-drop-refusal logic already lives in) gains a new verification step, run after real generation, before or alongside registration.

### Data models/types needed

```ts
export interface CompilerVerificationFinding {
  severity: 'error' | 'warning'
  contractElement: string   // e.g. "evidenceRequirement:t-received-to-attempted"
  workflowName: string
  message: string
}

export interface CompilerVerificationResult {
  verdict: 'satisfied' | 'gaps_found'
  findings: CompilerVerificationFinding[]
}
```

Checks, in order, each explicitly named as static/structural — never a claim of full correctness:

1. Every `EvidenceRequirement.transitionId` has a node named `evidenceNodeName(transitionId)` in some generated workflow.
2. Every `EvidenceRequirement.requiredFields` entry is plausibly referenced (a field-name string match against that node's parameters — an honest, explicitly-named limitation, not full data-flow proof) inside that node.
3. `correlationKey.fieldPath` is referenced by `extractWebhookFieldRefs()` in at least one intake workflow.
4. Every `StartCondition` produced at least one workflow — a compile-time sanity check that `compileToPackPlan()`'s own 1:1 `StartCondition` → intake-workflow assumption held after real generation, not only at plan time.

### CLI/API surface

`kairos contract compile <file.json> --build` gains verification by default, following the exact precedent Finding 2 already established for this same command path: refuse loudly by default when gaps are found, with an explicit `--confirm-verification-gaps` override for a genuinely exceptional case — matching the `--confirm-registration-drop`/`--confirm-version-change` naming convention already shipped.

### Tests/checkpoints

Unit test: a hand-built `N8nWorkflow` fixture deliberately missing an evidence node, confirm `verifyCompiledWorkflows` flags it by exact `transitionId`. **Live checkpoint** (the most valuable single check in this entire arc): run against a real `contract compile --build` cycle, reusing this session's own disposable-workflow discipline, and confirm verification passes cleanly against Kairos's *own real LLM-generated output* — this is the first time anything in the codebase checks, at scale, whether the generation LLM actually follows `compile.ts`'s node-naming instructions in practice, beyond the handful of manual spot-checks done so far this session.

### Guardrails

Static/structural only in v0 — explicitly not attempting full data-flow or expression-evaluation proof (a much larger undertaking, arguably its own future arc). The report's own language must say so plainly: "structurally present" is not "correctly wired," matching the evidence-graded, not-a-guarantee framing this whole project already applies everywhere else.

### What not to build yet

No attempt to *prove* data flows correctly end-to-end through expression evaluation — that needs a real n8n execution, which is Phase 6/7's job at runtime, not Phase 10's at compile time. No auto-fix or auto-regeneration when a gap is found — report only, human decides whether to accept, adjust the contract, or regenerate.

### Risks/open questions

If LLM-generated node names don't reliably match `evidenceNodeName()`'s exact convention, this check could be false-positive-heavy and get ignored — or, if it's catching real gaps often, that is itself useful signal that `compile.ts`'s current prose-instruction approach needs strengthening at the prompt level (a separate, later fix, but worth naming as a real feedback loop this phase could surface rather than silently absorb).

### Definition of done

`kairos contract compile --build` catches, before any human looks at `ProofLedger` data days or weeks later, a real case where the LLM-generated workflow does not structurally satisfy an `EvidenceRequirement` or a `correlationKey` reference — checkpointed against at least one real (not synthetic) `Kairos.build()` generation run.

### Shipped (2026-07-21)

Built to the exact scope Codex gave (narrow, structural, post-build): `src/promise/compiler-verify.ts` (new) — `verifyCompiledWorkflows(contract, workflows, traceability)`, three checks (evidence-node presence, correlation-key reference, start-condition coverage), all `severity: 'error'`, all explicitly worded "structurally present," never "correctly wired." Wired into `handleContractCompile`'s `--build` path in `src/cli.ts`: after a real, non-dry-run, non-escalated build with at least one deployed workflow, each is fetched back from n8n (read-only GET, via the already-required `N8N_BASE_URL`/`N8N_API_KEY`) and verified. Findings are always printed (both human and `--json` output) and, per the "surface a warning/failure, never silently block" framing, **never block the registration write itself** — the deployed workflows and the registration are both still real and correct even when a specific transition's evidence tracking is broken, and refusing to register at all would throw away visibility into every other evidence requirement that *is* correctly wired. The command's exit code is set to 2 at the very end if any error-severity gap was found, composing with (not replacing) the existing `buildResult.escalation` exit-2 check.

8 new unit tests (`tests/unit/promise/compiler-verify.test.ts`) covering every check's positive and negative case, including one that caught my own test-writing mistake mid-build (the correlation-key-via-headers test needed a dot-path-shaped expression to match the regex extractor, not a bracket-shaped one — caught and fixed before the test was trusted). Full suite 1859 → 1867, typecheck/lint/docs-drift clean.

**Live-checkpointed twice, against real infrastructure, proving both directions:**
- **Positive path, fully real, no shortcuts**: a disposable contract (`testwidget-maintenance-verify`, entity `TestWidgetMaintenanceRequest`, clearly labeled `DISPOSABLE - Phase 10 Compiler Verification Checkpoint`) compiled to 3 workflows and run through a real, non-dry-run `contract compile --build --yes` — real Anthropic generation for all 3, real n8n deployment, real verification against the real fetched-back JSON. Result: `✓ ... every evidence node, the correlation key, and every start condition are structurally present` — the LLM's real output followed `compile.ts`'s prose node-naming instruction correctly, for all 3 `EvidenceRequirement`s, on this run. This is itself a real (if single-sample) answer to this section's own risks/open-questions note above: at least in this instance, the current prose-instruction approach worked, not merely a false-positive-prone check that never finds anything.
- **Negative path, against the same real n8n-generated data, not just hand-built fixtures**: the 3 real workflows were fetched back a second time and an in-memory-only copy had one real evidence node renamed (`Kairos Evidence: t-received-to-acknowledged` → `Renamed By Accident`) — never written back to n8n. `verifyCompiledWorkflows` correctly flagged exactly that gap (`evidenceRequirement:t-received-to-acknowledged`, the exact expected node name in the message) and nothing else, confirming the check discriminates correctly against real, not synthetic, node data.
- **Cleanup**: all 3 disposable workflow ids (`Kk9xsNe0PNySJvND`, `rcWbRx4bURC7Ksvt`, `eChOu5T1GHDPF2ZB`) verified by name (`/^TestWidget/`) before deletion, deleted, and confirmed 404 afterward.

---

## 11. How the seven phases connect — the unified loop

```text
Intake Interview (4)
   |
ProcessContract  (existing, unchanged schema)
   |
   +--> Contract Compiler Verification (10) -- static check: did generation follow the
   |      contract's structural requirements? (independent of everything below)
   |
Contract Scenario Generator (5)
   |
   +--> Kairos Contract Harness (6) -- in-memory, no n8n: is the promise-evaluation logic
   |      self-consistent with what the contract's own scenarios expect?
   |        |
   |        +--> ProofLedger/ExceptionDesk Harness Tests (9) -- 5+6, made permanent in `npm test`
   |
   +--> Chaos Upgrade (8) -- real sandbox: does the GENERATED WORKFLOW handle the business
   |      scenario correctly when actually run?
   |
   +--> Replay Upgrade (7) -- real sandbox: does a CANDIDATE CHANGE still produce the
          expected business evidence, not just structurally resemble baseline?
```

Read top to bottom, this is the answer to *"how do these connect"* stated as plainly as possible: Intake produces the contract; Compiler Verification checks the contract was faithfully compiled into workflow *structure*; the Scenario Generator produces the test material; the Harness checks Kairos's own *evaluation logic* is self-consistent against that material without needing n8n at all; Chaos and Replay both then take the same material into a *real* n8n sandbox to check the *generated workflow itself* behaves correctly, from two different angles (adversarial-but-plausible new payloads vs. a candidate-change diff); and the Harness Tests phase locks every one of those checks in as permanent, automatic regression coverage so none of this has to be re-proven by hand again.

---

## 12. Recommended build order

1. **Phase 4 — Intake Interview v0, first.** Matches Codex's own consistently-stated priority across both source documents, and the reasoning holds up independently: every downstream phase in this plan inherits whatever the contract got wrong at authoring time, so improving contract quality at the source de-risks everything built on top of it.
2. **Phase 10 — Contract Compiler Verification, in parallel with Phase 4, not after it.** It is the cheapest and most self-contained phase in this plan — zero dependency on Phases 5–9, a real gap already found in existing shipped code, and immediately valuable against contracts that already exist today (Empire's real fixture, this session's own TestWidget live-validation contracts). It draws on different subsystem knowledge than Intake Interview (static analysis of generated JSON vs. conversational LLM design), so it does not meaningfully compete for the same engineering attention.
3. **Phase 5 + Phase 6, as one paired arc, next.** This is the technical heart of "Contract Harness." Building them together makes sense because Phase 6's design is already de-risked by this session's own synthetic validation — the harness's core approach is proven, not speculative, so this pairing should move quickly relative to its apparent size.
4. **Phase 9, immediately after 5+6.** Cheap, high-value, "lock in the gains" work — the same discipline this whole project has followed at every prior milestone (a new capability is always followed by regression tests before moving on, never left as a one-off).
5. **Phase 7 and Phase 8, last, in either order.** Both depend on 5/6 existing, both require the new cross-module boundary (§3.3), and both carry the most open scoping questions in this plan (Phase 7's real-vs-synthetic replay mode distinction, Phase 8's category-to-payload mapping gaps). Building these last means the underlying scenario/harness plumbing they depend on is already proven stable.

---

## 13. Guardrails (restated in one place)

All explicitly stated for this arc, honored by every phase section above without exception:

- **No code changes in this planning pass** — this document is the entire deliverable.
- **No dashboards or portal.** Every new surface in this plan is CLI/JSON output, matching every existing Kairos command.
- **No platform adapters.** n8n remains the only execution substrate discussed anywhere in this plan.
- **No Node.js runtime replacing n8n.** Every phase's Node.js code is a verification/simulation/test layer around real n8n execution (or around Kairos's own pure evaluation functions) — never a second execution engine.
- **No autonomous business decisions.** Every new capability reports; none of them resolve, repair, or act on a business outcome without a human — the same discipline `repair propose/apply` and `exceptions ack/resolve` already established.
- **No guard DSL**, except where explicitly and narrowly justified — this plan introduces none; every "condition" (scenario category, verification check) stays a fixed, curated, code-level template, never a new expression language.
- **n8n stays the execution substrate; Node.js is deterministic simulation/assertion/harness code.** Restated because it is the single sentence that most precisely separates this arc from the "Node runtime" outcome both source documents explicitly warn against.
- **ProcessContract remains the source of truth.** No phase in this plan proposes any change to `src/promise/types.ts`'s existing schema; every new artifact (scenarios, harness results, verification findings) is downstream of the contract, never a parallel source of truth.
- **"Evidence-graded evaluation," never "guarantee."** Every new report type in this plan (`HarnessResult`, `CompilerVerificationResult`, `BusinessOutcomeCheckResult`) should carry the same honest, bounded-confidence language this project has used everywhere since the v0.12.0 docs audit — a harness pass proves self-consistency, not correctness in the real world; a compiler-verification pass proves structural presence, not correct wiring.
- **Phases stay independently shippable.** §12's build order is a recommendation, not a hard dependency chain beyond what's noted explicitly (5→6→9 is a real sequence; 4 and 10 are genuinely independent of everything else and of each other).

---

## 14. What not to build in this arc (global)

Restated plainly, matching the explicit instruction and cross-referencing the longer roadmap items each defers to: no Contract Evolution / amendment-diff engine (Codex's own item 6 — needs this arc's harness proof first); no Automation P&L / value reporting (item 7); no Operations Scout (item 8); no Self-Tuning Flywheel (item 9); no Platform Adapter Layer (item 10 on Codex's list, distinct from this plan's own item 10); no hosted dashboard or portal (item 11); no employee-surveillance or always-on task recording of any kind; no direct n8n-JSON-to-Zapier-JSON translator; no massive cross-client ontology of business processes — `EntityDefinition.name` stays free-text and per-contract, exactly as `types.ts`'s own doc comments already establish.

---

## 15. Cross-phase risks and open questions

1. **The promise → n8n generation gap is real and structural, not hypothetical.** Phase 10 exists specifically because generation is LLM-based and non-deterministic; no amount of harness testing on the contract side (Phase 6) proves the *generated workflow* matches. Skipping Phase 10 because it looks like the "boring" phase relative to the harness would leave the single most concrete, already-identified gap in this entire plan unaddressed.
2. **Cross-module boundary creep.** Phases 7 and 8 need `src/reliability/` to import from `src/promise/` for the first time. This needs the explicit, narrow, tested boundary described in §3.3 — not an ad hoc import that later needs retrofitting into a firewall test the way the community/ boundary was retrofitted once already (memory boundary added 2026-07-19, a real gap closed after the fact, not before).
3. **Scope creep toward a full Node runtime.** Both source documents warn against this explicitly and by name. Every phase above is written to keep Node.js in a verification/simulation role — this needs to be actively defended during implementation, not just stated once here, since the natural engineering temptation (a harness that can classify synthetic evidence is one small step from a harness that could just *execute the business logic itself*) is real and worth naming.
4. **Intake Interview's open product questions are not purely engineering decisions.** REPL vs. MCP surface, fixed vs. dynamic question bank — these affect how the feature actually gets used and should be resolved as an explicit decision before implementation starts, not discovered mid-build.
5. **A real, small ProcessContract schema gap surfaced while drafting Phase 5.** `external_failure` (an external API/system being unavailable) has no first-class representation in the current contract schema — `EvidenceRequirement`/`ExceptionRule` don't model "the evidence couldn't be gathered because a downstream system was down" as distinct from "the evidence wasn't gathered." **Codex's explicit guidance (2026-07-21): do not let this expand into a full contract schema redesign.** Phase 5 should handle it as either (a) a `ScenarioCategory` only — a scenario that exercises how the harness/report classify a downstream failure using fields that already exist (an `EvidenceRequirement` that's simply never satisfied) — with no schema change at all, or, if that genuinely proves insufficient once real scenarios are drafted, (b) one small, additive classification value on an existing type (e.g. a new `ExceptionRule`/`EvidenceRequirement` field distinguishing "not gathered" from "gathering failed"), never a new top-level contract concept. Try (a) first; only reach for (b) if (a) demonstrably can't express the distinction.

---

## 16. Definition of done for the whole arc

All seven phases (4–10) shipped, each meeting its own section's definition of done above, plus:

- `npm test` includes real, permanent, contract-driven regression coverage for the promise-evaluation pipeline (Phase 9), not only hand-written unit tests.
- At least one real business description has gone through Intake Interview → Scenario Generator → Harness → Compiler Verification → a real `contract compile --build` cycle → Replay/Chaos against a real disposable sandbox workflow, end to end, checkpointed live at each stage the way every phase in the Reliability Suite and Promise Engine v0 arcs already were.
- The new `src/reliability/` ↔ `src/promise/` module boundary (§3.3) is enforced by a standing test, not just documented in prose.
- No dashboard, no platform adapter, no autonomous business decision, and no Node.js execution engine exist anywhere in the shipped code — verified against the actual diff at the end of the arc, the same way this session's own docs audit verified README/CLI-help claims against actual code before v0.12.0 shipped.
