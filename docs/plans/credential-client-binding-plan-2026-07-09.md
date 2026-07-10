# Credential-client-binding preflight check

**Status: shipped 2026-07-10.** Planned and approved 2026-07-09; implemented, tested (fixtures +
one live spot-check against a real n8n Cloud account), and committed 2026-07-10.

## Context

Identified independently three ways: this project's own real-model checkpoint (Step 9, see
`docs/plans/step9-checkpoint-2026-07-09.md`), the underlying audit history of Kairos's
credential-wiring bugs (Rule 58 / node-syncer's `credentials[0]` issue), and an independent
Codex review of the same conversation. Per-client storage isolation (separate databases,
separate Google accounts, Postgres Row-Level Security) protects the *data layer* — it does
nothing if Kairos wires the *wrong n8n credential* into a workflow in the first place, because
from n8n's point of view the workflow is simply using whatever credential it was told to use.
That's a generation-time/wiring mistake, not a storage-architecture one, and no amount of
database-level isolation catches it. This check is the thing that actually closes that specific
gap.

## What

A new, opt-in preflight check — `credential-client-binding` — that verifies every real
(non-placeholder) credential a pack's workflows reference actually belongs to the client the
pack is being preflighted for, catching the case where a workflow ended up wired to a credential
belonging to a *different* client.

## Where

- `src/pack/preflight.ts` — `PreflightOptions.clientId`, `parseCredentialClientSlug()`, the new
  check itself (reuses the existing live-fetch loop that already powers the
  `placeholder-credentials` check — no new n8n API surface needed).
- `src/cli.ts` — new `--client-id <slug>` flag on `kairos preflight`.
- `tests/unit/pack/preflight.test.ts` — 12 new tests.

## Why

Three independent signals converged on the same gap (see Context). It's small, additive, and
doesn't block on any other open decision (the Postgres/Supabase RLS question, which storage
backend Empire's two lines end up on, etc.) — it's useful regardless of what's decided there.

## How

1. **Naming convention, not a second mapping file.** Credentials used in a multi-client context
   are named `client:<clientSlug>:<service>:<purpose>` in n8n. The client identity is parsed
   directly out of the credential's own `name` field — no separate registry to keep in sync,
   deliberately avoiding a second source of truth that could drift (the same reasoning that
   argued against a standalone client-tracking spreadsheet in the broader credential-isolation
   discussion this plan came out of).
2. **Explicit `--client-id`, never inferred.** `packName` is just a slugified business-context
   string (`derivePackName()`) — not a reliable client identity (e.g.
   `empire-homecare-referral-pipeline-exactly-two-workflows-for-`). Guessing one from it would be
   exactly the kind of fabrication this codebase has consistently refused elsewhere (`webhookUrl`
   never fabricated without a known base URL; malformed `dependsOn` never silently coerced).
   Omitted entirely by default → the check is skipped, zero behavior change for every existing
   single-client / non-multi-tenant use of Kairos.
3. **Zero new n8n API surface.** `N8nCredentialReference` already has both `id` and `name`
   (`src/types/workflow.ts`), and `name` is already fetched live by the existing
   `fetchLiveWorkflowData()` → `fetchWorkflowJson()` → `client.getWorkflow()` path that powers
   the `placeholder-credentials` check. This check is a sibling of that one, sharing the same
   live-fetch loop rather than adding a second fetch.
4. **Three-way outcome per credential reference, not binary:**
   - **Match** (`client:empire:...` and `--client-id empire`) → no finding.
   - **Mismatch** (`client:acme:...` when `--client-id empire`) → **hard fail**, contributes to
     `NO-GO`. A confirmed cross-client credential wiring is a real, severe finding.
   - **Unverifiable** (name doesn't follow the convention at all, e.g. legacy `"Empire Slack"`)
     → **warn**, never fail, never silent pass — mirrors the existing `reachable: null` / "could
     not verify" honesty pattern already used elsewhere in this file for fetch failures.

## When

Built 2026-07-10, immediately after approval — doesn't block on the RLS/schema decision for
Empire's two lines, useful either way.

## Guardrails

- **Read-only, no auto-fix.** Never renames a credential or touches n8n's credential store.
  `preflight --fix` is an explicitly deferred item elsewhere in this codebase for good reason
  (needs its own live-write safety review) — this check must not become a backdoor into that.
- **Opt-in only — zero behavior change when `--client-id` is omitted.** Verified: all 45
  pre-existing `preflight.test.ts` tests pass unchanged.
- **Never fabricate client identity.** No fuzzy matching against a credential's display name if
  it doesn't follow the convention — "unverifiable" is the honest answer, not a guess.
- **State the real limit of this check plainly.** This is a *naming-convention consistency*
  check, not cryptographic proof of ownership — a deliberately mis-named credential would fool
  it. It materially raises the bar against the "wrong credential picked by mistake / registry-
  sync bug" class of error. It is **not** a substitute for hard isolation (separate n8n
  instances/projects, database-level RLS) on the highest-stakes (PHI-adjacent) data — stated in
  the CLI help text and in `PreflightOptions.clientId`'s doc comment, not just here.

## Process (as executed)

1. Added `clientId?: string` to `PreflightOptions` + `parseCredentialClientSlug()` (pure
   function, case-insensitive, `client:<slug>:...`).
2. Extended the existing live-fetch loop in `runPreflight()` to collect mismatches/unverifiable
   names alongside (not replacing) the existing unwired-credential collection.
3. Pushed the new `credential-client-binding` check with the same skip/pass/warn/fail shape as
   `placeholder-credentials`.
4. Wired `--client-id <slug>` into `handlePreflight()` in `cli.ts`, updated both usage strings
   (command-specific and the top-level help block).
5. 12 new tests: `parseCredentialClientSlug` unit tests (conforming, case-insensitive,
   non-conforming, superficially-similar-but-wrong), plus `runPreflight` tests covering
   skip-without-clientId, skip-without-live, pass-on-match, case-insensitive match, fail-on-
   mismatch, warn-on-unverifiable, no-double-flagging-a-placeholder-credential, and no-
   credentials-present.
6. One live spot-check against the real n8n Cloud sandbox account (`jwagon.app.n8n.cloud`) — see
   Outcome below.
7. Full gates (typecheck/test/lint), one commit.

## Reasoning

Reusing the existing live-fetch loop instead of adding a second one keeps this additive and
cheap. Parsing client identity from the credential's own name instead of a side-mapping file
avoids a second source of truth that can silently drift. Making a confirmed mismatch a hard fail
(not a warning) is consistent with this file's existing severity model — everything else here
already treats "real, confirmed problem" as fail and "can't be sure" as warn.

## Outcome (live spot-check results, 2026-07-10)

Verified end-to-end against real infrastructure, not just fixtures. Created two real n8n
credentials (`httpHeaderAuth`, fake header values — n8n doesn't validate credential data against
any live service at creation time, so no real secret was ever needed) named
`client:kairostemptest-empire:supabase:orders-db` (id `O0yp3ctTTu92Ugld`) and
`client:kairostemptest-acme:supabase:orders-db` (id `T52aHIuBwepUZq7N`), plus one throwaway
workflow (`TEMP_KAIROS_TEST_credential_binding_livecheck`, id `YRkat6KXlwcq8evT`, never
activated) with one node wired to each credential. Ran `runPreflight()` three ways against this
real, live-fetched workflow:

- `--client-id kairostemptest-empire` → **NO-GO**, correctly flagged only the Acme-owned
  credential as mismatched, correctly said nothing about the matching Empire credential.
- `--client-id kairostemptest-acme` → **NO-GO**, correctly flagged only the Empire-owned
  credential as mismatched (the reverse case), confirming the check isn't order-dependent or
  hardcoded to one direction.
- No `--client-id` → `skip`, `detail: 'N/A -- --client-id not provided'` — zero behavior change
  confirmed live, not just in fixtures.

Cleanup: workflow deleted (confirmed via a subsequent `GET` returning 404); both credentials
deleted (n8n's public API has no `GET` for credentials at all — even the list endpoint 405s, by
design — so deletion was instead confirmed by re-issuing the same `DELETE` and observing it
return 404 on the second attempt, proving the resource no longer existed).

1298 tests passing (up from 1286), typecheck/lint clean.

## What to avoid

Don't build a parallel credential-registry file. Don't make `--client-id` mandatory or infer it
from `packName`. Don't let this become the first step toward `preflight --fix`. Don't treat a
`warn` (unverifiable name) as license to skip manually checking those credentials.

## Anything else

This check mitigates the *shared-n8n-instance* risk specifically — it is a separate,
complementary gate from the Postgres/Supabase RLS / schema-separation decision still open for
Empire's two lines of business (DME/PHI-adjacent vs. Shopify), not a substitute for it.
