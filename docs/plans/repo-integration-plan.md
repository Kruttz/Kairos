# Repo Integration Plan — for Opus 4.8

**Written by:** Fable 5 (audit session, 2026-07-02)
**Executor:** Opus 4.8, in future Claude Code sessions with Jordan
**Status:** PHASE 1 COMPLETE (2026-07-02, implemented by Fable 5 — this plan was executed in the same session it was approved in, ahead of the original hand-off-to-Opus-4.8 intent; noted here for continuity). Phase 0 decisions locked (§5). All five amendments implemented (§6). Build + typecheck + lint + tests all green: 788/788 (49 new). Not yet committed to git as of this edit — see the end of §6 for the exact diff. Phases 2–4 remain unstarted; resume there.

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

## 7. Phase 2 — Library scaling (only what ingestion actually needs)

1. **Doc-token caching (R3):** cache `tokenize(buildSearchCorpus(meta))` per entry, invalidated on save. In-memory `Map<id, string[]>` on `FileLibrary` is sufficient; do NOT persist tokens to index.json (bloat).
2. **Search latency benchmark:** add a micro-benchmark script (`scripts/search-bench.ts`) measuring search at 100/500/1500/4000 entries. Gate any cap-raise on measured numbers, not vibes.
3. **Embedding backfill (R6):** if the library was constructed with an `embeddingFn`, offer `--backfill-embeddings` during ingestion (batched, respects the 2s/call timeout, saves via the existing `embeddingWriteQueue`).
4. **Measure `index.json` size and init time (R7)** at the chosen cap; if init exceeds ~200ms, consider lazy meta loading — but don't build it speculatively.

## 8. Phase 3 — The honest benchmark re-run (owed independently, doubly valuable now)

The README currently (correctly) caveats that benchmark numbers predate the 124-rule validator. After Phase 1:
1. Re-run `scripts/benchmark.ts` baseline (no library) under the 124-rule validator.
2. Re-run with the current organic library.
3. Re-run with organic + imported corpus.
4. Publish all three in the README, replacing the caveated table. This simultaneously restores benchmark honesty and measures exactly what the ingestion feature bought. Requires ANTHROPIC_API_KEY spend — get Jordan's go-ahead on budget first.

**AMENDMENT E — success/failure criterion, defined up front, not post-hoc:** success is organic+imported first-try pass rate ≥ organic-only first-try pass rate (step 3 ≥ step 2). If imports measurably *drop* the rate, the contract is: run `kairos library prune --source imported` and report the negative result honestly in the README/commit — not rationalize, not cherry-pick, not quietly re-run until a better number appears. A single run of 20 prompts is noisy; if budget allows, run the seeded (step 3) configuration twice and report both, or note in the writeup that it was a single run if not.

## 9. Phase 4 — Knowledge extraction from n8n-skills (study, re-encode, no copying)

Gap analysis of their 14 skill domains against Kairos's assets:
- For each domain, check: does Kairos have (a) a validator rule, (b) a sub-pattern, (c) a RULE_MITIGATION, (d) system-prompt coverage?
- Known likely gaps to check first: webhook payload under `$json.body` (their expression skill), Code-node Python limitations, binary-data handling, sub-workflow composition patterns, per-node error-output wiring (`continueOnFail`/error outputs).
- Output: new sub-patterns in `src/library/sub-patterns.ts` and/or new validation rules (follow the established rule-addition protocol: implement + dispatch + `VALIDATOR_RULE_IDS` + `RULE_PIPELINE_STAGES` + `RULE_MITIGATIONS` + tests — drift detection enforces the metadata half automatically).
- Cap: pick the 3-5 highest-frequency failure modes, not all 14 domains. Evidence for "highest-frequency" comes from Kairos's own telemetry (`kairos patterns`), not their claims.

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
