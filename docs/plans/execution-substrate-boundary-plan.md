# Execution Substrate Boundary v0 — Planning Only (Revision 5)

**Date:** 2026-07-22. **Status: planning only, nothing implemented.** Revision 5 responds to a fourth-pass technical review (Codex) of Revision 4, which found the architecture sound and confirmed all 17 prior corrections landed correctly, but identified two genuine behavioral regressions (a credential requirement leaking into the one path that must never need it; an overall deployment outcome that misclassifies an all-dry-run build) plus ten further design and self-containment gaps. **This document is now fully self-contained** — every section that Revision 4 shortened to "unchanged from Revision 3" is restored here in full, because Revision 3 is not preserved anywhere else in this repository and an implementer must be able to work from Revision 5 alone. Every claim below was independently re-verified against the real source this pass, with file:line citations, not accepted from either review's own text.

**A note on method, since the user has asked that this plan always carry its own why/when/where/how/guardrails/reasoning/outcomes, not just its conclusions:** every section below states not only *what* is being built or changed, but *why it must be this way* (the concrete defect or requirement that forces the design), *where* in the real codebase the relevant behavior lives today (file:line), *when* in the phased rollout it happens and why that ordering is safe, *how* it is implemented (concrete types and control flow, not just prose), *what guardrails* keep it from drifting into the "fake generic n8n abstraction" failure mode named in §4, and *what the observable outcome* is once it ships. Where a decision has real, non-obvious trade-offs, both sides are stated, not just the choice made.

---

## 0. Purpose, scope, and how to read this document

**Why this arc exists at all.** Kairos's Promise Engine (`ProcessContract` → compiled workflows → `ProofLedger` → `ExceptionDesk`/reports) is architecturally sound as a *business-meaning* layer — `ProcessContract` itself has zero n8n concept (§3.1) — but its *execution* path (compile → build/deploy → poll evidence → verify) is hard-wired to n8n at every step (§3.2). The sponsor brief's own framing, preserved verbatim because it is the single sentence that most precisely states the goal: *"The goal is not to remove n8n. The goal is to make n8n replaceable and optional at the architecture boundary."* Today, replacing n8n would mean rewriting the Promise Engine's own compile/deploy/evidence code, not writing a new adapter next to it. This plan is the boundary that changes that, for the narrow slice of the codebase (contract compile/build/evidence) where it actually matters, without touching anything else.

**Why not sooner, why not later.** Not sooner: Items 4–15 (intake, scenarios, harness, compiler verification, evolution, value reporting, scout, learning) needed to exist first to prove the Promise Engine's *business* layer was mature enough to be worth protecting with a real boundary — building this boundary before those items would have been premature abstraction around a still-changing shape. Not later: every new Promise Engine feature since has added one more n8n-specific call site (three now, precisely enumerated in §3.2); the longer this waits, the more call sites accrete and the larger the eventual refactor becomes.

**Why "narrow," repeatedly, throughout this document.** Every design choice below is checked against one question: does this genuinely need to change to achieve target-neutrality, or is it scope creep dressed as thoroughness? The non-goals in §14 are not a formality — five separate revisions of review specifically pushed back on scope in both directions (Revision 2 excluded too much — the actual build/deploy path; later reviews caught places where the design implicitly assumed more scope than intended, like credentials leaking into the dry-run path). The discipline that has held across all five revisions: touch only what a genuinely target-neutral compile→build→evidence path requires, wrap existing tested code rather than rewrite it, and name every place a shortcut was tempting and rejected.

**How to read this document if you are about to implement Phase 1.** Read §5 (the shared validation/decomposition helper) and §15 (phased order) first — they define the one new invariant every other phase depends on. Then read §6 in full — it is the actual interface design, and every one of its eight subsections states why that specific interface exists, not just its shape. §18 is the test-to-correction traceability matrix; treat it as the actual acceptance checklist for "is this revision's design safe to build," not a formality to skim.

---

## 1. Executive summary

**The sponsor brief's "current assessment of Kairos" checks out cleanly against the real code — no factual claim in it was contradicted, across five revisions of increasingly adversarial review.** Every specific coupling point (contract compilation, workflow registration, ProofLedger polling, evidence extraction, compiler verification, replay, chaos, sandbox, drift/repair/rollback, CLI construction sites) is independently verified with file:line precision in §3.

**Findings carried forward from every prior revision, all still true today:**
- `IProvider` is public API, unused internally, and itself n8n-shaped (§3.3 — restored in full this revision).
- The Promise Engine (`src/promise/*`) is entirely absent from the published npm API (§3.4 — restored in full this revision), narrowing the real public-API risk to `IProvider`/`N8nProvider`/`ClientOptions`/`N8nWorkflow`-family types only.
- `PackPlan`/`WorkflowPlan` is an n8n-adapter-specific artifact shape, not the neutral intent itself (§5).
- `evidenceNodeName()`'s naming convention is a concrete, shipped instance of "a generic evidence marker that assumes an n8n node name" (§3.2, §6.4).
- The `n8nWorkflowId`-as-identifier pattern recurs in `src/library/`, `src/pack/pack-wirer.ts`, `src/reliability/watch/loop.ts` — still explicitly out of scope, named rather than silently ignored.
- `harness.ts`/`scenario.ts` are reusable ingredients for, not already, a real execution adapter (§7).

**What this revision corrects, all independently re-verified against real source this pass:**

