# @kairos-sdk/core

[![CI](https://github.com/Kruttz/Kairos/actions/workflows/ci.yml/badge.svg)](https://github.com/Kruttz/Kairos/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@kairos-sdk/core)](https://www.npmjs.com/package/@kairos-sdk/core)
[![npm downloads](https://img.shields.io/npm/dw/@kairos-sdk/core)](https://www.npmjs.com/package/@kairos-sdk/core)

**Kairos is an AI workflow delivery engine for n8n. Give it a business context and it generates, validates, deploys, and documents a complete workflow pack — then learns from real executions and repairs over time.**

![Kairos SDK Demo](demo.gif)

Describe your business and Kairos builds a full suite of n8n automations: it plans the workflows, generates each one via Claude, validates every node and connection against **129 structural rules**, deploys to your n8n instance, and hands back a structured document covering credentials needed, data sources, assumptions made, open questions, and a test checklist. Use it as an **MCP server** (connect to Claude Code, Claude Desktop, or any MCP host — no Anthropic API key needed), a **TypeScript SDK**, or a **CLI**. With a seeded template library, Kairos achieves **100% first-try structural validation pass rate** across 20 benchmark prompts.

```ts
import { Kairos, PackBuilder } from '@kairos-sdk/core'

const kairos = new Kairos({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  n8nBaseUrl: 'https://your-instance.app.n8n.cloud',
  n8nApiKey: process.env.N8N_API_KEY!,
})

// Build a single workflow
const result = await kairos.build(
  'Every morning at 9am, send a message to #daily-digest on Slack'
)
console.log(result.workflowId)       // deployed workflow ID
console.log(result.credentialsNeeded) // what still needs configuring

// Build a complete workflow pack from a business context
const builder = new PackBuilder({ anthropicApiKey: process.env.ANTHROPIC_API_KEY!, kairos })
const plan = await builder.plan('Homecare DME operations')
const pack = await builder.build(plan)
console.log(pack.workflows.map(w => w.name))  // all deployed workflow names
console.log(pack.openQuestions)               // questions to answer before activating
console.log(pack.testChecklist)               // how to verify each workflow
```

### What Kairos does and does not do

| Kairos does | Kairos does not guarantee (yet) |
|---|---|
| Generates valid n8n workflow JSON | Perfect business logic |
| Builds complete workflow packs from business context | Correct credentials or API configs |
| Validates structure before deploy (129 rules) | Runtime success for every API |
| Documents assumptions, open questions, and test steps | That every workflow matches intent perfectly |
| Syncs node types from your live instance | Full replacement for human review |
| Learns from prior builds and failures | Monitoring after deployment (coming soon) |
| Works through MCP, SDK, or CLI | — |

---

## Use as MCP Server (no code required)

Connect Kairos to any MCP-compatible host — Claude Code, Claude Desktop, Cursor, or any agent that supports the Model Context Protocol. Your host LLM generates the workflow using Kairos's specialized context, then Kairos validates and deploys it. No Anthropic API key needed — no double-LLM calls, no wasted tokens. Kairos auto-syncs your n8n instance's node types so the catalog always matches your exact setup.

### Setup

```bash
npm install -g @kairos-sdk/core
```

### Claude Code

Add to your Claude Code MCP config (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "kairos": {
      "command": "kairos-mcp",
      "env": {
        "N8N_BASE_URL": "https://your-instance.app.n8n.cloud",
        "N8N_API_KEY": "your-n8n-key"
      }
    }
  }
}
```

`N8N_BASE_URL` and `N8N_API_KEY` are required for all MCP operations. Kairos syncs your instance's node types to generate accurate workflows that match your exact n8n setup.

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "kairos": {
      "command": "kairos-mcp",
      "env": {
        "N8N_BASE_URL": "https://your-instance.app.n8n.cloud",
        "N8N_API_KEY": "your-n8n-key"
      }
    }
  }
}
```

Then just ask your agent: *"Build me a workflow that monitors a webhook and sends a Slack notification"* — it will call `kairos_prompt` for context, generate the workflow itself, validate it with `kairos_validate`, and deploy with `kairos_deploy`.

### How the MCP flow works

The MCP server does **not** call an LLM internally. Instead, it gives your host LLM the specialized knowledge and guardrails to generate n8n workflows itself:

1. **Host LLM calls `kairos_prompt`** — gets the n8n system prompt, node catalog, library matches, and failure patterns
2. **Host LLM generates the workflow JSON** using that context (no separate API call)
3. **Host LLM calls `kairos_validate`** — checks the JSON against 129 structural rules
4. If invalid, the host LLM fixes the issues and validates again
5. **Host LLM calls `kairos_deploy`** — sends the validated workflow to n8n

This means Kairos works with **any LLM** — Claude, GPT, Gemini, Llama, or anything else connected as an MCP host. Zero Anthropic API key needed.

### Available MCP Tools

#### Generation tools

| Tool | Description |
|------|-------------|
| `kairos_prompt` | Returns the specialized system prompt, node catalog, library matches, and failure patterns for a given description |
| `kairos_validate` | Validates workflow JSON against 129 structural rules — returns errors and warnings |
| `kairos_search` | Searches the local workflow library for similar past builds |
| `kairos_sync` | Manually refresh the node catalog from your n8n instance (auto-runs on first `kairos_prompt` call) |
| `kairos_patterns` | Returns pattern analysis — top failure rules, confidence scores, and improvement suggestions derived from build telemetry |

#### Deployment tools

| Tool | Description |
|------|-------------|
| `kairos_deploy` | Deploys validated workflow JSON to n8n (re-validates before deploying) |
| `kairos_replace` | Replaces an existing n8n workflow with a new version — validates before updating, preserves workflow ID |
| `kairos_list` | List all deployed workflows |
| `kairos_get` | Get full workflow JSON by ID |
| `kairos_activate` | Activate a workflow |
| `kairos_deactivate` | Deactivate a workflow |
| `kairos_delete` | Delete a workflow |
| `kairos_executions` | List recent executions with status |

#### Library tools

| Tool | Description |
|------|-------------|
| `kairos_library` | Browse or search the local Kairos workflow library — returns metadata, node counts, deploy history, and n8n workflow IDs |
| `kairos_outcome` | Record build outcome against a library entry — feeds the pattern learning system with attempt counts, failed rules, and generation mode |
| `kairos_record_trace` | Record the most recent n8n execution of a deployed workflow into the library — grounds retrieval in real runtime behavior (stores node names, error types, and item counts only — never data values) |

### MCP Permissions & Security

Kairos's MCP server blocks destructive operations by default — deploying, activating, and deleting workflows all require an explicit opt-in, independent of whether an n8n connection is configured. This is deliberate: an MCP host that can talk to your n8n instance shouldn't be able to touch production automation without you saying so.

**Role modes** — `KAIROS_MCP_MODE` (default: `deploy`):

| Mode | Behavior |
|---|---|
| `readonly` | Blocks `kairos_deploy`, `kairos_replace`, `kairos_activate`, `kairos_delete` unconditionally — overrides the `ALLOW_*` flags below entirely |
| `validate` | Same as `readonly` — read/validate/search tools work, all write operations are blocked |
| `deploy` (default) | Write operations are *possible*, but each one still needs its own explicit `ALLOW_*` flag below — `deploy` mode does not auto-enable anything by itself |

**Per-action opt-in flags** (only relevant in `deploy` mode — `readonly`/`validate` block these regardless):

| Variable | Enables |
|---|---|
| `KAIROS_MCP_ALLOW_DEPLOY` | `kairos_deploy`, `kairos_replace` — set to exactly `true` |
| `KAIROS_MCP_ALLOW_ACTIVATE` | `kairos_activate`, and the `activate: true` option on `kairos_deploy` |
| `KAIROS_MCP_ALLOW_DELETE` | `kairos_delete` |

**Optional shared-secret auth:** set `KAIROS_MCP_SECRET` and every write-capable tool call must include a matching `kairos_secret` argument, or it's rejected as unauthorized — useful if the server is reachable by more than just your own trusted agent.

**HTTP transport:** `kairos-mcp --http` (default port 3000, override with `KAIROS_MCP_PORT`) runs over `StreamableHTTPServerTransport` instead of stdio. The transport itself does not add authentication beyond `KAIROS_MCP_SECRET` above — if you expose it over a network rather than binding to localhost, put it behind your own auth/reverse proxy, the same way you would any other unauthenticated local service.

---

## Use as SDK

### Installation

```bash
npm install @kairos-sdk/core @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peer dependency — install it alongside Kairos.

---

## Requirements

- Node.js 18+
- **SDK:** An [Anthropic API key](https://console.anthropic.com) — the SDK calls Claude internally
- **MCP:** No Anthropic key needed — your host LLM does the generation
- An n8n instance with API access enabled (Cloud or self-hosted) — required for both SDK and MCP (Kairos syncs your instance's node types for accurate generation)

---

## Standalone Validator (`kairos-lint`)

Don't need the SDK, MCP, or generation at all? The 129-rule structural validator works standalone against **any** n8n workflow JSON — hand-written, exported from n8n, or from any other tool — not just Kairos-generated ones. Fully offline: no Anthropic key, no n8n instance, no credentials of any kind.

```bash
npx @kairos-sdk/core kairos-lint my-workflow.json
npx @kairos-sdk/core kairos-lint my-workflow.json --json   # machine-readable output
```

```
my-workflow.json — Validation
──────────────────────────────────────────────────
Issues: 1 error(s), 2 warning(s)

  ✗ [error] [Rule 66] Node "Fetch Data" HTTP Request URL "api.example.com/data" is missing a protocol prefix — n8n requires a full URL starting with https:// or http://.
  ⚠ [warn]  [Rule 78] Workflow has no errorWorkflow configured in settings...
  ⚠ [warn]  [Rule 126] Node "Fetch Data" has ID "node-1" which is not a valid UUID v4...
```

Exits `1` if any error-severity issue is found (usable directly in CI). See [Validator Rules](#validator-rules) for the full rule list this checks against.

---

## Environment Variables Reference

Every `KAIROS_*` variable Kairos reads, in one place (the CLI's own `--help` output has a shorter version of the same list; MCP-specific vars are covered in more depth under [MCP Permissions & Security](#mcp-permissions--security)):

| Variable | Applies to | Effect |
|---|---|---|
| `KAIROS_MODEL` | SDK, CLI | Claude model override (default: `claude-sonnet-4-6`) |
| `KAIROS_MAX_TOKENS` | SDK, CLI | Max output tokens for the generation call (default: `16000`) — raise this if you see "Claude response was truncated (max_tokens reached)" on large, many-integration workflows |
| `KAIROS_TIMEOUT_MS` | SDK, CLI | Generation call timeout in ms (default: `300000`) — raise this if you see "Request was aborted" on large workflows (a bigger `KAIROS_MAX_TOKENS` needs more time to stream) |
| `KAIROS_TELEMETRY` | SDK, CLI, MCP | `true` for the default directory, or a path — enables JSONL telemetry logging |
| `KAIROS_LIBRARY_DIR` | CLI | Override the workflow library directory (default: `~/.kairos/library`) |
| `KAIROS_LIBRARY_SIZE` | SDK, CLI, MCP | Max library entries before oldest/least-used are evicted (default: `1500`) |
| `KAIROS_PROMPT_PROFILE` | SDK, CLI, MCP | `minimal` \| `standard` \| `rich` (default: `standard`) — how much library context and pattern guidance gets injected into the generation prompt |
| `KAIROS_REGISTRY_STRICT` | SDK, CLI, MCP | Set to `true` to warn on any node `typeVersion` above the registry's known-safe range. Default (unset/`false`) is lenient — a version higher than the known max is treated as a newer n8n release, not an error |
| `KAIROS_WEIGHT_TFIDF` / `KAIROS_WEIGHT_JACCARD` / `KAIROS_WEIGHT_OUTCOME` / `KAIROS_WEIGHT_DEPLOY` / `KAIROS_WEIGHT_COSINE` | SDK, CLI, MCP | Retrieval scoring weights — see [How retrieval works](#workflow-library--feedback-loop) |
| `KAIROS_MCP_MODE` | MCP | `readonly` \| `validate` \| `deploy` (default) — see [MCP Permissions & Security](#mcp-permissions--security) |
| `KAIROS_MCP_ALLOW_DEPLOY` / `KAIROS_MCP_ALLOW_ACTIVATE` / `KAIROS_MCP_ALLOW_DELETE` | MCP | Per-action opt-in for write operations — see [MCP Permissions & Security](#mcp-permissions--security) |
| `KAIROS_MCP_SECRET` | MCP | Optional shared secret required on write-capable tool calls |
| `KAIROS_MCP_PORT` | MCP | HTTP transport port when running `kairos-mcp --http` (default: `3000`) |

---

## Quick Start

```ts
import { Kairos } from '@kairos-sdk/core'

const kairos = new Kairos({
  anthropicApiKey: 'sk-ant-...',
  n8nBaseUrl: 'https://your-instance.app.n8n.cloud',
  n8nApiKey: 'your-n8n-api-key',
})

// Dry run — generates and validates but does not deploy
const preview = await kairos.build(
  'Receive a webhook, call an external API, and store the result in Google Sheets',
  { dryRun: true }
)

console.log(preview.name)               // workflow name Claude chose
console.log(preview.generationAttempts) // 1–3 (correction loop)
console.log(preview.credentialsNeeded)  // services that need credentials configured

// Live deploy
const deployed = await kairos.build(
  'Receive a webhook, call an external API, and store the result in Google Sheets'
)

console.log(deployed.workflowId) // now live in n8n
```

---

## Benchmark Results

Tested against 20 workflow prompts of varying complexity (simple triggers, multi-step conditional logic, AI agents with memory). Results measure **structural validation pass rate** — whether the generated workflow passes all 129 validator rules, not end-to-end execution correctness.

### Current results (re-run 2026-07-02, 128-rule validator)

| Metric | Baseline (no library) | Current library (292 entries) | + 14 imported fixtures |
|---|---|---|---|
| **First-try pass rate** | 100% (20/20) | 100% (20/20) | 100% (20/20) |
| Avg attempts | 1.00 | 1.00 | 1.00 |
| Correction loop usage | 0% | 0% | 0% |
| Avg generation time | 21.0s | 20.7s | 20.6s |
| Failures | 0 | 0 | 0 |

**Honest read of this result:** the accumulated system-prompt improvements (node catalog, connection-rule documentation, sub-patterns, intent-to-component mapping) plus the growth from 34 to 129 validator rules have together closed the gap this benchmark used to measure — even the no-library baseline now passes first-try on all 20 prompts. That's a genuinely good outcome, but it also means **this 20-prompt suite has hit a ceiling and no longer discriminates library-seeding's contribution** the way the original 55%→100% result did. The "+ 14 imported fixtures" column confirms the new `sync-templates --from-dir` bulk-import feature (see [Workflow Library & Feedback Loop](#workflow-library--feedback-loop)) doesn't regress quality — it's a null result, not a negative one — but it isn't a real test of importing hundreds or thousands of community workflows; the fixtures were 14 small, hand-authored workflows used only to exercise the import pipeline end-to-end without vendoring any third-party dataset into this repo.

Full results: [`benchmark-results.json`](./benchmark-results.json) (baseline), [`benchmark-seeded-results.json`](./benchmark-seeded-results.json) (current library), [`benchmark-imported-results.json`](./benchmark-imported-results.json) (+ imported fixtures).

**See [BENCHMARKS.md](BENCHMARKS.md) for full methodology, the 282-run backend-viability follow-up, and the three real reliability bugs that investigation found and fixed** — including one case where a result that looked like a regression turned out to be sampling noise, and the actual measurement that told the difference.

**Recommendation for anyone extending this benchmark:** move to a harder prompt set (the full 94-prompt suite in `scripts/benchmark.ts`, or a curated hard subset) to get a signal that isn't already saturated at 100%.

> **Note:** These results confirm that generated workflows are structurally valid and deployable to n8n. They do not verify runtime execution correctness, credential configuration, or whether the workflow output matches user intent.

### Backend-API viability run (2026-07-04)

A 282-run pass (94 prompts × `--repeat 3`, including a new `backendApi` tier of 9 CRUD/API-contract-shaped prompts) tested a harder question: not just "does this pass once," but "does it pass *reliably*." The `backendApi` tier passed 27/27 with zero inconsistency, and the investigation found and fixed three real reliability gaps along the way. Full writeup: **[BENCHMARKS.md](BENCHMARKS.md)**.

### Historical result (34-rule validator, superseded)

The original benchmark — 55% (11/20) baseline vs. 100% (20/20) with a 105-workflow seeded library — was recorded against an earlier 34-rule version of the validator and is kept here for historical context only. It does not reflect current behavior; see the current results above.

---

## How It Works

### SDK flow (calls Claude internally)

1. **Search** — Kairos searches its local workflow library for similar past builds. Matching workflows and their failure patterns are pulled into context.
2. **Warn** — Known failure patterns (from library matches and global telemetry rates) are injected into the system prompt so Claude avoids repeating known mistakes.
3. **Generate** — Your description is sent to Claude with a detailed system prompt, forcing a `generate_workflow` tool call that produces structured n8n workflow JSON.
4. **Validate** — The workflow is checked against **129 structural rules** covering node IDs, types, versions, names, positions, connections, forbidden fields, trigger presence, AI connection direction, cycle detection, webhook pairing, required parameters, and content quality (placeholder URLs, empty code nodes, missing required fields for Slack/Gmail/IF/Set/Schedule/Webhook nodes).
5. **Correct** — If validation fails, the specific rule violations are sent back to Claude for correction (up to 3 attempts, with tighter temperature on the final try).
6. **Strip** — Forbidden server-assigned fields (`id`, `createdAt`, `updatedAt`, etc.) are stripped before deployment.
7. **Deploy** — The validated workflow is posted to your n8n instance via REST API.
8. **Record** — The workflow, its metadata (generation mode, attempt count, failure patterns, credentials needed), and telemetry events are saved locally. Future builds use this history to avoid past mistakes.

### MCP flow (your LLM generates)

1. **Prompt** — Your LLM calls `kairos_prompt`, which searches the library and returns the specialized system prompt, node catalog, library matches, and failure patterns.
2. **Generate** — Your LLM generates the workflow JSON itself using that context. No separate API call.
3. **Validate** — Your LLM calls `kairos_validate`, which checks the JSON against the same 129 structural rules.
4. **Correct** — If validation fails, your LLM fixes the issues and calls `kairos_validate` again.
5. **Deploy** — Your LLM calls `kairos_deploy`, which strips forbidden fields and posts the workflow to n8n.
6. **Record** — The deployed workflow is saved to the local library for future retrieval.

---

## Validator Rules

The 129-rule validator is the core of what makes Kairos reliable. In baseline testing (no library), Claude needed the correction loop 45% of the time. Each rule targets a specific class of error:

**Node catalog generation:** Rule 129 (invalid `resource`/`operation` value for a node type) is backed by `src/validation/node-catalog-generated.ts`, a generated file listing every `resource`/`operation` value that actually exists for ~300 node types — extracted directly from the real `n8n-nodes-base` and `@n8n/n8n-nodes-langchain` packages (installed as devDependencies, never shipped) rather than hand-maintained. Regenerate it with `npm run generate:node-catalog` after bumping either package. It's an *existence* catalog, not a resource-to-operation pairing — a value that's valid under one resource might be incorrectly accepted under a different resource on the same node, since resolving that precisely would require evaluating n8n's conditional `displayOptions` logic against a specific parameter state (deferred; tracked as a follow-on).

| Rule | Severity | What it checks |
|------|----------|----------------|
| 1 | error | Workflow has a non-empty name |
| 2 | error | At least one node exists |
| 3 | error | Every node has a non-empty ID |
| 4 | error | No duplicate node IDs |
| 5 | error | Every node has a type string |
| 6 | error | Every node has a valid typeVersion |
| 7 | error | Every node has a valid [x, y] position |
| 8 | error | Every node has a non-empty name |
| 9 | error | Connections is a plain object |
| 10 | error | Every connection target exists in nodes |
| 11 | warn | Non-trigger nodes have incoming connections |
| 12 | error | No forbidden server-assigned fields |
| 13 | error | Settings is a valid object |
| 14 | error | At least one trigger node present |
| 15 | error | Node type strings match expected format |
| 16 | error | No duplicate node names |
| 17 | error | Credentials have valid id/name shape |
| 18 | error | AI connections originate from sub-nodes, not agent roots |
| 19 | warn | typeVersion is within known safe range |
| 20 | warn | No connection cycles (exempts splitInBatches loops) |
| 21 | warn | Webhook with responseMode="responseNode" has respondToWebhook |
| 22 | warn | Required parameters present for known node types |
| 23 | warn | Node type is recognized in the registry (unknown types may not exist in n8n) |
| 24 | warn | No deprecated `$node["..."]` accessor syntax in expressions |
| 25 | warn | No `$json.items[n]` array access (n8n flattens items automatically) |
| 26 | warn | Node references use `.first()` or `.all()` (bare `$('Node').json` throws at runtime) |
| 27 | warn | HTTP Request URLs are real endpoints (not `example.com` or `YOUR_URL` placeholders) |
| 28 | warn | Code nodes contain actual executable logic (not empty or comment-only) |
| 29 | warn | Slack message operations specify a channel (`channelId` with `__rl` object, or `channel`) |
| 30 | warn | Gmail send operations specify at least one recipient (`to` field non-empty) |
| 31 | warn | IF nodes have at least one condition in `conditions.conditions` |
| 32 | warn | Set nodes have at least one field assignment in `assignments.assignments` (typeVersion 3.x) |
| 33 | warn | Schedule triggers have at least one rule in `rule.interval` |
| 34 | warn | Webhook paths are relative — no spaces, no leading slash, no protocol prefix |
| 35 | warn | Email-sending node with no duplicate-prevention signal |
| 36 | warn | Code node output field names don't match downstream $json references (camelCase vs snake_case) |
| 37 | warn | New Date() called on external data without a custom date parsing helper |
| 38 | warn | Multiple parallel AI HTTP calls merge into same downstream node |
| 39 | warn | Deprecated Claude model name in use |
| 40 | warn | __rl resource locator field has wrong shape (plain string instead of {__rl, mode, value}) |
| 41 | warn | HTTP Request has body content but sendBody is not true |
| 42 | warn | SplitInBatches output 0 ("done") loops back into the batch node — outputs likely reversed |
| 43 | warn | IF/Filter node condition uses string operator instead of {type, operation} object (typeVersion 2+) |
| 44 | warn | Google Sheets append/update with columnMappingMode "defineBelow" but empty fieldsUi |
| 45 | error | AI Agent / chain node has no ai_languageModel sub-node connected |
| 46 | warn | HTTP Request has hardcoded API key / token in header values |
| 47 | warn | Switch node has output route(s) with no downstream connections |
| 48 | warn | Deprecated OpenAI model name in use |
| 49 | warn | ExecuteWorkflow node has no workflowId set |
| 50 | warn | AI Agent promptType "auto" with no chatTrigger or formTrigger upstream |
| 51 | warn | Wait node in webhook-resume mode with no resumeUrl sent downstream |
| 52 | warn | SQL injection risk — SQL query built with template literal + $json field in Code node |
| 53 | warn | Merge node mode incompatible with its incoming connection count |
| 54 | warn | HTTP Request to known protected API domain without credentials or auth headers |
| 55 | warn | Google Sheets sheetName is a placeholder literal when documentId is a real ID |
| 56 | warn | Node has continueOnFail but no immediate downstream error check on $json.error |
| 57 | warn | HTTP Request binary upload with missing or empty binaryPropertyName |
| 58 | warn | Wrong credential type key for the node type |
| 59 | warn | Webhook node has no authentication configured |
| 60 | warn | ScheduleTrigger fires every minute (cron minute=* or minutesInterval=1) |
| 61 | warn | ToolWorkflow sub-node missing description |
| 62 | warn | MemoryBufferWindow without chatTrigger and no sessionKey (shared memory) |
| 63 | error | Duplicate webhook path+httpMethod in the same workflow |
| 65 | error | SplitInBatches batchSize <= 0 |
| 66 | error | HTTP Request URL missing protocol prefix (not http:// or https://) |
| 67 | warn | Code node $('NodeName') references a node not in the workflow |
| 68 | warn | Google Calendar create event missing timezone |
| 69 | warn | Gmail send node missing subject |
| 70 | warn | Set node v1 with keepOnlySet=true drops all upstream fields |
| 71 | warn | ToolWorkflow source=database missing workflowId |
| 72 | warn | Code node calls JSON.parse() without a try/catch |
| 73 | warn | AI tool sub-nodes (toolCode, toolHttpRequest, etc.) missing description |
| 74 | warn | Multiple memoryBufferWindow nodes share the same static sessionKey |
| 75 | warn | EmailSend node missing toAddresses, subject, or message |
| 76 | warn | Telegram sendMessage missing chatId |
| 77 | warn | Code node in runOnceForAllItems mode uses $json without $input.all() |
| 78 | warn | Workflow has no errorWorkflow configured in settings |
| 79 | warn | HTTP Request URL contains "webhook-test" (test URL that expires) |
| 80 | warn | Set node v3+ has assignments but includeOtherInputFields is not enabled |
| 81 | error | ExecuteWorkflow calls the current workflow (infinite loop) |
| 82 | warn | Workflow has multiple SplitInBatches nodes (nested loop risk) |
| 83 | error | ToolWorkflow source=parameter has no inline workflow nodes |
| 84 | error | ToolWorkflow source=parameter inline workflow missing executeWorkflowTrigger entry point |
| 85 | warn | HTTP Request has both a credential and a manual Authorization header |
| 86 | error | ScheduleTrigger cronExpression has wrong number of fields |
| 87 | warn | Merge combineByPosition with an upstream Filter node (item count mismatch) |
| 88 | warn | Telegram sendMessage missing text |
| 89 | error | ChainRetrievalQa missing ai_retriever sub-node |
| 90 | error | RespondToWebhook exists but no webhook has responseMode="responseNode" |
| 91 | warn | Filter node has empty conditions (Rule 31 handles IF node; this handles Filter) |
| 92 | warn | Expression calls .toISOString() on a Luxon DateTime ($now/$today) |
| 93 | warn | Expression calls .format() (Moment.js API) instead of .toFormat() (Luxon API) |
| 94 | warn | ToolCode AI tool node has no executable code |
| 95 | error | ToolHttpRequest AI tool has no URL defined |
| 96 | warn | AI Agent/chain has multiple ai_languageModel sub-nodes (n8n only uses index 0) |
| 97 | error | VectorStore node missing ai_embedding sub-node |
| 98 | error | OutputParserStructured has no JSON schema |
| 99 | warn | ChainLlm with output parser connected but {format_instructions} missing from prompt |
| 100 | error | Postgres / MySQL executeQuery node has empty SQL query |
| 101 | warn | FormTrigger has no form fields defined |
| 102 | error | SplitOut node missing fieldToSplitOut parameter |
| 103 | warn | Code node returns array items without the required json wrapper |
| 105 | error | LM model parameter set to a non-routable alias ("latest", "default", etc.) |
| 106 | warn | Switch fallbackOutput is enabled but the fallback output port has no downstream connection |
| 107 | warn | Trigger node expression references $json (no upstream data at trigger time) |
| 108 | warn | Aggregate node in field-specific mode with no fields to aggregate |
| 109 | warn | Airtable create/update/upsert node with no field mappings |
| 110 | warn | Agent with promptType="define" but text is empty |
| 111 | warn | Ai_languageModel connection targets a non-agent/chain node |
| 112 | error | Luxon .add() or .subtract() used in expressions (Moment.js methods) |
| 113 | warn | IF node with unconnected true or false output branch |
| 114 | warn | $('NodeName') in expressions references a node that does not exist |
| 115 | warn | SplitInBatches output 1 (loop body) has no path that loops back |
| 116 | error | LM sub-node using a model name from the wrong provider |
| 117 | warn | Google Calendar create event missing start or end time |
| 118 | warn | Redis node missing key (propertyName) for key-based operations |
| 119 | error | Supabase node missing tableId |
| 120 | warn | Gmail reply operation missing messageId |
| 121 | warn | SplitOut fieldToSplitOut contains a dot (dot-path navigation attempt) |
| 122 | warn | Luxon .plus() or .minus() called with positional (n, 'unit') arguments |
| 123 | warn | HTTP Request sendQuery=true but queryParameters is empty |
| 124 | warn | Code node in runOnceForAllItems mode has no return statement |
| 125 | warn | Luxon uppercase YYYY or DD tokens in .toFormat() calls |
| 126 | warn | Node ID does not match UUID v4 format |
| 127 | warn | Code node language/param mismatch — jsCode/pythonCode populated for the wrong language |
| 128 | warn | OnError "continueErrorOutput" set but the dedicated error output port (index 1) is unwired |
| 129 | warn | Node's resource/operation value doesn't exist in the real n8n schema for its type |
| 130 | warn | AWS S3 / Slack file upload missing binaryPropertyName |
| 131 | warn | Long unbranched node chain (15+ nodes, no If/Switch/Merge/Filter) — consolidation opportunity |

Errors block deployment. Warnings are recorded and fed back into the prompt for future builds.

*(All 129 rules — generated from `src/validation/validator.ts` via `npx tsx scripts/generate-rules-table.ts`; run it again and re-paste after adding or changing a rule. `tests/unit/docs-drift.test.ts` fails CI if this table's rule-ID set ever falls out of sync with the code.)*

---

## API Reference

### `new Kairos(options)`

| Option | Type | Required | Description |
|---|---|---|---|
| `anthropicApiKey` | `string` | ✓ | Anthropic API key |
| `n8nBaseUrl` | `string` | ✓ | Base URL of your n8n instance |
| `n8nApiKey` | `string` | ✓ | n8n API key |
| `model` | `string` | | Claude model to use (default: `claude-sonnet-4-6`) |
| `maxTokens` | `number` | | Max output tokens for the generation call (default: `16000`) |
| `timeoutMs` | `number` | | Timeout in ms for the generation call (default: `300000`) |
| `logger` | `ILogger` | | Custom logger (default: silent) |
| `telemetry` | `boolean \| string` | | Enable JSONL telemetry logging (`true` for default dir, or a path) |
| `library` | `IWorkflowLibrary` | | Workflow library for learning loop (default: `NullLibrary`, CLI uses `FileLibrary`) |
| `nodeRegistry` | `NodeRegistry` | | Override the node-type registry used during validation — e.g. one synced from a live n8n instance via `kairos sync-nodes`. Defaults to the built-in static registry |

---

### `kairos.build(description, options?)`

Generates and optionally deploys a workflow from a plain-English description.

```ts
const result = await kairos.build(description, {
  dryRun: false,   // set true to skip deployment
  name: 'My Workflow', // override the generated name
})
```

**Returns `BuildResult`:**

```ts
{
  workflowId: string | null  // null on dry run
  name: string
  workflow: N8nWorkflow       // the full generated workflow JSON — inspect before deploying
  generationAttempts: number  // 1–3
  activationRequired: boolean // true if workflow needs manual activation
  credentialsNeeded: Array<{
    service: string
    credentialType: string
    description: string
  }>
  dryRun: boolean
}
```

---

### `new PackBuilder(options)` + `builder.plan()` + `builder.build()`

Build a complete workflow pack from a plain-English business context.

```ts
import { Kairos, PackBuilder } from '@kairos-sdk/core'

const kairos = new Kairos({ anthropicApiKey, n8nBaseUrl, n8nApiKey })
const builder = new PackBuilder({ anthropicApiKey, kairos })

// Step 1 — plan (LLM generates workflow list, assumptions, open questions)
const plan = await builder.plan('Homecare DME business operations')
console.log(plan.workflows)      // array of { name, description, purpose }
console.log(plan.openQuestions)  // questions needing human answers before go-live

// Step 2 — build (deploys each workflow, aggregates credentials and test steps)
const pack = await builder.build(plan, {
  dryRun: false,
  activate: false,
  onProgress: (wf, i, total) => console.log(`[${i+1}/${total}] ${wf.name}`),
})

console.log(pack.workflows)       // deployed results with workflowId and credentialsNeeded
console.log(pack.allCredentials)  // deduped credential list across all workflows
console.log(pack.sheetsColumns)   // Google Sheets required per sheet
console.log(pack.testChecklist)   // per-workflow test steps
```

### `validatePack(pack)` + `generateHandoff(pack)`

Check a built pack for issues, and generate a client-ready handoff document:

```ts
import { validatePack, generateHandoff } from '@kairos-sdk/core'

const issues = validatePack(pack)
// [{ type: 'duplicate_name' | 'blocking_assumption' | 'unsafe_activation' | 'schedule_conflict',
//    severity: 'error' | 'warning', message: string, workflows?: string[] }, ...]
const errors = issues.filter(i => i.severity === 'error')
if (errors.length === 0) {
  const handoffMarkdown = generateHandoff(pack)
  // Status, blocking issues, workflows, credentials needed, Google Sheets, setup/testing/activation checklists
}
```

---

### Workflow management

```ts
// List all workflows
const workflows = await kairos.list()

// Get a specific workflow
const workflow = await kairos.get(workflowId)

// Replace a workflow with a fresh generation from a new description
const updated = await kairos.replace(workflowId, 'new description')

// Activate / deactivate
await kairos.activate(workflowId)
await kairos.deactivate(workflowId)

// Delete (requires explicit confirmation)
await kairos.delete(workflowId, { confirm: true })
```

---

### Executions

```ts
// List recent executions for a workflow
const executions = await kairos.executions(workflowId, { limit: 20 })

// Get a specific execution with full details
const detail = await kairos.execution(executionId)
```

---

### Tags

```ts
const tags = await kairos.listTags()
const newTag = await kairos.createTag('production')
await kairos.tag(workflowId, [newTag.id])
await kairos.untag(workflowId, [newTag.id])
```

---

## Error Handling

All errors extend `KairosError` so you can catch them at different levels of specificity:

```ts
import {
  KairosError,
  GenerationError,
  ValidationError,
  ApiError,
  GuardError,
  DeployActivationError,
} from '@kairos-sdk/core'

try {
  await kairos.build('...')
} catch (err) {
  if (err instanceof ValidationError) {
    // Claude failed to produce a valid workflow after 3 attempts
    for (const issue of err.issues) {
      console.error(`[Rule ${issue.rule}] ${issue.message}`)
    }
    // Attempt metadata and warned rules are also available
    console.log(err.attemptMetadata)  // per-attempt timing, tokens, issues
    console.log(err.warnedRules)      // which pattern rules were warned about
  } else if (err instanceof DeployActivationError) {
    // Workflow deployed successfully to n8n, but activation failed — the workflow
    // exists and is recoverable. Kairos never deletes it automatically; you decide
    // whether to activate it manually later or clean it up.
    console.error(`Workflow ${err.workflowId} deployed but didn't activate:`, err.message)
  } else if (err instanceof GenerationError) {
    // Anthropic API call failed (auth, quota, timeout)
    console.error(err.message, err.cause)
  } else if (err instanceof ApiError) {
    // n8n returned a 4xx/5xx
    console.error(`n8n error ${err.statusCode}:`, err.message)
  } else if (err instanceof KairosError) {
    // Any other SDK error
    console.error(err.message)
  }
}
```

| Error class | When it's thrown |
|---|---|
| `GenerationError` | Anthropic API call failed |
| `ResponseParseError` | Claude responded but produced no usable tool call |
| `ValidationError` | Workflow failed 129-rule validation after max retries (carries `.attemptMetadata` and `.warnedRules`) |
| `ProviderError` | Network/auth failure talking to n8n |
| `ApiError` | n8n returned a 4xx or 5xx (carries `.statusCode`) |
| `GuardError` | Input validation failed (empty description) or `delete()` called without `{ confirm: true }` |
| `DeployActivationError` | Workflow was deployed successfully but activation failed (carries `.workflowId` — recoverable, never auto-deleted) |

---

## CLI

Deploy workflows from the command line — no code required:

```bash
# First-time setup (prompts for credentials, seeds template library, prints Claude Desktop config)
kairos init

# Generate and deploy a single workflow
kairos build "Every morning at 9am, send a Slack digest to #daily-updates"

# Generate a complete workflow pack from a business context
kairos build-pack "Homecare DME business — patient onboarding, reorder reminders, social media"

# Dry run — plan and validate without deploying
kairos build-pack "E-commerce store operations" --dry-run

# Skip confirmation prompt and build immediately
kairos build-pack "Real estate agency operations" --yes

# Wire deployed pack workflows to real Google Sheet IDs (patches documentId ResourceLocators)
kairos pack wire my-pack --sheet-ids '{"Contacts": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"}'
kairos pack wire my-pack --sheet-ids ./sheet-ids.json --dry-run

# Check a pack for duplicate names, unresolved blocking assumptions, failed
# deploys, and schedule conflicts before activating it
kairos validate-pack my-pack

# Print the saved pack as JSON, or generate a client-ready Markdown handoff
# (status, blocking issues, credentials needed, setup/testing/activation checklists)
kairos pack export my-pack
kairos pack export my-pack --handoff

# Record a deployed workflow's latest n8n execution into the library (improves retrieval)
kairos trace record <n8n-workflow-id>

# Seed library with n8n community templates
kairos sync-templates --max 200

# Bulk-import workflows from a local directory of n8n workflow JSON files
kairos sync-templates --from-dir ./my-workflows --dry-run
kairos sync-templates --from-dir ./my-workflows --limit 1000

# Fetch live node types/typeVersions from your n8n instance so build/build-pack
# validate against what your instance actually supports, not just the built-in registry
kairos sync-nodes

# Remove library entries by source (e.g. undo a bulk import)
kairos library prune --source imported --dry-run
kairos library prune --source imported

# View pattern analysis
kairos patterns
kairos patterns --days 60 --json

# View recent build sessions (description, attempts, matched library entries)
kairos sessions
kairos sessions --limit 50 --json

# Regenerate an existing n8n workflow from a new description (re-validates, preserves workflow ID)
kairos replace <n8n-workflow-id> "updated description of what this workflow should do"

# Manage workflows
kairos list
kairos get <workflow-id>
kairos activate <workflow-id>
kairos deactivate <workflow-id>
kairos delete <workflow-id> --confirm
```

### What `build-pack` outputs

After building, Kairos prints a structured document and saves a JSON file to `~/.kairos/packs/<name>.json`:

```
Homecare DME business — Workflow Pack
══════════════════════════════════════

Workflows Built (6/6)
──────────────────────────────────────────────────
  ✓ Weekly Social Media Content  [360Xba7BEQFQUw3v]
    Generate and email 3 Facebook/Instagram posts for approval each Monday
  ✓ Group Home Reorder Reminders  [g1Dx5hjTpV4FrkwH]
    Email facility contacts when supplies are due for reorder
  ✓ Monthly Newsletter  [lO8YxkDiaGkZiq76]
    Send AI-generated newsletter to customer mailing list on the 1st
  ✓ New Customer Welcome Sequence  [PrMj2DwVGfAo6VXq]
    3-email onboarding sequence triggered by webhook on customer add
  ✓ Annual Equipment Check-ins  [LZCIedaEnGNsKNRp]
    Daily check for customers whose equipment delivery was ~1 year ago
  ✓ Weekly Google Business Post  [IfxKaA1MYZ4Xs3eI]
    Auto-post educational content to Google Business Profile each Monday

Credentials Needed (connect once in n8n)
──────────────────────────────────────────────────
  □ Gmail OAuth2
  □ Google Sheets OAuth2
  □ Anthropic Claude API (HTTP Header Auth)
  □ Google My Business OAuth2

Google Sheets Required
──────────────────────────────────────────────────
  □ Facility Contacts: facility_name, contact_name, contact_email, product, reorder_frequency_weeks, last_order_date
  □ Customer Mailing List: name, email

Assumptions Made
──────────────────────────────────────────────────
  - Customer data is maintained in Google Sheets
  - Gmail is the outbound email platform
  - Owner approves social posts before publishing

Open Questions (answer before activating)
──────────────────────────────────────────────────
  ? What email address should receive social media approval emails?
  ? What is the brand voice / tone for posts and newsletters?
  ? Should newsletters require approval before sending to the full list?

Test Checklist
──────────────────────────────────────────────────
  Weekly Social Media Content
    □ Trigger manually — verify approval email arrives with 3 posts
  Group Home Reorder Reminders
    □ Add a test row with last_order_date 30 days ago — verify reminder email
  New Customer Welcome Sequence
    □ POST {"customer_name":"Test","customer_email":"you@test.com","equipment_type":"wheelchair"} to webhook
```

Set your credentials as environment variables or run `kairos init`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export N8N_BASE_URL=https://your-instance.app.n8n.cloud
export N8N_API_KEY=your-n8n-key
```

For dry-run mode, only `ANTHROPIC_API_KEY` is required — no n8n setup needed.

---

## Telemetry

Enable telemetry to log every generation attempt, validation result, and token usage to JSONL:

```ts
const kairos = new Kairos({
  anthropicApiKey: '...',
  n8nBaseUrl: '...',
  n8nApiKey: '...',
  telemetry: true, // writes to ~/.kairos/telemetry/
})
```

Or specify a custom directory:

```ts
telemetry: '/path/to/telemetry/dir'
```

Each event includes timestamp, session ID, token counts, validation issues, and duration — useful for benchmarking and analyzing the correction loop.

### Pattern Learning

When telemetry is enabled, Kairos runs a **pattern analyzer** that learns from every build — successes and failures. The analyzer produces `patterns.json` which is fed back into future generations:

- **Composite scoring** — patterns are scored using `rawConfidence × impact × recency × (1 + stickinessBoost)`, so frequent, recent, sticky failures rank highest
- **Stickiness detection** — rules that persist across consecutive failed retry attempts (the LLM can't self-correct) get a scoring boost
- **State lifecycle** — patterns progress through `draft → confirmed → resolved`, with per-rule resolved thresholds (5 clean builds) and 90-day TTL on resolved patterns
- **Regression detection** — if a resolved rule starts failing again, it's flagged as regressed and prioritized in the prompt
- **Warning effectiveness** — tracks whether warning the LLM about a rule actually prevented the failure, with per-rule pass/fail rates
- **Schema migration** — pattern data auto-migrates across versions (currently v2) so no accumulated knowledge is lost on upgrades
- **Rule co-occurrence** — identifies pairs of rules that commonly fail together (e.g., rules 5+17 always break at the same time)
- **Session depth analysis** — tracks how many attempts each session needed (e.g., 80% are 1-attempt, 15% need 2, 5% need all 3)
- **Warning cap** — max 10 patterns in the LLM prompt, prioritized: regressed > confirmed > drafts
- **Analysis history** — each analysis run appends a summary to `pattern-history.jsonl` for trend tracking over time

Run `kairos patterns` to view the current analysis, or `kairos patterns --json` for raw output.

For CLI usage, set `KAIROS_TELEMETRY=true` in your environment.

---

## Workflow Library & Feedback Loop

Kairos includes a file-based workflow library that stores every generation and feeds failure patterns back into future builds:

```ts
import { Kairos, FileLibrary } from '@kairos-sdk/core'

const kairos = new Kairos({
  anthropicApiKey: '...',
  n8nBaseUrl: '...',
  n8nApiKey: '...',
  library: new FileLibrary(), // stores in ~/.kairos/library/
  telemetry: true,            // enables failure rate tracking
})
```

**What gets stored per workflow:**
- The full workflow JSON and description
- Generation mode (`direct`, `reference`, or `scratch` based on library match quality)
- Number of generation attempts needed
- Failure patterns — which validation rules failed and how many times
- Source workflow IDs (which library entries influenced this build)
- Top match score and credentials needed
- Outcome tracking: retrieval count, usage as direct/reference source, first-try pass rate, avg attempts, and failed rules when used as a source

**How retrieval works:**

Kairos uses a **hybrid retrieval** pipeline with four scoring signals, weighted and combined:

| Signal | Weight | What it captures |
|---|---|---|
| TF-IDF keywords | 0.35 | Text similarity between description and stored workflows |
| Node fingerprint | 0.30 | Jaccard similarity between expected node types (extracted from query) and actual nodes in stored workflows |
| Outcome history | 0.20 | First-try pass rate and avg attempts when this workflow was used as a source — proven templates rank higher |
| Deploy frequency | 0.15 | How often a workflow has been deployed — a proxy for usefulness |

These weights are overridable via `KAIROS_WEIGHT_TFIDF` / `KAIROS_WEIGHT_JACCARD` / `KAIROS_WEIGHT_OUTCOME` / `KAIROS_WEIGHT_DEPLOY` — set any subset, unset ones keep their default, and the full set is renormalized to sum to 1.

After hybrid scoring, results are **reranked by cluster**: workflows are grouped by node fingerprint pattern (e.g., webhook→slack, scheduleTrigger→httpRequest→gmail), and cluster-level success stats boost or penalize candidates. Clusters with high failure rates on specific rules surface those as warnings.

- High-scoring matches (>= 0.92) provide direct structural templates
- Medium matches (>= 0.72) provide reference examples
- Failure patterns from matched workflows and cluster-level warnings are injected into Claude's prompt

**Optional semantic retrieval (embeddings):** Pass an `embeddingFn` to `FileLibrary` to add cosine similarity as a fifth signal (weights shift to 0.30 TF-IDF / 0.20 fingerprint / 0.25 cosine / 0.15 outcome / 0.10 deploy for entries with cached vectors — entries not yet embedded keep the keyword-only weights). This set is separately overridable via the same `KAIROS_WEIGHT_*` vars plus `KAIROS_WEIGHT_COSINE` for the embedding-only term. Embeddings are computed lazily during search (a few per call, 2s timeout, silent BM25 fallback) and cached in `~/.kairos/library/embedding-cache.json`. Fully backward-compatible: omit `embeddingFn` and nothing changes.

```ts
const library = new FileLibrary(undefined, {
  embeddingFn: async (text) => {
    const resp = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
    return resp.data[0].embedding
  },
})
```

**Execution trace learning:** After a deployed workflow runs in n8n, record its latest execution with `kairos trace record <n8n-workflow-id>` (CLI) or `kairos_record_trace` (MCP). Kairos stores a privacy-safe trace (status, executed node names, error *types*, per-node execution time, item counts — never data values, up to 10 per workflow) and computes a `runtimeReliabilityScore` that blends into the outcome signal (70% generation outcome, 30% runtime reliability). Workflows that actually run reliably in production rank higher in future retrieval.

Each `trace record` call also compares the new run against that workflow's own trace history and reports: a node erroring that never errored before, a run more than 2x slower than the historical average, a node that always ran before but is now missing, any brand-new node in the executed path, and the single slowest node in the latest run. This is runtime *execution* drift — distinct from the validator-rule-coverage drift surfaced by `kairos patterns`.

**Template seeding:** Run `kairos sync-templates` to ingest validated workflows from the n8n community library. Templates are safety-filtered (blocks code/executeCommand/ssh nodes, hardcoded secrets) and tagged with `sourceKind: 'n8n-template'`. Under the 34-rule-era validator, seeding the library with 89 templates improved first-try pass rate from 55% to 100% — the current 129-rule validator plus a stronger system prompt now hits 100% even without a library (see [Benchmark Results](#benchmark-results) for the honest current picture and why the old comparison no longer discriminates).

**Bulk import from a local directory:** `kairos sync-templates --from-dir <path>` ingests any local directory of n8n workflow JSON files (recurses into subdirectories, accepts bare or n8n.io-style `{workflow: {...}}`-wrapped JSON). Each file goes through the same safety + validation gates as template seeding, deduplicates by a structural hash (so re-hosted copies of the same workflow don't pile up), synthesizes a description from any sticky notes on the canvas (falling back to a node-type summary), and selects up to `--limit` (default 1000) entries via diversity-aware sampling — every distinct structural pattern gets a slot before extra slots go to patterns matching your own build history. `code` nodes are demoted to `review` trust rather than blocked outright (pass `--strict-code-nodes` to keep the stricter behavior); imported `review`-trust entries are never injected as full JSON into the generation prompt, only as a reference node list, so an unvetted workflow's contents can't leak arbitrary instructions into a build. Never evicts existing library entries — if the library is already at capacity, the import reports zero capacity and stops rather than displacing what's there. Undo with `kairos library prune --source imported`.

The library holds up to `KAIROS_LIBRARY_SIZE` entries (default 1500 — chosen to comfortably fit a real organic library plus a full 1000-entry bulk import with headroom to spare; measured at ~683 KB of `index.json` and ~12ms warm search latency, both negligible next to the multi-second LLM call every build makes). Beyond that, the least-used entries by a composite of deploy count, retrieval count, and outcome usage are evicted to make room for new organic saves (bulk imports never trigger this — see above).

The CLI automatically enables the library — no configuration needed. It defaults to `~/.kairos/library`; override with `KAIROS_LIBRARY_DIR=<path>` (useful for pointing at an isolated directory in tests or scripts without touching your real library).

---

## Custom Logger

```ts
const kairos = new Kairos({
  anthropicApiKey: '...',
  n8nBaseUrl: '...',
  n8nApiKey: '...',
  logger: {
    debug: (msg, meta) => console.debug(msg, meta),
    info: (msg, meta) => console.info(msg, meta),
    warn: (msg, meta) => console.warn(msg, meta),
    error: (msg, meta) => console.error(msg, meta),
  },
})
```

---

## Supported n8n Node Types

Kairos's built-in static registry (`DEFAULT_REGISTRY`) knows about 67 n8n node types out of the box, including:

- **Triggers:** Webhook, Schedule, Chat, Manual, Email, GitHub, Telegram
- **Core:** HTTP Request, Set, If, Switch, Merge, Code, Wait
- **Apps:** Slack, Gmail, Google Sheets, Notion, Airtable, GitHub, Telegram
- **Data:** PostgreSQL, Redis, S3, Execute SQL
- **AI (LangChain):** Agent, OpenAI Chat Model, Anthropic Claude Model, Buffer Memory, Tool Workflow, Vector Store Retriever

Beyond the static registry, `src/validation/node-catalog-generated.ts` is a separately-generated *existence* catalog covering ~300 node types' valid `resource`/`operation` values (see the note under [Validator Rules](#validator-rules)), and `kairos sync-nodes` (or `kairos_sync` in MCP mode) pulls in the exact node types and typeVersions your live n8n instance actually has, beyond either built-in list.

---

## License

MIT — © 2026 Jordan Krutman
