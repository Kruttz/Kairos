# Changelog

All notable changes to `@kairos-sdk/core` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); dates are publish dates from npm.

## [Unreleased]

Everything below is committed locally as of this entry but **not yet pushed to GitHub or published to npm** — a deliberate checkpoint (see `docs/plans/repo-integration-plan.md` for the full session log). Grouped by theme, not commit-by-commit.

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
