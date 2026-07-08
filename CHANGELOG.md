# Changelog

All notable changes to `@kairos-sdk/core` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); dates are publish dates from npm.

## [Unreleased]

### Fixed: credentials.md grouping key could silently merge two distinct credentials
A second, independent review caught a real regression in the NUL-byte fix above: replacing the literal NUL byte with a plain space (`` `${cred.service} ${cred.credentialType}` ``) is not collision-safe. `service="Google", credentialType="Sheets OAuth"` and `service="Google Sheets", credentialType="OAuth"` both join to the identical string `"Google Sheets OAuth"` — two genuinely different credentials would have silently merged into one `credentials.md` entry, attributing one workflow's credential description and "needed by" list to the other's. The earlier commit's "no behavior change" claim was incorrect for this case (it was correct for the byte-identity/typecheck/full-suite checks actually run, but those checks didn't include a collision scenario).

Replaced the space join with `JSON.stringify([cred.service, cred.credentialType])`, which preserves the exact field boundary regardless of what either string contains -- not just a different single-character delimiter, which would only move the same class of collision to a different (still guessable) pair of inputs.

Verified empirically, not just by inspection: temporarily reverted to the space-joined key, confirmed the new regression test actually fails against it, then restored the fix and confirmed it passes.

Tests: 1 new regression test (the exact colliding pair from the review, confirming both remain distinct `## Google` / `## Google Sheets` sections with correctly separated descriptions and "needed by" workflows). 1219/1219 passing overall. Typecheck/lint clean.

### Fixed: Step 5 provenance closure pass (Codex review)
An independent review of the provenance tuple above found real gaps before it shipped. All addressed in one closure pass, 7 commits:

- **The biggest one: `BuildResult.provenance` was silently discarded at the pack-builder boundary.** `pack-builder.ts`'s build loop only ever copied `workflowId`/`deployed`/`generationAttempts`/`credentialsNeeded`/`finalIssues` from each `Kairos.build()` result onto `PackWorkflowResult` -- provenance never reached `PackWorkflowResult`, `WorkflowPackResult`, or (transitively) `BundleManifest`. Added `PackWorkflowResult.provenance?: BuildProvenance`, copied through.
- **Bundle-manifest per-workflow hash only ever answered "what does this look like now," never "what did Kairos build."** Renamed the ambiguous `workflowHash` to `liveExportHash` (fresh live-fetch, unchanged behavior) and added `originalBuildHash` (from the now-preserved `PackWorkflowResult.provenance.workflowHash`) alongside it -- both raw values recorded, comparing them (build-vs-live drift) is left to the consumer, not auto-classified.
- **No way to tell which Kairos release produced a build/bundle.** Added `getKairosVersion()`, reading the nearest `package.json` by walking up parent directories rather than a fixed number of `../` segments -- this file's depth under `src/` doesn't match its depth under the flat `dist/` tsup produces, so the fixed-depth pattern `mcp-server.ts` already uses wasn't safe to copy here.
- **`computeWorkflowHash()` had no algorithm/schema version.** A future change to the canonicalization logic would have been silently indistinguishable from a real workflow change. Every hash now carries a `w1:` schema-version prefix, bumped whenever the algorithm itself changes.
- **`promptVersion` only ever hashed the static base template, not what was actually sent.** `PromptBuilder.buildSystem()` dynamically assembles the real per-request prompt (node catalog substituted in, reference/pattern/memory blocks appended per profile) -- hashing that would produce a per-build fingerprint, not a stable version. Renamed to `promptTemplateVersion` with an honest doc comment, and added a separate `promptProfile` field (which `KAIROS_PROMPT_PROFILE` value shaped this build) as the other real, cheaply-recorded input the base-template hash alone can't capture.
- **Activation provenance was never implemented**, despite being listed in the original plan. Explicitly moved to Step 6's `workflow_activated` ledger event instead of leaving it silently unaddressed (`docs/plans/hardening-and-chaining-plan.md`).
- **Separate hygiene fix, its own no-behavior-change commit:** `pack-bundle.ts` contained a literal NUL byte inside a Map-key template string (harmless at runtime, but made `grep`/`file` treat the whole source file as binary) -- replaced with a real space.
- **The "restore candidate, not rollback" documentation gap**, called out in the original Step 5 plan but not yet written: `handoff.md` now explicitly states that an exported `workflow.json` is a restore candidate, not a one-command rollback -- redeploying it can still need credentials reconnected, webhooks re-registered, and a matching n8n version, none of which the JSON alone restores.

Tests: ~55 new/updated across nine files, including build-vs-live drift tests using real computed hashes (not placeholder strings) for both the no-drift and drift-detected cases, and a mixed-pack test (one workflow with recorded provenance, one without). 1218/1218 passing overall. Typecheck/lint clean.

### New: provenance tuple across BuildResult, bundle manifests, and preflight
Answers "what was actually true when this was built/exported" without any diffing, history, or rollback mechanic -- purely additive data, no new checks fail because of it.

**`BuildResult.provenance`** (new, optional field): real `model`/`maxTokens` this Kairos instance was constructed with, the final attempt's actual `temperature`, the same `runId` already used for telemetry, plus three content-derived identifiers -- `ruleSetVersion` (hash of the active rule ID list), `promptVersion` (hash of the live system prompt string), `nodeCatalogVersion` (the exact pinned `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` versions the catalog was generated from) -- and `workflowHash`, a new deterministic content hash (`src/utils/workflow-hash.ts`) sensitive to nodes/connections/settings. None of these are manually-bumped constants; all are computed from the actual running code, so they can't silently drift out of sync with what they claim to describe.

Deliberately distinct from the existing `computeTopologyHash()` (used for template-library dedup), which is designed to be *insensitive* to node ids/parameter values/connections so structurally-similar templates match -- the opposite sensitivity profile from what provenance needs.

**`BundleManifest.provenance`** (new, optional field): the same three content-derived identifiers, stamped fresh at `writeBundle()` time. Each `workflow.json` file entry also gets a `workflowHash` computed from its live-fetched content.

