# Repo Integration Plan — for Opus 4.8

**Written by:** Fable 5 (audit session, 2026-07-02)
**Executor:** Opus 4.8, in future Claude Code sessions with Jordan
**Status:** PHASES 1–3 COMPLETE, ALL TRACKED JUDGMENT CALLS RESOLVED (2026-07-02, implemented by Fable 5 — this plan was executed in the same session it was approved in, ahead of the original hand-off-to-Opus-4.8 intent; noted here for continuity). Phase 0 decisions locked (§5). All five Phase 1 amendments implemented (§6). Phase 2 library-scaling work done and measured with real numbers (§7). Phase 3's benchmark actually ran against real API spend (Jordan's explicit go-ahead) — see §8 implementation notes for the honest result (a ceiling effect, not the improvement the old README claimed). The three items tracked after Phase 1/3 (MAX_LIBRARY_SIZE default, CLI test isolation, benchmark tier selection) were planned in §8a and all resolved — see the "Deferred follow-ups tracker" after §6 for commit references. Phase 4 remains unstarted; resume there. All phases committed to git; see commit history for exact diffs and gate results.

---

## 1. Mission

Evaluate and selectively integrate learnings from the external n8n ecosystem — primarily bulk workflow datasets and encoded n8n knowledge — to deepen Kairos's library moat. The single thesis, validated by Kairos's own benchmark (89 ingested templates took first-try pass 55%→100% in the 34-rule era): **more high-quality, diverse library entries = better retrieval = better generation.**

## 2. Hard constraints (non-negotiable)

1. **Credentials are NEVER written to disk, memory files, or commits.** This includes anything found inside ingested workflow JSONs — the secret-scanning safety gate is mandatory, not optional.
2. Every ingested workflow passes through the existing pipeline: `assessTemplateSafety()` → `N8nValidator.validate()` → `library.save()` with provenance metadata. No bypass paths.
3. All existing tests stay green. Run `npm run build && npm run typecheck && npm run lint && npm test` before EVERY commit — this repo has shipped two broken commits before; CI runs exactly those four gates.
4. Backward compatibility: no changes to the shapes of `index.json`, `StoredWorkflow`, or public API exports without a migration path (see `migrateFromMonolithic` for the established pattern).
5. Do not copy code from external repos, even MIT-licensed ones. Study, then write original implementations. Cite what was studied in commit messages.
6. Do not add external repos as dependencies. Datasets are user-supplied local files; knowledge is re-encoded, not vendored.

## 3. Verified repo audit (2026-07-02)

These findings were verified directly against each repo — several correct or sharpen the earlier Claude AI review.

### czlonkowski/n8n-mcp — competitor/complement (22.1k★, MIT, actively maintained: v2.62.0 released 2026-07-02)
- 23 MCP tools; node database of 2,063 nodes (816 core + 1,247 community) with 99% property coverage, built by extracting from n8n packages + docs.
- **Correction to the earlier review:** it DOES have workflow validation — multi-level (minimal/full profiles), connection and expression checks, and an "auto-fix common errors" capability. It also ships 2,352 workflow templates and a `n8n_deploy_template` tool. "They have no validator" is not a safe differentiation claim.
- **Kairos's actual differentiation:** the learning loop (outcome stats, failure patterns, warning effectiveness, execution traces), business-context packs, per-instance catalog sync, and telemetry-driven prompt adaptation. n8n-mcp is stateless knowledge; Kairos is stateful learning. Frame it that way in all docs/marketing.
- Coexistence: no tool-name collisions (`kairos_*` vs their names). Running both in one Claude Code session is viable — n8n-mcp for node property lookup, Kairos for generation/validation/deploy/learning.

### czlonkowski/n8n-skills — study target (MIT)
- 14 Claude Code skills encoding n8n knowledge: expression syntax gotchas, 5 architectural workflow patterns, error-handling patterns, Code-node JS/Python constraints, AI agent design, binary data handling, sub-workflows.
- Kairos has 6 sub-patterns (`src/library/sub-patterns.ts`) and 124 validation rules. Their 14 skill domains are a **gap-analysis checklist** — see Phase 4.

### Zie619/n8n-workflows — dataset, use with care (55.5k★, "MIT")
- 4,343 raw n8n workflow JSONs in `workflows/`, organized by integration category. Claims 100% import success, 365 integrations, 29,445 nodes.
- **Legal caveat:** August 2025 "Repository History Rewrite" for DMCA compliance — content was scraped ("all of the workflows of n8n i could find (also from the site itself)"), and the MIT license is the repo author's claim over content they did not author. Kairos must NOT vendor, redistribute, or hardcode this dataset. A generic `--from-dir` ingestion feature that users point at any local folder is fine; the user's local library (~/.kairos) is personal use.

### Danitilahun/n8n-workflow-templates — SKIP as a separate source (695★, no license)
- **Correction to the earlier review:** this is not an independent second dataset. It claims the exact same statistics as Zie619 (29,445 total nodes, 365 unique integrations) — it is the same underlying scrape repackaged with a FastAPI browser, fewer stars, and NO license file. Strictly worse provenance. Ingesting both would mostly produce duplicates (the content-hash dedup in Phase 1 handles this anyway, but there is no reason to bother).

### enescingoz/awesome-n8n-templates — marginal (23.6k★, "CC-BY-4.0")
- 280+ actual JSON files across 18 categories. Same provenance problem, stated openly in its own disclaimer: "All automation templates... were found online... None of the templates are created or owned by the repository author." The CC-BY-4.0 grant is therefore hollow. Small volume; only worth ingesting as part of a generic `--from-dir` run if Jordan wants, never as a documented recommendation.

### Dev tooling (peripheral — not Kairos features)
- **oraios/serena** (semantic code navigation MCP): moderate value for working ON the Kairos repo as it grows past ~20k lines; zero value to Kairos users. Defer; revisit when navigation friction is actually felt.
- **Repomix, GitHub official MCP, awesome-claude-code:** fine as occasional utilities; no integration work warranted.

