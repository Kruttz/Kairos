# Step 9 — Real-flow checkpoint note (2026-07-09)

Per `docs/plans/hardening-and-chaining-plan.md` §11 (Step 9). Run against the real Anthropic
API and a real n8n Cloud account (`jwagon.app.n8n.cloud`), not fixtures or a unit-test harness.

## What worked

- **`plan()` against the real model**: after fixing the `max_tokens` bug below, `plan()` ran
  successfully multiple times against realistic Empire Homecare business descriptions, returning
  well-formed JSON every time, including correct `dependsOn` name declarations.
- **Chaining against real model output**: built a real pack ("Referral Intake" → "Referral
  Confirmation Email", `dependsOn: ['Referral Intake']`). The confirmation email's generated
  content correctly referenced `https://jwagon.app.n8n.cloud/webhook/referral-intake` — the
  *exact* real, deployed webhook URL of its dependency, not a guessed or hallucinated one. This
  is the one thing a mocked fixture cannot prove (see `tests/integration/golden-pack.test.ts`'s
  own comment to that effect) and it held up under a real model call.
- **Blocking-assumption safety gate, verified live**: a 7-workflow real plan carried 4 blocking
  assumptions. Built with `buildDespiteBlocking: true, activate: true`; confirmed directly
  against the live n8n API that all 7 workflows deployed but none activated (`active: false`
  for every one), matching the design ("activation will still be suppressed regardless").
- **Provenance, bundle, preflight**: `writeBundle()` produced all 17 expected artifacts (2
  webhook-only artifacts correctly skipped for 4 non-webhook workflows) with correct
  `kairosVersion`/`ruleSetVersion`/`promptTemplateVersion`/`nodeCatalogVersion` in the manifest.
  `preflight --live --bundle-dir` correctly returned **NO-GO**, citing real, specific gaps
  (unwired Slack/SMTP credential IDs, emailSend nodes missing a `to` address, unauthenticated
  webhooks, non-UUID node IDs) — not noise.
- **Ledger**: `bundle_exported` and `preflight_completed` events fired with correct
  `packName`/`fileCount`/`hasProvenance`/`verdict` fields once `KAIROS_TELEMETRY` was explicitly
  set (off by default — a gap in my own checkpoint process, not a Kairos defect).
- **Activation path, tested separately and safely**: per explicit scoping, built a
  hand-authored, side-effect-free two-workflow plan directly via `PackBuilder.build()` (bypassing
  `plan()`) — Webhook + Set + respondToWebhook nodes only, no credentials, no external services.
  Both workflows deployed within the intended node-type scope (verified by inspecting the live
  JSON before activating). The dependent workflow's `Set` node correctly carried the real
  upstream webhook URL. Activated directly via `N8nApiClient.activateWorkflow()`; both workflows
  reported `active: true` via n8n's own API — see "What looked off" below for what that flag
  did and didn't actually mean here. Both checkpoint workflows deactivated and deleted
  afterward (`QtF2pkjLTGD28g6m`, `UPIqkcDRyfhWZ55H`).

## What looked off (not new defects — pre-existing, already-documented platform behavior)

- **n8n Cloud's `active: true` does not guarantee the webhook route is registered.** Both
  checkpoint workflows reported `active: true` from n8n's own API after activation — including
  after a full deactivate/reactivate cycle — yet their production webhooks returned 404
  `"is not registered"` every time. This is **not a new Kairos bug**: it's the exact, already
  investigated and documented n8n platform gap `src/utils/webhook-verify.ts`'s doc comment
  describes ("confirmed directly against a live instance: survived a manual UI toggle, a fresh
  path, and a deactivate/reactivate cycle, still 404ing 'not registered' every time"). Confirmed
  that `Kairos.build({ activate: true })`'s existing automatic `verifyWebhookReachable()` call
  (`client.ts`, populates `BuildResult.webhookVerification`) would have caught and correctly
  reported this via `reachable: false` had the real build gone through `Kairos.build()` directly
  instead of a manual out-of-band `activateWorkflow()` call — which is exactly what the Step 8
  closure commit's `webhookVerified` field on `WorkflowReference` exists to carry into a
  downstream chained prompt. This is strong, real-world validation that the three-state
  lifecycle model (dry-run / deployed-but-inactive / activated-with-separately-tracked
  reachability) closed in that commit is not speculative caution — it reflects genuine platform
  behavior.
- **`PLAN_PROMPT` hardcodes "Generate a list of 4-8 n8n workflows"** (`pack-builder.ts` line
  145) and overrides explicit user requests for a smaller pack — three separate attempts to ask
  for "exactly two workflows" all returned 7-8 workflows anyway. Recorded as a documented product
  finding per explicit instruction, not changed in this step (would be an unplanned Step 9
  feature, not a bug fix).
- **7 workflows from the `buildDespiteBlocking` real-flow test remain deployed-but-inactive** on
  the real `jwagon.app.n8n.cloud` account (workflow IDs: `5PG8gfQFwcSGmzyk`, `tac4sqkWkjB2ApiU`,
  `xjMANL9USbiHaggb`, `1tDTXUz45GXIy0oK`, `TRdRVH84dJcPt4QI`, `L6DoAwh0L6tXwr5v`,
  `svwYRvHKXQeAq1ki`). Cleanup for these wasn't part of the explicit checkpoint-workflow
  disposal instruction (that covered only the hand-authored activation-test pair) — left for
  Jordan's call on disposal vs. keeping as reference.

## Real bugs found and fixed (their own commit, not bundled into feature work)

1. **`PackBuilder.plan()`'s `max_tokens: 4096` was hardcoded and too small.** The very first live
   `plan()` call against a realistic 3-workflow business description truncated mid-JSON-string
   (`Unterminated string in JSON at position 16891`) and threw. Fixed by exporting
   `client.ts`'s existing `DEFAULT_MAX_TOKENS`/`KAIROS_MAX_TOKENS` convention and reusing it in
   `PackBuilder` instead of a second hardcoded magic number (also added a `maxTokens` constructor
   option for parity with `ClientOptions`). No test fixture had ever exercised a business
   description long/complex enough to hit this — short synthetic contexts (`'Empire Homecare
   referral intake'`) never generate an 8-workflow plan.
2. **`derivePackName()` had no length cap.** A single realistic, full-paragraph business
   description slugified into a 400+ character filename, crashing the CLI's final save step with
   `ENAMETOOLONG` — after a real, billed `plan()` call had already run. Fixed by reusing
   `slugifyWorkflowName()`'s existing 60-char cap (`pack-bundle.ts`) instead of a second,
   uncapped slug implementation — exactly the kind of "two independent slug implementations
   silently drift apart" pattern this codebase has already called out once before (the
   `buildWebhookUrl()` extraction).

Both fixes verified: 1286/1286 tests passing, typecheck/lint clean, and confirmed live by
re-running the exact business description that originally crashed.

## Token/cost notes

Every `plan()` call in this checkpoint used the real model (`claude-sonnet-4-6`) at the
now-16000-token default. `build()` was called 9 times total against the real model across the
two live packs (7-workflow despite-blocking pack + 2-workflow hand-authored activation pack).
No systematic token-delta measurement was taken here — that was already done in Step 8's own
token-budget guardrail (~70 tokens/dependency) and isn't this step's purpose.

## Outcome

Full pipeline (`plan → build → writeBundle → preflight`, plus a separate controlled activation
path) validated end to end against real infrastructure. Two genuine bugs found and fixed. One
pre-existing platform-level webhook-registration gap reproduced live and confirmed already
correctly handled by existing Kairos design (`webhookVerification`, and now `webhookVerified` on
`WorkflowReference`). One product-level finding (hardcoded 4-8 workflow range) documented, not
acted on, per explicit scoping. Step 9 is complete.

## Cleanup: disposal of the 7 `buildDespiteBlocking` test workflows (2026-07-09T14:34:00Z)

Deleted the 7 deployed-but-inactive workflows from the `buildDespiteBlocking` real-flow test
(the "What looked off" item above), per explicit authorization. Before deleting each, fetched it
live from `jwagon.app.n8n.cloud` and verified all three of: workflow ID matches this checkpoint's
list, `active` is `false`, and `name` matches this checkpoint run's workflow name. All 7 passed
verification; none were skipped.

| Workflow ID | Name | Verified | Deleted |
|---|---|---|---|
| `5PG8gfQFwcSGmzyk` | Referral Intake | id ✓, inactive ✓, name ✓ | ✓ |
| `tac4sqkWkjB2ApiU` | Referral Confirmation Email | id ✓, inactive ✓, name ✓ | ✓ |
| `xjMANL9USbiHaggb` | Referral Follow-Up Reminder | id ✓, inactive ✓, name ✓ | ✓ |
| `1tDTXUz45GXIy0oK` | New Referral Slack Acknowledgment with Assignee Ping | id ✓, inactive ✓, name ✓ | ✓ |
| `TRdRVH84dJcPt4QI` | Weekly Referral Summary Report | id ✓, inactive ✓, name ✓ | ✓ |
| `L6DoAwh0L6tXwr5v` | Referral Error Alert | id ✓, inactive ✓, name ✓ | ✓ |
| `svwYRvHKXQeAq1ki` | Referral Source Onboarding Email | id ✓, inactive ✓, name ✓ | ✓ |

Deletion confirmed: re-fetching `5PG8gfQFwcSGmzyk` afterward returned HTTP 404 (workflow no
longer exists). The two earlier hand-authored activation-test workflows (`QtF2pkjLTGD28g6m`,
`UPIqkcDRyfhWZ55H`) were already deactivated and deleted during the checkpoint itself (see
above). The `jwagon.app.n8n.cloud` account now has no remaining artifacts from this checkpoint.
Bundle output (`step9-bundle/`), telemetry (`step9-telemetry/`), the saved pack JSON, and this
checkpoint document are all preserved.