1. **A real credential regression is fixed.** `contract compile --build --dry-run` must never require `N8N_BASE_URL`/`N8N_API_KEY` — confirmed true of today's code (`cli.ts`'s compiler-verification gate is `if (!isDryRun && !buildResult.escalation)`, only then does it check `registeredWorkflows.length > 0` before ever constructing `N8nApiClient`). Revision 4's `resolveContractDeployTarget()` constructed `N8nApiClient` unconditionally on every `--build` call, dry-run or not. Deployer construction is now split from deployment-lookup/verifier construction, with the latter created only after a real (non-dry-run, non-blocked) deployment produced at least one real `targetDeploymentId` — mirroring today's exact gate. §6.2.
2. **Golden parity is now genuinely achievable.** The shared `prepareContract()` helper's escalation strings are corrected to match `compile.ts`'s real, exact text byte-for-byte (confirmed this pass, `compile.ts:222-249`) — Revision 4's version had silently dropped a trailing clause from each of the two escalation `reason` strings, which would have broken the very golden-fixture comparison this plan depends on to prove the refactor is behavior-preserving. §5.
3. **A distinct overall `'generated'` deployment outcome is added.** `ContractDeployOutcome` previously had no way to represent "every slot in this build was a successful dry run" without incorrectly computing to `'deployed'` — a real, confirmable classification bug (an all-`'generated'`-slots build has no `'failed'` slot, so Revision 4's `slots.every(s => s.outcome !== 'failed') ? 'deployed' : 'partial'` logic wrongly returned `'deployed'`). §6.2.
4. **Compiler-verification fetch-error semantics are made explicit, with a stated decision, not left ambiguous.** Confirmed this pass (`compiler-verify.ts:52-71`, `cli.ts:2330-2364`): today's `verifyCompiledWorkflows()` receives only the *successfully fetched* workflows — a workflow that failed to fetch is invisible to it, meaning its own evidence requirements will be reported as structurally *missing* (a false-looking "gap") rather than "unknown because we couldn't check." This is real, existing, pre-boundary behavior. This plan's explicit decision (with reasoning, not silence): **preserve it exactly, unchanged**, because fixing it would require modifying `verifyCompiledWorkflows()` itself — a function this whole plan has committed, in every revision, to wrap rather than rewrite. The conflation is named, documented, and left as a pre-existing, out-of-scope limitation, not silently carried forward as if it were fine. §6.5, §13.
5. **The document is restored to fully self-contained.** §3.3 (IProvider), §3.4 (public API map), and §6.7 (watermark design, types, and pseudocode) are written out in full below, not referenced as "unchanged from Revision 3" — a prior revision this repository does not separately retain.
6. **`DeployedSlotResult` and `ContractPreparationResult` are now real discriminated unions.** Every non-null assertion (`s.ref!`, `prepared.decomposition!`) is removed from the design; TypeScript's own control-flow narrowing replaces them. §6.2, §5.
7. **A persisted *outer* registration container type is defined.** Only the per-workflow `PersistedRegisteredWorkflow` existed before; `loadRawRegistration()` (`registry.ts:73-80`) returns a whole registration object, whose own outer shape (and whose `workflows` array's *element* type) needed its own name. §6.6.
8. **`PollContractResult`'s canonical-field change is assigned to exactly one phase (Phase 1), not two contradictory ones.** Revision 4 listed it under both Phase 1's expanded scope and Phase 4's own description — resolved by recognizing it belongs with the other purely mechanical, no-new-interface dual-write changes (registration, watermark) that Phase 1 already owns. §15.
9. **Execution-history ordering is defensively enforced, and a cross-component target-id guard is added.** `N8nExecutionHistorySource` now sorts and truncates its own result rather than trusting n8n's API to maintain newest-first ordering forever; a new `assertConsistentTargetIds()` check catches a wiring mistake (mismatched ref/history-source/normalizer) at one clear point rather than three separate, less-diagnostic throws. §6.4.
10. **Golden-baseline sequencing is reclassified as a required process checkpoint, not a runtime test.** Git commit ordering cannot be reliably verified by an automated test (a packaged npm tarball has no `.git` directory at all) — this is now documented as a two-commit procedure enforced by code review, with the runtime test doing only what it can actually prove (current output matches the committed fixture content). §12, §15, §18.
11. **Contract Evolution's target-provenance wording is corrected.** `ExceptionDeskItem` (confirmed this pass, `exception-types.ts:29-59`) has no `targetId` field at all — target provenance can be threaded into `AmendmentEvidenceRef{kind: 'ledger_entry'}` from `ProofLedgerEntry.targetId`, but **not** into `AmendmentEvidenceRef{kind: 'exception_item'}` refs without a further, separate, not-yet-decided schema change to `ExceptionDeskItem` itself — named explicitly as an open question, not silently implied to already work. §6.8.
12. **The in-memory adapter's deployment references now resolve to slot-specific data, not the whole decomposition copied under every slot's id.** Revision 4's `this.deployments.set(id, artifact)` stored the *entire* `ContractDecomposition` under each individual slot's own deployment id — meaning fetching any one slot returned every slot's data, weakening the very conformance proof this adapter exists to provide. Corrected to store one `WorkflowSlot` per deployment id, matching how n8n itself deploys N independently-fetchable workflows. §7.

No implementation is proposed to begin. This document is written so the phases in §15 can be authorized individually, in order, with a real checkpoint after each.

---

## 2. Roadmap relationship — why this doesn't reopen or reorder anything already decided

`docs/plans/contract-evolution-ops-roadmap-plan.md`'s own "Items 16–18 Remain Later / Deferred" section (lines 1888–2146) remains authoritative, unchanged, across every revision of this plan. **Why this matters enough to restate every revision:** this arc is easy to mistake for Item 16 (Platform Adapter Layer) or Item 17 (Node runtime) if read carelessly — it is neither. It is explicitly the *prerequisite* infrastructure Item 16's own existing text anticipates ("only the final, currently-n8n-only generation step made pluggable in some future phase," line 68 of that document) — built now, without building the pluggable step itself, without building a second target, and without starting Item 16, Item 17's runtime half, or Item 18. The roadmap decision order given in the sponsor brief (Item 18 next, then Item 17's Hatchet-vs-Temporal spike, then Item 16 only on real demand) is unaffected by anything in this plan.

---

## 3. Current coupling map — verified against real source, fully restored this revision

**Why this section exists, and why it is this long.** Every design decision in §5 onward is justified by a specific fact about the current codebase — not by architectural preference. This section is the evidentiary record those justifications point back to. It is organized by concern (the sponsor brief's own list: contract compilation, deployment, registration, evidence extraction, compiler verification, replay/chaos/sandbox, drift/repair/rollback, CLI construction sites) because that is the shape the eventual boundary itself takes (§6).

### 3.1 Already target-neutral — confirmed by direct code read, not assumed

**Why check this at all, rather than assume ProcessContract is clean because it's "supposed to be":** the whole point of a design-risk audit (§4) is not trusting a component's stated purpose — it is checking whether n8n concepts leaked into it anyway, the way they leaked into `IProvider` despite that type's own generic name (§3.3). Every file below was grepped for `n8n`/`N8n` case-insensitively; every hit is individually characterized, not just counted.

| Module | n8n/N8n hits | Nature of every hit |
|---|---|---|
| `src/promise/types.ts` (ProcessContract itself) | 0 | — |
| `src/promise/store.ts` | 0 | — |
| `src/promise/intake.ts` | 0 | — |
| `src/promise/plan.ts` | 0 | — |
| `src/promise/scenario.ts` | 0 | — |
| `src/promise/exception-desk.ts` | 0 | — |
| `src/promise/evolution.ts` | 0 | — |
| `src/promise/value-report.ts` | 0 | — |
| `src/promise/learning.ts` | 0 | — |
| `src/promise/diff.ts` | 0 | — |
| `src/promise/harness.ts` | 3 | Doc comments only ("fed synthetic evidence instead of a real n8n poll", "no n8n, no network", "extracted from n8n JSON") |
| `src/promise/sla-compliance.ts` | 1 | Doc comment only |
| `src/promise/report.ts` | 1 | Doc comment only |
| `src/promise/validate.ts` | 2 | Doc comments only |
| `src/promise/business-calendar.ts` | 1 | Doc comment only (a string-format note) |

**Outcome of this check:** `ProcessContract`'s own type (`src/promise/types.ts`) has zero n8n concept anywhere — the "source of truth" claim holds under direct inspection, not just by design intent. This is the load-bearing fact behind §17's first eventual-boundary DoD bullet ("`ProcessContract` remains unchanged and target-neutral") — it is a fact to *preserve*, not a property this plan needs to *create*.

### 3.2 Operationally n8n-dependent — mapped per concern, with exact file:line evidence

**ProcessContract compilation → PackPlan generation** (`src/promise/compile.ts`, 297 lines):
- `compileToPackPlan()` returns `{ plan: PackPlan, traceability: ContractWorkflowTrace[], escalation?: CompileEscalationInfo }` (compile.ts:53-60 — note `plan`, not `artifact`; this exact field name is why §6.2's n8n compiler wrapper explicitly renames it at the boundary rather than assuming it).
- Its real internal order, re-confirmed this pass (compile.ts:222-296): `validateProcessContract(contract)` → if errors, return an escalation with **exact text**, quoted here because golden parity depends on it byte-for-byte (correction 2): *`'This ProcessContract fails deterministic validation and cannot be compiled until fixed. Run \`kairos contract validate\` for the full list.'`* → blocking-assumption check → if any, return an escalation with this exact text: *`'This ProcessContract has blocking assumptions that must be resolved before compiling. Resolve them (edit the contract and re-validate), or compile anyway once they no longer apply.'`* → **only then** do the three `build*Workflow` functions run. **§5 factors this exact order, and these exact strings, into a shared `prepareContract()` helper called by every target's own compiler.**
- `buildProcessingWorkflow()` (compile.ts:120-168) embeds n8n-specific codegen prose directly into `WorkflowPlan.description` (compile.ts:145) — instructing the generation LLM to name a node exactly `"Kairos Evidence: <transitionId>"`.
- The parallel, already-neutral channel: `ContractWorkflowTrace.sourceElements` (compile.ts:48-51) records `evidenceRequirement:<transitionId>`, `startCondition:<id>`, `transition:<id>` as plain strings with zero n8n concept.

**Why this matters for the boundary design:** the compile step does two genuinely separable things at once — deciding *which workflow slots exist and what contract elements they trace to* (target-neutral) and *writing n8n-flavored English prose describing them for an LLM to codegen against* (n8n-specific). §5 is the fix.

**Workflow deployment** (`src/client.ts`, `src/pack/pack-builder.ts`):
- `Kairos.provider: N8nProvider | null` (client.ts:41) — the concrete class, not `IProvider`. **Why this matters:** it means even the codebase's own primary abstraction point (`IProvider`) isn't actually used at the one place a caller could swap providers — see §3.3 for the full consequence.
- `PackBuilder`'s constructor: `{anthropicApiKey, kairos: Kairos, model?, n8nBaseUrl?, maxTokens?}` (pack-builder.ts:227) — holds a `Kairos` instance, calls it internally per workflow inside `build()`.
- `PackBuilder.build(plan, options)`'s real `options`/`onProgress` shape (pack-builder.ts:270-278): `onProgress?: (workflow: WorkflowPlan, index: number, total: number) => void` — receives a `WorkflowPlan` object, not a name string.
- **`PackBuilder.build()`'s real per-workflow outcome construction, confirmed this pass (pack-builder.ts:386-405), three branches, quoted precisely because the correct outcome classification (§6.2) depends on getting this exactly right:**
  1. Dependency-unavailable skip: `{ workflowId: null, deployed: false, error: 'Not built: required dependenc[y|ies] unavailable (...)' }`.
  2. **A successful build or dry run** (the branch inside the `try`, after `this.kairos.build(...)` resolves without throwing): `{ workflowId: result.workflowId, deployed: !result.dryRun, ...no error field at all... }` — `result.workflowId` is `null` for a dry run (by `Kairos.build()`'s own design: dry runs *deliberately* never register a fake/placeholder id) and a real string for a live deploy; `deployed` is `false` for a dry run, `true` for a live deploy; **`error` is never present on this branch, dry-run or not.**
  3. A caught-exception failure (the `catch` branch): `{ workflowId: null, deployed: false, error: err instanceof Error ? err.message : String(err) }`.
  - **The load-bearing fact this plan's outcome classification depends on:** the true failure signal is *whether `error` is present*, never `workflowId === null` in isolation — branches 2 (dry-run success) and 3 (real failure) both have `workflowId: null`, and are distinguished *only* by `error`'s presence. Getting this wrong (as Revision 4 initially did, and as an even earlier check of the *overall* build outcome still did until this revision — correction 3) misclassifies a successful dry run as a failure or, at the aggregate level, as a real deployment.
- `handleContractCompile` (cli.ts:2251): `new PackBuilder({anthropicApiKey, kairos})` — constructed lazily, only inside the `--build` branch, needing only an Anthropic key (via `kairos`), never n8n credentials at this point.
- **The real compiler-verification gate, confirmed this pass (cli.ts:2306-2320):** `if (!isDryRun && !buildResult.escalation) { ...build registeredWorkflows from workflows with a real workflowId and no error...; if (registeredWorkflows.length > 0) { ...only HERE does N8nApiClient get constructed... } }`. **This is the exact gate §6.2's `resolveContractDeployTarget()`/`resolveVerificationTarget()` split must reproduce** — n8n credentials are required only for a real (non-dry-run), non-blocked build that produced at least one real deployment.
- **The real registration-construction site, confirmed this pass (cli.ts:2311):** `{ n8nWorkflowId: w.workflowId, workflowName: w.name, sourceElements: ..., contractVersion: contract.version, status: 'active', registeredAt }` — the exact object literal Phase 1 must also mechanically extend with a `targetId`/`targetDeploymentId` dual-write.
- **The real build-then-print-then-persist sequence, confirmed this pass (cli.ts:2277-2299):** `buildResult` (the raw `WorkflowPackResult`) drives JSON output, `printPackResult(buildResult)` (typed to expect a real `WorkflowPackResult`), and whole-object persistence to `~/.kairos/packs/<buildResult.packName>.json`. **§6.2's generic-raw-type design exists specifically so this exact sequence keeps working with zero cast, ever.**

**Workflow registration** (`src/promise/registry.ts`, 134 lines):
- `saveContractWorkflowRegistration()`'s real merge (registry.ts:96-99): `const byId = new Map((existing?.workflows ?? []).map(w => [w.n8nWorkflowId, w])); for (const w of reg.workflows) byId.set(w.n8nWorkflowId, w)` — keyed by `n8nWorkflowId` alone, no target concept.
- Its real write (registry.ts:100-101): `await writeFile(path, ...)` **directly to the final path**, inside a lock (`acquireFileLock`), with **no temp-file-then-rename** — unlike `ledger-store.ts`'s own watermark writer (confirmed: `ledger-store.ts:117-120` writes to `${path}.tmp` then `rename()`s it). A process killed mid-`writeFile()` here could leave a truncated, invalid JSON registration file; the sibling watermark file cannot suffer the equivalent failure, because it was already built with the safer pattern.
- `loadRawRegistration()`'s real signature (registry.ts:73-80): reads and `JSON.parse`s the file, returning the *raw, on-disk* shape (or `null`) — **this function's own return type has never had an explicit name distinct from the canonical, in-memory `ContractWorkflowRegistration` type**, a real gap this plan closes (correction 7, §6.6).
- `computeDroppedWorkflows()` (registry.ts:131-133): `existingWorkflows.filter(w => !newWorkflowNames.has(w.workflowName))` — not scoped by target at all.

**Execution polling / evidence extraction / ProofLedger ingestion** (`src/promise/ledger.ts`, 372 lines; `src/promise/ledger-types.ts`):
- `extractExecutionEvidence()` (ledger.ts:148-276) parses raw n8n execution shape directly: `data.resultData.runData[nodeName][runIndex].data.main[branchIndex][itemIndex].json` — confirmed against a real live n8n execution per the Phase 3 design-verification spike (`docs/plans/process-contract-promise-engine-plan.md` §6.0, Finding 1).
- `evidenceNodeName(transitionId)` → `` `Kairos Evidence: ${transitionId}` `` (compile.ts:87-89) is the naming convention the extractor itself resolves today (ledger.ts:174) — the concrete, shipped instance of "a generic evidence marker that assumes an n8n node name" (§4).
- `PollableN8nClient` (ledger-types.ts:159-162) declares `getExecutions`/`getExecution` — the *real* `N8nApiClient` method names (confirmed, `api-client.ts:156,183`), not the differently-named `listExecutions`/`fetchExecution` this plan's own `ExecutionHistorySource` interface uses — meaning a real, if small, wrapper class is required (§6.4), not a "already satisfies it" claim.
- `ContractPollWatermark.n8nWorkflowId` (ledger-types.ts:91) is the flat watermark map's own key (`ledger-store.ts:116`: `all[watermark.n8nWorkflowId] = watermark`).
- `pollWorkflowEvidence()`'s real watermark construction (ledger.ts:341-357) builds `newWatermark` as a plain object literal with `n8nWorkflowId`.
- `PollContractResult`'s real shape (ledger-types.ts:133-153): `{ contractId, n8nWorkflowId: string, executionsChecked, entries, outcomes, newWatermark, possibleGap, unattributedCount }` — its sibling `ContractPollWatermark` was corrected in an earlier revision; this type was not, until this revision (correction 8, §6.4/§15).
- `ProofLedgerEntry.id` construction (ledger.ts:210,258): `` `${execution.id}:${ev.transitionId}:${itemPosition(item)}` `` / `` `${execution.id}:instance_start:${itemPosition(item)}` `` — carries no target discriminator.

**Compiler verification** (`src/promise/compiler-verify.ts`, 133 lines):
- `checkEvidenceNodesPresent()` (compiler-verify.ts:52-71) builds `allNodeNames` from **only the workflows it was handed** and checks every `contract.evidenceRequirements` entry's `evidenceNodeName()` against that set. **The load-bearing consequence, re-confirmed this pass and stated explicitly (correction 4):** a workflow that failed to fetch is simply absent from the input array — its evidence requirements are then reported as *missing*, indistinguishable from a genuine structural gap. This is today's real, existing behavior, not something this plan introduces.
- `checkCorrelationKeyReferenced()` (compiler-verify.ts:73-92) calls `extractWebhookFieldRefs()` (`src/pack/webhook-schema.ts`) — an n8n webhook-trigger-specific parser.
- `handleContractCompile`'s real fetch loop (cli.ts:2336-2364, confirmed this pass): a per-workflow `try { apiClient.getWorkflow(...) } catch (err) { fetchErrors.push(...) }`, with `fetchErrors` reported **entirely separately** from `verification.findings`, and `compilerVerificationHasGaps` computed only from `verification.verdict`, never from `fetchErrors.length`. **§6.5 preserves this exact two-channel reporting**, while also naming (per correction 4) that a fetch error can still *indirectly* cause a real gap finding inside `verification` itself, via the mechanism described above.

**Contract Evolution** (`src/promise/evolution-types.ts`, `src/promise/evolution.ts`):
- `AmendmentEvidenceRef`'s real shape (evolution-types.ts:25-28): `{ kind: AmendmentEvidenceRefKind, id: string }` — `AmendmentEvidenceRefKind = 'ledger_entry' | 'exception_item' | 'harness_scenario'` — no target field on any of the three kinds.
- Its real construction site (evolution.ts:103-104, inside `detectRateHotspot()`): `input.ledgerEntryIds.map((id): AmendmentEvidenceRef => ({ kind: 'ledger_entry', id }))` and `input.exceptionItemIds.map((id): AmendmentEvidenceRef => ({ kind: 'exception_item', id }))` — both built from bare id strings.
- **`ExceptionDeskItem`'s real shape, confirmed this pass (`exception-types.ts:29-59`): `{ id, contractId, promiseInstanceId, kind, status, owner, nextAction, reason, evidence: string[], slaId?, expirationRuleId?, transitionId?, detectedAt, updatedAt, history }` — no `targetId` field anywhere on this type.** This is the precise fact behind correction 11: target provenance can be threaded into a `kind: 'ledger_entry'` ref (from `ProofLedgerEntry.targetId`) but **cannot** be threaded into a `kind: 'exception_item'` ref without a separate schema change to `ExceptionDeskItem` itself — which this plan does **not** propose, and names as an open question rather than silently implying it already works (§6.8, §13).

**Three, precisely enumerated, contract-specific CLI call sites** (unchanged inventory across every revision, re-confirmed):
1. `handleContractCompile`'s `--build` branch (cli.ts:2247-2364) — compile/deploy + compiler-verification. **Phase 3's scope.**
2. `handleLedgerPoll` (cli.ts:3500-3582) — evidence polling. **Phase 4's scope.**
3. `runContractComplianceTick` (cli.ts:4369-4442, called from `handleWatch --contracts`) — a near-duplicate of #2's own polling loop. **Phase 4's scope.**

Beyond these three, `n8nWorkflowId` appears 72 times total in `cli.ts` and 15+ separate `new N8nApiClient(...)` construction sites exist — the other sites (`sync-nodes`, `pack export` flags, `pack wire`, `trace record`, `chaos run --live`, `replay capture/run --live`) are **not contract-specific** and are explicitly out of scope, per the sponsor brief's own "does not require converting every existing non-contract Kairos command to a generic target."

**Replay / Chaos / Sandbox** (`src/reliability/replay/*`, `src/reliability/chaos/*`, `src/reliability/sandbox/manager.ts`):
- `sandbox/manager.ts` (426 lines, 39 n8n hits — the highest density in the codebase) literally spawns `npx n8n@<PINNED_N8N_VERSION> start` (manager.ts:182). No abstraction exists here at all today; this module *is* n8n.
- `chaos/static-audit.ts` operates directly on `N8nNode`/`N8nWorkflow` types and n8n node-type strings (`n8n-nodes-base.if`/`.switch`/`.httpRequest`) and n8n's own error-handling model (`onError`/`retryOnFail`/`stopWorkflow`).
- **Why these are legitimately out of scope, not merely deferred for convenience:** they are target-*specific reliability capabilities*, exactly the kind the sponsor brief itself says "may remain n8n-specific" — a future runtime target having a completely different health/repair mechanism is expected, not a gap to paper over with a fake shared abstraction (§4's own risk table names this exact trap).

**Drift / repair / rollback** (`src/reliability/drift/*`, `src/reliability/repair/*`):
- `drift/checks.ts` operates on `ExecutionTrace[]` — an already-normalized structure produced by `src/telemetry/execution-tracer.ts`'s `parseExecutionTrace()`, itself parsing raw n8n runData independently of, and never reused by, `ledger.ts`'s own extraction logic. **This is a second, redundant re-implementation of "parse n8n execution data," left unaddressed — unifying it is explicitly out of scope (§13, §14) because doing so would require touching `src/reliability/drift/*`, which this whole plan has committed not to touch.**
- `repair/apply.ts`/`repair/propose.ts` operate directly on `N8nWorkflow` — genuinely n8n-structural (field-level diffing of real n8n node/connection JSON).

### 3.3 The `IProvider` finding — restored in full this revision (correction 5)

**Why this fact matters more than its file size suggests.** `IProvider` is the pre-existing type in this codebase that looks, by name, exactly like what this whole plan is trying to build — a generic execution-target abstraction. Understanding precisely why it *isn't* that, and precisely why the new interfaces in §6 are not simply "IProvider, but tried again," is the single most important piece of context for anyone approaching this plan fresh.

`src/providers/types.ts` defines:

```typescript
export interface IProvider {
  readonly platform: string
  deploy(workflow: N8nWorkflow): Promise<DeployResult>
  update(id: string, workflow: N8nWorkflow): Promise<DeployResult>
  get(id: string): Promise<N8nWorkflow>
  list(): Promise<WorkflowListItem[]>
  activate(id: string): Promise<void>
  deactivate(id: string): Promise<void>
  delete(id: string, options: DeleteOptions): Promise<void>
  executions(workflowId?: string, filter?: ExecutionFilter): Promise<ExecutionSummary[]>
  execution(id: string): Promise<ExecutionDetail>
  tag(workflowId: string, tagIds: string[]): Promise<void>
  untag(workflowId: string, tagIds: string[]): Promise<void>
  listTags(): Promise<Tag[]>
  createTag(name: string): Promise<Tag>
}
```

**Where it is used — every reference in the whole codebase, grepped, not sampled:**

```
src/standalone.ts:12:export type { IProvider } from './providers/types.js'
src/index.ts:6:export type { IProvider } from './providers/types.js'
src/providers/types.ts:5:export interface IProvider {
src/providers/n8n/provider.ts:4:import type { IProvider } from '../types.js'
src/providers/n8n/provider.ts:20:export class N8nProvider implements IProvider {
```

**What this means, precisely:** `IProvider` is exported publicly (part of the real npm package API surface) but is used as a *type* — as something a function parameter, a class field, or a test accepts — **nowhere** except `N8nProvider`'s own `implements` clause. No code anywhere in `src/` or `tests/` is written against `IProvider`; every real call site holds a concrete `N8nProvider` reference. It is a *declared* abstraction with *zero* consumers that actually depend on the abstraction rather than the concrete class — decorative, not load-bearing.

**Why its own shape is n8n-specific despite its generic name — the concrete "fake generic abstraction" instance:**
- `deploy(workflow: N8nWorkflow)` and `get(id): Promise<N8nWorkflow>` take/return the concrete n8n workflow-JSON type directly, not a generic artifact type.
- `ExecutionDetail` (`src/types/result.ts:79-93`) — the return type of `execution()` — has `data?: unknown` and `workflowData?: unknown` fields that are, by their own doc comments, placeholders for n8n's own execution-data shape, under generic-sounding field names.
- `ExecutionSummary.mode: string` is n8n's own execution-mode field, carried through unmodified.

**Confirming this is even deeper than the interface itself — `client.ts` doesn't use `IProvider` at all, even where it could:**
- `Kairos.provider: N8nProvider | null` (client.ts:41) is typed against the **concrete class**, not `IProvider`.
- `client.ts`'s `build()` method calls `provider.checkWebhookReachable(workflow)` and `provider.smokeTest(deployed.workflowId, workflow)` — **neither method exists on `IProvider` at all** (confirmed: `IProvider`'s declared 13 methods, listed above, include neither). These are only on the concrete `N8nProvider` class (`n8n/provider.ts:94,153`).
- **The conclusion this forces:** even if a caller wanted to program against `IProvider` today, they structurally could not use `client.ts`'s own `build()` flow that way — two of the methods it depends on simply aren't part of the interface's contract. `IProvider` isn't merely unused by convention; the codebase's own primary consumer of provider behavior has already outgrown what it declares.

**What Reuse — the one genuinely useful, reusable seed found in `IProvider`:** `readonly platform = 'n8n'` (`n8n/provider.ts:20`) — an existing string discriminator for "which target is this," already present, already following the exact convention this plan's own `TargetId` (§6.1) reuses rather than reinventing.

**Why §6's new interfaces are deliberately NOT built as an extension of `IProvider` — stated as a direct comparison, since Codex has explicitly required this document say so clearly:**

| | `IProvider` | The new interfaces (§6.2-§6.5) |
|---|---|---|
| Visibility | **Public npm API** — exported from `index.ts`/`standalone.ts`. | **Internal only** — never exported from any public entry point. |
| Level of abstraction | Raw n8n workflow CRUD — one level *below* a compiled artifact. | One level *above* — a compiled `ProcessContract` artifact and its deployment references, never a bare workflow JSON type. |
| Scope | Every Kairos command that touches a workflow (`build`, `pack export`, `chaos`, `drift`, `repair`, ...). | Only the three contract-specific CLI call sites named in §3.2 — nothing else changes. |
| Relationship to concrete n8n classes | `N8nProvider implements IProvider` directly. | The new n8n implementations **wrap** `compileToPackPlan()`/`PackBuilder`/`Kairos.build()`/`N8nApiClient` — calling the existing concrete classes, never replacing or extending `IProvider`'s own contract in any way. |
| What happens if this arc never ships | `IProvider` is completely unaffected either way — it was never touched, in any revision. | N/A — these types don't exist yet. |

**Guardrail this comparison enforces, restated as a standing rule for every phase in §15: `IProvider` is never modified, extended, deprecated, or referenced by any new type in this plan, in any phase.** Revisiting it is explicitly reserved for a future arc, only alongside a real second target (Item 16), as its own deliberate, version-conscious decision — never a byproduct of this one.

### 3.4 Public API surface map — restored in full this revision (correction 5)

**Why this matters:** every design decision about "can we change this type's shape" in §6-§9 depends on knowing precisely what is, and is not, a real compatibility commitment to external consumers of `@kairos-sdk/core`. Getting this wrong in either direction is costly — being too conservative would block legitimate internal refactoring; being too loose would silently break a real consumer.

**`src/index.ts`'s real, complete export list** (the package's default entry point, `import ... from '@kairos-sdk/core'`):
- Classes: `Kairos`, `N8nProvider`, `N8nApiClient`, `N8nFieldStripper`, `NullLibrary`, `FileLibrary`, `N8nValidator`, `NodeRegistry`, `PackBuilder`, `TemplateSyncer`, `TelemetryCollector`, `TelemetryReader`.
- Types: `IProvider`, `ScoredEntry`, `WorkflowCluster`, `IWorkflowLibrary`, `WorkflowMatch`, `StoredWorkflow`, `FailurePattern`, `WorkflowMetadataInput`, `SourceKind`, `TrustLevel`, `OutcomeData`, `OutcomeStats`, `EmbeddingFn`, `ExecutionTrace`, `ValidationResult`, `ValidationIssue`, `N8nWorkflow`, `N8nNode`, `N8nConnections`, `N8nSettings`, `Tag`, `BuildResult`, `DeployResult`, `SmokeTestResult`, `WorkflowListItem`, `ExecutionSummary`, `ExecutionDetail`, `CredentialRequirement`, `ClientOptions`, `BuildOptions`, `DeleteOptions`, `ExecutionFilter`, `PackPlan`, `WorkflowPlan`, `WorkflowPackResult`, `PackWorkflowResult`, `TypedAssumption`, `AssumptionType`, `PackStatus`, `SyncProgress`, `ILogger`, `RuleFailureRate`, `TelemetryEvent`, `AttemptMetadata`.
- Functions/constants: `hybridScore`, `clusterWorkflows`, `rerank`, `derivePackStatus`, `generateHandoff`, `validatePack`, `nullLogger`, plus the `KairosError` family (`GenerationError`, `ResponseParseError`, `ResponseTruncationError`, `ValidationError`, `ProviderError`, `ApiError`, `GuardError`, `DeployActivationError`).

**`src/standalone.ts`'s export list** — a deliberately smaller subset (excludes `Kairos` itself and its `@anthropic-ai/sdk` dependency, per its own doc comment: *"Use this when you only need validation, the library, or the MCP server and don't want to install @anthropic-ai/sdk"*) — otherwise overlapping substantially with `index.ts`: `N8nProvider`, `N8nApiClient`, `N8nFieldStripper`, `IProvider`, `NullLibrary`, `FileLibrary`, `N8nValidator`, `NodeRegistry`, the same `N8nWorkflow`/`ClientOptions`/error-family types, `TemplateSyncer`, `TelemetryCollector`/`Reader`, and `PatternAnalyzer` (with its own `Pattern`/`PatternAnalysis`/`PatternState`/etc. types) — which `index.ts` does not separately re-export.

**The one fact every design decision in §5-§9 rests on: nothing from `src/promise/` is exported from either entry point.** Confirmed directly (`grep -n "promise" src/index.ts src/standalone.ts` returns zero matches, re-confirmed this revision). `ProcessContract`, `ProofLedgerEntry`, `ContractWorkflowRegistration`, `ContractPollWatermark`, `AmendmentEvidenceRef`, `ExceptionDeskItem` — none of it is importable from `@kairos-sdk/core` today. `src/mcp-server.ts` likewise exposes zero contract/ledger/promise concepts (confirmed: `grep -n "contract\|promise\|ledger" src/mcp-server.ts` returns nothing) — the MCP server surfaces only the generation-loop tools (`kairos_prompt`/`kairos_validate`/`kairos_deploy`).

**Practical consequence, stated as the operating rule for the rest of this document:** the entire Promise Engine — every type and function this plan touches in §5-§9 — can be freely restructured internally with **zero** public-npm-API breaking-change risk. The real, non-zero public-API risk is concentrated entirely in `IProvider`/`N8nProvider`/`N8nApiClient`/`ClientOptions`/`N8nWorkflow`-family types — **none of which this plan proposes touching, in any phase** (§10, §14).

**One more fact worth stating precisely, since it changes the risk calculus further:** `package.json` has zero *runtime* dependency on n8n packages — `n8n-core`/`n8n-nodes-base`/`@n8n/n8n-nodes-langchain` are `devDependencies` only (used at build time by `scripts/generate-node-catalog.ts` to generate a static node catalog). Kairos talks to n8n exclusively over its own REST API (`N8nApiClient`), with no package-level coupling at all — meaning even the deepest layer of "how does Kairos depend on n8n" is already healthier than a typical SDK-embedding integration would be.

---

## 4. Design risk check — looking for fake-generic-n8n-shaped abstractions, restated with reasoning for each row

**Why this check exists as its own section, separate from the coupling map.** §3 answers "where does n8n leak in." This section answers a narrower, more dangerous question: "if we build a 'generic' interface to fix that, will the new interface secretly just be n8n wearing a neutral name?" The sponsor brief names this as the primary design risk, with six illustrative examples, precisely because a plan that merely renames n8n concepts under generic-sounding labels would be worse than no plan at all — it would create false confidence that a boundary exists.

| Illustrative risk | Found in current code? | Why, and where the fix lives |
|---|---|---|
| generic "node" that is really an n8n node | **Yes, if `IProvider`'s shape were extended naively.** `IProvider.deploy(workflow: N8nWorkflow)` already takes a concrete n8n type under a generic-sounding interface name — precisely the trap a naive extension would repeat. | §3.3; avoided by never extending `IProvider` at all. |
| generic "workflow id" that assumes n8n workflow identity | **Yes, pervasively** — `n8nWorkflowId` as a field/parameter name across `RegisteredWorkflow`, `ContractPollWatermark`, `PollContractResult`, `PollableN8nClient`'s call sites, plus (out of scope) `StoredWorkflow`, `WiredWorkflow`, `WatchTarget`. | §3.2, §6.4, §6.6, §6.7 — every in-scope instance gets a canonical `targetId`/`targetDeploymentId` pair with the n8n-named field demoted to an optional legacy alias. |
| generic "execution" shaped like n8n runData | **Yes.** `ExecutionDetail.data?: unknown`/`.workflowData?: unknown` are placeholders for n8n's own execution shape under generic-sounding field names. | §3.3; the neutral `NormalizedExecution` type (§6.4) is deliberately built from Kairos concepts (execution reference, event time, transition ID, evidence fields), never from this shape. |
| generic "trigger" that assumes an n8n webhook | **Yes**, in compiler verification's `checkCorrelationKeyReferenced()`, which assumes a webhook trigger with `body`/`query`/`headers`. | §3.2; left exactly as-is, since compiler verification remains n8n-specific behind `N8nCompilerVerifier` (§6.5) rather than generalized. |
| generic "evidence marker" that assumes an n8n node name | **Yes — the clearest instance found in the whole codebase.** `evidenceNodeName()`'s entire convention (a literally-named node in a visual node-graph) has no meaning for a non-node-based target. | §3.2, §6.4 — node-name resolution happens entirely inside the n8n adapter's own normalizer; the neutral extractor never calls `evidenceNodeName()` or knows a node-naming convention exists at all. |
| generic "credential" that assumes n8n credential storage | Not investigated this pass — `ClientOptions.n8nBaseUrl`/`n8nApiKey` are already explicitly n8n-named, not disguised as generic, so this specific *disguise* risk doesn't currently apply. Credential handling generally is out of this plan's scope. | Not in scope. |
| capability-flags-only "interface" with no real methods behind it | **Yes — an early draft of this plan's own `TargetCapabilities` design was an instance of this**, before being corrected into the six real, narrow interfaces in §6.2-§6.5. | §6 — every capability flag now corresponds to a real interface with a real implementation, or is explicitly labeled informational-only with no interface backing it at all (next row). | 
| a capability type claiming coverage for capabilities no interface in this arc actually backs | **Yes — an earlier draft's `TargetCapabilities` included `replay`/`chaos`/`sandbox`/`drift`/`repair`/`rollback` as if they were part of this boundary's own consumable surface**, when nothing in this plan reads or type-checks against them. | §6.1 — split into `ImplementedCapabilities` (this arc's own six real interfaces) and `InformationalReliabilityCapabilities`, explicitly and permanently labeled as descriptive metadata about n8n's separate reliability modules, consumed by no code path in this plan. |

**The standing conclusion, re-confirmed at every revision:** every one of the sponsor brief's illustrative risks has a real, findable, named instance somewhere in this codebase or in an earlier draft of this very plan. This is not a hypothetical to design around in the abstract — it is a concrete checklist every new type in §6 was built against, and re-checked against on each revision.

---

## 5. Target-neutral trace construction — a shared `prepareContract()` helper, with golden-parity-exact escalation text

**Why (the concrete defect this section fixes, twice over).** Two separate problems converge here, both found by review, both real: (1) Revision 3's design left the *logic* that decides "which workflow slots exist" entirely inside `compileToPackPlan()` — meaning a future target, including the in-memory reference adapter this plan itself proposes, would have had to call n8n's own compiler just to get a neutral trace. (2) Revision 4's fix for (1) introduced its *own* new bug: the shared helper's escalation-message text didn't match `compile.ts`'s real strings byte-for-byte, which would silently break the golden-fixture parity test this whole refactor depends on to prove itself safe (§12).

**Where.** `src/promise/decomposition.ts` (new file, this arc). Consumed by `src/promise/compile.ts` (the n8n compiler, refactored to call it) and by `src/promise/targets/in-memory/adapter.ts` (Phase 5, the in-memory compiler).

**When.** Phase 2 (§15) — after Phase 1's compatibility scaffolding, before Phase 3's compile/deploy interfaces (which depend on `decomposeContract()` existing).

**How.**

```typescript
// src/promise/decomposition.ts (NEW, this arc — pure, zero target concept, zero LLM call)

export type WorkflowSlotKind = 'intake' | 'processing' | 'escalation'

export interface WorkflowSlot {
  /** Deterministic name -- identical to what compile.ts computes today, so the n8n adapter's
   * output stays byte-identical after refactor (verified by the golden-fixture test, §12). */
  name: string
  kind: WorkflowSlotKind
  /** Identical shape to today's ContractWorkflowTrace.sourceElements -- zero n8n concept. */
  sourceElements: string[]
  /** Present only for kind: 'intake' -- which StartCondition this slot realizes. */
  startConditionId?: string
}

export interface ContractDecomposition {
  slots: WorkflowSlot[]
}

/** Pure. The exact trace-construction half of buildIntakeWorkflow()/buildProcessingWorkflow()/
 * buildEscalationWorkflow() (compile.ts), extracted verbatim -- same three conditions (one
 * intake slot per startCondition; a processing slot iff transitions.length > 0; an escalation
 * slot iff sla.length > 0 || expirationRules.length > 0), same naming, same sourceElements
 * construction. Never calls validateProcessContract() itself -- the ONLY caller is
 * prepareContract() below, which guarantees validation and the blocking-assumption check have
 * already passed before this runs. */
export function decomposeContract(contract: ProcessContract): ContractDecomposition {
  const slots: WorkflowSlot[] = []
  for (let i = 0; i < contract.startConditions.length; i++) {
    const sc = contract.startConditions[i]!
    const name = contract.startConditions.length === 1
      ? `${contract.entity.name} Intake`
      : `${contract.entity.name} Intake ${i + 1}`
    slots.push({ name, kind: 'intake', startConditionId: sc.id, sourceElements: [`startCondition:${sc.id}`, `state:${sc.initialState}`, 'correlationKey'] })
  }
  if (contract.transitions.length > 0) {
    slots.push({
      name: `${contract.entity.name} Processing & Outcome Logging`,
      kind: 'processing',
      sourceElements: [...contract.transitions.map(t => `transition:${t.id}`), ...contract.evidenceRequirements.map(e => `evidenceRequirement:${e.transitionId}`)],
    })
  }
  const expirationRules = contract.expirationRules ?? []
  if (contract.sla.length > 0 || expirationRules.length > 0) {
    slots.push({
      name: `${contract.entity.name} SLA Escalation`,
      kind: 'escalation',
      sourceElements: [...contract.sla.map(s => `sla:${s.id}`), ...expirationRules.map(e => `expirationRule:${e.id}`), ...contract.exceptions.map(e => `exception:${e.id}`)],
    })
  }
  return { slots }
}

/** Discriminated union (correction 6) -- removes every non-null assertion a caller would
 * otherwise need. TypeScript's own control-flow narrowing on `outcome` makes `decomposition`
 * and `escalation` mutually exclusive and always correctly typed, with no `!` anywhere. */
export type ContractPreparationResult =
  | { outcome: 'ready'; decomposition: ContractDecomposition }
  | { outcome: 'blocked'; escalation: CompileEscalationInfo }

/** THE shared, target-neutral preparation step every target's own compileContract() calls
 * FIRST -- validate -> check blocking assumptions -> decompose, in that exact order, matching
 * compileToPackPlan()'s own existing order (compile.ts:222-296) precisely, INCLUDING its exact
 * escalation text (correction 2 -- Revision 4's own version of this function had silently
 * dropped a trailing clause from each string below; both are now copied verbatim from
 * compile.ts:230,244, confirmed this pass, so the golden-fixture parity test (§12) is checking
 * something real, not something this refactor itself redefined). Exists specifically so a
 * target's own compiler cannot forget or reproduce the blocking-assumption gate incorrectly --
 * the concrete bug an earlier draft of the in-memory adapter's own pseudocode had (§7). */
export function prepareContract(contract: ProcessContract): ContractPreparationResult {
  const errors = validateProcessContract(contract).filter(i => i.severity === 'error')   // UNCHANGED existing function
  if (errors.length > 0) {
    return {
      outcome: 'blocked',
      escalation: {
        reason: 'This ProcessContract fails deterministic validation and cannot be compiled until fixed. Run `kairos contract validate` for the full list.',
        questions: errors.map(e => `[Rule ${e.rule}] ${e.message}${e.path ? ` (${e.path})` : ''}`),
        source: 'validation_errors',
      },
    }
  }
  const blocking = contract.assumptions.filter(a => a.type === 'blocking')
  if (blocking.length > 0) {
    return {
      outcome: 'blocked',
      escalation: {
        reason: 'This ProcessContract has blocking assumptions that must be resolved before compiling. Resolve them (edit the contract and re-validate), or compile anyway once they no longer apply.',
        questions: blocking.map(a => a.text),
        source: 'blocking_assumptions',
      },
    }
  }
  return { outcome: 'ready', decomposition: decomposeContract(contract) }
}
```

**`compileToPackPlan()` is refactored to call `prepareContract(contract)` first**, branching on `outcome`, then (on `'ready'`) running its own existing kind-specific n8n-prose generation keyed off each `WorkflowSlot`. The in-memory compiler (§7) calls the **identical** `prepareContract()` — not a hand-written copy of the same two checks — so it inherits both the validation gate and the blocking-assumption gate automatically, and cannot silently diverge from either in the future.

**Guardrails.** `decomposeContract()` is never called directly by any CLI code, by `resolveContractCompiler()`, or by anything outside a target's own `compileContract()` implementation — it has exactly one caller, `prepareContract()`, and `prepareContract()` has exactly two callers, one per target's compiler (§6.2, §7). This is what makes "every target validates before decomposing" a structural guarantee rather than a documented expectation that could silently drift.

**Outcome / how this is verified.** Before any refactor code is written, every existing fixture contract (`tests/fixtures/contracts/*.json`) is run through **today's, pre-refactor** `compileToPackPlan()`, and its exact `{plan, traceability}` output — including a contract deliberately constructed to trigger *both* escalation paths — is reviewed and committed to `tests/fixtures/contracts/golden-compile/<fixture-name>.expected.json`, in its own dedicated commit, **before** `decomposeContract()`/`prepareContract()` are written (§12, §15 — this ordering is a process checkpoint, not a runtime test, per correction 10). The refactored code is then tested against these already-committed, human-reviewed baselines — including the two escalation-path fixtures, which are the direct test for correction 2.

`PackPlan`/`WorkflowPlan` remains, precisely, the n8n adapter's own artifact shape — never the neutral intent. A hypothetical future target with a different generation strategy would consume `ContractDecomposition` directly and produce its own artifact shape, never touching `compileToPackPlan()` or `WorkflowPlan.description`'s n8n-flavored prose at all.

---

## 6. Six narrow internal interfaces, capability model, and why this is not `IProvider`

**Why six, and why not one.** The sponsor brief's own interface-separation guidance explicitly warns against "one enormous ExecutionAdapter interface." Six interfaces exist here because six distinct, independently-cited defects each required their own seam: bundling compile+deploy would have forced the plan-only path to need Anthropic credentials it doesn't need today (§6.2); compiler verification needing its own interface, rather than the CLI casting `DeploymentLookup`'s `raw: unknown` itself, is what keeps n8n-specific narrowing out of `cli.ts` entirely (§6.5). Every interface below is traceable to a concrete, cited reason it exists — none is speculative future-proofing.

All new types are additive, internal, and never exported from `index.ts`/`standalone.ts` (§3.4) — meaning every choice in this section carries **zero** public npm API risk, only internal-refactor risk, which is fully covered by the test suite (§12, §18).

### 6.1 Shared identity/capability types

**Why a discriminated union for capabilities, not booleans.** A flat boolean either overclaims (marking n8n's own `replay` capability `true` when the local sandbox that replay actually needs might not be bootable in a given environment — a real, named precondition risk from the reliability-suite arc's own S1/S2 spike) or requires an undocumented precondition check living somewhere else entirely. Making the precondition part of the capability's own declared shape means a consumer can never read `state: 'conditional'` without also being handed the `note` explaining why — TypeScript enforces this structurally, not just by convention.

```typescript
// src/promise/targets/types.ts (NEW)

export type TargetId = string   // reuses IProvider.platform's existing string-discriminator convention (§3.3)

export interface TargetDeploymentRef {
  targetId: TargetId
  targetDeploymentId: string
}

/** Collision-safe composite key, shared by registry.ts's merge logic (§6.6) and
 * ledger-store.ts's watermark keying (§6.7) -- one implementation, not two independent copies
 * of the same escaping logic. Plain string concatenation ("${targetId}:${targetDeploymentId}")
 * would collide whenever either value itself contains ':' -- e.g. targetId: 'foo' +
 * targetDeploymentId: 'bar:baz' produces the identical string as targetId: 'foo:bar' +
 * targetDeploymentId: 'baz'. encodeURIComponent escapes ':' into '%3A' in both components
 * first, so the delimiter can only ever be the intentional separator. */
export function targetRefKey(ref: TargetDeploymentRef): string {
  return `${encodeURIComponent(ref.targetId)}:${encodeURIComponent(ref.targetDeploymentId)}`
}

/** A real discriminated union, not an interface allowing every field combination -- TypeScript
 * itself now enforces that `note` can only exist, and MUST exist, when state === 'conditional'. */
export type CapabilityDescriptor =
  | { state: 'supported' }
  | { state: 'unsupported' }
  | { state: 'conditional'; note: string }

/** Only the six capabilities THIS ARC actually defines interfaces for (§6.2-§6.5). Any consumer
 * can rely on: if a field here says 'supported', a matching interface exists and is implemented
 * by that target. */
export interface ImplementedCapabilities {
  compile: CapabilityDescriptor
  deploy: CapabilityDescriptor
  fetchDeployment: CapabilityDescriptor
  executionHistory: CapabilityDescriptor
  evidenceExtraction: CapabilityDescriptor
  compilerVerification: CapabilityDescriptor
}

/** Purely informational (§4's own risk-table correction). Describes what n8n's own, separate,
 * untouched reliability modules (src/reliability/{replay,chaos,drift,repair,sandbox}) support --
 * for a future console/report to display (Codex-Plan.txt's own Item 18 framing names exactly
 * this use: "The Local Console can later display normalized targets, deployments, evidence, and
 * capabilities"). NO interface exists anywhere in THIS plan for any of these six; nothing in
 * this arc's own code type-checks against, calls, or consumes this data. A future arc that
 * actually builds a real interface for one of these would move that field into
 * ImplementedCapabilities; until then this is metadata only. */
export interface InformationalReliabilityCapabilities {
  replay: CapabilityDescriptor
  chaos: CapabilityDescriptor
  sandbox: CapabilityDescriptor
  drift: CapabilityDescriptor
  repair: CapabilityDescriptor
  rollback: CapabilityDescriptor
}

export interface TargetCapabilities {
  implemented: ImplementedCapabilities
  reliability: InformationalReliabilityCapabilities
}
```

```typescript
// src/providers/n8n/capabilities.ts (NEW, Phase 3/4)

export const N8N_CAPABILITIES: TargetCapabilities = {
  implemented: {
    compile: { state: 'supported' },
    deploy: { state: 'supported' },
    fetchDeployment: { state: 'supported' },
    executionHistory: { state: 'supported' },
    evidenceExtraction: { state: 'supported' },
    compilerVerification: { state: 'supported' },
  },
  reliability: {
    replay: { state: 'conditional', note: 'Requires a bootable local n8n sandbox (kairos sandbox up) -- see docs/plans/reliability-suite-plan.md S2.' },
    chaos: { state: 'conditional', note: 'Tier A (audit) is always supported; Tier B (run) requires the same sandbox as replay.' },
    sandbox: { state: 'conditional', note: 'Requires network access to fetch the pinned n8n package version via npx.' },
    drift: { state: 'supported' },
    repair: { state: 'supported' },
    rollback: { state: 'supported' },
  },
}
```

**Guardrail.** `TargetCapabilities` is structurally required to have exactly `implemented`/`reliability` as its two top-level keys — there is no flat top-level capability field a caller could accidentally branch on without first deciding which bucket they mean. §18's test for this is explicit: it is a *lint*-style assertion (no production code path outside the `capabilities.ts` files reads `.reliability.*` for a branching decision), not just a type check, because TypeScript alone cannot prove "nothing consumes this."

### 6.2 Contract compilation and deployment — split interfaces, credential-isolated construction, corrected outcome classification

**Why split into two interfaces at all (the concrete regression this avoids, twice named by review).** `handleContractCompile`'s plan-only path (`kairos contract compile <file.json>`, no `--build`) calls only `compileToPackPlan(contract)` today (cli.ts:2207-2208) and needs **zero credentials**. The `--build` branch is the only place `PackBuilder` (needing an Anthropic key) gets constructed, and does so lazily (cli.ts:2251). A single interface bundling compile+deploy would force every caller — including the plan-only path — to hold a fully-constructed adapter (meaning a constructed `PackBuilder`, meaning an Anthropic key) just to compile.

**Why this correction needed a second pass (correction 1, the deeper version of the same principle).** Fixing the compile/deploy split alone was not sufficient — a later draft's `resolveContractDeployTarget()` still unconditionally constructed `N8nApiClient` (via `getEnvOrExit('N8N_BASE_URL')`/`getEnvOrExit('N8N_API_KEY')`, which **exit the process** if those env vars are absent) on *every* `--build` call, including `--build --dry-run`. Confirmed against today's real gate (cli.ts:2306-2320, quoted in full in §3.2): n8n credentials are required **only** for a real, non-dry-run, non-blocked build that produced at least one real deployment. The fix below is not "split compile from deploy" — it is "split compile, deploy, and verification-against-real-n8n into three separately-constructible pieces, gated exactly where today's code gates them."

```typescript
// src/promise/targets/contract-compiler.ts (NEW)

export interface ContractCompileResult<TArtifact> {
  artifact: TArtifact   // compileToPackPlan() returns `plan`; the n8n wrapper maps plan -> artifact explicitly (compile.ts:53-60)
  traceability: ContractWorkflowTrace[]
  escalation?: CompileEscalationInfo
}

export interface ContractCompiler<TArtifact = unknown> {
  readonly targetId: TargetId
  /** Calls prepareContract() (§5) FIRST, internally -- never receives a pre-computed
   * ContractDecomposition as a parameter, and never skips validation. */
  compileContract(contract: ProcessContract): ContractCompileResult<TArtifact>
}
```

```typescript
// src/promise/targets/contract-deployer.ts (NEW)

/** Three outcomes (correction 1, from the earlier review round): 'generated' is a real,
 * successful completion state -- a dry run intentionally produces no deployment id
 * (compile.ts's own comment elsewhere in this codebase: "--dry-run deliberately never registers
 * fake/placeholder workflow ids"). Confirmed against PackBuilder.build()'s real result
 * construction (pack-builder.ts:386-405, quoted in full in §3.2): the true failure signal is
 * `error` being present, never `workflowId === null` in isolation. */
export type SlotDeployOutcome = 'deployed' | 'generated' | 'failed'

/** Discriminated union (correction 6) -- `ref` and `error` are only ever accessible on the
 * variant where they're guaranteed present; no `s.ref!` non-null assertion is possible or needed
 * anywhere downstream. */
export type DeployedSlotResult =
  | { slotName: string; outcome: 'deployed'; ref: TargetDeploymentRef }
  | { slotName: string; outcome: 'generated' }
  | { slotName: string; outcome: 'failed'; error: string }

export interface ContractDeployOptions {
  dryRun?: boolean
  activate?: boolean
  buildDespiteBlocking?: boolean
  onProgress?: (workflowName: string, index: number, total: number) => void
}

/** Corrected (correction 3): a fourth overall outcome, 'generated', distinct from 'deployed'.
 * Without it, an all-dry-run build (every slot 'generated', none 'failed') would incorrectly
 * compute to the overall outcome 'deployed' under a two-outcome-only design -- a real
 * classification bug found by the second review round, distinct from (though related to) the
 * first round's per-slot classification fix. */
export type ContractDeployOutcome = 'deployed' | 'generated' | 'partial' | 'blocked'

/** Generic over the raw result type -- resolving the raw:unknown / unchanged-CLI-behavior
 * contradiction (correction 4 from the prior review round). The n8n deployer is typed
 * ContractDeployer<PackPlan, WorkflowPackResult>; when the CLI holds a concretely n8n-typed
 * deployer (which it does this arc -- resolveContractDeployer() below returns a concrete class,
 * not a type-erased interface reference), `.raw` is genuinely WorkflowPackResult-typed, no cast
 * needed, and every existing printPackResult()/JSON-output/pack-persistence call site (cli.ts:
 * 2277-2299, quoted in full in §3.2) keeps working exactly as it does today. `unknown` only
 * appears in TRawResult's own default, for a hypothetical caller holding nothing but the
 * abstract interface. */
export interface ContractDeployResult<TRawResult = unknown> {
  outcome: ContractDeployOutcome
  slots: DeployedSlotResult[]
  escalation?: CompileEscalationInfo
  raw: TRawResult
}

export interface ContractDeployer<TArtifact = unknown, TRawResult = unknown> {
  readonly targetId: TargetId
  deployArtifact(artifact: TArtifact, options: ContractDeployOptions): Promise<ContractDeployResult<TRawResult>>
}
```

**n8n implementations — corrected classification, generic typing, and the credential-isolation split:**

```typescript
// src/providers/n8n/contract-target.ts (NEW, Phase 3)

export class N8nContractCompiler implements ContractCompiler<PackPlan> {
  readonly targetId = 'n8n'
  compileContract(contract: ProcessContract): ContractCompileResult<PackPlan> {
    const { plan, traceability, escalation } = compileToPackPlan(contract)
    return { artifact: plan, traceability, ...(escalation ? { escalation } : {}) }   // exactOptionalPropertyTypes-safe conditional spread
  }
}

export class N8nContractDeployer implements ContractDeployer<PackPlan, WorkflowPackResult> {
  readonly targetId = 'n8n'
  constructor(private readonly packBuilder: PackBuilder) {}   // needs only an Anthropic key, via packBuilder -- never n8n credentials

  async deployArtifact(artifact: PackPlan, options: ContractDeployOptions): Promise<ContractDeployResult<WorkflowPackResult>> {
    const result = await this.packBuilder.build(artifact, {
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      ...(options.activate !== undefined ? { activate: options.activate } : {}),
      ...(options.buildDespiteBlocking !== undefined ? { buildDespiteBlocking: options.buildDespiteBlocking } : {}),
      ...(options.onProgress ? { onProgress: (wf, i, total) => options.onProgress!(wf.name, i, total) } : {}),
    })
    const slots: DeployedSlotResult[] = result.workflows.map(w => {
      if (w.error) return { slotName: w.name, outcome: 'failed', error: w.error }
      if (w.workflowId !== null) return { slotName: w.name, outcome: 'deployed', ref: { targetId: 'n8n', targetDeploymentId: w.workflowId } }
      return { slotName: w.name, outcome: 'generated' }   // dry-run success -- corrected classification, correction 1 (prior round)
    })
    const outcome: ContractDeployOutcome =
      result.status === 'blocked' ? 'blocked'
      : slots.some(s => s.outcome === 'failed') ? 'partial'
      : slots.length > 0 && slots.every(s => s.outcome === 'generated') ? 'generated'   // corrected: NEW branch, correction 3 (this round)
      : 'deployed'
    return { outcome, slots, ...(result.escalation ? { escalation: result.escalation } : {}), raw: result }
  }
}
```

**Factories, split three ways to make credential requirements structural, not a caller's discipline (Phase 3):**

```typescript
// src/cli.ts (revised, Phase 3)

/** Zero-argument, zero-credential -- safe to call on the plan-only path, matching today's
 * compileToPackPlan(contract) call (cli.ts:2207-2208), which also needs none. */
function resolveContractCompiler(): N8nContractCompiler {
  return new N8nContractCompiler()
}

/** Needs only an Anthropic key (via kairos/packBuilder) -- constructed unconditionally inside
 * the --build branch, exactly where PackBuilder is constructed today (cli.ts:2251), for BOTH a
 * dry run and a real build. Never touches N8N_BASE_URL/N8N_API_KEY. */
function resolveContractDeployer(anthropicApiKey: string, kairos: Kairos): N8nContractDeployer {
  return new N8nContractDeployer(new PackBuilder({ anthropicApiKey, kairos }))
}

/** Corrected (correction 1, this round): a SEPARATE, third factory -- constructed ONLY after a
 * real deployment happened, reproducing today's exact gate (cli.ts:2306-2320): NOT dry-run, NOT
 * blocked, AND at least one slot actually deployed. This is the fix for the credential
 * regression the second review round found: an earlier draft's single
 * resolveContractDeployTarget() constructed N8nApiClient unconditionally on every --build call,
 * including --build --dry-run, which today's code never requires n8n credentials for at all. */
function resolveVerificationTarget(): { deploymentLookup: N8nDeploymentLookup; verifier: N8nCompilerVerifier } {
  const apiClient = new N8nApiClient(getEnvOrExit('N8N_BASE_URL'), getEnvOrExit('N8N_API_KEY'), CLI_LOGGER)
  const deploymentLookup = new N8nDeploymentLookup(apiClient)
  return { deploymentLookup, verifier: new N8nCompilerVerifier(deploymentLookup) }
}
```

**`handleContractCompile`, revised (Phase 3), call-by-call:** the plan-only path calls `resolveContractCompiler().compileContract(contract)` — zero credentials, unchanged from today. The `--build` branch calls `resolveContractDeployer(anthropicKey, kairos).deployArtifact(artifact, options)` — needs only the Anthropic key it already had. **Only after that resolves**, and only `if (deployResult.outcome !== 'blocked' && deployResult.outcome !== 'generated' && !options.dryRun && deployResult.slots.some(s => s.outcome === 'deployed'))` (the exact translation of today's `if (!isDryRun && !buildResult.escalation) { ... if (registeredWorkflows.length > 0) ... }` gate into this plan's own vocabulary), does it call `resolveVerificationTarget()` and proceed to compiler verification (§6.5). `deployResult.raw` is `WorkflowPackResult`-typed throughout — printed, JSON'd, and persisted exactly as today, no cast.

**Guardrail.** No code path exists in this design where `N8nApiClient` gets constructed without a real, non-dry-run, non-blocked deployment having already produced at least one `targetDeploymentId`. This is enforced by *which function gets called*, not by a caller remembering not to touch certain fields — the credential-free property of the plan-only and dry-run paths is structural.

### 6.3 Deployment lookup

```typescript
// src/promise/targets/deployment-lookup.ts (NEW)

export interface TargetDeploymentSnapshot {
  ref: TargetDeploymentRef
  raw: unknown   // target-specific full deployment shape (n8n: N8nWorkflow)
}

export interface DeploymentLookup {
  readonly targetId: TargetId
  /** MUST throw GuardError if ref.targetId !== this.targetId -- every adapter method taking a
   * TargetDeploymentRef validates this, catching a caller bug (a mismatched ref passed to the
   * wrong adapter) immediately rather than silently returning confusing cross-target data. */
  fetchDeployment(ref: TargetDeploymentRef): Promise<TargetDeploymentSnapshot>
}
```

```typescript
export class N8nDeploymentLookup implements DeploymentLookup {
  readonly targetId = 'n8n'
  constructor(private readonly client: N8nApiClient) {}
  async fetchDeployment(ref: TargetDeploymentRef): Promise<TargetDeploymentSnapshot> {
    if (ref.targetId !== this.targetId) throw new GuardError(`N8nDeploymentLookup received a ref for target "${ref.targetId}", not "n8n".`)
    return { ref, raw: await this.client.getWorkflow(ref.targetDeploymentId) }
  }
}
```

### 6.4 Execution history and evidence normalization — real wrapper class, defensive ordering, ledger-ID generation in the correct layer, `PollContractResult` corrected

**Why a real wrapper class, not "already satisfies it."** `N8nApiClient`'s real methods, confirmed this pass, are `getExecutions(workflowId?, filter?)` and `getExecution(id, options?)` (`api-client.ts:156,183`) — not `listExecutions`/`fetchExecution`, and not taking a `TargetDeploymentRef` as their first argument. An earlier draft claimed this interface was "already satisfied with zero code," which was false; a real wrapper is required.

**Why the wrapper defensively sorts, rather than trusting the raw API response (correction 9).** `pollWorkflowEvidence()`'s own watermark logic (`newest = summaries[0]`) depends on newest-first ordering. n8n's real Executions API *is* empirically confirmed to return results in that order (Phase 3 design-verification spike, `docs/plans/process-contract-promise-engine-plan.md` §6.0, Finding 5) — but that is an observed fact about today's n8n version, not a documented contract n8n itself guarantees to preserve forever. The wrapper enforces the ordering itself, structurally, rather than silently inheriting whatever n8n happens to return.

```typescript
// src/promise/targets/execution-history.ts (NEW)

export interface ExecutionHistorySource<TRawExecution = unknown> {
  readonly targetId: TargetId
  /** MUST return executions newest-first and MUST respect `limit` (return at most `limit`
   * items) -- callers (specifically pollWorkflowEvidence()'s watermark/possibleGap logic,
   * ledger.ts:340,368) depend on both being true, not just usually true. */
  listExecutions(ref: TargetDeploymentRef, limit: number): Promise<Array<{ id: string; startedAt: string | null }>>
  fetchExecution(ref: TargetDeploymentRef, executionId: string): Promise<TRawExecution>
}

export interface EvidenceNormalizer<TRawExecution = unknown> {
  readonly targetId: TargetId
  /** Contract-aware -- needs contract.evidenceRequirements to resolve node names into
   * transitionIds BEFORE the neutral extractor ever sees the data. Produces a NormalizedExecution
   * only -- it does NOT construct a ProofLedgerEntry.id (§ below, correction 14 from the prior
   * review round: that responsibility belongs to the neutral extractor, which is the only layer
   * that both knows the target identity and builds entry ids at all). */
  normalize(contract: ProcessContract, raw: TRawExecution): NormalizedExecution
}

/** Defense-in-depth beyond each individual method's own ref.targetId guard (correction 9, this
 * round): catches a WIRING mistake -- e.g. an n8n history source accidentally paired with a
 * non-n8n ref or normalizer -- at one clear orchestration point, with a single error naming all
 * three component target ids, rather than three separate, less-diagnostic per-method throws. */
export function assertConsistentTargetIds(ref: TargetDeploymentRef, historySource: ExecutionHistorySource, normalizer: EvidenceNormalizer): void {
  if (ref.targetId !== historySource.targetId || ref.targetId !== normalizer.targetId) {
    throw new GuardError(`Target id mismatch: ref="${ref.targetId}", historySource="${historySource.targetId}", normalizer="${normalizer.targetId}" -- these must all agree.`)
  }
}
```

```typescript
// src/providers/n8n/execution-history.ts (NEW, Phase 4)

export class N8nExecutionHistorySource implements ExecutionHistorySource<RawExecutionDetail> {
  readonly targetId = 'n8n'
  constructor(private readonly client: N8nApiClient) {}

  async listExecutions(ref: TargetDeploymentRef, limit: number): Promise<Array<{ id: string; startedAt: string | null }>> {
    if (ref.targetId !== this.targetId) throw new GuardError(`N8nExecutionHistorySource received a ref for target "${ref.targetId}", not "n8n".`)
    const raw = await this.client.getExecutions(ref.targetDeploymentId, { limit })
    // Defensive, not merely trusting: sorts and truncates explicitly rather than assuming n8n's
    // API response is already correctly ordered and sized, even though it is today (correction 9).
    return raw.slice().sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, limit)
  }
  async fetchExecution(ref: TargetDeploymentRef, executionId: string): Promise<RawExecutionDetail> {
    if (ref.targetId !== this.targetId) throw new GuardError(`N8nExecutionHistorySource received a ref for target "${ref.targetId}", not "n8n".`)
    return this.client.getExecution(executionId, { includeData: true })
  }
}
```

**Normalized evidence shape** — built from Kairos concepts, reviewed to confirm every field is actually needed by neutral business logic rather than being target provenance in disguise:

```typescript
export interface EvidenceFieldItem {
  fields: Record<string, unknown>
  /** OPTIONAL, opaque, target-provided item-uniqueness key. When absent, extractNormalizedEvidence()
   * falls back to the item's own array index within its containing list -- so a target that
   * doesn't populate this can never produce colliding multi-item evidence ids. Never interpreted
   * by neutral logic beyond "these two items are different." Kept (unlike markerId, dropped
   * entirely) because ProofLedgerEntry.id uniqueness for multi-item batch executions is real
   * neutral business logic (ledger.ts:210,258 build entry ids from it today). */
  sourceItemRef?: string
}
export interface NormalizedTransitionEvidence {
  transitionId: string   // already resolved by the adapter -- see normalizeN8nExecution below
  items: EvidenceFieldItem[]
}
export interface NormalizedExecution {
  executionRef: string
  eventTime: string | null
  initiatingItems: EvidenceFieldItem[]   // was triggerItems -- fed to the existing, unchanged findStartCondition() logic
  transitionEvidence: NormalizedTransitionEvidence[]
}
```

**Ledger-ID generation, in the correct layer.** The neutral extractor already receives `deploymentRef` as a parameter — it is the only place with both the target identity and the data needed to build an id, and it is the only place `ProofLedgerEntry.id` is actually constructed:

```typescript
// src/promise/evidence-extraction.ts (renamed/extracted from ledger.ts's extractExecutionEvidence)

function buildEntryId(deploymentRef: TargetDeploymentRef, executionRef: string, suffix: string): string {
  return deploymentRef.targetId === 'n8n' ? `${executionRef}:${suffix}` : `${deploymentRef.targetId}:${executionRef}:${suffix}`
}

export function extractNormalizedEvidence(
  contract: ProcessContract,
  execution: NormalizedExecution,
  deploymentRef: TargetDeploymentRef,
  startCondition?: StartCondition,
): { outcomes: PollExecutionOutcome[]; entries: ProofLedgerEntry[] } {
  // ... unchanged instance_start / per-transition logic, with every id: `${execution.id}:...`
  // construction (ledger.ts:210,258 today) replaced by buildEntryId(deploymentRef, execution.
  // executionRef, suffix), and every itemPosition(item) reference replaced by
  // `item.sourceItemRef ?? String(indexWithinItsOwnArray)` ...
}
```

```typescript
// src/providers/n8n/evidence.ts (NEW, Phase 4)

export function evidenceNodeName(transitionId: string): string {   // moved here from compile.ts, mechanical relocation only
  return `Kairos Evidence: ${transitionId}`
}

/** Contract-aware: parses runData exactly as today's allItemsJson()/readPath() do (verbatim
 * logic move), resolves evidenceNodeName(ev.transitionId) for each contract.evidenceRequirements
 * entry against the parsed node list, buckets items by transitionId. Produces ONLY a
 * NormalizedExecution -- it never constructs a ProofLedgerEntry.id (that would be the wrong
 * layer, per the fix above). */
export function normalizeN8nExecution(contract: ProcessContract, execution: RawExecutionDetail): NormalizedExecution {
  // ...
}
```

**`PollContractResult` corrected, assigned to exactly one phase (correction 8: it is Phase 1, alongside its sibling `ContractPollWatermark`, since both changes are purely mechanical dual-writes needing no new interface — Phase 4 then consumes the already-canonical type when it introduces the interface-based refactor of `pollWorkflowEvidence()`'s actual data-fetching logic):**

```typescript
// src/promise/ledger-types.ts (revised, Phase 1)

export interface PollContractResult {
  contractId: string
  targetId: TargetId               // NEW, canonical -- Phase 1
  targetDeploymentId: string        // NEW, canonical -- Phase 1
  n8nWorkflowId?: string             // LEGACY, optional, dual-written for targetId === 'n8n' only -- Phase 1
  executionsChecked: number
  entries: ProofLedgerEntry[]
  outcomes: PollExecutionOutcome[]
  newWatermark: ContractPollWatermark
  possibleGap: boolean
  unattributedCount: number
}
```

`pollWorkflowEvidence()`'s own construction of both `newWatermark` and its own return value dual-writes the canonical fields alongside `n8nWorkflowId`, in Phase 1, mechanically, before any interface exists — exactly like the registration and watermark dual-writes described in §6.6/§6.7.

### 6.5 Compiler verification — its own interface, with the fetch-error/indirect-gap conflation explicitly decided, not silently carried

**Why its own, sixth interface.** If the CLI itself narrowed `DeploymentLookup.fetchDeployment()`'s `raw: unknown` into `{nodes: N8nNode[]}` to call `verifyCompiledWorkflows()`, the CLI would still be n8n-coupled — the coupling would just have moved from "which class to construct" to "how to interpret the result." A dedicated interface keeps that one necessary cast entirely inside the n8n-specific verifier.

**Why fetch errors are preserved as their own field, not merged into or dropped from verification findings.** Today's real code (cli.ts:2336-2364, quoted in §3.2) tracks fetch failures separately from structural findings, explicitly never counting a fetch failure as a gap. An earlier interface draft returned only `Promise<CompilerVerificationResult>`, which would have made a single fetch failure throw and abort the whole check — a real behavior regression from today, not a neutral simplification.

**The explicit decision on the deeper conflation named by correction 4, stated plainly rather than glossed over.** `verifyCompiledWorkflows()` (unchanged, wrapped, never rewritten) receives only the workflows that were *successfully* fetched. A workflow that failed to fetch is invisible to it — meaning any evidence requirement that workflow would have satisfied is reported by `checkEvidenceNodesPresent()` as structurally *missing*, indistinguishable from a genuine gap, even though the real reason is "we couldn't check," not "it's actually wrong." **This plan's decision: preserve this exact behavior, unchanged, and document it here rather than pretend it doesn't exist.** The alternative — teaching `verifyCompiledWorkflows()` to accept "which requirements are unknown due to a fetch failure" and report a genuine third state (`'unverifiable'`, distinct from `'satisfied'`/`'gaps_found'`) — is a real, valid improvement, but it requires modifying `verifyCompiledWorkflows()`'s own logic, which this whole plan has committed, in every revision, to wrap rather than rewrite. Named explicitly as an out-of-scope future improvement in §13, not silently absorbed as if today's behavior were already correct.

```typescript
// src/promise/targets/compiler-verifier.ts (NEW)

/** Takes {slotName, ref} pairs -- exactly ContractDeployResult.slots filtered to
 * outcome === 'deployed' -- not a bare TargetDeploymentRef[], which has no name to resolve a
 * compiled workflow back to (a real, unresolved gap in an earlier interface draft). */
export interface DeployedSlotRef {
  slotName: string
  ref: TargetDeploymentRef
}

export interface TargetVerificationResult {
  verification: CompilerVerificationResult   // UNCHANGED existing type (compiler-verify.ts)
  fetchErrors: string[]
}

export interface TargetCompilerVerifier {
  readonly targetId: TargetId
  verifyCompiledArtifact(
    contract: ProcessContract,
    deployedSlots: DeployedSlotRef[],
    traceability: ContractWorkflowTrace[],
  ): Promise<TargetVerificationResult>
}
```

```typescript
// src/providers/n8n/compiler-verifier.ts (NEW, Phase 3)

export class N8nCompilerVerifier implements TargetCompilerVerifier {
  readonly targetId = 'n8n'
  constructor(private readonly deploymentLookup: N8nDeploymentLookup) {}

  async verifyCompiledArtifact(contract: ProcessContract, deployedSlots: DeployedSlotRef[], traceability: ContractWorkflowTrace[]): Promise<TargetVerificationResult> {
    const fetched: CompiledWorkflowForVerification[] = []
    const fetchErrors: string[] = []
    for (const { slotName, ref } of deployedSlots) {   // per-slot try/catch, matching today's real loop exactly (cli.ts:2338-2345)
      try {
        const snapshot = await this.deploymentLookup.fetchDeployment(ref)
        const workflow = snapshot.raw as N8nWorkflow   // the one cast, inside this n8n-specific verifier only
        fetched.push({ workflowName: slotName, workflow: { nodes: workflow.nodes } })
      } catch (err) {
        fetchErrors.push(`"${slotName}" (${ref.targetDeploymentId}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { verification: verifyCompiledWorkflows(contract, fetched, traceability), fetchErrors }   // UNCHANGED existing function
  }
}
```

`handleContractCompile`'s compiler-verification block is revised (Phase 3) to call `verifier.verifyCompiledArtifact(contract, deployResult.slots.filter((s): s is Extract<DeployedSlotResult, {outcome: 'deployed'}> => s.outcome === 'deployed').map(s => ({slotName: s.slotName, ref: s.ref})), traceability)` — the type-predicate filter is what lets TypeScript narrow `s.ref` to always-present with no `!`, per correction 6 — and print/JSON both `verification` and `fetchErrors` exactly as today.

### 6.6 Generic deployment registration — outer container type defined, normalize-then-key merge, atomic write

**Why an explicit outer, persisted container type (correction 7).** `loadRawRegistration()` (`registry.ts:73-80`) reads and parses a whole registration file, returning either `null` or an object with `{contractId, contractVersion, clientId, workflows, registeredAt}` — but only the *per-workflow* raw shape (`PersistedRegisteredWorkflow`) had ever been named; the outer container itself, and the fact that its `workflows` array holds *raw*, possibly-legacy per-workflow records rather than already-canonical ones, had no distinct type. Implementing code without this type would either reuse the canonical `ContractWorkflowRegistration` shape for raw data (wrong — it would claim `targetId`/`targetDeploymentId` are always present when they might not be, for a pre-boundary file) or leave the raw shape anonymous (making the normalize-before-use discipline below unenforceable by the type system).

**Why normalize-then-key, not key-then-normalize (correction 11, closing a silent — not crashing, therefore worse — bug).** A genuinely legacy entry loaded from disk has `targetId`/`targetDeploymentId` both `undefined`. Calling `targetRefKey()` directly on such an entry does not throw (`encodeURIComponent(undefined)` stringifies to the literal string `"undefined"`, not an error) — it silently produces the wrong key, `"undefined:undefined"`, which would cause **every** legacy entry across **every** contract to collide into the same map slot during a merge, since they'd all key identically. This is worse than a crash: it is silent data loss. The fix is to guarantee normalization happens exactly once, at the single read boundary (`loadRawRegistration()`'s own caller), before any keying, merging, or drop-detection logic ever sees the data.

**Why an atomic write is added here, in this arc, when it was a pre-existing gap this plan never introduced (correction 12).** `saveContractWorkflowRegistration()` has locking (`acquireFileLock`) but writes directly to the final path — no temp-file-then-rename — unlike its sibling `ledger-store.ts`'s watermark writer, which already uses that pattern. A process killed mid-`writeFile()` could leave a truncated, invalid JSON file. This plan does not claim to have introduced this gap, and does not claim it was already safe — it states the gap plainly and closes it, because Phase 1 already modifies this exact function for the collision-safe merge, making this the natural, low-risk moment to apply a pattern the codebase already uses elsewhere, rather than leaving a known gap open while touching the surrounding code anyway.

```typescript
// src/promise/registry.ts (revised)

/** Per-workflow raw shape -- may be legacy (n8nWorkflowId only) or target-aware. */
interface PersistedRegisteredWorkflow {
  n8nWorkflowId?: string
  targetId?: TargetId
  targetDeploymentId?: string
  workflowName: string
  sourceElements: string[]
  contractVersion: number
  status: RegisteredWorkflowStatus
  registeredAt: string
}

/** NEW (correction 7): the outer, persisted container loadRawRegistration() actually returns --
 * distinct from the canonical, always-normalized ContractWorkflowRegistration below. Its
 * `workflows` array is explicitly typed as raw, possibly-legacy records, never accidentally
 * treated as already-canonical by the type system. */
interface PersistedContractWorkflowRegistration {
  contractId: string
  contractVersion: number
  clientId: string
  workflows: PersistedRegisteredWorkflow[]
  registeredAt: string
}

export interface RegisteredWorkflow {
  targetId: TargetId
  targetDeploymentId: string
  n8nWorkflowId?: string   // legacy, optional, n8n-only
  workflowName: string
  sourceElements: string[]
  contractVersion: number
  status: RegisteredWorkflowStatus
  registeredAt: string
}

/** The public, canonical shape -- every field on `workflows` is guaranteed already-normalized. */
export interface ContractWorkflowRegistration {
  contractId: string
  contractVersion: number
  clientId: string
  workflows: RegisteredWorkflow[]
  registeredAt: string
}

export function normalizeRegisteredWorkflow(raw: PersistedRegisteredWorkflow): RegisteredWorkflow {
  if (raw.targetId && raw.targetDeploymentId) return { ...raw, targetId: raw.targetId, targetDeploymentId: raw.targetDeploymentId }
  if (!raw.n8nWorkflowId) throw new GuardError(`Registered workflow "${raw.workflowName}" has neither targetId/targetDeploymentId nor a legacy n8nWorkflowId -- corrupt registration record.`)
  return { ...raw, targetId: 'n8n', targetDeploymentId: raw.n8nWorkflowId, n8nWorkflowId: raw.n8nWorkflowId }
}

/** loadRawRegistration() itself is unchanged in spirit -- reads and JSON.parses, returns
 * PersistedContractWorkflowRegistration | null. Never called directly by anything outside this
 * file after this revision -- normalization happens exactly once, in the two functions below. */
async function loadRawRegistration(clientId: string, contractId: string): Promise<PersistedContractWorkflowRegistration | null> {
  try { return JSON.parse(await readFile(registrationPath(clientId, contractId), 'utf-8')) as PersistedContractWorkflowRegistration }
  catch { return null }
}

export async function saveContractWorkflowRegistration(reg: ContractWorkflowRegistration): Promise<{ path: string }> {
  const path = registrationPath(reg.clientId, reg.contractId)
  await mkdir(join(homedir(), '.kairos', 'contracts', reg.clientId), { recursive: true })
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const existingRaw = await loadRawRegistration(reg.clientId, reg.contractId)
    // Normalize BEFORE keying (correction 11) -- every entry, legacy or not, is canonical before
    // targetRefKey() ever sees it.
    const existingNormalized = (existingRaw?.workflows ?? []).map(normalizeRegisteredWorkflow)
    const byKey = new Map(existingNormalized.map(w => [targetRefKey(w), w]))
    for (const w of reg.workflows) byKey.set(targetRefKey(w), w)   // reg.workflows are already canonical
    const merged: ContractWorkflowRegistration = { ...reg, workflows: [...byKey.values()] }
    // Atomic temp-rename write (correction 12), matching ledger-store.ts's own existing pattern
    // (confirmed, ledger-store.ts:117-120) -- registry.ts never had this before this arc.
    const tmpPath = `${path}.tmp`
    await writeFile(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
    await chmod(tmpPath, 0o600)
    await rename(tmpPath, path)
    return { path }
  } finally {
    await releaseLock()
  }
}

/** Every reader of registration data gets already-normalized entries -- normalization happens
 * once, here (or in the save path above), never again downstream. */
export async function loadContractWorkflowRegistration(clientId: string, contractId: string): Promise<ContractWorkflowRegistration | null> {
  const raw = await loadRawRegistration(clientId, contractId)
  if (!raw) return null
  return { ...raw, workflows: raw.workflows.map(normalizeRegisteredWorkflow) }
}

export function computeDroppedWorkflows(existingWorkflows: RegisteredWorkflow[], newWorkflowNames: Set<string>, targetId: TargetId): RegisteredWorkflow[] {
  return existingWorkflows.filter(w => w.targetId === targetId && !newWorkflowNames.has(w.workflowName))
}
```

**Guardrail.** `PersistedRegisteredWorkflow`/`PersistedContractWorkflowRegistration` are internal to `registry.ts` — no other module imports them. Every function any other module calls (`loadContractWorkflowRegistration`, `saveContractWorkflowRegistration`) either takes or returns the canonical `RegisteredWorkflow`/`ContractWorkflowRegistration` shape, never the raw one — making "did I forget to normalize" structurally impossible to get wrong from outside this file.

### 6.7 Watermarks — collision-safe key, persisted-vs-canonical types, staleness-aware read, and an honest rewrite claim, restored in full this revision (correction 5)

**Why this design exists (three separately-verified bugs, each with a concrete failure scenario).**

**(a) Plain string-concatenation keys collide.** `` `${targetId}:${targetDeploymentId}` `` collides whenever either component itself contains `:` — e.g. `targetId: 'foo'` + `targetDeploymentId: 'bar:baz'` produces the identical string as `targetId: 'foo:bar'` + `targetDeploymentId: 'baz'`. Fixed by reusing `targetRefKey()` (§6.1), which escapes both components with `encodeURIComponent` first.

**(b) The persisted shape and the canonical shape need to be different types, for the same reason as §6.6.** A watermark loaded from a pre-boundary file has only `n8nWorkflowId`; the canonical, in-memory shape guarantees `targetId`/`targetDeploymentId` are always present.

**(c) A stale-read race exists across old and new binaries, named precisely.** A new binary writes both the composite key and the legacy bare key (watermark A, `updatedAt: t1`). Later, an *old* binary — unaware composite keys exist at all — polls the same workflow and writes **only** the bare key (watermark B, `updatedAt: t2 > t1`). The file now has a stale composite-keyed entry and a fresh bare-keyed entry. A read that blindly prefers the composite key would return the stale A. Fixed by comparing `updatedAt` across both keys whenever both exist, returning whichever is newer.

```typescript
// src/promise/ledger-types.ts (revised)

interface PersistedContractPollWatermark {
  contractId: string
  targetId?: TargetId
  targetDeploymentId?: string
  n8nWorkflowId?: string
  lastProcessedExecutionId: string
  lastProcessedStartedAt: string
  updatedAt: string
  cumulativeUnattributedCount?: number
}

export interface ContractPollWatermark {
  contractId: string
  targetId: TargetId               // canonical, always present after normalization
  targetDeploymentId: string        // canonical, always present after normalization
  n8nWorkflowId?: string            // LEGACY, optional, dual-written for targetId === 'n8n' only
  lastProcessedExecutionId: string
  lastProcessedStartedAt: string
  updatedAt: string
  cumulativeUnattributedCount?: number
}

export function normalizeContractPollWatermark(raw: PersistedContractPollWatermark): ContractPollWatermark {
  if (raw.targetId && raw.targetDeploymentId) return { ...raw, targetId: raw.targetId, targetDeploymentId: raw.targetDeploymentId }
  if (!raw.n8nWorkflowId) throw new GuardError(`Watermark for contract "${raw.contractId}" has neither targetId/targetDeploymentId nor a legacy n8nWorkflowId -- corrupt watermark record.`)
  return { ...raw, targetId: 'n8n', targetDeploymentId: raw.n8nWorkflowId, n8nWorkflowId: raw.n8nWorkflowId }
}
```

```typescript
// src/promise/ledger-store.ts (revised) -- watermarks.json's own TOP-LEVEL shape is UNCHANGED
// (still Record<string, PersistedContractPollWatermark>) -- only the KEY FORMAT for new entries
// changes, which is why no whole-file migration is ever required.

function watermarkLegacyKey(ref: TargetDeploymentRef): string | null {
  return ref.targetId === 'n8n' ? ref.targetDeploymentId : null
}

export async function loadContractPollWatermark(clientId: string, contractId: string, ref: TargetDeploymentRef): Promise<ContractPollWatermark | null> {
  const all = await readWatermarks(clientId, contractId)   // Record<string, PersistedContractPollWatermark>
  const composite = all[targetRefKey(ref)]
  const legacyKey = watermarkLegacyKey(ref)
  const legacy = legacyKey ? all[legacyKey] : undefined
  // Staleness-aware (the fix for scenario (c) above): when BOTH exist, return whichever has the
  // newer updatedAt -- never blindly prefer the composite key.
  const winner =
    composite && legacy ? (composite.updatedAt >= legacy.updatedAt ? composite : legacy)
    : composite ?? legacy
  return winner ? normalizeContractPollWatermark(winner) : null
}

export async function saveContractPollWatermark(clientId: string, watermark: ContractPollWatermark): Promise<void> {
  const dir = contractLedgerDir(clientId, watermark.contractId)
  await mkdir(dir, { recursive: true })
  const path = watermarksPath(clientId, watermark.contractId)
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const all = await readWatermarks(clientId, watermark.contractId)
    all[targetRefKey(watermark)] = watermark
    // Dual-write for old-binary readability -- this EXPLICITLY REWRITES the legacy bare-key
    // entry for the SAME deployment id being saved, every time (the corrected claim, below).
    const legacyKey = watermarkLegacyKey(watermark)
    if (legacyKey) all[legacyKey] = watermark
    const tmpPath = `${path}.tmp`
    await writeFile(tmpPath, JSON.stringify(all, null, 2) + '\n', 'utf-8')
    await chmod(tmpPath, 0o600)
    await rename(tmpPath, path)
  } finally {
    await releaseLock()
  }
}
```

**The corrected claim, stated plainly rather than glossed over:** an earlier draft of this plan said "old entries are never touched, rewritten, or removed... the file only ever grows new keys, never restructures old ones." **This was imprecise.** The legacy bare-key entry for whichever `(contractId, targetDeploymentId)` is currently being saved **is actively rewritten on every save** — that is the entire mechanism that keeps it current for old-binary reads. What is genuinely never touched is every *other* entry in the file (different deployment ids, or a different target's entries entirely); the file's top-level shape never restructures, and no key is ever deleted — but the specific legacy key tied to an active deployment id is, by design, kept fresh via repeated rewrite, not left frozen after its first write.

**Compatibility tests required (Phase 1, before this schema change lands):**
1. A fixture legacy `watermarks.json` (bare keys only) loads correctly via the legacy-key branch.
2. A fresh save for an n8n target writes both keys; a subsequent load finds the same watermark via either path.
3. Two synthetic `TargetDeploymentRef`s with `targetId`s or `targetDeploymentId`s that would collide under naive string concatenation (e.g. `{targetId: 'foo', targetDeploymentId: 'bar:baz'}` vs. `{targetId: 'foo:bar', targetDeploymentId: 'baz'}`) produce two independently-loadable, non-colliding entries.
4. The staleness scenario itself: seed a composite-keyed entry with an old `updatedAt`, then a bare-keyed entry (simulating an old binary's write) with a newer `updatedAt`; confirm `loadContractPollWatermark` returns the newer one.

### 6.8 ProofLedger and Contract Evolution — target identity propagated one layer further, with an honest limit named

**Why this matters beyond §6.4's own ledger-entry fix.** Adding `targetId` to `ProofLedgerEntry` (§6.4) only helps if the information actually reaches every place a ledger entry gets referenced elsewhere in the codebase — otherwise the same cross-target ambiguity this plan set out to fix simply reappears one layer downstream.

**Where it does propagate.** `AmendmentEvidenceRef`'s real shape (`evolution-types.ts:25-28`): `{ kind: AmendmentEvidenceRefKind, id: string }`, where `AmendmentEvidenceRefKind = 'ledger_entry' | 'exception_item' | 'harness_scenario'`. For `kind: 'ledger_entry'` refs, `targetId` is available at the construction site (`evolution.ts:103-104`, `detectRateHotspot()`) because it can be threaded through from the source `ProofLedgerEntry.targetId` — provided the caller that populates `RateHotspotInput.ledgerEntryIds` is also revised to carry `Array<{id: string; targetId?: TargetId}>` rather than bare `string[]`, so the information is actually available to thread at all.

```typescript
// src/promise/evolution-types.ts (revised)

export interface AmendmentEvidenceRef {
  kind: AmendmentEvidenceRefKind
  id: string
  targetId?: TargetId   // NEW, optional -- absent implies 'n8n', same convention as everywhere else in this plan
}
```

**Where it does NOT propagate, and why — the correction the second review round required (correction 11).** `ExceptionDeskItem`'s real shape, confirmed this pass (`exception-types.ts:29-59`), has **no `targetId` field at all** — its own evidence list is a plain `evidence: string[]` (ledger entry ids or a plain description, per its own doc comment). This means an `AmendmentEvidenceRef{kind: 'exception_item'}` **cannot** carry target provenance from its source the way a `{kind: 'ledger_entry'}` ref can — there is nothing on `ExceptionDeskItem` to read it from. **This plan does not propose adding a `targetId` field to `ExceptionDeskItem`** — doing so would be a further, separate schema change, with its own persisted-data compatibility considerations, not yet designed or decided. It is named here explicitly, as an open question (§13), rather than silently implied to already work by a document that only mentions the `ledger_entry` case.

**Guardrail.** Every `AmendmentEvidenceRef` constructor in `evolution.ts` — there is more than one, since evidence refs are built ad hoc across several distinct detection functions, not read from one single storage format the way registrations/watermarks are — must be updated individually; there is no single normalization choke point here the way there is for registrations (§6.6) or watermarks (§6.7). This asymmetry is named as its own residual risk in §13, with its own dedicated test in §18 (correction 13's row), precisely because the lack of a single choke point makes it easier for a future addition to `evolution.ts` to forget to thread `targetId` through than it would be for the registration/watermark cases, where the type system itself makes forgetting structurally impossible.

---

## 7. In-memory reference adapter — five interfaces, slot-specific deployment data, blocking-assumption-gated by construction

**Why this adapter exists at all, restated precisely.** Its purpose is not "a second target Kairos can run against" — it will never be a production runtime, and this plan repeats that constraint at every mention. Its purpose is to *prove* that the six interfaces in §6 represent genuine Kairos concepts, not n8n concepts wearing a generic name — the same purpose the sponsor brief itself states for it. A design that merely *asserts* the interfaces are neutral proves nothing; a second, honest, non-n8n implementation of the same interfaces is the actual evidence.

**Why five interfaces, not six.** `InMemoryContractTarget` implements `ContractCompiler`, `ContractDeployer`, `DeploymentLookup`, `ExecutionHistorySource`, `EvidenceNormalizer` — never `TargetCompilerVerifier`, matching its own honest `compilerVerification: {state: 'unsupported'}` declaration. Its "artifact" is its own decomposition by construction — there is no LLM-authored JSON that could structurally diverge from what the contract asked for, so the whole *category* of question compiler verification answers ("does the generated artifact actually contain what it's supposed to") does not apply here, not merely "isn't built yet." An earlier revision's own prose incorrectly said "all six interfaces" in two places despite its own code already correctly implementing five — both are corrected in this document, since the confusion was in the *description*, not the *design*.

**Why slot-specific deployment storage, not the whole decomposition copied under every id — the concrete defect this closes (correction 12).** An earlier draft's `deployArtifact()` stored `this.deployments.set(id, artifact)` — the **entire** `ContractDecomposition`, all slots — under **each individual slot's own** freshly-generated deployment id. That means fetching *any one* slot's deployment would return *every* slot's data, indiscriminately. This directly weakens the adapter's own stated purpose: n8n deploys N independently-fetchable workflows, each containing only its own content; an in-memory adapter that doesn't mirror this isn't actually proving the interfaces work correctly for a target with genuinely separate per-slot artifacts — it's testing a degenerate case where "fetch this one thing" and "fetch everything" happen to look the same.

```typescript
// src/promise/targets/in-memory/adapter.ts (future, Phase 5 -- NOT built this pass)

export const IN_MEMORY_CAPABILITIES: TargetCapabilities = {
  implemented: {
    compile: { state: 'supported' }, deploy: { state: 'supported' }, fetchDeployment: { state: 'supported' },
    executionHistory: { state: 'supported' }, evidenceExtraction: { state: 'supported' },
    compilerVerification: { state: 'unsupported' },
  },
  reliability: {
    replay: { state: 'unsupported' }, chaos: { state: 'unsupported' }, sandbox: { state: 'unsupported' },
    drift: { state: 'unsupported' }, repair: { state: 'unsupported' }, rollback: { state: 'unsupported' },
  },
}

/** Test-only. Never a production runtime -- no code path anywhere lets a real build/deploy/poll
 * cycle route here by accident; no --target flag exists to select it; it is only ever
 * constructed directly by test code. */
export class InMemoryContractTarget
  implements ContractCompiler<ContractDecomposition>, ContractDeployer<ContractDecomposition, ContractDecomposition>,
             DeploymentLookup, ExecutionHistorySource<InMemoryRawExecution>, EvidenceNormalizer<InMemoryRawExecution> {
  readonly targetId = 'in-memory-test'
  // Corrected (correction 12): keyed by deployment id -> ONE slot, not the whole decomposition.
  private deployments = new Map<string, WorkflowSlot>()
  private executions = new Map<string, InMemoryRawExecution[]>()

  // -- ContractCompiler -- calls the SAME prepareContract() every real target calls (§5) -- the
  // blocking-assumption gate is structurally inherited, not reproduced by hand.
  compileContract(contract: ProcessContract): ContractCompileResult<ContractDecomposition> {
    const prepared = prepareContract(contract)
    if (prepared.outcome === 'blocked') return { artifact: { slots: [] }, traceability: [], escalation: prepared.escalation }   // no `!` needed -- discriminated union narrows this
    return { artifact: prepared.decomposition, traceability: prepared.decomposition.slots.map(s => ({ workflowName: s.name, sourceElements: s.sourceElements })) }
  }

  // -- ContractDeployer -- unique ids via generateUUID() (src/utils/uuid.ts, already used
  // elsewhere in this codebase), never a slot index (which would collide on any repeated
  // deployment, e.g. simulating a rebuild). Each id maps to exactly ONE slot's own data.
  async deployArtifact(artifact: ContractDecomposition): Promise<ContractDeployResult<ContractDecomposition>> {
    const slots: DeployedSlotResult[] = artifact.slots.map(slot => {
      const id = generateUUID()
      this.deployments.set(id, slot)   // corrected: one slot, not the whole artifact
      return { slotName: slot.name, outcome: 'deployed', ref: { targetId: this.targetId, targetDeploymentId: id } }
    })
    return { outcome: 'deployed', slots, raw: artifact }
  }

  // -- DeploymentLookup -- returns only the ONE slot this ref points at, matching n8n's own
  // per-workflow fetch semantics.
  async fetchDeployment(ref: TargetDeploymentRef): Promise<TargetDeploymentSnapshot> {
    if (ref.targetId !== this.targetId) throw new GuardError(`InMemoryContractTarget received a ref for target "${ref.targetId}".`)
    const slot = this.deployments.get(ref.targetDeploymentId)
    if (!slot) throw new GuardError(`No in-memory deployment "${ref.targetDeploymentId}".`)
    return { ref, raw: slot }
  }

  // -- ExecutionHistorySource -- newest-first and limit-respecting, matching §6.4's own stated
  // contract; every method validates ref.targetId, including fetchExecution() (an earlier draft
  // had this guard on the other two methods but not this one -- an inconsistency with no
  // principled reason, now fixed).
  async listExecutions(ref: TargetDeploymentRef, limit: number): Promise<Array<{ id: string; startedAt: string | null }>> {
    if (ref.targetId !== this.targetId) throw new GuardError(`InMemoryContractTarget received a ref for target "${ref.targetId}".`)
    return (this.executions.get(ref.targetDeploymentId) ?? []).slice().reverse().slice(0, limit).map(e => ({ id: e.id, startedAt: e.startedAt }))
  }
  async fetchExecution(ref: TargetDeploymentRef, executionId: string): Promise<InMemoryRawExecution> {
    if (ref.targetId !== this.targetId) throw new GuardError(`InMemoryContractTarget received a ref for target "${ref.targetId}".`)
    const found = (this.executions.get(ref.targetDeploymentId) ?? []).find(e => e.id === executionId)
    if (!found) throw new GuardError(`No in-memory execution "${executionId}".`)
    return found
  }

  // -- EvidenceNormalizer -- reuses scenario.ts's own generated evidence timelines directly, zero
  // new synthetic-data-generation code.
  normalize(_contract: ProcessContract, raw: InMemoryRawExecution): NormalizedExecution {
    return raw.asNormalizedExecution
  }

  /** Test-seam only -- not a "deploy runs code" path. Translates a scenario.ts-generated
   * ContractScenario into this adapter's own InMemoryRawExecution shape and appends it. */
  seedExecution(deploymentId: string, scenario: ContractScenario): void { /* ... */ }
}
```

**Conformance suite (Phase 5), verified function names against real exports:**
1. **Evidence-normalization parity:** the same fixture contract's scenarios run through both `normalizeN8nExecution()` (fed a hand-constructed raw-runData fixture) and `InMemoryContractTarget.normalize()` (fed via `seedExecution`) produce identical `extractNormalizedEvidence()` output.
2. **Cross-target report parity:** equivalent normalized evidence from either target produces identical results from `checkSlaCompliance()`, `updateExceptionDesk()`, `buildPromiseReportData()` (`report.ts:221`), `analyzeContractForAmendments()` (`evolution.ts:292`), `deriveLearningNotesFromProposals()` (`learning.ts:39`), and `buildAutomationValueReport()` (`value-report.ts:45`).

---

## 8. Proposed module/file layout (future phases, none created this pass)

```
src/promise/
  decomposition.ts                 # decomposeContract(), prepareContract() -- Phase 2 (§5)
  compile.ts                       # compileToPackPlan() calls prepareContract() -- Phase 2
  evolution-types.ts                # AmendmentEvidenceRef gains optional targetId -- Phase 4 (§6.8)
  evolution.ts                      # every AmendmentEvidenceRef-constructing site threads
                                   # targetId through individually (no single choke point --
                                   # §6.8's own named residual risk) -- Phase 4
  ledger.ts                        # pollWorkflowEvidence() dual-writes PollContractResult/
                                   # ContractPollWatermark canonical fields -- Phase 1 (dual-write
                                   # only); uses ExecutionHistorySource/EvidenceNormalizer,
                                   # assertConsistentTargetIds() -- Phase 4 (full refactor)
  evidence-extraction.ts            # extractNormalizedEvidence() -- owns buildEntryId(), the
                                   # sourceItemRef index fallback -- Phase 4 (§6.4)
  registry.ts                      # PersistedRegisteredWorkflow/PersistedContractWorkflowRegistration/
                                   # RegisteredWorkflow/ContractWorkflowRegistration split,
                                   # normalizeRegisteredWorkflow(), normalize-before-key merge,
                                   # atomic temp-rename write, target-scoped
                                   # computeDroppedWorkflows() -- Phase 1
  ledger-types.ts                   # PersistedContractPollWatermark/ContractPollWatermark split;
                                   # PollContractResult gains targetId/targetDeploymentId --
                                   # BOTH Phase 1 (correction 8: one phase, not two)

  targets/
    types.ts                        # TargetId, TargetDeploymentRef, targetRefKey(),
                                   # CapabilityDescriptor (discriminated union),
                                   # ImplementedCapabilities, InformationalReliabilityCapabilities,
                                   # TargetCapabilities, EvidenceFieldItem,
                                   # NormalizedTransitionEvidence, NormalizedExecution -- Phase 1
                                   # (shared identity types), 3, 4 (evidence types)
    contract-compiler.ts             # ContractCompileResult, ContractCompiler -- Phase 3
    contract-deployer.ts             # SlotDeployOutcome, DeployedSlotResult (discriminated union),
                                   # ContractDeployOptions, ContractDeployOutcome (4 states),
                                   # ContractDeployResult<TRawResult>, ContractDeployer -- Phase 3
    deployment-lookup.ts              # TargetDeploymentSnapshot, DeploymentLookup -- Phase 3
    execution-history.ts              # ExecutionHistorySource, EvidenceNormalizer,
                                   # assertConsistentTargetIds() -- Phase 4
    compiler-verifier.ts              # DeployedSlotRef, TargetVerificationResult,
                                   # TargetCompilerVerifier -- Phase 3
    in-memory/
      adapter.ts                      # InMemoryContractTarget (5 interfaces, slot-specific
                                   # deployment storage) -- Phase 5

src/providers/n8n/
  capabilities.ts                   # N8N_CAPABILITIES -- Phase 3
  contract-target.ts                 # N8nContractCompiler, N8nContractDeployer -- Phase 3
  deployment-lookup.ts                # N8nDeploymentLookup -- Phase 3
  compiler-verifier.ts                # N8nCompilerVerifier -- Phase 3
  execution-history.ts                # N8nExecutionHistorySource (defensive sort/limit) -- Phase 4
  evidence.ts                         # normalizeN8nExecution() (no id construction),
                                   # evidenceNodeName() (moved from compile.ts) -- Phase 4

src/cli.ts
  resolveN8nApiClient()              # plain n8n-specific de-dup helper -- Phase 1
  resolveContractCompiler()          # zero-credential factory -- Phase 3
  resolveContractDeployer()          # Anthropic-only factory, --build always -- Phase 3
  resolveVerificationTarget()        # n8n-credentialed factory, ONLY after a real deployment --
                                   # Phase 3 (this THREE-way split is correction 1's fix)
  handleContractCompile              # plan-only + --build branch + compiler-verification use
                                   # the boundary; registration construction dual-writes
                                   # targetId/targetDeploymentId -- Phase 1 (dual-write only),
                                   # Phase 3 (full interface use)
  handleLedgerPoll                   # watermark load/save calls updated to canonical refs --
                                   # Phase 1 (call-site signature update); uses
                                   # ExecutionHistorySource/EvidenceNormalizer -- Phase 4
  runContractComplianceTick           # same as handleLedgerPoll -- Phase 1, Phase 4

tests/fixtures/contracts/golden-compile/
  <fixture-name>.expected.json       # checked-in, human-reviewed, captured from PRE-refactor
                                   # code, committed as its own commit before Phase 2's refactor
                                   # commit -- a PROCESS checkpoint (§12, correction 10), not a
                                   # runtime-testable git-history assertion
  <fixture-name>-validation-error.expected.json    # NEW this revision -- exercises prepareContract()'s
                                   # validation-error escalation path byte-for-byte (correction 2)
  <fixture-name>-blocking-assumption.expected.json # NEW this revision -- exercises the
                                   # blocking-assumption escalation path byte-for-byte (correction 2)

tests/unit/promise/
  decomposition.test.ts              # decomposeContract() + prepareContract(), including BOTH
                                   # escalation paths asserted against the exact compile.ts
                                   # strings -- Phase 2
  compile-golden.test.ts             # every fixture contract vs. its pre-captured golden file,
                                   # including the two escalation-path fixtures -- Phase 2
  registry-compat.test.ts            # legacy/new/cross-target-collision/normalize-before-key
                                   # registration tests; atomic-write crash-safety test -- Phase 1
  evolution-evidence-ref.test.ts      # AmendmentEvidenceRef targetId propagation for
                                   # kind: 'ledger_entry'; explicit assertion that
                                   # kind: 'exception_item' refs never carry a fabricated
                                   # targetId -- Phase 4
tests/unit/promise/targets/
  watermark-compat.test.ts           # legacy/new/collision/staleness watermark tests -- Phase 1
  poll-result-compat.test.ts         # PollContractResult canonical/legacy fields -- Phase 1
  ledger-id-generation.test.ts        # buildEntryId() byte-identical for n8n, self-distinguishing
                                   # for a synthetic non-n8n target -- Phase 4
  deploy-outcome-classification.test.ts  # per-slot 'generated' vs. 'failed' vs. 'deployed', AND
                                   # the overall outcome 'generated' for an all-dry-run build --
                                   # Phase 3
  credential-isolation.test.ts        # NEW this revision -- resolveContractCompiler() and
                                   # resolveContractDeployer() never read N8N_BASE_URL/
                                   # N8N_API_KEY; resolveVerificationTarget() is never called
                                   # for a dry-run or blocked build -- Phase 3
  compiler-verifier.test.ts           # slot-name resolution + fetch-error preservation +
                                   # explicit assertion of the indirect-gap conflation (correction
                                   # 4's documented, accepted behavior) -- Phase 3
  execution-history-ordering.test.ts  # NEW this revision -- N8nExecutionHistorySource sorts/
                                   # truncates defensively even when given out-of-order or
                                   # over-limit raw input; assertConsistentTargetIds() rejects a
                                   # mismatched trio -- Phase 4
  evidence-conformance.test.ts        # n8n-normalized vs. in-memory evidence parity -- Phase 5
  cross-target-report-parity.test.ts  # SLA/ExceptionDesk/Report/Value/Evolution/Learning
                                   # identical given equivalent normalized evidence -- Phase 5
  in-memory-slot-isolation.test.ts    # NEW this revision -- fetching one deployed slot's data
                                   # never returns another slot's data -- Phase 5
```

No file under `src/reliability/`, `src/library/`, or `src/pack/pack-wirer.ts` is touched. `src/providers/types.ts` (`IProvider`) is not touched. `client.ts`/`PackBuilder`/`N8nProvider`/`N8nApiClient` are wrapped, not modified.

---

## 9. Persisted-data compatibility

| File | Current shape | Revised shape | Migration |
|---|---|---|---|
| `~/.kairos/contracts/<clientId>/<contractId>-workflows.json` | `RegisteredWorkflow.n8nWorkflowId`, merge keyed by it alone, direct (non-atomic) write | `targetId`/`targetDeploymentId` canonical; `n8nWorkflowId` legacy; merge keyed by `targetRefKey()` on **normalized** entries; **atomic temp-rename write** | **None required for reads.** New writes dual-write `n8nWorkflowId` for n8n; write path is now crash-safe. |
| `~/.kairos/promise-ledger/<clientId>/<contractId>/watermarks.json` | `Record<n8nWorkflowId, ContractPollWatermark>` | `targetRefKey()`-keyed, legacy key actively dual-written, staleness-aware read | **None required.** |
| `~/.kairos/promise-ledger/<clientId>/<contractId>/ledger.jsonl` | `ProofLedgerEntry` without `targetId`; `id` construction target-blind | `targetId?: TargetId` added; `id` construction now target-aware **inside the neutral extractor**, byte-identical for n8n | **None required.** |
| `~/.kairos/contracts/<clientId>/evolution/*` (Contract Evolution proposal storage) | `AmendmentEvidenceRef { kind, id }` | `targetId?: TargetId` added — **only meaningfully populated for `kind: 'ledger_entry'`; `kind: 'exception_item'` refs remain without it**, since `ExceptionDeskItem` itself has no target field (§6.8, correction 11) | **None required.** |
| `pollWorkflowEvidence()`'s `PollContractResult` (not persisted, but consumed by CLI/tests) | `n8nWorkflowId: string` required | `targetId`/`targetDeploymentId` canonical, `n8nWorkflowId` legacy — **Phase 1 only** (correction 8) | N/A — not a file, but existing call-site consumers updated in Phase 1. |

**clientId/contractId isolation, contractVersion association, active/retired registration history** — untouched.

**Rollback/recovery:** an old binary reads every n8n-target record correctly. It cannot read a future non-n8n-target record — expected, not a regression.

---

## 10. Public API compatibility — restated, grounded in §3.4's fully-restored map

Everything in §5-§9 lives inside `src/promise/`, `src/promise/targets/`, and new files under `src/providers/n8n/`, none exported from `index.ts`/`standalone.ts` (§3.4). `PackBuilder`, `Kairos`, `N8nProvider`, `N8nApiClient`, `IProvider` remain exactly as published, in every field and signature, in every phase. This plan adds new internal callers of them, never new public exports, and never changes any of their own existing signatures or behavior.

---

## 11. Migration strategy

1. No eager migration of any on-disk file.
2. No lazy migration-on-read.
3. New writes always populate canonical fields; the n8n adapter always dual-writes its legacy alias, permanently, actively kept current via rewrite on every save for the deployment currently being touched (§6.7's own corrected claim).
4. A future non-n8n target's writes never populate a legacy alias.
5. Rollback reads every n8n-target file correctly; does not, and is not expected to, understand a non-n8n-target record.

---

## 12. Test and checkpoint strategy

**Three distinct comparison methods, never conflated:** checked-in golden fixtures for deterministic/no-LLM outputs; behavioral/canonical equivalence for LLM-involving outputs; additive/superset comparison for files that intentionally gain fields.

**Golden-baseline sequencing is a process checkpoint, not a runtime test (correction 10).** Git commit ordering cannot be reliably asserted by an automated test — a packaged npm tarball, or a shallow CI checkout, may have no `.git` directory or history at all. The requirement is instead a **documented, two-commit procedure**, enforced by code review: Commit A captures `compileToPackPlan()`'s real output for every fixture (including the two new escalation-path fixtures) from **today's, unmodified** code, reviewed for correctness, and merged on its own. Commit B — the `decomposeContract()`/`prepareContract()` refactor itself — is only authorized to merge *after* Commit A exists in the branch history. The runtime test (`compile-golden.test.ts`) then does exactly what a test *can* prove: current code's output matches the already-committed fixture content, byte-for-byte. It cannot, and does not claim to, prove the fixture was captured before the refactor — that is a review-time responsibility, named here explicitly rather than implied to be automatically enforced.

**Before any registration/watermark schema change:** compatibility tests (§6.6, §6.7), including the normalize-before-key test and the atomic-write crash-safety test.

**Existing suites that must stay green, unchanged** (2137/2137 at v0.13.0, growing with each phase's additions).

**Live-checkpoint discipline, per phase:** Phase 1/2 — golden-fixture exact match, including both escalation-path fixtures. Phase 3 — behavioral equivalence, **explicitly including an all-dry-run build** (exercising both the per-slot `'generated'` outcome and the corrected overall `'generated'` outcome), and **explicitly confirming the plan-only path and the dry-run path both need zero n8n credentials** (a direct, live test of correction 1, not just a unit test). Phase 4 — behavioral equivalence for evidence extraction, including a batch execution with multiple items per transition, and a subsequent `kairos contract evolve run` confirming proposal evidence refs carry `targetId` for ledger-entry-derived proposals. Phase 5 — the two conformance suites plus the in-memory slot-isolation test.

**`npm pack` + fresh-install smoke test** re-run after any phase changing a persisted file shape or CLI-visible behavior.

---

## 13. Risks and open questions

1. **`IProvider` is public API and already unused internally.** Do not touch it in any phase (§3.3, §6's own comparison table).
2. **`ContractDeployResult.raw`/`TargetDeploymentSnapshot.raw` remain deliberately narrow, target-specific leaks at the abstract interface level** — resolved for the one real call site this arc has (generic typing + a concretely-typed factory, §6.2) but still `unknown` for a hypothetical future caller holding only the interface reference.
3. **The `n8nWorkflowId` pattern still recurs in `src/library/`, `src/pack/pack-wirer.ts`, `src/reliability/watch/loop.ts`** — still out of scope, named rather than ignored.
4. **Two independent re-implementations of "parse n8n runData" still exist** (`execution-tracer.ts` for drift, `normalizeN8nExecution()` for evidence) — unifying them remains out of scope, since it would require touching `src/reliability/drift/*`.
5. **`TargetCapabilities`' split shape is still underdetermined with one real implementation** — not validated until Phase 5.
6. **The compiler-verification fetch-error/indirect-gap conflation (§6.5) is preserved exactly, by explicit decision, not fixed.** A genuine `'unverifiable'` third state for verification would be a real improvement, but requires modifying `verifyCompiledWorkflows()` itself — out of scope for an arc committed to wrapping, not rewriting, existing tested logic. Named here as a real, accepted limitation, not silently carried forward as if today's behavior were fully correct.
7. **`AmendmentEvidenceRef.targetId` propagation has no single normalization choke point** (§6.8) — unlike registrations/watermarks, evidence refs are constructed ad hoc across multiple functions in `evolution.ts`; a future addition to that file could forget to thread `targetId` through with no type-system safeguard against it. §18's own test for this is the main mitigation; a longer-term fix (a single evidence-ref-construction helper) is a legitimate future improvement, not attempted here.
8. **Whether `ExceptionDeskItem` should eventually gain its own `targetId` field** (closing the gap named in §6.8 for `kind: 'exception_item'` refs) is a real, open, and explicitly *not decided* question — raised here for whoever authorizes a future phase, not silently deferred without a trace.
9. **The staleness-aware watermark read only resolves the specific old-binary-writes-after-new-binary race** — a more adversarial concurrent-write interleaving remains a named, accepted residual risk.
10. **Three separate factories in §6.2 (`resolveContractCompiler`/`resolveContractDeployer`/`resolveVerificationTarget`) is more construction-site surface than a single factory** — a deliberate trade-off, since the credential-isolation property this arc's own release-blocker (correction 1) depends on is only structurally guaranteed by *which function gets called*, not by a single function's internal branching that a future edit could get wrong.

---

## 14. Explicit non-goals

- No Zapier adapter. No Make adapter. No Hatchet integration. No Temporal integration.
- No production Node runtime. No dashboard/local console. No hosted service.
- No genericization of n8n drift/repair/replay/chaos/sandbox internals — their capability flags are explicitly informational-only (§6.1), with no interface anywhere in this plan claiming to cover them.
- No changes to `src/library/`, `src/pack/pack-wirer.ts`, or `src/reliability/watch/loop.ts`'s own `n8nWorkflowId` usage.
- No unification of `ExecutionTrace`/`NormalizedExecution`.
- No modification of `IProvider`, `N8nProvider`, `N8nApiClient`, `PackBuilder`, or `Kairos.build()`'s own source/behavior — wrapped, never rewritten, in every phase.
- No modification of `verifyCompiledWorkflows()`'s own internal logic — the indirect-gap conflation (§6.5, §13) is preserved, not fixed, by explicit decision.
- No `--target` CLI flag and no second real target.
- No conversion of any non-contract Kairos command to a generic target.
- No new schema field on `ExceptionDeskItem` (§6.8, §13) — named as a real, open, undecided question, not attempted this arc.

---

## 15. Phased implementation order

**Phase 0 (this document, Revision 5).** Planning only. Stop for review.

**Phase 1 — Compatibility readers/normalizers; every registration writer, watermark constructor, load/save caller, and existing test fixture affected by required canonical fields; PollContractResult included here, exactly once; tests before schema writes.**
- `resolveN8nApiClient()`: plain, n8n-specific de-dup helper — no target concept.
- `src/promise/targets/types.ts`: `TargetId`, `TargetDeploymentRef`, `targetRefKey()`, `CapabilityDescriptor` (discriminated union), `TargetCapabilities` (split) — shared identity primitives only, no operational interfaces yet.
- `registry.ts`: full split (`PersistedRegisteredWorkflow`/`PersistedContractWorkflowRegistration`/`RegisteredWorkflow`/`ContractWorkflowRegistration`), `normalizeRegisteredWorkflow()`, normalize-before-key merge, atomic temp-rename write, target-scoped `computeDroppedWorkflows()`.
- `handleContractCompile`'s registration-construction site (cli.ts:2311): dual-write, mechanical.
- `ledger-types.ts`/`ledger-store.ts`: full watermark split (`PersistedContractPollWatermark`/`ContractPollWatermark`), `normalizeContractPollWatermark()`, `targetRefKey()`-based keys, staleness-aware read, dual-write.
- `pollWorkflowEvidence()`'s watermark construction (ledger.ts:341) AND its `PollContractResult` construction: both dual-write canonical fields, **assigned here, once, per correction 8** — not repeated in Phase 4.
- Every load/save caller updated: `handleLedgerPoll` (cli.ts:3549), `runContractComplianceTick` (cli.ts:4398) both normalize registration entries before calling `loadContractPollWatermark`/`saveContractPollWatermark` with a `TargetDeploymentRef`, not a bare string.
- Existing tests/fixtures updated: every direct `RegisteredWorkflow`/`ContractPollWatermark`/`PollContractResult` object-literal construction in `registry.test.ts`/`ledger.test.ts`/`ledger-store.test.ts` gets canonical fields or is explicitly kept legacy-shaped to exercise the normalization functions' legacy branches.
- Compatibility tests (§6.6, §6.7, §18) written **before** any schema-touching code lands.
- Checkpoint: full existing suite green, unchanged; new compatibility tests green; live `kairos contract compile --build` → `kairos ledger poll` → `kairos contract report` against real n8n, behavioral equivalence confirmed.

> **Phase 1 — SHIPPED (2026-07-22).** Implemented exactly as specified below, then closeout-reviewed and corrected before commit.
>
> **Implemented scope.** `src/promise/targets/types.ts` (new): `TargetId`, `TargetDeploymentRef`, `targetRefKey()`, `CapabilityDescriptor` (discriminated union), `ImplementedCapabilities`/`InformationalReliabilityCapabilities`/`TargetCapabilities`. `src/promise/targets/types.compile-check.ts` (new, added during closeout — see finding 3 below): a small file, deliberately never imported by any of tsup's five bundle entry points, that gives `CapabilityDescriptor`'s discriminated-union invariant a *real*, `npm run typecheck`-enforced compile-time proof — necessary because this repository's own `tsconfig.json` excludes `tests/` from type-checking entirely, so a `@ts-expect-error` inside a `.test.ts` file is never actually validated by any command in the pipeline. `registry.ts`: full persisted/canonical type split, `normalizeRegisteredWorkflow()`, normalize-before-key collision-safe merge, atomic temp-rename write (closing a real, pre-existing gap — this file never had it before), target-scoped `computeDroppedWorkflows()`. `ledger-types.ts`/`ledger-store.ts`: the identical treatment for watermarks, plus the staleness-aware read. `ledger.ts`: `pollWorkflowEvidence()`'s own signature is unchanged; its `newWatermark` and `PollContractResult` constructions both dual-write the canonical fields. `cli.ts`: a new `resolveN8nApiClient()` helper (used at exactly one call site — see deviation below); `handleContractCompile`'s registration construction dual-writes; `handleContractReport`, `handleContractValue`, `handleLedgerPoll`, `runContractComplianceTick` all updated to the new ref-shaped watermark calls (`handleContractReport`/`handleContractValue` were not named in this section's own bullet list above but were discovered to need the identical fix during implementation, since they also call `loadContractPollWatermark` — documented honestly as a real scope gap in the original phase description, not silently absorbed).
>
> **Compatibility behavior, as actually verified, not merely designed.** Legacy (pre-boundary, `n8nWorkflowId`-only) registration and watermark records both load and normalize correctly — proven by dedicated tests that write a genuinely legacy-shaped fixture directly to disk (bypassing every Phase-1-aware write path) and read it back through the real, unmodified-signature public functions. A legacy file merges correctly with a fresh write with no `"undefined:undefined"` key ever appearing (the normalize-before-key ordering). Two different targets whose deployment ids collide as bare strings do not overwrite each other, in both registrations and watermarks (`targetRefKey()`'s per-component `encodeURIComponent` escaping, directly tested against a fixture pair that WOULD collide under naive string concatenation). The watermark staleness race (an old binary updating the legacy key with a newer `updatedAt` after a new binary already wrote both) resolves to the newer entry, not a blind composite-key preference. Both registry and watermark writes are now atomic (temp-file-then-rename), confirmed by a direct "no `.tmp` file left behind" check.
>
> **Validation results (final, after all five closeout fixes below).** `npm run typecheck`: clean. `npm run lint`: clean. `npm test`: **120/120 test files, 2157/2157 tests passed** (2137 baseline + 20 new: registry.test.ts 13→21, ledger-store.test.ts 19→24, plus two new files — `targets/types.test.ts` (5 tests) and `targets/poll-result-compat.test.ts` (2 tests)). `docs-drift.test.ts` passed as part of the suite (no CLI-visible change this phase). `npm run build`: clean. `npm pack` + fresh-install smoke test (per this section's own instruction and the accepted plan's §12): tarball built at the unchanged version `0.13.0` (273 files, up 2 from the v0.13.0 release pack, matching the one new bundled module plus its map — `types.compile-check.ts` confirmed absent from the built output, exactly as designed), installed into a fresh scratch project with no `@anthropic-ai/sdk` present, and exercised: `kairos --help` boots correctly; `kairos contract validate` and `kairos contract compile` (plan-only, no `--build`) both run correctly against the real Empire Homecare fixture with zero credentials; `kairos ledger poll`'s own usage text (invoked with no args) renders correctly, confirming the surrounding `cli.ts` code is intact; the full `contract`/`ledger`/`exceptions` command surface in `--help` is unchanged from pre-Phase-1.
>
> **Live n8n checkpoint: unavailable in this environment, explicitly still pending.** No `N8N_BASE_URL`/`N8N_API_KEY`/`ANTHROPIC_API_KEY` were set anywhere this phase was implemented or validated — the real `kairos contract compile --build` → `kairos ledger poll` → `kairos contract report` sequence against actual n8n.cloud, which this plan's own §12 calls for, could not be run. **This is named here explicitly, not silently substituted for and forgotten: the real n8n checkpoint remains outstanding and should be run before the complete Execution Substrate Boundary arc (all five phases) is considered production-validated**, even though Phase 1 itself is internal-only and has no CLI-visible behavior change to validate against a live instance yet.
>
> **Substitute checkpoint actually run, and exactly what it does and does not prove.** A standalone script, run via `tsx` directly against `src/` (not vitest, not the built bundle — proven to be a faithful proxy for the shipped binary's own behavior, since `npm run build` is a pure bundler with no logic transformation), exercised the real, modified `registry.ts`/`ledger-store.ts`/`ledger.ts`/`report.ts` functions end to end with real disk I/O against a real temporary `$HOME`: register two workflows (mirroring `handleContractCompile`'s exact dual-write construction) → first poll against a mock n8n client (real evidence extraction, real watermark write) → re-poll with the identical mock (proves the new ref-based watermark read correctly prevents reprocessing — this is the one step that most directly stands in for "poll evidence a second time," the core behavior a live n8n checkpoint would otherwise confirm) → target-scoped drop detection → a report built from the real resulting ledger entries → an explicit check that every field an old, pre-boundary binary would read (`n8nWorkflowId` alone) is present and correct. All six steps passed. **What this does not, and cannot, prove:** real n8n API response shapes/quirks, real network behavior, real credential handling, or anything about `handleContractCompile`'s or `handleLedgerPoll`'s actual `N8nApiClient`/`N8nCompilerVerifier` wiring under real HTTP round trips — those remain exactly what the still-pending live checkpoint above is for. Two bugs were found and fixed in the *checkpoint script itself* while building it (a mock returning execution timestamps relative to `Date.now()` instead of fixed values, and a mock returning executions in array order instead of the newest-first order real n8n's API is confirmed to use) — named here because they are a real, if narrow, illustration of exactly how easy it is for a *substitute* checkpoint to silently test the wrong thing, which is precisely why the real one is still required, not skipped.
>
> **Five closeout corrections made after the phase was first reported complete, before this note was written — documented here because the report that preceded this note materially overstated what two of the new tests actually proved:**
> 1. The dual-write watermark test (`ledger-store.test.ts`, "a fresh save... writes both keys") originally asserted `Object.keys(raw).some(k => k.startsWith('n8n%3A') || k.includes('wf-dual'))` — an OR-any check that the legacy bare key `'wf-dual'` alone trivially satisfies (`'wf-dual'.includes('wf-dual')` is true), meaning the assertion could pass even if the composite-key write were completely broken or absent. Fixed to assert both the exact legacy key and the exact `targetRefKey()`-computed composite key independently.
> 2. The staleness test fixture hand-spelled its seeded composite key as `'n8n%3Awf-stale'` — **wrong**: `targetRefKey()` only percent-encodes the two components individually; the literal `:` delimiter between them is never encoded, so the real key is `'n8n:wf-stale'`. Because the wrong key was seeded, the real composite-key lookup found nothing, and the function silently fell through to the legacy-only branch — the test passed, but for the wrong reason, never actually exercising the "both keys exist, compare `updatedAt`, newer wins" branch its own name claims to test. Fixed to build the fixture key via `targetRefKey()` itself, with a sanity assertion that both seeded keys are genuinely present in the file the test wrote, so this class of mismatch can't recur silently.
> 3. `CapabilityDescriptor`'s negative-assertion coverage (`types.test.ts`) was runtime-only — it could prove a *valid* construction's shape, never that an *invalid* one is rejected, since this repository's `tsconfig.json` excludes `tests/` and vitest doesn't type-check at all, making a `@ts-expect-error` in a test file inert. Fixed by adding `src/promise/targets/types.compile-check.ts` (described above) and verifying directly — not just asserting — that it works: temporarily stripping its `@ts-expect-error` comments and re-running `npm run typecheck` produced exactly the three expected `TS2322`/`TS2353` errors before the file was restored.
> 4. `npm pack` + a fresh-install smoke test had not been run for Phase 1's own persisted-file-shape changes, as this plan's own §12 requires. Run during closeout — see validation results above.
> 5. This shipped note itself — added per this same closeout request, so a reader of this plan doesn't need a separate report to know Phase 1's real, current, honestly-assessed status.

**Phase 2 — Golden-baseline capture (its own commit, before any refactor commit); pure neutral decomposition/preparation helper with byte-exact escalation text; existing n8n compiler delegates to it; golden-fixture parity tests.**
- **Commit A (process checkpoint, §12):** capture `compileToPackPlan()`'s real output for every fixture contract, plus two new fixtures deliberately constructed to trigger each escalation path, from today's unmodified code, into `tests/fixtures/contracts/golden-compile/`, reviewed and merged on its own.
- **Commit B, strictly after A:** `decomposeContract()`/`prepareContract()` (§5), with escalation text copied verbatim from `compile.ts:230,244`; `compileToPackPlan()` refactored to call `prepareContract()` internally.
- Checkpoint: full suite green; every fixture's output — including both escalation paths — matches its pre-captured golden file exactly.

> **Phase 2 — SHIPPED (2026-07-22).** Commit A (golden-baseline capture) was implemented, reviewed, and merged as its own dedicated commit. Commit B — the `decomposeContract()`/`prepareContract()` refactor itself — was implemented exactly as specified in §5, then closeout-reviewed and corrected.
>
> **Implemented scope.** `src/promise/decomposition.ts` (new, zero imports from `compile.ts` or any other target-specific module — the dependency runs one way only, target-specific code depends on this neutral core, never the reverse): `WorkflowSlotKind`, `WorkflowSlot`, `ContractDecomposition`, `decomposeContract()`, `ContractPreparationEscalation` (the canonical, neutrally-named definition of what used to be `compile.ts`'s own `CompileEscalationInfo`), `ContractPreparationResult`, `prepareContract()` — copied from §5's accepted spec verbatim, including both escalation `reason` strings byte-for-byte from `compile.ts:230,244`. `src/promise/compile.ts`: `CompileEscalationInfo` is now a backward-compatible type alias (`export type CompileEscalationInfo = ContractPreparationEscalation`) re-exported from `compile.ts` so nothing that already imports it from there needs to change, with its real definition living in `decomposition.ts`. `compileToPackPlan()` now calls `prepareContract(contract)` first and branches on `outcome` — `'blocked'` returns `prepared.escalation` directly, identical shape to before; `'ready'` walks `prepared.decomposition.slots`, deliberately preserving the original three-part control flow (an indexed loop over `contract.startConditions`, matched positionally against the decomposition's intake slots — safe because `decomposeContract()` builds exactly one intake slot per StartCondition, in the same order, with zero skipping — then one `.find()` for the processing slot, then one `.find()` for the escalation slot) instead of a generic single-loop dispatch keyed off `slot.kind`, specifically to keep the diff small and the byte-for-byte equivalence easy to verify by inspection, not just by test. `buildIntakeWorkflow()`/`buildProcessingWorkflow()`/`buildEscalationWorkflow()` were narrowed to accept a pre-computed `WorkflowSlot` for `name`/`sourceElements` instead of recomputing them, and their own `transitions.length === 0` / `sla.length === 0 && expirationRules.length === 0` early-exit null-return guards were removed as now-redundant (the caller only invokes them when `decomposeContract()` already determined the slot exists) — every line of prose-generation logic (`lines`, `description`, `purpose`) is byte-for-byte unchanged.
>
> **One closeout correction made after Commit B was first reported complete, before this note reached its final form — documented here because the direction of one dependency was wrong.** `decomposition.ts` originally imported `CompileEscalationInfo` from `compile.ts` as a type-only import — safe at runtime (erased at compile time, no circularity), but architecturally backwards: it made the target-neutral module depend, even nominally, on the n8n-specific one. Fixed by defining the type natively in `decomposition.ts` as `ContractPreparationEscalation` and turning `compile.ts`'s `CompileEscalationInfo` into a type alias pointing at it — `decomposition.ts` now has zero imports from `compile.ts`, confirmed directly via grep, not just asserted. Separately, `compile-golden.test.ts` originally parsed both sides with `JSON.parse` and compared with `toEqual()`, which proves structural equality but is blind to key-order or formatting drift; fixed to compare `JSON.stringify(compileToPackPlan(contract), null, 2) + '\n'` directly against each golden file's raw text, after first confirming directly (not assuming) that this exact serialization is what the committed golden files already contain byte-for-byte.
>
> **Two new test files, per §8's file layout.** `tests/unit/promise/decomposition.test.ts`: direct unit coverage of `decomposeContract()`'s slot ordering/content/omission rules and `prepareContract()`'s ready/blocked outcomes, with both escalation `reason` strings hardcoded literally in the test (not imported from either source file) so a future accidental drift in `compile.ts` or `decomposition.ts` is caught by a literal string mismatch, not silently passed because both sides drifted together. `tests/unit/promise/compile-golden.test.ts`: sweeps all 10 fixtures under `tests/fixtures/contracts/` (both the pre-existing `negative-*` structurally-invalid ones and the valid ones — Commit A captured a golden output for all 10, not only the two new escalation fixtures, since `compileToPackPlan()` runs deterministically on any contract regardless of validity) and deep-compares the refactored `compileToPackPlan()`'s live output against each fixture's already-committed `tests/fixtures/contracts/golden-compile/<name>.expected.json`. No golden file was modified or regenerated to make this test pass, per this phase's explicit instruction.
>
> **Mismatches found: none.** All 10 golden comparisons passed on the first run against the unmodified, already-committed golden files. The 17 pre-existing behavioral tests in `tests/unit/promise/compile.test.ts` (written against the pre-refactor code, asserting on workflow names/descriptions/traceability/assumptions/checklist rather than full-object equality) also passed unchanged, with zero edits to that file — a second, independent confirmation of behavior preservation beyond the golden-fixture comparison itself.
>
> **Validation results.** `npm run typecheck`: clean. `npm run lint`: clean. `npm test`: **122/122 test files, 2179/2179 tests passed** — the file count rose by exactly 2 (120 → 122), matching the two new test files added this phase (10 tests in `decomposition.test.ts`, 11 in `compile-golden.test.ts`); zero regressions anywhere else in the suite, zero modifications to any pre-existing test. `docs-drift.test.ts` passed as part of the suite — no CLI-visible behavior changed this phase; `compileToPackPlan()`'s exported signature and the `CompileToPackPlanResult`/`CompileEscalationInfo`/`ContractWorkflowTrace` shapes are all unchanged. `npm run build`: clean. Per §12's own guidance, a `npm pack` + fresh-install smoke test was judged unnecessary for this specific commit and was not run: this refactor changes no persisted-file shape and no CLI-visible behavior — `compile.ts`'s one external CLI caller (`cli.ts:2224`) invokes the same exported `compileToPackPlan()` with the same signature and receives byte-identical output, which the golden-fixture test above already proves directly; Phase 1's own pack/smoke-test remains the most recently run one.
>
> **External consumers confirmed unaffected.** `src/promise/compiler-verify.ts` (imports `evidenceNodeName`, `type ContractWorkflowTrace`) and `src/promise/ledger.ts` (imports `evidenceNodeName`) both still resolve against `compile.ts`'s unchanged exports — neither file was touched. `src/cli.ts:2224`'s dynamic `import('./promise/compile.js')` and its `compileToPackPlan(contract)` call are unchanged.
>
> **No deviations from the accepted plan.** The implementation matches §5 exactly, including both escalation strings byte-for-byte and the one-caller discipline (`decomposeContract()`'s only caller is `prepareContract()`; `prepareContract()`'s only caller today is `compileToPackPlan()`, with a second caller anticipated in Phase 3 for a future non-n8n target's own compiler, not yet built). `research/` was not touched at any point.

**Phase 3 — `ContractCompiler`/`ContractDeployer`/`DeploymentLookup`/`TargetCompilerVerifier` interfaces; the three-way credential-isolated factory split; n8n adapters delegate to existing build/deploy behavior; contract CLI uses the boundary; behavioral-equivalence checkpoint including a dry-run and an explicit credential check.**
- Interfaces (§6.2, §6.3, §6.5); `N8nContractCompiler`/`N8nContractDeployer`/`N8nDeploymentLookup`/`N8nCompilerVerifier`.
- `resolveContractCompiler()`/`resolveContractDeployer()`/`resolveVerificationTarget()` — three separate factories, per §6.2's release-blocker fix (correction 1).
- `handleContractCompile`'s plan-only path, `--build` branch, and compiler-verification block revised to use the boundary — with the verification-target gate matching today's exact condition (not dry-run, not blocked, at least one deployed slot).
- Checkpoint: full suite green; live `kairos contract compile` (plan-only, zero credentials, confirmed) and `kairos contract compile --build --dry-run` (zero *n8n* credentials, confirmed — this is the direct test of correction 1) and `kairos contract compile --build` (real n8n) all confirmed behaviorally equivalent, with the corrected `'generated'`/`'deployed'`/`'partial'`/`'blocked'` overall outcomes exercised explicitly.

**Phase 4 — n8n execution normalization split; neutral evidence extraction with target-aware ledger-ID generation in the correct layer; `AmendmentEvidenceRef` target propagation; defensive execution-history ordering; behavioral-equivalence checkpoint.**
- `ExecutionHistorySource`/`EvidenceNormalizer` interfaces; `N8nExecutionHistorySource` (defensive sort/limit, per correction 9); `normalizeN8nExecution()` (no id construction) and `evidenceNodeName()`'s relocation; `assertConsistentTargetIds()`.
- `extractNormalizedEvidence()` with `buildEntryId()` (§6.4) and the `sourceItemRef` index fallback.
- `ProofLedgerEntry.targetId`; `AmendmentEvidenceRef.targetId` propagation for `kind: 'ledger_entry'` (§6.8) — `PollContractResult`'s own change was already completed in Phase 1 (correction 8), not repeated here.
- `handleLedgerPoll`/`runContractComplianceTick` revised to use the boundary.
- Checkpoint: full suite green; live `kairos ledger poll` → `kairos contract report` against real n8n, including a batch execution with multiple items per transition, and a subsequent `kairos contract evolve run` confirming proposal evidence refs carry `targetId`.

**Phase 5 — In-memory adapter (five interfaces, slot-specific deployment storage, blocking-assumption-gated by construction); cross-target conformance suite; capability model validated by two implementations.**
- `InMemoryContractTarget` (§7); evidence-normalization, cross-target report-parity, and slot-isolation suites.
- Checkpoint: all three suites pass.

**Not part of this plan, at any phase:** `IProvider`, `N8nProvider`'s/`N8nApiClient`'s/`PackBuilder`'s/`Kairos.build()`'s/`verifyCompiledWorkflows()`'s own source logic, `src/library/`, `src/pack/pack-wirer.ts`, `src/reliability/watch/loop.ts`'s own registration, `src/reliability/{drift,repair,replay,chaos,sandbox}/*`'s internal logic, any new field on `ExceptionDeskItem`.

Each phase stops for its own review and live checkpoint before the next begins.

---

## 16. Definition of done — for this planning pass (Revision 5)

- [x] All 12 corrections from the fourth-round review addressed, each independently re-verified against real source this pass.
- [x] Two genuine behavioral regressions fixed: the dry-run credential requirement (correction 1) and the all-dry-run "deployed" misclassification (correction 3).
- [x] Golden parity made genuinely achievable via byte-exact escalation text in `prepareContract()` (correction 2).
- [x] Compiler-verification fetch-error semantics explicitly decided and documented, not left ambiguous (correction 4).
- [x] The document restored to fully self-contained — §3.3, §3.4, §6.7 written out in full, not referenced against an unavailable prior revision (correction 5).
- [x] `DeployedSlotResult` and `ContractPreparationResult` are real discriminated unions; every non-null assertion removed from the design (correction 6).
- [x] A persisted outer registration container type (`PersistedContractWorkflowRegistration`) defined (correction 7).
- [x] `PollContractResult`'s canonical-field change assigned to exactly one phase (correction 8).
- [x] Execution-history ordering defensively enforced; a cross-component target-id guard added (correction 9).
- [x] Golden-baseline sequencing reclassified as a documented process checkpoint, not a runtime-testable git-history assertion (correction 10).
- [x] Contract Evolution target-provenance wording corrected — `ExceptionDeskItem` has no `targetId`, named as an open question, not implied to already work (correction 11).
- [x] In-memory deployment references resolve to slot-specific data, not the whole decomposition (correction 12).
- [x] Explicit tests added or updated for every one of the 12 corrections (§18).
- [x] Every section states its own why/when/where/how/guardrails/reasoning/outcomes, per the user's explicit standing instruction for this document.
- [x] No product code modified. No implementation started. `research/` untouched. Plan not committed.

---

## 17. Definition of done — for the eventual, implemented boundary

- `ProcessContract` remains unchanged and target-neutral.
- Neutral contract decomposition/trace (`decomposeContract()`, via the shared `prepareContract()` gate) does not require calling `compileToPackPlan()` or any other target-specific compiler, applies the identical validation/blocking-assumption gate for every target, and produces escalation text byte-identical to today's for the n8n path.
- Contract-specific compile/build CLI logic calls `ContractCompiler`/`ContractDeployer`/`TargetCompilerVerifier` — the plan-only path and the dry-run path are both proven, not assumed, to still need zero n8n credentials.
- Contract-specific evidence-polling CLI logic calls `ExecutionHistorySource`/`EvidenceNormalizer`, with target-id consistency enforced across the wired-together components.
- n8n remains the unchanged default and only production execution target.
- The in-memory adapter implements every interface it declares `'supported'` for (five, not six), with slot-specific, not whole-decomposition, deployment data.
- New n8n deployments — including dry runs, correctly classified as `'generated'` at both the per-slot and overall-outcome level, never `'failed'` or `'deployed'` — behave identically to pre-boundary behavior.
- Legacy registrations, watermarks, and poll results remain readable without migration; all are normalized exactly once, at their own load boundary.
- Registry writes are crash-safe (atomic temp-rename).
- Target-aware registrations and watermarks cannot collide across different `targetId`s, including when either component of the key contains a `:` character.
- Normalized Promise Engine evidence contains no required n8n concept; ledger-entry IDs are generated by the neutral extractor, byte-identical for n8n.
- ProofLedger and Contract Evolution's `ledger_entry`-kind evidence references both carry consistent, optional target provenance; `exception_item`-kind references honestly do not, and this is documented, not silently assumed away.
- Compiler verification's fetch-error/indirect-gap conflation is preserved exactly as it exists today, by explicit, documented decision.
- SLA compliance, ExceptionDesk, Promise Report, Value Report, Contract Evolution, and Learning-note results are identical across equivalent normalized evidence regardless of target.
- Public npm APIs remain byte-for-byte backward-compatible.
- Replay, chaos, drift, repair, sandbox, and rollback remain honestly n8n-specific, with their capability flags explicitly labeled informational.
- The full existing test suite passes at every phase; golden baselines were captured and committed before, not after, the refactor commit that depends on them; every correction in §18 has a passing, named test or an explicitly-documented process checkpoint where a runtime test cannot apply.

---

## 18. Correction → test traceability

| # | Correction | Test / checkpoint | What it asserts |
|---|---|---|---|
| 1 | Dry-run credential regression | `credential-isolation.test.ts`; Phase 3 live checkpoint | `resolveContractCompiler()`/`resolveContractDeployer()` never read `N8N_BASE_URL`/`N8N_API_KEY`; `resolveVerificationTarget()` is called only when `!dryRun && outcome !== 'blocked' && outcome !== 'generated'`; a live `--build --dry-run` run against a contract with no `N8N_BASE_URL` set in the environment succeeds. |
| 2 | Golden parity / escalation text | `decomposition.test.ts`; two new golden fixtures | `prepareContract()`'s two escalation `reason` strings match `compile.ts:230,244` byte-for-byte; the two new golden-fixture files capture both escalation paths from pre-refactor code. |
| 3 | Overall `'generated'` outcome | `deploy-outcome-classification.test.ts` | An all-`'generated'`-slots deploy result (simulated all-dry-run build) computes overall `outcome: 'generated'`, never `'deployed'`. |
| 4 | Fetch-error / indirect-gap decision | `compiler-verifier.test.ts` | Fetch errors appear in `fetchErrors`, never in `verification.findings`, matching today; a separate, explicitly-named test asserts the documented indirect-gap conflation itself (a missing fetch causes a `gaps_found` verdict for that workflow's own evidence requirements) so the accepted limitation is pinned by a test, not just prose. |
| 5 | Self-containment | (this document itself) | §3.3/§3.4/§6.7 contain full content, verifiable by reading this file alone with no reference to an unavailable prior revision. |
| 6 | Discriminated unions | (enforced by the type system; `deploy-outcome-classification.test.ts` exercises all three `DeployedSlotResult` variants and both `ContractPreparationResult` variants) | No `s.ref!`/`prepared.decomposition!` non-null assertion exists anywhere in the implemented code; a `// @ts-expect-error` fixture confirms `{outcome: 'deployed'}` without `ref` fails to typecheck. |
| 7 | Persisted outer registration type | `registry-compat.test.ts` | `loadRawRegistration()`'s return type is `PersistedContractWorkflowRegistration | null`; a fixture with raw, unnormalized `workflows` entries loads and normalizes correctly via `loadContractWorkflowRegistration()`. |
| 8 | `PollContractResult` phase ownership | Phase 1's own checkpoint | `PollContractResult`'s canonical fields exist and are dual-written starting in Phase 1, before any Phase 3/4 interface exists — confirmed by the module-layout table (§8) and phase description (§15) agreeing on exactly one phase. |
| 9 | Execution-history ordering + cross-guard | `execution-history-ordering.test.ts` | `N8nExecutionHistorySource.listExecutions()` returns newest-first and respects `limit` even when fed a deliberately out-of-order or over-limit raw fixture; `assertConsistentTargetIds()` throws when any of ref/historySource/normalizer disagree. |
| 10 | Golden-baseline sequencing | (documented process checkpoint, §12, §15 — explicitly not a runtime test) | The Phase 2 description requires Commit A (golden capture) to exist before Commit B (refactor) is authorized to merge; `compile-golden.test.ts` verifies current output matches the committed fixture, which is only meaningful because of this documented ordering discipline. |
| 11 | ExceptionDesk wording correction | `evolution-evidence-ref.test.ts` | `detectRateHotspot()`'s `kind: 'ledger_entry'` refs carry `targetId` threaded from source ledger entries; a separate assertion confirms `kind: 'exception_item'` refs are never given a fabricated `targetId` (remaining `undefined`, honestly). |
| 12 | In-memory slot isolation | `in-memory-slot-isolation.test.ts` | Deploying a multi-slot decomposition, then fetching one slot's deployment reference, returns only that slot's own `WorkflowSlot` data — never another slot's, never the whole `ContractDecomposition`. |

---

## Contradictions found between the supplied context and current code

**Unchanged conclusion across all five revisions: none, in the sense of a sponsor-brief factual claim being wrong.** Every specific coupling point named in the original sponsor brief was independently verified true against the real source, every revision.

**This revision's own provenance, stated honestly:** Revision 5 responds to a fourth technical review that found two genuine behavioral regressions and ten further design/self-containment gaps in Revision 4's own proposed pseudocode — not new contradictions in the original sponsor brief. Every corrected fact cited above (the exact `PackBuilder.build()` outcome branches, the exact `compileToPackPlan()` escalation strings, the exact absence of a `targetId` field on `ExceptionDeskItem`, the exact behavior of `N8nApiClient`'s real methods) was independently re-confirmed against the real source this pass, not accepted from either review's own text alone. The pattern across all five revisions is consistent: the underlying architectural direction has not needed to change since Revision 2's correction of Revision 1's scope; every subsequent revision has corrected concrete, verifiable implementation defects in the design's own pseudocode and control flow, each one confirmable — and confirmed — against the real codebase.
