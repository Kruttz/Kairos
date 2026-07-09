# Kairos Hardening & Pack-Chaining Implementation Plan

**Status:** Authoritative, not immutable. This is the current best plan, amended in place whenever implementation reveals a fact that contradicts it (exactly as Step 7's `pack-wirer.ts` correction and this section's own corrections round already did, before any code was written) — not re-litigated wholesale, and not treated as frozen against reality once Step 1 begins.
**Amendment history:** v1 (initial). v2 — incorporated a corrections pass covering: deterministic no-network fixtures with no live Anthropic calls in required CI, no committed failing tests, chaining dependency validation (unknown/forward/cycle handling), stable workflow dependency keys instead of display names, method/path/full-URL distinction in `WorkflowReference`, provenance hashing extended to connections/settings, content-derived (not manually-bumped) version fields, and a tiny non-blocking ledger v0 so Step 6 cannot delay chaining or Empire Homecare. v3 — Steps 1–6a executed and closed (including two Codex review rounds on Step 5's provenance work that found and fixed real gaps, and a best-effort fix on Step 6a's telemetry emissions); Step 7's design tightened before any Step 8 code: unknown/self-dependency/cyclic dependency declarations now rejected per-workflow before generation spend (not v2's graceful degrade) — duplicate dependencies, on manual trace-through, turned out to warrant a different, lighter response (dedupe-and-build, not reject) — a new build-time cascading-unavailability gate distinct from plan-time rejection, and an explicit dry-run-vs-unavailable distinction so dry-run packs (the common case) don't lose chaining. v4 (this revision) — a second review of Step 7 found six further gaps, all closed before any Step 8 code: ambiguous name resolution (two workflows sharing a display name) now its own rejection category; malformed-but-present `dependsOn` now rejected rather than silently coerced to `[]`; `resolveBuildOrder()`'s own return shape was internally incoherent (claimed a topological order could contain rejected/cyclic workflows, which is mathematically undefined) — fixed to a six-pass pipeline where only the valid DAG gets ordered and every rejection is pre-seeded as unavailable before building starts; the returned `PackWorkflowResult[]` now explicitly preserves original plan order regardless of execution order; `workflowKey`/`dependsOn` now persist onto `PackWorkflowResult` so the dependency graph survives past one build call; and `webhookUrl` construction now explicitly reuses `N8nApiClient.triggerWebhookProduction()`'s existing URL-building logic via a new shared function, rather than a second implementation.
**Origin:** Three independent rounds — (1) 12-repo external research by two agents independently, (2) cross-comparison of both research sets with source verification, (3) cross-audit of both final recommendations with further source verification and correction, followed by a fourth corrections pass before implementation began. This document is the execution spec that came out the other end. It does not re-litigate the research; see `research/comparison/` for that.
**Scope boundary:** No new architecture beyond what's specified here. No Kairos code is modified by writing this document — it is the plan for implementation sessions, updated as those sessions proceed.

---

## 0. How to read this document

Each of the 10 steps below uses the same template: **What / Why / When / How / Where / Reasoning / Process / Guardrails / What to avoid / Outcome / Anything else**. Read them in order — they are sequenced by dependency, not by arbitrary priority. A handful of small "interleaved items" (Section 12) get a lighter version of the same template; they ride alongside the numbered steps rather than blocking them. Step 6 is split into a tiny non-blocking v0 (6a) and an explicitly deferred full version (6b) — see Section 8.

**The one rule that overrides all others:** one step (or one clearly-scoped sub-piece of a step) = one commit = tests green = typecheck/lint clean, before moving to the next. Never bundle two steps' changes into one commit, even when they touch the same file. This is not bureaucracy — it's what makes Step 4 ("fix confirmed defects") auditable against Step 3 ("find defects"), and what makes Step 8's chaining implementation safely reversible piece by piece if something goes sideways.

**Every claim of "verified" below was checked directly against Kairos source (v0.10.0) or the relevant n8n source during this planning session — not assumed from the earlier research documents.** One such check overturned an assumption both prior research syntheses made: see Step 7.

---

## 1. Why this order (dependency rationale)

```
Step 1  Read real telemetry ──────────────┐
                                            ├─→ sizes Step 2's fixtures
Step 2  Regression safety net ─────────────┴─→ protects everything below
Step 3  n8n ground-truth audit ────────────────→ produces confirmed defects
Step 4  Fix confirmed defects ─────────────────→ protected by Step 2, informs nothing gets imported speculatively
Step 5  Provenance stamps ─────────────────────→ independent of 3/4, but should land before chaining generates new artifacts
Step 6a Ledger v0 (tiny, 2 events) ─────────────→ minimal, non-blocking; full ledger (6b) explicitly deferred past Step 9
Step 7  Chaining — DESIGN ─────────────────────→ the one real architecture change; deliberately separated from code
Step 8  Chaining — IMPLEMENTATION ─────────────→ built behind Step 2's fixtures, extended with a chaining-specific fixture
Step 9  Real-flow checkpoint ──────────────────→ the whole arc, run for real, once
Step 10 Empire Homecare ───────────────────────→ the actual business milestone every prior step serves
```

Steps 1–2 must come first because everything after them edits validator, catalog, or generation-adjacent code, and there is currently no regression net catching a silent break. Steps 3–4 are paired and sequential (diagnose, then treat) rather than merged, so the commit history stays honest about what was found versus what was changed. Step 5 (provenance) is independent of 3/4 but is sequenced before chaining specifically so that chained-pack artifacts get provenance from day one instead of being retrofitted. Step 6a (ledger v0 — two event types only) is placed after provenance because those two events want to carry provenance fields, and is deliberately kept tiny so it cannot delay chaining; the full ledger (Step 6b) is explicitly deferred to after Step 9, since none of it is a real dependency of chaining or the checkpoint. Steps 7–8 are the payload of the whole arc and are deliberately split into a design step and an implementation step because this is the single highest-leverage and highest-risk item in the plan. Steps 9–10 are the checkpoint and the actual reason any of this matters.

---

## 2. Global guardrails (apply to every step)