**`PreflightResult.provenance`** (new, required field -- preflight results are never persisted/deserialized, so there's no backward-compat case to leave optional): the same three identifiers, always computed regardless of `--live`/`--bundle-dir`. The existing bundle-manifest check (`--bundle-dir`) now also compares the bundle's stored provenance against current, informationally noting "same versions," "different versions," or "predates provenance tracking" -- never changes the check's pass/warn/fail status, matching that check's existing purely-informational contract.

Known, honestly-documented limitation: `ruleSetVersion` catches added/removed rules, not every internal logic change to an existing rule (e.g. the Rule 58 fix above doesn't change it, since Rule 58's ID didn't change) -- hashing the validator's actual source isn't reliably possible from a published, compiled package.

Tests: 10 (workflow-hash) + 5 (version identifiers) + 4 (BuildResult plumbing) + 2 (bundle manifest) + 4 (preflight) = 25 new tests across four commits. 1206/1206 passing overall. Typecheck/lint clean.

### Fixed: Rule 126's message overclaimed a hard n8n requirement (wording only, no logic change)
Rule 126's warning said "n8n requires UUID v4 format ... for all node IDs" and "Non-UUID IDs may cause issues with execution tracking." Checked against real n8n source (`workflow-structure-validation.ts`'s Zod schema types node `id` as `z.string().optional()`, no format constraint) and n8n's own editor code (which does generate `uuidv4()` by convention, but doesn't enforce or reject other formats): the claimed requirement doesn't exist, and no evidence of a runtime dependency on ID format was found. This is very likely why the rule fires on nearly every generated node in real telemetry (2,263 of ~435 build attempts) rather than indicating broken output.

Reworded to state the accurate claim: n8n's editor conventionally generates UUID v4, a non-conforming ID would look conspicuously non-editor-generated, and n8n's own validation doesn't reject other formats. The check itself (still WARN, still flagging non-UUID-v4 IDs) is unchanged — this is a wording-only fix, not a logic or severity change. No test asserts on exact message text, so no test changes were needed.
### Fixed: Rule 58 false-positived on legitimate non-default credential types
Rule 58 hardcoded exactly one "expected" credential type key per node type (`Record<string, string>`). Checked against real `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` source during a ground-truth audit: 13 of the 25 node types it covers actually accept more than one valid credential type, gated by an authentication-style parameter in real n8n — e.g. Gmail's `serviceAccount` mode uses `googleApi` while `oAuth2` mode uses `gmailOAuth2`, both legitimate. Same for Google Sheets, Google Drive, Slack, Notion, Airtable (+ trigger variants), GitHub (+ trigger), HubSpot, and Jira (Cloud vs. Server vs. Server PAT). Rule 58 was warning "n8n will fail to find the credential at runtime" on every one of these legitimate alternates.

Widened `EXPECTED_CRED` to `Record<string, string[]>` and changed the check to set membership rather than a single-key match. Deliberately does not attempt to resolve *which* mode is currently selected (that would require a displayOptions-conditional resolver, which stays a separately-gated decision — see `feedback_kairos_narrow_rules_over_resolver`) — this fix only stops flagging credentials that are valid under *some* mode as if they were wrong under all of them.

Tests: 13 new cases (one per confirmed valid alternate) + 1 confirming Rule 58 still correctly warns on a genuinely invalid credential key. 1177/1177 passing overall. Typecheck/lint clean.

### Fixed: node-syncer dropped all but the first credential type for new node types
`NodeSyncer.sync()`'s `node.credentials?.[0]?.name` only ever captured the first declared credential option when merging a live n8n instance's node-type info into the registry — the same underlying gap the Rule 58 fix above addresses on the validator side, confirmed during the same ground-truth audit.

Practical exposure was narrower than initially assumed: `sync()`'s merge path only sets `credentialType` for genuinely new node types (not already in `DEFAULT_REGISTRY`) — existing entries only get their `safeTypeVersions` unioned, never their credential info touched. All 9 non-trigger node types found affected by the Rule 58 fix are already statically seeded, so this bug's real-world exposure is for less-common node types syncing for the first time, not Gmail/Slack/GitHub/etc.

Added `NodeDefinition.credentialTypes?: string[]` alongside the existing `credentialType?: string` (kept unchanged, still the first credential seen — its only consumer, `node-syncer.ts`'s own catalog log line, needed no changes) so `sync()` can now capture the full set without breaking anything reading the single-value field. `credentialTypes` is only populated when a node reports more than one credential option.

Deliberately does **not** attempt to capture `displayOptions` (which auth-mode value selects which credential) — `N8nNodeTypeInfo.credentials` only types `{name, required?}` today, and whether n8n's real node-types API response actually carries that data is unverified (checked only against Kairos's own type, not a live response — see `docs/plans/step3-audit-report-2026-07-08.md` §2). Broadening the capture without that verification would be guessing at a live API shape, not fixing a confirmed gap.

Tests: first-ever test coverage for `NodeSyncer` (previously none existed) — 5 new tests covering single-credential capture, multi-credential capture, zero-credential nodes, the already-known-node merge path leaving `credentialType`/`credentialTypes` untouched, and the catalog text rendering. 1181/1181 passing overall. Typecheck/lint clean.

## [0.10.0] - 2026-07-07

### New: `kairos pack export <pack> --impact-notes` (Phase 4 — client diagnostic worksheet)
A static, fill-in-the-blank Markdown worksheet for a human to complete during a client diagnostic call — not generated from any pack data. Seven fixed fields: current manual process, time spent weekly, error/failure points, revenue leakage, before/after metric, human owner, follow-up date.

This is the last item on the `preflight`/impact-notes roadmap arc and the only one with zero risk of guessing at requirements: every field is written by hand from a real conversation, never auto-computed or pre-filled — doing so (even with a plausible-looking guess) would reintroduce exactly the fabricated-precision problem an earlier "roi-ledger.md" concept was rejected for. Deliberately kept separate from `--bundle`'s artifact set, since it's a sales/diagnostic tool, not a pack deliverable.

Known limitation, noted rather than silently accepted: wiring this as a `pack export` flag means a pack has to exist first, but impact notes are genuinely useful *before* one does (e.g. during the initial diagnostic call that decides whether to build a pack at all). A standalone `kairos impact-notes [business-context]` command would fix this — deferred, not built now, since the current wiring is adequate for the immediate need and building the standalone path speculatively would be exactly the kind of premature scope this whole roadmap arc has been avoiding.

Tests: 4 unit tests (all 7 fields render, business-context header present/absent, no pre-filled values anywhere in the output) + 1 CLI test. 1152/1152 passing overall. Typecheck/lint clean.

### New: `kairos preflight <pack> --bundle-dir <dir>` (Phase 3 — bundle cross-reference)
Cross-checks a preflight run against a previously generated `--bundle` output directory: whether test-artifacts (`test-payloads.json`/`contract.openapi.json`) exist for each webhook-shaped workflow, and — if a `bundle-manifest.json` is present there — surfaces its raw `generatedAt` timestamp and any artifacts it had to skip during generation.

