# Kairos Reliability Suite — Implementation Plan

**Date:** 2026-07-18 (revised same day after a Codex second opinion — 3 points folded in: chaos-as-replay-mutation architecture, Phase 0/1 resequencing, structured verification-boundary reporting. One point flagged, not folded in: moving intake interview earlier — that overrides Jordan's own explicit sequencing decision from the same conversation, left to him.)
**Status:** APPROVED to begin. Phase 0, spike S2 (sandbox), starting now.
**Scope:** The four committed items from the 2026-07-18 direction reset, in priority order:
1. Self-healing / drift detection (automation SRE)
2. Network-effect pattern library (community failure corpus)
3. Chaos testing (pre-deploy adversarial hardening)
4. Replay/shadow testing (safe-change verification)

Explicitly out of scope (deferred until these ship): intake interview, automation P&L, self-tuning flywheel, platform-agnostic (Zapier/Make) layer.

---

## 1. What we're building and why

**The one-paragraph version:** Kairos currently reads to a casual observer as "English in, n8n workflow out" — a category n8n itself now occupies with its own AI builder (`@n8n/ai-workflow-builder.ee`). This arc repositions Kairos around the part n8n's builder doesn't touch and can't casually copy: what happens *before* deploy (chaos testing proves the workflow survives hostile input), *after* deploy (drift detection notices when a live workflow starts behaving differently; self-healing proposes or applies fixes), *during any change* (replay proves a new version behaves like the old one against real recorded traffic), and *across every install* (the community pattern library compounds what every Kairos user's failures teach). Generation becomes one feature inside a reliability loop, instead of the whole product.

**The loop these four features form:**

```
            BUILD (exists today)
              │
   [3] CHAOS TEST ──── pre-deploy: attack it in a sandbox
              │
            DEPLOY (exists today: preflight, webhook-verify)
              │
   [1] DRIFT WATCH ─── post-deploy: baseline → detect → diagnose
              │
   [1] PROPOSE REPAIR ─ escalate by default; auto only when opted in
              │
   [4] REPLAY VERIFY ── prove the fix behaves before swapping it in
              │
            SWAP + POST-VERIFY + ROLLBACK-ON-FAILURE
              │
   [2] PATTERN LIBRARY ─ every failure class learned, optionally shared
```

**Why this is defensible:** n8n's builder stops mattering the moment a workflow is deployed. Every feature in this arc operates on deployed, running automations over time — a category difference, not a feature difference. And [2] compounds: the corpus of real-world failure patterns grows with every install that opts in, which no single vendor (including n8n) can replicate from a standing start.

---

## 2. Ground truth — verified current state (recon 2026-07-18)

Everything below was read from the actual repo this session, not remembered. Repo: `/Users/jordankrutman/KairosSDK/kairos-sdk`, **v0.11.0**, 1277+ tests. (The `~/Desktop/kairos-sdk` copy is stale at v0.9.0 — do not use it.)