### Explicit skip list (agree with the earlier review)
Claude-Flow, SuperClaude, "The Hive," multi-agent orchestration frameworks, mega prompt/persona collections. They add token bloat and failure modes to solve coordination problems Kairos doesn't have. When customers need orchestration, write thin cron+state code inside Kairos.

## 4. Kairos-side readiness audit (what blocks bulk ingestion today)

Verified against the v0.8.0 source. These are the real constraints Phase 1/2 must address:

| # | Constraint | Location | Impact at 4k+ workflows |
|---|-----------|----------|------------------------|
| R1 | `TemplateSyncer` only fetches from `api.n8n.io` — no local-file path | `src/templates/syncer.ts` | Feature gap: `--from-dir` doesn't exist |
| R2 | Library cap is 500 (`KAIROS_LIBRARY_SIZE`, min 10); eviction by usage score | `src/library/file-library.ts:38-43` | 4,343 entries can't fit; naive ingestion causes eviction churn and evicts proven organic entries |
| R3 | `search()` re-tokenizes EVERY entry's corpus on EVERY query — O(N) tokenize per search, no cache | `file-library.ts` search(), `buildSearchCorpus` | Fine at 500; likely 100ms+ per search at 5k. Must cache doc tokens if cap is raised |
| R4 | Dedup in `save()` is by exact normalized description + n8nWorkflowId only | `file-library.ts` save() | Scraped datasets have near-duplicate descriptions and cross-repo copies; needs content-hash dedup |
| R5 | `assessTemplateSafety` BLOCKS any workflow containing a `code` node | `src/templates/safety.ts` BLOCKED_NODE_TYPES | Code nodes are ubiquitous in community workflows — likely 30-50% of the dataset gets dropped. Kairos's own generated workflows use Code nodes freely, so this is asymmetric |
| R6 | Embeddings warm lazily, 5 per search | `file-library.ts` | 4k entries ≈ 800 searches to warm the cache; needs bulk backfill during ingestion |
| R7 | `index.json` holds all meta, loaded on init | `file-library.ts` | ~5-15MB at 4k entries; acceptable but measure |

## 5. Phase 0 — Decisions (LOCKED 2026-07-02)

1. **Safety policy for `code` nodes in ingested workflows (R5):** DECIDED — demote `code` nodes to the `review` trust tier for local-dir ingestion (do NOT hard-block on `code` alone). Secret-pattern scanning remains a hard-block regardless of trust tier — this is non-negotiable (§2.1). `executeCommand`/`ssh` remain blocked. This decision is made safe by AMENDMENT B (§6): `imported` + `review` entries are never used for direct-mode full-JSON prompt injection, only reference mode (node list). That guard is what makes demoting code nodes acceptable — do not implement one without the other.
2. **Library size target (R2):** DECIDED — `--limit` default of 1,000, diversity-sampled (see AMENDMENT D in §6 for the sampling weighting).
3. **Docs stance on scraped datasets:** DECIDED — document the generic `--from-dir` feature with a neutral, hypothetical example path. Do not name, link, or endorse Zie619/Danitilahun/enescingoz or any other specific scraped repo anywhere in README, code comments, or CLI help text.
4. **Whether to run n8n-mcp side-by-side:** DECIDED — yes, in Jordan's own Claude Code MCP config. This is a config change on Jordan's machine only; zero Kairos repo changes, not part of any implementation phase.

## 6. Phase 1 — Bulk local ingestion: `kairos sync-templates --from-dir <path>`

The headline feature. Everything below rides on existing machinery.

**CLI surface:**
```
kairos sync-templates --from-dir ./some-dataset/workflows [--limit 1000] [--dry-run] [--include-code-nodes]
```