- **No comment unless the WHY is non-obvious.** Match Kairos's existing style — no restating what code does, no "used by X" references to this plan.
- **No speculative generalization.** Every fix in Step 4 is narrow and scoped to what Step 3 actually found. No step in this plan imports a general mechanism (e.g., n8n's `displayParameter()`) speculatively — general mechanisms stay behind their own named trigger even when a related narrow fix is happening in the same session.
- **Repairs stay telemetry-visible.** If a step ever introduces something that silently corrects malformed model output, it must still surface in telemetry/logs — Kairos's pattern-learning loop depends on seeing failures, not having them quietly absorbed.
- **Retries must be operation-aware.** Auto-retry only safe reads and genuinely idempotent operations. Workflow creation, activation, and webhook-test calls must classify-then-escalate rather than blindly retry — a lost response on a call that actually succeeded server-side must never become a duplicate side effect in a client's real n8n instance.
- **Additive schema changes only.** Any new field on an existing interface (`BuildResult`, `BundleManifest`, `PreflightResult`, `TelemetryEvent`, `WorkflowPlan`, `BuildOptions`) must be optional and must not break deserializing artifacts created before the change shipped.
- **Precise language about guarantees.** Do not call anything "rollback" that isn't transactional. Timestamped bundle directories are **restore candidates** — redeployment can still depend on credentials, webhook registration, and environment/n8n-version state the JSON alone doesn't capture. Do not call `ANTHROPIC_BASE_URL` a multi-model abstraction — it works for Anthropic-wire-format-compatible endpoints only, not arbitrary local models.
- **One commit per defect, per event type, per implementation piece.** Never batch unrelated changes.
- **When in doubt about scope, do less.** Every step lists a "what to avoid" — treat scope creep inside a step as a bigger risk than under-scoping it.

---

## 3. Step 1 — Read and classify real failure telemetry

**What:** Read the JSONL telemetry Kairos already writes (`~/.kairos/telemetry/*.jsonl` by default, or wherever this instance's `telemetry` option points), covering the three existing event types (`build_start`, `generation_attempt`, `build_complete`), and classify what's actually there: rule-violation frequency, parse-failure occurrences and shape, workflow-type distribution, attempt-count distribution.

**Why:** This is the one research act neither prior agent performed across six documents, despite four hold-off items (`displayParameter()` import, syntactic JSON-repair modes, the DSL spike, and Step 3's audit sizing) explicitly depending on what real failures look like. Doing this first turns four guesses into evidence and directly determines what Step 2's fixtures should assert on.

**When:** Now — first, before any code change. Zero risk; pure information-gathering.

**How:**
- Locate the telemetry directory actually in use.
- Parse each `.jsonl` line; group by `eventType`.
- For `generation_attempt` events (shape: `GenerationAttemptData` in `src/telemetry/types.ts`): tally `issues[].rule` frequency, tally `parseFailure` occurrences (`AttemptMetadata.parseFailure` — set only when an attempt produced no parseable workflow at all) and inspect the actual malformed content if any exist, tally `workflowType` distribution.
- For `build_complete` events (`BuildCompleteData`): tally `success` rate, `totalAttempts` distribution, `warnedRules` frequency.
- Cross-reference firing rule numbers against `src/validation/rule-metadata.ts`'s `RULE_PIPELINE_STAGES` map to see which pipeline stage (`node_generation` / `credential_injection` / `connection_wiring` / `workflow_structure` / `expression_syntax`) dominates — this directly validates or redirects Step 3's audit targeting.

**Where:** `~/.kairos/telemetry/*.jsonl` (read-only), `src/telemetry/types.ts` (event shapes), `src/validation/rule-metadata.ts` (rule → stage cross-reference).

**Reasoning:** The data already carries structured signal (rule numbers, severities, parse failures) under a stable, versioned schema (`TELEMETRY_SCHEMA_VERSION = 2`) — this is "finally read what's already being captured," not "add logging then wait weeks." If the directory is thin or empty (plausible — Kairos hasn't had a paying client yet), that is itself an important, valid finding: it means Steps 2's fixtures should lean on structural coverage rather than telemetry-driven content, and it strengthens rather than weakens the case for treating Empire Homecare as the priority.

**Process:**
1. List and sort all `.jsonl` files by date.
2. Parse into the three event-type groups.
3. Build simple frequency tables: rule frequency, parse-failure count + content samples, workflow-type distribution, attempt-count distribution.
4. Write a short findings note (a markdown file, e.g. `docs/plans/telemetry-findings-<date>.md`, or a section appended to this plan): event count and date range; top 5 firing rules and their pipeline stages; parse-failure count and shape; explicit statement of whether any of the four telemetry-gated triggers fired; what Step 2's fixtures should specifically cover as a result.

**Guardrails:**
- Zero source-code changes in this step.
- Do not over-fit conclusions to a tiny sample — state the sample size plainly rather than treating N=8 as a representative distribution.
- Telemetry may contain real business descriptions from dev/test usage — treat as sensitive; don't paste raw contents into any shared artifact without checking contents first.

**What to avoid:** Don't skip this because the external research already produced hypotheses — the whole point is that research was blind to this data. Don't over-polish the findings note; it's an input to Step 2, not a deliverable.

**Outcome / Definition of done:** A findings note exists stating event count/date range, top failing rules + stages, parse-failure shape (if any), which (if any) telemetry-gated triggers fired, and what Step 2 should specifically cover.

**Anything else:** An empty or thin telemetry directory is not a failed step — it's evidence that production signal doesn't exist yet, which should make Step 2 lean structural (not over-fit to a handful of dev-time events) and makes Step 10 (Empire Homecare) the thing that will actually generate the signal every hold-off item is waiting on.

---

## 4. Step 2 — Regression safety net

**What:** Two clearly separated deliverables, not one:
1. **Required, CI-gated:** 2–3 golden pack fixtures with **semantic** assertions (not full JSON snapshots), built with a **stubbed/recorded LLM response** and a mocked n8n — zero live network calls of any kind, including to Anthropic.
2. **Manual, not required-CI:** a benchmark-baseline diff for `scripts/benchmark.ts`, which by its own nature calls the real Anthropic API — this stays a human-triggered comparison, never a gate that fires automatically on every push.

**Why:** Steps 3, 4, 5, 7, and 8 all touch validator, catalog, or generation-adjacent code. Full-JSON-snapshot tests were explicitly considered and rejected: they rot into false-positive noise (node IDs, key ordering, timestamps differ every run) and get rubber-stamped away via "update snapshot," silently losing protective value over time. **Corrected in this revision:** the first draft of this step said "run each through the real `plan()`/`build()` path" for the required fixtures without addressing that this path calls the real Anthropic API — which would make required CI non-deterministic (model output can vary), slow, and costly on every run. The fix is to separate "does the pipeline logic behave correctly" (deterministic, stubbed-LLM, required-CI) from "does the real model actually generate well" (non-deterministic by definition, live-API, manual-only) — these are different questions and need different gates.

**When:** Now, immediately after Step 1 (so fixture content reflects real failure modes where they exist) and before Step 3's fixes land.

**How:**
- **Golden fixtures (required CI, fully offline):** Construct 2–3 `WorkflowPackResult`-shaped fixtures by stubbing the Anthropic client's response (record a real `plan()`/`build()` LLM response once, by hand, against the actual API — outside of CI — then replay that exact recorded JSON through a test double standing in for the Anthropic client) combined with a mocked n8n (existing `msw`-based convention, matching `tests/unit/client-*.test.ts`'s naming pattern). This exercises Kairos's real parsing/validation/bundling logic against a fixed, known LLM output — deterministic, free, and fast. At minimum: one pack with a webhook-triggered workflow, one with none. If Step 1 surfaced specific failure-prone rules/node types, add a third fixture exercising them.
- Assert semantically: `finalIssues` (on `BuildResult`) contains no `severity: 'error'` entries; expected node types are present (`workflow.nodes.some(n => n.type === '...')`); `credentialsNeeded` matches expected services; `PackValidationIssue[]` is empty or matches an expected small set; the webhook path extracted via the existing `findWebhookTrigger()` utility (`src/utils/webhook-verify.ts`) matches an expected value.
- Explicitly do **not** assert on: full node array structure, node/workflow IDs, `builtAt` or other timestamps, prose summary wording.
- Add a no-network guard in `vitest.config.ts` (or a global test setup) that fails loudly if any test — including these new fixtures — attempts a real HTTP call to any host not explicitly intercepted by `msw` or the Anthropic stub. This guard is what actually enforces "no live Anthropic calls," not just a written intention.
- **Benchmark baseline (manual, optional, never required-CI):** Snapshot per-prompt pass/fail plus key metrics (attempt count, error-severity rule count) from a real, human-triggered `scripts/benchmark.ts` run into a checked-in baseline JSON (extending the existing `benchmark-*-results.json` convention already in the repo root). Add a narrow comparison script that a developer runs locally (or an optional, manually-dispatched CI workflow — never a required-per-PR gate) to check a fresh benchmark run against the baseline and flag regressions. Updating the baseline is a deliberate, explicit action a person takes after reviewing a real run, not something CI does automatically.

**Where:** `tests/` (new fixture files + a new Anthropic-response-stub helper), `scripts/benchmark.ts` + new baseline JSON + a separate, optional comparison script, the CI workflow file that runs tests (required-CI only runs the offline fixtures), `vitest.config.ts`.

**Reasoning:** The existing 1,152 tests already cover individual pieces well (confirmed file names: `client-memory-wiring.test.ts`, `client-deploy-activation.test.ts`, `client-webhook-verification.test.ts`, `client-parse-failure-telemetry.test.ts`). What's missing is an end-to-end "does the whole pack→bundle→preflight shape still hold" check. Semantic assertions are strict enough to catch real regressions and loose enough not to need updating on every non-semantic diff. Keeping the benchmark (a live-model quality measurement) separate from the golden fixtures (a deterministic logic-correctness check) respects that these answer genuinely different questions — conflating them would either make required CI flaky and expensive, or dilute the benchmark into something that has to be deterministic and therefore can't actually measure real model behavior.

**Process:**
1. From Step 1's note, pick 2–3 representative business-context prompts.
2. Run each **once, by hand, outside of CI**, against the real `plan()`/`build()` path with a mocked n8n, to capture a real LLM response; save that response as a recorded fixture (check `tests/fixtures/` for an existing LLM-response-recording convention before inventing a new one).
3. Write a small Anthropic-client stub/double that returns the recorded response deterministically when invoked with the matching prompt; wire the golden-fixture tests to use it instead of a real `Anthropic` instance.
4. Write one assertion file per fixture using only the semantic properties above, run entirely offline.
5. Add/verify the no-network guard; run the full suite to confirm nothing — including the new fixtures — silently depends on live network.
6. Separately, run a real `scripts/benchmark.ts` pass by hand to generate the initial baseline JSON; commit it as a distinct, manual artifact.
7. Wire CI to run only the offline golden fixtures as a required step. The benchmark comparison script is available to run locally or via manual dispatch, never as a required gate.

**Guardrails:**
- Required CI must never make a live call to Anthropic or any real n8n host — the no-network guard is what enforces this, not a naming convention.
- Never assert on anything that legitimately changes non-semantically.
- Keep the baseline-diff mechanism narrow — pass/fail plus error-count delta, not a metrics dashboard.
- If a fixture needs updating because behavior intentionally changed (e.g., after a Step 4 fix), update it explicitly in that same commit with a one-line reason.
- The benchmark baseline is a manual artifact — never auto-refreshed by CI, since that would silently launder a regression into the new "expected" baseline.

**What to avoid:** Full JSON snapshot testing. Building a general eval-scoring product (LangSmith-style) — this is a regression guard, not a quality-scoring system, consistent with Kairos's existing "validation-first, not eval-first" stance. Trying to cover every node type in fixtures — 2–3 representative packs is the right size now. Wiring the live-model benchmark into required CI under any framing ("just for important PRs," "only weekly") — it stays a deliberate, human-triggered action.

**Outcome / Definition of done:** 2–3 golden fixtures with semantic assertions pass in required CI with zero live network calls of any kind (verified by the no-network guard actually catching a deliberately-introduced stray call during testing of the guard itself); a benchmark baseline JSON exists as a separate, manually-maintained artifact with a comparison script available but not CI-required; full suite green; typecheck/lint clean.

**Anything else:** These fixtures double as a live, executable spec of "what correct output looks like" — useful independent of their regression-catching purpose. The recorded-LLM-response approach also means the golden fixtures will keep passing even during a temporary Anthropic API outage or key rotation — a small, incidental reliability win for the CI pipeline generally.

---

## 5. Step 3 — n8n ground-truth audit (consolidated, automated as a parity check)

**What:** One consolidated audit comparing four specific Kairos assumptions against n8n's verified real behavior:
- **(a)** Rule 58 (`src/validation/validator.ts`, ~line 1732) assumes one expected credential key per node type.
- **(b)** `src/validation/node-syncer.ts` captures only `node.credentials?.[0]?.name` when merging live n8n node info, discarding any additional credential options a node declares.
- **(c)** `src/validation/registry.ts`'s static `requiredParams`/`credentialType` fields don't account for n8n's `displayOptions`-conditional visibility (a credential/param required only under a specific `resource`/`operation` selection).
- **(d)** `scripts/generate-node-catalog.ts`'s choice of default `typeVersion` — verified target: n8n's actual `defaultVersion ?? max(nodeVersions keys)`, not simply "highest version found" — plus a parameter-rename sweep across each covered node's `V1/V2/V3` folder variants (the exact class that produced Rules 56, 57, and 130).

**Why — verified, not assumed:** n8n's own `packages/workflow/src/node-validation.ts` line 27 reads `const shouldDisplay = displayParameter(node.parameters, credDesc, node, nodeType.description)` before ever flagging a credential as required — confirmed by direct read of n8n's source. `displayParameter` is confirmed exported from `packages/workflow/src/node-helpers.ts` (`export function displayParameter`, line 413) and re-exported from the package's `index.ts` (`export * from './node-helpers'`). This means n8n itself will not require a credential/param currently hidden by the node's resource/operation selection — while Kairos's registry and Rule 58 have no equivalent conditional check today. This is the highest confidence-per-hour item in the plan: the same method (compare Kairos's assumption to n8n's real source) already produced three confirmed fixes (Rules 56, 57, 128/130).

**When:** Now, immediately after Step 2's safety net exists, consolidated into one pass (all four sub-items touch the same file cluster and use the same verification method).

**How:**
- Pick a 5–10-node working set from what Kairos's registry actually covers, biased toward nodes known to have resource/operation-conditional credentials or params (HTTP Request's auth modes, Google Sheets' auth types, Slack's per-operation scopes are plausible starting points — confirm against the real `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` devDependencies already pinned in Kairos's `package.json`).
- For each: write a failing fixture first, encoding a resource/operation configuration where n8n's real `displayParameter()` logic and Kairos's current validator/registry disagree.
- For node-syncer: find a node type whose n8n API response declares 2+ credential options; confirm the merge currently drops all but the first.
- For typeVersion default: for each versioned node in the set, read `INodeTypeDescription.defaultVersion` directly from the real n8n package source and compare against what the catalog generator currently selects.
- For the rename sweep: diff parameter names declared across each node's `V1/V2/V3` folder variants against the version Kairos's catalog currently represents.
- Turn the whole thing into a re-runnable script (e.g. `scripts/audit-node-catalog-parity.ts`) rather than a one-time pass, so it can rerun whenever the catalog regenerates against a bumped `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` version — flagging parameter-name diffs and default-version mismatches as **warnings for human review**, not auto-applied fixes.

**Where:** `src/validation/validator.ts`, `src/validation/node-syncer.ts`, `src/validation/registry.ts`, `scripts/generate-node-catalog.ts`, new `scripts/audit-node-catalog-parity.ts`, the pinned `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` devDependencies as ground truth, n8n's `packages/workflow/src/node-helpers.ts` + `node-validation.ts` as read-only reference (not imported — see Step 4).

**Reasoning:** Scoping to nodes Kairos actually catalogs (not all ~439 in `n8n-nodes-base`) is the right size — auditing everything "in one sitting" is unrealistic; auditing the ~30–60 types Kairos's registry contains, biased toward known conditional shapes, is tractable and covers the real risk surface. A re-runnable script matters because n8n ships node version bumps regularly — a bug fixed today (as Rules 56/57/130 were) can reappear silently the next time a node version changes, and only a re-runnable check catches that at catalog-generation time instead of waiting for the next client incident.

**Process:**
1. Enumerate registry entries with any `credentialType`/`requiredParams` value.
2. Cross-reference against real n8n source to find which have `displayOptions`-conditional credentials/params — this is the working set.
3. Write repro fixtures per working-set node encoding the specific disagreement, **developed locally and not committed while red** (see Guardrails — this session's scratch workspace, or a local branch, not pushed until the corresponding fix lands).
4. Run fixtures; separate real bugs (fail) from already-correct behavior (pass — commit these immediately as permanent regression guards, since a passing test is always safe to commit).
5. Write and run the node-syncer multi-credential fixture under the same not-committed-while-red discipline.
6. Write and run `audit-node-catalog-parity.ts`; triage every finding into "real bug → Step 4" vs. "not currently exploitable, noted."
7. Compile a short written audit report (same format as Step 1's note) listing every confirmed defect (each with its uncommitted repro test kept locally, ready for Step 4), handed to Step 4.

**Guardrails:**
- Every claimed defect needs a reproducing test — a read-through observation isn't a finding.
- **Do not commit a failing test to the shared branch.** A repro for a confirmed bug is developed and run locally during this step, then either (a) committed together with its fix in Step 4 in the same commit, or (b) if it must be committed before a fix is ready for some reason, committed using the test framework's explicit skip/expected-fail marker (e.g. vitest's `.todo` or `.fails`) so CI stays green — never a bare failing test on a branch others might build on.
- Diagnose only in this step in terms of *what gets fixed*; do not ship fixes yet (keeps the commit history honest about found-vs-changed) — but do not leave the shared branch red while diagnosing.
- The parity script produces warnings for human review, never auto-applies rule changes.
- **Stop-and-report threshold:** if this audit surfaces so many confirmed `displayOptions`-conditional mismatches, or mismatches so broad in pattern, that fixing them one narrow rule at a time would mean touching double-digit call sites, **stop before proceeding to Step 4's fixes.** Write up exactly what pattern connects the findings and how many there are, and treat "import n8n's general resolver" as its own new, separately-approved step — do not silently default to patching 20 narrow cases just because Step 4 is next in the plan. See Step 4's "Anything else" for the full reasoning on this threshold.

**What to avoid:** Auditing all of n8n — scope to Kairos's registry. Importing `displayParameter()`/`checkConditions()` as a general resolver during this step — that decision stays separately gated (Step 4). Committing any test that is currently red without an explicit skip/expected-fail marker.

**Outcome / Definition of done:** A written audit report listing every confirmed defect with a reproducing test (developed locally, not sitting red on the shared branch); `audit-node-catalog-parity.ts` exists and runs against the current catalog; every confirmed defect is queued for Step 4; if the stop-and-report threshold above was hit, that is documented explicitly instead of proceeding into Step 4's narrow-fix mode.

**Anything else:** A clean audit (no confirmed defects) is a valid, valuable outcome — evidence the registry's assumptions currently hold, and it lowers urgency on ever importing the general resolver. The parity-check script has permanent value either way.

---

## 6. Step 4 — Fix confirmed defects (narrow rules); resolver import stays gated

**What:** For every defect Step 3 confirmed with a failing test, ship the narrowest fix that makes that fixture pass — a corrected constant, an added conditional, a new numbered validator rule, or a node-syncer change to retain all credential options instead of just the first. The general import of n8n's `displayParameter()`/`checkConditions()` as shared infrastructure is explicitly **not** part of this step.

**Why:** Confirmed reproducing bugs in the validator — Kairos's single most differentiated asset — should never sit unfixed. But there's a real, deliberate distinction between "patch the specific bug" and "adopt a general mechanism," already governed by a standing Kairos engineering policy (documented in project memory as `feedback_kairos_narrow_rules_over_resolver`): narrow, evidence-driven rules first; the general resolver only once narrow-patching itself becomes the bottleneck. Finding some bugs during an audit is not, by itself, evidence that the bottleneck has been reached — that requires evidence about bug *volume/rate*, not bug *existence*.

**When:** Now, immediately following Step 3, same short arc.

**How:**
- Rule 58 fixes: widen the expected-credential-key check to condition on the node's actual `resource`/`operation` parameter values, implemented as a targeted conditional at the existing call site (matching the existing `private warn(issues, rule, message, nodeId?, nodeType?)` signature) — not a rewrite of the rule's structure.
- Node-syncer fix: retain the full array of declared credential options (or as many as the `NodeDefinition` type can represent) instead of unconditionally taking `[0]`; only flag a single expected type when a node genuinely has one option.
- Registry fixes: correct the static value directly if it was simply wrong for the current default typeVersion; if the defect is genuinely resource/operation-conditional and a static field can't represent it, add a new narrowly-scoped validator rule (next available ID, with entries added to `rule-metadata.ts`'s `VALIDATOR_RULE_IDS` array and `RULE_PIPELINE_STAGES` map, matching the existing convention exactly — note the existing gaps at 64 and 104 are intentionally documented, follow that precedent for any newly-skipped IDs).
- Catalog fixes: correct `generate-node-catalog.ts`'s typeVersion-default selection or specific parameter entries directly.
- Each fix ships as its own commit matching its Step 3 fixture — no bundling.

**Where:** `src/validation/validator.ts`, `src/validation/node-syncer.ts`, `src/validation/registry.ts`, `src/validation/rule-metadata.ts` (if a new rule is added), `scripts/generate-node-catalog.ts`, `src/validation/node-catalog-generated.ts` (regenerated).

**Reasoning:** A narrow rule's blast radius is fully understood at review time — it only ever touches the case it was written for. A general resolver import changes behavior across every cataloged node, including ones nobody in Step 3 specifically audited — a much larger, less-reviewed surface change than what the audit's working set actually validated.

**Process:**
1. Take Step 3's report one confirmed defect at a time.
2. Write (if not already written) the minimal fix **together with its previously-uncommitted repro test in the same commit** — the repro that was red during Step 3's diagnosis becomes green and lands atomically with the fix that makes it green; the shared branch never sees that test in a failing state.
3. Run the fixture to green; run the full Step 2 safety-net suite; commit.
4. If a new rule is added, update `rule-metadata.ts` and any generated rule-reference docs.
5. Re-run Step 3's parity script once more after all fixes land, confirming a clean result against the working set.
6. Add a CHANGELOG entry per fix (root-caused, one line, matching Kairos's existing changelog discipline).

**Guardrails:**
- No fix touches code outside the specific rule/file it corrects — no "clean up while I'm here."
- Every fix's fixture becomes a permanent passing regression test, committed atomically with the fix, never deleted after confirming the fix works.
- No import of `displayParameter()`/`checkConditions()` under any framing in this step.
- **Re-affirm the stop-and-report threshold from Step 3 before starting this step's fixes:** if the audit report shows the defect count/pattern crossing into "double-digit call sites, same root shape," do not begin narrow-patching them one at a time — stop, and get explicit approval for a separate resolver-import step first. This is a hard gate, not a judgment call to make silently mid-fix.

**What to avoid:** Refactoring Rule 58's or the registry's overall shape while "in the neighborhood." Leaving any confirmed live-correctness defect unfixed and merely "filed." Patching a large, patterned set of narrow cases one-by-one without stopping to ask whether the resolver-import threshold has actually been crossed.

**Outcome / Definition of done:** Every Step 3 defect has a fix commit (fix + its test, landed together, never separately) with its fixture passing; the parity script shows clean against the working set; CHANGELOG updated; full suite (incl. Step 2's net) green; `displayParameter()` import remains untaken, its trigger documented (see Section 13).

**Anything else:** If Step 3's findings turn out so numerous or so varied that narrow-rule patching itself starts to feel unsustainable *during this step* — that observation **is** the trigger firing. Stop, document exactly what pattern connects the defects and how many there were, and treat "import the resolver" as its own new, separately-approved step rather than silently expanding this one. This is deliberately redundant with Step 3's own stop-and-report guardrail — the threshold matters enough to state twice, once at diagnosis and once at the point of actually writing the narrow fixes.

---

## 7. Step 5 — Artifact provenance stamps

**What:** Add a provenance tuple to every generated artifact — a deterministic workflow hash, Kairos package version, validator rule-set version, node-catalog version, prompt/template version, model name + key generation settings, and a run ID — stamped into `BundleManifest`, `PreflightResult`, and activation records.

**Why — verified absent:** `BundleManifest` (`src/pack/pack-bundle.ts`) is today exactly `{ generatedAt: string; packName: string; files: Array<{artifact, workflowName?, path, fetchedAt?}>; skipped: Array<{artifact, workflowName?, reason}> }` — no hash, no version, no model info. `BuildResult` (`src/types/result.ts`) has no hash or version fields either. Two basic questions — "did this workflow change since export?" and "was this built under today's rules or an older set?" — are currently unanswerable, and provenance only protects artifacts created *after* it ships, so every week of delay is permanently lost coverage.

**When:** Now, right after Step 4, and before Step 7/8 so chained-pack artifacts get provenance from day one.

**How:**
- Canonical hash: a deterministic serialization of `N8nWorkflow` covering **all three semantic fields, not just nodes/parameters** — `nodes` (sorted by a stable key, `id` or `name`; each node's `parameters` object keys recursively sorted), `connections` (the node-wiring graph — genuinely part of `N8nWorkflow`'s structure and just as semantically significant as node parameters; a workflow whose wiring changed but whose node list/parameters didn't must hash differently), and `settings` (workflow-level settings that affect behavior, e.g. error-workflow assignment, execution order) — strip anything already known to be non-semantic (server-assigned IDs, timestamps) — then SHA-256 the canonical string. Implement as a small pure function, e.g. `src/utils/workflow-hash.ts`, with unit tests for stability (reordered-but-identical input → same hash), sensitivity to node/parameter changes, **and sensitivity to connection-only changes** (same nodes, same parameters, different wiring → different hash — this specific case is the one a naive nodes-only hash would silently miss, so it gets its own explicit test).
- Version fields: **content-derived, not manually bumped.** A rule-set version computed as a hash (or stable digest) of `VALIDATOR_RULE_IDS` (or the full rule-metadata table) at runtime — this can never drift out of sync the way a "remember to bump this constant" convention eventually will, since it's simply whatever the current array's content actually is. A node-catalog version derived from the pinned `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` package versions already used to generate it (itself a form of content-derivation, since those come from `package.json`/`node_modules`, not a manually-tracked number). A prompt/template version derived from a hash of the actual prompt template content (`PLAN_PROMPT`, `prompts/v1.ts`) rather than a manually-incremented label someone has to remember to bump. If any of these three genuinely cannot be content-derived cheaply, the fallback is a CI check that fails when the underlying content changes without the version constant changing in the same diff — never silent manual discipline as the only safeguard.
- Model/settings: thread `this.model`, `maxTokens`, and other generation-relevant settings already present on the `Kairos`/`WorkflowDesigner` instance through to `BuildResult` and onward — no new capture logic, just wiring.
- Extend `BundleManifest` with a new `provenance` field; extend `PreflightResult` with a compatibility check comparing an older artifact's stamped versions against current ones, classified `clean` / `warn` / `needs-human` (a simple comparison, not a diff engine — matching Dify's `services/dsl_version.py` pattern studied in the research as the correctly-sized intermediate step, adapted freely rather than copied literally since Kairos isn't a DSL import/export system).

**Where:** New `src/utils/workflow-hash.ts` (+ tests), `src/pack/pack-bundle.ts` (`BundleManifest`, `writeBundle()`), `src/pack/preflight.ts` (`PreflightResult` + compatibility check), `src/types/result.ts` (`BuildResult`), a new small version-constant module, activation-recording code.

**Reasoning:** Highest value-per-line-of-code item in the plan — a handful of fields and one pure hashing function, against a compounding cost of every week without it. Deliberately not full version control — no diffing, no history storage, no rollback mechanic. Just "what was true when this was built," so a later comparison can classify drift without reopening the deliberately-deferred VCS/rollback decision.

**Process:**
1. Write `workflow-hash.ts` + stability/sensitivity/connection-sensitivity unit tests (three distinct test categories, not just "stability").
2. Define rule-set-version and prompt-version as content-derived hashes; confirm node-catalog-version can genuinely be read from the pinned devDependency versions.
3. Extend `BuildResult`/`BundleManifest`/`PreflightResult` additively (old persisted packs without these fields deserialize fine, treated as "provenance unknown").
4. Wire population at creation points (`writeBundle()`, `BuildResult` construction). Activation recording explicitly moved to Step 6b's `workflow_activated` event (see note below) — not implemented as part of this step.
5. Add the clean/warn/needs-human compatibility check to a `--bundle-dir`-style re-check.
6. Extend Step 2's fixtures to assert the new fields are present and correctly shaped, including a fixture asserting two workflows with identical nodes/parameters but different `connections` hash differently.

**Guardrails:**
- Additive-only; never make persisted-pack deserialization break.
- Compatibility classification stays a simple comparison — no diff view, changelog generator, or migration tool (that would reopen the deferred rollback decision through the back door).
- Model/settings capture must reflect what was **actually** used for that specific build, not a static global default — relevant the moment any per-workflow model override exists.
- No version field in this step relies solely on a human remembering to bump a constant — either it's derived from content, or a CI check catches drift between content and the constant.

**What to avoid:** Building a general "artifact versioning system." Retroactively backfilling provenance onto pre-existing packs — just mark them "provenance: unknown." Hashing only `nodes`/`parameters` and treating `connections`/`settings` as an afterthought — a wiring-only change must produce a different hash, or the hash isn't actually answering "did this workflow change."

**Outcome / Definition of done:** Every newly-generated manifest/preflight/activation record carries the full provenance tuple; hash function has passing stability, node/parameter-sensitivity, **and connection-sensitivity** tests; rule-set and prompt versions are content-derived (or CI-enforced, if content-derivation genuinely isn't feasible for one of them); compatibility check exists and is exercised by a Step 2 fixture; old artifacts still deserialize.

**Anything else:** This is the natural place to land the "restore candidate, not rollback" documentation correction in `handoff.md` — one paragraph, explicitly caveating that redeployment may still require re-wiring credentials, re-registering webhooks, or accounting for environment/n8n-version drift the JSON alone doesn't capture.

**Activation provenance — explicitly deferred to Step 6b, not silently dropped (Codex review, 2026-07-08):** the original draft of this step listed "activation records" as a fourth population point alongside `BuildResult`/`BundleManifest`/`PreflightResult`. It was not implemented here. Recording what was true at activation time (model/settings/hash-equivalent data, whether the activated workflow matches what was built) is a real, still-open need — but it belongs with Step 6b's `workflow_activated` event (§8), which already anticipated an activation event type before this note existed, rather than being bolted onto this step's four data structures after the fact. When Step 6b is picked up, its `workflow_activated` payload should carry the same provenance tuple shape (`BuildProvenance`/`BundleProvenance`, `src/types/result.ts` / `src/pack/pack-bundle.ts`) established here, not a new ad hoc shape.

---

## 8. Step 6 — Operation ledger: v0 now, full ledger deferred

**Corrected in this revision:** the original draft of this step bundled six new event types, a retention sweep, a CLI read-back surface, and the full finding-taxonomy adapter layer into one step sitting between provenance (Step 5) and chaining (Steps 7–8) — meaning chaining and, ultimately, Empire Homecare would wait on all of that landing first. That's disproportionate: none of it is a dependency chaining actually needs. This step is now split into a **v0** (small, done now, unblocking) and the **full ledger** (moved to a Later/Soon item that rides alongside or after Step 9, explicitly not gating Steps 7–10).

### Step 6a — Ledger v0 (now, minimal)

**What:** Widen `TelemetryEvent['eventType']` — verified today as exactly `'build_start' | 'generation_attempt' | 'build_complete'` in `src/telemetry/types.ts` — by exactly two new types: `bundle_exported` and `preflight_completed`. Call `emit()` from the two corresponding existing call sites. Nothing else.

**Why:** These two events are the ones most directly useful to have live before Step 9's real-flow checkpoint and Step 10's Empire Homecare engagement — "was this pack bundled, and what did preflight say" is the minimum operational visibility worth having during the first real engagement. Everything else (retention sweep, CLI read-back, workflow_activated/replaced/handoff/incident event types, finding-taxonomy adapters) is real and worth building, but not a blocker for anything above it in this plan.

**When:** Now, after Step 5 (so these two events can carry provenance fields), before Step 7/8.

**How:** Widen the `eventType` union; bump `TELEMETRY_SCHEMA_VERSION` from 2 to 3; add `BundleExportedData`/`PreflightCompletedData` payload interfaces following the existing `BuildStartData`-style pattern; add the two `emit()` calls at the end of `writeBundle()` (`pack-bundle.ts`) and the end of the preflight flow (`preflight.ts`).

**Guardrails:** No retention sweep, no CLI surface, no finding-taxonomy adapters, no additional event types in this sub-step — those are explicitly deferred, not silently expanded into. Keep this to the smallest possible diff that gets two real events flowing.

**What to avoid:** Treating this as "started, might as well finish the whole ledger while I'm in the file" — the whole point of splitting v0 out is that it does not grow into the full scope in this sitting.

**Outcome / Definition of done:** `bundle_exported` and `preflight_completed` events fire correctly, verified by a Step 2 fixture extension; nothing else about the telemetry system changed.

### Step 6b — Full ledger (deferred to Later/Soon, explicitly non-blocking)

**What (unchanged from the original design, just re-sequenced):** the remaining event types (`workflow_activated`, `workflow_replaced`, `handoff_generated`, `incident_recorded`), a retention sweep, a minimal CLI read-back surface, and the finding-taxonomy adapter layer (`UnifiedFinding` + `toUnifiedFinding()` mapping functions in `src/telemetry/finding-adapter.ts`) unifying `ValidationIssue` / `PackValidationIssue` (note the `'error'|'warning'` spelling drift from `ValidationIssue`'s `'error'|'warn'`) / `PreflightCheck` for ledger and future support-bundle consumption.

**`workflow_activated`'s payload explicitly carries activation provenance** (moved here from Step 5, see that section's note): the same `BuildProvenance`/`BundleProvenance` tuple shape (`kairosVersion`, `ruleSetVersion`, `promptTemplateVersion`/`promptProfile`, `nodeCatalogVersion`, and a `workflowHash` of the workflow as activated), so "was the workflow that got activated the same one Kairos built, or had it drifted first" is answerable the same way build-vs-live drift already is for bundles.

**When:** Soon — naturally after Step 9's checkpoint, whenever there's a real need for the additional event types (most likely once activation/replace/incident flows are actually exercised against a real client), not gated to land before Step 7/8/9/10.

**Reasoning:** Explicitly not a new logging system, not an event bus, not a delivery-state machine. An event bus implies pub/sub and multiple in-process consumers reacting in real time — none of which a single-operation CLI needs. A plain, wider log answers "what happened, when" without that machinery. If a genuine need for resumable multi-step state ever emerges (most likely once `kairos test pack` exists), that's a distinct, later, separately-gated decision. An adapter layer is strictly lower-risk than changing the three underlying finding types, since those are consumed in multiple rendering paths (`risk-report.md`, `handoff.md`, CLI output) that would all need re-verification if their shape changed.

**Guardrails:**
- Keep the eventual full event taxonomy small (~6–8 types total, including v0's two), each corresponding to a real already-identified operational question, not granular internal steps.
- No pub/sub, no in-process consumers reacting to events, no retry/dead-letter semantics.
- Do not change `ValidationIssue`, `PackValidationIssue`, or `PreflightCheck` themselves — only add mapping functions that read them.
- Retention sweep must be idempotent and safe to run repeatedly.

**What to avoid:** A delivery-state machine or resumable-operations tracker (later, gated on real multi-step live-operation pain). Hosted/remote telemetry. A fourth finding shape beyond `UnifiedFinding`. A "breaking type replacement" refactor across validator/pack-validator/preflight. Treating this as blocking anything in Steps 7–10 — it explicitly does not.

**Outcome / Definition of done:** Full event taxonomy, retention sweep, CLI read-back, and finding-taxonomy adapters land whenever picked up, independent of the chaining/checkpoint/Empire-Homecare sequence above.

---

## 9. Step 7 — Pack-builder output chaining: DESIGN (locked, v4)

**What:** Design only — implementation is Step 8 — a small, typed, structured mechanism by which workflow *N*'s `build()` call in a pack receives specific prior workflows' actual built outputs, not just the shared upfront plan.

**⚠️ v2 correction (unchanged from before):** Both prior research syntheses assumed `pack-wirer.ts` already provided a "wiring graph" this mechanism could plug into. **That is false.** `src/pack/pack-wirer.ts` (297 lines) is entirely about post-deploy Google Sheets document-ID patching — there is no concept anywhere in it of one workflow depending on another. `WorkflowPlan` is exactly `{ name, description, purpose }`, and `PackPlan.workflows` is a flat array with no dependency field. The design must add a dependency-declaration mechanism to the plan step itself.

**⚠️ v3 correction (kept) — failure semantics tightened, superseding v2's softer language:** v2 designed every validation failure (unknown dependency, cycle) as *graceful degradation*: surface a warning, build the workflow anyway without that one chain. A review round asked for stricter, explicit guarantees: **(a)** unknown/self/cyclic dependency declarations must be *rejected before any generation spend*, not merely warned about while still building; **(b)** a downstream workflow must not build or activate when a *validly-declared* dependency's reference is genuinely unavailable (the upstream build failed), not just chained without it; **(c)** dry-run packs must not trip that same gate. A refinement found while locking v3: duplicate dependencies are detected and deduped, not rejected — the other three are rejected.

**⚠️ v4 correction (this revision) — six further gaps found by a second review, all before any Step 8 code:**
1. **Ambiguous name resolution.** v3 never specified what happens when a `dependsOn` name matches *more than one* workflow in the plan (two workflows can share a display name even though they get distinct `workflowKey`s via the dedup-suffix scheme). Silently picking the first match would be exactly the kind of silent mis-wiring this whole design exists to prevent. New `ambiguous_dependency` rejection category, §3.
2. **Malformed vs. missing `dependsOn`.** v3's "Anything else" note said the new field needs `normalizeAssumptions()`-style tolerance without distinguishing *missing* (→ `[]`, correct, backward-compatible) from *present but malformed* (a string, a number, an array of non-strings — signals the LLM tried to declare a dependency and the shape broke). Silently coercing the latter to `[]` discards a real signal with zero trace. New `malformed_dependency` rejection category, §3.
3. **`resolveBuildOrder()`'s own return shape was internally incoherent.** v3 said `order` contains "every workflow, rejected ones too" — but a topological sort is mathematically undefined over a graph containing a cycle; a rejected/cyclic workflow cannot meaningfully occupy a position in a topological order. Fixed in §3: `order` now contains only the valid, already-resolved DAG; every rejected workflow is excluded from sorting entirely and pre-seeded as `'unavailable'` in §7's availability map before the build loop starts.
4. **Result-array ordering was never specified.** Building in topological order (§3, unchanged) says nothing about what order the *returned* `PackWorkflowResult[]` should be in. Left unstated, the natural implementation would return build-completion order, silently changing `pack.workflows[i]`'s correspondence to `plan.workflows[i]` for any pack that declares a dependency — breaking any existing consumer (CLI progress index, `onProgress`, `handoff.md`/`credentials.md` rendering order) that assumes plan order. New §11: execution order and result order are explicitly decoupled.
5. **The dependency graph was designed to disappear after building.** Nothing in v3 persisted `workflowKey`/`dependsOn` onto `PackWorkflowResult` — the one artifact that actually gets saved to `~/.kairos/packs/<name>.json` and read back later (by `preflight`, `pack export`, any future re-validation). New §12: both persisted, optional, additive.
6. **`webhookUrl` construction would have duplicated existing logic.** v3's §5 said "constructed as the base URL plus n8n's real webhook-path convention" without saying how — implying a second implementation of URL-joining next to the one that already exists in `N8nApiClient.triggerWebhookProduction()` (confirmed: `${baseUrl.replace(/\/$/, '')}/webhook${cleanPath}`, with `cleanPath` ensuring a leading slash). New §5 amendment: extract that exact logic into one shared function, used by both.

All six are locked below. This is exactly what a design-lock step exists to find before Step 8 starts, not after persisted pack shapes and execution ordering have already shipped.

**Why:** This is the one verified architecture-level defect in Kairos's core generation loop. `pack-builder.ts`'s build loop (lines ~244–283) calls `await this.kairos.build(wf.description, { name, dryRun, activate })` per workflow in sequence, with no channel for a prior workflow's actual output to reach a later one's prompt. It sits exactly on the path Kairos's actual business (Empire Homecare, and the earlier Cartlio test) walks: multi-workflow packs where a later workflow needs to reference something a specific earlier workflow concretely produced (e.g., a confirmation email needing the intake webhook's real path), not what the plan merely predicted.

**When:** Design now, as its own step, deliberately separated from implementation (Step 8) given this is the most architecturally consequential item in the plan. **This step produces no code.**

**Confirmed before writing v3:** `PackBuilder.build(plan, options)`'s `dryRun`/`activate` are pack-wide, applied identically to every workflow in the loop (`src/pack/pack-builder.ts` lines ~209–219) — no existing per-workflow dry-run mixing.

**Confirmed before writing v4:** `N8nApiClient.triggerWebhookProduction()` (`src/providers/n8n/api-client.ts` line ~243) already builds exactly the URL a `webhookUrl` field needs: `const cleanPath = path.startsWith('/') ? path : \`/${path}\`; const url = \`${this.baseUrl.replace(/\\/$/, '')}/webhook${cleanPath}\``. This must be extracted into a shared, standalone function, not reimplemented.

**How — the design must answer precisely:**

### 1. How are workflows keyed? (locked, unchanged from v2/v3)

Joining on raw display `name` is fragile (two workflows can have similar, whitespace-different, or literally duplicate names — the plan prompt doesn't enforce uniqueness). Assign every `WorkflowPlan` entry a stable `workflowKey` at plan-normalization time, derived via the **already-existing** `slugifyWorkflowName(name: string): string` (exported from `src/pack/pack-bundle.ts` — reuse directly, don't duplicate), with a numeric suffix appended (`-2`, `-3`, ...) if two workflows in the same plan would slug to the same key. `dependsOn` references other workflows by `workflowKey`, never by raw display name, at every layer of this design.

### 2. How are dependencies declared? (locked, unchanged from v2/v3; malformed-input handling moved to §3)

Extend `WorkflowPlan` with an optional `dependsOn?: string[]`. Extend `PLAN_PROMPT` to explicitly ask the planning LLM to declare, per workflow, which other workflows it needs to reference, with a worked example matching the prompt's existing per-field style. The model naturally thinks in workflow *names*, not slugs it's never told about — so the prompt asks for `dependsOn` as names, resolved to `workflowKey`s during the same normalization pass that assigns keys. The LLM never computes or reasons about slugs. **What "resolved" means when a name matches zero, one, or more than one workflow is now precisely specified in §3, not left implicit.**

### 3. Dependency-graph validation — a deterministic multi-pass pipeline, REJECTED before generation spend where structural, DEDUPED where merely redundant (v4: six categories, ordering fixed)

After `plan()` returns and workflows/keys are assigned, validate and resolve `dependsOn` in this exact order — each pass operates only on what the previous pass left as still-candidate, so the categories can never silently interact in an unspecified way:

**Pass 1 — shape check (new in v4, resolves gap 2):** for each workflow, is `dependsOn` present at all?
- **Absent** (`undefined`, the field never appears): treated as `[]`. This is the *only* case that becomes an empty dependency set — the backward-compatibility guarantee (§10) rests on this exact case, not on "anything that isn't a clean array."
- **Present but malformed** (not an array, or an array containing a non-string element): **rejected** as `malformed_dependency` — surfaced with the actual malformed value in the rejection detail, never silently coerced to `[]`. A malformed-but-present value is evidence the LLM *attempted* to declare a dependency; discarding it silently would hide that attempt entirely rather than surface it.
- **Present and a valid `string[]`** (including `[]` itself, explicitly declared): proceeds to Pass 2.

**Pass 2 — name resolution (new in v4, resolves gap 1):** for each name in a workflow's (validly-shaped) `dependsOn`, resolve it against every other workflow's `name` in the plan:
- **Zero matches:** **rejected** as `unknown_dependency` (v3's category, unchanged).
- **Exactly one match:** resolves cleanly to that workflow's `workflowKey`.
- **Two or more matches** (two workflows in the plan share that exact display name): **rejected** as `ambiguous_dependency` — never silently resolved to "the first match" or "the first-declared workflow." This is a distinct failure from "unknown" (the name exists, just not uniquely) and gets its own label so a human reading the rejection reason isn't left guessing which of the two problems occurred.

A workflow rejected in Pass 1 or Pass 2 is finalized as rejected right there and takes no further part in Passes 3–5.

**Pass 3 — dedup (v3's category, unchanged in effect, now explicitly *after* resolution):** for workflows that passed Passes 1–2, dedupe their now-fully-resolved `workflowKey` lists. A repeated key **is not a rejection** — deduping produces a perfectly valid, buildable edge set. Recorded in `deduped` as an advisory (surfaced, never silently dropped), the workflow proceeds to Pass 4 with the deduplicated set.

**Pass 4 — self-dependency (v3's category, unchanged):** does a workflow's deduplicated key list contain its own `workflowKey`? **Rejected** as `self_dependency` — the degenerate 1-node cycle, called out as its own explicit category and test case (not silently subsumed under Pass 5's general cycle check) since self-loops are a classic off-by-one source in naive graph code.

**Pass 5 — cycle detection (v3's category, unchanged; ordering bug fixed):** build a graph from every workflow that survived Passes 1–4, and run standard DFS-based cycle detection **over that candidate graph only**. Every workflow found to participate in a cycle is **rejected** as `cycle` (with the rejection detail naming every workflow in that specific cycle) and **removed from the candidate set** — it does not proceed to Pass 6.

**Pass 6 — topological sort (v3, ordering bug fixed):** the *remaining* candidate set — by construction acyclic, since every cyclic member was removed in Pass 5 — is topologically sorted. **This is the only set that ever gets a topological position.** A rejected workflow, from any pass, never appears in `order`; it exists only as an entry in `rejected`.

```ts
type DependencyRejectionReason = 'malformed_dependency' | 'unknown_dependency' | 'ambiguous_dependency' | 'self_dependency' | 'cycle'

interface DependencyRejection {
  reason: DependencyRejectionReason
  detail: string // e.g. the malformed raw value, the unresolved name, the 2+ matching workflowKeys, or the full cycle's workflowKeys
}

function resolveBuildOrder(workflows: WorkflowPlan[]): {
  order: WorkflowPlan[] // topologically sorted; ONLY non-rejected workflows -- never a cyclic/rejected one
  rejected: Map<string, DependencyRejection[]> // workflowKey -> why (malformed/unknown/ambiguous/self/cycle)
  deduped: Map<string, string[]> // workflowKey -> the duplicate keys that were collapsed (advisory only, never blocks)
  resolvedDependsOn: Map<string, string[]> // workflowKey -> final, resolved+deduped dependency keys (§12 needs this for persistence)
}
```

**Rejection semantics (v3, restated precisely):** a workflow rejected in Passes 1, 2, 4, or 5 does not build, and does not spend a single generation token — it gets a `PackWorkflowResult` with `error` set (reusing the exact shape already used for a thrown build exception), `deployed: false`, `workflowId: null`. **Scoped to that one workflow, not the whole pack** — the plan-level `TypedAssumption`/`EscalationInfo` channel is **not** used, since that channel is pack-wide/all-or-nothing and this rejection is deliberately per-workflow. **Every rejected workflow, across all five rejection categories, is pre-seeded as `'unavailable'` in §7's availability map before the build loop begins** — not discovered lazily as the loop reaches it, so a downstream workflow's dependency lookup never races a not-yet-processed rejection.

**Forward dependency (the ordering problem, unchanged from v2/v3):** since a workflow can only chain from something already built, **do not build in the LLM's listed plan order** — build in `order` (Pass 6's topological sort) instead. A workflow that depends on another always builds after it, regardless of which order the plan happened to list them in.

### 4. What does a "prior output" contain? (locked, unchanged from v3)

```ts
interface WorkflowReference {
  workflowKey: string
  workflowName: string
  /** True only when this workflow was actually deployed to n8n (dryRun: false at build
   * time) -- see §8. When false, workflowId/webhookUrl are always null/absent; this is the
   * field that distinguishes "never deployed" (fine, expected in a dry-run pack) from
   * "build failed" (blocks downstream, see §7). */
  deployed: boolean
  workflowId: string | null
  httpMethod?: string
  webhookPath?: string
  webhookUrl?: string
  nodeNames: string[]
  credentialsUsed: string[]
}
```

Populate `httpMethod`/`webhookPath` via the **already-existing** `findWebhookTrigger(workflow): { path: string; httpMethod: string } | null` in `src/utils/webhook-verify.ts` — no new extraction logic. `nodeNames` from `workflow.nodes.map(n => n.name)`. `credentialsUsed` from each node's `credentials` keys on `BuildResult.workflow`. `deployed` from `!result.dryRun` (the same expression `pack-builder.ts` already uses for `PackWorkflowResult.deployed`).

Every one of these fields is derivable from the upstream workflow's **already-generated JSON and build metadata alone** — none require the workflow to have been deployed except `workflowId`/`webhookUrl`, which is exactly why those two (and only those two) are gated by `deployed`.

### 5. The method/path/full-URL distinction, and one shared URL builder (locked from v3; v4 adds the shared-builder requirement)

`webhookPath` (e.g. `"/intake"`) is a relative path fragment, never a dereferenceable URL on its own. `webhookUrl` (a complete, callable URL) may only be populated when `N8N_BASE_URL` is actually known/configured at build time — **never fabricated or guessed when the base URL is unknown**.

**v4 addition:** `webhookUrl` must be constructed by calling the **exact same logic** `N8nApiClient.triggerWebhookProduction()` already uses, extracted into one small shared pure function — e.g. `buildWebhookUrl(baseUrl: string, path: string): string` in a new small utility module — called from both `triggerWebhookProduction()` and `toWorkflowReference()`. Not reimplemented, not approximated: the same trailing-slash-stripping, same leading-slash-ensuring, same `/webhook` segment. Two independent implementations of the same URL-join is exactly the kind of duplication that silently drifts apart over time (e.g. one gets a query-string edge case fixed, the other doesn't).

The prompt-builder rendering (§6) must render these as clearly distinct labeled fields — "HTTP method," "webhook path (relative)," and, only when present, "full webhook URL" — so the model is never left to infer which kind of reference it's looking at.

### 6. How does it reach the next `build()` call? (locked, unchanged from v2/v3)

Extend `BuildOptions` (currently `{ dryRun?, activate?, name?, smokeTest? }`) with `priorContext?: WorkflowReference[]`. Extend `src/generation/prompt-builder.ts` to render these as a small, clearly-labeled, deterministic section (e.g. "Related workflows already built in this pack: ...") with method/path/URL rendered as separately labeled lines, and `deployed: false` entries rendered with an explicit "(not yet deployed — path/method only, no live URL)" caveat rather than silently omitting the field. Never a free-form LLM-summarized version — the next generation call sees exactly and only what was structurally extracted.

### 7. Reference availability gating — build-time, distinct from §3's plan-time rejection (locked from v3; v4 changes only when the map is seeded)

§3 rejects a *declaration* before any building starts (free, offline, no generation spend at risk by construction). This section is about a **different failure window**: a dependency that passed §3 validation (a real, unambiguous, non-cyclic `workflowKey`) whose upstream workflow's *actual build* then fails for an unrelated reason — a real `Kairos.build()` exception. This can only be known after building has started, so it cannot be caught by §3's offline validation.

**v4 semantics (ordering fixed per gap 3):** initialize a `Map<string, WorkflowReference | 'unavailable'>` keyed by `workflowKey`, **pre-seeding every rejected workflow (§3's `rejected` map, all five categories) as `'unavailable'` before the build loop starts** — not lazily discovered as the loop reaches a rejected key, since §3's `order` never contains rejected workflows for the loop to "reach" in the first place. Then, building in `order` (§3 Pass 6), after each workflow builds or throws, record its outcome (a real `WorkflowReference`, or `'unavailable'` if it threw). Before building the next workflow in `order`:

- Look up each of its resolved `dependsOn` keys (§3's `resolvedDependsOn`).
- If **every** dependency resolved to a real `WorkflowReference`, build normally with `priorContext` populated.
- If **any** dependency resolved to `'unavailable'` (whether pre-seeded-rejected or build-failed), **do not build this workflow at all** — no generation spend, `PackWorkflowResult.error` set naming which upstream dependency was unavailable and why, `deployed: false`. This **cascades**: if C depends on B depends on A, and A fails (or was rejected), B is marked unavailable too (never attempted), and C sees B as unavailable and is never attempted either.
- This never hard-fails the *whole pack* — an unrelated workflow with no path back to the failure builds normally.

**The critical distinction this section exists to make explicit:** `deployed: false` (dry-run, §4) is **not** the same condition as `'unavailable'` (§7). A dry-run upstream workflow is fully available for chaining — its `WorkflowReference` exists, `deployed` is honestly `false`, and downstream workflows build against it normally (§8). Only a §3-rejected or build-failed upstream workflow counts as `'unavailable'`.

### 8. Dry-run chaining reports unresolved deploy-time references honestly, never blocks on them (locked, unchanged from v3)

Since `dryRun` is pack-wide, a dry-run pack means every workflow's `WorkflowReference.deployed` is `false` and every `workflowId`/`webhookUrl` is null/absent throughout the whole chain — expected, not a failure, and §7's gate must never trigger on it. What a dry-run pack *does* get, fully populated: `workflowKey`, `workflowName`, `httpMethod`, `webhookPath`, `nodeNames`, `credentialsUsed`. Net effect: full **content-level** chaining with **zero deploy-time** data — an honest, useful degradation, not a blocked one.

### 9. Token-budget guardrail (locked, unchanged from v2/v3)

Cap `priorContext` to directly-declared dependencies only (no transitive chains in v1 — §7's cascade is about *which workflows get blocked*, not about injecting transitive context into a prompt). Keep each `WorkflowReference`'s rendered form compact — node *names*, not node objects; path/URL strings, not the trigger node object. Never inline a full `N8nWorkflow` JSON object into a subsequent prompt.

### 10. Backward compatibility (locked, unchanged from v2/v3; now precisely scoped by §3 Pass 1)

A plan whose workflows all have `dependsOn` **absent** (not present-and-empty, not present-and-malformed — genuinely absent, per §3 Pass 1) produces an empty dependency graph: `resolveBuildOrder()` returns the plan's own order (trivially, since an empty graph's topological sort is just insertion order), no workflow is ever rejected or gated, `priorContext` is never populated, and the rendered prompt has no new section. Same prompt, same cost, same output, same build order as today.

### 11. Result-array ordering is decoupled from execution order (new in v4, resolves gap 4)

Execution uses `order` (§3 Pass 6's topological sort) — a workflow physically cannot be built before its dependencies. But the **returned** `WorkflowPackResult.workflows` array must preserve the **original plan order** (`plan.workflows`'s index order, exactly as the LLM returned it and exactly as every pre-chaining pack has always returned it), regardless of what order building or rejection actually happened in.

Mechanism: the build loop accumulates every outcome (built, rejected, cascaded-unavailable) into a `Map<string, PackWorkflowResult>` keyed by `workflowKey` as it goes, using `order` for the *iteration/execution* sequence. Only after every workflow has been processed does the loop assemble the final array — by iterating `plan.workflows` in its **original** order and looking up each one's result from the map. `pack.workflows[i]` always corresponds to `plan.workflows[i]`, for every pack, whether or not it declares dependencies, and whether or not any workflow was rejected — existing consumers (CLI progress index, `onProgress`, `handoff.md`/`credentials.md` rendering order) see no change in the shape of what they already rely on.

### 12. The dependency graph is persisted, not just used and discarded (new in v4, resolves gap 5)

Extend `PackWorkflowResult` with two new optional fields, populated by the build loop for **every** workflow (built or rejected — both cases have a `workflowKey`; rejected workflows may have an empty or partial `resolvedDependsOn` depending on which pass rejected them):

```ts
interface PackWorkflowResult {
  // ...existing fields unchanged...
  workflowKey?: string
  /** Resolved, deduplicated dependency keys (from resolveBuildOrder()'s resolvedDependsOn) --
   * not the raw LLM-provided names. Absent on packs persisted before this field existed, and
   * on workflows built before chaining existed at all. */
  dependsOn?: string[]
}
```

Both optional, additive — a pre-chaining persisted pack (`~/.kairos/packs/<name>.json`) deserializes exactly as before, no fields required. Without this, the dependency topology that `resolveBuildOrder()` computed exists only transiently in memory during one `build()` call — a later `kairos preflight`, `kairos pack export`, or any future re-validation tool reading the persisted pack JSON would have no way to know the graph ever existed.

**Where (design touches, implemented in Step 8):** `src/pack/pack-builder.ts` (`WorkflowPlan` + `workflowKey` assignment, `PLAN_PROMPT`, `PackWorkflowResult` extended per §12, the build loop reordered by `order` and gated per §7, result array reassembled per §11), `src/types/options.ts` (`BuildOptions`), `src/generation/prompt-builder.ts` (rendering), new `src/pack/workflow-reference.ts` (the `WorkflowReference` type + a pure `toWorkflowReference(result: BuildResult, n8nBaseUrl?: string): WorkflowReference` reusing `findWebhookTrigger()` and the new shared `buildWebhookUrl()`), new `src/utils/webhook-url.ts` (the shared `buildWebhookUrl()`, extracted from `N8nApiClient.triggerWebhookProduction()` — that method updated to call it too, not just the new code), new `src/pack/dependency-graph.ts` (the `resolveBuildOrder()` pure function, six-pass pipeline), `src/pack/pack-bundle.ts` (import site of the existing `slugifyWorkflowName`).

**Reasoning:** The earlier assumption that a wiring graph already existed would have led straight to a design bug if implementation had started from it. Rejecting invalid declarations before generation spend means a hallucinated, ambiguous, or malformed dependency costs nothing and fails loudly and specifically. Cascading unavailability (§7) exists because chaining is only safe if a downstream workflow's assumptions about an upstream reference are actually true. The dry-run/unavailable distinction (§§4, 7, 8) exists because those two conditions look superficially similar but mean opposite things for whether downstream building should proceed. §3's six-pass ordering (shape → name resolution → dedup → self → cycle → sort) exists because these checks are not independent — resolving a name before deduping it, deduping before checking self-dependency, and excluding rejected/cyclic workflows before the topological sort are all necessary for the pipeline to be well-defined rather than order-dependent-by-accident. §11 and §12 exist because a design that gets the *validation* right but silently reorders results or discards the graph after one use would still ship two real regressions — just later and harder to attribute, once packs and consumers depend on the old (undocumented, accidental) behavior.

**Process:**
1. Draft `buildWebhookUrl()` (extracted from `N8nApiClient.triggerWebhookProduction()`) + unit tests (trailing slash on base, leading slash on path, both, neither) — land this before `toWorkflowReference()`, which depends on it. Update `triggerWebhookProduction()` to call it, confirming its own existing tests still pass unchanged.
2. Draft `WorkflowReference` (with `deployed` + method/path/URL fields, URL via step 1's builder) + `toWorkflowReference()`; unit tests: `webhookUrl` absent when no base URL supplied; present and correctly constructed (matching step 1's builder exactly) when one is; `deployed: false` with `workflowId`/`webhookUrl` both absent for a dry-run `BuildResult`; `deployed: true` with both populated for a deployed one.
3. Draft `resolveBuildOrder()`'s six-pass pipeline with unit tests covering, at minimum: no dependencies (trivial order, nothing rejected); a simple valid chain; a forward-declared-in-plan-but-resolvable dependency (confirms reordering); an unknown-dependency case; an ambiguous-dependency case (two workflows sharing a name, a third depending on that name); a malformed-dependency case (a string instead of an array; an array containing a number); a self-dependency case; a cycle case (2-workflow and 3-workflow); a duplicate-dependency case (confirms dedup-and-build, not rejection). Explicitly assert `order` never contains a rejected workflow's key, for every rejection category. This is the commit most worth getting right in isolation before anything downstream depends on it.
4. Draft the cascading-unavailability logic (§7) as its own unit-tested function or clearly separated block, confirming the availability map is pre-seeded with §3's full `rejected` set before any building happens: a 3-workflow chain (C→B→A) where A's build throws, confirming B and C are both marked unavailable and neither is attempted; the same chain where A is instead rejected by §3 (not a build failure), confirming the same cascade; the same chain where A only dry-run-succeeds, confirming B and C both build normally using A's non-deploy-time fields.
5. Draft the workflow-key assignment (slug + dedup suffix) at plan-normalization time, reusing `slugifyWorkflowName`.
6. Draft the `PLAN_PROMPT` addition with a concrete worked example, asking for `dependsOn` by workflow *name*.
7. Draft the `BuildOptions.priorContext` extension and the exact rendered-prompt-section text for a 2-workflow chained example, including the dry-run caveat line — sanity-check length and clarity by hand before writing code.
8. Draft the pack-builder loop's accumulation/lookup/gate logic (§7) **and** the result-array reassembly into original plan order (§11) **and** the `workflowKey`/`dependsOn` persistence onto `PackWorkflowResult` (§12) as one coherent loop rewrite — these three are tightly coupled in the same loop body, not independent commits.
9. Write this design as a short doc; manually trace it through 2–3 realistic multi-workflow business descriptions, **plus explicit pathological cases**: an LLM-declared cycle, a self-dependency, a duplicate dependency, an unknown dependency name, an ambiguous dependency name (two same-named workflows), a malformed `dependsOn` value, a build-time failure cascading to two downstream workflows, a fully dry-run 3-workflow chain, and a plan where the build/rejection order differs from plan order (confirming §11's result-array reassembly actually produces plan order) — confirming each behaves exactly as specified above before moving to Step 8.

**Guardrails:**
- No full `N8nWorkflow` JSON ever inlined into a subsequent prompt.
- `dependsOn` references are resolved to `workflowKey` values within the same plan only — no cross-pack lookups, no raw display-name matching at build time.
- Zero behavior change for packs whose plan declares no dependencies (`dependsOn` genuinely absent, §3 Pass 1) — same prompt, same cost, same output, same result order as today.
- Unknown/ambiguous/malformed/self/cyclic dependency declarations are always rejected per-workflow, before any generation spend for that workflow — never silently dropped, never coerced to an empty dependency set, never built-anyway-with-a-warning, never escalated pack-wide.
- Duplicate dependencies are always detected and surfaced, never silently dropped — but deduped and built, never rejected.
- `resolveBuildOrder()`'s `order` never contains a rejected workflow — a topological position is only ever assigned to the valid, acyclic candidate subgraph.
- A downstream workflow whose required dependency is genuinely unavailable (rejected or build-failed upstream) does not build or activate — this cascades transitively even though context injection stays direct-only. The availability map is pre-seeded with every §3 rejection before the build loop starts, never discovered lazily.
- Dry-run (`deployed: false`) is never treated as unavailable — chaining proceeds normally using non-deploy-time fields, honestly labeled.
- `webhookUrl` is never fabricated when `N8N_BASE_URL` is unknown, and is always built via the one shared function also used by `triggerWebhookProduction()` — never a second, independent implementation.
- The returned `PackWorkflowResult[]` always corresponds index-for-index to the original plan's workflow order, regardless of build/rejection order.
- `workflowKey`/`dependsOn` are persisted onto every `PackWorkflowResult`, additively.
- None of this ever hard-fails the whole pack build — rejection and unavailability are always scoped to the affected workflow(s), never the pack.

**What to avoid:** Building a generic "task context" framework or inter-step message bus resembling crewAI's `Task.context` machinery wholesale. Heuristic/automatic dependency inference from descriptions — require explicit LLM declaration. Solving transitive *context* injection in this version — direct dependencies only for what gets rendered into a prompt (transitive *unavailability propagation* per §7 is required regardless, since it's a safety property). Letting a bare webhook path be rendered or treated as if it were a complete URL. A second, independent `webhookUrl`-building implementation anywhere. Reviving v2's graceful-degrade language, or v3's incoherent "topologically sort everything including rejected workflows" language, anywhere in Step 8 — both are superseded.

**Outcome / Definition of done:** A written design covering: the `workflowKey` scheme; the `WorkflowReference` schema; the shared `buildWebhookUrl()` extraction; `resolveBuildOrder()`'s six-pass pipeline (shape → name resolution → dedup → self → cycle → sort) with all nine Process-step-3 test cases; the per-workflow (not pack-wide) rejection semantics; the cascading build-time availability gate, pre-seeded before the build loop; the dry-run/unavailable distinction; result-array order preservation (§11); dependency-graph persistence (§12); the `PLAN_PROMPT` and `BuildOptions` additions; the token-budget guardrail; backward compatibility precisely scoped to genuinely-absent `dependsOn` — manually traced against 2–3 realistic examples plus the nine pathological cases listed in Process step 9.

**Anything else:** None outstanding — v4 closes every gap raised in this design-lock pass. Before Step 8 begins, still worth a final skim of `PLAN_PROMPT`'s current JSON-response schema to confirm the `dependsOn` addition slots in cleanly alongside the existing fields.

---

## 10. Step 8 — Pack-builder output chaining: IMPLEMENTATION

**What:** Implement exactly what Step 7 (v4) designed, landing as nine small sequential commits, each checked against Step 2's (extended) semantic fixtures.

**Why:** Implementation should follow a scrutinized design, not run ahead of or drift from it. Semantic fixtures already existing (Step 2) means each commit can be checked against real expected behavior immediately.

**When:** Now, immediately following Step 7 v4's design lock — no gap, so the design doesn't drift out of sync with the surrounding code while sitting unimplemented.

**How — land in this order, each its own commit:**
1. `buildWebhookUrl(baseUrl, path)` (§5) extracted from `N8nApiClient.triggerWebhookProduction()`'s existing inline logic into a new small shared utility, with `triggerWebhookProduction()` updated to call it — + unit tests (trailing slash on base, leading slash on path, both, neither) + confirming `triggerWebhookProduction()`'s own existing tests still pass unchanged against the extracted version. Lands first since `toWorkflowReference()` (commit 2) depends on it.
2. `WorkflowReference` type (with `workflowKey`/`deployed`/`httpMethod`/`webhookPath`/`webhookUrl`) + `toWorkflowReference()` (using commit 1's `buildWebhookUrl()`) + unit tests: no `webhookUrl` without a known base URL; present and matching commit 1's builder exactly when one is; `deployed: false` with `workflowId`/`webhookUrl` both absent for a dry-run `BuildResult`; `deployed: true` with both populated for a deployed one.
3. Workflow-key assignment at plan-normalization time (slug via the existing `slugifyWorkflowName` + dedup suffix) + unit tests for the dedup case (two workflows that would slug identically).
4. `resolveBuildOrder()`'s six-pass pipeline (§3: shape → name resolution → dedup → self → cycle → sort) — + unit tests: no deps; valid chain; forward-reference reordering; unknown dependency; **ambiguous dependency** (two workflows sharing a display name, a third depending on that name); **malformed dependency** (a string instead of an array; an array containing a non-string element); self-dependency; cycle (2- and 3-workflow); duplicate dependency (confirms dedup-and-build, not rejection). Explicitly assert `order` never contains a rejected workflow's key, for every one of the five rejection categories — this is the direct regression test for the v3→v4 "order can't meaningfully contain cyclic workflows" fix. This is the commit most worth getting right in isolation before anything downstream depends on it.
5. `PLAN_PROMPT` addition (`dependsOn` field, requested by name, resolved to keys during normalization) + `WorkflowPlan` extension. Defensive parsing here must match §3 Pass 1 exactly: `undefined` → `[]`; present-but-malformed → surfaced as a rejection (commit 4's `malformed_dependency`), never silently coerced to `[]` the way `normalizeAssumptions()` coerces malformed assumptions — this is a deliberately different tolerance policy than that existing precedent, not the same one reused, and the implementation must not accidentally reach for the assumption-style coercion out of habit.
6. `BuildOptions.priorContext` extension + `prompt-builder.ts` rendering (with method/path/URL rendered as distinct labeled fields, and an explicit "(not yet deployed)" caveat line for `deployed: false` entries) + unit tests confirming deterministic, compact, exactly-expected-fields output for both deployed and dry-run references.
7. The cascading build-time availability gate (§7): a `Map<string, WorkflowReference | 'unavailable'>`, **pre-seeded with every workflow in commit 4's `rejected` map before the build loop starts** (not lazily populated as the loop encounters them) + unit tests: a 3-workflow chain where the root build throws, confirming both downstream workflows are skipped and neither is attempted; the same chain where the root is instead rejected by commit 4's validation (not a build failure), confirming the same cascade; the same chain fully dry-run, confirming all three build normally.
8. `pack-builder.ts`'s loop rewrite — the three tightly-coupled pieces from §§7/11/12 land together since they share the same loop body: build in `order` (commit 4's topological sort, not plan order) with commit 7's availability gate; accumulate every outcome into a `Map<workflowKey, PackWorkflowResult>`; reassemble the **returned** array by iterating `plan.workflows` in **original order** and looking up each result (§11); persist `workflowKey`/`dependsOn` onto every `PackWorkflowResult`, built or rejected (§12). Unit/integration tests: a chained pack where build order differs from plan order, confirming the returned array is still in plan order; a persisted-pack round-trip confirming `workflowKey`/`dependsOn` survive JSON serialization.
9. A new golden pack fixture specifically exercising chaining — two workflows where the second `dependsOn` the first — asserting the second's generated JSON references the first's **real** webhook path/method (not guessed/hallucinated); a fixture confirming a pack with no declared dependencies behaves byte-for-byte as before this step (including result order); a fixture confirming an unknown/ambiguous/malformed/self/cyclic declaration rejects only the affected workflow, with the rest of the pack unaffected; a fixture confirming a duplicate declaration builds normally against the deduped edge set; a fixture confirming a build-time failure cascades to skip its dependents; a fixture confirming a fully-dry-run chained pack builds every workflow normally with `deployed: false` throughout.

**Where:** Same files as Step 7 v4, plus `tests/` for the new chaining fixture(s).

**Reasoning:** Nine small commits behind fixtures (not one large commit) means any regression is caught and attributable to a specific small change — consistent with the one-commit-per-item discipline the Delivery Bundle and preflight arcs already established as Kairos's working pattern. `buildWebhookUrl()` lands first because `toWorkflowReference()` depends on it, and extracting existing logic is lower-risk than writing new logic — proving the extraction is byte-for-byte equivalent to the inline version before building anything new on top of it. `resolveBuildOrder()` lands early because everything downstream depends on its correctness, and it's the piece most amenable to thorough, fast, isolated unit testing before any LLM-dependent behavior is layered on top. Commit 8 intentionally bundles three design sections (§§7/11/12) that v4 explicitly identified as sharing one loop body — splitting them into separate commits would mean each intermediate commit temporarily breaks one of the other two's invariants.

**Process:**
1. Land commit 1; run full suite — confirm `triggerWebhookProduction()`'s pre-existing tests are unaffected by the extraction.
2. Land commit 2; run full suite.
3. Land commit 3; run full suite.
4. Land commit 4; run full suite — this is the commit to scrutinize hardest, since a bug in build ordering, cycle detection, or any of the five rejection categories would silently corrupt every subsequent chained pack.
5. Land commit 5; run full suite; **manually inspect** a real `plan()` call's output against a realistic business description to confirm the LLM populates `dependsOn` sensibly (can't be fully unit-tested — depends on real model behavior).
6. Land commit 6; run full suite; manually inspect the actual rendered prompt text for both a deployed and a dry-run 2-workflow chained scenario, confirming method/path/URL read as distinct fields and the dry-run caveat renders correctly.
7. Land commit 7; run full suite — scrutinize nearly as hard as commit 4, since an inverted condition here (e.g. treating dry-run as unavailable, or lazily seeding instead of pre-seeding) would silently break chaining for every dry-run pack, the most common real-world case.
8. Land commit 8; run full suite — scrutinize hard: a bug in the result-array reassembly would silently reorder client-facing output for every chained pack; a bug in persistence would silently lose the graph on the next save.
9. Land commit 9; run full suite — this is the commit that actually proves the feature end to end, including every failure-mode and the dry-run case.
10. Measure token delta: tokens-per-build for a chained vs. non-chained pack of similar size, confirming the Step 7 token-budget guardrail holds in practice, not just on paper.

**Guardrails:** Same as Step 7 v4's, now enforced in code and tests. No commit is "wire everything up and see" — if a later commit reveals an earlier one needs a small tweak, that's a small follow-up commit, not a reason the sequence should have been skipped.

**What to avoid:** Skipping straight to assembling the whole mechanism at once. Reintroducing v2's pack-wide escalation channel for any rejection case — Step 7 §3 deliberately supersedes that with per-workflow `error`. Reintroducing v3's incoherent "topologically sort everything including rejected workflows" — Step 7 v4 §3 deliberately supersedes that. Writing a second `webhookUrl`-construction implementation instead of using commit 1's extracted `buildWebhookUrl()`. Reaching for `normalizeAssumptions()`-style silent coercion for malformed `dependsOn` out of habit — the tolerance policy for this field is deliberately different (surface, don't coerce).

**Outcome / Definition of done:** All nine commits land; the chaining fixture passes, demonstrating a correct real cross-workflow reference; the "no dependencies declared → unchanged behavior, including result order" fixture also passes; the "unknown/ambiguous/malformed/self/cyclic declaration → per-workflow rejection, rest of pack unaffected" fixture also passes; the "duplicate declaration → deduped, builds normally" fixture also passes; the "build-time failure cascades to dependents" fixture also passes; the "fully dry-run chained pack builds normally" fixture also passes; the "returned result array matches plan order regardless of build order" fixture also passes; a persisted-pack round-trip confirms `workflowKey`/`dependsOn` survive; token delta measured and reported; full suite (incl. Steps 2–6a) green; typecheck/lint clean.

**Anything else:** Budget for one or two small design-refinement iterations within this step once real model behavior is observed — e.g., the LLM might declare `dependsOn` inconsistently at first, or the rendered section might need re-wording. Treat Step 7 v4's design as a strong starting point, not an unchangeable spec.

---

## 11. Step 9 — Real-flow checkpoint

**What:** Run the complete pipeline — `plan()` → `build()` (chaining active) → `writeBundle()` → `preflight` — end to end against a realistic 3-workflow business description, ideally modeled on an actual Empire Homecare scenario (e.g. "referral intake webhook → confirmation email referencing the intake link → weekly summary email").

**Why:** Every step above was validated in isolation. This is the first point the whole arc gets validated together against something resembling real usage rather than synthetic fixtures — and it doubles as the dress rehearsal for Step 10.

**When:** Now, immediately after Step 8, before the real engagement.

**How:** Run via the actual CLI/SDK path (not a unit-test harness) against a sandbox n8n instance or the most realistic available mock. Inspect by hand: (a) the third workflow's generated JSON correctly references what the first workflow's build actually produced; (b) the bundle manifest carries the full provenance tuple; (c) the ledger shows the expected event sequence (plan → build×3 → `bundle_exported` → `preflight_completed`); (d) preflight's compatibility classification reports "clean."

**Where:** Real CLI/SDK entry points; direct inspection of `bundle-manifest.json`, `handoff.md`, `risk-report.md`, and the telemetry `.jsonl` output — not only through test assertions.

**Reasoning:** Unit and fixture tests test what you thought to test. Running the real pipeline against a business description nobody wrote specifically to exercise a known code path is the closest available proxy for "will this work for Empire Homecare" short of the engagement itself.

**Process:**
1. Write (or reuse from Step 1) a realistic 3-workflow business description with a genuine cross-workflow reference need.
2. Run `plan()`; inspect the `dependsOn` declarations.
3. Run `build()` for the full pack; inspect the third workflow's JSON for the expected cross-reference.
4. Run `writeBundle()`; inspect `bundle-manifest.json` for provenance.
5. Run `preflight`; inspect verdict and compatibility classification.
6. Read the ledger's `.jsonl` output; confirm expected events.
7. Write a short checkpoint note: what worked, anything that looked off, token delta observed, any small follow-ups identified (these feed Step 10's post-engagement backlog, not new mid-flight scope).

**Guardrails:** Don't let this become a debugging session for anything merely suboptimal — note it for later. A genuinely broken behavior is a real, small, targeted fix (its own commit) before this step is considered complete.

**What to avoid:** Skipping this because fixtures already pass — fixtures test what was anticipated; this tests what wasn't.

**Outcome / Definition of done:** A written checkpoint note confirming the full pipeline works end to end, with chaining, provenance, and ledger events all manually verified; any genuinely broken behavior found is fixed before this step closes.

**Anything else:** This is the moment to decide, with real evidence, whether any of Section 12's small items still need attention before Step 10, or are already in good shape.

---

## 12. Small interleaved items (ride alongside the numbered steps)

These are cheap enough not to need the full template, but each still gets a real why/how/guardrail. Do them opportunistically alongside whichever numbered step they naturally attach to — none should block a numbered step, and none should be skipped either.

**A. `kairos patterns explain`** — expose the existing pattern-scoring math (`src/telemetry/pattern-analyzer.ts`) per candidate via a new CLI subcommand. Why: pure observability over a system that already exists; no architecture change. Guardrail: read-only formatter, touches no scoring logic. Attach to: any point after Step 1 (useful for interpreting telemetry findings too).

**B. `ANTHROPIC_BASE_URL` documentation** — verified: `src/client.ts` constructs `new Anthropic({ apiKey })` with no `baseURL` override, so the SDK's own env-var default passes through untouched. Add one README section stating precisely what this supports: Anthropic-*wire-format*-compatible gateways/proxies (e.g., a local Ollama instance serving `/v1/messages`) — explicitly **not** "arbitrary local models," since nothing translates the wire protocol on Kairos's side. Guardrail: the caveat sentence is not optional — an unqualified claim here would overclaim, which cuts against Kairos's own honesty discipline elsewhere (typed-string OpenAPI contracts, human-filled impact notes).

**C. Benchmark condition reporting** — add model name, temperature, retries, and rule-set version to `scripts/benchmark.ts`'s output alongside pass/fail scores. Why: a benchmark score without its conditions can't be compared against a future run reliably. Attach to: Step 2 (natural extension of the baseline-diff work).

**D. Confidence-filtered reporting pass** — review preflight/risk-report language so every finding states evidence, severity, and an actionable fix, not a speculative warning. Why: noisy preflight output destroys the trust the whole product sells on. Guardrail: this is a language/copy review, not a logic change — don't let it drift into rule-behavior changes (that's Step 4's job). Attach to: after Step 6 (once the finding-taxonomy adapters exist, this pass can be written against the unified shape once, rather than three times).

**E. Library empty-result + normalization tests** — verified split: `src/memory/retrieval.ts` has no strict threshold to relax (BM25 `score > 0` filter + RRF + optional embeddings — already degrades gracefully); `src/library/file-library.ts` line ~420 filters candidates to `signals.tfidf > 0 || signals.nodeFingerprint > 0`, meaning a business description sharing no tokens/fingerprints with any library entry **can** return zero template matches. Write tests for both paths: confirm memory retrieval never returns a false-empty; confirm the library path's empty-match behavior is *tested and intentional* (a genuinely novel request correctly returning no template match may be the right behavior — injecting an irrelevant template can hurt generation). Add a relaxed-fallback only if these tests reveal real misses, not preemptively. Attach to: Step 2 (same regression-net spirit).

**F. Operation-aware retry logic** — before adding any shared `withRetry` utility for n8n API calls (`src/providers/n8n/api-client.ts`), explicitly classify each call site: safe reads and genuinely idempotent operations may auto-retry; workflow creation, activation, and webhook-test calls must classify-then-escalate instead, since a lost response on a call that actually succeeded server-side must never become a duplicate side effect in a client's real n8n instance. Guardrail: this classification must be written down per call site before any retry wrapper is added — don't wrap first and reason about idempotency after. Attach to: Soon, after Step 6 (shares the same error-plumbing surface as the ledger's activation events).

**G. "Restore candidate" language fix** — already folded into Step 5's outcome, listed here as its own item since it's genuinely separable: audit every place documentation or generated output implies "rollback" for a timestamped bundle directory, and replace with language that states plainly what redeployment does and does not guarantee.

---

## 13. What we are explicitly not doing during this arc (condensed reference)

Rejected outright, all three research/comparison/audit rounds in agreement: portable workflow IR / target exporters, a full multi-agent generation framework, an event bus / delivery-state DAG engine, descriptor-registry / middleware-stage-interface refactors, hosted monitoring / SaaS dashboard / UI, release/rollback infrastructure, a credential vault, a plugin marketplace, RAPTOR/GraphRAG/multi-backend vector retrieval, Elo-style scoring, LLM-in-the-loop memory encode/recall, silent deterministic auto-repair of workflow JSON, multi-provider LLM abstraction beyond the `ANTHROPIC_BASE_URL` docs line.

Held off with a named trigger (not forgotten, not scheduled): `displayParameter()` general resolver import (narrow-patching rate becoming the bottleneck — see Step 4), `kairos test pack` + its SSRF helper (manual webhook testing becomes genuinely annoying), redacted support bundle (first painful client debugging session), Code-node content security scan (first Code-heavy client), syntactic JSON-repair modes (telemetry shows fenced/truncated JSON failures), stage-specific model *routing* (a second real LLM call site exists — today there is exactly one, in `client.ts`), markdown local rule packs (a precedence design is written **and** a client actually asks), a compiled spec-DSL (telemetry shows >25% of failures are shape errors a compiler would eliminate), a drift-watching scheduler (a client pays for ongoing monitoring — blueprint already filed: Open WebUI's `claim_due` + `SKIP LOCKED` + jitter pattern), preflight `--fix` (a client asks for auto-repair, plus a live-n8n-write safety review first).

---

## 14. Risk register (cross-cutting, not step-specific)

- **Telemetry is empty or thin (Step 1).** Not a failure — treat as a finding, lean Step 2's fixtures structural, and let it strengthen the case for Step 10.
- **A required-CI test accidentally makes a live call (Step 2).** Mitigated by the no-network guard itself — but the guard's own effectiveness should be verified once by deliberately introducing a stray live call in a throwaway test and confirming the guard catches it, not just trusting the guard was written correctly.
- **Step 3's audit finds nothing.** Also not a failure — a clean audit is valid evidence the registry's assumptions currently hold; the parity script still has permanent value.
- **Step 3's audit finds too much.** This is the trigger for the resolver import — see Step 3 and Step 4's explicit stop-and-report guardrails. Don't let it become an excuse to skip the narrow-fix discipline, and don't let it slip into silently patching 20 cases without stopping to check the threshold.
- **A repro test sits red on the shared branch between Step 3 and Step 4.** Mitigated by the "no committed failing tests" guardrail — repro tests are developed locally/uncommitted (or committed only with an explicit skip marker) and land atomically with their fix.
- **Workflow-hash design misses a semantic dimension.** Mitigated by the explicit connections/settings inclusion and the dedicated connection-sensitivity test — but worth a second look if `N8nWorkflow`'s shape ever grows a new semantically-significant field this plan didn't anticipate.
- **Version constants drift from the content they describe.** Mitigated by content-derivation (hashes) rather than manual bump discipline — but if any of the three (rule-set/catalog/prompt) ends up manually maintained after all because content-derivation proved impractical, that specific one needs the CI-enforcement fallback, not silent trust.
- **The dependency graph's topological sort or cycle detection has a bug.** This is the single highest-consequence bug surface in the whole chaining mechanism, since it silently determines build order for every future chained pack. Mitigated by landing `resolveBuildOrder()` as its own commit with all five test cases (Step 8, commit 3) before anything downstream depends on it.
- **`workflowKey` collisions beyond the simple dedup-suffix case.** The dedup suffix (`-2`, `-3`, ...) handles the common case; if a pack ever has enough workflows with enough naming collisions that this feels fragile, that's a signal to revisit — not something to over-engineer against preemptively for a typical 4–8-workflow pack.
- **Chaining's prompt-size creep (Steps 7–8).** Mitigated by the token-budget guardrail (direct dependencies only, compact `WorkflowReference`, never full JSON) — but must be *measured*, not just designed against, in Step 8's final commit.
- **The plan-prompt's `dependsOn` field breaks JSON parsing on some models.** Mitigated by matching the existing defensive-parsing pattern (`normalizeAssumptions()`) — must be explicitly tested with a malformed/missing `dependsOn` fixture, not just the happy path.
- **A bare webhook path gets treated as a full URL somewhere.** Mitigated by the explicit three-field distinction (`httpMethod`/`webhookPath`/`webhookUrl`) and never fabricating `webhookUrl` without a known base URL — worth a specific manual check during Step 9's checkpoint that the rendered prompt text couldn't be misread as claiming a bare path is callable.
- **The full ledger (Step 6b) never gets prioritized once Step 10 starts.** Acceptable — it was deliberately made non-blocking; if it never becomes urgent, that itself is evidence it wasn't as load-bearing as first estimated.
- **Scope creep at every step.** Each step's "what to avoid" section is the primary defense; when in doubt, do less and note the temptation for a later, separately-approved step.
- **The whole arc taking too long before Empire Homecare.** The plan is sized so that by Step 9 the pipeline is worth testing on a real client. Resist "one more engineering step first" — see Step 10's guardrails.

---

## 15. Master checklist (Definition of Done for the whole arc)

- [x] Step 1: telemetry findings note written (`docs/plans/telemetry-findings-2026-07-08.md`; pre-audit resolution of Rule 126 wording + `warnedRules` semantics appended same day, both left as deferred small polish items, not fixed)
- [x] Step 2: 2–3 semantic golden fixtures (stubbed LLM, mocked n8n, zero live calls) green in required CI; benchmark baseline handled by the pre-existing `--compare` flag (extended with per-prompt regression detection), not a required-CI gate; no-network guard verified to actually catch a stray call
- [x] Step 3: audit report (`docs/plans/step3-audit-report-2026-07-08.md`) — Rule 58 (13/25 node types confirmed), node-syncer (confirmed, narrower exposure than assumed), registry `requiredParams` (clean), typeVersion/defaultVersion (clean), parameter-rename spot-check (clean). `audit-node-catalog-parity.ts` not built — noted as an optional Step 4 tooling item, not required by findings. All repro tests kept uncommitted until landed atomically with their fix.
- [x] Step 4 (partial — 2 of 2 confirmed-defect fixes landed, resolver import untaken): Rule 58 widened to `Record<string, string[]>` + 14 tests, landed with its tests in one commit; node-syncer widened to capture all credential names via new `credentialTypes?: string[]` (backward-compatible, `credentialType` unchanged) + 5 new tests (first-ever `NodeSyncer` coverage), landed with its tests in one commit. Registry `requiredParams`/typeVersion needed no fix (audit found them clean). Displayoptions capture deliberately not added to node-syncer — unverified against a live n8n API response. Rule 126 wording and `warnedRules` rename remain deferred, separate small polish items, not done here.
- [x] Step 5 (provenance tuple — 12 commits total across the initial pass + two Codex-reviewed closure passes): `computeWorkflowHash()` with a bumpable schema-version prefix (nodes/connections/settings, 12 tests incl. connection-sensitivity); content-derived `ruleSetVersion`/`promptTemplateVersion`+`promptProfile`/`nodeCatalogVersion`/`kairosVersion` (walks up to the nearest `package.json`, correct in both dev and the flat `dist/` tsup produces); `BuildResult.provenance` with real model/maxTokens/temperature/runId + the above; `PackWorkflowResult.provenance` preserving it through the pack-builder boundary (previously silently discarded — the single biggest gap the first review found); `BundleManifest.provenance` (export-time) plus per-workflow `liveExportHash`/`originalBuildHash` (build-time, from `PackWorkflowResult.provenance`) so build-vs-live drift is directly visible; `buildProvenance?: BuildProvenance` per workflow.json manifest entry carrying the FULL build-time object (model/maxTokens/temperature/runId/versions), not just the hash — the second review's biggest catch, since the manifest had only ever exported `originalBuildHash` as a bare string; `PreflightResult.provenance` with a same/different/predates-tracking comparison check including `kairosVersion`/`promptProfile`. Two real hygiene/correctness bugs found across the two reviews and fixed in their own commits: a literal NUL byte in `pack-bundle.ts` (harmless at runtime, broke `grep`/`file` tooling), and — this one genuinely a regression, not hygiene — the NUL-byte fix's first attempt (a plain space join) could silently collide two distinct `(service, credentialType)` pairs into one `credentials.md` entry; replaced with `JSON.stringify([service, credentialType])` and verified empirically (reverted, confirmed the regression test fails, restored, confirmed it passes) rather than trusting inspection alone this time. ~60 new/updated tests, 1221/1221 passing overall. Still outstanding, explicitly not silently dropped: the "restore candidate" `handoff.md` wording correction — actually landed in this same arc, see below — and activation provenance (moved to Step 6b's `workflow_activated` payload, see §7's note).
- [x] Step 6a: `bundle_exported` + `preflight_completed` events, `TelemetryEvent['eventType']` widened, `TELEMETRY_SCHEMA_VERSION` 2→3, `writeBundle()`/`runPreflight()` take an optional `telemetry?: TelemetryCollector` (additive, no dependency for callers that don't pass one), CLI wired via a new `createTelemetryCollector()` helper reusing the existing `KAIROS_TELEMETRY` env-var decision. Verified end-to-end by extending a Step 2 golden-pack fixture (real `TelemetryCollector`, both events read back from disk and asserted), not just isolated unit tests. Full ledger (6b) explicitly not touched. Follow-up micro-fix (same review pass): both emit() calls wrapped in try/catch — a telemetry append failure must never throw out of writeBundle()/runPreflight() or change their result/the CLI's exit status; verified empirically for the writeBundle() case.
- [x] Step 7 (design locked, v4 — no code written, per instruction): `workflowKey` assignment (unchanged from v2); `resolveBuildOrder()` redesigned as an explicit six-pass pipeline (shape → name resolution → dedup → self → cycle → sort) covering nine test cases across six categories — unknown/ambiguous/malformed/self/cycle get **per-workflow rejection before generation spend**; duplicate gets dedup-and-build instead (not the same defect class); a build-time cascading-availability gate (§7), now explicitly **pre-seeded with every rejection before the build loop starts** (v3 left this lazy/implicit — a second review caught that a topological order can't coherently include rejected/cyclic workflows, which v3's stated return shape had implied); an explicit dry-run-vs-unavailable distinction (§8, `WorkflowReference.deployed: boolean`, unchanged from v3); **new in v4:** the returned `PackWorkflowResult[]` explicitly preserves original plan order regardless of execution order (§11 — previously unspecified, would have silently reordered client-facing output for any chained pack); `workflowKey`/`dependsOn` now persist onto `PackWorkflowResult` (§12 — previously the graph vanished after one build call); `webhookUrl` construction now explicitly reuses `N8nApiClient.triggerWebhookProduction()`'s existing URL-join logic via a new shared `buildWebhookUrl()` rather than a second implementation (§5). Step 8's implementation plan updated in the same pass for consistency (9 commits now, not 8).
- [x] Step 8: all nine chaining commits landed (per Step 7 v4) -- `buildWebhookUrl()` extraction; `WorkflowReference`/`toWorkflowReference()`; workflow-key assignment; `resolveBuildOrder()`'s six-pass pipeline (9 test cases); `PLAN_PROMPT` `dependsOn` addition (no parsing code needed -- confirmed `plan()`'s existing cast already passes it through raw); `BuildOptions.priorContext` threaded through the full `Kairos.build()` → `WorkflowDesigner.design()` → `PromptBuilder.build()` chain (a plumbing detail the design's "Where" list didn't spell out, traced and confirmed during re-anchoring, not a deviation); the cascading availability gate (pre-seeded, never lazy); the pack-builder loop rewrite bundling execution order + plan-order-preserving result reassembly + `workflowKey`/`dependsOn` persistence (found and fixed a real pre-existing test-fixture gap along the way: mock `workflow: {}` fixtures broke once `toWorkflowReference()` started reading `.nodes` on every success); a golden-pack chaining fixture through the real `plan()→build()→writeBundle()→preflight` pipeline; and a token-budget measurement (~278 chars / ~70 tokens per dependency, well under the 1000-char bound, no live API call). 1277/1277 passing overall. Typecheck/lint clean throughout — full gates run after every single commit, not just the three instructed checkpoints.
- [ ] Step 9: real-flow checkpoint note, any real bugs found fixed, webhook path/URL rendering specifically spot-checked
- [ ] Section 12 items (A–G): each attached and done at its natural point, none skipped
- [ ] Step 10: Empire Homecare engagement underway, replacing every hold-off item's guess with a real answer
- [ ] Step 6b (full ledger): tracked separately as a Soon item, explicitly not blocking anything above

---

*This plan supersedes prior scope-level discussion in `research/comparison/`. It does not redo that research and should not be re-opened for re-litigation — only for execution, and for recording what Steps 1, 3, and 9 actually find once they're run.*