**Already exists and is load-bearing for this plan:**
- `src/telemetry/execution-drift.ts` — `detectExecutionDrift(traces)` with 4 signals: newly-erroring nodes, duration anomaly (>2x avg, ≥100ms baseline guard), missing core nodes, new nodes. Needs ≥2 traces. Clean, narrow, extensible.
- `src/telemetry/execution-tracer.ts` — `parseExecutionTrace()` converts an n8n execution into an `ExecutionTrace`: status, durationMs, executedNodes, erroredNodes (name+errorType only), itemCount (count only), per-node `nodeDurations`. **Deliberately privacy-safe: no payload values are ever captured.** `mergeTraces()` caps history at 10 per workflow. `fetchLatestTrace()` pulls live from n8n.
- Traces are stored on the workflow-library record (`executionTraces` on `StoredWorkflow`, `FileLibrary.recordTrace()`), surfaced via `kairos trace` CLI.
- `N8nApiClient` — full workflow CRUD, activate/deactivate, `getExecutions(workflowId, filter)` + `getExecution(id)` (returns **full execution `data`** — real node I/O lives in `data.resultData.runData`), tags, node-types, `triggerManual(id)` (no payload injection), `triggerWebhookTest/Production` (empty `{}` body only — no payload parameter yet).
- `src/pack/webhook-schema.ts` — `extractWebhookFieldRefs()` walks all node expressions for `$json.body/query/headers.*` refs (hyphen-safe, nested paths). Carries the honest-scope DISCLAIMER discipline this plan reuses.
- Pattern system (`src/telemetry/pattern-analyzer.ts`, 805 lines) — lifecycle draft→confirmed→resolved, composite scoring, `KAIROS_PATTERN_REVIEW` human gate with `pending_review` state, always-on audit trail (`~/.kairos/pattern-audit.jsonl`), CLI approve/reject.
- Per-client memory (`src/memory/`) — typed-markdown nodes, BM25+vector hybrid retrieval, fail-closed clientId, **secret scrubber**.
- Preflight (`src/pack/preflight.ts`) — offline/`--live`/`--bundle-dir` checks, GO/GO-WITH-WARNINGS/NO-GO/BLOCKED verdicts, exit codes.
- Delivery Bundle (`src/pack/pack-bundle.ts`) — per-workflow `originalBuildHash` (build-time) vs `liveExportHash` (export-time) already in `bundle-manifest.json`, with build-vs-live comparison explicitly "left to the consumer" — **a ready-made structural-drift hook this plan consumes**.
- Telemetry ledger v3 — five event types incl. `bundle_exported`, `preflight_completed`; emissions guarded so telemetry failure never breaks a real result.
- `replace()` structural diff, `DeployActivationError`, webhook-verify (`BuildResult.webhookVerification`), escalation-as-first-class (`buildDespiteBlocking`), pack output chaining (`dependsOn`/`WorkflowReference` — shipped in 0.11.0; **off this plan's list, already done**).

**Corrections this recon made to the working assumptions:**
- Pack-chaining gap: already fixed (0.11.0). Removed from scope.
- Version: 0.11.0, not 0.9.0. There is post-July-9 work (operation ledger, provenance, chaining) this plan builds on rather than re-proposes.

---

## 3. Hard constraints (drive the whole design)

**C1 — No Docker, no local n8n CLI on this machine (verified).** Chaos Tier B and replay both need an execution sandbox — a real n8n runtime that is not production. Phase 0 must resolve how (see spikes). Both candidate paths end in a one-time human task for Jordan (install Docker Desktop, or one-time local-n8n owner setup + API key paste). **The plan is explicitly structured so that if no sandbox ever materializes, Phases 1, 4-Tier-A, and 5 still ship full value** (see §13 fallback).

**C2 — The only live n8n is the family business's production Cloud instance.** It hosts real Empire Homecare workflows, and it has the documented webhook-404 registration gap. **Chaos and replay must never execute against it.** This becomes an enforced guardrail (G1), not a convention: the sandbox client refuses to operate when its base URL matches the configured production `N8N_BASE_URL`.

**C3 — Current traces are payload-free by deliberate design.** Replay needs real payloads; capturing them is a privacy posture change and must be opt-in, local-only, retention-capped, and firewalled from sharing (G3, G4).

**C4 — n8n public API has no payload-injecting execution endpoint.** `triggerManual` takes no input; webhook triggers currently send `{}`. Replay's injection mechanism must be chosen by spike S3 (extend webhook call with a real body — trivial — plus a trigger-swap transform for non-webhook workflows).

**C5 — No hosted infrastructure anywhere in this arc.** The prior hold-off reasoning ("drift-watching as a hosted product needs real users first") still stands. Everything here runs locally as CLI/MCP invocations; `kairos watch` is a local loop + cron recipes, not a service. The community library uses GitHub as its aggregation point precisely to avoid running a server.

**C6 — Honesty discipline is inherited, not optional.** Heuristic classifications are labeled heuristic; "insufficient data" is a first-class status, never silently passed; no invented thresholds presented as verified; DISCLAIMER pattern from `webhook-schema.ts` carries into chaos and replay reports.

---

## 4. Architecture overview

**New modules (all under existing conventions):**
```
src/reliability/
  drift/
    checks.ts          # named DriftChecks D1-D8 (validator-rule style)
    baseline.ts        # baseline model build/update/persist
    diagnose.ts        # drift class → likely causes → action class
    repair.ts          # (Phase 3) proposal generation, ladder, rollback
  sandbox/
    manager.ts         # sandbox lifecycle: locate, verify-not-production, import, cleanup
    transforms.ts      # workflow prep: name-prefix, cred-strip, trigger-swap
  replay/
    capture.ts         # opt-in payload capture from execution data
    runner.ts          # inject payload → run in sandbox → collect execution
    diff.ts            # trace/output diff engine + verdicts
  chaos/
    payloads.ts        # adversarial payload family generator
    static-audit.ts    # Tier A: no-runtime robustness findings
    sandbox-run.ts     # Tier B: live sandbox chaos execution
  community/
    whitelist.ts       # THE serializer — whitelist-only, by construction
    share.ts           # report build, pre-share diff, GitHub handoff
    ingest.ts          # community-patterns.json loading w/ provenance
```

**Data layout (all local, under existing `~/.kairos/` conventions):**
```
~/.kairos/
  drift/<workflowId>/baseline.json        # baseline model + observation window
  captures/<clientId>/<workflowId>/*.json # opt-in payloads (chmod 600, retention-capped)
  snapshots/<workflowId>/<ts>.json        # pre-replace workflow JSON (rollback source)
  reliability-audit.jsonl                 # every automated observation/action (G6)
  sandbox.json                            # sandbox instance config (url, key, marker)
```

**Command surface (kept minimal; MCP mirrors for the ones marked ◆):**
- `kairos drift baseline <wf>` / `kairos drift check <wf> [--live]` ◆
- `kairos sandbox up|status|down` (thin wrapper; real runtime per spike S2)
- `kairos replay capture <wf>` / `kairos replay run <wf> --candidate <file>` ◆
- `kairos chaos audit <wf|pack>` (Tier A) / `kairos chaos run <wf>` (Tier B) ◆
- `kairos repair propose <wf>` / `kairos repair apply <wf> [--auto]` (Phase 3)
- `kairos patterns share` / `kairos patterns sync` (Phase 5)
- `kairos watch [--interval <s>]` (Phase 6)

---

## 5. Phase 0 — Research spikes + shared plumbing

**Why first:** three later phases (2, 3, 4-Tier-B) stand on two pieces of infrastructure that don't exist (sandbox, payload capture) and four questions the codebase can't answer from the armchair. Every spike is timeboxed; every spike ends in a written decision in this plan file (edited in place), per the verify-before-build discipline.

**Revised ordering (Codex second opinion, folded in):** don't let drift detection wait behind the full capture/sandbox build-out. Only one of Phase 1's nine checks (D8) needs captured payloads — the other eight need nothing beyond traces that already exist today. So:

1. **S2 (sandbox spike) first** — resolves the highest-risk unknown before anything else depends on it.
2. **Privacy/capture *spec* second** — S3 (injection mechanism) plus the capture policy decisions (opt-in, retention, scrub) get written down as a design, not necessarily fully built yet.
3. **Phase 1 (drift, capture-independent checks D1-D7/D9) ships third** — immediately, without waiting on the capture build or sandbox manager to be finished. Real value lands early; the arc is de-risked further, since drift is proven and shipped before the harder infrastructure is even attempted.
4. **Full capture build + sandbox manager build, then Phase 2 (replay)** — only after both the sandbox and the privacy posture are actually settled, not just spec'd.

S1 and S4 slot in wherever they're needed by the step consuming them (S1 before sandbox execution work starts; S4 before the replay diff engine is built).

### 5.1 Spikes (research, no production code)

**S1 — Execution data shapes. RESOLVED 2026-07-18, and it surfaced a real, previously-unknown gap in shipped code.** Tested two error classes against the live sandbox, not just the success case already covered by S3:

- **Code-node thrown error** (`throw new Error("deliberate spike error")`): the real `error` object on the run entry has keys `description, level, lineNumber, message, shouldReport, stack, tags` — **no `name`, no `type`**. `execution-tracer.ts`'s `parseExecutionTrace()` extracts `errorType` as `error['name'] ?? error['type'] ?? 'UnknownError'` — for this error class, that **always** resolves to `'UnknownError'`. Confirmed by directly inspecting the fetched object, not inferred.
- **HTTP Request node error** (GET against a deliberately invalid host): a *completely different, much richer* shape — `context, functionality, httpCode, level, message, messages, name, node, shouldReport, stack, tags, timestamp`. `name` is present (`'NodeApiError'`), and `httpCode` carries real diagnostic gold (`'ENOTFOUND'` here — would be `401`/`429`/`500` etc. for other real failures). The existing extraction logic works correctly for this class.
- **Verdict:** the gap is real but narrower than "error classification is broken" — it's specific to certain node/error classes (confirmed: Code-node thrown errors; unconfirmed either way for other node types). It also means today's tracer is **silently discarding `httpCode` entirely** for the node type (HTTP-calling nodes) most central to typical Kairos-generated automations, even though `errorType` extraction happens to work for that class. **Design implication for Phase 1 §6.2/§6.3:** D1/diagnose.ts should read `httpCode` when present (it's a far stronger diagnostic signal than `name` alone — distinguishes DNS failure from auth failure from rate-limit from server error, each with a different remediation), and should not assume every drift-relevant error will classify beyond `'UnknownError'` for non-API node types. Filed as a real, scoped finding — not a blocker, a design input.
- **Non-webhook (schedule) trigger shape:** not directly tested this round (time-boxed; the webhook and error-path tests were higher priority and already consumed the spike's budget). Flagged as a small residual gap — cheap to close inside Phase 1's own build when a schedule-triggered fixture is needed anyway.
- **Readiness-timing side-finding:** on a second boot, `/healthz` returned 200 several seconds *before* `/rest/login` stopped 404ing. `sandbox/manager.ts`'s "wait until ready" logic needs to poll a real REST endpoint (not just `/healthz`) before considering the instance usable — recorded here so it isn't rediscovered the hard way later.

**S4 — Volatile fields. RESOLVED 2026-07-18.** Fired the identical payload twice at the same sandbox webhook, fetched both executions, diffed byte-for-byte. **The actual payload content (`body`/`headers`/`query`/`webhookUrl`/`executionMode`) was byte-identical across both runs** — no fuzzy matching needed there; given identical input, n8n's webhook-capture output is deterministic. The fields that *did* differ, confirmed directly: top-level `id` (execution ID), `startedAt`/`stoppedAt` (wall-clock timestamps), and per-node `startTime`/`executionTime` (epoch ms / duration ms — naturally jittery, 0ms vs 1ms here). `executionIndex` stayed identical (0/0) for this single-node case. **Decision: `replay/diff.ts`'s volatile-field exclusion list is exactly these five fields** (`id`, `startedAt`, `stoppedAt`, `startTime`, `executionTime`) — everything else in a node's captured output is fair game for exact comparison, not fuzzy-matched.

**S2 — Sandbox runtime. RESOLVED 2026-07-18, best-case outcome, no Docker needed.** Actually booted it, not just checked version numbers:
- Node: local is v24.10.0, n8n@2.30.7 requires `>=22.22` — comfortably clear.
- `npx --yes n8n@2.30.7 start` with `N8N_USER_FOLDER`/`N8N_PORT` pointed at an isolated scratch dir/port: cold boot (fresh download) ready in ~85s, confirmed via `/healthz` → `{"status":"ok"}`. Fully isolated — own SQLite DB, own port, zero contact with the production Cloud instance.
- **Owner setup and API-key creation are both scriptable via REST, zero browser required** — this was the open question and it resolved the good way: `POST /rest/owner/setup` (email/password) → session cookie → `GET /rest/api-keys/scopes` (returns the exact valid scope list for the role — don't guess these, they're specific: `workflow:activate`/`workflow:deactivate` exist, `workflow:execute` does not) → `POST /rest/api-keys` with `expiresAt: null` and the confirmed scope list → real `rawApiKey`.
- **Exact confirmed working scope set** (minimum needed to cover everything `N8nApiClient` calls — create/read/update/delete/list/activate/deactivate workflows, read/list/delete executions, create/list tags, update workflow tags): `workflow:create`, `workflow:read`, `workflow:update`, `workflow:delete`, `workflow:list`, `workflow:activate`, `workflow:deactivate`, `execution:read`, `execution:list`, `execution:delete`, `tag:create`, `tag:list`, `workflowTags:update`. Recorded verbatim so `sandbox/manager.ts`'s provisioning step doesn't have to re-derive this by trial and error the way the spike did.
- **Verified end-to-end against the actual public API surface Kairos already calls:** `GET /api/v1/workflows` (200, empty list), `POST /api/v1/workflows` with a `[kairos-sandbox]`-prefixed disposable workflow (200, created), `DELETE /api/v1/workflows/:id` (200, cleaned up). This is the exact `N8nApiClient` surface — createWorkflow/listWorkflows/deleteWorkflow all confirmed working against a real local instance.
- Confirmed the process starts and stops cleanly (`pkill` on the npx-spawned process, verified gone).
- **Revised human task for Jordan: none, for basic sandbox setup.** `kairos sandbox up` can be a fully automated `npx n8n` boot + scripted owner/API-key provisioning — no manual account creation, no Docker install. This removes the Phase-0-blocking human dependency the original plan assumed. (Whether webhook registration works the same way locally as it does on Cloud — the documented 404 gap was Cloud-specific — is now S3's job to confirm, not S2's.)
- One real friction note for `sandbox/manager.ts` to handle: n8n's own deprecation warnings say running outside a container will eventually be required to use Docker in a future n8n version, and several `N8N_*` env vars will change defaults. Not a blocker now; worth a version-pin discipline (`n8n@2.30.7` exact, not `@latest`) so a future n8n release doesn't silently change this spike's findings.

**S3 — Payload injection mechanism. RESOLVED 2026-07-18, confirmed end-to-end against a live local sandbox.** Real test, not inference: created `[kairos-sandbox] s3-webhook-spike` (Webhook → Set), activated it via the API, POSTed a real JSON body (`{"customerName":"Jane Test","customerPhone":"555-0100"}`) at its production webhook URL (`http://localhost:15678/webhook/s3-spike`) — got back `{"message":"Workflow was started"}`, HTTP 200, **no 404**. This directly confirms local n8n does not carry the documented Cloud-specific webhook-registration gap (memory's "IMPORTANT — n8n Cloud API-activation webhook gap" section) — chaos/replay sandbox testing is unaffected by that platform bug.

Fetched the execution afterward (`GET /api/v1/executions/1?includeData=true`) and confirmed the payload landed exactly where `extractWebhookFieldRefs()`/`parseExecutionTrace()` already assume: `data.resultData.runData.Webhook[0].data.main[0][0].json.body` = `{"customerName":"Jane Test","customerPhone":"555-0100"}`, alongside `headers`/`query`/`webhookUrl`/`executionMode`. **Decision: candidate (a) confirmed working as designed** — extend `triggerWebhookProduction()`-style calls with a real `payload` argument (it currently hardcodes `{}`), fire at the sandbox's webhook URL, read the result back via `getExecution()`. Candidate (b) (trigger-swap for non-webhook workflows) is validated by the same mechanism once needed — no separate injection path required, just a different trigger node before this same POST.

Honest side-finding, not a blocker: the test fixture's downstream Set node returned an empty `json: {}` — a Set/Edit-Fields node parameter-schema mismatch for n8n@2.30.7 in my quick fixture, unrelated to injection itself (the Webhook node's own output, which is what matters for S3, was exactly correct). Flag for whoever builds real chaos/replay fixtures later: verify Set-node parameter schema against the pinned n8n version before trusting a downstream assertion, the same way `webhook-schema.ts`'s DISCLAIMER pattern already counsels.

**Cleanup verified for this spike too** (same discipline as S2): the test workflow was deleted via `DELETE /api/v1/workflows/:id` (confirmed 200), and the n8n process was killed and confirmed gone via `ps aux` afterward. No residual state, no lingering process, matching G1's cleanup requirement.

**S4 — Volatile fields in real payloads.** Question: which fields legitimately differ between two replays of the same payload (timestamps, execution IDs, generated tokens)? Method: run the same payload twice in the sandbox (needs S2/S3), diff, catalog. Unblocks: the diff engine's heuristic volatile-field list (Phase 2) with real evidence instead of guesses.

### 5.1b Privacy/capture spec (design decision, written now; full build deferred until Phase 2 per the resequencing)

Per the resequenced Phase 0 ordering (§5, "sandbox spike → privacy/capture spec → drift baseline without capture → replay only after both settled"), this is the *spec*, not the build — `replay/capture.ts` itself is built in §5.2, whenever Phase 2 actually needs it, not before.

**Decisions, made now so Phase 1 and Phase 2 both build against a settled posture instead of a moving target:**
1. **Opt-in, per-command, never implicit.** No existing command's behavior changes. Capture only happens when `kairos replay capture <wf>` is explicitly run.
2. **What's captured:** only the triggering node's output (confirmed shape from S1/S3: `headers`/`params`/`query`/`body`/`webhookUrl`/`executionMode`) — not every node's data. Minimizes stored PII to exactly what replay needs to re-inject.
3. **Where:** `~/.kairos/captures/<clientId>/<workflowId>/<executionId>.json`, `chmod 600`.
4. **Retention:** default cap 20 payloads / 30 days per workflow, both configurable; swept on each new capture, no background process (C5).
5. **Scrub:** `--scrub` passes captures through the existing memory-module secret scrubber, offered but explicitly labeled best-effort — real customer data (names, phone numbers, per S3's own test payload shape) can still be present after scrubbing, and the docs must say so plainly, not imply a guarantee that doesn't exist.
6. **Firewall from sharing (G4):** the Phase 5 whitelist serializer has no import path to this module or its output directory — enforced as a lint/test-checkable module-graph property, not just a convention, per Codex's original sandbox-safety framing extended to this boundary too.
7. **Consent copy:** the exact wording shown before the first capture, and the retention/scrub caveats in the README's privacy section, are flagged for Jordan's review before Phase 2 ships anything using this spec (unchanged from the original plan's outcome-section commitment).

This spec is the thing Phase 2's `replay/capture.ts` build must match — if implementation details drift from this during Phase 2, the plan file gets corrected in place, same discipline as the S1-S4 findings above.

### 5.2 Build: payload capture (`replay/capture.ts`) — SHIPPED 2026-07-19, own commit per Codex ("capture deserves its own careful commit like sandbox did — treat it like client data custody, not just another telemetry file")

1. **Opt-in only:** `capturePayloads()` is never called as a side effect of any other function; only an explicit call (eventually `kairos replay capture <wf>`, CLI wiring deferred same as sandbox's) writes anything. No existing command's behavior changed.
2. Fetches recent executions (`getExecutions` + `getExecution`), extracts **only** the trigger node's own input fields (`headers`/`params`/`query`/`body`/`webhookUrl`/`executionMode`) via a dedicated shape-walker, not the raw execution object — deliberately narrower than "everything n8n returns."
3. Stores under `~/.kairos/captures/<clientId>/<workflowId>/<executionId>.json`, `chmod 600` — **verified live**, not just asserted: `stat().mode & 0o777 === 0o600` confirmed against real files written by the real capture call.
4. Retention: two independent limits both enforced every call, no background process (C5) — newest `maxPerWorkflow` (default 20) survive by count, and anything older than `retentionDays` (default 30) is swept regardless of count. Unit-tested with both triggers separately.
5. `clientId` validated fail-closed against the exact same `CLIENT_ID_PATTERN` the memory module already uses for the same reason (now exported from `memory/store.ts` rather than duplicated) — an invalid clientId is rejected before it can be used to construct a file path, tested directly against a path-traversal-shaped input (`../../etc`).
6. `--scrub`: reuses the memory module's own `SECRET_PATTERNS` list (also newly exported, single source of truth for "what counts as a secret" across both modules) via a genuine recursive redaction, not the memory module's refuse-to-store behavior — capture's job is to store a usable (if imperfect) payload, not reject it outright. **Verified honest, not just working:** a live test payload containing an ordinary customer name and phone number came back `scrubbed: false` with the data fully intact (proving --scrub cannot be mistaken for a PII guarantee, exactly the doc comment's claim), while a payload containing a Bearer-token-shaped string came back correctly redacted with `scrubbed: true`.
7. **Firewall (G4), enforced as a standing test, not a comment:** `tests/unit/reliability/module-boundaries.test.ts` scans `src/reliability/community/` (once it exists — Phase 5 isn't built yet, so this is honestly vacuous today, and says so in its own doc comment) for any import of `replay/capture` or any literal reference to the `captures/` path, and fails the build the instant either appears.
8. **Revocation path, added beyond the original sketch, directly motivated by Codex's "treat it like client data custody" framing:** `deleteCapturedPayloads()` — a real, immediate "delete everything captured for this workflow" answer, not just an eventual retention-timer expiry. A custody model without an explicit deletion path isn't really custody.

**Live checkpoint, full lifecycle against a real sandbox** (boot → import a real webhook workflow → activate → fire two real HTTP requests at it, one carrying an ordinary customer name/phone, one carrying a Bearer-token-shaped string → capture without scrub, confirm both payloads captured exactly and file permissions correct → delete and re-capture with `--scrub`, confirm the token-shaped one is redacted and the ordinary customer data is not → list → delete → confirm zero remain → sandbox cleanup → stop): every step passed. Getting there surfaced two real bugs along the way, both found and fixed with their own justification, not folded silently into this commit's own scope: a `sandbox/manager.ts` provisioning-race robustness fix (§5.3's own follow-up section, above) and a genuine pre-existing bug in `N8nApiClient.getExecution()` predating this entire arc (its own section, below) — landed as three separate commits for exactly this reason.

### 5.3 Build: sandbox manager (`sandbox/manager.ts`) — SHIPPED 2026-07-19 (Phase 2's own first commit, per Codex: sandbox/capture safety infrastructure before any replay logic)

Built as one consolidated module (not split into a separate `transforms.ts` as originally sketched — the prefix/strip logic is small enough that splitting it added indirection without value; revisit only if it grows).

1. **`assertNotProduction(url)`** is the one guardrail every write path calls, not a one-time boot check — `bootSandbox`, `provisionSandbox`, `importToSandbox`, and `cleanupSandboxWorkflows` each re-run it independently, so a stale or hand-edited `SandboxConfig` can never be used to write to production even if it somehow ended up pointing there. Compares URL *origins* (not raw strings), fails open (doesn't throw) on an unparseable URL on either side — that's the caller's own validation's job. **Verified live, not just unit-tested**: set `N8N_BASE_URL` to collide with the sandbox port before ever spawning a process — `bootSandbox` refused immediately, before any child process existed.
2. **Boot/provision**: `npx --yes n8n@2.30.7` (version-pinned per S2's own finding about upcoming forced-Docker/env-default changes), `N8N_USER_FOLDER`/`N8N_PORT` isolated under `~/.kairos/sandbox/`, detached + `unref()`'d so it survives the calling process's exit, stdout/stderr to a log file rather than inherited. Readiness uses S1's own finding (`/healthz` alone isn't sufficient — polls `POST /rest/login`, treats any non-404 as "REST routes are mounted," not `/healthz`). First boot provisions an owner account + API key via the exact scripted flow S2 verified (`/rest/owner/setup` → `/rest/api-keys/scopes` → `/rest/api-keys` with the recorded scope list); subsequent boots detect the existing `sandbox.json` + a still-alive PID and skip straight to "already running," or detect an existing config with a dead process and just reboot without re-provisioning (n8n's own SQLite DB under `N8N_USER_FOLDER` already remembers the owner account).
3. **Prefix + credential-strip**: `applySandboxPrefix()` (idempotent — never double-prefixes) and `stripCredentialBindings()` (a fresh copy, doesn't mutate the input) both unit-tested in isolation, then proven together in the live checkpoint below.
4. **Cleanup**: `cleanupSandboxWorkflows()` lists every workflow on the instance and deletes only ones whose name carries the `[kairos-sandbox]` prefix — the prefix check is the entire safety rail, verified live against an adversarial case (see checkpoint).
5. **`sandbox.json`**: `chmod 600` (holds a real, if low-stakes, API key) — same discipline as the capture spec's payload files, applied here even though this specific key protects only a disposable local instance.

**Real operational finding from the live checkpoint, not assumed:** the original 120s boot timeout (based on the Phase 0 spike's "~85s cold boot") was measured against an *already-warm* `~/.npm` cache reused across that whole spike session. Booting from a genuinely fresh `HOME` with zero prior npx/npm cache for n8n took noticeably longer than 120s (a full dependency-tree install, not just a package download) and the first checkpoint attempt timed out and threw. Raised the default to 300s with the reasoning recorded in code, not just the number changed — a warm re-boot (the common case after the first real install) still returns in single-digit seconds, confirmed live (7.6s cold-but-cached, 0ms on immediate re-boot reusing an already-running instance).

**Live checkpoint, full lifecycle, via `tsx` directly against source** (not dist — this is internal reliability tooling, not part of the public SDK's `index.ts` export surface): boot (provisions fresh) → boot again (reuses existing config, 0ms, same API key, no re-provisioning) → import a workflow carrying a real credential binding (comes back prefixed) → separately create an *unprefixed* workflow directly via the raw API client, deliberately bypassing the sandbox module (the adversarial case cleanup must get right) → `cleanupSandboxWorkflows()` → confirmed only the prefixed workflow was deleted, the unprefixed one survived untouched → stop → confirmed process gone. Every step matched its expected result; the timeout finding above was the only surprise, and it was fixed with a documented reason, not silently patched.

**Not built in this commit, deliberately:** `kairos sandbox up/status/down` CLI wrapper (module is fully checkpointed and ready for it; the wrapper itself is thin and was left for whenever the CLI surface is wired, so as not to blur this commit's own scope past "safety infrastructure"). Test-mock-server extension for executions endpoints (item 4 in the original sketch) -- deferred to whenever `replay/runner.ts`'s own unit tests need it, per Codex's "own first commit" instruction for this piece specifically.

**Follow-up robustness fix, found via `replay/capture.ts`'s live checkpoint (below), landed as its own commit against this already-shipped file:** two separate live failures established that different n8n REST routes mount at different points during startup -- `waitUntilReady()`'s own `/rest/login` probe succeeding is not proof `/rest/owner/setup` is mounted yet (observed: a bare 404 on owner/setup after login had already stopped 404ing), and even once mounted, the session-cookie subsystem can lag a beat behind (observed separately: a 200 response with no `Set-Cookie` header). Both read as narrow startup races, not logic bugs -- confirmed by direct follow-up calls behaving correctly and predictably outside the race window, and by a real repeat-call test returning a clean, expected `400 "Instance owner already setup"` (proving the retry logic correctly distinguishes "not ready yet" from "a real rejection"). Fixed with a bounded retry (8 attempts, 1.5s apart) that treats 404 and 200-without-cookie as "retry," and any other non-2xx as an immediate, non-retried failure.

### Real pre-existing bug found and fixed while checkpointing capture.ts (own commit, unrelated to either sandbox or capture's own new logic)

Chasing an unrelated capture bug (0 payloads captured despite firing 2 real webhook requests) led to a live A/B test against the real sandbox: a raw `GET /executions/:id` without `?includeData=true` returns 17 fields and no `data` key at all; the identical request with `?includeData=true` returns those same 17 plus `data`/`workflowData`/`customData`. **`N8nApiClient.getExecution()` — pre-existing code, not written this session — has never passed this query parameter**, meaning every real caller (`execution-tracer.ts`'s `fetchLatestTrace()`, used by the existing `kairos trace record` command; `mcp-server.ts`; `pack-bundle.ts`'s monitoring-plan generator; the new `capture.ts`) has been silently receiving `execution.data === undefined` against any real n8n instance this whole time, despite `ExecutionDetail`'s own type declaring `data?: unknown` as if it would be populated. This was always a bug in the implementation, not a deliberately lightweight default.

Fixed at the source (`getExecution(id, options?: { includeData?: boolean })`, defaulting to `true`), not patched around locally in `capture.ts` -- the whole point of finding a shared-code bug is fixing it once for every caller, not re-encoding the same wrong assumption in a fourth place. One caller, `provider.ts`'s `pollExecution` (a tight status-only polling loop for smoke-test), genuinely doesn't want the larger payload on every tick and only ever reads `.status` downstream (confirmed by reading its caller) -- opts out explicitly with `{ includeData: false }`.

One existing test (`cli.test.ts`'s `pack export --monitoring-plan` live-status test) encoded the old, incorrect assumption directly in its mock HTTP server (`req.url === '/api/v1/executions/exec-1'`, an exact match that broke once the real query param was correctly appended) -- fixed to `startsWith`, matching the pattern already used one line above it for the executions-list endpoint. This is the only place in the test suite with that exact-match pattern (checked via grep across all of `tests/`). Full suite re-verified green after the fix (1387/1387), not just the one failing test.

This bug was invisible to every previous phase's live checkpoints because Phase 1's drift-detection checkpoints used hand-seeded synthetic `ExecutionTrace` objects (via `lib.recordTrace()`) rather than exercising `fetchLatestTrace()`'s real fetch path against a live instance -- a real gap in Phase 1's own checkpoint coverage, noted here rather than silently. `kairos trace record` against a real instance was, in practice, always recording traces with `erroredNodes: []` and empty `nodeDurations` regardless of what actually happened, since `parseExecutionTrace()` had nothing but `undefined` to read from. This is now fixed for that command too, not just for the new reliability-suite code.

### 5.4 Exit criteria (Phase 0 done when)
- All four spikes have written decisions in this file.
- Capture works against the real instance's disposable test workflows; retention sweep tested.
- Sandbox either boots end-to-end (create → inject → execute → fetch execution) or fallback mode is formally declared.
- Tests green, typecheck/lint clean, one commit per step, CHANGELOG entries.

---

## 6. Phase 1 — Drift detection core (#1, part A)

**What:** grow the existing 4-signal `detectExecutionDrift()` into a named-check engine with baselines, without breaking its current callers.

### 6.1 Baseline model (`drift/baseline.ts`)
1. Raise the trace cap: 10 → configurable (default 50) — verified cheap, traces carry names/durations/counts only. Migration: additive, old records fine.
2. `kairos drift baseline <wf>` computes and persists: success rate over window, error-class inventory, per-node duration mean+spread (data already in `nodeDurations`), item-count distribution, execution cadence (median gap between runs), core-node set, and — when captures exist — trigger payload key/type shape.
3. **Warmup honesty, revised to a real 4-state model (Jordan's explicit instruction, 2026-07-19):** every check reports one of four distinct, never-conflated statuses -- `insufficient_data` (not enough history YET; temporary, resolves with more traces), `not_applicable` (this check permanently does not apply to this workflow -- more data will never fix it), `healthy` (ran, had what it needed, found nothing), `drifting` (ran, found drift). The distinction is real, not cosmetic: D9's original "no build hash on record" was initially coded as insufficient_data before this revision, which was wrong -- a workflow Kairos never built will *never* accumulate a build hash no matter how much time passes, so it's not_applicable. Confirmed real not_applicable cases exist for D2 (baseline too fast to check reliably), D6 (historical cadence too irregular to have a meaningful expected rhythm -- measured via coefficient of variation on gaps, not guessed), D7 (no per-node duration data ever recorded), D8 (payload capture never enabled), and D9 (never built by Kairos). D1/D3/D4/D5 have no reachable not_applicable case -- documented as a deliberate absence in each check's tests, not an oversight.

### 6.2 Named checks (`drift/checks.ts`) — narrow, evidence-driven, validator-rule style
- **D1 newly-erroring nodes** (exists — port as-is)
- **D2 duration anomaly, workflow-level** (exists — port, threshold configurable)
- **D3 missing core nodes** (exists — port)
- **D4 new nodes** (exists — port)
- **D5 error-rate drift:** windowed success rate vs baseline (not just latest run — catches gradual degradation D1 misses)
- **D6 cadence drift / silent-stop:** no executions within k× median gap → the workflow may have silently stopped firing (the scariest failure for a client; detectable only with a cadence baseline)
- **D7 per-node duration anomaly:** D2 at node granularity (`nodeDurations` already recorded)
- **D8 payload-schema drift:** latest captured trigger payload keys/types vs baseline shape (only when captures exist; reported as heuristic per C3/C6)
- **D9 build-vs-live structural drift:** `originalBuildHash` vs `liveExportHash` — someone edited the deployed workflow outside Kairos. Consumes the hook 0.11.0 already shipped.

Each check: id, severity, evidence payload, configurable thresholds (env/config, documented defaults), one focused test file. **Not doing:** ML/statistical anomaly detection — explicit thresholds only, this arc.

**`evidenceQuality` on error-based findings (Codex second opinion, folded in — directly motivated by the S1 spike finding).** S1 confirmed that error classification reliability genuinely varies by node/error class: a Code-node thrown error has no `name`/`type` to classify with (always falls back to `'UnknownError'`), while an HTTP Request node error carries `name` *and* `httpCode` (`'NodeApiError'`/`'ENOTFOUND'` etc.) — real, specific, actionable detail. Reporting both with the same confident tone would overstate certainty for the weak case. So D1 and D5 (the two checks built on error classification) carry an `evidenceQuality: 'specific' | 'generic'` field alongside their finding:
- `'specific'` — the underlying error carried `httpCode` and/or a real `name` beyond a bare exception — Kairos can say *what kind* of failure this is, not just that one occurred.
- `'generic'` — classification fell back to `'UnknownError'`/bare message only — Kairos can say a node started erroring, but not confidently why, and diagnose.ts must not invent a cause it doesn't have evidence for.

Extends the same D6/`errorType` extraction `execution-tracer.ts` already does — reads `httpCode` when present (currently captured nowhere), and threads `evidenceQuality` through the check → diagnosis → escalation report chain so a human sees "high-confidence: rate limited (429)" vs. "an error occurred, cause unclear — inspect manually" as visibly different statements, not the same finding with different words. This is a concrete instance of C6/G5 (honesty discipline) applied specifically to drift findings, not a new principle — worth naming because S1 showed the failure mode is real, not hypothetical.

### 6.3 Diagnosis (`drift/diagnose.ts`)
Maps each fired check → (likely causes list, evidence gathered, recommended action) rendered as a structured escalation report — same philosophy as Phase A escalation: Kairos's default competent behavior is *telling a human precisely what's wrong*, not guessing. Action classes this phase: OBSERVE / ESCALATE only (repair is Phase 3). **`evidenceQuality` gates how confidently a cause is stated**, not just how the finding is phrased: a `'generic'`-quality D1/D5 finding can only ever produce an ESCALATE with "inspect manually, cause not determinable from execution data" — diagnose.ts must not fabricate a plausible-sounding cause to fill the gap.

### 6.4 Surface -- SHIPPED 2026-07-19 (checks, diagnosis, and CLI; MCP tool deferred)

**`diagnose.ts`, per Jordan/Codex confidence-tiering spec:** every drifting finding gets a `DriftDiagnosis` with exactly six fields (evidence, causeStatement, recommendedAction, repairClass, confidence, checkId+workflowId+affectedNodes) and rigid, non-improvised confidence language -- `high` -> "Likely caused by: X", `medium` -> "Possible cause: X", `low` -> "Observed symptom; cause unknown." (cause text never leaks at low confidence). Confidence is per-check judgment (documented inline, not asserted): D1 follows its own `evidenceQuality` (specific->high, generic->low, no medium); D9 is high (a hash mismatch essentially names its own cause); D2/D3/D4/D5/D6/D7/D8 are medium (a real, narrower-than-nothing causal story, but not a single determinable cause from execution data alone). `repairClass` (`mechanical`/`escalation_only`) matches the plan's own 8.2 design table for D2/D5/D6/D7/D8/D9; D1/D3/D4 required independent judgment calls since 8.2 didn't name them explicitly (documented in code comments, not silently decided). `diagnoseDrift()` returns `null` for any non-`drifting` status -- nothing is manufactured for insufficient_data/not_applicable/healthy.

**CLI, both commands real and checkpointed against actual data, not just typechecked:**
- `kairos drift baseline <n8n-workflow-id> [--json]` -- reports readiness, not a verdict: which checks are `captured` (real data, healthy or drifting) vs `skipped` (insufficient_data or not_applicable), each skip with its own reason. Exactly the "clearly say what was captured and what was skipped" requirement.
- `kairos drift check <n8n-workflow-id> [--live] [--original-build-hash <hash>] [--json]` -- runs all 9 checks, diagnoses every drifting one. **Exit code contract verified live, not assumed:** a healthy 3-trace workflow exits 0; a workflow with only `insufficient_data`/`not_applicable` findings (D5/D8/D9 on 3 traces) also exits 0 -- confirmed those statuses never trip the exit code. Inducing a real drift (a 429 on a previously-clean node, which fires both D1 and D3) flips the verdict to DRIFTING and the process to exit 1, with the diagnosis section showing the exact tiered language live: D1's specific-evidence 429 renders "Likely caused by: ..." (high, mechanical); D3's structural read renders "Possible cause: ..." (medium, escalation_only). `--json` output checked byte-for-byte against the rendered text's own data -- confirmed it's the literal `DriftCheckReport` object (all 9 findings incl. `evidenceQuality`, both diagnoses), not a lossy re-summarization.
- New telemetry event `drift_check_completed` (schema v3->v4), wired with the same try/catch-swallow discipline as `bundle_exported`/`preflight_completed` -- telemetry never changes the command's own exit behavior.
- D9's `originalBuildHash` is explicitly `--original-build-hash <hash>`-supplied, not auto-discovered -- confirmed during CLI wiring that `StoredWorkflow` (the general library record `kairos drift` operates on) carries no provenance/hash field at all; that data currently only lives inside pack-export results (`PackWorkflowResult.provenance`). Honestly reports `not_applicable` rather than inventing new storage under time pressure. Revisit if/when provenance gets threaded into the general library record.
- **Real bug found and fixed during the live checkpoint, not by inspection:** the first checkpoint attempt failed with "No library entry found," which traced back to `FileLibrary`'s `isValidMeta()` correctly rejecting a test fixture missing `workflow.name` (silently dropped by `JSON.stringify` since `workflowName: workflow.name` resolved to `undefined`) -- not a Kairos bug, a synthetic-fixture gap (real n8n/Kairos-built workflows always have a name). Documented here so the next person hitting this exact "orphaned workflow file" warning doesn't re-chase it as a library bug.
- Also fixed in passing: README's execution-trace-learning section still said traces cap "at up to 10 per workflow" -- stale since 6.1 raised the default to 50 (`KAIROS_MAX_TRACES_PER_WORKFLOW`).

**Deferred, not forgotten:** MCP `kairos_drift_check`/`kairos_drift_baseline` tools (plan originally scoped these here) -- CLI + telemetry covered Codex's three explicit asks and the live checkpoint; MCP wiring is mechanical (mirrors preflight's MCP tool exactly) but wasn't rushed in without its own verification pass. `reliability-audit.jsonl` (G6) also not yet wired for drift specifically -- follows once Phase 3 (repair) exists, since right now there's nothing automated happening beyond reporting for a human to read directly.

### 6.5 Checkpoint (end-to-end, real)
Disposable two-workflow Empire-*shaped* pack on the real instance (never real Empire workflows): record ≥5 baseline traces, then induce three drifts — add a failing node (D1), simulate schema change in a test payload (D8), stop triggering it (D6, with shortened test cadence) — verify each fires with correct evidence, verify HEALTHY on an undisturbed control workflow. One commit per step throughout; suite green; docs-drift green.

---

## 7. Phase 2 — Replay engine (#4)

**Precondition:** S2 sandbox exists (else this phase enters fallback §13).

### 7.1 The core design decision: sandbox-vs-sandbox diffing
Production executions supply **payloads only**. Both the baseline workflow version *and* the candidate version are replayed **in the sandbox**, and the two sandbox runs are diffed against each other — never sandbox-vs-production. Why: the sandbox has no credentials, so credentialed nodes fail identically on both sides and cancel out; comparing sandbox-vs-production would drown the diff in credential noise. This is the honest comparison: same payloads, same degraded conditions, only the workflow version differs.

### 7.2 Runner (`replay/runner.ts`) — SHIPPED 2026-07-19, own commit per Codex, live-checkpointed against a real sandbox

Built against Codex's explicit 8-point guardrail list (2026-07-19), each enforced in code and confirmed live, not just documented:

1. **Cleanup always runs, even on timeout/failure** — both imports deleted in a `finally`, each independently `.catch(() => {})`-guarded so one failing delete can never block the other. Live-verified: after a full run, the sandbox showed exactly the untouched setup workflow and neither the baseline nor candidate import.
2. **Baseline/candidate separation unmistakable** — sandbox workflow names literally prefixed `baseline: `/`candidate: ` (on top of the existing `[kairos-sandbox]` prefix), carried through into every returned result field (`baselineImportedName`/`candidateImportedName`, `baselineExecutionId`/`candidateExecutionId`).
3. **Production never executed against** — `runReplay()`'s only inputs are a `SandboxConfig` and already-captured payloads read from disk; there is no code path in this module that touches a production client. `assertNotProduction` called again at the top anyway, same defense-in-depth pattern as sandbox/manager.ts.
4. **Bounded polling with backoff** — `replayOnePayload()` polls with a real backoff (starts at `pollIntervalMs`, multiplies toward `maxPollIntervalMs`), never a tight loop, never indefinite. Unit-tested with real (short) timeouts, not mocked timers: confirmed a found execution returns promptly, and confirmed a genuinely-missing execution takes at least the full timeout and no more than timeout+2s — proving it actually polled rather than either failing instantly or hanging.
5. **"No execution found" is its own status, never folded into a pass** — `PayloadReplayStatus: 'no_execution_found'` is structurally distinct from diff.ts's `'not_reached_by_this_payload'` (which means something categorically different: a legitimate untaken branch). Any `no_execution_found` outcome forces the whole run's verdict to `'INCOMPLETE'`, overriding whatever the comparable payloads showed — a run can never report a clean verdict while silently failing to test something. Unit-tested directly, including the case where the same execution ID appears on every poll (proving the "before" snapshot correctly distinguishes stale from fresh).
6. **Every outcome carries full traceability** — the original capture's own `executionId` (`payloadId`) plus both fresh sandbox execution IDs this run created (`baselineExecutionId`/`candidateExecutionId`), confirmed live as three distinct, correct values in one real run.
7. **Structured output first, rendered text second** — `ReplayRunResult` is the real return type; `formatReplayRunResult()` is a separate, later function, same discipline as drift/report.ts and diff.ts's own formatters.
8. **Credentials never added to the sandbox** — this module has no path that wires credentials in; `importToSandbox` already strips them (sandbox/manager.ts) and this module only ever calls that. Confirmed live: the credentialed `CRM Lookup` node correctly shows as `unverifiable`/`credential_stripped` in every real run, never silently "working."

`buildSnapshotFromExecution()` walks the same real `execution.data.resultData.runData` shape S1 confirmed, generalized from capture.ts's trigger-only extraction to every node (replay needs to compare the whole workflow, not just its input), reusing the same httpCode-aware error-typing discipline `execution-tracer.ts` already established. Exported and directly unit-tested, including the exact S1-confirmed shapes for both error classes (Code-node bare error -> `UnknownError`; HTTP Request node -> real `name`/`httpCode`).

**A real, structural bug found via the live checkpoint (not the unit tests, which had no way to catch it): baseline and candidate normally share the exact same webhook path in production** (a candidate is, by definition, meant to replace a workflow at the same path) — importing both into the sandbox and activating them simultaneously (replay's whole point) makes n8n correctly refuse the second activation with `409 "conflict with one of the webhooks"`. Fixed in `sandbox/manager.ts` (already-shipped code, its own commit): `importToSandbox()` now rewrites every imported webhook's path to a unique value on a copy of the workflow (never mutating the caller's own object), and `SandboxImportResult` carries the actually-registered `webhookTrigger` so `runner.ts` injects against reality, never the original workflow's stale `parameters.path`. 4 new tests on the rewrite function itself (uniqueness, non-mutation, no-op for non-webhook workflows).

A second, smaller finding from the same checkpoint, **not a code bug**: an early attempt to prove real `BEHAVIORAL_CHANGE` detection using a `Set` node's parameters produced an unexpected `IDENTICAL` result. Direct investigation (a dedicated raw-execution-data check, not assumption) confirmed both configurations produced literal `"json": {}` regardless of parameters -- the diff engine correctly reported the true, if surprising, fact; the fixture's `Set`-node parameter shape (`{mode: 'manual', fields: {...}}`) simply didn't match what n8n@2.30.7's real Set node (typeVersion 3.4) expects, exactly the risk the S3 spike already flagged ("verify Set-node parameter schema against the pinned n8n version before trusting a downstream assertion"). Re-ran the behavioral-change proof using a `Code` node instead (simple, well-understood JS logic, already proven reliable in S1) and got the expected, correct `BEHAVIORAL_CHANGE` result with an exact, itemized output-shape diff.

### 7.3 Diff engine (`replay/diff.ts`) — SHIPPED 2026-07-19, own commit per Codex ("this is now becoming the actual safe-change engine")

Built and fully tested (13 tests) as a pure module, before `replay/runner.ts` exists — deliberately, per Codex's ordering: diff.ts needs only two already-collected snapshots and both workflow JSONs, never a live sandbox, so it's fully unit-testable in isolation with synthetic fixtures matching S1's real confirmed shapes.

**"No fake equivalence" (Codex, 2026-07-19) is the module's organizing discipline, not a bolt-on check.** The design realization that shaped everything else: in the sandbox, every credentialed node gets stripped (`sandbox/manager.ts`'s `stripCredentialBindings`), and almost every real Kairos-generated workflow has most of its nodes past the trigger calling a credentialed external service (CRM, Twilio, Sheets...). So "baseline and candidate both fail identically at the same credential-stripped node" isn't a rare edge case to special-case — for a typical real workflow, it's the *normal* shape a replay run will take. Treating that as a clean match would be actively misleading, not just imprecise.

**How it's enforced, concretely:**
- Credential-dependency is determined **structurally**, from the real workflow JSON (which node originally had a `.credentials` binding) and a BFS closure over the `main` connections graph to find everything only reachable through it — not by pattern-matching error messages, which would be guessable and fragile. Uses the union of both baseline's and candidate's credentialed nodes, since either version could introduce a new one.
- The one deliberate exception, tested directly: if a structurally-credentialed node nonetheless shows a genuine successful run on **both** sides, that observed reality is trusted over the structural assumption (not every credentialed node necessarily throws when uncredentialed) — verified with its own test (`'trusts a genuine successful run over the structural credential assumption when both sides actually succeed'`).
- Every `PayloadDiffResult` carries two independent axes, never collapsed into one: `verdict` (what changed among what *could* be compared) and `verificationBoundary: { verified, unverifiable }` (what could and could not be compared, and specifically why — `credential_stripped` vs. `downstream_of_unverifiable`). `partialVerification: true` is set whenever the boundary is non-empty.
- **The rendered report makes this loud, not a footnote** — `formatPayloadDiffResult()` prints `(PARTIAL VERIFICATION -- see boundary below)` directly in the verdict line and a `⚠ VERIFICATION BOUNDARY` section explicitly stating downstream business behavior was "not exercised," enforced once in the shared formatter so no future CLI/report caller has to remember to add it themselves. Tested directly (`'the rendered report makes the boundary loud, not a footnote'`).
- **Real behavioral changes in the credential-free prefix are still caught, not swallowed by downstream credential noise** — tested directly: a workflow with a genuine output-shape change in an early `Set` node correctly reports `BEHAVIORAL_CHANGE` even though the same payload's `HTTP Request`/`Send Email` nodes remain unverifiable in the same result.

**Verdicts** (`IDENTICAL` / `BENIGN_VARIANCE` / `BEHAVIORAL_CHANGE` / `BROKEN`), computed only from the *verifiable* portion: node-coverage changes (branch flips), output-shape changes (keys/types only, never values), error-class changes, and — distinctly — a candidate erroring where baseline succeeded is `BROKEN`, while the reverse (candidate succeeding where baseline errored) is `BEHAVIORAL_CHANGE`, not silently accepted as an improvement. `BENIGN_VARIANCE` is reserved for duration-only divergence (>2x either direction) with no other change — the S4 volatile-field discipline shows up here as "duration is the one dimension allowed to vary without being a finding," everything else (raw values, timestamps, execution IDs) was never part of the shape comparison to begin with. A node neither side reached, and that isn't credential-attributable, is reported as `not_reached_by_this_payload` (an untaken conditional branch) — not a finding, not unverifiable, just not part of this payload's path.

`aggregateReplayResults()`: a suite's verdict is the single worst verdict among all its payloads (severity-ordered), and `partialVerification` is true if *any* payload had it — one clean payload can never paper over a partially-verified one.

### 7.4 Surface + gate
- `kairos replay run <wf> --candidate <file>` → report (human + `--json`), exit 0 on IDENTICAL/BENIGN, 1 otherwise.
- `kairos replace --replay`: runs the suite before swapping; refuses on BROKEN, warns-and-asks on BEHAVIORAL_CHANGE (`--accept-changes` to proceed — some behavioral changes are the *point* of the change; the tool's job is proof, not prohibition).
- MCP `kairos_replay_run`. Telemetry `replay_completed`.

### 7.5 Checkpoint
Real sandbox, disposable workflow, 3 captured payloads: (a) no-op candidate → IDENTICAL; (b) candidate with changed Set-node mapping → BEHAVIORAL_CHANGE naming the exact node and keys; (c) candidate with broken expression → BROKEN. Then one full `kairos replace --replay` run end-to-end against the real (disposable) workflow.

---

## 8. Phase 3 — Self-healing loop (#1, part B)

**What:** close detect→diagnose into propose→verify→apply→rollback. **Escalation remains the default posture; auto-repair is narrow, opt-in, and verified-by-replay.**

### 8.1 Snapshots (the honest slice of "rollback")
Before *any* Kairos-driven `replace()` (existing command included): store prior live JSON in `~/.kairos/snapshots/<wf>/<ts>.json` (cap default 10). `kairos rollback <wf> [--to <ts>]` = replace-from-snapshot, reusing all existing replace machinery (diff summary, webhook-verify). *Not* building: full git-for-workflows versioning product — stays on the held-off list.

### 8.2 Proposal generation (`drift/repair.ts`)
Per drift class, honestly tiered:
- **Mechanical (proposable):** D9 build-vs-live → propose re-sync (restore Kairos's built version or re-export live as new baseline — human picks direction); D8 schema drift → propose a regenerated field-mapping via existing `replace()` + targeted feedback prompt (generation machinery already supports targeted retry feedback); D1 where the error class maps to a known pattern (e.g. missing onError on an external call — existing rules 56/128 knowledge) → propose the specific config addition.
- **Diagnostic-only (escalate, v1):** D2/D5/D6/D7 — latency, error-rate, cadence drifts have external causes (API slowness, credential expiry, upstream volume) no workflow edit fixes. Proposing edits here would be theater. The escalation report says what to check instead. **This asymmetry is correct behavior, documented as such.**
- Every proposal = workflow diff + rationale + attached replay report (when sandbox exists).

### 8.3 The ladder (enforced order, audited at every rung)
```
detect → diagnose → propose → [human approves | KAIROS_AUTO_REPAIR for whitelisted classes]
      → snapshot → replay-verify (must be IDENTICAL/BENIGN on non-targeted behavior)
      → apply via replace() → post-verify (webhook-verify + fresh drift check)
      → on post-verify failure: AUTO-ROLLBACK from snapshot + escalate loudly
```
Guardrails hard-coded: cooldown per workflow (default 1h), max 1 auto-attempt per distinct cause (second occurrence always escalates), flap detection (rollback ↔ repair cycling halts the loop and escalates), every rung appends to `reliability-audit.jsonl`. Without a sandbox, auto-repair is **disabled entirely** — propose-only (no unverified automated writes to a live workflow, ever).

### 8.4 Surface + checkpoint
`kairos repair propose <wf>` / `kairos repair apply <wf> [--auto]`; MCP mirror for propose only (apply stays CLI — a deliberate human-friction choice). Checkpoint: induce D9 on a disposable workflow → propose → approve → watch snapshot/replay/apply/post-verify chain run; then induce a post-verify failure (candidate that breaks webhook-verify) → confirm auto-rollback restores the snapshot and escalates.

---

## 9. Phase 4 — Chaos testing (#3)

### 9.1 Tier A — static robustness audit (no sandbox needed; ships regardless of S2)
1. **Payload families** (`chaos/payloads.ts`), generated from `extractWebhookFieldRefs()` + captured payloads when present. Enumerated list (each with rationale, each extensible later): valid-baseline, missing-required-field (one per referenced field), null-valued field, wrong-type field (string↔number↔object), empty body, empty strings, oversized string (configurable, default 100KB), unicode/emoji, array-where-object, `__proto__`/`constructor` keys (JSON.parse is safe but downstream naive merges aren't), injection-shaped strings (`'; DROP`, `{{ }}`, `<script>`) — probing handling, not exploiting.
2. **Static findings** (`chaos/static-audit.ts`): per adversarial payload, trace referenced fields through node expressions — flag unguarded refs that would evaluate `undefined` (per-node, per-payload: "removing `body.customerPhone` breaks 'Send SMS' — no default, no guard"); flag external-call nodes lacking onError/retry posture; flag absent error-workflow. **Design step obligation:** audit overlap against existing Rules 56/57/59/127-130 first — chaos findings must *reference* rules where they exist ("Rule 128 would catch this") and only add the input-driven analysis the structure-driven validator can't do. No duplicated logic.
3. `kairos chaos audit <wf|pack>` → report with the webhook-schema DISCLAIMER discipline (static analysis of expressions is heuristic; says so).

### 9.2 Tier B — sandbox chaos runs (`chaos/sandbox-run.ts`; needs S2)

**Architecture (Codex second opinion, folded in): chaos Tier B is not a separate execution pipeline — it's Phase 2's replay runner and diff engine, called with the payload as the varying dimension instead of the workflow version.** Replay holds the payload fixed and varies the workflow version (old vs. candidate); chaos holds the workflow version fixed and varies the payload (valid-baseline vs. adversarial). Both are "inject → run in sandbox → diff against a reference." `chaos/sandbox-run.ts` becomes a thin adapter: generate the adversarial payload set (`chaos/payloads.ts`), call `replay/runner.ts` once per payload with the *valid-baseline execution* as the diff reference, and remap `replay/diff.ts`'s verdicts (IDENTICAL/BENIGN_VARIANCE/BEHAVIORAL_CHANGE/BROKEN) onto chaos's own labels below. This removes a duplicate injection/execution/diff pipeline that added nothing chaos-specific.

1. Import (prefix, cred-strip) → run every payload family member through the shared replay runner → collect executions.
2. Classify per payload (mapped from the shared diff verdicts): `HANDLED` (IDENTICAL/BENIGN_VARIANCE — completed, no meaningful deviation from the valid-baseline run) / `CRASHED` (BROKEN — execution error; the node and error class named) / `SILENT_MISBEHAVIOR` (BEHAVIORAL_CHANGE — completed but node-coverage/branch/output-shape diff vs. the valid-baseline run) / `BLOCKED_AT_CREDENTIAL` (failure at a credentialed node — reported inside the verification boundary as *unverifiable in sandbox*, never asserted as a HANDLED/CRASHED/SILENT_MISBEHAVIOR finding).
3. Only pre-credential findings are asserted. Rate-limit/500/timeout fault injection against external APIs requires a mock-sink URL-rewrite layer — **explicitly deferred (v2)**, sketched in §14, not built.
4. `kairos chaos run <wf>`; telemetry `chaos_completed`; findings feed the pattern system as a new pattern source (drafts, normal lifecycle).

### 9.3 Checkpoint
Disposable webhook workflow with one deliberately unguarded field ref and one guarded: Tier A predicts the break; Tier B confirms it live (CRASHED with matching node), guarded field survives (HANDLED), and one credentialed node correctly reports BLOCKED_AT_CREDENTIAL rather than a false CRASHED finding.

---

## 10. Phase 5 — Community pattern library (#2)

**The no-server design:** GitHub is the aggregation point; the maintainer review *is* the quality gate; the npm package *is* the distribution channel. Zero hosted infrastructure (C5), full public transparency, human-gated by construction — consistent with Phase D's philosophy.

**Split into two sub-phases (Codex second opinion, folded in).** Export and ingestion are different commitments — export is "make my own local patterns safely shareable," ingestion is "become an ongoing curator of a shared corpus for everyone." Bundling them risked treating a much bigger commitment (5b) as a same-size step as a much smaller one (5a). They now ship separately, with 5b explicitly gated:

- **Phase 5a — export only (§10.1-10.2).** Local pattern hygiene already exists (Phase D). Ships: the whitelist serializer and the share flow. This has real standalone value even with zero ingestion ever built — an anonymized, reviewable pattern report is useful on its own, and it's the smaller, lower-commitment half.
- **Phase 5b — ingestion (§10.3).** Explicitly gated: only start this after **several real 5a export cycles have happened and been reviewed** — a real precondition, not just "whenever we get to it." Ingestion is where the ongoing-curation commitment actually begins, and it shouldn't be scoped before there's evidence the export side works and produces something worth ingesting.

### 10.1 Whitelist serializer (`community/whitelist.ts`) — the load-bearing privacy wall
1. **Whitelist-only, by construction:** the serializer's input type only *has* fields for: rule IDs, drift-check IDs, chaos verdict enums, node **type** names (`n8n-nodes-base.httpRequest` — never instance names), error-class enums, occurrence counts, kairos/n8n version strings. Free text, workflow names, URLs, parameter values, expressions, and payloads are not representable in the type — nothing to scrub because nothing else can exist. (Blacklist-scrubbing is the approach that fails; this is the approach that can't.)
2. No import path from `captures/` or client memory into this module (G4); a lint-enforceable boundary plus a test asserting the module graph.

### 10.2 Share flow (`community/share.ts`)
1. `kairos patterns share` → builds report → **prints the exact bytes that would leave the machine** → explicit y/N confirm → writes `pattern-report.json` + opens a prefilled GitHub issue URL against `Kruttz/Kairos` (uses `gh` CLI if present, else prints the URL). Off by default, per-invocation consent, **no background transmission path exists in the codebase** — that's a checkable property, not a promise.
2. Repo side (Jordan, one-time): issue template for pattern submissions, CONTRIBUTING section describing review criteria (dedup, minimum occurrence count, plausibility).

### 10.3 Ingestion (`community/ingest.ts`)
1. Reviewed submissions merge into `community-patterns.json`, shipped inside the npm package (distribution = normal releases; `kairos patterns sync` = optional raw-GitHub fetch between releases, same file, signature-checked by content hash listed in the repo).
2. Loaded patterns carry `provenance: community`, enter at **draft tier with reduced weight** (existing scoring accommodates this), and can never auto-promote past draft without *local* confirming evidence — a community hint becomes a local pattern only when this install's own telemetry corroborates it.
3. Honest cold-start note in docs: initially the corpus is one maintainer's data; the value compounds with adoption. (Forum mining remains the shelved accelerant if wanted later.)

### 10.4 Checkpoint
Round-trip: generate a share report from real local patterns → verify by eye nothing non-whitelisted appears → simulate maintainer merge → `sync` → verify ingestion at draft/community provenance → verify a local corroborating event promotes it and a non-corroborated one never promotes.

---

## 11. Phase 6 — `kairos watch` + repositioning polish

1. **`kairos watch [--interval <s>] [--workflows <ids|all>]`** — a foreground loop: drift check per workflow per tick; on DRIFTING → diagnose, propose (if mechanical), notify (stdout + audit log; optional shell-hook for user-supplied notification commands). Documented cron/launchd recipes for background use. Explicitly not a daemon/service (C5).
2. **README repositioning:** restructure around the reliability loop (§1 diagram); generation demoted to one section. The honest benchmark discipline applies — no claims without a measured artifact behind them.
3. **Scripted demo = acceptance test:** one script that builds a disposable workflow, chaos-audits it, deploys, baselines, induces drift, watches Kairos catch/diagnose/propose/verify/repair/rollback. Doubles as the arc's end-to-end regression and the marketing demo. If the demo script can't run truthfully, the arc isn't done.
4. Version/CHANGELOG: this arc is the v1.0 story candidate (Jordan's call at the end, not before).

---

## 12. Cross-cutting guardrails (consolidated, enforced not aspirational)

- **G1 Production protection:** sandbox modules refuse production-matching base URLs (tested); chaos/replay only ever execute on `[kairos-sandbox]`-prefixed imports; cleanup is prefix-scoped; checkpoints use disposable Kairos-created workflows only — never Empire's (July 6 discipline, now codified).
- **G2 Escalation-first:** every automated path defaults to reporting, not acting. Auto-repair: opt-in env var + whitelisted mechanical classes + replay-verified + snapshot-backed + cooldown/flap-limited.
- **G3 Payload privacy:** capture is opt-in per command; local-only, `chmod 600`, retention-capped; scrub offered and labeled best-effort; documented plainly.
- **G4 Sharing firewall:** whitelist-only serializer, no import path from captures/memory, pre-share byte-diff, per-invocation consent, no background transmission code path.
- **G5 Honesty:** heuristic labels on heuristic outputs; INSUFFICIENT_DATA first-class; BLOCKED_AT_CREDENTIAL never reported as a finding; DISCLAIMER pattern inherited; CHANGELOG corrections when claims prove wrong (0.11.0 set the precedent).
- **G6 Audit:** every automated observation, proposal, application, rollback → `reliability-audit.jsonl` (pattern-audit.jsonl conventions).
- **G7 Process:** re-read the touched modules at each phase start (memory ≠ code); one commit per step; tests grow every phase; typecheck/lint/docs-drift green before every commit; real end-to-end checkpoint before a phase closes; pattern-extraction review after every session (standing feedback); plan file updated in place as spikes resolve.
- **G8 Scope:** no hosted infra, no Zapier/Make, no ML anomaly detection, no auto-ROI numbers, no flywheel, no forum mining — all live elsewhere on the roadmap, none sneak in here.

---

## 13. Risks and honest unknowns

- **Sandbox may not materialize (top risk).** S2 may find npx-n8n unworkable and Jordan may not want Docker. **Fallback mode, pre-committed:** Phase 2 deferred; Phase 3 ships propose-only with auto-repair disabled; Phase 4 ships Tier A only. Phases 1, 4A, 5, 6 — the majority of the repositioning value — ship regardless. The arc does not collapse if the sandbox does.
- **n8n's `/workflows/:id/run` (`triggerManual`) may not exist on all versions/instances** — verified in S1/S2 before anything depends on it; webhook-based injection is the primary path anyway.
- **Baseline false positives during warmup** — mitigated by INSUFFICIENT_DATA gating and conservative defaults; thresholds configurable; expect a tuning pass after real use, and say so in docs.
- **Payload PII** — even opt-in, captures hold real customer data (Empire's flows carry names/phones). Mitigations in G3; residual risk documented for the user, not hidden.
- **Community cold start** — corpus starts as one person's data; stated plainly (§10.3). Value thesis is compounding, not instant.
- **Post-July-9 code I haven't read deeply** (0.10/0.11 internals beyond CHANGELOG) — G7's phase-start re-read covers this; the plan's per-phase design steps re-verify their own dependencies.
- **Timeline pressure from life** (Claude Corps process, MS program, Empire work) — phases are independently shippable and ordered so any stopping point leaves shipped, coherent value (§15).

## 14. Explicitly deferred (so they don't creep in)

Mock-sink fault injection (rate-limit/500 simulation via URL rewriting) — sketched: `transforms.ts` gains a rewrite map to a local sink server returning scripted faults; real work, v2 of chaos. Multi-instance drift dashboards; hosted anything; scheduled daemon; pattern-library web UI; intake interview; P&L; flywheel; Zapier/Make. Each has a home on the roadmap already — none belong in this arc.

## 15. Sequencing, sizing, definition of done

**Order:** P0 → P1 → P2 → P3 → P4 → P5 → P6. (P4 Tier A may float earlier if a stall needs a quick win — it has zero dependencies.)

**Sizing against demonstrated velocity** (memory layer ~1 session; Delivery Bundle 6 commits/~2 days; preflight 4 phases/2 days; 0.11 chaining 10 commits):
- P0: 1-2 sessions (spike uncertainty dominates) — S2 first
- P1: 1-2 sessions · P2: ~2 sessions (hardest engineering) · P3: 1-2 sessions
- P4: 1-2 sessions · P5: 1 session · P6: 1 session
- **Arc total: realistically 8-11 focused sessions**, spread as life allows; every phase boundary is a safe pause.

**Definition of done, per phase:** design step re-verified against current code → build steps landed one commit each → new tests green, full suite green, typecheck/lint/docs-drift clean → real end-to-end checkpoint passed against disposable workflows → CHANGELOG entry written honestly (including anything that didn't survive contact with reality) → plan file updated → pattern-extraction review offered.

**Definition of done, arc:** the §11.3 demo script runs truthfully end-to-end; README tells the reliability-loop story; a skeptic reading the repo for five minutes can no longer say "n8n already does this."

## 16. Outcome

When this ships, Kairos is no longer a generator with good manners. It is the system that **proves an automation before it goes live, watches it for as long as it runs, demonstrates any change is safe before applying it, heals what it can, escalates what it can't with evidence in hand, and gets smarter with every failure anyone in its community has ever hit.** That is not a feature n8n's builder competes with — it's the job that starts where every builder stops.

**Human tasks flagged for Jordan (small, non-blocking to start):** S2 sandbox decision when the spike presents options (possible Docker Desktop install *or* a one-time local-n8n owner setup + API-key paste); GitHub issue template approval for Phase 5; review of consent/privacy copy before Phase 0.2 ships.
