# Step 3 — n8n Ground-Truth Audit Report (2026-07-08)

**Scope:** exactly as planned — Rule 58, node-syncer multi-credential capture, registry/displayOptions conditional gap, typeVersion/defaultVersion + parameter-rename sweep.
**Method:** every claim below checked against the real, pinned `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` devDependencies (not assumed, not re-read from prior research docs), same method that already produced Rules 56/57/128/130.
**Status:** diagnosis only. No validator/registry/node-syncer code has been changed. Two local repro test files exist on disk, **not committed** (per the plan's guardrail): `tests/unit/validation/rule-58-repro.test.ts` (12 cases, confirmed red) and `tests/unit/validation/node-syncer-multi-credential-repro.test.ts` (1 case, documents current behavior, passing as written).
**Stop-and-report threshold:** evaluated explicitly below (§5) — **not crossed.**

---

## 1. Rule 58 — confirmed real bug, larger scope than originally estimated

**Claim being tested:** Rule 58 (`src/validation/validator.ts`, `EXPECTED_CRED`) hardcodes exactly one expected credential type key per node type. If a node type genuinely supports multiple valid credential types (selected by an `authentication`-style parameter), Rule 58 will false-positive on any legitimate non-default choice.

**Method:** read the real `credentials: [...]` declaration (including `displayOptions`) for every one of the 25 node-type entries in Rule 58's `EXPECTED_CRED` map, directly from the pinned `n8n-nodes-base`/`@n8n/n8n-nodes-langchain` packages in `node_modules`.

**Result — 13 of 25 entries confirmed affected:**

| Node type | Rule 58 expects | Also valid (confirmed in real n8n source) |
|---|---|---|
| `gmail`, `gmailTrigger` | `gmailOAuth2` | `googleApi` (serviceAccount auth) |
| `googleSheets` | `googleSheetsOAuth2Api` | `googleApi` (serviceAccount auth) |
| `googleDrive` | `googleDriveOAuth2Api` | `googleApi` (serviceAccount auth) |
| `slack` | `slackOAuth2Api` | `slackApi` (accessToken auth) |
| `notion`, `notionTrigger` | `notionApi` | `notionOAuth2Api` (oAuth2 auth) |
| `airtable`, `airtableTrigger` | `airtableTokenApi` | `airtableOAuth2Api` (oAuth2); trigger also accepts legacy `airtableApi` |
| `github`, `githubTrigger` | `githubApi` | `githubOAuth2Api` (oAuth2), `githubAppApi` (GitHub App) |
| `hubspot` | `hubspotOAuth2Api` | `hubspotApi` (apiKey), `hubspotAppToken` (appToken) |
| `jira` | `jiraSoftwareCloudApi` | `jiraSoftwareServerApi`, `jiraSoftwareServerPatApi` (self-hosted Server) |

**Confirmed NOT affected (single credential, or Rule 58's expectation matches n8n's only/default option):** `googleCalendar`, `slackTrigger`, `postgres`, `mySql`, `telegram`, `telegramTrigger`, `emailSend`, `emailReadImap`, `lmChatAnthropic`, `lmChatOpenAi`, `@n8n/n8n-nodes-langchain.anthropic`, `@n8n/n8n-nodes-langchain.openAi` (12 entries, verified clean).

**Severity nuance:** for Notion (`default: 'apiKey'` matches Rule 58's expectation) and Airtable (`default: 'airtableTokenApi'` matches), the false positive only fires when a workflow deliberately uses the non-default auth mode — lower practical hit rate. For Jira, Hubspot, Gmail, GoogleSheets, GoogleDrive, Slack, and Github, there is no "safe default" bias in Rule 58's favor — any of the valid modes is equally likely to trigger the false positive.

**Repro:** `tests/unit/validation/rule-58-repro.test.ts` — 12 hand-built cases, one per confirmed-valid alternate credential, run and confirmed **all 12 fail** against current code (each produces exactly the false-positive Rule 58 warning predicted from source).

## 2. node-syncer — confirmed real bug, narrower practical exposure than assumed

**Claim being tested:** `src/validation/node-syncer.ts`'s `const credentialType = node.credentials?.[0]?.name` drops all but the first credential option when merging a live n8n instance's node-type info into the registry.

**Confirmed:** the capture is exactly `[0]`-only, as suspected.

**Important nuance found during this audit, narrowing the practical impact:** `sync()`'s merge logic only sets `credentialType` in the `else` branch — i.e., **only for node types not already present in `merged` (which starts as a copy of `DEFAULT_REGISTRY`).** For an existing entry, the merge only unions `safeTypeVersions`; `credentialType` is never touched. All 9 non-trigger node types found affected in §1 (gmail, googleSheets, googleDrive, slack, notion, airtable, github, hubspot, jira) **are already present in `DEFAULT_REGISTRY`** with their own static (also-incomplete) `credentialType` string. So this specific bug's real-world exposure is narrower than the Rule 58 finding: it only manifests when Kairos syncs a **genuinely new node type** (not yet in the static seed registry) from a live instance for the first time — a real gap, but a rarer one than Rule 58's, which fires on every generation of an already-common node type in a non-default auth mode.

**A deeper, related gap found:** `N8nNodeTypeInfo` (`src/providers/n8n/types.ts:55-62`) types a node's `credentials` as `Array<{ name: string; required?: boolean }>` — **no `displayOptions` field at all.** Even a fixed node-syncer that captured every credential name in the array would have no way to know *which* `authentication` parameter value selects which credential — it could only learn "this node type accepts any of these N credential type names," not "credential X applies when `authentication === 'oAuth2'`." Whether n8n's real live REST API (the actual endpoint Kairos's `N8nApiClient` calls to list installed node types) even returns `displayOptions` in its response is **not verified in this audit** — that would require inspecting a live n8n instance's actual API response shape, which is out of scope for a source-code-only audit. Flagged as an open question for whoever implements the Step 4 fix, not resolved here.

**Repro:** `tests/unit/validation/node-syncer-multi-credential-repro.test.ts` — documents the current (buggy) behavior as a passing characterization test (a genuinely new hypothetical node type with 2 credential options; only the first is captured). Written as passing-documents-current-behavior rather than red, since there's no existing "correct" behavior in the codebase yet to assert against — Step 4 needs to decide the target shape (array of valid credential names? richer per-credential display-condition metadata, if the live API supports it?) before this can be inverted into a real regression test.

## 3. registry/displayOptions conditional gap (`requiredParams` side) — clean, no live bug

**Claim being tested:** `registry.ts`'s static `requiredParams` field doesn't account for `displayOptions`-conditional visibility, so Rule 22 (which checks `requiredParams` unconditionally) could false-positive on a resource/operation-conditional required parameter.

**Result:** only 2 of 67 `DEFAULT_REGISTRY` entries have a non-empty `requiredParams`: `webhook` (`httpMethod`, `path`) and `httpRequest` (`url`). Verified against real n8n source: neither of these is resource/operation-conditional — both are genuinely, unconditionally required regardless of any other parameter on those node types. **No live false-positive exists today.** This is a latent risk pattern to watch (if a future registry entry adds `requiredParams` for a field that *is* resource/operation-conditional without gating it, the same class of bug as Rule 58 would appear here too), but it is not a current defect and needs no Step 4 fix.

## 4. typeVersion/defaultVersion + parameter-rename sweep

**typeVersion/defaultVersion — clean, no bug, and structurally can't drift.** `scripts/generate-node-catalog.ts` does not reimplement n8n's default-version-selection algorithm at all — it calls `instance.getNodeType()` (no version argument) directly on the real, `require()`'d n8n node class. Read n8n's real `VersionedNodeType` (`packages/workflow/src/versioned-node-type.ts`): the constructor sets `this.currentVersion = description.defaultVersion ?? this.getLatestVersion()`, and `getNodeType()` called with no argument returns `this.nodeVersions[this.currentVersion]`. Since Kairos calls the real n8n method rather than re-deriving the "which version is default" logic itself, **this is correct by construction and cannot silently drift out of sync with n8n's own behavior** — a stronger guarantee than a Kairos-side reimplementation would have given.

**A related, already-documented finding:** `generate-node-catalog.ts`'s own header comment explicitly states its scope is "existence-only catalog of resource/operation values, not a requiredParams/credentialType extractor," and explicitly cites the same displayOptions-conditional-requiredness problem this whole Step 3 audit investigated, already deferred with a pointer to "the Phase 5 judgment-call tracker." This audit's findings (§1-§3) are exactly the kind of evidence that earlier deferred judgment call anticipated collecting before deciding whether/how to act — this audit didn't uncover an unknown problem so much as gather the concrete evidence the team already knew would eventually be needed.

**Parameter-rename sweep — spot-checked, no new undiscovered instances found.** Searched `validator.ts` for every rule that branches on `node.typeVersion` (10 locations). Read each: Rule 6 (basic validity), Rule 23-area version-safety check (delegates to `registry.isVersionSafe`), the Slack resource-locator `channelId` check (typeVersion ≥ 2, matches real n8n's V2 resource-locator introduction), Rule 70 (Set node v1 `keepOnlySet`, matches real Set-node version history), Rule 80 (Set node v3+ `includeOtherInputFields`, matches), Rule 130 (Slack file-upload binary-toggle boundary at exactly typeVersion 2.2, with a precise inline comment distinguishing 2/2.1 from 2.2+ — matches real n8n behavior). **All ten are correctly gated against real n8n version boundaries; no new instance of the Rule 56/57/128/130 bug class found in this spot-check.** This was a manual read-through of existing rules, not an exhaustive automated diff (building `scripts/audit-node-catalog-parity.ts` as a permanent, re-runnable tool — per the plan's original Step 3 design — remains a Step 4 action item, not performed here since it's a build/tooling task rather than a diagnosis task).

## 5. Stop-and-report threshold — evaluated explicitly, NOT crossed

The plan's guardrail: stop before Step 4 if fixing confirmed defects "one narrow rule at a time would mean touching double-digit call sites." §1 confirms 13 affected node-type entries — double-digit in raw count. The judgment call is whether this means double-digit **call sites** (separate places in the code each needing an independent design decision) or one **structural fix** that happens to correct many entries at once.

**Assessment: one structural fix, not double-digit call sites.** All 13 Rule 58 findings share the exact same root cause (a `Record<string, string>` that should be a `Record<string, string[]>`, or better, an array of `{ credential: string; requiredWhen?: { param: string; value: string } }`) and the exact same fix shape (change `credKeys.includes(expected)` to check membership against a set, with the actual valid-credential-sets for the 13 affected types gathered directly from n8n source during this audit — already done, ready to hand to Step 4). This is materially different from needing 13 independently-designed narrow rules. **Recommendation: proceed to Step 4 with a single widening fix to Rule 58's data table, not a resolver import.** The node-syncer fix (§2) is a separate, smaller, structurally similar single fix (widen `credentialType: string` to capture multiple names) — also does not warrant the general resolver.

## 6. Summary for Step 4

| Area | Verdict | Action for Step 4 |
|---|---|---|
| Rule 58 | **Confirmed bug**, 13/25 node types | Widen `EXPECTED_CRED` to a valid-credential-set per node type (data already gathered in §1); change the check from single-key match to set membership |
| node-syncer `credentials[0]` | **Confirmed bug**, narrower exposure (new node types only) | Widen capture to all declared credential names; verify (against a live n8n instance, not source alone) whether the real API response includes `displayOptions` before deciding whether `N8nNodeTypeInfo` needs extending too |
| registry `requiredParams` | Clean, no bug | No action needed; note as a pattern to watch if new conditional required-params entries are added later |
| typeVersion/defaultVersion | Clean, no bug, structurally safe | No action needed |
| Parameter-rename sweep | Clean (spot-check), no new instances | Optional: build `scripts/audit-node-catalog-parity.ts` as a permanent re-runnable check (a Step 4 tooling item, not required by this audit's findings alone) |
| `displayParameter()` general resolver import | **Trigger not fired** — findings are structural Rule-58/node-syncer fixes, not evidence of needing the general mechanism | Remains gated on its existing trigger (see plan §13) |

**No fixes have been applied.** This report is the complete input to Step 4.