**Pipeline per file (reuse, don't rebuild):**
1. Read + JSON.parse (skip unparseable, count them).
2. **Normalize:** accept raw n8n JSON and common wrappers (some datasets nest under `workflow` or include `meta`/`pinData`). Extract `{name, nodes, connections, settings}`; default settings like `TemplateSyncer.processTemplate` does.
3. **Content-hash dedup (new, R4):** SHA-256 over a canonical form (sorted node types + connection topology + parameter keys — NOT parameter values, so trivially-reworded copies still dedup). Store as `sourceId` = hash prefix, `sourceKind: 'imported'` (the type already exists in `SourceKind`). Skip if a library entry with the same hash exists.
4. **Safety gate:** `assessTemplateSafety()` per the locked Phase 0 policy — `code` nodes alone escalate to `review`, not `blocked`; secret patterns and `executeCommand`/`ssh` remain hard-blocked regardless.
5. **Validation gate:** `validator.validate()`, drop entries with errors (same as `TemplateSyncer`).
6. **AMENDMENT A — description synthesis via sticky-note harvest:** many dataset files have empty/garbage names, and "name + node-type summary" alone adds almost no retrieval signal beyond what `buildSearchCorpus` already derives from node types. Community workflows very often carry their real documentation in `n8n-nodes-base.stickyNote` node `parameters.content` text. Harvest all sticky-note content in the workflow, concatenate it with the workflow name, and use that as the synthesized description (falling back to name + node-type summary only when no sticky notes exist). This is free, offline, and is where the actual human-written explanations live — it is the difference between imports actually moving the retrieval needle and imports being inert filler. Do NOT call an LLM for this in v1 — keep ingestion offline and free.
7. Save with full provenance: `sourceKind: 'imported'`, `sourceId: <hash>`, `sourceUrl: <file path>`, `trustLevel` from the safety result, auto-tags via the same logic as `TemplateSyncer`.

**AMENDMENT B — prompt-injection guard (required, implemented alongside the importer, not deferred):** `search()` currently only filters `trustLevel !== 'blocked'`. Once `review`-trust imported entries exist, a review-trust match could reach direct mode (score >= 0.92) and have its full JSON — including whatever a stranger wrote into code nodes and sticky notes — injected verbatim into the generation prompt. That is a prompt-injection channel via the library. Rule to implement in `prompt-builder.ts` `buildSystem()`: when `mode === 'direct'` and the top match has `sourceKind === 'imported' && trustLevel === 'review'`, downgrade that match to reference-mode presentation (node list only, per the existing `mode === 'reference'` branch) instead of injecting the full workflow JSON. Organic and `safe`-trust entries are unaffected. This guard is a prerequisite for the Phase 0 decision to demote code nodes to `review` rather than blocking them — the two ship together.

**Diversity-aware selection (R2):**
- After gating, cluster candidates with the existing `clusterWorkflows()` (node-fingerprint grouping).
- **AMENDMENT D — telemetry-weighted, not pure round-robin:** pure round-robin across ~365 integrations spends limit slots on exotic node types Kairos will rarely be asked to build (e.g. niche crypto or regional-service nodes) at the expense of the SMB automation patterns (email, sheets, Slack, scheduling, CRM) that are actually Kairos's business. Pull the workflow-type distribution from Kairos's own telemetry (`PatternAnalyzer` / `kairos patterns`, or the `workflowTypeBreakdown` already tracked on patterns) and bias cluster selection toward clusters matching frequently-built types, while still guaranteeing every previously-unrepresented cluster gets at least one slot (diversity floor). If no telemetry exists yet (fresh install), fall back to plain round-robin — do not fail or block ingestion.
- Within a cluster, prefer mid-size workflows (5-20 nodes) over trivial 2-node or monster 50-node ones.
- NEVER evict existing `organic` entries to make room for imports: imports fill only the space under the cap. If the cap is full of organic entries, report and stop.

**AMENDMENT C — mandatory rollback command, built in this phase, not deferred:** add `kairos library prune --source imported [--dry-run]`. Build the rollback before shipping the thing that might need rolling back. See the dedicated task/section below — this is a first-class Phase 1 deliverable, not a "consider it" footnote.

**UX:** `SyncProgress`-style summary (parsed / duplicate / blocked / invalid / selected / saved), `--dry-run` prints the report without saving.

**Tests (write first):** normalizer variants, sticky-note harvest (workflow with/without sticky notes → correct description), hash-dedup (identical topology + different param values → dup), safety policy branches (code node → review, secret pattern → still blocked), prompt-injection guard (imported+review top match → reference presentation, not full JSON), telemetry-weighted diversity selection (with and without existing telemetry), organic-entry protection, prune command (dry-run + real, count accuracy), dry-run ingestion persists nothing. Target: full suite green + ~20-25 new tests.

**Acceptance:** point at a directory of 50 mixed fixture files (create fixtures in `tests/fixtures/imported-workflows/`, hand-written — do NOT commit files copied from the scraped repos, include at least one fixture with sticky notes and one with a code node), get a correct report, correct library state, all counts accurate, and confirm `library prune --source imported` cleanly removes exactly the imported entries and nothing else.

### Phase 1 implementation notes (as actually built, 2026-07-02)

- New files: `src/templates/local-importer.ts` (normalize/hash/synthesize/select/orchestrate), `src/templates/text-clean.ts` (markdown stripper, extracted from `TemplateSyncer.cleanDescription` so both modules share it — `TemplateSyncer`'s public behavior is unchanged).
- `src/templates/safety.ts`: `assessTemplateSafety(workflow, options?)` gained an optional second arg `{ codeNodePolicy?: 'block' | 'review' }`, default `'block'` — every existing call site and all 20 existing tests are byte-for-byte unaffected. Local import passes `'review'` per the locked Phase 0 decision.
- `src/library/file-library.ts`: exported `MAX_LIBRARY_SIZE` (was module-private); added `pruneBySource()`. Fixed a real bug surfaced while building `pruneBySource`: `persist()`'s multi-process merge logic resurrected just-deleted entries from a stale on-disk copy, because it had no way to distinguish "added by another process" from "deleted by this one." Added an in-memory `deletedIds` set to disambiguate — this is a genuine correctness fix, not scope creep, since `pruneBySource` is the first deletion feature this codebase has ever had.
- `src/library/types.ts` + `src/library/null-library.ts`: `pruneBySource` added to `IWorkflowLibrary` (same pattern as `recordTrace` before it).
- `src/generation/prompt-builder.ts`: the AMENDMENT B guard is one added condition in the existing direct-mode branch — `sourceKind === 'imported' && trustLevel === 'review'` now takes the same node-list-only code path already used for oversized JSON, rather than a new branch.
- `src/cli.ts`: `kairos sync-templates --from-dir <path>` branches early inside `handleSyncTemplates`; `kairos library prune --source <kind>` is a new top-level `library` command with one subcommand.
- **Deviation from the original plan text, called out explicitly:** the plan's CLI surface sketch listed `--include-code-nodes` as an opt-in flag. Since Phase 0 fixed the *default* to `'review'` (not `'block'`), that flag name no longer made sense — it's now `--strict-code-nodes`, an opt-*in* to the old stricter blocking behavior. Documented in `HELP` and the CLI help section.
- **Known interaction, not silently resolved:** Phase 0 approved a `--limit` default of 1000, but the library's hard cap (`MAX_LIBRARY_SIZE`, default 500) is untouched — raising it is explicitly Phase 2 territory, gated on the search-latency benchmark (§7.2), not assumed here. `importFromDirectory` clamps its effective limit to whatever capacity is actually free under the current cap and reports the clamp via `capacityAvailable`; it refuses to evict organic entries (verified by a capacity-exhaustion test using a temporarily-lowered `KAIROS_LIBRARY_SIZE`). On a typical fresh-ish install this still allows a meaningful import; on an install with 500 organic entries already, `--from-dir` will import 0 until Phase 2's cap increase lands or `library prune` frees space. **Tell Jordan this explicitly — it's the single biggest judgment call in this implementation.**
- **CLI test isolation gap, not fixed here:** `kairos library prune` (and every other CLI command that touches the workflow library) always operates on the real `~/.kairos/library` — there's no `--library-dir` override or env var, unlike `KAIROS_TELEMETRY` which already sandboxes telemetry-dependent commands in tests. Because of this, the new CLI tests only exercise the safe paths (usage errors, `--dry-run`, which never writes) via real subprocess calls; the actual deletion logic is verified instead through direct unit tests against `FileLibrary.pruneBySource()`, which do use an isolated temp directory. Worth a `KAIROS_LIBRARY_DIR` env override at some point — flagging, not building it now, since it wasn't asked for.
- Tests added: 34 in `local-importer.test.ts`, 4 in `file-library.test.ts` (prune), 4 in `prompt-builder.test.ts` (guard), 7 in `cli.test.ts` (library prune + sync-templates --from-dir) = 49 new. Full suite: 788/788.

### Deferred follow-ups tracker — ALL THREE RESOLVED (2026-07-02, see §8a)

Two items flagged when Phase 1 shipped, plus a third found during Phase 3. All deliberately *not* fixed inline when found — each deserved its own deliberate pass rather than a rushed bolt-on. Jordan asked for that dedicated pass once Phases 1–3 were done; the plan for it is §8a below, and all three are now resolved.

1. **`--limit` (1000) vs. `MAX_LIBRARY_SIZE` (500) tension** — §6 "Known interaction" above. **RESOLVED** in `2391555`: default raised 500 → 1500 (§8a item 1 for the full reasoning). Verified via search-latency data measured in Phase 2, not guessed.
2. **CLI test isolation gap** — §6 "CLI test isolation gap" above. **RESOLVED** in `fe124d8`: added `KAIROS_LIBRARY_DIR` mirroring the existing `KAIROS_TELEMETRY` pattern, threaded through all 7 `FileLibrary` call sites in `cli.ts`, and added the two real (non-dry-run) CLI mutation tests this was blocking.
3. **Benchmark suite has hit a ceiling (found during Phase 3, §8 implementation notes)** — **RESOLVED (structurally)** in `ade5e5b`: added `TIER_RANGES` + `--tier <name>` to `scripts/benchmark.ts`. Note the scope of "resolved" here — the *capability* to select a harder tier now exists and was verified for free (source-level partition check, zero-cost arg-parsing smoke tests); actually spending API money to re-run a harder tier and get a fresh discriminating number is a separate decision, deliberately not bundled in, under the same budget-approval norm as Phase 3.

*(Space for further additions — append below this line as they're found, don't edit the items above until they're actually resolved.)*

---

## 8a. Judgment Calls — Resolution Plan (2026-07-02)

Jordan asked for this dedicated pass now that Phases 1–3 are done. Same protocol as every phase before it: plan first, tests-first where feasible, all 4 gates before each commit, one commit per item, check in between items rather than batching silently.

### Item 1 — Raise `MAX_LIBRARY_SIZE`'s default (500 → 1500)

- **What:** Change the fallback default in `src/library/file-library.ts` (`parseInt(process.env['KAIROS_LIBRARY_SIZE'] ?? '500', 10)` → `'1500'`, and the two `?? 500` type-guard fallbacks alongside it).
- **Why:** This is the actual decision the Phase 2 benchmark was built to inform, deliberately not pulled the trigger on inside Phase 2 itself (a shipped-default change deserves its own moment, not to ride in on the PR that built the measuring stick). The data supports it outright: 1500 entries costs 683 KB of `index.json` and ~12ms warm-search / ~21ms cold-search — both trivial next to the multi-second LLM round-trip every `build()` call already makes. 1500 (not 2000) is chosen specifically because it comfortably covers Jordan's current real library (292 entries) *plus* the Phase-0-approved 1000-entry `--limit` for a single bulk import, with headroom left over for organic growth — going to 2000 buys more headroom at a real disk-size cost (1.8 MB at 4000 in the benchmark table) for no benefit anyone has asked for.
- **How:** Single-line default change plus a scan for any test or doc that hardcodes the old `500` value as an expectation (not just as an example env var).
- **Where:** `src/library/file-library.ts` lines 38-39 (the two `?? 500` sites already share one `_rawSize` computation, so this is genuinely a one-line change) — confirmed no test in `file-library.test.ts` or `local-importer.test.ts` asserts the literal default value (the capacity-exhaustion test in `local-importer.test.ts` explicitly sets `KAIROS_LIBRARY_SIZE=10` for its own isolated scenario, so it's unaffected by the default changing).
- **When:** First item, since it's the most consequential and the one the whole Phase 2 benchmark chain exists to unblock.
- **Methodology / guardrails:** This is a real behavioral change (bigger `index.json` ceiling, marginally slower search for every user by default, not just `--from-dir` users) — but it's bounded, reversible via `KAIROS_LIBRARY_SIZE`, and backed by first-party measurement rather than a guess. Verify: unit test asserting the new default (1500) when the env var is unset; existing env-var-override tests continue to pass unchanged. Update the README wherever the old default is implied. Gates + commit.

### Item 2 — `KAIROS_LIBRARY_DIR` env override for CLI-instantiated `FileLibrary`

- **What:** A new env var, read the same way `KAIROS_TELEMETRY` already is (`getTelemetryOption()` in `cli.ts`), that overrides the directory every CLI-constructed `FileLibrary` points at.
- **Why:** Every CLI test that touches the library today either avoids real mutation (dry-run only) or would mutate Jordan's actual `~/.kairos/library` if it didn't. This was explicitly called out as untested surface after Phase 1 (`library prune`'s real deletion path, `sync-templates --from-dir`'s real save path) — both were verified via direct `FileLibrary` unit tests instead, which is a legitimate fallback but leaves the CLI *wiring itself* (arg parsing → handler → FileLibrary call) unverified end-to-end.
- **How:** Add `getLibraryDirOption(): string | undefined` mirroring `getTelemetryOption()`'s shape, then thread it through every `new FileLibrary()` call site in `cli.ts` — there are 7: `createClient()` (line 138), `createDryRunClient()` (151), `handleSyncTemplates()`'s n8n.io path (303), `handleLocalImport()` (357), `handleLibraryPrune()` (385), `handleTrace()` (790 — already passes an explicit path equal to the real default, so this becomes the override-aware version of that same line), `handleInit()` (927).
- **Where:** `src/cli.ts`, all 7 sites above, plus the `HELP` text's Environment variables section (mirroring the existing `KAIROS_TELEMETRY` line) and the README's environment variable table.
- **When:** Second item — depends on nothing from item 1, but doing it second keeps the diff reviewable one concern at a time.
- **Methodology / guardrails:** Once this lands, add the previously-blocked tests: a real (non-dry-run) `library prune` CLI subprocess test and a real (non-dry-run) `sync-templates --from-dir` save-and-verify CLI subprocess test, both pointed at a `KAIROS_LIBRARY_DIR`-overridden temp directory — closing the exact gap this item exists to close, not just adding the plumbing and leaving it unexercised. Gates + commit.

### Item 3 — Benchmark suite tier selection (structural fix, not a re-run)

- **What:** Add machine-readable tier boundaries to `scripts/benchmark.ts`'s `PROMPTS` array (currently only comment-marked) and a `--tier <name>` CLI flag, so a harder subset can be selected without hand-editing the script. Confirmed tier boundaries by direct read: Simple 0-9 (10), Medium 10-24 (15), Complex 25-34 (10), Edge cases 35-44 (10), Real-world 45-54 (10), Stress tests 55-64 (10), Additional 65-84 (20) — sums to 85, matching the known total.
- **Why:** The ceiling-effect finding from Phase 3 means the default `--count 20` (which only ever runs the Simple tier plus the first 10 of Medium) can no longer discriminate anything. The fix Jordan needs is the *capability* to run a harder slice on demand — not necessarily spending real API money to actually re-run it right now, which is a separate decision under the same budget-approval norm as Phase 3.
- **How:** Restructure `PROMPTS` from `string[]` to keep the flat array (avoid a risky full rewrite of 85 hand-tuned prompt strings) but add a parallel `TIER_RANGES: Record<string, [number, number]>` constant with the exact boundaries above, plus a `--tier <name>` flag that slices by range instead of `PROMPTS.slice(0, count)` when provided. `--tier all` (or no `--count`/`--tier` at all) runs everything. Keep `--count` working unchanged for backward compatibility with the existing `npm run benchmark` / `benchmark:baseline` scripts.
- **Where:** `scripts/benchmark.ts` only — no `src/` changes, so this item touches zero production code.
- **When:** Third — independent of items 1 and 2, lowest risk (a benchmarking dev-tool, not shipped SDK behavior), and naturally the item to close out this pass before Phase 4.
- **Methodology / guardrails:** **No spend without asking.** Building the `--tier` flag itself costs nothing. Actually running it (even once, on one tier) is real Anthropic API money exactly like Phase 3 — after building the capability, ask Jordan explicitly whether he wants to spend anything to demonstrate it produces a discriminating signal, rather than assuming yes. `scripts/*.ts` isn't covered by `tsc --noEmit` (confirmed during Phase 1 — `tsconfig.json`'s `include` is `["src"]` only), so verification here is a manual `tsx scripts/benchmark.ts --tier complex --no-library` argument-parsing smoke check (no real prompt/API call needed to verify the *slicing logic* — a `--help`-style dry inspection of which prompts would run is enough) rather than the full 4-gate CI protocol (which doesn't apply to `scripts/`). Gates for `src/` still run as a final sanity check that this change touched nothing under `src/`.



1. **Doc-token caching (R3):** cache `tokenize(buildSearchCorpus(meta))` per entry, invalidated on save. In-memory `Map<id, string[]>` on `FileLibrary` is sufficient; do NOT persist tokens to index.json (bloat).
2. **Search latency benchmark:** add a micro-benchmark script (`scripts/search-bench.ts`) measuring search at 100/500/1500/4000 entries. Gate any cap-raise on measured numbers, not vibes.
3. **Embedding backfill (R6):** if the library was constructed with an `embeddingFn`, offer `--backfill-embeddings` during ingestion (batched, respects the 2s/call timeout, saves via the existing `embeddingWriteQueue`).
4. **Measure `index.json` size and init time (R7)** at the chosen cap; if init exceeds ~200ms, consider lazy meta loading — but don't build it speculatively.

### Phase 2 implementation notes (as actually built, 2026-07-02)

- **Doc-token cache (R3):** `FileLibrary` gained a private `docTokenCache: Map<string, string[]>`, populated lazily inside `search()` (same call site that used to call `tokenize(buildSearchCorpus(w))` unconditionally). Invalidated in exactly two places: the `save()` redeploy branch (description/workflowName/cachedNodeTypes changed) and `pruneBySource()`. Never persisted — rebuilt from `meta` on demand, `meta` stays the single source of truth.
- **Bug found and fixed while building this (same class as Phase 1's `deletedIds` bug):** the embedding cache had the identical staleness problem — a redeployed entry's embedding vector was computed from the OLD description/tags and, because `search()`'s lazy backfill only computes vectors for entries *not already cached*, would never self-correct. Fixed with `this.embeddingCache.delete(existing.id)` alongside the doc-token invalidation in the same redeploy branch, plus cleanup in `pruneBySource()`. This was pre-existing latent behavior, not something Phase 2 introduced — it was just unreachable before `pruneBySource` (Phase 1) and this cache-correctness pass gave a reason to look at it.
- **Search latency benchmark (`scripts/search-bench.ts`, new):** measures cold (empty-cache) vs. warm (cache-populated) `search()` latency, `index.json` size, and a fresh instance's `initialize()` time, at configurable sizes (`--sizes`, default 100/500/1500/4000). Real run (`KAIROS_LIBRARY_SIZE=5000` to bypass the default cap during measurement — it's read at module-load time, so it must be set in the environment before the process starts, not inside the script):

  | Entries | `index.json` | `initialize()` | Cold search | Warm search (avg) | Cache speedup |
  |---|---|---|---|---|---|
  | 100 | 46.2 KB | 0.6ms | 3.9ms | 1.1ms | 3.5x |
  | 500 | 227.3 KB | 1.4ms | 7.8ms | 4.6ms | 1.7x |
  | 1500 | 683.3 KB | 5.5ms | 20.8ms | 11.9ms | 1.7x |
  | 4000 | 1818.2 KB | 9.4ms | 51.3ms | 24.8ms | 2.1x |

  Two findings: (1) the doc-token cache cuts cold-search cost by roughly half to two-thirds at every size tested, but search still scales ~linearly with entry count — caching removes the tokenization cost, not the O(N) scoring/clustering work `hybridScore`/`clusterWorkflows` do over every entry, so it is not a fix for unbounded growth, only a multiplier improvement. (2) even the worst case measured (51ms cold search at 4000 entries) is negligible next to the multi-second LLM call every `build()` already makes — nothing here argues against raising the cap; see the tracker item above for why that raise isn't executed in this same commit.
  - **Real bug hit while first running this script:** the initial run showed nearly-identical numbers for 500/1500/4000 entries — turned out `MAX_LIBRARY_SIZE`'s default (500) was silently evicting entries during seeding, so all three "sizes" were actually measuring the same post-eviction 500-entry library. Fixed by documenting (in the script's own usage comment) that `KAIROS_LIBRARY_SIZE` must be set in the environment, not passed as a script flag, since it's read once at module import time.
  - **Second bug hit:** the cleanup `rm(dir, ...)` intermittently failed `ENOTEMPTY` — each `search()` call triggers a fire-and-forget `persist()` to update `timesRetrieved` counters, racing the directory removal. Same class of bug the test suite's `afterEach` already guards against; fixed by calling `lib.drain()` again after the search-timing loop, before `rm()`.
- **Embedding backfill (R6):** `FileLibrary.backfillEmbeddings(batchSize = 20)` — bulk-computes and caches embeddings for every not-yet-cached entry, processed in bounded batches (vs. search()'s existing 5-per-call lazy trickle), reusing the existing `computeEmbedding()` timeout and `embeddingWriteQueue`. No-ops (`{computed: 0, skipped: 0}`) when the library has no `embeddingFn` configured.
  - **Scope decision, not silently cut:** the plan text suggested a `--backfill-embeddings` CLI flag "during ingestion." Not built — the CLI has **no mechanism at all** to configure an `embeddingFn` today (every `new FileLibrary()` call site in `cli.ts` passes no options; there's no `OPENAI_API_KEY`-equivalent env var handling). A CLI flag would be dead/no-op for every current user. What's shipped instead is the reusable, tested capability at the `FileLibrary` level — any SDK caller who constructs `new FileLibrary(dir, { embeddingFn })` themselves (with their own embedding provider) can call `library.backfillEmbeddings()` after a bulk import. Wiring an actual embedding-provider config into the CLI is new scope beyond "library scaling for ingestion" and would need its own decision, not a bolt-on here.
  - Not added to the `IWorkflowLibrary` interface — consistent with how `embeddingFn` itself has always been `FileLibrary`-only and has no `NullLibrary` equivalent.
- **`index.json` size / `initialize()` time (R7):** measured directly by the same benchmark script (table above). Verdict: even at 4000 entries, `initialize()` is 9.4ms — nowhere near the ~200ms threshold that would justify lazy meta loading. Confirmed by measurement, not built speculatively, per the plan's own instruction.
- Tests added: 3 in `file-library.test.ts` for the doc-token cache (reuse-is-transparent, redeploy invalidation, prune invalidation), 5 for `backfillEmbeddings` (no-op without embeddingFn, batched bulk compute, skip-on-failure counting, no-recompute-when-cached, redeploy invalidation). `scripts/search-bench.ts` is a manual measurement tool, not part of the automated suite (matches `scripts/benchmark.ts`'s existing precedent — real Anthropic API usage / long-running by design, not CI material).

## 8. Phase 3 — The honest benchmark re-run (owed independently, doubly valuable now)

The README currently (correctly) caveats that benchmark numbers predate the 124-rule validator. After Phase 1:
1. Re-run `scripts/benchmark.ts` baseline (no library) under the 124-rule validator.
2. Re-run with the current organic library.
3. Re-run with organic + imported corpus.
4. Publish all three in the README, replacing the caveated table. This simultaneously restores benchmark honesty and measures exactly what the ingestion feature bought. Requires ANTHROPIC_API_KEY spend — get Jordan's go-ahead on budget first.

**AMENDMENT E — success/failure criterion, defined up front, not post-hoc:** success is organic+imported first-try pass rate ≥ organic-only first-try pass rate (step 3 ≥ step 2). If imports measurably *drop* the rate, the contract is: run `kairos library prune --source imported` and report the negative result honestly in the README/commit — not rationalize, not cherry-pick, not quietly re-run until a better number appears. A single run of 20 prompts is noisy; if budget allows, run the seeded (step 3) configuration twice and report both, or note in the writeup that it was a single run if not.

### Phase 3 implementation notes (as actually run, 2026-07-02)

- **Budget gate honored:** Jordan approved ~$1.50-3 in Anthropic API spend before anything ran (per the plan's own requirement). Key was loaded from the repo's `.env` (gitignored, confirmed via `git check-ignore` before touching it) — never echoed to any tool output, never written anywhere else, never committed.
- **All three configurations run** against the real `claude-sonnet-4-6` model (Kairos's default): (1) baseline, no library; (2) current real library (292 entries: 51 organic + 241 n8n-template); (3) same library + 14 hand-authored fixture workflows imported via the new `sync-templates --from-dir` feature.
- **Result: all three hit 100% first-try pass, 1.00 avg attempts, near-identical duration (~20-21s).** This is a real, honest finding, not a data-collection failure — verified by actually running all three configs, not assumed. The accumulated system-prompt improvements (node catalog, sub-patterns, intent mapping) plus the jump from 34 to 124 validator rules have together closed the gap this specific 20-prompt suite used to measure. Consequence: **the suite has hit a ceiling and can no longer discriminate library-seeding's or the new import feature's contribution** — this is reported plainly in the README rather than dressed up, along with a recommendation to move to a harder prompt set (the full 85-prompt array already in `scripts/benchmark.ts`, most of it unused by the default `--count 20`) for future comparisons that need real signal.
- **Amendment E's literal criterion was met** (100% ≥ 100%) — the imports caused no regression. But given the ceiling effect, this is a weaker result than the amendment anticipated: it confirms the feature is *safe*, not that it *helps*, on this test set.
- **No scraped/vendored dataset was used for config 3,** consistent with §3's DMCA/provenance stance. 14 small workflows covering distinct patterns (webhook→Slack, schedule→email, AI classifier, batch processing, etc.) were hand-authored specifically for this benchmark, imported for real via the actual CLI command (dry-run verified first, 0 failures), the benchmark run, then **pruned back out via `kairos library prune --source imported`** — Jordan's real library was verified to return to its exact prior state (292 entries, same source-kind split) afterward. This was also the first time `pruneBySource` and its `deletedIds` fix ran against real (non-test) data, and it worked correctly.
- **README updated, not just noted:** replaced the stale 55%→100% headline table with the current three-way comparison, moved the old number to a clearly-labeled "historical result, superseded" section, fixed the other stale 55%→100% reference in the template-seeding paragraph, and added the missing `sync-templates --from-dir` / `library prune` documentation (CLI examples + feature description) that Phase 1 had built but never written up in the README. Result JSON files committed alongside: `benchmark-results.json` (baseline, overwritten), `benchmark-seeded-results.json` (current library, overwritten), `benchmark-imported-results.json` (new).
- **Not done:** a harder benchmark suite. Flagged as the natural next step for whoever wants a discriminating number in the future, not built here — out of scope for "re-run the existing benchmark honestly."

## 9. Phase 4 — Knowledge extraction from n8n-skills (study, re-encode, no copying)

Gap analysis of their 14 skill domains against Kairos's assets:
- For each domain, check: does Kairos have (a) a validator rule, (b) a sub-pattern, (c) a RULE_MITIGATION, (d) system-prompt coverage?
- Known likely gaps to check first: webhook payload under `$json.body` (their expression skill), Code-node Python limitations, binary-data handling, sub-workflow composition patterns, per-node error-output wiring (`continueOnFail`/error outputs).
- Output: new sub-patterns in `src/library/sub-patterns.ts` and/or new validation rules (follow the established rule-addition protocol: implement + dispatch + `VALIDATOR_RULE_IDS` + `RULE_PIPELINE_STAGES` + `RULE_MITIGATIONS` + tests — drift detection enforces the metadata half automatically).
- Cap: pick the 3-5 highest-frequency failure modes, not all 14 domains. Evidence for "highest-frequency" comes from Kairos's own telemetry (`kairos patterns`), not their claims.

### Phase 4 gap analysis findings (2026-07-02)

**Telemetry check first, as the plan requires.** Jordan's real `~/.kairos/patterns.json`: 137 builds, 91% first-try pass rate. Only two *active* (non-resolved) failure patterns exist at all: Rule 17 (credential shape, `confirmed` state, composite score 0.046 — small and already tracked) and Rule 14 (missing trigger, `draft`, score 0.001 — negligible). **Neither maps to an n8n-skills domain Kairos is missing** — this telemetry sample is narrow (Jordan's own build history, concentrated on email/Slack/Sheets/schedule automation) and simply hasn't exercised most of the 14 domains yet, so absence of telemetry signal for them isn't evidence they're not real gaps — it's evidence the sample is too narrow to tell. Used the plan's own "known likely gaps" list as the primary candidate set instead, and verified each directly against the actual source (grep, not assumption) rather than trusting n8n-skills' framing.

**Per-domain verification (grepped `src/generation/prompts/v1.ts`, `src/validation/validator.ts`, `src/library/sub-patterns.ts` directly):**

| Candidate | Finding | Verdict |
|---|---|---|
| Webhook payload under `$json.body` | Zero mentions anywhere in prompt, validator, or sub-patterns | **Genuine gap** |
| Binary data (`$binary`, `binaryPropertyName`) | Rule 57 covers exactly one narrow case (HTTP Request binary *upload* with empty `binaryPropertyName`) — nothing broader (reading binary from downloads, S3/Drive/email attachments, `$binary` expression access) | **Genuine gap** (Rule 57 stays; extend, don't duplicate) |
| Code-node Python vs JavaScript | System prompt's node catalog documents only `mode, jsCode` — no mention of the `language` param or `pythonCode`. Existing Rule 124 already reads `params['language'] === 'python'` correctly elsewhere in the validator, confirming the real param name/values to build against (not guessed) | **Genuine gap** (prompt coverage + one precise new rule) |
| Per-node error-output port wiring | Rule 56 already exists (continueOnFail/`onError` set but no downstream `$json.error` check) — but it flattens all `main` output ports together rather than checking specifically whether output port **1** (the dedicated error branch n8n creates when `onError: 'continueErrorOutput'` is set) has any connection at all. A node with that setting and only port 0 wired silently drops every error-path item — a different, more precise bug than what Rule 56 catches | **Genuine narrow gap** (Rule 56 stays; add a companion rule, don't touch Rule 56) |
| Sub-workflow composition | Rule 49 (missing `workflowId`), Rule 81 (infinite self-call loop), Rule 84 (inline `toolWorkflow` missing entry trigger), plus system-prompt coverage | **Already covered** — not pursued |
| The other ~9 n8n-skills domains (MCP Tools Expert, Multi-Instance, Self-Hosting, Validation Expert, Node Configuration, Workflow Patterns, AI Agents, Code Tool, general Error Handling) | Either about *using* n8n-mcp or deploying n8n itself (not Kairos's generation-quality concern — Kairos has its own `kairos_sync` for live-instance targeting), or already substantially covered by Kairos's own intent-to-component mapping (7 intents), `ai-agent-tool-wiring` sub-pattern, and the validator's own error-handling rules (56, 78) | **Not pursued** — confirmed covered or out of scope, not skipped from laziness |

**Selected 4 items** (within the plan's 3-5 cap):

1. **New sub-pattern `webhook-body-access`** — guidance only, no new validator rule. The correctness of `$json.body.field` vs `$json.field` depends on webhook response-mode/content-type configuration the validator can't reliably infer statically; a rule here risks real false positives in both directions. Sub-pattern injection (intent-triggered, not always-on) is the safer mechanism — matches how `luxon-datetime` already handles a similarly fuzzy-to-validate expression convention.
2. **New sub-pattern `binary-data-handling`** — same reasoning: guidance only. References Rule 57 by number for the one case that *is* safely checkable; the broader convention (binary data lives in a sibling `binary` object per item, not under `json`) is prompt-injectable knowledge, not a safe validator target.
3. **New validator rule (127): Code node `language`/param mismatch** — WARN when `language === 'python'` but `jsCode` is populated instead of `pythonCode` (or the reverse: `language` unset/`'javaScript'` but only `pythonCode` is populated). Narrow, structural, verified against the exact param convention Rule 124 already uses — low false-positive risk.
4. **New validator rule (128): unwired error-output port** — WARN when `onError === 'continueErrorOutput'` (n8n gives the node a second output port at that point) but `connections[node.name].main[1]` has no entries. Companion to Rule 56, not a replacement — Rule 56 catches "no error check downstream," this catches "error output has nowhere to go at all," a distinct and more precise failure.

**Not done:** rules/sub-patterns for the other domains — confirmed via direct source inspection they're either already covered or out of Kairos's scope, not left unexamined. Per the established protocol: new rules get dispatched in `validate()`, added to `VALIDATOR_RULE_IDS` (next slot: 127-128, extending the 105-126 range), `RULE_PIPELINE_STAGES`, `RULE_MITIGATIONS` — drift detection (`detectDrift()` in `pattern-analyzer.ts`) enforces the metadata half automatically, so a missing entry surfaces as a `missing_mitigation`/`missing_stage_mapping` alert rather than failing silently. Tests first, all 4 gates, one commit for the phase (matching how Phase 1's five amendments were one commit, not five).

## 10. Phase 5 (deferred) — Node property-schema enrichment

n8n-mcp's depth comes from extracting property schemas from n8n packages (2,063 nodes, 99% property coverage). Kairos's `DEFAULT_REGISTRY` has ~70 nodes with mostly-empty `requiredParams`, and `kairos_sync` gets only shallow data from the public `/node-types` API. The enrichment path: a build-time script that installs `n8n-nodes-base` + `@n8n/n8n-nodes-langchain` as dev-deps and extracts `{type, requiredParams, credentialType, operations}` into a generated registry file. This would power stronger per-node validation and richer prompt catalogs.
**Deferred because:** meaningful engineering; the live-instance sync already covers "does this node exist here"; and Phases 1-4 have better effort/reward. Revisit when validator telemetry shows param-level failures Kairos can't currently catch.

## 11. Non-goals

- No dependency on, vendoring of, or bundled redistribution of any external dataset.
- No multi-agent orchestration frameworks (Claude-Flow, SuperClaude, etc.).
- No competing with n8n-mcp on node documentation breadth.
- No LLM calls during ingestion (keep it offline/free in v1).
- No serena/Repomix integration work — usable ad hoc, zero code changes.

## 12. Execution order & verification protocol

Order: Phase 0 (Jordan) → 1 → 2 → 3 → 4. Phase 5 stays parked.
Per phase: tests first where feasible → implement → `npm run build && npm run typecheck && npm run lint && npm test` → commit (one phase per commit, message cites this plan) → show Jordan the summary before starting the next phase.

## 13. Risks

| Risk | Mitigation |
|------|-----------|
| DMCA/licensing exposure from scraped datasets | Generic feature, user-supplied paths, no vendoring/endorsement, provenance recorded per entry |
| Library pollution degrades retrieval | Diversity selection (telemetry-weighted, AMENDMENT D), organic-entry protection, validation+safety gates, `trustLevel` preserved, rollback via `kairos library prune --source imported` (AMENDMENT C — built in Phase 1, not deferred) |
| Prompt injection via imported workflow content (code nodes / sticky notes written by strangers) | AMENDMENT B: imported+review entries never used for direct-mode full-JSON injection, reference mode only |
| Search latency regression | Token caching + measured benchmark gate before any cap raise |
| Duplicate flood from overlapping repos | Content-hash dedup on topology, not text |
| Secrets inside scraped workflow params | Existing secret-pattern hard-block; never demote this gate |
| Benchmark spend surprises Jordan | Explicit budget confirmation before Phase 3 |