Knowing *which* workflows are webhook-shaped requires the live node graph, so this check's meaning depends on `--live`, not just `--bundle-dir`. Without `--live`, the check reads exactly "Webhook artifact checks require --live" — refined mid-implementation from an earlier draft that would have said "N workflows may be webhook-shaped," which is a count preflight genuinely doesn't have without `--live` and shouldn't guess at. With `--live` but no `--bundle-dir`, it reports the real count it *does* have and recommends passing `--bundle-dir`. With both, it checks actual file presence — missing artifacts warn (`GO WITH WARNINGS` at most), never fail, since these are already-documented heuristic/best-effort artifacts from the Delivery Bundle and their absence shouldn't be treated as more serious than the artifacts themselves claim to be.

Bundle manifest freshness is purely informational, not a go/no-go check — no invented staleness threshold (e.g. "stale after 7 days" would be fake precision with no basis); it's only rendered at all when `--bundle-dir` was actually given. Extended mid-implementation to also surface `manifest.skipped` entries (not just `generatedAt`) — if the bundle run had to skip generating `workflow.json` because an n8n fetch failed, preflight now shows that alongside the timestamp, since it's directly relevant to whether the pack is actually ready.

Tests: 8 new unit tests (no-count-without-`--live` phrasing, informational count with `--live` only, warn-not-fail on missing artifacts, pass on present artifacts, manifest absent from output when no `--bundle-dir`, manifest found with skipped entries, manifest missing/malformed degrades to warn not throw) + 1 CLI test (`--bundle-dir` end-to-end with a real manifest file). 1147/1147 passing overall. Typecheck/lint clean.

### New: `kairos preflight <pack> --live` (Phase 2 — live n8n checks)
Adds the two checks that genuinely need a live n8n fetch, on top of Phase 1's offline checklist: placeholder/unwired credential IDs, and a best-effort Google Sheets ID signal. Also quietly enumerates webhook-shaped workflows for Phase 3's `--bundle-dir` cross-reference (stored on `PreflightResult.webhookShapedWorkflows`, not rendered as a check of its own yet).

**Placeholder credentials**: Kairos's generation prompt tells Claude to write the literal string `"placeholder-id"` for every credential reference — confirmed via direct source inspection, never checked anywhere at runtime before this. `--live` fetches each workflow (reusing `fetchWorkflowJson()` from the Delivery Bundle, no new n8n API surface needed) and scans every node's `credentials` map for that literal, **or an empty/missing `id`** — broadened from the original plan after a mid-implementation refinement: a credential slot with `id: ''` or no `id` at all is just as unwired as the literal placeholder, and costs nothing extra to also catch.

**Google Sheets IDs**: reuses `findSheetNodes()`/`extractSheetDocumentId()` (already exported from `pack-wirer.ts`, previously computed there but never used for any decision). Unlike credentials, there's no placeholder-literal convention for Sheet document IDs, confirmed by direct research — so an empty value is confidently flagged, but a non-empty value renders as a pass **that always carries an explicit "unverified, confirm manually" caveat** rather than a bare checkmark. Overclaiming certainty here would be worse than the honest alternative.

One workflow's live-fetch failure degrades that workflow's live checks to a `warn` ("could not verify"), never aborts the rest of the pack's checklist — same graceful-degradation contract as every Delivery Bundle live-fetch function. `--live` requires `N8N_BASE_URL`/`N8N_API_KEY`, fails fast with a clear message if missing.

Tests: 10 new unit tests (skip-without-`--live` behavior, placeholder-string detection, empty/missing-id detection, real-id pass case, per-workflow fetch-failure degradation, empty vs. non-empty vs. no-sheet-nodes Sheets rendering, webhook enumeration presence/absence) + 2 CLI tests (a real mock-n8n-server run flagging a placeholder credential end-to-end, missing-env-vars exit code). 1139/1139 passing overall. Typecheck/lint clean.

### New: `kairos preflight <pack>` (Phase 1 — offline checks)
The next operational-safety command after the Delivery Bundle, converged on after two rounds of second-opinion review: stop adding generator features, build one small go/no-go gate, then go use it on a real client engagement.

`generateRiskReport()` (Delivery Bundle Phase 3) already answers "did Kairos generate this correctly" — it's entirely derived from generation-time data. It has zero concept of "has the human actually finished the manual setup" (connected real credentials, wired real Google Sheet IDs). That's the gap `preflight` fills, and this phase ships the offline half — everything answerable from the saved pack JSON alone, no n8n required.

Refactored `generateRiskReport()` to extract `computeRiskFindings(pack)` — the same escalation/severity-normalization/verdict computation, now reusable structured data instead of only-derivable-by-reparsing-Markdown. `generateRiskReport()`'s rendered output is unchanged (verified: all 34 existing tests pass unmodified).

New `src/pack/preflight.ts`: `runPreflight()` returns structured `PreflightCheck[]` + an overall `GO`/`GO WITH WARNINGS`/`NO-GO`/`BLOCKED` verdict; `formatPreflightChecklist()` renders it as an actual line-by-line checklist (✓/✗/⚠/⊘), not narrative prose — the Delivery Bundle's other artifacts are reports, this one is a checklist because its whole purpose is scannable go/no-go, not context.

Seven checks this phase: pack build completed (escalation), no unresolved blocking assumptions (checked independently of escalation — a pack built with `buildDespiteBlocking: true` can still carry unresolved blocking assumptions that `pack.escalation` won't catch, since escalation only fires when the pack was never built at all), pack-structural validation, all workflows deployed, no error-severity issues, no warning-severity issues (this is where Rule 59's missing-webhook-auth warning surfaces automatically, zero new logic needed), and an informational credential checklist.

An escalated pack does **not** short-circuit the checklist the way `generateRiskReport()` does — every per-workflow check still renders, explicitly marked `skip` with "N/A -- pack never built" rather than naively reporting a pass because `pack.workflows` happens to be empty. A checklist that looks all-green on a pack that was never generated would be actively misleading.

