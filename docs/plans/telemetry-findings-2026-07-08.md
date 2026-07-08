# Step 1 Findings — Real Telemetry Read (2026-07-08)

**Source:** `~/.kairos/telemetry/*.jsonl`, 7 files spanning 2026-06-18 to 2026-07-06.
**Volume:** 1,303 total events — `build_start`: 455, `generation_attempt`: 435, `build_complete`: 413. Not thin — this is a real, substantial sample (the July 4 spike of 890 lines in one day almost certainly corresponds to the 282-run backend-viability benchmark referenced in project memory: 94 prompts × 3 repeats).

## Headline numbers

- First-attempt validation pass rate: **94.5%** (411/435 `generation_attempt`s passed validation).
- Overall build success rate: **99.5%** (411/413 `build_complete`s succeeded) — the gap between 94.5% and 99.5% is the retry loop doing its job.
- Attempt-count distribution: 393 builds succeeded in 1 attempt, 18 needed 2, 2 needed 3. Retries are rare and mostly resolve on the second try.
- **Parse failures: zero.** No `AttemptMetadata.parseFailure` occurrences anywhere in the sample.
- `workflowType` distribution: webhook (132), email (97), slack (64), schedule (11), messaging (11), data (9), ai (9), api (6), devops (4), database (3).
- Token totals across `build_complete`: ~467K input, ~1.32M output.

## Top firing rules (`generation_attempt.issues[]`, by count)

| Rule | Severity | Stage | What it checks | Count |
|---|---|---|---|---|
| 126 | warn | node_generation | Node ID doesn't match UUID v4 format | **2,263** |
| 78 | warn | workflow_structure | No `errorWorkflow` configured in settings | 363 |
| 80 | warn | node_generation | Set node v3+ has assignments but `includeOtherInputFields` not enabled | 359 |
| 59 | warn | node_generation | Webhook node has no authentication configured | 209 |
| 35 | warn | node_generation | Email-sending node with no duplicate-prevention signal | 169 |
| 75 | warn | node_generation | `emailSend` node missing `toAddresses`/`subject`/`message` | 161 |
| 11 | warn | connection_wiring | Node has no incoming connections, may never execute | 28 |
| 17 | *(undefined)* | credential_injection | Credential shape (object with id/name) | 23 |
| 55 | warn | node_generation | Google Sheets `sheetName` is a placeholder literal | 19 |
| 129 | warn | node_generation | Node's resource/operation doesn't exist in real n8n schema | 13 |
| 90 | **error** | connection_wiring | `respondToWebhook` exists but no webhook has `responseMode="responseNode"` | 8 |
| 128 | warn | node_generation | `onError: continueErrorOutput` set but error output port unwired | 7 |

## `build_complete.warnedRules` (rules present in the *final, delivered* workflow of a successful build)

| Rule | Severity (per source) | Count | Note |
|---|---|---|---|
| 17 | *(shape check)* | 357 | Fires on **86% of all successful builds** |
| 14 | error | 357 | "Workflow must contain at least one trigger" — also 86%, worth double-checking this reflects reality, not a labeling artifact |
| 90 | **error** | 199 | 48% of successful builds still carry an ERROR-severity rule in their final state |
| 66 | **error** | 157 | HTTP Request URL missing protocol prefix — 38% of successful builds |
| 10 | error | 24 | Connection references a nonexistent node |

## What this means for the plan

1. **Zero parse failures kills the premise of the "syntactic JSON-repair modes" hold-off item, for now.** LangChain-style fence-stripping/truncation-tolerant repair (Section 12, item E's companion) has no evidence of a problem to solve in this window. Recommendation: leave it exactly where the plan already has it — trigger-gated, untouched — and don't add fixtures for a failure shape that hasn't occurred.

2. **Rule 126 (2,263 hits, by far the most dominant signal) is a strong "confidence-filtered reporting" (Section 12, item D) candidate, not obviously a Step 3 defect.** A warning firing on essentially every generated node is either (a) correctly flagging that Kairos's own ID generation or the model's node-ID output isn't real UUID v4 — worth a quick, cheap check of whether that's true and whether n8n actually requires UUID-format IDs at all — or (b) a rule so noisy it has stopped being informative, which is exactly the "noisy warnings erode trust" failure mode both prior research rounds flagged. **Recommendation:** a five-minute check before Step 3 proper — read Rule 126's actual check and one real node ID it's flagging — to decide whether this is a real, fixable generation-quality issue (candidate for Step 4) or a miscalibrated/non-actionable rule (candidate for the confidence-filtered-reporting pass, possibly even a rule to soften or retire).

3. **Rules 78, 80, 59, 35, 75 are all node_generation/workflow_structure warnings firing in the hundreds — none of them are in Step 3's four target areas (Rule 58, node-syncer, registry static fields, typeVersion/rename).** They're real signal about generation quality generally, but out of scope for the audit as currently defined. Not a reason to expand Step 3 — noted here so a future pass (not this one) has a starting point if generation-quality tuning becomes its own initiative.

4. **Rule 17 warning on 86% of successful builds is worth a specific look during Step 3**, even though source-reading in the earlier cross-audit already confirmed Rule 17 itself is shape-only (checks that a present credential has `id`/`name` fields) and cannot produce the false-positive-on-requiredness risk originally hypothesized. An 86% fire rate on a shape check is either expected (most generated credentials are legitimately placeholder-shaped pre-handoff, which is by design) or worth understanding better. This doesn't change Step 3's actual target (Rule 58 + node-syncer + registry + typeVersion), but it's useful context to have in hand when doing that audit.

5. **Rules 90 and 66 are both labeled ERROR in source but show up heavily in `build_complete.warnedRules`** (199 and 157 times respectively, on builds that *succeeded*). This is either a real, common failure pattern the retry loop is successfully working around before final delivery, or a signal that `warnedRules`' semantics (does it track "ever fired during any attempt" vs. "present in the final delivered workflow") don't mean what the type's name implies. **Flagged for Step 3/4 attention, not resolved here** — resolving it is a small, separate investigation (read `client.ts`'s `warnedRules` population logic) that's out of scope for a read-only telemetry classification pass.

6. **None of the four telemetry-gated hold-off triggers fired.** No evidence of: fenced/truncated JSON (item 26 in the master ranked list), >25% shape-error failures that would justify the DSL spike (item 30), or param-level `displayOptions` failures specifically (the `displayParameter()` import trigger) — though item 4 above means Step 3's own audit is still the right way to check that last one directly, since telemetry alone wouldn't necessarily surface a *systematic* displayOptions gap if Kairos's registry currently avoids generating into the affected configurations at all.

7. **Step 2's fixtures should specifically exercise:** a webhook-shaped workflow (132 occurrences, the most common type — matches the plan's existing "one webhook pack" fixture), an email-shaped workflow (97 occurrences, second most common — good candidate for the "one non-webhook pack" fixture instead of an arbitrary choice), and, given Rules 78/80/59/35/75/126 are the dominant real-world warning signals, at least one fixture that asserts a *known-acceptable* warning count rather than asserting zero warnings (since a real successful build routinely carries several warn-severity findings — asserting "zero errors, warnings within an expected/documented set" is more honest than "zero issues," which would fail immediately against normal, correct output).
