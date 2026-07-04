# Changelog

All notable changes to `@kairos-sdk/core` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); dates are publish dates from npm.

## [Unreleased]

### Fixed 3 real correctness/reliability gaps found by the 282-run backend-viability benchmark
A benchmark run (94 prompts × 3 repeats, backend-API tier included) found 12 failures. Root-caused all three:
- **`max_tokens: 8192` was hardcoded** in `src/generation/designer.ts` since the very first commit (v0.1.1), never tuned — accounted for 10/12 failures, all on 5+ integration "stress test" prompts hitting the ceiling. Raised the default to 16000 and made it configurable (`KAIROS_MAX_TOKENS` env var / `ClientOptions.maxTokens`), matching the existing `KAIROS_MODEL` convention. `pack-builder.ts`'s separate `max_tokens: 4096` (a different, smaller planning-JSON call) is untouched — not implicated by this benchmark.
- **The retry/correction loop only ever fed back ERROR-severity validation issues, never WARN-severity ones** — confirmed via two Explore agents tracing the full loop. Since most of the 131 rules are warn-level (including Rule 126, invalid UUID node IDs — the one that appeared to "resist correction" across 3 attempts in the benchmark), this meant the majority of rules never got a chance to be corrected during retries at all, even when a build was already retrying for an unrelated real error. Fixed by feeding the *full* issue list (not just errors) into the next attempt's correction message — `designer.ts`'s pass/fail gate (`validation.valid`) is completely unchanged, so this only affects what Claude is told to fix during an already-happening retry, not what counts as a passing build.
- **Rule 126 had no `RULE_EXAMPLES` entry** — even after the fix above, Claude would've gotten only the raw validator message, no concrete bad/good example. Added one (`"id": "node-1"` vs. a real UUID v4), with reverse-guard/regression-guard tests matching the existing pattern for every other example in `rule-metadata.ts`.

A follow-up verification re-run (the 6 originally-failing prompts × 3 repeats) confirmed 3 of them fully fixed, but surfaced a new problem: raising `max_tokens` means the largest workflows take longer to generate, and `designer.ts`'s own hardcoded 120-second `AbortController` timeout (deliberately added in an earlier "harden SDK" pass, just miscalibrated for the new ceiling) started firing on requests that were still legitimately in progress. Fixed the same way as `max_tokens`: raised the default to 300000ms and made it configurable (`KAIROS_TIMEOUT_MS` / `ClientOptions.timeoutMs`), same convention as `KAIROS_MODEL`/`KAIROS_MAX_TOKENS`.

### Parse-failure resilience: recovered, retried, and made visible instead of failing instantly
One prompt from that same verification re-run kept failing with `"generate_workflow tool call missing workflow field"` — a larger, isolated 8-run sample confirmed this was real (not sampling noise: 2/8 passed, well past the threshold for a genuine signal), and an instrumented repro captured the actual raw response. The field wasn't missing: **Claude had serialized the workflow as a JSON *string* instead of a JSON object** — a known failure mode on very large tool outputs — and the string contained complete, valid workflow JSON the whole time.