`kairos preflight <pack>` exits 0 for GO/GO WITH WARNINGS, 1 for NO-GO/BLOCKED (matching `validate-pack`'s existing exit-code convention) — scriptable as a real gate. `--json` prints structured output for automation.

Tests: 11 unit tests (escalated-pack full-checklist skip behavior, clean-pack GO, blocking-assumptions-without-escalation NO-GO, undeployed workflows, error vs. warning severity verdict distinction, pack-structural validation, credentials checklist always-informational, checklist rendering) + 3 CLI tests (GO exit 0, NO-GO exit 1, `--json` shape). 1127/1127 passing overall. Typecheck/lint clean.

### Fix: Delivery Bundle — escalated packs, and staleness tracking for live-fetched artifacts
A second-opinion review (Codex) checked the shipped Delivery Bundle plan against the actual code and found two genuine gaps, both fixed here (four other points it raised — `hashContent` correctness, monitoring-plan's drift-claiming discipline, OpenAPI path normalization, nested vs. flat JSON for multi-segment fields — were re-verified directly against the code and confirmed already correct, no change needed):

- **`risk-report.md` never checked `pack.escalation`.** An escalated pack (`PackBuilder.build()` stopped before generating anything because of unresolved blocking assumptions) has zero workflows and zero issues — `generateRiskReport()` would previously and misleadingly report `READY` for a pack that doesn't actually exist yet. Now checks `pack.escalation` first and reports a distinct `BLOCKED — build never completed` status with the escalation reason and open questions, before any of the normal READY/NEEDS ATTENTION/NOT READY logic runs.
- **Live-fetched per-workflow artifacts (`workflow.json`, `test-payloads.json`, `contract.openapi.json`) carried no record of when they were fetched.** Since these reflect n8n's *current* state (which can differ from what Kairos originally generated — hand-edited since, or drifted), `bundle-manifest.json`'s per-file entries now carry an optional `fetchedAt` timestamp for anything that came from a live fetch; pure-render, pack-level artifacts (`handoff.md`, `credentials.md`, `risk-report.md`) don't have a fetch moment and correctly leave it unset.

Tests: 1 new `generateRiskReport()` test (escalated pack → BLOCKED, not READY, reason + questions rendered) + 2 new `fetchedAt` tests (`writeWorkflowJsonFiles()` records a timestamp in the expected window; `writeBundle()`'s manifest sets it for live-fetched artifacts and leaves it undefined for pure renders). 1113/1113 passing overall. Typecheck/lint clean.

### New: `kairos pack export --openapi <dir>` and `--bundle <dir>` (Delivery Bundle, Phase 6 — final)
Sixth and final artifact, plus the orchestrator that ties all six phases together into one command. This completes the Delivery Bundle plan.

`generateOpenApiContract()` reuses Phase 5's `extractWebhookFieldRefs()` rather than mining fields a second time — the marginal cost of this phase is mostly "assemble an OpenAPI document shape" given Phase 5 already exists. Body fields become a nested JSON Schema (`requestBody.content['application/json'].schema`); query/header fields become `parameters` entries with `in: 'query'`/`in: 'header'`. Every field is typed `string` and every parameter is `required: false` — the extractor can only confirm a field is *referenced* somewhere, never that it's required or its real type, and a wrong inferred type/requiredness would be worse than an honest, uniform "string, unverified." Marked `x-kairos-generated: 'heuristic'` throughout, with the same disclaimer text as `--test-payloads`, so nobody mistakes this for a hand-written contract. No new dependency (no `openapi-types`, no schema validator) — the document is small and hand-assembled consistently.

`kairos pack export <name> --bundle <dir>` is the actual "client deliverable machine" this whole plan was building toward: writes every pack-level artifact (`handoff.md`, `credentials.md`, `risk-report.md`, `monitoring-plan.md`) and every applicable per-workflow artifact (`workflow.json` for all, `test-payloads.json`/`contract.openapi.json` for webhook-shaped ones only) into one directory, plus a `bundle-manifest.json` listing exactly what was written and what was skipped and why. Composes the existing `generate*`/`write*Files` functions from Phases 1-5 rather than duplicating any of their logic. One failing piece (n8n unreachable for one workflow, a workflow with no webhook trigger) never aborts the rest — every skip is recorded in the manifest, never silent.

Tests: 6 new unit tests (`generateOpenApiContract()`: null for non-webhook, minimal valid document, nested body schema, query/header parameter placement, zero-fields case) + 2 `writeOpenApiFiles()` tests + 2 `writeBundle()` tests (full artifact set + manifest, non-webhook skip recorded not thrown) + 1 CLI integration test (pack with one webhook and one non-webhook workflow — confirms the full expected file set is written, webhook-only artifacts are correctly *absent* for the non-webhook workflow rather than empty-but-present, and the manifest accurately reflects both). 1111/1111 passing overall. Typecheck/lint clean.

**One real bug found and fixed while writing this phase's JSDoc comment, not the code itself**: a doc comment describing this function as reusing "generate*/write*Files functions" broke the TypeScript parser, because `*/` inside a `/** ... */` comment closes the comment early — everything after it became malformed source code. Caught immediately by `npm run typecheck`, fixed by rewording. A small, easy-to-miss gotcha worth remembering: never write a literal `*/` sequence inside a JSDoc block, even in prose.

This closes out the six-phase Delivery Bundle plan. All six artifacts (`workflow.json`, `credentials.md`, `risk-report.md`, `monitoring-plan.md`, `test-payloads.json`, `contract.openapi.json`) are available individually via their own flags, or together via `--bundle`.

### New: `kairos pack export --test-payloads <dir>` (Delivery Bundle, Phase 5)
Fifth of six new client-deliverable artifacts, and the first that's genuinely new logic rather than a render over existing data -- confirmed nothing like this existed anywhere in the codebase.

Deliberately narrow scope, on purpose: the codebase already investigated and rejected a fuller version of this exact idea. The repo-integration plan found that extracting a webhook's required fields from static n8n node metadata is unreliable specifically for the Webhook node (`httpMethod`/`path` aren't statically required; body shape depends on response-mode/content-type the validator "can't reliably see"), and the existing `webhook-body-access` prompt guidance was deliberately kept as LLM prompt text rather than an enforced rule for the same reason. New `src/pack/webhook-schema.ts` doesn't try to solve that ambiguity -- `extractWebhookFieldRefs()` mines field names from `$json.body`/`$json.query`/`$json.headers` expressions anywhere in the workflow (a fresh, nested-path-aware regex -- the existing private `extractJsonFieldRefs` in `validator.ts` only captures one level and is tuned for its own two rules, left untouched), and `generateTestPayload()` builds a sample from those names with a naive placeholder guesser (email/phone/name/date/id pattern matching on the field name only). Every output carries a mandatory disclaimer: this is a best-effort guess, not a verified contract, and should be checked against a real request before production use.

**A real bug found by the test suite, not by inspection**: the initial field-reference regex used a plain `\w`-based character class for path segments, which silently truncated at the first hyphen -- `x-api-key` and `x-signature` (both completely normal HTTP header names) were captured as just `x`. Fixed by widening the segment character class to include hyphens. A good reminder that "write the test first" catches exactly this class of edge case before it ships.

`kairos pack export <name> --test-payloads <dir>` writes one `<slug>.test-payloads.json` per webhook-shaped workflow (live n8n fetch, same graceful-degradation contract as `--workflow-json`); non-webhook workflows are skipped silently since the artifact doesn't apply to them.

Tests: 9 unit tests for `extractWebhookFieldRefs()`/`generateTestPayload()` (nested paths, single-level regression guard, query/header roots, dedup+sort, zero-references case, non-webhook null, flat vs. nested sample building) + 3 unit tests for `writeTestPayloadFiles()` (webhook workflow, non-webhook skip, partial-failure resilience) + 1 CLI integration test against a mock n8n server. 1101/1101 passing overall. Typecheck/lint clean.

### New: `kairos pack export --monitoring-plan` (Delivery Bundle, Phase 4)
Fourth of six new client-deliverable artifacts. Generalizes the existing single-workflow `kairos trace record` (CLI) / `kairos_record_trace` (MCP) infrastructure to "for every workflow in this pack, tell me its current health" -- reusing `parseExecutionTrace()` and a newly-shared `getSlowestNodes()` helper rather than any new trace-parsing logic.

Small refactor first: the "top N slowest nodes from `nodeDurations`" sort-and-slice was duplicated inline in both `cli.ts`'s `handleTrace` and `mcp-server.ts`'s `kairos_record_trace` -- factored into one new exported `getSlowestNodes(nodeDurations, n)` in `execution-tracer.ts`, both call sites updated, output byte-identical (verified: full suite green before and after, no test needed updating).

`generateMonitoringPlan(pack, client)` reports each workflow's live active/inactive status and its single latest execution (status, duration, slowest nodes) -- and deliberately does NOT claim a drift comparison happened. A true drift comparison (`detectExecutionDrift()`) needs multiple historical traces (`StoredWorkflow.executionTraces`), which pack export has no access to -- that's the library's stored record, not derivable from one live fetch. Says so explicitly ("insufficient history for drift comparison -- run `kairos trace record <id>` periodically") rather than rendering an empty or misleading drift section. One workflow's fetch failure (n8n unreachable, workflow deleted) is reported and skipped, not fatal to the rest of the report.

Requires `N8N_BASE_URL`/`N8N_API_KEY` (live fetch per workflow), unlike `--credentials`/`--risk-report`.

Tests: 5 new `getSlowestNodes()` unit tests (top-N sort, empty map, n-exceeds-available, default n=3, ties) + 5 `generateMonitoringPlan()` unit tests (not-deployed case, unreachable-n8n graceful degradation, never-run workflow, latest-execution rendering with slowest nodes, multi-workflow partial-failure resilience) + 2 CLI integration tests against a mock n8n HTTP server. 1088/1088 passing overall. Typecheck/lint clean.

### New: `kairos pack export --risk-report` (Delivery Bundle, Phase 3)
Third of six new client-deliverable artifacts, and the one that needed a real prerequisite fix rather than being a pure render. `BuildResult` and `PackWorkflowResult` gain a new `finalIssues: ValidationIssue[]` field (structured rule/severity/message data) -- previously, the final generation attempt's validation issues were computed in `designer.ts` but discarded before reaching either type; only an unstructured `summary: string` survived, and that string only ever mentioned `warn`-severity issues, never `error`-severity ones. `finalIssues` is additive on `BuildResult` (always populated going forward) and optional on `PackWorkflowResult` (undefined on packs persisted before this field existed -- handled explicitly, not silently, in the new risk report).

`generateRiskReport()` combines this per-workflow structured data (enriched with `RULE_MITIGATIONS`/`RULE_PIPELINE_STAGES` fix guidance) with the already-public pack-structural risk from `validatePack()` (duplicate names, schedule conflicts, unresolved blocking assumptions), normalizing the two different severity spellings (`ValidationIssue`'s `'warn'` vs. `PackValidationIssue`'s `'warning'`) into one consistent rendering. Produces a categorical **READY / NEEDS ATTENTION / NOT READY** verdict from the real itemized issues -- deliberately not a fabricated numeric score (e.g. "73/100"), since an unfounded-precision number not backed by real calibration data would erode trust rather than build it.

`kairos pack export <name> --risk-report` is a pure synchronous render, same contract as `--handoff`/`--credentials` -- no network call, no n8n credentials required.

Tests: 6 new unit tests for `generateRiskReport()` (all-clean READY case, error-severity NOT READY with mitigation text rendered, warning-only NEEDS ATTENTION, pack-structural issue surfacing, graceful degradation for pre-existing packs without `finalIssues`, severity-spelling normalization) + 5 plumbing tests (`BuildResult.finalIssues` populated across build-dry-run/build-deployed/build-no-issues/replace, `PackWorkflowResult.finalIssues` threaded through `PackBuilder.build()`) + 1 CLI test. 1076/1076 passing overall. Typecheck/lint clean.

### New: `kairos pack export --credentials` (Delivery Bundle, Phase 2)
Second of six new client-deliverable artifacts. Groups every workflow's `credentialsNeeded` (service/credentialType/description) by service across the whole pack, printing a client-readable checklist — which credential, why it's needed, which workflow(s) need it, and a setup-order reminder.

Deliberately sources from each workflow's own `PackWorkflowResult.credentialsNeeded`, not the pack-level `WorkflowPackResult.allCredentials` aggregate — the latter dedupes down to just `{service, credentialType}` and silently drops the `description` field, which is the part that actually tells a client *why* they need a given credential. Multiple workflows needing the same credential for different reasons now show both descriptions, not just one.

Pure synchronous render, same contract as the existing `--handoff` flag — no network call, no n8n credentials required, works offline against the saved pack JSON.

Tests: 5 new unit tests for `generateCredentialsDoc()` (zero-credentials case, multi-workflow dedup with description preservation, identical-description collapse, mixed zero/nonzero-credential workflows, business-context/setup-order presence) + 1 CLI test. 1064/1064 passing overall. Typecheck/lint clean.

### New: `kairos pack export --workflow-json <dir>` (Delivery Bundle, Phase 1)
First of six new client-deliverable artifacts, prompted by an external review proposing every generated pack ship as a full client handoff bundle, not just a workflow JSON. Sorted the proposal by real marginal cost before building anything -- this is the one genuine prerequisite the others share: `PackWorkflowResult` (the per-workflow record inside a saved pack) only ever stored `workflowId`, a string reference into n8n, never the actual node/connection graph -- the full `N8nWorkflow` was fetched during generation but discarded before being persisted to the pack file.

New `src/pack/pack-bundle.ts`: `fetchWorkflowJson(workflowId, client)` fetches a workflow's *current* live n8n definition via the existing `N8nApiClient.getWorkflow(id)` and strips n8n-internal fields (`id`, `active`, `versionId`, `meta`, etc.) down to the portable `N8nWorkflow` shape -- deliberately live, not cached from build time, so a client's workflow.json always reflects reality even if the workflow was hand-edited in n8n since Kairos built it. Returns `null` (not a throw) on a fetch failure so one broken workflow in a multi-workflow pack never blocks exporting the rest.

`kairos pack export <name> --workflow-json <dir>` writes one `<slug>.workflow.json` per workflow, skipping (with a printed reason, not a hard failure) any workflow with no `workflowId` or whose n8n fetch fails. Requires `N8N_BASE_URL`/`N8N_API_KEY`, same as every other n8n-touching command -- fails fast with a clear message if missing.

This is the first of six planned artifacts (`workflow.json`, `credentials.md`, `risk-report.md`, `monitoring-plan.md`, `test-payloads.json`, `contract.openapi.json`) that will fold into a single `--bundle <dir>` command once all six exist. Naming note: deliberately called "the delivery bundle" in code/docs, not "Contract Pack" or similar, to avoid colliding with the existing `WorkflowPackResult`/`PackBuilder` "pack" concept.

Tests: 9 unit tests (`fetchWorkflowJson`/`writeWorkflowJsonFiles`/`slugifyWorkflowName` — success, field-stripping, fetch failure, partial-failure graceful degradation, output-dir auto-creation) + 2 CLI integration tests spawning the real CLI against a mock n8n HTTP server. 1058/1058 passing overall. Typecheck/lint clean.

### New: always-on pattern audit trail + opt-in human-gated pattern promotion (`KAIROS_PATTERN_REVIEW`)
Fourth and final concept from the SOLIVEN comparison, closing out the Tier 1+2 transfer plan — SOLIVEN's best governance idea Kairos lacked: state changes to learned behavior can require human sign-off, and every change is auditable. For a client-facing service, "why does your AI believe this?" needs an answer.

**Audit trail (always on, no flag needed)**: `pattern-analyzer.ts` now diffs each analysis run's pattern states against the previous run and appends one line per actual state change to `~/.kairos/pattern-audit.jsonl` (`{ ts, rule, from, to, actor, evidence }`). Append-only, never read back by generation -- pure record. Unchanged patterns across repeated runs produce zero duplicate lines (verified).

**Review gate (opt-in, `KAIROS_PATTERN_REVIEW=true`)**: new `pending_review` `PatternState`. Under the flag, a pattern crossing the confirm threshold lands in `pending_review` instead of `confirmed` -- unless it was already approved in a prior run, in which case it stays `confirmed` (approval is sticky, not required every analysis run). `draft` creation is never gated -- only the confirm-level *promotion* that lets a pattern start steering generation. `prompt-builder.ts`'s `getActivePatterns()` (the sole point where `patterns.json` is read for injection) now excludes `pending_review` alongside `resolved`.

New CLI: `kairos patterns --pending` (list only patterns awaiting review), `kairos patterns approve <rule>` (promotes to confirmed, actor `'human'` in the audit trail), `kairos patterns reject <rule> [reason]` (marks resolved with an optional reason, excluded from generation same as any resolved pattern). Both exit 1 with a clear message if no `pending_review` pattern exists for that rule.

Default (flag off) behavior is byte-identical to before -- only the new audit file appears; `patterns.json`'s evolution over time is unaffected. `PatternState`'s new fourth member is additive: old `patterns.json` files with only `draft`/`confirmed`/`resolved` remain perfectly valid, no migration needed.

Tests: 13 new (4 review-gate state-computation tests, 6 audit-trail diff/dedup/approve/reject tests in `pattern-analyzer.test.ts`, 1 injection-exclusion test in `prompt-builder.test.ts`, 4 CLI round-trip tests spawning real subprocesses against real telemetry fixtures in `cli.test.ts`). 1047/1047 passing overall. Typecheck/lint clean.

Deliberately out of scope: a web UI or approval queue service (CLI is the v1 surface, per the original SOLIVEN comparison's own guidance); audit file rotation (append-only JSONL, ~100 bytes/line, noted as future work if it ever matters at scale).

This completes the SOLIVEN → Kairos Tier 1+2 transfer plan (4 phases: escalation-as-first-class-outcome, per-client memory, hybrid retrieval, human-gated pattern governance). SOLIVEN's remaining Tier 3 ideas and the four previously-deferred roadmap items remain intentionally out of scope for now.

### New: optional hybrid (embedding + BM25) retrieval for per-client memory
Third concept from the SOLIVEN comparison — its hybrid retrieval recipe (local embeddings + BM25, fused by Reciprocal Rank Fusion, zero per-query API cost), the specific piece of SOLIVEN's design confirmed to be its most genuinely mature asset. Evaluated `fastembed` vs `@xenova/transformers` vs `@huggingface/transformers` before picking one: `@xenova/transformers` is the deprecated predecessor (last published mid-2024, superseded); `@huggingface/transformers` is actively maintained but drags in `sharp` and general multi-modal support unneeded for pure text embedding (9.5MB); `fastembed` is purpose-built for exactly this, ~100KB unpacked plus `onnxruntime-node`, explicitly "no hidden dependencies," and defaults to the *same model SOLIVEN used* (`BAAI/bge-small-en-v1.5`, 384-dim) — the clear pick.

Added as an **optional peer dependency** (`fastembed`, `peerDependenciesMeta.optional: true`), mirroring the existing `@anthropic-ai/sdk` pattern exactly — not installed, memory retrieval stays pure BM25 (Phase B's behavior, unchanged); installed, `store.ts` automatically computes and persists an embedding for every memory node in a per-client `embeddings.json` sidecar (recomputed only when a node's `contentHash` changes), and `retrieve()` fuses a BM25 ranking with a cosine-similarity vector ranking via `rrfFuse()` (SOLIVEN's exact `Σ 1/(k+rank+1)`, `k=60`). `KAIROS_MEMORY_EMBEDDINGS=off` force-disables even when installed. A missing package, a disabled flag, or any embedding-path failure all degrade silently to Phase B's BM25-only ranking — never an error, never a blocked build.

Verified live and with real (not mocked) `fastembed` model loads, not just unit tests: a query and a stored preference sharing zero related tokens ("Should notifications be concise or detailed?" vs. "Prefers brief, minimal wording...") now correctly match once embeddings are enabled — confirming this closes exactly the class of retrieval miss Phase B's live checkpoint found.

**A real, separate bug found and fixed while adding this**: `fastembed`'s native `onnxruntime-node` backend crashes the test runner (`FATAL ERROR: HandleScope::HandleScope Entering the V8 API without proper locking in place`) under vitest's default worker-threads-based execution pool — its async native callback doesn't correctly re-acquire the V8 isolate lock inside a worker thread. Confirmed reproducible with a single embeddings test file, unrelated to test concurrency. Fixed by switching `vitest.config.ts` to `pool: 'forks'` (separate child processes, each with an isolated V8 instance) — confirmed no measurable slowdown to the full suite (~15s before and after). This only affects test execution; `onnxruntime-node` runs correctly in normal (non-vitest-worker) Node.js processes, including every real CLI/build invocation used throughout this investigation.

Tests: 13 new (9 for the embedding provider itself — kill-switch, caching, cosine similarity math, one real end-to-end fastembed load; 4 for the full hybrid path through `ClientMemoryStore` with real embeddings — sidecar write-on-remember, a genuine semantic-match retrieval BM25 alone would miss, no-recompute-when-unchanged, sidecar cleanup on forget) plus 10 new pure-math tests for `rrfFuse`/`rankMemoriesHybrid`/`bm25RankedIds`. All of Phase B's existing memory tests updated to explicitly force `KAIROS_MEMORY_EMBEDDINGS=off` (they test BM25/storage mechanics specifically, not the embedding path, and `fastembed` being a real devDependency here meant they'd otherwise attempt a real model load). 1030/1030 passing overall. Typecheck/lint clean.

Deliberately out of scope: applying this hybrid ranker to `FileLibrary`'s workflow search (the benchmark showed library search isn't today's bottleneck).

### New: per-client persistent memory (`clientId`, `kairos.remember()`/`recall()`, `kairos memory`, `kairos_remember`/`kairos_recall`)
Second concept adapted from the SOLIVEN comparison (see the escalation entry below for the first) — its typed-markdown-memory-plus-derived-index architecture and hybrid retrieval approach, re-implemented in TypeScript rather than ported (SOLIVEN's version is Python and, per the research, was never actually a graph — no edges/traversal exist there either, just flat typed files and a good ranker). Set `clientId` (constructor option, `KAIROS_CLIENT_ID` env var, or CLI `--client <id>`) to give Kairos persistent memory for a specific client across builds: preferences, build history, incidents, and reference facts, stored as human-readable markdown (`~/.kairos/clients/<id>/memory/<type>/*.md`) plus a derived, always-rebuildable `index.json`. Fully inert when unset — zero filesystem access, no behavior change for anyone not using it.

- **Retrieval**: pure-TypeScript BM25 (no external services, no embeddings, no API cost) over each node's description + body + tags, weighted by recency (90-day half-life, floored) and a small `preference`-type boost.
- **Write path**: every successful `build()`/`replace()` automatically records a `history` node; `kairos.remember()`/`kairos memory add`/`kairos_remember` (MCP) support explicit writes. Deduplicates on write (same type + description updates the existing node instead of creating a duplicate) and evicts oldest `history`/`incident` nodes first when over a cap (`KAIROS_MEMORY_CAP`, default 500) — `preference`/`reference` are never auto-evicted.
- **Safety**: every clientId is validated (`^[a-z0-9][a-z0-9-]{0,63}$`) before any filesystem access — fail-closed, so an invalid id can never traverse outside its own directory or reach another client's memory. Every write is scrubbed for credential-shaped text (API keys, bearer tokens, long hex/base64 runs) and rejected if found. A memory read/write failure never blocks a build.
- **MCP**: `kairos_remember`/`kairos_recall`, both gated behind `KAIROS_MCP_ALLOW_MEMORY=true` (default off) — `kairos_recall` is deliberately gated the same as the write tool, more conservative than the other read-only tools, since client memory can hold business-sensitive context.

Two real bugs found and fixed via a live end-to-end checkpoint against the real Anthropic API, not just mocks:
1. **Retrieval missed a directly-relevant memory purely on a singular/plural mismatch** — a stored preference said "...for notifications" (plural) and a build query said "...a notification..." (singular); exact-token BM25 scored zero overlap and the memory never surfaced. Fixed with minimal, conservative suffix normalization in the tokenizer (not a full stemmer — just enough to catch this class of near-miss) — confirmed the exact failing query now retrieves correctly.
2. **A test-isolation bug that was writing real test data into the actual `~/.kairos/clients/` directory on every test run.** The original client-level wiring tests tried to isolate filesystem writes by mutating `process.env['HOME']` at runtime — confirmed directly that this pattern works in a plain Node script but does *not* reliably redirect `os.homedir()` inside vitest's worker context, silently leaking test client directories into the real home directory every run. Found by manually inspecting `~/.kairos/clients/` after the live checkpoint and noticing directories that shouldn't have existed. Fixed by replacing the private `memoryStore` field with one pointed at a real temp directory via `ClientMemoryStore`'s own `baseDir` option (the same safe pattern every other memory test already used) — confirmed clean on rerun. The CLI/MCP test suites were never affected, since they spawn genuinely separate child processes (env vars passed at process creation work correctly; this bug was specific to same-process mutation).

Deliberately out of scope for this pass: hybrid (embedding-based) retrieval — noted as a natural follow-up now that a concrete real-world retrieval miss has been found and partially addressed; wiring memory into `PackBuilder` (packs have their own planning context).

### `build-pack` now escalates instead of spending API calls on packs that can't be activated yet
First of several concepts adapted from a deep-research comparison against SOLIVEN (a separate, earlier agent-platform project) — specifically its `MissionRunner`'s ESCALATED-as-first-class-status idea. `PackBuilder.build()` already computed `hasBlockingAssumptions` to suppress activation, but ran the *entire* generation loop regardless — building every workflow in a pack even when it was already known the pack couldn't go live without a human answering open questions first. Now, when blocking assumptions exist and the caller hasn't opted in via the new `buildDespiteBlocking: true` option, `build()` returns immediately with `escalation: { reason, questions, source: 'blocking_assumptions' }` and zero workflows built — no generation calls, no spend. `kairos build-pack` prints the questions clearly and exits with code `2` (distinct from the generic error code `1`) so scripts can branch on "needs a human" vs. "actually failed." Verified live: an intentionally under-specified business context now stops immediately after the (already-necessary) planning call instead of generating and deploying 7 workflows it already knew would be blocked. `kairos.build()` (single-workflow) is unaffected — no equivalent escalation trigger exists there today, and `EscalationInfo` is exported for future reuse rather than inventing one.

### Fixed: `smokeTest` for webhook workflows tested the wrong URL (always failed headlessly) + new automatic webhook reachability check
Directly confirmed against a live n8n Cloud instance: a workflow can show `active: true` (verified via the API, surviving a manual UI toggle, a fresh webhook path, and a deactivate→reactivate cycle) while its production webhook (`/webhook/<path>`) still 404s "not registered" every time — n8n's own activation state cannot be trusted alone for webhook-triggered workflows. While building a fix for this, found that `smokeTest`'s existing webhook branch (`provider.smokeTest()`) tested the *test* URL (`/webhook-test/<path>`) instead — confirmed that URL 404s with n8n's own message telling you to click "Execute workflow" in the editor first, meaning this check has likely never worked in real headless/automated use; it was only ever unit-tested against mocks.

New `src/utils/webhook-verify.ts` (`findWebhookTrigger`/`interpretWebhookProbe`/`verifyWebhookReachable`) and `N8nApiClient.triggerWebhookProduction()` fix both problems with one shared implementation: fire one real request at the workflow's production webhook, and distinguish n8n's specific "not registered" 404 signature from any other response (even a 4xx/5xx from the workflow's own logic — that still proves the route dispatched correctly, which is the only thing being checked here, not business-logic correctness).

- `smokeTest`'s webhook branch now uses this correctly — repointed at the production URL.
- New: `BuildResult.webhookVerification`, populated automatically whenever a webhook-triggered workflow is built with `{ activate: true }`, even without `{ smokeTest: true }` — closes the silent-failure gap by default. Skips a redundant second probe when `smokeTest` is also requested (derives the same result from `smokeTestResult` instead). Wired into `kairos build`, MCP `kairos_deploy`, and MCP `kairos_activate`. Folded into `BuildResult.summary`/`kairos_deploy`'s response text as a plain-English line.
- Verified live: after this fix, `kairos build "..." --smoke-test` against a real n8n Cloud instance now correctly reports `smokeTest.status: "failed"` with an accurate "not registered" message, replacing what would previously have been a false or misleadingly-labeled result.
- Deliberately out of scope: `Kairos.replace()` (never calls `activate()`, so there's no activation moment to hook into) and schedule/poll-trigger registration reliability (a structurally different, unverified question — no way to check it instantly the way a webhook can be probed).

### `kairos.replace()` now diffs against the previously-deployed workflow
Confirmed before building this that neither `Kairos.replace()` nor MCP `kairos_replace` had ever fetched the existing workflow before overwriting it — a silent full replacement with no way to see what changed. New `src/utils/workflow-diff.ts` (`diffWorkflows()`/`formatDiff()`) computes a structural diff — added/removed/type-changed nodes matched by name (n8n workflows don't carry a stable node ID across redeploys), plus added/removed credential *types* (inferred from each node's `credentials` object keys, since the richer `CredentialRequirement` shape isn't available for a previously-deployed workflow, only for a freshly-generated one). Wired additively into both `Kairos.replace()` (`src/client.ts`) and MCP `kairos_replace` (`src/mcp-server.ts`): a new `provider.get(id)` / `client.getWorkflow(id)` call runs *before* the existing update call, and if it fails (workflow deleted, transient API error), the replace still proceeds — it just degrades to no diff rather than throwing. The diff, when available, is appended to the same `summary` string from the previous `BuildResult.summary` change.

### New `BuildResult.summary` — plain-English "what this workflow does"
A deterministic, human-readable summary generated alongside every `kairos.build()`/`kairos.replace()` result — no new Claude call, built entirely from data the build already produces: a new `src/utils/workflow-summary.ts` walks the generated workflow's trigger(s) and steps through a small node-type→plain-English-label dictionary (falls back to the raw type string for anything not in the dictionary, rather than guessing), and reuses `credentialsNeeded` and the validator's own warning message text verbatim (from the last generation attempt's `attemptMetadata.issues`) instead of re-deriving new copy. Wired into the CLI's `kairos build`/`kairos replace` output (printed to stderr alongside the JSON, also included in the JSON as `summary`) and MCP's `kairos_deploy` response. Intended to make a generated workflow reviewable by a non-technical person before deploy, not just a JSON dump. Generalizes the same idea `pack-exporter.ts`'s `generateHandoff()` already applies to whole packs, down to a single build.

### New `BENCHMARKS.md`
A dedicated writeup of the benchmark methodology (`--repeat`/`--isolated`/tiers), the original 20-prompt ceiling-effect finding, and the 282-run backend-viability follow-up with the three real bugs it led to fixing — every number cross-checked against the actual committed result files, not recalled from memory. Also fixes two README lines that still said "128 validator rules" in general (non-dated-snapshot) prose despite the rest of the README having been updated to 129 earlier, and trims the README's own inline backend-viability section down to a pointer at `BENCHMARKS.md` rather than maintaining the same narrative in two places.

### New `kairos-lint` — the structural validator, standalone
The 129-rule validator (`N8nValidator`) has zero runtime dependency on Claude/generation and never did — it was just never exposed as its own thing. New `src/lint-cli.ts` entry point + `kairos-lint` bin: `npx @kairos-sdk/core kairos-lint <workflow.json>` validates *any* n8n workflow JSON — hand-written, exported from n8n, or from another tool — fully offline, no API keys or n8n instance required. Matches the existing `handleValidatePack` terminal-output convention (plain glyphs, no color library, `--json` mode, exit 1 on any error-severity issue — usable directly in CI). Shipped as a new bin entry in the existing package rather than a separate `@kairos-sdk/lint` package: a genuinely separate package would need the validator's source either duplicated or re-depend on `@kairos-sdk/core` itself, both defeating the point.

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
