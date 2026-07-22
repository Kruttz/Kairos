# Kairos Roadmap Items 11–18 — Implementation Plan (Planning Only)

## 0. Scope of this document

Codex asked for a detailed implementation plan for roadmap items 11–18, planning only, no code changes. This document was written after:

- Reading `/Users/jordankrutman/Desktop/Futrure copy.txt` and `/Users/jordankrutman/Desktop/FutureForKairos.txt` in full (the original side-chat sources this roadmap comes from — not assumed from memory).
- Reading `docs/plans/intake-scenario-harness-plan.md`, `docs/plans/process-contract-promise-engine-plan.md`, `docs/plans/reliability-suite-plan.md`, and `README.md`.
- Reading the actual current source of `src/promise/` (all 24 files) and `src/reliability/` (all 20 files) directly — types, function signatures, storage layout, CLI wiring — rather than trusting any plan doc's own prose about itself, since plan docs can drift from what actually shipped.

Every "How it connects" and "Risks" section below cites a real, currently-existing file, type, or function, confirmed by reading it in this pass. Where the current code has a real gap relevant to an item, that gap is named explicitly rather than glossed over — several of these gaps are load-bearing for how the item should be scoped.

**No code was changed to produce this document.**

---

## 1. Framing (repeated back, not reinterpreted)

- **ProcessContract is the source of truth.** Not `PackPlan`, not raw n8n JSON. Confirmed still true of the current codebase: `compile.ts`'s `compileToPackPlan(contract)` is a one-way compiler *from* `ProcessContract`, never the reverse.
- **Kairos remains a Business Operations Reliability engine** — the positioning `README.md`'s own opening paragraph already states today: *"a reliability engine for n8n workflows, and a compiler for verifiable business promises."* Nothing in items 11–18 should push Kairos toward "AI automation agency," "workflow builder," or "guaranteed business proof."
- **Node.js is a deterministic harness/simulation/assertion layer first, optional runtime later.** This is not aspirational — it is *already true of the codebase as it stands*. `src/promise/harness.ts` (`runContractHarness`) is exactly this: a pure, deterministic, no-network simulation layer that evaluates a `ProcessContract`'s own declared logic against synthetic scenarios. Item 17 below is mostly about naming this clearly and scoping what (if anything) comes after it — not building something new from scratch.
- **n8n remains the first execution substrate.** No item below treats n8n as legacy or as something to route around.
- **Evidence-graded evaluation language, not guarantees.** Every new report/proposal/finding type introduced below follows the same discipline `ProofStatus` (`'observed' | 'asserted' | 'verified' | 'unverifiable'`) and `PromiseComplianceStatus` (`'insufficient_data' | 'not_applicable' | 'healthy' | 'drifting' | 'unverifiable'`) already established: confidence is graded, absence of evidence is reported as absence of evidence, never silently upgraded to a claim.
- **Avoid platformization too early. No hosted SaaS/dashboard unless justified by real need.** Both explicitly shape items 16 and 18 below — both are scoped as *strategy documented, not built*.

---

## 2. Design-verification pass — what the current codebase actually does (read directly, 2026-07-22)

This section exists because several of the items below (especially 11 and 12) sound simpler in the source chat logs than they actually are once checked against real code. Naming these gaps up front changes how the items should be scoped.

### 2.1 `store.ts` has no version history at all — item 12's single biggest real gap

`src/promise/store.ts`'s `saveProcessContract()` writes to `~/.kairos/contracts/<clientId>/<id>.json` and **overwrites unconditionally** on every call. There is no `versions/` directory, no archive-on-write, nothing. The file's own doc comment says this plainly: *"No update/delete/versioning semantics here — re-saving a contract with the same id overwrites."*

The only guard that exists today is in `cli.ts`'s `handleContractImport()`: a helper `checkContractVersionConflict()` (`cli.ts:2265`) loads the existing contract, compares `.version` numbers, and refuses to overwrite a *different* version without an explicit `--confirm-version-change` flag — but even when confirmed, it still just overwrites the file. The old version is gone, full stop. The console warning it prints is honest about the consequence: *"Overwriting it would silently orphan any ProofLedger evidence recorded against the old version's own state/transition/SLA ids."*

**This means "preserve version history" (item 12's own explicit requirement) is not a refinement of existing behavior — it is new behavior that does not exist today in any form.**

### 2.2 `ContractWorkflowRegistration` is keyed by contractId only, not by (contractId, version)

`src/promise/registry.ts`'s `saveContractWorkflowRegistration()` writes to `~/.kairos/contracts/<clientId>/<contractId>-workflows.json` — one file per contract, no version in the path. Recompiling after an amendment (`kairos contract compile ... --build` again) overwrites this file. There is no way today to know, after an amendment, which real n8n workflow ids implemented the *old* version.

Concretely: if a promise instance is still active under the old contract version when an amendment is recompiled, and the new compile changes which workflows exist (adds/removes/renames), `kairos ledger poll` and `kairos watch --contracts` would only ever poll the workflows in the *current* registration — the old instance's evidence trail could silently stop being polled. This is a real mechanism, not a hypothetical, and it's central to item 12's "needs to be careful with active instances" requirement.

### 2.3 `checkSlaCompliance()` is not version-cohort-aware

`src/promise/sla-compliance.ts`'s `checkSlaCompliance(contract, entries, now)` takes one `ProcessContract` object and matches ledger entries against it by state/transition/SLA *id strings*. `ProofLedgerEntry.contractVersion` exists as a field (so the data model already tags each entry with the version it was recorded under) but nothing in the current compliance-checking path reads that field to select a different, older contract shape for older entries. If a contract amendment renames or repurposes an id (e.g. reusing `sla-1`'s id for a materially different deadline), evidence recorded under the old meaning would be silently evaluated against the new meaning. This is the same risk class `handleContractImport`'s own warning names for the whole-file overwrite case, just one layer deeper — it also applies to a single ExceptionRule or SlaSpec id being redefined *within* a version bump. Item 12 needs to either enforce id-stability rules for non-breaking amendments, or make compliance-checking version-cohort-aware. Both are real design work, not a formality.

### 2.4 `ExceptionDeskItem`/`ExceptionStatusChange` has no structured "what actually happened" field

`src/promise/exception-types.ts`'s `ExceptionStatusChange` has only `reason?: string` — free text. The worked example from `Futrure copy.txt` ("repeated resolved exceptions show staff actually use 2 attempts before escalation") implies extracting a *specific number* from resolution history. Today there is nowhere a human (or Kairos) would have recorded "2 attempts" as a structured value anywhere in the system — only as prose in a free-text `reason`, if that. This directly narrows what Item 11 can honestly claim to detect in its v0 (see §4 below).

### 2.5 `Kairos Contract Harness` (item 17's near-term half) is already shipped

`src/promise/harness.ts`'s `runContractHarness(contract, scenarios, now)` — pure, deterministic, zero network calls, zero LLM calls — already *is* "Node.js as a deterministic harness/simulation/assertion layer." It's been live-checkpointed multiple times across this arc (Phases 6, 9) and has a golden regression suite (`tests/integration/contract-harness-golden.test.ts`). Item 17 is therefore mostly a scoping/naming exercise for what comes *after* this, not new construction.

### 2.6 `PatternAnalyzer` (`src/telemetry/pattern-analyzer.ts`) is the exact template for item 15's human-gate

Already shipped, already proven over this whole arc: `PatternState = 'draft' | 'confirmed' | 'pending_review' | 'resolved'`, `PatternAuditEntry` with `actor: 'auto' | 'human'`, and `kairos patterns approve/reject` as the CLI gate. This is validator-rule-scoped today (n8n generation-quality patterns). Item 15 is "build the same shape for a different evidence domain," not a new design.

### 2.7 `generateImpactNotesTemplate()` (`src/pack/pack-exporter.ts`) is the exact precedent for item 13's guardrail