- **Recovery shim**: `extractToolUse` now `JSON.parse`s a stringified `workflow` (and defensively, `credentialsNeeded`) before giving up — the captured failure would have succeeded outright with this in place. Falls through to an honest error if the parse doesn't yield an object.
- **Honest error messages**: three distinct cases now (field absent / string that failed to parse / other wrong type), replacing one generic "missing" message that was true for none of them.
- **Made retryable**: parse and truncation failures used to throw immediately, bypassing the existing 3-attempt retry loop entirely — one flaky response killed the whole build even though this exact prompt succeeds 25-67% of the time on a fresh call. Now retried with format-specific correction feedback ("you returned workflow as a string," "your response was cut off, generate something more compact"), while correctly preserving any still-unaddressed validation issues from an earlier attempt across the parse failure.
- **Telemetry parity**: parse/truncation failures previously emitted zero telemetry (today's data: 14 `build_start` vs. 5 `generation_attempt`/`build_complete` — the pattern-learning system was completely blind to this failure class). `ValidationError`, `GenerationError`, and the new `ResponseTruncationError` (a `GenerationError` subclass, distinguishing timeout from other generation failures by type rather than message-matching) now all carry `attemptMetadata` and get the same `build_complete`/pattern-update treatment via a new shared `Kairos.emitFailureTelemetry()`, replacing duplicated inline logic in both `build()` and `replace()`.
- **New `--isolated` benchmark flag**: the investigation also found that benchmark runs read *and write* the same global `~/.kairos` telemetry/patterns state as real usage — `patterns.json` regenerated mid-way through the 8-run isolation test, meaning the system prompt's injected guidance wasn't stationary across the run. `--isolated` scopes telemetry/patterns to a temp directory for a single run; default behavior (shared state) is unchanged.
- Deliberately not done: no SDK upgrade, no tool-schema `required` change (would break the tool's legitimate `{error}`-only escape path), no change to `pack-builder.ts`'s separate, smaller planning call.

### Runtime execution drift detection + efficiency analysis
Part of a "can Kairos serve as a real app's backend" investigation — these two were identified as prerequisites for trusting Kairos with unattended backend workloads, not separate nice-to-haves.
- `ExecutionTrace` now captures per-node execution time (`nodeDurations`) — n8n's own execution data already contained this (`runData`'s per-node `executionTime` field), `parseExecutionTrace` was just discarding it
- New `detectExecutionDrift()` (`src/telemetry/execution-drift.ts`) compares a workflow's latest recorded execution against its own trace history: a node erroring that never errored before, a run more than 2x slower than the historical average, a node that always ran before but is now missing, or a brand-new node in the executed path. Deliberately distinct from the unrelated `DriftReport`/`detectDrift()` in `pattern-analyzer.ts`, which tracks validator-rule-coverage drift, not runtime behavior
- `kairos trace record` (CLI) and `kairos_record_trace` (MCP) now report drift and the slowest node from the latest run as a side effect of the existing manual trace-recording flow — no new scheduler/polling infrastructure, reuses the trigger that already exists
- New validator **Rule 131** (warn): flags a workflow with 15+ nodes and zero branching logic (no If/Switch/Merge/Filter) as a consolidation opportunity — each n8n node adds real per-node execution/serialization overhead that compounds on every request for latency-sensitive workflows

### Fixed CI (broken since before this changelog existed — nobody had been watching Actions)
- `npm ci` failed on every push/PR because the committed `package-lock.json` wasn't actually self-consistent with `package.json` — likely from `npm install`'s non-deterministic handling of `@langchain/community`'s large optional-peer-dependency surface (Azure Search, HuggingFace, xata.io, AWS Smithy SDK components, mysql2, etc. all showed as "missing from lock file" on a strict `npm ci`, independent of Node version). Fixed by fully regenerating the lockfile from a clean `node_modules`-free install and verifying `npm ci` against it from an isolated copy
- Separately, discovered `isolated-vm@6.1.2` — a required (non-optional) transitive dependency of `@n8n/expression-runtime`, pulled in by all three n8n devDependencies — hard-requires Node ≥22 and fails to natively compile below that (a real `node-gyp` build error, not just an engines warning). CI's matrix included Node 20, which can never install this toolchain regardless of lockfile correctness. Updated the matrix from `[20, 22]` to `[22, 24]` — this only affects the dev/build toolchain; Kairos's published package (`files: dist` only) never ships these devDependencies and still declares/supports `engines: node >=18.0.0` for consumers
- No production code changed; this is lockfile + CI workflow only

## [0.9.0] - 2026-07-03

Grouped by theme, not commit-by-commit.

### Repo-integration effort (Phases 1–5)
- Bulk local workflow import (`kairos sync-templates --from-dir`)
- Library scaling: `MAX_LIBRARY_SIZE` raised 500→1500, backed by measured search-latency data
- Honest benchmark re-run — found and documented a ceiling effect in the old 20-prompt suite, replacing a stale 55%→100% headline claim
- n8n-skills gap analysis: two new sub-patterns (`webhook-body-access`, `binary-data-handling`) and validator rules 127/128/130
- Generated node resource/operation catalog (`scripts/generate-node-catalog.ts`, `src/validation/node-catalog-generated.ts`) extracted from the real `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` packages, backing validator Rule 129

### Bug fixes found via direct verification against the real n8n package
- **Rules 56/128** were reading `onError` from the wrong location (`node.parameters.onError` instead of the correct top-level `node.onError`) — meant both rules could never fire against a correctly-shaped real workflow
- **Rule 57** checked the wrong parameter name for HTTP Request binary uploads (`binaryPropertyName`, a typeVersion 1-2 name) instead of `inputDataFieldName` (typeVersion 3+, what Kairos actually generates) — caused false positives on every correctly-configured binary upload

### Backlog remediation (2 CRITICAL + 6 HIGH items from an internal audit)
- Fixed a check-then-act race in the MCP server's `autoSync()` causing duplicate n8n network calls under concurrent requests (new `coalesceAsync()` utility)
- Extended retrieval-weight env-var tunability (`KAIROS_WEIGHT_*`) to the embedding-augmented scoring path; documented all five vars
- New `DeployActivationError` — surfaces the orphaned `workflowId` when a workflow deploys successfully but activation fails (recoverable, never auto-deleted)
- MCP session-warning fix: distinct messages for "never called `kairos_prompt`" vs. "session expired," previously conflated
- New `kairos sync-nodes` CLI command — brings the CLI/SDK path to parity with the MCP server's live node-registry sync (`ClientOptions.nodeRegistry`)
- Real schedule-conflict detection in `validatePack()` (`PackValidationIssue.type: 'schedule_conflict'` was declared but never implemented)

### Documentation
- Full audit-driven README pass: completed the Validator Rules table (was showing 34 of 128 rules with no "partial" framing — now auto-generated from `validator.ts` via `scripts/generate-rules-table.ts`), documented the previously-invisible MCP permission model (`KAIROS_MCP_*` vars, `--http` transport), added a unified Environment Variables reference, closed API Reference gaps (`nodeRegistry`, `sessions`/`replace` CLI commands, node-type registry counts)
- New `tests/unit/docs-drift.test.ts` — structurally verifies README rule-table completeness, env-var coverage, and CLI-command coverage against the actual source, so this class of drift fails CI going forward instead of silently recurring

### Cleanup
- Removed the dead `'skipped'` value from `SmokeTestStatus` (confirmed never constructed anywhere — `'not-applicable'` already covers the case it was meant for)
- Patch-level dependency bumps: `tsx`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`

### Fixed a near-miss in the node-catalog generator before it shipped
- `scripts/generate-node-catalog.ts` silently dropped Slack, Gmail, Telegram, Discord, WhatsApp, Microsoft Teams, Microsoft Outlook, and Google Chat from the generated catalog when run against a newer `n8n-nodes-base` — root cause: those node families all transitively require a shared "send and wait" utility that itself requires `n8n-core`, which isn't declared as a dependency of `n8n-nodes-base` and was never installed. The generator's blind `catch { skipped++ }` made a hard failure and a benign "no resource/operation options" skip look identical, hiding it completely
- Fixed by (1) adding `n8n-core` as a devDependency so the requires actually resolve, verified via a full isolated reproduction — 288 node types extracted, matching the current catalog's count exactly, byte-identical resource/operation data; and (2) making the generator report the real error message per file, grouped and deduplicated, instead of swallowing it into an indistinguishable skip count
- Currently-committed catalog (built against the still-pinned `n8n-nodes-base@2.15.1`) was never affected — this was caught before any version bump was taken, not after

### n8n-nodes-base 2.15.1 → 2.28.4, @n8n/n8n-nodes-langchain 2.28.4 → 2.28.5
Deferred from the fix above until it could be taken deliberately rather than as a side effect. Diffed the full catalog before and after (297 node types either way — zero added/removed node types, only value changes within 7 existing ones):
- **GitHub** gains real PR management coverage: `pullRequest` resource plus `close`/`merge`/`reopen`/`editComment`/`getDiff`/`getMembers`/`getPatch` — previously, Rule 129 would have rejected a valid "merge this pull request" workflow as invalid
- **NocoDB** substantially expanded: `base`/`linkrow` resources, `count`/`link`/`list`/`search`/`unlink`/`upload`/`upsert` operations
- Smaller additions: LoneScale (`company`/`contact` resources, `enrich`/`search`/`source`), Phantombuster (`launchSync`), Telegram (`sendMessageDraft`/`sendRichMessage`/`sendRichMessageDraft`)
- Odoo's `note` resource renamed to `activity`; Pipedrive loses the `dealActivity` resource (the one place coverage narrows, not widens) — confirmed via repo-wide grep that neither is referenced anywhere in Kairos's library, tests, or patterns

## [0.8.0] - 2026-07-02
Full audit pass: fixed `pack-wirer`'s `__rl` resource-locator shape, an unstripped PUT field, word-boundary intent matching, and a library write-queue poisoning bug.

## [0.7.0] - 2026-07-01
Five intelligence features: failure-aware retrieval, intent mapping, embeddings, pack wiring, and execution-trace learning.

## [0.6.0] - 2026-06-29

## [0.5.1] - 2026-06-28

## [0.5.0] - 2026-06-28

## [0.4.6] - built, not published
Parameter-level validation rules 27-34. Superseded quickly by 0.5.0 before ever being published to npm.

## [0.4.5] - 2026-06-26

## [0.4.1] - 2026-06-25
Expression syntax validation — Rules 24-26 (community-sourced from n8n forum feedback).

## [0.4.0] - 2026-06-24

## [0.3.2] - 2026-06-23
## [0.3.1] - 2026-06-23

## [0.3.0] - 2026-06-23
MCP server added — use Kairos as an MCP tool with any LLM (Claude, GPT, Gemini, etc.), no Anthropic API key required.

## [0.2.1] - 2026-06-22

## [0.2.0] - 2026-06-22
`kairos init` first-time setup wizard.

## [0.1.1] - 2026-06-18
## [0.1.0] - 2026-06-18
Initial release.