Already shipped: a blank, human-filled-in worksheet (`kairos pack export --impact-notes`), with a doc comment that is directly on point: *"deliberately not auto-computed from anything… guessing at any field… would reintroduce exactly the fabricated-precision risk an earlier 'roi-ledger.md' concept was rejected for."* **A prior "automatic ROI math" concept was already proposed and rejected in this codebase's own history.** Item 13 must not resurrect it in a new shape.

### 2.8 `compileToPackPlan()`'s output is business-purpose-shaped, not n8n-JSON-shaped

Read directly for item 16: `CompileToPackPlanResult`/the `WorkflowPlan`s it produces (`src/pack/pack-builder.ts`) describe *which workflows to build and why*, in business language — actual n8n JSON generation happens later, per-workflow, via the same LLM-prompt path single-workflow `Kairos.build()` uses. This is a genuinely good sign for item 16's architecture: the IR above the n8n-JSON layer is already reasonably platform-neutral. The n8n-specificity is concentrated in the *generation* step, not the *planning* step.

### 2.9 No existing code touches Gmail/Sheets/CSV/any external read-only data source

Confirmed by search: nothing in `src/` reads a spreadsheet, inbox, or CSV export for analysis purposes. `pack/webhook-schema.ts`'s `extractWebhookFieldRefs()` is about *workflow node parameters*, unrelated. **Item 14 (Operations Scout) is the one genuinely greenfield item in this list** — it has no existing subsystem to extend, unlike 11–13, 15, and 17, which are all extensions of shipped infrastructure.

---

## 3. Items 11–18

---

### 11. Contract Evolution v0

**What it is**

A read-only analysis pass over a contract's own real operational evidence — `ProofLedgerEntry[]`, `ExceptionDeskItem[]`, and (secondarily, see Risks) harness regression history — that produces `ContractAmendmentProposal[]`: structured, evidence-linked suggestions that a specific part of the contract may no longer match reality. It never writes to the contract. A human reviews and either acts on a proposal (via item 12's amendment flow) or dismisses it.

**Why it matters**

`ProcessContract` today is authored once (via `contract plan` or Intake Interview) and never revisits itself. Real businesses drift — SLA thresholds set at authoring time turn out to be too tight or too loose, exception rules that seemed rare turn out to fire constantly, states that seemed reachable never get reached. Treating the contract as a *hypothesis*, not permanent truth, is the whole point of collecting `ProofLedger`/`ExceptionDesk` evidence in the first place — right now that evidence is only ever used to grade the *existing* contract (`kairos contract report`), never to question it.

**How it connects to current Kairos architecture**

- Reads `ProofLedgerEntry[]` via `getProofLedgerEntries()` (`ledger-store.ts`) and `ExceptionDeskItem[]` via `loadExceptionDeskItems()` (`exception-store.ts`) — both already shipped, read-only.
- Reuses `checkSlaCompliance()`'s own `PromiseComplianceFinding[]` output (`sla-compliance.ts`) as the primary frequency signal: which `SlaSpec`/`ExceptionRule` ids show up in `'drifting'` findings, and how often, over a real window.
- Reuses `ExceptionDeskItem.kind`/`slaId`/`expirationRuleId`/`transitionId` (`exception-types.ts`) to group resolved items by which contract element opened them.
- **Does not** treat `runContractHarness()` scenario failures as first-class evidence for promoting a proposal (see Risks §11 below for why) — may use them only as a secondary, always-labeled-synthetic signal.

**Files/subsystems likely affected**

- **NEW** `src/promise/evolution-types.ts` — `ContractAmendmentProposal`, `AmendmentEvidenceRef`, `AmendmentCategory`.
- **NEW** `src/promise/evolution.ts` — `analyzeContractForAmendments(contract, entries, exceptions, options): ContractAmendmentProposal[]`, pure, deterministic, no I/O (matches every other analysis module in `src/promise/` — `sla-compliance.ts`, `report.ts`).
- **NEW** `src/promise/evolution-store.ts` — persists generated proposals (not the contract) to `~/.kairos/contracts/<clientId>/<contractId>/amendment-proposals/`, mirroring `exception-store.ts`'s own per-contract subdirectory convention.
- **MODIFY** `src/cli.ts` — new `handleContractEvolve()`.

**Data models/types needed**

```ts
export type AmendmentCategory =
  | 'sla_threshold_hotspot'   // an SlaSpec drifts far more often than the contract's other SLAs
  | 'exception_rule_hotspot'  // an ExceptionRule fires far more often than others
  | 'unreached_state'         // a non-start ProcessState with zero observed instance evidence ever reaching it
  | 'unused_transition'       // a ProcessTransition never observed as evidence across the whole window
  | 'evidence_gap'            // a transition with an EvidenceRequirement that is *never* satisfiable given observed payload shapes (from Phase 7/8's own scopeCaveat class of finding)

export interface AmendmentEvidenceRef {
  kind: 'ledger_entry' | 'exception_item'
  id: string
}

export interface ContractAmendmentProposal {
  id: string
  contractId: string
  contractVersion: number       // the version this was computed against -- staleness-checked before use, per §2.3
  category: AmendmentCategory
  summary: string                // plain-language, e.g. "SLA 'sla-contact-attempt' drifted in 42% of instances this window, far above the contract's other SLAs (avg 6%)"
  affectedElementId: string      // the SlaSpec/ExceptionRule/ProcessState/transition id this concerns
  evidence: AmendmentEvidenceRef[]  // never empty -- a proposal with no evidence refs is a bug, not a valid proposal
  occurrenceCount: number
  sampleSize: number             // total instances/exceptions the occurrenceCount was measured against -- always shown alongside the count, never a bare percentage
  confidence: 'low' | 'medium' | 'high'   // evidence-graded by sample size + consistency, never "AI judgment"
  status: 'proposed' | 'accepted' | 'rejected'
  createdAt: string
  reviewedAt?: string
  reviewNote?: string
}
```

**CLI/API surface**

```
kairos contract evolve <contract-id> --client-id <slug> [--from <date>] [--to <date>] [--json]
```

Read-only against the contract itself; writes only to the new `amendment-proposals/` directory (the proposals, never the contract). Prints each proposal with its evidence citations and confidence. No `--accept`/`--reject` here — that belongs to item 12's amendment flow, which is the only thing allowed to change contract state.

**Tests/checkpoints**

- Unit: a synthetic fixture where one `SlaSpec` drifts in 8 of 10 instances while every other SLA drifts in 0–1 of 10 — confirm it's flagged as `sla_threshold_hotspot` with `confidence: 'high'`, and that the quiet SLAs produce no proposal at all.
- Unit: a fixture with a `ProcessState` that is declared but never appears as any entry's `initialState` or transition target across the whole evidence set — confirm `unreached_state`.
- Unit: proposals never generated with zero evidence refs (an invariant test, not just a happy-path test).
- Unit: a proposal computed against `contractVersion: 1` is flagged/excluded when checked against a currently-loaded `contractVersion: 2` contract (staleness).
- No live-sandbox checkpoint needed — this module is pure analysis over already-real (not synthetic-sandbox) evidence; the existing `ledger.ts`/`exception-desk.ts` extraction paths are what were already live-checkpointed in earlier phases.

**Guardrails**

- Never writes to `ProcessContract` in any form, directly or indirectly.
- Every proposal must cite at least one real evidence ref; no confidence score without a cited sample size.
- No LLM call in the detection logic itself (deterministic, auditable, cheap, always available — matching `sla-compliance.ts`'s own no-LLM discipline). An optional, later, clearly-separated "explain this proposal in plainer language" LLM rendering step may be added on top *without* touching detection, the same layering `report.ts` already keeps between computed data and rendered prose.
- No proposal implies or claims a specific *replacement value* (e.g. "change 3 attempts to 2") unless a structured evidence field for that value actually exists (see next point) — v0 detects *that something is off*, not *the exact right number*.

**What not to build yet**

- No free-text NLP/LLM extraction of a specific replacement number from `ExceptionStatusChange.reason` prose. Per §2.4, there is no structured field today recording "staff actually did X" — inferring a number from unstructured text is a real capability but a meaningfully riskier one (false precision from a small, noisy free-text sample), and should be a clearly separate, later increment, gated behind adding a structured field first (see Risks).
- No auto-accept of any proposal at any confidence level.
- No cross-client proposal comparison/aggregation (a privacy-sensitive extension, out of scope here and arguably belongs nowhere near item 15's community-sharing boundary either — see item 15's guardrails).

**Risks/open questions**

- **The literal "3 attempts → 2 attempts" example from the source chat is not directly buildable from today's data model.** v0's honest scope is frequency/existence-based ("this element is a hotspot," "this element is never reached"), not value-inference-based ("the right number is 2"). Closing this gap for real would need a small, additive schema change first — e.g. an optional structured field on `ExceptionStatusChange` (something like `observedValue?: Record<string, unknown>`, human-entered at resolution time, e.g. `{attemptsBeforeEscalation: 2}`) — named here as a real prerequisite for the *stronger* version of this feature, not assumed to already exist.
- Harness (`runContractHarness`) mismatches are evidence about **internal consistency between a contract's stated `expected` outcome and Kairos's own compiled evaluation logic**, not evidence about **real-world business behavior**. A harness scenario failing usually means a bug in `report.ts`/`sla-compliance.ts`/the scenario's own `expected` authoring (exactly what Phases 5/6/9 already used it for) — treating a harness failure as grounds to *amend the contract* would be confusing an internal-consistency bug with a business-reality signal. If harness data is used at all here, it should be a separate, clearly-labeled-synthetic category, never blended into the same confidence scoring as real ProofLedger/ExceptionDesk evidence.
- Small clients will have small sample sizes for a long time. `confidence` must fold in `sampleSize`, not just consistency — a "3 of 3" hotspot is not the same claim as a "40 of 100" hotspot, and the proposal's own text should say so plainly rather than only exposing a raw percentage.

**Definition of done**

`kairos contract evolve <id>` runs against a real client's real local ProofLedger + ExceptionDesk data, produces zero proposals on quiet/healthy evidence, produces at least the `sla_threshold_hotspot` and `unreached_state` categories correctly on a crafted fixture, every proposal carries real evidence refs and a sample-size-aware confidence, nothing is ever written to the contract itself, full unit coverage, docs updated.

---

### 12. Contract Amendment/Diff

**What it is**

The mechanics companion to item 11: takes a proposed or manually-authored new contract version, computes a structured diff against the current version, classifies each change as compatible or breaking, requires the same validation gate `contract import` already uses, and — only on explicit human confirmation — archives the old version (for the first time ever, per §2.1) and saves the new one. Recompilation to workflows stays a separate, later, explicit step (the existing `kairos contract compile --build`), never automatic.

**Why it matters**

Without this, item 11's proposals have nowhere real to land — "human approves/rejects" needs an actual accept path, and per §2.1, the *only* thing that currently happens on any contract update is silent, irreversible overwrite. This item is also independently necessary for the much more mundane case of a human hand-editing a contract file directly (no proposal involved at all) — today that path already exists (`contract import --confirm-version-change`) but with zero diff visibility and zero history.

**How it connects to current Kairos architecture**

- Directly extends `store.ts` — needs real version-archival for the first time (§2.1).
- Directly extends `registry.ts`'s registration semantics to be version-aware (§2.2), or explicitly documents the limitation if that's deferred.
- Reuses `validateProcessContract()` (`validate.ts`) unchanged as the pre-write gate, exactly like `handleContractImport` already does.
- Reuses `checkContractVersionConflict()`'s existing logic as the *first* check (is this actually a version bump), then adds real diffing on top rather than replacing it.
- The diff renderer is new, but the "old vs new" comparison target (two `ProcessContract` objects) needs nothing new from any other module — every field it needs to compare is already on the existing `ProcessContract` type.

**Files/subsystems likely affected**

- **MODIFY** `src/promise/store.ts` — `saveProcessContract()` needs an archive-before-overwrite step, or a new `amendProcessContract(contract, priorVersion)` function that does archive+save together, keeping `saveProcessContract()`'s existing (simpler, first-import) behavior unchanged for the common "no prior version" case.
- **NEW** `src/promise/store.ts` (same file) or **NEW** `src/promise/contract-versions.ts` — `listContractVersions()`, `loadContractVersion(clientId, id, version)`.
- **NEW** `src/promise/diff.ts` — `diffProcessContracts(from, to): ContractDiff`, pure, no I/O.
- **MODIFY** `src/promise/registry.ts` — either add `contractVersion` into the registration file path/schema so old registrations survive a recompile, or (the more conservative v0) explicitly document that registration is current-version-only and that `kairos ledger poll` must be re-pointed manually after an amendment — named as an explicit open design decision below, not silently picked.
- **MODIFY** `src/cli.ts` — `handleContractAmend()`, `handleContractVersions()`, `handleContractDiff()`.

**Data models/types needed**

```ts
export interface ContractVersionRecord {
  contract: ProcessContract           // the full archived contract, exactly as it was
  supersededAt: string
  supersededBy: { kind: 'proposal'; proposalId: string } | { kind: 'manual' }
  diffSummary: string                  // one-line human summary of what changed, for a version-list view
}

export type ContractDiffChangeType = 'added' | 'removed' | 'modified'

export interface ContractDiffChange {
  path: string                         // e.g. "sla[sla-contact-attempt].duration.amount"
  changeType: ContractDiffChangeType
  from?: unknown
  to?: unknown
  /** True when this change could invalidate how existing evidence's ids should be interpreted
   * -- an id removed/renamed/repurposed, a state's terminal-ness flipped, a transition's
   * fromState/toState changed. False for things like an SLA duration number changing, an
   * owner name changing, or description/text edits -- narrow, structural criteria, not a vibe
   * check. */
  breaking: boolean
}

export interface ContractDiff {
  contractId: string
  fromVersion: number
  toVersion: number
  changes: ContractDiffChange[]
  hasBreakingChanges: boolean
}
```

**CLI/API surface**

```
kairos contract versions <contract-id> --client-id <slug> [--json]
kairos contract diff <contract-id> --client-id <slug> --from <v> --to <v> [--json]
kairos contract amend <contract-id> --client-id <slug> --new <file.json> [--from-proposal <proposal-id>] [--confirm] [--json]
```

`amend` without `--confirm` only prints the diff and validation result (dry-run by default, same posture as `contract compile` without `--build`). With `--confirm`, it validates (refuses on error/blocking assumption, same gate as `import`), archives the current version, and saves the new one. `--from-proposal <id>` links the amendment back to an item-11 proposal, marking that proposal `status: 'accepted'` in the same operation — kept as a convenience path, not a requirement (a manually-authored amendment with no proposal behind it must work identically).

**Tests/checkpoints**

- Unit: `diffProcessContracts()` against two hand-built contracts — confirm added/removed/modified are each detected correctly across `states`, `transitions`, `sla`, `owners`, `exceptions`.
- Unit: `breaking` classification — an SLA duration change is non-breaking; a transition's `toState` changing, or a state's `terminal` flipping, is breaking.
- Unit: version archival — amend a contract twice, confirm both prior versions are still loadable via `listContractVersions()`/`loadContractVersion()`, and the live `loadProcessContract()` always returns the newest.
- Unit: `amend` without `--confirm` never writes anything (dry-run parity with `contract compile`).
- Unit: `amend` refuses (same as `import`) on a validation error in the new contract, archiving nothing.
- No live-sandbox checkpoint needed for the diff/versioning logic itself (pure, file-store-only) — but the "recompile after amend" interaction with `registry.ts` (whichever design is chosen, see Risks) should get one live checkpoint against a real disposable n8n sandbox to confirm `kairos ledger poll` behaves as documented after a recompile.

**Guardrails**

- Never recompiles or redeploys anything automatically — `kairos contract amend --confirm` only ever changes local contract storage; workflow regeneration stays the human's own explicit `kairos contract compile ... --build` afterward.
- Same validate-before-write gate as `contract import`, no exceptions.
- Version history is append-only — nothing under `versions/` is ever deleted by this feature.
- A breaking change (`hasBreakingChanges: true`) must be surfaced loudly in both the CLI output and `--json`, never buried — this is the single most important signal a human reviewing an amendment needs.

**What not to build yet**

- No automatic instance migration/backfill across versions.
- No automatic recompile-and-redeploy on confirm.
- No 3-way-merge / concurrent-amendment resolution — single-writer, last-confirmed-wins, matching every other local file store in this codebase (`store.ts`, `snapshot.ts`, `ledger-store.ts` all share this same simplicity, and there's no evidence yet that concurrent contract editing is a real problem worth solving for).

**Risks/open questions — the two hardest open questions in this whole document**

1. **Active-instance version pinning.** When an amendment lands while a promise instance is mid-flight (started under v1, still open when v2 is confirmed), should its SLA/terminal evaluation continue to use v1's definitions until it reaches a terminal outcome, or immediately switch to v2? `ProofLedgerEntry.contractVersion` already tags each entry with the version active when it was recorded (the data model supports pinning today), but `checkSlaCompliance()` (§2.3) has no version-cohort logic — it just takes one contract object and matches by id string against every entry handed to it. Making this genuinely correct means either (a) `checkSlaCompliance` accepting a version resolver and grouping entries by their own `contractVersion` before evaluating each cohort against its own contract shape, or (b) a simpler, more conservative v0 rule: **only allow non-breaking amendments to affect in-flight instances; any breaking amendment requires all instances active under the old version to reach a terminal state (or be explicitly, visibly excluded from future compliance checks) before the new version's compliance logic applies to anything.** Recommend (b) for v0 — it's a real constraint but it's honest and far simpler than building version-cohort-aware compliance checking from scratch. This should be a joint decision with Codex before implementation, not decided unilaterally in code.
2. **Registration staleness after recompile (§2.2).** Recommend v0 conservative choice: `kairos contract compile --build` after an amendment should *merge* into the existing registration (add newly-produced workflows, keep prior-version workflows that still exist by name, only drop what `computeDroppedWorkflows()` — already shipped — says is genuinely gone) rather than blind-overwrite. This is a small, targeted fix to `registry.ts`'s save path, not a version-keyed rearchitecture, and should ship as part of this item since it's directly exposed by amendment for the first time (today nothing ever re-registers a contract that already has real evidence against it, so the gap has been latent, not yet harmful).

**Definition of done**

`kairos contract diff` renders a correct, breaking-vs-compatible-classified diff between two real versions; `kairos contract amend --confirm` archives the prior version (recoverable via `contract versions`/a direct file read) and never silently loses it; `kairos contract amend` without `--confirm` never writes anything; the active-instance and registration-staleness questions above are resolved as explicit, documented v0 rules (not left as silent gaps) before this ships; full test coverage; docs updated.

---

### 13. Automation P&L / Value Report

**What it is**

A report that translates `PromiseReportData`'s already-real, already-conservative counts (kept/missed/at-risk/unverifiable instances, resolved/open exceptions) into operator/client-facing "value" language — **only** when a human has supplied the per-unit assumptions needed to do that translation (e.g. "each resolved missed-SLA exception represents roughly 15 minutes of staff follow-up avoided"). Structurally two sections: an **Observed** section (always present, zero assumptions needed, identical in spirit to today's `promise-report.md`) and an **Estimated Value** section (present only when assumptions are supplied, every number traceable to `count × assumption`).

**Why it matters**

Sales/retainer conversations need something more concrete than raw counts, but §2.7 already found that a prior "automatic ROI math" idea was proposed and explicitly rejected in this codebase's own history — for good reason: fabricated-precision numbers erode trust faster than no numbers at all. The `impact-notes` worksheet already proved the right pattern (human supplies the real-world number, Kairos never guesses it) — this item is that same pattern applied to Promise Report data specifically, not a new philosophy.

**How it connects to current Kairos architecture**

- Consumes `PromiseReportData` (`report.ts`) unchanged as its factual base — `instanceCounts`, `openExceptionCount`/`resolvedExceptionCount`, `unattributedExecutionCount`, `disclaimers` all carry over untouched.
- Extends, rather than replaces, `generateImpactNotesTemplate()`'s philosophy (`pack-exporter.ts`) — a new, analogous human-fillable assumptions file, kept deliberately separate from the pack-level impact-notes template since this one is contract-scoped and recurring (filled in once, reused across every report run), not a one-time diagnostic-call worksheet.

**Files/subsystems likely affected**

- **NEW** `src/promise/value-report.ts` — `buildAutomationValueReport(reportData, assumptions?): AutomationValueReport`, pure, no I/O.
- **NEW** `src/promise/value-types.ts` — `ImpactAssumptions`, `AutomationValueReport`, `ValueLineItem`.
- **MODIFY** `src/promise/report-bundle.ts` or a new sibling writer — optional bundle output alongside `promise-report.md`.
- **MODIFY** `src/cli.ts` — `handleContractValue()`.

**Data models/types needed**

```ts
export interface ImpactAssumptions {
  /** All optional, all human-entered, all blank-if-unknown -- never defaulted by Kairos. */
  minutesSavedPerKeptInstance?: number
  minutesSavedPerResolvedException?: number
  dollarValuePerResolvedException?: number
  dollarValuePerAvoidedMiss?: number   // an instance that would plausibly have been 'missed' without the exception being caught and resolved
  currency?: string                     // required only if any dollar field above is present
  enteredBy?: string
  enteredAt?: string
}

export interface ValueLineItem {
  label: string
  formula: string           // literal, human-readable, e.g. "42 resolved exceptions × 15 min = 10.5 hours"
  count: number
  perUnitAssumption: number
  total: number
  unit: 'minutes' | 'hours' | 'currency'
}

export interface AutomationValueReport {
  observed: PromiseReportData        // unchanged, always present
  estimatedValue?: {
    lineItems: ValueLineItem[]
    assumptionsUsed: ImpactAssumptions
    disclaimer: string               // always present when this section exists: "Estimated from assumptions entered by <enteredBy> on <enteredAt>, not measured directly."
  }
}
```

**CLI/API surface**

```
kairos contract value <contract-id> --client-id <slug> [--assumptions <file.json>] [--from <date>] [--to <date>] [--bundle <dir>] [--json]
```

Without `--assumptions`, output is the Observed section only (a strict superset of today's `kairos contract report`, safe to run with zero setup). With `--assumptions <file.json>` (a hand-edited JSON file, matching `impact-notes`' own "human edits a file" pattern — no interactive editor needed for v0), the Estimated Value section is added.

**Tests/checkpoints**

- Unit: no `--assumptions` supplied → output has zero currency/time-value figures anywhere, only the unchanged Observed counts (an explicit invariant test, not just a happy path — this is the single most important guarantee this feature makes).
- Unit: partial assumptions (e.g. only `minutesSavedPerResolvedException` supplied) → only that line item appears, nothing invented for the missing fields.
- Unit: every `ValueLineItem.total` matches `count × perUnitAssumption` exactly, and `formula` renders that same arithmetic in text.
- Unit: a `currency` field is required (and validated) if any dollar-denominated assumption is present, refused otherwise with a clear error, never silently defaulting to a currency.

**Guardrails**

- No dollar or time figure computed without an explicit, present, human-supplied assumption for that specific multiplier — enforced structurally (the type itself has no non-optional numeric default anywhere).
- No assumption value is ever invented, inferred, benchmarked, or defaulted by Kairos itself, from any source (industry averages, LLM guesses, prior clients' assumptions) — this is the direct, explicit continuation of the `roi-ledger.md` rejection (§2.7).
- Every value line shows its own formula inline — never a bare final number with no visible derivation.
- The word "estimated" (or equivalent) appears on every value figure shown; the report never uses "saved" or "$X value" language without that qualifier attached.

**What not to build yet**

- No automatic assumption inference from any source.
- No multi-currency conversion.
- No forecasting/projection — this reports only on the observed window, never predicts future value.
- No default assumption library "for common industries" — a tempting shortcut that reintroduces exactly the fabricated-precision risk this whole item exists to avoid.

**Definition of done**

`kairos contract value` with no assumptions produces a report byte-for-byte equivalent (in its Observed section) to today's `kairos contract report`; with assumptions, every value figure is traceable to `count × assumption` with the formula shown; the "no assumptions → no dollar figures" invariant has a dedicated test; docs updated to reference the `roi-ledger.md` precedent explicitly so a future contributor understands *why* this stays conservative.

---

### 14. Operations Scout v0

**What it is**

A read-only, single-data-source, human-invoked diagnostic: point Kairos at one file (v0: a CSV export the human already produced) and get back an `OpportunityReport` — a small set of structured findings about messiness (stale rows, duplicate keys, missing-owner rows) that a human can review and, if a finding looks real, hand off directly into an Intake Interview session to start building a `ProcessContract` for that process.

**Why it matters**

Everything else in this roadmap assumes a `ProcessContract` already exists. Operations Scout is about the step *before* that: finding which process is worth building a contract for in the first place, for a business that doesn't already know. Per §2.9, this is genuinely new territory for Kairos — no existing subsystem reads external business data for analysis.

**How it connects to current Kairos architecture**

- Its only real integration point with existing code is at the *output* end: `kairos contract intake start` already accepts `--context <file>` (`cli.ts:1741`) — Scout's job is to produce a file shaped well enough to hand to that existing flag, not to build any new coupling into `intake.ts` itself.
- Otherwise deliberately standalone — no dependency on `ProcessContract`, `ProofLedger`, or any reliability-suite module, since by definition there is no contract yet for whatever Scout is looking at.

**Files/subsystems likely affected**

- **NEW** `src/scout/` (new top-level module, not under `promise/` or `reliability/` — it operates *before* a contract exists, so it doesn't belong under either) — `types.ts`, `csv-source.ts`, `checks.ts`, `report.ts`.
- **MODIFY** `src/cli.ts` — `handleScout()`.

**Data models/types needed**

```ts
export interface OpportunitySource {
  type: 'csv'          // v0: exactly one variant
  path: string
  /** Column-name hints -- v0 heuristics need to know which column is a status/timestamp/owner
   * column, and cannot assume fixed names across arbitrary client spreadsheets (see Risks). */
  columnHints?: { statusColumn?: string; timestampColumn?: string; ownerColumn?: string; keyColumn?: string }
}

export type OpportunityCheckId = 'STALE_ROWS' | 'DUPLICATE_KEY' | 'MISSING_OWNER'

export interface OpportunityFinding {
  checkId: OpportunityCheckId
  description: string
  rowCount: number
  totalRowCount: number        // denominator, always shown alongside rowCount, same discipline as item 11's sampleSize
  sampleRowRefs: number[]      // row INDEX references only -- never row content, never any cell value, in the report or --json output
  confidence: 'low' | 'medium' | 'high'
}

export interface OpportunityReport {
  source: OpportunitySource
  generatedAt: string
  findings: OpportunityFinding[]
  disclaimer: string           // always present: "Based on column-name heuristics against one file; confirm findings against the real process before treating them as fact."
}
```

**CLI/API surface**

```
kairos scout csv <file.csv> [--client-id <slug>] [--status-column <name>] [--timestamp-column <name>] [--owner-column <name>] [--key-column <name>] [--json]
kairos scout to-intake <report-id> --finding <finding-index> --client-id <slug>
```

`scout csv` is read-only against the input file; writes only the `OpportunityReport` itself (never the source file, never full row content) to `~/.kairos/opportunity-reports/<clientId>/`. `scout to-intake` renders the chosen finding as a short context brief (finding description + which check + row *count*, never row content) and writes it to a file, then prints the exact `kairos contract intake start --client-id <slug> --context <path>` command for the human to run — deliberately not auto-invoking intake itself, keeping the handoff a visible, separate, human-initiated step.

**Tests/checkpoints**

- Unit: `STALE_ROWS` — a fixture CSV with a timestamp column, some rows old/some recent, confirm the right rows (by index) are flagged and fresh rows are not.
- Unit: `DUPLICATE_KEY` — a fixture with a repeated key-column value, confirm detection and correct `rowCount`.
- Unit: `MISSING_OWNER` — a fixture with some blank owner-column cells.
- Unit: no PII in output — assert the serialized `OpportunityReport` (JSON) never contains any cell value from the source file, only row indices and counts (a structural invariant test, mirroring item 11's "no proposal without evidence" invariant test).
- Unit: `scout to-intake` output is a valid input to `intake.ts`'s own `--context` file-reading path (an integration-shaped unit test, no live LLM call needed).

**Guardrails**

- Every data source is explicit and human-supplied — `kairos scout csv <path>` requires the exact file; no auto-discovery, no directory crawling, no scanning a filesystem or inbox on its own initiative.
- File-based only in v0 — no live API/OAuth integration to Sheets, Gmail, Shopify, or any live system. This is not employee surveillance and must never become it: no continuous/scheduled scanning, no browser automation, no "record this task" session capture (all explicitly named as later/rejected paths in the source docs).
- No row content (cell values) ever appears in a report, in `--json` output, or in the `scout to-intake` handoff brief — row *indices* and *counts* only, so the human can look up the real row themselves in their own file if they want detail.
- Single-source only — no cross-file/cross-system correlation in v0.

**What not to build yet**

- Gmail/Calendar/Shopify/CRM/any live API integration — all deferred; v0 is file-only.
- Playwright/browser-based scraping — explicitly named in the source docs as "should not be the main architecture"; genuinely out of scope for v0, not merely deprioritized.
- Any scheduled/continuous scanning of a data source — Scout is a point-in-time, human-invoked diagnostic, never a watcher.
- Cross-source correlation.

**Risks/open questions**

- CSV schemas vary enormously across real businesses. Heuristics that assume fixed column names will misfire constantly; `columnHints` (human-supplied) is the v0 mitigation, but even with hints, a small/messy real file will produce some noisy findings. This is named directly in the source docs as the core risk of Scout mode ("needs intake + measurement integrity first or it becomes noisy" — that prerequisite work is now done, but the noise risk is inherent to the heuristic approach itself, not something sequencing alone fixes). The `confidence` field and the always-shown `disclaimer` are the mitigation, not a solution — this item should ship with an explicit expectation, stated to Codex/Jordan, that early real-world runs will need heuristic tuning.
- No existing convention in this codebase for a "pre-contract" module (everything else lives under `promise/` or `reliability/`, both of which assume a contract exists). Putting this at `src/scout/` is a new top-level module boundary — worth confirming with Codex before implementation, since it's a structural precedent for anything else that might need to run before a contract exists.

**Definition of done**

`kairos scout csv <file>` runs against a real CSV, all three v0 checks work correctly on crafted fixtures, `--json` output contains zero source-file cell values under test, `kairos scout to-intake` produces a file that `intake.ts`'s existing `--context` flag reads correctly, docs updated.

---

### 15. Self-Tuning Flywheel

**What it is**

A human-gated loop that promotes *validated, real-evidence-backed* observations about contract authoring, scenario generation, and intake questioning into confirmed "patterns" — which then influence *prompt context* for future contract synthesis/refinement, never silently rewrite generated output. Structurally a direct parallel to the already-shipped `PatternAnalyzer`/`patterns approve|reject` mechanism (§2.6), applied to a new evidence domain.

**Why it matters**

Right now, every lesson learned from a real client's contract (a scenario category that should probably always be generated, a question Intake Interview should have asked but didn't, an SLA default that's consistently wrong) lives only in a human's head or in this session's own memory files — nothing feeds it back into how Kairos authors the *next* contract. The validator-rule flywheel already proves this loop works when done carefully; this item is "do that again, for contracts."

**How it connects to current Kairos architecture**

- Deliberately modeled on, but **not sharing storage with**, `src/telemetry/pattern-analyzer.ts`'s `Pattern`/`PatternState`/`PatternAuditEntry`/`kairos patterns approve|reject`. Same shape, separate module, separate store — this is a **module-boundary decision, not an oversight**: validator patterns are about n8n generation mechanics (privacy-safe to whitelist-share today, per `community/whitelist.ts`); contract-authoring patterns are about a specific business's own process shape, a meaningfully different privacy surface that must never accidentally become shareable through a merged store.
- Confirmed patterns become **prompt-context additions** — read as extra context by `plan.ts`'s synthesis call (contract authoring) and/or `intake.ts`'s synthesis call (intake refinement), the same "prompt context, never silent output mutation" boundary the validator-pattern flywheel already respects for n8n generation.
- Evidence sources: real `ProofLedger`/`ExceptionDesk` data (via item 11's own evidence-reading path, reused rather than re-derived), item 11's own *accepted* amendment proposals (a proposal a human actually accepted is strong real-world evidence a pattern exists), and live-checkpoint-caught bugs (this arc's own session history is full of these, currently living only in commit messages and plan-doc "Shipped" notes, never structured).

**Files/subsystems likely affected**

- **NEW** `src/promise/contract-pattern-types.ts`, `src/promise/contract-pattern-analyzer.ts`, `src/promise/contract-pattern-store.ts` — deliberately named/placed to parallel `telemetry/pattern-analyzer.ts` in shape while staying structurally separate (own file, own store, own CLI namespace).
- **MODIFY** `src/promise/plan.ts` — read confirmed contract-authoring patterns as additional synthesis-prompt context (additive only).
- **MODIFY** `src/promise/intake.ts` — same, for refinement-round question generation.
- **MODIFY** `src/cli.ts` — new `kairos contract patterns ...` namespace.
- **NEW** `tests/unit/reliability/contract-pattern-boundary.test.ts` — a module-boundary firewall test (mirroring `tests/unit/reliability/module-boundaries.test.ts`'s own established pattern) asserting the new contract-pattern store never imports, and is never imported by, `telemetry/pattern-analyzer.ts` or `reliability/community/`.

**Data models/types needed**

```ts
export type ContractPatternCategory = 'sla_default' | 'exception_template' | 'scenario_gap' | 'intake_question_gap'
export type ContractPatternState = 'draft' | 'pending_review' | 'confirmed' | 'resolved'

export interface ContractPatternEvidenceRef {
  /** 'real' evidence can promote a pattern past pending_review. 'synthetic' (harness/scenario-
   * generator-derived) evidence can only ever keep a pattern at 'draft' -- structurally enforced,
   * not just documented (see Guardrails). */
  kind: 'real' | 'synthetic'
  source: 'accepted_amendment_proposal' | 'ledger_entry' | 'exception_item' | 'live_checkpoint_finding' | 'harness_scenario'
  refId: string
}

export interface ContractPatternAuditEntry {
  ts: string
  from: ContractPatternState | null
  to: ContractPatternState
  actor: 'auto' | 'human'
  reason?: string
}

export interface ContractPattern {
  id: string
  category: ContractPatternCategory
  description: string
  occurrenceCount: number
  clientCount: number            // how many distinct clientIds this has been observed across -- small-sample caution, see Risks
  evidence: ContractPatternEvidenceRef[]
  state: ContractPatternState
  suggestedPromptContext?: string   // the actual text that would be appended to a synthesis prompt, once confirmed -- human-editable before confirming, never silently generated-and-applied in one step
  history: ContractPatternAuditEntry[]
}
```

**CLI/API surface**

```
kairos contract patterns [--pending] [--json]
kairos contract patterns approve <pattern-id> [--reason <text>]
kairos contract patterns reject <pattern-id> [--reason <text>]
```

Deliberately its own namespace (`contract patterns`, not `patterns`) rather than a `--domain` flag on the existing command — keeps the CLI surface honest about the fact that these are two structurally separate stores with two separate privacy postures, rather than implying a shared backend that doesn't exist.

**Tests/checkpoints**

- Unit: a pattern whose only evidence is `kind: 'synthetic'` (harness-derived) cannot be promoted past `'draft'` — attempting to approve it is refused with a clear error, not silently allowed. This is the single most important test in this item.
- Unit: a pattern with real evidence (`kind: 'real'`) can move `draft → pending_review → confirmed` via explicit human actions, mirroring the existing `patterns approve/reject` test shape.
- Unit: `plan.ts`'s synthesis call includes confirmed pattern context only when patterns exist, and the addition is purely additive to the existing prompt (a snapshot/diff-style test on the constructed prompt string, not a live LLM call).
- Module-boundary test (above) — asserts zero import coupling with `telemetry/pattern-analyzer.ts` or `reliability/community/`, in both directions.
- Regression gate: `tests/integration/contract-harness-golden.test.ts` (already shipped) must stay green after any prompt-context change driven by a confirmed pattern — named explicitly as a required CI check for this item, not optional.

**Guardrails**

- No autonomous self-modification — every `draft → pending_review` and `pending_review → confirmed` transition requires an explicit human CLI action (`actor: 'human'` in the audit trail), identical in spirit to the existing validator-pattern gate.
- **Real-evidence-only promotion, structurally enforced**: the promotion function itself refuses (not just discourages) confirming a pattern whose evidence set is 100% `kind: 'synthetic'`. This directly answers Codex's own stated danger — *"Kairos could optimize for synthetic tests instead of reality"* — with a mechanism, not a policy statement.
- No cross-client pattern *sharing* for contract-authoring patterns, ever, in this item — deliberately narrower than the validator-pattern flywheel's own (already whitelist-audited) community-sharing feature, because a contract-authoring pattern is inherently about a specific business's process shape in a way a validator rule number is not. If this is ever revisited, it needs its own, separate privacy design pass — not an extension of `community/whitelist.ts`.
- Confirmed patterns only ever add prompt *context* — never post-process, filter, or rewrite an LLM's generated contract output directly.

**What not to build yet**

- No automatic numeric-threshold tuning (e.g., auto-adjusting a default SLA duration across all future contracts from aggregate data) — v0 is prompt-context suggestions only.
- No cross-client sharing (above).
- No fully-automated evidence-to-pattern pipeline — pattern *drafting* can be semi-automated (surfacing candidates from item 11's proposals), but promotion is always a discrete human action, never a background job that silently confirms things.

**Risks/open questions**

- What counts as "enough real evidence" is genuinely unclear this early — the validator-pattern flywheel had the benefit of thousands of n8n builds' worth of telemetry before its own confidence scoring became trustworthy; contract-authoring patterns will have very few real clients for a long time. `clientCount` is tracked explicitly in the data model above so a human reviewing a `pending_review` pattern can see "this is based on 1 client" vs. "this is based on 6 clients" and weight their approval accordingly — but there's no good automatic confidence formula for this yet, and v0 should not pretend to have one (no composite score, unlike the validator-pattern flywheel's `computeCompositeScore()` — deliberately simpler and more manual here, given the much smaller expected sample sizes).
- Overlaps meaningfully with item 11 (evolution proposals) as an evidence *source* — this is intentional, but the plan should be explicit that item 15 depends on item 11 existing first (see build order, §4).

**Definition of done**

A separate, tested `contract-pattern-analyzer` module exists with its own store; `kairos contract patterns` lists/approves/rejects exactly like the existing `kairos patterns` command family; a pattern with only synthetic evidence is provably unable to reach `confirmed` (dedicated test); at least one of `plan.ts`/`intake.ts` reads confirmed patterns as additive prompt context; the module-boundary firewall test passes; docs updated.

---

### 16. Platform Adapter Layer

**What it is**

The architecture (not the implementation) for eventually targeting Make/Zapier/other automation platforms from the same `ProcessContract`, via a `ProcessContract → PackPlan/WorkflowPlan IR → pluggable target generator` pipeline — reusing `compileToPackPlan()` (§2.8) unchanged as the shared upper layer, with only the final, currently-n8n-only generation step made pluggable in some future phase.

**Why it matters**

Named directly in both source documents as a real future direction, but also explicitly gated behind real demand and behind avoiding one specific trap: treating this as "translate n8n JSON into Zapier JSON," which both source documents independently call out as the wrong architecture (n8n's node/connection model has no clean structural equivalent in Zapier/Make — a direct JSON-to-JSON translator would be permanently brittle, chasing every n8n node-type edge case forever). Getting the *architecture* right now, on paper, prevents an expensive false start later.

**How it connects to current Kairos architecture**

Confirmed directly (§2.8) by reading `compile.ts`/`pack-builder.ts`: `compileToPackPlan(contract)`'s output already describes *which workflows to build and why* in business-purpose language — the actual n8n-JSON generation happens afterward, per-workflow, via the same LLM-prompt path (`Kairos.build()`) single-workflow generation already uses. This is a genuinely good starting position: the n8n-specificity in the current pipeline is concentrated in the *final generation step*, not the *planning step*. A platform adapter, when it's ever built, is therefore not a rearchitecture of `compile.ts` — it's a new, parallel generation step consuming the same `WorkflowPlan` shape n8n generation already consumes, plus a target-specific prompt/compiler analogous to today's n8n-specific one.

**Files/subsystems likely affected**

None in this pass. If/when this is ever built: a new `src/targets/` (or similar) module housing per-target generators, with `WorkflowPlan → n8n workflow JSON` (today's `Kairos.build()` path) refactored to be one interchangeable implementation of a shared interface, not special-cased into the pipeline.

**Data models/types needed**

None new in this pass. The eventual interface shape, sketched for future reference only:

```ts
// FUTURE, NOT BUILT:
interface TargetGenerator {
  target: 'n8n' | 'zapier' | 'make' | 'node'
  generate(plan: WorkflowPlan, context: GenerationContext): Promise<GeneratedAutomation>
}
```

**CLI/API surface**

None in this pass.

**Tests/checkpoints**

None in this pass — this section stays strategy-only.

**Guardrails**

- No direct n8n-JSON-to-target-JSON translator, ever, as the primary path — confirmed as the right call by reading the actual n8n JSON shape `compile.ts`/`Kairos.build()` produce, which is dense with n8n-specific node types and connection semantics with no general cross-platform equivalent.
- n8n stays the first and, for the foreseeable future, only real target — this item does not imply diluting n8n-specific quality/effort to hedge toward a hypothetical second target.

**What not to build yet**

Everything. No Zapier/Make adapter code, no `src/targets/` scaffolding, no refactor of `Kairos.build()`'s call sites — all explicitly deferred until real client demand exists, per Codex's own framing.

**Risks/open questions**

- The one thing worth flagging: `WorkflowPlan`'s current shape has never actually been audited field-by-field for n8n leakage (this pass only confirmed the high-level split between planning and generation, not that zero n8n-specific assumptions exist anywhere in `WorkflowPlan`'s own type). A real future adapter effort should start with that audit, not assume it's already clean.

**Definition of done (for this pass)**

The target architecture is documented here; zero code changes; explicitly deferred.

---

### 17. Node.js Optional Runtime

**What it is**

Two genuinely different things bundled under one roadmap number, and this plan separates them explicitly:

1. **Near-term**: Node as a deterministic harness/simulation/assertion layer — **already shipped** (§2.5, `src/promise/harness.ts`).
2. **Longer-term, explicitly not-yet**: Node as an *optional production execution runtime* for certain deterministic flows, where that's safer/cheaper/more testable than n8n — a real idea, deliberately unbuilt, gated behind durable-execution primitives (idempotency, retries, provenance) that don't exist anywhere in this codebase yet.

**Why it matters**

Naming these as two separate things prevents the roadmap from implying there's a large missing near-term build here — there isn't. What's actually missing is the *longer-term* half, and that half has real prerequisites that are easy to skip past if this item is treated as "just extend the harness a bit."

**How it connects to current Kairos architecture**

- The near-term half connects to everything already covered in items 9 (ProofLedger/ExceptionDesk Harness Tests, shipped) and, prospectively, item 15 (Self-Tuning Flywheel) — both already exercise/extend the harness. There is no separate "item 17 near-term" work left to plan; it would be double-counting already-shipped or already-planned work.
- The longer-term half connects to `ContractProvenance` (`types.ts`) and `BuildProvenance` (`src/types/result.ts`, referenced throughout this codebase's existing provenance conventions) as the natural starting model for what "Node execution provenance" would need to record — but nothing concrete exists to point at beyond that analogy.

**Files/subsystems likely affected**

None in this pass for the longer-term half. For the near-term half: none, because it's already built — this item's only real "file" is this plan document naming that fact clearly.

**Data models/types needed**

None in this pass.

**CLI/API surface**

None in this pass.

**Tests/checkpoints**

None in this pass.

**Guardrails**

- Node is never positioned as replacing n8n as the primary execution substrate — this is a hard, standing guardrail, not a v0-only caveat.
- Any future runtime work must design for idempotency, retries, durable state, and provenance **first**, as a hard prerequisite — not layered on after a first working version, the same lesson the source docs draw from Temporal's own positioning (long-running business processes must survive crashes/outages; bolting that on after the fact tends to fail).

**What not to build yet**

The runtime itself, in full — no queue/worker/service infrastructure, no decision about which flows would ever run in Node (that decision needs real operational pain data from actual n8n-based clients first — e.g., a flow that proves itself genuinely too slow, expensive, or fragile in n8n specifically, not a hypothetical).

**Risks/open questions**

- There is a real risk of this item being "rediscovered" as new work by a future planning pass that doesn't check current code first (exactly the mistake this document's own §2 design-verification pass was written to avoid) — worth stating plainly in the plan doc itself so a future reader doesn't re-propose building the harness from scratch.

**Definition of done (for this pass)**

The plan states explicitly that the near-term half is done, names the longer-term half's real prerequisites, and commits to zero code in this pass.

---

### 18. Dashboard / Portal (only if needed)

**What it is**

The lowest-priority item on this list, kept exactly there. `report-bundle.ts`'s `writePromiseReport()` already produces a static `promise-report.md` file plus a manifest — this **already is** the "static local report" the source docs describe as the right lightweight first version, if one is ever needed at all. The only increment worth even naming (not building) is rendering that same Markdown as a single, static HTML file — no server, no auth, no hosting, no database.

**Why it matters**

Named explicitly, last, in both source documents, with strong language against premature investment: a full SaaS dashboard means auth, hosting, billing, support, and security surface — all real, ongoing costs — for a need that doesn't currently exist. `README.md`'s own current framing has no dashboard claim anywhere in it; adding one prematurely would also be a positioning regression, not just wasted engineering time.

**How it connects to current Kairos architecture**

`report-bundle.ts` and the Delivery Bundle's own existing artifact list (`handoff.md`, `risk-report.md`, `monitoring-plan.md`, etc. — all static files) are the entire precedent. Nothing about the current architecture points toward needing a server anywhere in this stack.

**Files/subsystems likely affected**

None in this pass.

**Data models/types needed**

None in this pass.

**CLI/API surface**

None in this pass. If ever built: a purely additive `kairos contract report ... --html` flag rendering the same `PromiseReportData` (and, per item 13, `AutomationValueReport`) to a single static HTML file alongside the existing `.md` output — no new command, no new surface, no server.

**Tests/checkpoints**

None in this pass.

**Guardrails**

- No hosted anything, ever, without real client demand as the explicit trigger — this should be treated as a hard gate, not a soft preference.
- If ever built, the static-HTML increment must stay purely additive to `report-bundle.ts`'s existing output — never a replacement for the Markdown, never a dependency the CLI needs network access for.

**What not to build yet**

A full SaaS dashboard in any form — auth, hosting, billing, multi-tenant database, live updates, a support surface. All explicitly out of scope until real, paying client demand exists.

**Risks/open questions**

None beyond the obvious: if this is ever revisited, the trigger condition ("a real client asked for it") should be written down explicitly wherever that decision gets made, so it's traceable later why the investment was made.

**Definition of done (for this pass)**

The plan names the static-HTML-of-existing-Markdown option as the only thing worth even sketching, explicitly gated behind real demand, zero code in this pass.

---

## 4. Build order, grouping, and sequencing recommendation

### 4.1 Recommended build order

1. **Item 12's storage/versioning primitives first, ahead of Item 11's detection logic**, even though Codex's own numbering (and both source documents' own priority lists) put Evolution before Amendment/Diff. This is the one place this plan deviates from the source ordering, and it's grounded in §2.1/§2.2/§2.3: item 11 produces `ContractAmendmentProposal`s that are *inert* without item 12's accept path to act on them, but more importantly, item 12's version-archival gap (§2.1) is a real, standing risk **independent of item 11 entirely** — `contract import --confirm-version-change` already lets a human silently destroy contract history *today*, with no item-11 proposal involved at all. Fixing that gap has value on its own and should not wait on Evolution's detection logic being ready.
   - Recommend building 12's storage/versioning/diff layer first (a self-contained, well-scoped piece per §12's own definition of done), *then* 11's detection logic on top of a system that can actually act on what it detects, then wiring the two together (`--from-proposal`).
2. **Item 13 (Automation P&L) next**, independent of 11/12 — it only depends on already-shipped `report.ts`, and per both source documents' own priority ordering, it's valuable for sales/retainer conversations sooner rather than later. No sequencing dependency on anything else in this list.
3. **Item 15 (Self-Tuning Flywheel) after 11/12**, since its strongest real-evidence source (accepted amendment proposals) doesn't exist until item 11 does. Building 15 before 11 would starve it of its best evidence type and push it toward relying on synthetic (harness) evidence — exactly the trap its own guardrails exist to prevent.
4. **Item 14 (Operations Scout) can run in parallel with 11/12/13/15** — it has zero dependency on any of them (§2.9 confirms it's fully greenfield). The only reason it's not listed first is that both source documents independently rank it *after* the intake/measurement-integrity foundation for noise-avoidance reasons — that foundation is now done (this whole session's arc), so Scout is unblocked, but there's no strict *technical* dependency forcing it after 11–13/15 specifically. Sequence it wherever fits available effort.
5. **Items 16, 17, 18 stay planning/strategy-only** for this entire cycle — no implementation trigger exists for any of them yet (see §4.3).

### 4.2 Grouping

- **Group A — Contract lifecycle (11 + 12)**: build together, in the 12-then-11-then-wire-together order above. They share storage conventions and are only really useful in combination.
- **Group B — Client-facing proof (13)**: independent, can ship any time, no coupling to Group A.
- **Group C — Discovery (14)**: independent, greenfield, can ship any time.
- **Group D — Learning loop (15)**: depends on Group A being live first (for its strongest evidence source); otherwise independent of B/C.
- **Group E — Deferred strategy (16, 17, 18)**: no build work; revisit only when named trigger conditions are met (real second-platform demand; real Node-runtime operational pain in n8n; real client dashboard ask).

### 4.3 What should remain deferred, and why

- **Item 16 (Platform Adapters)**: deferred until real client demand for a non-n8n target exists. Building this speculatively risks locking in an IR shape before there's a real second target to validate it against.
- **Item 17 (Node runtime, longer-term half)**: deferred until a specific, real flow demonstrably struggles in n8n specifically (cost, latency, fragility) — building durable-execution infrastructure speculatively is exactly the kind of "overbuild this now" both Codex and the source docs warn against.
- **Item 18 (Dashboard)**: deferred until a real client explicitly asks, per Codex's own explicit guardrail. Even then, the static-HTML increment described above is the only thing that should be considered before a genuine SaaS ask materializes.

### 4.4 What to build first, concretely

**Recommendation: start with item 12's storage/versioning/diff layer** (§3, item 12 — specifically `store.ts`'s archive-on-write extension and `diff.ts`'s pure diff/breaking-change classifier), for three reasons: (a) it closes a real, standing data-loss risk that exists in production code *today*, independent of any new feature; (b) it is the most self-contained, cleanly-testable piece of the whole list (pure functions, file-store extension, no LLM, no network, no sandbox); (c) it unblocks item 11 from day one rather than producing proposals with nowhere to land.

### 4.5 Biggest risks across the whole roadmap

1. **The active-instance version-pinning question (item 12, Risk 1)** is the single hardest open design problem in this entire document. It needs a real decision (recommended: the conservative "breaking changes wait for in-flight instances to terminate" rule) confirmed with Codex before any code is written, not resolved ad hoc mid-implementation.
2. **Item 11's evidence gap (§2.4)**: the roadmap's own headline example ("3 attempts vs 2 attempts") is not fully buildable from today's data model. If Codex wants that specific capability rather than the frequency/hotspot-based v0 described here, a structured-evidence schema addition to `ExceptionStatusChange` needs to be scoped and approved as its own small prerequisite piece first.
3. **Item 15's evidence-quality bar**: the guardrail that synthetic (harness) evidence can never alone promote a pattern is only as good as its enforcement — this must be a structural check in the promotion function itself (refuses, not just discourages), verified by a dedicated test, not a documented convention a future change could silently violate.
4. **Item 14's noise risk** is inherent to CSV-heuristic discovery and isn't solved by sequencing alone — worth setting expectations that early real-world runs will need heuristic/threshold tuning, not treating a first working version as done-done.
5. **Scope creep into platformization** (items 16/18 especially) is a standing risk given how much of the source-document material *wants* to talk about these — this plan's own guardrails need to actually hold in a future planning pass, not just in this one.

### 4.6 Contradictions found against current code or docs

- The source documents' framing of Contract Evolution's worked example implies more capability than `ExceptionDeskItem`'s current schema supports (§2.4) — not a contradiction in intent, but a real gap between the example given and what's buildable without a small schema addition first. Named explicitly in item 11's Risks so it isn't silently under-delivered.
- No other real contradictions found — the source documents' own architecture recommendations (Process Contract as source of truth, ProcessContract → target compiler rather than n8n-JSON → Zapier-JSON, Node as harness-first) all check out cleanly against the current, real code, which is a genuinely good sign that the codebase has been built in the direction these documents describe all along, not that it needs correcting to match them.

### 4.7 Items that are strategy-only and should stay that way for now

Items 16, 17 (longer-term half), and 18 — all three are documented above at full depth per Codex's request, and all three conclude with "zero code, explicitly deferred." None should be pulled forward into implementation without a named, real trigger condition being met first (see §4.3).

---

## 5. Summary

| # | Item | Depends on | Status after this doc |
|---|------|-----------|------------------------|
| 11 | Contract Evolution v0 | Item 12's storage layer (for its accept path to mean anything) | Planned, real scope gap named (§2.4) |
| 12 | Contract Amendment/Diff | None (build first) | Planned, two hard open questions named (active-instance pinning, registration staleness) |
| 13 | Automation P&L / Value Report | None | Planned, fully independent, safe to build any time |
| 14 | Operations Scout v0 | None (greenfield) | Planned, fully independent |
| 15 | Self-Tuning Flywheel | Item 11 (for its strongest evidence source) | Planned, structural guardrail specified |
| 16 | Platform Adapter Layer | Real client demand (not met) | Strategy only, zero code |
| 17 | Node.js Optional Runtime | Real n8n operational pain (not met); near-term half already shipped | Strategy only for the unshipped half, zero code |
| 18 | Dashboard / Portal | Real client demand (not met) | Strategy only, zero code |
