#!/usr/bin/env node

// Kairos is imported as a type only here -- @anthropic-ai/sdk (an optional peer dependency,
// deliberately, so `kairos-mcp` never needs an Anthropic API key) is pulled in transitively by
// client.ts's own top-level import. A real npm-pack + fresh-install smoke test (2026-07-19
// closeout) found that a *static* top-level `import { Kairos }` here made the entire CLI --
// including --help and every command that never touches generation (drift/chaos/watch/repair/
// patterns/etc.) -- crash immediately with ERR_MODULE_NOT_FOUND on any install that skipped the
// optional peer dependency, since ES module static imports resolve before any code (including
// argument parsing) runs. createClient()/createDryRunClient() below import the real value
// dynamically, deferring the @anthropic-ai/sdk resolution until a command that actually
// generates something is invoked.
import type { Kairos } from './client.js'
import { FileLibrary } from './library/file-library.js'
import { TemplateSyncer } from './templates/syncer.js'
import { PatternAnalyzer } from './telemetry/pattern-analyzer.js'
import type { TelemetryCollector } from './telemetry/collector.js'
import { N8nApiClient } from './providers/n8n/api-client.js'
import { NodeSyncer } from './validation/node-syncer.js'
import type { NodeRegistry } from './validation/registry.js'
import { getCatalogCachePath, readCatalogCache, writeCatalogCache } from './utils/node-catalog-cache.js'

const HELP = `
Kairos SDK — n8n workflow generation, a post-deploy reliability suite (drift
detection, chaos testing, self-healing, replay), and a Promise Engine that
compiles business commitments (ProcessContract) into workflows and checks
from real execution evidence whether they were actually kept. Promise
Reports are evidence-graded evaluations (kept/missed/unverifiable/in_progress),
never a guarantee. n8n is the current execution substrate throughout.

Usage:
  kairos init                         First-time setup wizard
  kairos build <description> [options]
  kairos build-pack <business context> [options]
  kairos pack export <name> [--handoff]
  kairos pack wire <name> [--sheet-ids <json-or-path>] [--dry-run]
  kairos validate-pack <name>
  kairos preflight <name> [--live] [--bundle-dir <dir>] [--client-id <slug>] [--json]
  kairos trace record <n8n-workflow-id>
  kairos contract plan "<business description>" --client-id <slug> [--json]
  kairos contract intake start --client-id <slug> [--context <file>] [--resume <session-id>] [--json]
  kairos contract intake status <session-id> --client-id <slug> [--json]
  kairos contract scenarios generate <file.json> [--categories <list>] [--out <dir>] [--json]
  kairos contract harness run <file.json> [--scenarios <dir-or-file>] [--json]
  kairos contract compile <file.json> [--build] [--dry-run] [--json]
  kairos contract validate <file.json> [--json]
  kairos contract import <file.json> --client-id <slug> [--confirm-version-change] [--json]
  kairos contract versions <contract-id> --client-id <slug> [--json]
  kairos contract diff <contract-id> --client-id <slug> --from <v> --to <v> [--json]
  kairos contract amend <contract-id> --client-id <slug> --new <file.json> [--confirm] [--confirm-breaking-with-active-instances] [--from-proposal <id>] [--json]
  kairos contract evolve run|list|show|accept|reject <contract-id> [<proposal-id>] --client-id <slug> [--json]
  kairos contract report <contract-id> --client-id <slug> [--from <date>] [--to <date>] [--bundle <dir>] [--json]
  kairos contract value <contract-id> --client-id <slug> [--assumptions <file.json>] [--from <date>] [--to <date>] [--bundle <dir>] [--json]
  kairos ledger poll <contract-id> --client-id <slug> [--limit <n>] [--json]
  kairos ledger show <contract-id> --client-id <slug> [--instance <promise-instance-id>] [--json]
  kairos exceptions list <contract-id> --client-id <slug> [--status <status>] [--json]
  kairos exceptions show <contract-id> <item-id> --client-id <slug> [--json]
  kairos exceptions ack <contract-id> <item-id> --client-id <slug> [--reason <text>] [--json]
  kairos exceptions resolve <contract-id> <item-id> --client-id <slug> [--reason <text>] [--json]
  kairos drift baseline <n8n-workflow-id> [--json]
  kairos drift check <n8n-workflow-id> [--live] [--original-build-hash <hash>] [--json]
  kairos sandbox up [--port <n>]
  kairos sandbox status [--json]
  kairos sandbox down
  kairos replay capture <n8n-workflow-id> --client-id <slug> [--limit <n>] [--scrub] [--json]
  kairos replay run <n8n-workflow-id> --candidate <file> --client-id <slug> [--live] [--verbose] [--json]
  kairos replay run <n8n-workflow-id> --candidate <file> --client-id <slug> --contract <file.json> [--scenario <id>] [--verbose] [--json]
  kairos replay purge <n8n-workflow-id> --client-id <slug> [--json]
  kairos chaos audit <n8n-workflow-id> [--json]
  kairos chaos run <n8n-workflow-id> [--contract <file>] [--json]
  kairos watch --workflows <ids|all> [--interval <s>] [--on-drift <cmd>] [--once] [--json]
  kairos watch --contracts <contract-id>[,...] --client-id <slug> [--on-exception <cmd>] [--once] [--json]
  kairos repair propose <n8n-workflow-id> --client-id <slug> [--json]
  kairos repair apply <n8n-workflow-id> --client-id <slug> [--yes] [--auto] [--json]
  kairos rollback <n8n-workflow-id> [--to <iso-timestamp>] [--yes] [--json]
  kairos replace <n8n-id> <description>
  kairos memory add|list|search|forget|rebuild-index <client-id> [...]
  kairos patterns [options]
  kairos patterns approve <rule-number>
  kairos patterns reject <rule-number> [reason]
  kairos patterns share
  kairos patterns ingest <path>
  kairos patterns sync --url <url>
  kairos sessions [options]
  kairos list
  kairos get <id>
  kairos activate <id>
  kairos deactivate <id>
  kairos delete <id> --confirm
  kairos sync-templates [options]
  kairos sync-templates --from-dir <path> [options]
  kairos sync-nodes
  kairos library prune --source <organic|n8n-template|imported> [--dry-run]

Build options:
  --dry-run       Generate and validate without deploying
  --name <name>   Override the generated workflow name
  --activate      Activate the workflow after deployment
  --smoke-test    After deploy, trigger the workflow and verify it runs without error

Build-pack options:
  --dry-run       Plan and validate without deploying
  --activate      Activate each workflow after deployment (blocked if blocking assumptions exist)
  --yes           Skip confirmation prompt and build immediately

Pack options:
  pack export <name>          Print the saved pack as JSON
  pack export <name> --handoff  Generate a client-ready Markdown handoff document
  pack export <name> --impact-notes  Print a blank worksheet to fill in during a client call
  pack wire <name>            Patch deployed workflows with real Google Sheet IDs
  validate-pack <name>        Cross-workflow safety check before activation
  preflight <name>            Go/no-go launch checklist -- offline by default (saved pack only)
  preflight <name> --live     Also checks live n8n state: placeholder credentials, Sheet IDs, webhook artifacts
  preflight <name> --bundle-dir <dir>  Cross-check against a previously generated --bundle output
  preflight <name> --live --client-id <slug>  Also verifies every real credential is named client:<slug>:... in n8n (naming-convention check, not access control -- see docs/plans/credential-client-binding-plan-2026-07-09.md)

Patterns options:
  --days <days>   Analysis window (default: 30)
  --json          Output raw JSON instead of summary
  --pending       Show only patterns awaiting human review (KAIROS_PATTERN_REVIEW=true)

Patterns review-gate (opt-in via KAIROS_PATTERN_REVIEW=true):
  patterns approve <rule>          Confirm a pending_review pattern -- it starts influencing generation
  patterns reject <rule> [reason]  Mark a pending_review pattern resolved -- it's excluded, same as any resolved pattern

Patterns share (community pattern library, export-only -- see docs/plans/reliability-suite-plan.md §10):
  patterns share   Build a report of your CONFIRMED local patterns (rule number, pipeline stage,
                   failure count, confidence only -- no free text, node names, workflow names,
                   URLs, parameter values, or expressions are ever representable in the report).
                   Prints the exact bytes that would leave this machine, then requires an
                   explicit y/N confirmation naming the real consequence (a public GitHub issue)
                   before anything is written or transmitted. Uses the gh CLI if present, else
                   prints the issue URL to open manually. No background transmission path exists.

Patterns ingest/sync (community pattern library, EXPERIMENTAL -- see docs/plans/reliability-suite-plan.md §10.4/10.4a):
  patterns ingest <path>    Read a local kairos-patterns-share-shaped JSON file (no network) and
                             overwrite ~/.kairos/community-patterns.json with its aggregate.
  patterns sync --url <url> Fetch one JSON file (same shape) and ingest it the same way. A single
                             explicit request, no retries, no polling, no default URL.
                             Community data is always a fully separate store -- it never enters
                             local pattern scoring, never changes a local pattern's state, and
                             never influences generation. Set KAIROS_COMMUNITY_PATTERNS=true to
                             see it (clearly marked [EXPERIMENTAL COMMUNITY]) in 'kairos patterns'
                             output; unset it (the default) to fully disable the display.

Contract options (ProcessContract v0, Phase 0+1+2+5 -- see docs/plans/process-contract-promise-engine-plan.md):
  contract plan "<description>"  Draft a ProcessContract from a plain-language business
    --client-id <slug>           description via an LLM (requires ANTHROPIC_API_KEY). Always run
                                  through the deterministic validator before being returned;
                                  always saved to ~/.kairos/contracts/<client-id>/<id>.json for
                                  human review, even when it needs review -- never withheld. Exits
                                  2 (not 1) when the draft has a validation error or a blocking
                                  assumption, distinguishing "needs a human" from a hard failure.
  contract intake start          Guided alternative to plan (roadmap item 4, see
    --client-id <slug>           docs/plans/intake-scenario-harness-plan.md §4): 11 focused,
    [--context <file>]           fixed-order questions (trigger, done states, branches,
    [--resume <session-id>]      exceptions, owners, SLAs, evidence, handoffs, missing data,
                                  duplicates, what to never automate), answered interactively --
                                  no LLM call per question. Once answered, a single synthesis call
                                  reuses contract plan's own prompt and validator/review gate
                                  unchanged (the transcript IS the description). Up to 2 further
                                  bounded rounds of targeted follow-up questions run automatically
                                  if the draft still has blocking assumptions or validation
                                  errors; never more than that -- the draft is always saved and
                                  shown in full even if issues remain, exactly like plan's own
                                  "never withheld" rule. Saves progress after every single answer,
                                  so Ctrl-C is always safe -- resume with --resume <session-id>.
                                  --context <file> includes a plain-text file verbatim as extra
                                  synthesis context (capped ~8000 chars) -- no chunking, no
                                  embeddings, no document-ingestion/RAG system, just literal
                                  inclusion. Saved to the same
                                  ~/.kairos/contracts/<client-id>/<id>.json path plan uses.
  contract intake status <id>    Reports a session's progress (questions answered, pending
    --client-id <slug>           follow-ups, synthesis rounds so far, current draft name/version)
                                  without asking anything or calling the LLM -- purely local.
  contract scenarios generate    Deterministically derives synthetic ContractScenarios from a
    <file.json>                  valid ProcessContract (roadmap item 5, see docs/plans/
    [--categories <list>]        intake-scenario-harness-plan.md §5) -- no LLM call. Categories:
    [--out <dir>]                happy_path, missing_data, failure_terminal, no_response,
                                  duplicate_correlation, after_hours, in_progress (default: all,
                                  or a comma-separated subset via --categories). NEVER fabricates
                                  an evidence timeline event for a transition the contract has no
                                  EvidenceRequirement for -- real ledger.ts extraction could never
                                  produce such an entry either. A category is skipped, with a
                                  stated reason, rather than faked when the contract genuinely
                                  cannot support it (e.g. no EvidenceRequirement covers any
                                  transition into a success/acceptable terminal outcome -- a real,
                                  confirmed gap in both checked-in Empire Homecare and SaaS
                                  incident-response fixtures as currently authored, not a
                                  limitation of this generator). With --out <dir>, also writes one
                                  JSON file per generated scenario there.
  contract harness run           Kairos Contract Harness / Node Harness v0 (roadmap item 6, see
    <file.json>                  docs/plans/intake-scenario-harness-plan.md §6): runs
    [--scenarios <dir-or-file>]  ContractScenarios through the REAL checkSlaCompliance()/
                                  updateExceptionDesk()/classifyPromiseInstance() functions --
                                  the exact same functions "kairos watch --contracts"/"kairos
                                  contract report" call in production, never a parallel
                                  evaluator. Purely in-memory: no n8n, no network, no LLM call,
                                  no file writes to ~/.kairos/. Without --scenarios, generates
                                  scenarios for every category first (equivalent to running
                                  "contract scenarios generate" and piping its output in).
                                  Compares each scenario's actual classification/exception
                                  result against its own recorded expected outcome and reports
                                  every mismatch. Exits 1 if any scenario fails to match.
  contract compile <file.json>   Deterministically compile a valid ProcessContract into a
    [--build] [--dry-run]        PackPlan -- no LLM call in this step; traceability from each
                                  compiled workflow back to the exact contract element ids it came
                                  from. Without --build, only prints the plan. With --build, feeds
                                  it into the same PackBuilder/Kairos.build() machinery
                                  build-pack uses -- full generation, validation, and (unless --dry-run)
                                  deployment, and (unless --dry-run) registers the real deployed
                                  workflow ids against this contract. --dry-run deliberately never
                                  registers fake/placeholder workflow ids -- there are no real ones
                                  yet. compile itself never saves the CONTRACT anywhere (see import
                                  below) -- kairos ledger poll/watch --contracts/contract report all
                                  need BOTH a saved contract AND a real (non-dry-run) build's
                                  workflow registration before they have anything to find. Refuses
                                  to compile at all (exit 2, no plan) if the contract fails
                                  validation or still has a blocking assumption. Does not attempt to
                                  prove the built workflows fulfill the contract AT RUNTIME -- that
                                  is ProofLedger's job (see Ledger options below) and, later, the
                                  Replay Upgrade. A real (non-dry-run) build with at least one
                                  deployed workflow also runs Contract Compiler Verification
                                  (roadmap item 10, see docs/plans/intake-scenario-harness-plan.md
                                  §10): fetches each deployed workflow back from n8n (read-only) and
                                  statically checks it contains an evidence node ("Kairos Evidence:
                                  <transitionId>") for every EvidenceRequirement, the correlation
                                  key referenced somewhere, and every start condition covered by a
                                  compiled workflow. This is structural presence only, never a claim
                                  the wiring is correct at runtime -- but a missing evidence node
                                  means ProofLedger will silently never see that transition's
                                  evidence at all, so a gap here is surfaced loudly (exit 2) even
                                  though it never blocks the registration write itself (the deployed
                                  workflows and registration are both still real and correct; only
                                  the affected transition's evidence tracking is broken).
  contract validate <file.json>  Validate a ProcessContract JSON file against the deterministic
                                  contract validator (reachability, terminal-state consistency,
                                  dangling references, business-calendar consistency). Fully
                                  offline. ProcessContract is deliberately separate from PackPlan
                                  (a contract describes a business promise; a pack describes
                                  workflows to build) -- a contract compiles into a PackPlan, it
                                  does not extend one.
  contract import <file.json>    Validates a contract file (same gate as compile: exit 2, nothing
    --client-id <slug>           written, on a validation error or a blocking assumption) and
                                  saves it to ~/.kairos/contracts/<client-id>/<id>.json --
                                  REQUIRED, alongside a real (non-dry-run) "contract compile
                                  --build", before ledger poll/watch --contracts/contract report can
                                  find this contract. --client-id must exactly match the contract's
                                  own clientId field, so a contract can never be silently imported
                                  into the wrong client's namespace. Provenance/version/status are
                                  preserved exactly as given, never rewritten -- importing is not
                                  authoring. Refuses (exit 2, nothing written) to overwrite an
                                  already-saved contract at a DIFFERENT version unless
                                  --confirm-version-change is passed; even then the prior version
                                  is archived first, never destroyed (roadmap item 12 -- see
                                  contract versions/diff/amend below).
  contract versions <id>         Contract Amendment/Diff (roadmap item 12, see docs/plans/
    --client-id <slug>           contract-evolution-ops-roadmap-plan.md §12): lists every archived
                                  (superseded) version of a saved contract, newest first, plus the
                                  current live version -- empty until amended/re-imported at least
                                  once.
  contract diff <id>             Pure, offline, field-by-field structural diff between two
    --client-id <slug>           versions of a saved contract (the live one or any archived one).
    --from <v> --to <v>          Classifies each change breaking (could cause existing
                                  ProofLedger/ExceptionDesk evidence to be misinterpreted against
                                  the new shape -- e.g. a transition's fromState/toState changing,
                                  an SLA's measuredFrom/expectedBy changing) or compatible (e.g. an
                                  SLA duration number changing, a description edit). Never writes
                                  anything.
  contract amend <id>            Previews (default, nothing written) or applies (--confirm)
    --client-id <slug>           replacing a saved contract with a new version from a file --
    --new <file.json>            always shows the diff and its breaking/compatible classification
    [--confirm]                  first. --confirm validates (same gate as import), archives the
    [--confirm-breaking-with-    current version, then saves the new one as live. Refuses (exit 2)
     active-instances]           a breaking amendment while any promise instance is still
    [--from-proposal <id>]       in_progress unless --confirm-breaking-with-active-instances is
                                  also passed -- an in-flight instance's already-recorded evidence
                                  could be misinterpreted against the new shape. --from-proposal
                                  <id> links this amendment back to a "contract evolve" proposal
                                  once it succeeds, marking it applied with the resulting version
                                  -- the proposal never causes the amendment, only records that one
                                  already happened. Never recompiles or redeploys anything -- run
                                  "contract compile <file.json> --build" yourself afterward.
  contract evolve run <id>       Contract Evolution v0 (roadmap item 11, see docs/plans/contract-
    --client-id <slug>           evolution-ops-roadmap-plan.md §11): treats ProcessContract as a
    [--from/--to <date>]         hypothesis, not permanent truth. run reads this contract's own
    [--with-harness]             real ProofLedger + ExceptionDesk evidence (plus, with
                                  --with-harness, generated-scenario mismatches -- always
                                  confidence 'low', never blended with real-evidence confidence,
                                  since a harness failure is about internal consistency, not real
                                  business behavior) and produces evidence-linked amendment
                                  proposals: SLA/expiration-rule hotspots, never-reached states,
                                  unused evidence-backed transitions, and a whole-contract
                                  high-miss-rate signal -- frequency/existence findings only, never
                                  a specific replacement value. Read-only against the contract;
                                  writes only to this contract's own stored proposal list.
                                  Re-running against unchanged evidence refreshes existing
                                  proposals rather than duplicating them, and never resets a
                                  human's prior review decision.
  contract evolve list <id>      Lists (list, optionally --status-filtered) or shows one proposal
    --client-id <slug>           (show <proposal-id>) in detail, including its evidence and full
  contract evolve show <id>      status-change history.
    <proposal-id> --client-id
  contract evolve accept <id>    Records a human decision (audited, never automatic) -- does NOT
    <proposal-id>                change the contract either way. To act on an accepted proposal,
    --client-id <slug>           hand-author a new contract version yourself, then run "contract
    [--reason <text>]            amend ... --confirm --from-proposal <proposal-id>" (item 12's own
  contract evolve reject <id>    diff/amend/version gate is the only thing allowed to write a new
    <proposal-id>                contract version).
    --client-id <slug>
    [--reason <text>]
  contract report <contract-id>  Client-facing promise report (Phase 5) from this contract's own
    --client-id <slug>           ProofLedger + ExceptionDesk data -- purely local, no network
    [--from/--to <iso-date>]     calls. --from/--to are plain ISO 8601 strings, compared
    [--bundle <dir>]             lexicographically against event timestamps -- a bare date
                                  ("2026-07-20") is an EXCLUSIVE boundary against full timestamps
                                  ("2026-07-20T09:00:00Z" > "2026-07-20" as a string), so it does
                                  NOT include events later that same day. Pass the following day
                                  (--to 2026-07-21) for an inclusive "through end of July 20", or a
                                  full timestamp (--to 2026-07-20T23:59:59.999Z) directly. Counts
                                  kept/at-risk/missed/unverifiable/in-progress instances (never
                                  counts unverifiable as kept), open/acknowledged/resolved
                                  exceptions, an evidence-quality breakdown, and an owner/action
                                  summary for open exceptions. Always states plainly when evidence
                                  is incomplete -- no fake ROI math, no raw PII beyond the hashed
                                  correlation key, no dashboard, no autonomous decisions. Without
                                  --bundle, prints only; with --bundle <dir>, also writes
                                  promise-report.md + a manifest there, reusing the same Delivery
                                  Bundle artifact/manifest pattern pack export --bundle already uses.
  contract value <contract-id>   Automation P&L / Value Report (roadmap item 13, see docs/plans/
    --client-id <slug>           contract-evolution-ops-roadmap-plan.md §13): report's own
    [--assumptions <file.json>]  Observed section (identical, zero assumptions needed) plus an
    [--from/--to <iso-date>]     optional Estimated Value section -- present only when
    [--bundle <dir>]             --assumptions <file.json> supplies at least one human-entered
                                  per-unit multiplier (minutesSavedPerKeptInstance,
                                  minutesSavedPerResolvedException, dollarValuePerResolvedException,
                                  dollarValuePerAvoidedMiss, currency, enteredBy, enteredAt -- all
                                  optional, never defaulted/inferred by Kairos). No dollar or time
                                  figure is ever computed without an explicit assumption for that
                                  specific multiplier; refuses (exit 1, nothing printed) if a
                                  dollar-denominated assumption is present with no currency. Every
                                  value line shows its own formula inline (e.g. "42 resolved
                                  exception(s) x 15 min = 630 min"), never a bare final number --
                                  the same "human supplies the real number, Kairos never guesses
                                  it" discipline pack export --impact-notes already established;
                                  a prior automatic-ROI-math concept was proposed and explicitly
                                  rejected in this codebase's own history for exactly this risk.
                                  Without --bundle, prints only; with --bundle <dir>, also writes
                                  automation-value-report.md + a manifest there.

Ledger options (ProofLedger v0, Phase 3 -- see docs/plans/process-contract-promise-engine-plan.md §6):
  ledger poll <contract-id>      Polls n8n execution data (read-only -- GET only, never a write)
    --client-id <slug>           for every workflow registered against this contract, extracts
    [--limit <n>]                evidence ONLY from the exact fields each EvidenceRequirement
                                  whitelists, from the exact node compile.ts's evidence-marker
                                  convention names, and appends observed/unverifiable entries to
                                  the local ProofLedger. Never re-reads an execution already
                                  covered by the stored per-workflow watermark, and never claims
                                  more than the evidence in n8n's own execution data supports --
                                  a marker node with fields missing is "unverifiable", not
                                  silently rounded up to "observed". No new hosted service, no
                                  listener -- decided by a real design-verification spike against
                                  live production execution data, not assumed (§6.0).
  ledger show <contract-id>      Reads back stored ProofLedger entries for a contract -- purely
    --client-id <slug>           local, no network calls. Optionally filtered to one promise
    [--instance <id>]            instance (the hashed correlation key value). --client-id is
                                  required (Finding 1 fix, 2026-07-20): ProofLedger storage is
                                  scoped per client, under ~/.kairos/promise-ledger/<client-id>/
                                  <contract-id>/ -- this refuses rather than falling back to any
                                  unscoped or ambiguous lookup.
  SLA compliance + ExceptionDesk (Phase 4) run only inside kairos watch --contracts (see
  kairos watch with no args, and ExceptionDesk options below). No dashboard, no autonomous
  business decisions anywhere in this arc -- Kairos only ever records and reports what evidence
  can prove.

ExceptionDesk options (v0, Phase 4 -- see docs/plans/process-contract-promise-engine-plan.md §7):
  All exceptions subcommands require --client-id <slug> (Finding 1 fix, 2026-07-20):
  ExceptionDesk storage is scoped per client, under the same
  ~/.kairos/promise-ledger/<client-id>/<contract-id>/ directory as the ledger above -- refuses
  rather than falling back to any unscoped or ambiguous lookup.
  exceptions list <contract-id>  Human resolution ONLY -- ack/resolve are the ONLY way an item's
    [--status <status>]          status ever changes. Items are opened/refreshed automatically,
  exceptions show <id> <item>    only inside kairos watch --contracts, never by any exceptions
  exceptions ack <id> <item>     subcommand. No auto-resolution, no workflow edits, ever. Each
    [--reason <text>]            item carries owner/nextAction (from the contract's own
  exceptions resolve <id> <item> OwnerAssignment/ExceptionRule, never invented), reason, evidence,
    [--reason <text>]            contract id, hashed correlation key (promiseInstanceId), the
                                  triggering SLA/expiration-rule/transition id, and a full
                                  status-change history (actor: 'auto' only for the opening event).
                                  IMPORTANT: ExceptionDesk only opens/refreshes items for
                                  time-based SLA/expiration drift findings. A terminal outcome
                                  reached quickly (e.g. a submission flagged "missing info" within
                                  minutes, well before any SLA/expiration deadline has passed)
                                  is correctly classified in 'contract report' but produces NO
                                  ExceptionDesk item -- this is a real system boundary, not a bug.
                                  Do not rely on ExceptionDesk alone to catch every miss; use
                                  'contract report' for the complete picture.

Sessions options:
  --limit <n>     Number of recent sessions to show (default: 20)
  --json          Output raw JSON instead of summary

Sync options:
  --max <count>          Maximum templates to fetch from n8n.io (default: 500)
  --from-dir <path>      Import from a local directory of workflow JSON files instead of n8n.io
                          (recurses into subdirectories, accepts bare or {workflow: {...}}-wrapped JSON)
  --limit <count>        Max entries to select via diversity-aware sampling (default: 1000, --from-dir only)
  --strict-code-nodes    Block workflows containing code nodes instead of demoting them to "review"
                          trust (default: review — see docs/plans/repo-integration-plan.md §5.1;
                          --from-dir only)

Library options:
  library prune --source <kind>   Remove all library entries with the given sourceKind
                                   (organic | n8n-template | imported)
  --dry-run                       Preview what would be removed without deleting anything

Environment variables:
  ANTHROPIC_API_KEY       Anthropic API key (required)
  N8N_BASE_URL            n8n instance URL (required for deploy, optional for --dry-run)
  N8N_API_KEY             n8n API key (required for deploy, optional for --dry-run)
  KAIROS_MODEL            Claude model override (default: claude-sonnet-4-6)
  KAIROS_MAX_TOKENS       Max output tokens for generation (default: 16000)
  KAIROS_TIMEOUT_MS       Generation call timeout in ms (default: 300000)
  KAIROS_TELEMETRY        Set to "true" or a directory path to enable telemetry logging
  KAIROS_LIBRARY_DIR      Override the workflow library directory (default: ~/.kairos/library)
  KAIROS_PROMPT_PROFILE   minimal | standard | rich (default: standard)
                          minimal: base prompt only, no library context, top 3 patterns
                          standard: full library context, top 10 patterns (default)
                          rich: full library context, top 15 patterns, proactive expression guidance
  KAIROS_LIBRARY_SIZE     Max library entries before oldest/least-used are evicted (default: 1500)
  KAIROS_WEIGHT_TFIDF     Retrieval weight: keyword/TF-IDF relevance (default: 0.35)
  KAIROS_WEIGHT_JACCARD   Retrieval weight: node-type overlap / Jaccard similarity (default: 0.30)
  KAIROS_WEIGHT_OUTCOME   Retrieval weight: past build outcome success (default: 0.20)
  KAIROS_WEIGHT_DEPLOY    Retrieval weight: deployment popularity (default: 0.15)
  KAIROS_WEIGHT_COSINE    Retrieval weight: embedding cosine similarity, only applies once a
                          workflow has a cached embedding vector (default: 0.25)
                          All KAIROS_WEIGHT_* values are normalized to sum to 1 — set any
                          subset, unset ones keep their default before normalization.
`

function getEnvOrExit(name: string): string {
  const val = process.env[name]
  if (!val) {
    console.error(`Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return val
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const args = argv.slice(2)
  const command = args[0] ?? ''
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}

const CLI_LOGGER = {
  debug: () => {},
  info: (msg: string, meta?: Record<string, unknown>) => console.error(meta ? `${msg} ${JSON.stringify(meta)}` : msg),
  warn: (msg: string, meta?: Record<string, unknown>) => console.error(meta ? `[warn] ${msg} ${JSON.stringify(meta)}` : `[warn] ${msg}`),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(meta ? `[error] ${msg} ${JSON.stringify(meta)}` : `[error] ${msg}`),
}

function getTelemetryOption(): boolean | string | undefined {
  const telemetryEnv = process.env['KAIROS_TELEMETRY']
  if (telemetryEnv === 'true') return true
  if (telemetryEnv && telemetryEnv !== 'false') return telemetryEnv
  return undefined
}

// For standalone functions (writeBundle(), runPreflight()) that take an optional
// TelemetryCollector directly rather than going through a Kairos instance -- same
// KAIROS_TELEMETRY-driven decision createClient()/createDryRunClient() already make, just
// producing a collector instance instead of a Kairos constructor option.
async function createTelemetryCollector(): Promise<TelemetryCollector | undefined> {
  const telemetry = getTelemetryOption()
  if (telemetry === undefined) return undefined
  const { TelemetryCollector } = await import('./telemetry/collector.js')
  return new TelemetryCollector(typeof telemetry === 'string' ? telemetry : undefined)
}

// Overrides the directory every CLI-constructed FileLibrary points at — mirrors
// getTelemetryOption()'s pattern. Exists so tests can point library-mutating
// commands (sync-templates, library prune) at an isolated temp directory instead
// of the real ~/.kairos/library.
function getLibraryDirOption(): string | undefined {
  return process.env['KAIROS_LIBRARY_DIR'] || undefined
}

function createLibrary(): FileLibrary {
  const dir = getLibraryDirOption()
  return dir ? new FileLibrary(dir) : new FileLibrary()
}

async function loadNodeRegistry(): Promise<NodeRegistry | undefined> {
  const telemetry = getTelemetryOption()
  const cachePath = getCatalogCachePath(typeof telemetry === 'string' ? telemetry : undefined)
  const cached = await readCatalogCache(cachePath)
  return cached?.registry
}

async function createClient(clientId?: string): Promise<Kairos> {
  const telemetry = getTelemetryOption()
  const nodeRegistry = await loadNodeRegistry()
  const { Kairos } = await import('./client.js')
  return new Kairos({
    anthropicApiKey: getEnvOrExit('ANTHROPIC_API_KEY'),
    n8nBaseUrl: getEnvOrExit('N8N_BASE_URL'),
    n8nApiKey: getEnvOrExit('N8N_API_KEY'),
    ...(process.env['KAIROS_MODEL'] ? { model: process.env['KAIROS_MODEL'] } : {}),
    ...(process.env['KAIROS_MAX_TOKENS'] ? { maxTokens: parseInt(process.env['KAIROS_MAX_TOKENS'], 10) } : {}),
    ...(process.env['KAIROS_TIMEOUT_MS'] ? { timeoutMs: parseInt(process.env['KAIROS_TIMEOUT_MS'], 10) } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(nodeRegistry ? { nodeRegistry } : {}),
    ...(clientId ? { clientId } : {}),
    library: createLibrary(),
    logger: CLI_LOGGER,
  })
}

async function createDryRunClient(clientId?: string): Promise<Kairos> {
  const telemetry = getTelemetryOption()
  const nodeRegistry = await loadNodeRegistry()
  const { Kairos } = await import('./client.js')
  return new Kairos({
    anthropicApiKey: getEnvOrExit('ANTHROPIC_API_KEY'),
    ...(process.env['N8N_BASE_URL'] ? { n8nBaseUrl: process.env['N8N_BASE_URL'] } : {}),
    ...(process.env['N8N_API_KEY'] ? { n8nApiKey: process.env['N8N_API_KEY'] } : {}),
    ...(process.env['KAIROS_MODEL'] ? { model: process.env['KAIROS_MODEL'] } : {}),
    ...(process.env['KAIROS_MAX_TOKENS'] ? { maxTokens: parseInt(process.env['KAIROS_MAX_TOKENS'], 10) } : {}),
    ...(process.env['KAIROS_TIMEOUT_MS'] ? { timeoutMs: parseInt(process.env['KAIROS_TIMEOUT_MS'], 10) } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(nodeRegistry ? { nodeRegistry } : {}),
    ...(clientId ? { clientId } : {}),
    library: createLibrary(),
    logger: CLI_LOGGER,
  })
}

async function handleBuild(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const description = positional.join(' ')
  if (!description) {
    console.error('Usage: kairos build <description> [--dry-run] [--name <name>] [--activate] [--smoke-test] [--client <id>]')
    process.exit(1)
  }

  const isDryRun = flags['dry-run'] === true
  const clientId = typeof flags['client'] === 'string' ? flags['client'] : undefined
  const kairos = isDryRun ? await createDryRunClient(clientId) : await createClient(clientId)
  const start = Date.now()

  console.error(`Generating workflow...`)

  const result = await kairos.build(description, {
    dryRun: isDryRun,
    ...(typeof flags['name'] === 'string' ? { name: flags['name'] } : {}),
    activate: flags['activate'] === true || flags['smoke-test'] === true,
    smokeTest: flags['smoke-test'] === true,
  })

  await kairos.drain()

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  console.error(`Done in ${elapsed}s (${result.generationAttempts} attempt${result.generationAttempts > 1 ? 's' : ''})`)
  console.error('')
  console.error(result.summary)
  console.error('')

  console.log(JSON.stringify({
    workflowId: result.workflowId,
    name: result.name,
    generationAttempts: result.generationAttempts,
    activationRequired: result.activationRequired,
    dryRun: result.dryRun,
    credentialsNeeded: result.credentialsNeeded,
    summary: result.summary,
    ...(result.dryRun ? { workflow: result.workflow } : {}),
    ...(result.smokeTest ? { smokeTest: result.smokeTest } : {}),
  }, null, 2))
}

async function handleReplace(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const id = positional[0]
  const description = positional.slice(1).join(' ')

  if (!id || !description) {
    console.error('Usage: kairos replace <n8n-workflow-id> <description> [--client <id>]')
    process.exit(1)
  }

  const clientId = typeof flags['client'] === 'string' ? flags['client'] : undefined
  const kairos = await createClient(clientId)
  const start = Date.now()
  console.error(`Replacing workflow ${id}...`)

  const result = await kairos.replace(id, description)
  await kairos.drain()

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.error(`Done in ${elapsed}s (${result.generationAttempts} attempt${result.generationAttempts > 1 ? 's' : ''})`)
  console.error('')
  console.error(result.summary)
  console.error('')

  console.log(JSON.stringify({
    workflowId: result.workflowId,
    name: result.name,
    generationAttempts: result.generationAttempts,
    summary: result.summary,
  }, null, 2))
}

const MEMORY_TYPES = ['preference', 'history', 'incident', 'reference'] as const

async function handleMemoryAdd(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const clientId = positional[0]
  const type = positional[1]
  const description = positional.slice(2).join(' ')

  if (!clientId || !type || !(MEMORY_TYPES as readonly string[]).includes(type) || !description) {
    console.error(`Usage: kairos memory add <client-id> <${MEMORY_TYPES.join('|')}> <description> [--body <text>] [--tags a,b,c]`)
    process.exit(1)
  }

  const { ClientMemoryStore } = await import('./memory/store.js')
  const store = new ClientMemoryStore(clientId)
  const body = typeof flags['body'] === 'string' ? flags['body'] : description
  const tags = typeof flags['tags'] === 'string'
    ? flags['tags'].split(',').map((t) => t.trim()).filter(Boolean)
    : []

  const node = await store.remember({
    type: type as typeof MEMORY_TYPES[number],
    description,
    body,
    tags,
    source: 'user',
  })
  console.log(JSON.stringify(node, null, 2))
}

async function handleMemoryList(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const clientId = positional[0]
  if (!clientId) {
    console.error('Usage: kairos memory list <client-id> [--type <type>] [--json]')
    process.exit(1)
  }

  const { ClientMemoryStore } = await import('./memory/store.js')
  const store = new ClientMemoryStore(clientId)
  const nodes = await store.loadAllNodes()
  const filterType = typeof flags['type'] === 'string' ? flags['type'] : undefined
  const filtered = filterType ? nodes.filter((n) => n.type === filterType) : nodes

  if (flags['json'] === true) {
    console.log(JSON.stringify(filtered, null, 2))
    return
  }

  console.error(`${filtered.length} memory node(s) for client "${clientId}"`)
  for (const n of filtered) {
    console.error(`  [${n.type}] ${n.id.slice(0, 8)} — ${n.description}`)
  }
}

async function handleMemorySearch(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const clientId = positional[0]
  const query = positional.slice(1).join(' ')
  if (!clientId || !query) {
    console.error('Usage: kairos memory search <client-id> <query> [--k <n>] [--json]')
    process.exit(1)
  }

  const { ClientMemoryStore } = await import('./memory/store.js')
  const store = new ClientMemoryStore(clientId)
  const k = typeof flags['k'] === 'string' ? parseInt(flags['k'], 10) : 5
  const results = await store.retrieve(query, k)

  if (flags['json'] === true) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  console.error(`${results.length} result(s) for "${query}"`)
  for (const n of results) {
    console.error(`  [${n.type}] ${n.description}`)
  }
}

async function handleMemoryForget(positional: string[]): Promise<void> {
  const clientId = positional[0]
  const id = positional[1]
  if (!clientId || !id) {
    console.error('Usage: kairos memory forget <client-id> <memory-id>')
    process.exit(1)
  }

  const { ClientMemoryStore } = await import('./memory/store.js')
  const store = new ClientMemoryStore(clientId)
  const removed = await store.forget(id)
  if (!removed) {
    console.error(`No memory found with id "${id}"`)
    process.exit(1)
  }
  console.error(`Forgot memory ${id}`)
}

async function handleMemoryRebuildIndex(positional: string[]): Promise<void> {
  const clientId = positional[0]
  if (!clientId) {
    console.error('Usage: kairos memory rebuild-index <client-id>')
    process.exit(1)
  }

  const { ClientMemoryStore } = await import('./memory/store.js')
  const store = new ClientMemoryStore(clientId)
  const count = await store.rebuildIndex()
  console.error(`Rebuilt index: ${count} memory node(s) for client "${clientId}"`)
}

async function handleList(): Promise<void> {
  const kairos = await createClient()
  const workflows = await kairos.list()
  await kairos.drain()

  if (workflows.length === 0) {
    console.log('No workflows found.')
    return
  }

  for (const w of workflows) {
    const status = w.active ? 'active' : 'inactive'
    console.log(`  ${w.id}  ${status.padEnd(8)}  ${w.name}`)
  }
  console.log(`\n${workflows.length} workflow(s)`)
}

async function handleGet(positional: string[]): Promise<void> {
  const id = positional[0]
  if (!id) {
    console.error('Usage: kairos get <workflow-id>')
    process.exit(1)
  }

  const kairos = await createClient()
  const workflow = await kairos.get(id)
  await kairos.drain()
  console.log(JSON.stringify(workflow, null, 2))
}

async function handleActivate(positional: string[]): Promise<void> {
  const id = positional[0]
  if (!id) {
    console.error('Usage: kairos activate <workflow-id>')
    process.exit(1)
  }

  const kairos = await createClient()
  await kairos.activate(id)
  await kairos.drain()
  console.log(`Activated workflow ${id}`)
}

async function handleDeactivate(positional: string[]): Promise<void> {
  const id = positional[0]
  if (!id) {
    console.error('Usage: kairos deactivate <workflow-id>')
    process.exit(1)
  }

  const kairos = await createClient()
  await kairos.deactivate(id)
  await kairos.drain()
  console.log(`Deactivated workflow ${id}`)
}

async function handleDelete(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const id = positional[0]
  if (!id) {
    console.error('Usage: kairos delete <workflow-id> --confirm')
    process.exit(1)
  }

  if (flags['confirm'] !== true) {
    console.error('Refusing to delete without --confirm flag.')
    process.exit(1)
  }

  const kairos = await createClient()
  await kairos.delete(id, { confirm: true })
  await kairos.drain()
  console.log(`Deleted workflow ${id}`)
}

async function handleLocalImport(dir: string, flags: Record<string, string | boolean>): Promise<void> {
  const limitRaw = typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : NaN
  const limit = Number.isNaN(limitRaw) ? 1000 : limitRaw
  const dryRun = flags['dry-run'] === true
  const codeNodePolicy = flags['strict-code-nodes'] === true ? 'block' : 'review'
  const tag = dryRun ? '[DRY RUN] ' : ''

  const library = createLibrary()
  const { LocalImporter } = await import('./templates/local-importer.js')
  const importer = new LocalImporter(library, CLI_LOGGER)

  // AMENDMENT D: bias diversity selection toward Kairos's own build history rather than
  // pure round-robin across every integration in the source dataset.
  const analyzer = PatternAnalyzer.fromEnv()
  const sessions = await analyzer.getSessions(100_000)
  const workflowTypeWeights = new Map<string, number>()
  for (const s of sessions) {
    if (s.workflowType) workflowTypeWeights.set(s.workflowType, (workflowTypeWeights.get(s.workflowType) ?? 0) + 1)
  }

  console.error(`${tag}Importing workflows from ${dir} (limit ${limit}, code nodes: ${codeNodePolicy})...`)

  const report = await importer.importFromDirectory(dir, {
    limit,
    dryRun,
    codeNodePolicy,
    workflowTypeWeights,
    onProgress: (p) => {
      if (p.parsed % 100 === 0 && p.parsed > 0) {
        console.error(`  Progress: ${p.parsed} parsed, ${p.duplicates} dup, ${p.blocked} blocked, ${p.invalid} invalid...`)
      }
    },
  })

  console.error('')
  console.error(`${tag}Local import complete:`)
  console.error(`  Files found:     ${report.filesFound}`)
  console.error(`  Parsed:          ${report.parsed}  (${report.parseErrors} parse errors)`)
  console.error(`  Duplicates:      ${report.duplicates}`)
  console.error(`  Blocked:         ${report.blocked} (executeCommand/ssh, secrets, or --strict-code-nodes)`)
  console.error(`  Review tier:     ${report.reviewed}`)
  console.error(`  Failed validation: ${report.invalid}`)
  console.error(`  Candidates:      ${report.candidatesAfterGating}`)
  console.error(`  Selected:        ${report.selected}`)
  console.error(`  ${dryRun ? 'Would save' : 'Saved'}:          ${dryRun ? report.selected : report.saved}`)
  console.error(`  Capacity left:   ${report.capacityAvailable}`)
  if (report.stoppedReason) {
    console.error('')
    console.error(`  ${report.stoppedReason}`)
  }
}

async function handleLibraryPrune(flags: Record<string, string | boolean>): Promise<void> {
  const source = flags['source']
  const validSources = ['organic', 'n8n-template', 'imported']
  if (typeof source !== 'string' || !validSources.includes(source)) {
    console.error('Usage: kairos library prune --source <organic|n8n-template|imported> [--dry-run]')
    process.exit(1)
  }

  const dryRun = flags['dry-run'] === true
  const library = createLibrary()
  await library.initialize()

  if (dryRun) {
    const all = await library.list()
    const matching = all.filter((w) => w.sourceKind === source)
    console.log(`[DRY RUN] Would remove ${matching.length} entr${matching.length === 1 ? 'y' : 'ies'} with sourceKind="${source}".`)
    for (const w of matching.slice(0, 20)) {
      console.log(`  - ${w.id}  ${w.description.slice(0, 70)}`)
    }
    if (matching.length > 20) console.log(`  ... and ${matching.length - 20} more`)
    return
  }

  const result = await library.pruneBySource(source as import('./library/types.js').SourceKind)
  await library.drain()
  console.log(`Removed ${result.removed.length} entr${result.removed.length === 1 ? 'y' : 'ies'} with sourceKind="${source}".`)
}

async function handleSyncTemplates(flags: Record<string, string | boolean>): Promise<void> {
  const fromDir = flags['from-dir']
  if (typeof fromDir === 'string') {
    await handleLocalImport(fromDir, flags)
    return
  }

  const maxRaw = typeof flags['max'] === 'string' ? parseInt(flags['max'], 10) : NaN
  const max = Number.isNaN(maxRaw) ? 500 : maxRaw
  const library = createLibrary()
  const syncer = new TemplateSyncer(library, CLI_LOGGER)

  console.error(`Syncing up to ${max} templates from n8n community library...`)

  const result = await syncer.sync({
    maxTemplates: max,
    onProgress: (p) => {
      if (p.processed % 25 === 0 && p.processed > 0) {
        console.error(`  Progress: ${p.processed}/${p.total} processed, ${p.saved} saved`)
      }
    },
  })

  console.error('')
  console.error(`Sync complete:`)
  console.error(`  Saved:      ${result.saved}`)
  console.error(`  Blocked:    ${result.blocked} (validation errors or unsafe content)`)
  console.error(`  Review:     ${result.reviewed} (saved but flagged for review)`)
  console.error(`  Duplicates: ${result.skippedDuplicate} (already in library)`)
  console.error(`  Paid:       ${result.skippedPaid} (skipped)`)
}

async function handleSyncNodes(): Promise<void> {
  const baseUrl = getEnvOrExit('N8N_BASE_URL')
  const apiKey = getEnvOrExit('N8N_API_KEY')
  const client = new N8nApiClient(baseUrl, apiKey, CLI_LOGGER)

  console.error('Fetching node types from your n8n instance...')
  const nodeTypes = await client.getNodeTypes()
  if (nodeTypes.length === 0) {
    console.error('No node types returned — registry not updated. Check N8N_BASE_URL/N8N_API_KEY.')
    process.exit(1)
  }

  const result = new NodeSyncer().sync(nodeTypes)
  const telemetry = getTelemetryOption()
  const cachePath = getCatalogCachePath(typeof telemetry === 'string' ? telemetry : undefined)
  await writeCatalogCache(cachePath, result)

  console.error(`Synced ${result.nodeCount} node types (${result.newNodes} new beyond the built-in registry).`)
  console.error(`Cached to ${cachePath} — build/validate will use it for the next 24h, or until you run sync-nodes again.`)
}

async function handlePatterns(flags: Record<string, string | boolean>): Promise<void> {
  const daysRaw = typeof flags['days'] === 'string' ? parseInt(flags['days'], 10) : NaN
  const days = Number.isNaN(daysRaw) ? 30 : daysRaw
  const analyzer = PatternAnalyzer.fromEnv()

  const analysis = await analyzer.analyzeAndSave(days)

  if (flags['json'] === true) {
    console.log(JSON.stringify(analysis, null, 2))
    return
  }

  console.log(`\nKairos Pattern Analysis (last ${days} days)`)
  console.log('─'.repeat(45))
  console.log(`  Builds:          ${analysis.summary.totalBuilds}`)
  console.log(`  Attempts:        ${analysis.summary.totalAttempts}`)
  console.log(`  First-try pass:  ${(analysis.summary.firstTryPassRate * 100).toFixed(1)}%`)
  console.log(`  Correction rate: ${(analysis.summary.correctionRate * 100).toFixed(1)}%`)
  if (analysis.summary.singleAttemptFailRate !== undefined) {
    console.log(`  Single-attempt failures: ${(analysis.summary.singleAttemptFailRate * 100).toFixed(1)}%`)
  }
  console.log(`  Avg duration:    ${(analysis.summary.avgDurationMs / 1000).toFixed(1)}s`)

  const pendingOnly = flags['pending'] === true
  const active = analysis.topFailureRules.filter(p =>
    pendingOnly ? p.state === 'pending_review' : p.state !== 'resolved'
  )
  const resolved = pendingOnly ? [] : analysis.topFailureRules.filter(p => p.state === 'resolved')

  // Experimental, off by default (docs/plans/reliability-suite-plan.md §10.4/10.4a): community
  // data never touches analysis.topFailureRules or its scoring -- this is purely a text-render
  // annotation layer, loaded and rendered only when explicitly enabled.
  const communityEnabled = process.env['KAIROS_COMMUNITY_PATTERNS'] === 'true'
  let communityAnnotations: import('./reliability/community/ingest.js').CommunityAnnotations | null = null
  if (communityEnabled) {
    const { loadCommunityPatternStore, annotateWithCommunityData } = await import('./reliability/community/ingest.js')
    const store = await loadCommunityPatternStore()
    if (store) communityAnnotations = annotateWithCommunityData(analysis.topFailureRules, store)
  }

  if (active.length > 0) {
    console.log(pendingOnly ? `\nPatterns Awaiting Review:` : `\nActive Failure Patterns:`)
    for (const p of active) {
      const regressionTag = p.regressed ? '[REGRESSION] ' : ''
      const stateTag = p.state === 'confirmed' ? '[CONFIRMED]' : p.state === 'pending_review' ? '[PENDING REVIEW]' : '[DRAFT]'
      const trendIcon = p.trend === 'improving' ? ' ^' : p.trend === 'worsening' ? ' v' : p.trend === 'new' ? ' *' : ''
      const stage = p.pipelineStage.replace(/_/g, ' ')
      const scoreStr = p.compositeScore.toFixed(3)
      console.log(`  Rule ${p.rule} ${regressionTag}${stateTag}${trendIcon} — score ${scoreStr} | ${p.failureCount} failures (${(p.confidence * 100).toFixed(1)}%) [${stage}]`)
      const f = p.scoringFactors
      console.log(`    Factors: confidence=${f.rawConfidence} × impact=${f.impact} × recency=${f.recency} + boost=${f.stickinessBoost}`)
      if (p.mitigation) console.log(`    Fix: ${p.mitigation}`)
      if (p.exampleMessages.length > 0) console.log(`    e.g. ${p.exampleMessages[0]}`)
      if (p.workflowTypeBreakdown) {
        const topType = Object.entries(p.workflowTypeBreakdown).sort((a, b) => b[1] - a[1])[0]
        if (topType) console.log(`    Top workflow type: ${topType[0]} (${topType[1]} failures)`)
      }
      const communityMatch = communityAnnotations?.localMatches.get(p.rule)
      if (communityMatch) {
        console.log(`    [EXPERIMENTAL COMMUNITY] also reported in ${communityMatch.reportCount} community submission(s) -- informational only, does not affect this pattern's score or state`)
      }
    }
  } else {
    console.log(`\nNo active failure patterns.`)
  }

  if (communityAnnotations && communityAnnotations.communityOnly.length > 0) {
    console.log(`\n[EXPERIMENTAL COMMUNITY] Reported by other Kairos installs, not yet seen locally:`)
    for (const c of communityAnnotations.communityOnly) {
      console.log(`  Rule ${c.rule} — ${c.reportCount} submission(s), ${c.totalOccurrences} total occurrences [${c.pipelineStage.replace(/_/g, ' ')}]`)
    }
    console.log(`  (unconfirmed by this install's own telemetry -- never influences generation or local scoring)`)
  }

  if (resolved.length > 0) {
    console.log(`\nResolved Patterns:`)
    for (const p of resolved) {
      console.log(`  Rule ${p.rule} — previously confirmed, 0 failures in current window`)
    }
  }

  if (analysis.failingCredentialTypes.length > 0) {
    console.log(`\nFailing Credential Types:`)
    for (const c of analysis.failingCredentialTypes) {
      console.log(`  ${c.type}: ${c.count} failures`)
    }
  }

  if (analysis.warningEffectiveness && analysis.warningEffectiveness.length > 0) {
    console.log(`\nWarning Effectiveness:`)
    for (const w of analysis.warningEffectiveness) {
      console.log(`  Rule ${w.rule}: warned ${w.timesWarned}x, prevented ${w.timesWarnedAndPassed}x (${Math.round(w.effectivenessRate * 100)}% effective)`)
    }
  }

  const drift = analysis.drift
  if (drift) {
    console.log(`\nDrift Detection: ${drift.healthy ? 'HEALTHY' : 'ALERTS FOUND'}`)
    console.log(`  Coverage: ${drift.coveredRules}/${drift.totalRules} rules have mitigations + stage mappings`)
    if (drift.alerts.length > 0) {
      for (const a of drift.alerts) {
        console.log(`  [${a.type}] Rule ${a.rule}: ${a.message}`)
      }
    }
  }

  console.log(`\nPatterns saved to ~/.kairos/patterns.json`)
}

function parseRuleArg(positional: string[], usage: string): number {
  const ruleArg = positional[0]
  const rule = ruleArg ? parseInt(ruleArg, 10) : NaN
  if (!ruleArg || Number.isNaN(rule)) {
    console.error(usage)
    process.exit(1)
  }
  return rule
}

async function handlePatternApprove(positional: string[]): Promise<void> {
  const rule = parseRuleArg(positional, 'Usage: kairos patterns approve <rule-number>')
  const analyzer = PatternAnalyzer.fromEnv()
  const approved = await analyzer.approvePattern(rule)
  if (!approved) {
    console.error(`No pattern awaiting review for Rule ${rule} (run 'kairos patterns --pending' to see what's pending).`)
    process.exit(1)
  }
  console.log(`Rule ${rule} approved — now confirmed and will influence generation.`)
}

async function handlePatternReject(positional: string[]): Promise<void> {
  const rule = parseRuleArg(positional, 'Usage: kairos patterns reject <rule-number> [reason]')
  const reason = positional.slice(1).join(' ') || undefined
  const analyzer = PatternAnalyzer.fromEnv()
  const rejected = await analyzer.rejectPattern(rule, reason)
  if (!rejected) {
    console.error(`No pattern awaiting review for Rule ${rule} (run 'kairos patterns --pending' to see what's pending).`)
    process.exit(1)
  }
  console.log(`Rule ${rule} rejected${reason ? ` (${reason})` : ''} — marked resolved, will not influence generation.`)
}

async function handlePatternShare(): Promise<void> {
  const { buildPatternShareReport } = await import('./reliability/community/whitelist.js')
  const { formatReportPreview, writePatternReportFile, attemptGhIssueCreate, manualIssueUrl, COMMUNITY_REPO } =
    await import('./reliability/community/share.js')

  const analyzer = PatternAnalyzer.fromEnv()
  const patterns = await analyzer.loadCurrentPatterns()
  const report = buildPatternShareReport(patterns)

  if (report.patterns.length === 0) {
    console.log("No confirmed patterns to share yet. Run 'kairos patterns approve <rule-number>' on a pattern you trust first.")
    return
  }

  console.log('The following data would leave this machine:\n')
  console.log(formatReportPreview(report))
  console.log('')

  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>(resolve =>
    rl.question(`This will create a public GitHub issue at github.com/${COMMUNITY_REPO} containing the JSON above. Continue? [y/N] `, resolve)
  )
  rl.close()
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Not shared.')
    return
  }

  const path = await writePatternReportFile(report)
  console.log(`Wrote ${path}.`)

  const ghResult = await attemptGhIssueCreate(path, report.kairosVersion)
  if (ghResult.opened) {
    console.log('Opened a GitHub issue via gh.')
  } else if (ghResult.attempted) {
    console.error(`gh issue create did not succeed (exit ${String(ghResult.exitCode)}${ghResult.error ? `: ${ghResult.error}` : ''}).`)
    console.log(`Open manually: ${manualIssueUrl()} and attach or paste the contents of ${path}.`)
  } else {
    console.log(`gh CLI not found. Open manually: ${manualIssueUrl()} and attach or paste the contents of ${path}.`)
  }
}

async function handlePatternIngest(positional: string[]): Promise<void> {
  const path = positional[0]
  if (!path) {
    console.error('Usage: kairos patterns ingest <path>')
    console.error('Reads a local kairos-patterns-share-shaped JSON file (no network) and')
    console.error('overwrites ~/.kairos/community-patterns.json with its aggregate.')
    process.exit(1)
  }

  const { ingestCommunityPatternsFromFile } = await import('./reliability/community/ingest.js')
  let store: Awaited<ReturnType<typeof ingestCommunityPatternsFromFile>>
  try {
    store = await ingestCommunityPatternsFromFile(path)
  } catch (err) {
    console.error(`Could not ingest ${path}: ${String(err)}`)
    process.exit(1)
  }

  console.log(`Ingested ${store.entries.length} rule(s) from ${path} into ~/.kairos/community-patterns.json.`)
  console.log(`[EXPERIMENTAL] This is display-only context -- set KAIROS_COMMUNITY_PATTERNS=true to see it in 'kairos patterns'. It never influences local pattern scoring or generation.`)
}

async function handlePatternSync(flags: Record<string, string | boolean>): Promise<void> {
  const url = typeof flags['url'] === 'string' ? flags['url'] : undefined
  if (!url) {
    console.error('Usage: kairos patterns sync --url <url>')
    console.error('Fetches one JSON file (a kairos patterns share-shaped report) and ingests it')
    console.error('the same way `kairos patterns ingest` does. No default URL -- there is no')
    console.error('official community corpus feed yet; you must name the source explicitly.')
    process.exit(1)
  }

  const { syncCommunityPatternsFromUrl } = await import('./reliability/community/ingest.js')
  let store: Awaited<ReturnType<typeof syncCommunityPatternsFromUrl>>
  try {
    store = await syncCommunityPatternsFromUrl(url)
  } catch (err) {
    console.error(`Could not sync from ${url}: ${String(err)}`)
    process.exit(1)
  }

  console.log(`Synced ${store.entries.length} rule(s) from ${url} into ~/.kairos/community-patterns.json.`)
  console.log(`[EXPERIMENTAL] This is display-only context -- set KAIROS_COMMUNITY_PATTERNS=true to see it in 'kairos patterns'. It never influences local pattern scoring or generation.`)
}

async function handleSessions(flags: Record<string, string | boolean>): Promise<void> {
  const limitRaw = typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : NaN
  const limit = Number.isNaN(limitRaw) ? 20 : limitRaw
  const analyzer = PatternAnalyzer.fromEnv()
  const sessions = await analyzer.getSessions(limit)

  if (flags['json'] === true) {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }

  if (sessions.length === 0) {
    console.log('No session history found. Run kairos patterns first to generate session data.')
    return
  }

  console.log(`\nRecent Sessions (last ${sessions.length})`)
  console.log('─'.repeat(60))

  for (const s of [...sessions].reverse()) {
    const status = s.success ? '✓' : '✗'
    const typeTag = s.workflowType ? ` [${s.workflowType}]` : ''
    const attemptsStr = s.attempts > 1 ? ` (${s.attempts} attempts)` : ''
    const nameStr = s.workflowName ? `  ${s.workflowName}` : `  ${s.description.slice(0, 50)}`
    const rulesStr = s.failedRules.length > 0 ? `  — rules ${s.failedRules.join(', ')} failed` : ''
    console.log(`${s.date}  ${status}${nameStr}${attemptsStr}${typeTag}${rulesStr}`)
  }
}

function printPackResult(result: import('./pack/pack-builder.js').WorkflowPackResult): void {
  const line = '─'.repeat(50)
  const deployed = result.workflows.filter(w => w.deployed).length
  const total = result.workflows.length

  console.error(`\n${result.businessContext} — Workflow Pack`)
  console.error('═'.repeat(Math.min(result.businessContext.length + 18, 60)))
  console.error(`Status: ${result.status}`)

  const blocking = result.assumptions.filter(a => a.type === 'blocking')
  if (blocking.length > 0) {
    console.error(`\n⚠ Blocking Issues (${blocking.length}) — resolve before activating`)
    console.error(line)
    for (const a of blocking) {
      console.error(`  ✗ ${a.text}`)
    }
  }

  console.error(`\nWorkflows Built (${deployed}/${total})`)
  console.error(line)
  for (const wf of result.workflows) {
    const icon = wf.error ? '✗' : '✓'
    const idStr = wf.workflowId ? `  [${wf.workflowId}]` : ''
    const attStr = wf.generationAttempts > 1 ? `  ${wf.generationAttempts} attempts` : ''
    console.error(`  ${icon} ${wf.name}${idStr}${attStr}`)
    console.error(`    ${wf.purpose}`)
    if (wf.error) console.error(`    Error: ${wf.error}`)
  }

  if (result.allCredentials.length > 0) {
    console.error(`\nCredentials Needed (connect once in n8n)`)
    console.error(line)
    for (const cred of result.allCredentials) {
      console.error(`  □ ${cred.service}`)
    }
  }

  if (result.sheetsColumns.length > 0) {
    console.error(`\nGoogle Sheets Required`)
    console.error(line)
    for (const sheet of result.sheetsColumns) {
      console.error(`  □ ${sheet.sheet}: ${sheet.columns.join(', ')}`)
    }
  }

  const needsConfirmation = result.assumptions.filter(a => a.type === 'needs_confirmation')
  if (needsConfirmation.length > 0) {
    console.error(`\nNeeds Confirmation Before Going Live`)
    console.error(line)
    for (const a of needsConfirmation) {
      console.error(`  ? ${a.text}`)
    }
  }

  const safe = result.assumptions.filter(a => a.type === 'safe')
  if (safe.length > 0) {
    console.error(`\nSafe Assumptions`)
    console.error(line)
    for (const a of safe) {
      console.error(`  - ${a.text}`)
    }
  }

  if (result.testChecklist.length > 0) {
    console.error(`\nTest Checklist`)
    console.error(line)
    for (const item of result.testChecklist) {
      console.error(`  ${item.workflow}`)
      for (const step of item.steps) {
        console.error(`    □ ${step}`)
      }
    }
  }
}

async function handleBuildPack(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const businessContext = positional.join(' ')
  if (!businessContext) {
    console.error('Usage: kairos build-pack <business context description> [--dry-run] [--activate] [--yes] [--despite-blocking]')
    process.exit(1)
  }

  const anthropicKey = getEnvOrExit('ANTHROPIC_API_KEY')
  const { PackBuilder } = await import('./pack/pack-builder.js')
  const isDryRun = flags['dry-run'] === true
  const kairos = isDryRun ? await createDryRunClient() : await createClient()
  const builder = new PackBuilder({ anthropicApiKey: anthropicKey, kairos })

  console.error('\nPlanning workflow pack...')
  const plan = await builder.plan(businessContext)

  console.error(`\n${businessContext} — Planned Workflows (${plan.workflows.length})\n`)
  for (let i = 0; i < plan.workflows.length; i++) {
    const wf = plan.workflows[i]!
    console.error(`  ${i + 1}. ${wf.name}`)
    console.error(`     ${wf.purpose}`)
  }

  const planBlocking = plan.assumptions.filter(a => a.type === 'blocking')
  const planNeedsConfirmation = plan.assumptions.filter(a => a.type === 'needs_confirmation')
  if (planBlocking.length > 0) {
    console.error(`\nBlocking Issues (resolve before activation)`)
    for (const a of planBlocking) console.error(`  ✗ ${a.text}`)
  }
  if (planNeedsConfirmation.length > 0) {
    console.error(`\nNeeds Confirmation`)
    for (const a of planNeedsConfirmation) console.error(`  ? ${a.text}`)
  }

  if (flags['yes'] !== true) {
    const readline = await import('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>(resolve => rl.question('\nBuild all of these? [y/N] ', resolve))
    rl.close()
    if (!answer.toLowerCase().startsWith('y')) {
      console.error('Aborted.')
      process.exit(0)
    }
  }

  console.error('\nBuilding...\n')
  const result = await builder.build(plan, {
    dryRun: isDryRun,
    activate: flags['activate'] === true,
    buildDespiteBlocking: flags['despite-blocking'] === true,
    onProgress: (wf, i, total) => {
      console.error(`  [${i + 1}/${total}] ${wf.name}...`)
    },
  })

  if (result.escalation) {
    console.error(`\n⚠ Build stopped — blocking assumptions must be resolved first`)
    console.error('─'.repeat(50))
    console.error(result.escalation.reason)
    console.error('')
    console.error('Questions to resolve:')
    for (const q of result.escalation.questions) console.error(`  - ${q}`)
  } else {
    printPackResult(result)
  }

  const { writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const packsDir = join(homedir(), '.kairos', 'packs')
  await mkdir(packsDir, { recursive: true })
  const packPath = join(packsDir, `${result.packName}.json`)
  await writeFile(packPath, JSON.stringify(result, null, 2), 'utf-8')
  console.error(`\nPack saved to: ${packPath}`)

  if (result.escalation) process.exit(2)
}

async function handlePackExport(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const packName = positional[0]
  if (!packName) {
    console.error('Usage: kairos pack export <pack-name> [--handoff] [--credentials] [--risk-report] [--impact-notes] [--monitoring-plan] [--workflow-json <dir>] [--test-payloads <dir>] [--openapi <dir>] [--bundle <dir>]')
    process.exit(1)
  }

  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const packPath = join(homedir(), '.kairos', 'packs', `${packName}.json`)

  let pack: import('./pack/pack-builder.js').WorkflowPackResult
  try {
    const content = await readFile(packPath, 'utf-8')
    pack = JSON.parse(content) as import('./pack/pack-builder.js').WorkflowPackResult
  } catch {
    console.error(`Pack not found: ${packPath}`)
    console.error('Run "kairos build-pack <context>" to create one.')
    process.exit(1)
  }

  if (typeof flags['workflow-json'] === 'string') {
    const outDir = flags['workflow-json']
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --workflow-json (fetches each workflow live from n8n).')
      process.exit(1)
    }
    const { writeWorkflowJsonFiles } = await import('./pack/pack-bundle.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
    const result = await writeWorkflowJsonFiles(pack.workflows, client, outDir)
    for (const w of result.written) console.error(`Wrote ${w.path}`)
    for (const s of result.skipped) console.error(`Skipped "${s.workflowName}": ${s.reason}`)
    console.error(`\n${result.written.length} workflow.json file(s) written to ${outDir}, ${result.skipped.length} skipped.`)
    return
  }

  if (typeof flags['test-payloads'] === 'string') {
    const outDir = flags['test-payloads']
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --test-payloads (fetches each workflow live from n8n).')
      process.exit(1)
    }
    const { writeTestPayloadFiles } = await import('./pack/pack-bundle.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
    const result = await writeTestPayloadFiles(pack.workflows, client, outDir)
    for (const w of result.written) console.error(`Wrote ${w.path}`)
    for (const s of result.skipped) console.error(`Skipped "${s.workflowName}": ${s.reason}`)
    console.error(`\n${result.written.length} test-payloads.json file(s) written to ${outDir}, ${result.skipped.length} skipped.`)
    return
  }

  if (typeof flags['openapi'] === 'string') {
    const outDir = flags['openapi']
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --openapi (fetches each workflow live from n8n).')
      process.exit(1)
    }
    const { writeOpenApiFiles } = await import('./pack/pack-bundle.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
    const result = await writeOpenApiFiles(pack.workflows, client, outDir)
    for (const w of result.written) console.error(`Wrote ${w.path}`)
    for (const s of result.skipped) console.error(`Skipped "${s.workflowName}": ${s.reason}`)
    console.error(`\n${result.written.length} contract.openapi.json file(s) written to ${outDir}, ${result.skipped.length} skipped.`)
    return
  }

  if (typeof flags['bundle'] === 'string') {
    const outDir = flags['bundle']
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --bundle (fetches each workflow live from n8n).')
      process.exit(1)
    }
    const { writeBundle } = await import('./pack/pack-bundle.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
    const telemetry = await createTelemetryCollector()
    const manifest = await writeBundle(pack, client, outDir, telemetry)
    for (const f of manifest.files) console.error(`Wrote ${f.path}`)
    for (const s of manifest.skipped) console.error(`Skipped ${s.artifact}${s.workflowName ? ` for "${s.workflowName}"` : ''}: ${s.reason}`)
    console.error(`\n${manifest.files.length} file(s) written to ${outDir}, ${manifest.skipped.length} skipped. See bundle-manifest.json for details.`)
    return
  }

  if (flags['monitoring-plan'] === true) {
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --monitoring-plan (checks each workflow\'s live status and execution history).')
      process.exit(1)
    }
    const { generateMonitoringPlan } = await import('./pack/pack-bundle.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
    console.log(await generateMonitoringPlan(pack, client))
    return
  }

  if (flags['handoff'] === true) {
    const { generateHandoff } = await import('./pack/pack-exporter.js')
    console.log(generateHandoff(pack))
  } else if (flags['credentials'] === true) {
    const { generateCredentialsDoc } = await import('./pack/pack-bundle.js')
    console.log(generateCredentialsDoc(pack))
  } else if (flags['risk-report'] === true) {
    const { generateRiskReport } = await import('./pack/pack-bundle.js')
    console.log(generateRiskReport(pack))
  } else if (flags['impact-notes'] === true) {
    const { generateImpactNotesTemplate } = await import('./pack/pack-exporter.js')
    console.log(generateImpactNotesTemplate(pack.businessContext))
  } else {
    console.log(JSON.stringify(pack, null, 2))
  }
}

async function handlePackWire(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const packName = positional[0]
  if (!packName) {
    console.error('Usage: kairos pack wire <pack-name> [--sheet-ids <json-or-path>] [--dry-run]')
    console.error('')
    console.error('Examples:')
    console.error("  kairos pack wire empire-homecare --sheet-ids '{\"Facility Contacts\": \"1BxiMV...\"}'")
    console.error('  kairos pack wire empire-homecare --sheet-ids ./sheet-ids.json --dry-run')
    process.exit(1)
  }

  const dryRun = flags['dry-run'] === true
  const sheetIdsArg = flags['sheet-ids'] as string | undefined

  let sheetIds: import('./pack/pack-wirer.js').SheetIdMapping = {}
  if (sheetIdsArg) {
    try {
      // Try JSON inline first, then as a file path
      if (sheetIdsArg.trim().startsWith('{')) {
        sheetIds = JSON.parse(sheetIdsArg)
      } else {
        const { readFile } = await import('node:fs/promises')
        const content = await readFile(sheetIdsArg, 'utf-8')
        sheetIds = JSON.parse(content)
      }
    } catch {
      console.error(`Error parsing --sheet-ids: must be valid JSON or a path to a JSON file`)
      process.exit(1)
    }
  }

  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const { readFile } = await import('node:fs/promises')

  const packPath = join(homedir(), '.kairos', 'packs', `${packName}.json`)
  let pack: import('./pack/pack-builder.js').WorkflowPackResult
  try {
    const content = await readFile(packPath, 'utf-8')
    pack = JSON.parse(content) as import('./pack/pack-builder.js').WorkflowPackResult
  } catch {
    console.error(`Pack not found: ${packPath}`)
    console.error('Run "kairos build-pack <context>" to create one.')
    process.exit(1)
  }

  const n8nBaseUrl = process.env['N8N_BASE_URL']
  const n8nApiKey = process.env['N8N_API_KEY']

  if (!dryRun && (!n8nBaseUrl || !n8nApiKey)) {
    console.error('N8N_BASE_URL and N8N_API_KEY are required for pack wire (or use --dry-run to preview).')
    process.exit(1)
  }

  const { wirePackSheets, formatWireReport } = await import('./pack/pack-wirer.js')
  const report = await wirePackSheets(pack, sheetIds, {
    dryRun,
    ...(n8nBaseUrl ? { n8nBaseUrl } : {}),
    ...(n8nApiKey ? { n8nApiKey } : {}),
  })
  console.log(formatWireReport(report))
}

async function handleTrace(positional: string[]): Promise<void> {
  const subcommand = positional[0]
  const n8nWorkflowId = positional[1]

  if (subcommand !== 'record' || !n8nWorkflowId) {
    console.error('Usage: kairos trace record <n8n-workflow-id>')
    console.error('')
    console.error('Fetches the most recent execution of the given n8n workflow and')
    console.error('records it in the Kairos library to improve future retrieval quality.')
    console.error('Also checks for execution drift against this workflow\'s own trace')
    console.error('history and reports the slowest node from the latest run.')
    process.exit(1)
  }

  const n8nBaseUrl = process.env['N8N_BASE_URL']
  const n8nApiKey = process.env['N8N_API_KEY']
  if (!n8nBaseUrl || !n8nApiKey) {
    console.error('N8N_BASE_URL and N8N_API_KEY are required for trace record.')
    process.exit(1)
  }

  console.error(`Fetching latest execution for workflow ${n8nWorkflowId}...`)

  const { fetchLatestTrace, getSlowestNodes } = await import('./telemetry/execution-tracer.js')
  const trace = await fetchLatestTrace(n8nWorkflowId, n8nBaseUrl, n8nApiKey)

  if (!trace) {
    console.error('No executions found for this workflow, or could not reach n8n.')
    process.exit(1)
  }

  console.error(`Execution ${trace.executionId}: status=${trace.status}, nodes=${trace.executedNodes.length}, errors=${trace.erroredNodes.length}`)

  // Find matching library entry by n8nWorkflowId
  const lib = createLibrary()
  await lib.initialize()

  const all = await lib.list()
  const match = all.find(w => w.n8nWorkflowId === n8nWorkflowId)

  if (!match) {
    console.error(`No library entry found with n8nWorkflowId="${n8nWorkflowId}".`)
    console.error('Build and deploy a workflow with kairos first to create a library entry.')
    process.exit(1)
  }

  await lib.recordTrace(match.id, trace)
  console.error(`Trace recorded for "${match.description}".`)

  const { detectExecutionDrift } = await import('./telemetry/execution-drift.js')
  const updated = await lib.get(match.id)
  const traces = updated?.executionTraces ?? [trace]
  const drift = detectExecutionDrift(traces)

  const slowestNode = getSlowestNodes(trace.nodeDurations, 1)[0]

  if (drift.hasDrift) {
    console.error('')
    console.error('⚠ Execution drift detected vs. this workflow\'s own trace history:')
    if (drift.newlyErroringNodes.length > 0) console.error(`  - newly erroring: ${drift.newlyErroringNodes.join(', ')}`)
    if (drift.durationAnomaly) console.error(`  - duration anomaly: ${drift.durationAnomaly.latestMs}ms vs. historical average ${Math.round(drift.durationAnomaly.baselineAvgMs)}ms (${drift.durationAnomaly.ratio.toFixed(1)}x)`)
    if (drift.missingCoreNodes.length > 0) console.error(`  - missing nodes that always ran before: ${drift.missingCoreNodes.join(', ')}`)
    if (drift.newNodes.length > 0) console.error(`  - new nodes not seen in prior runs: ${drift.newNodes.join(', ')}`)
  }
  if (slowestNode) {
    console.error(`Slowest node this run: "${slowestNode.name}" (${slowestNode.ms}ms)`)
  }

  console.log(JSON.stringify({
    libraryId: match.id,
    workflowDescription: match.description,
    executionId: trace.executionId,
    status: trace.status,
    durationMs: trace.durationMs,
    executedNodes: trace.executedNodes.length,
    erroredNodes: trace.erroredNodes,
    nodeDurations: trace.nodeDurations,
    drift,
  }, null, 2))
}

async function handleValidatePack(positional: string[]): Promise<void> {
  const packName = positional[0]
  if (!packName) {
    console.error('Usage: kairos validate-pack <pack-name>')
    process.exit(1)
  }

  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const packPath = join(homedir(), '.kairos', 'packs', `${packName}.json`)

  let pack: import('./pack/pack-builder.js').WorkflowPackResult
  try {
    const content = await readFile(packPath, 'utf-8')
    pack = JSON.parse(content) as import('./pack/pack-builder.js').WorkflowPackResult
  } catch {
    console.error(`Pack not found: ${packPath}`)
    console.error('Run "kairos build-pack <context>" to create one.')
    process.exit(1)
  }

  const { validatePack } = await import('./pack/pack-validator.js')
  const issues = validatePack(pack)

  const packLabel = `"${packName}" (status: ${pack.status})`

  if (issues.length === 0) {
    console.log(`✓ Pack ${packLabel} passed all cross-workflow checks`)
    return
  }

  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')

  console.log(`\n${packName} — Pack Validation`)
  console.log('─'.repeat(50))
  console.log(`Status: ${pack.status}`)
  console.log(`Issues: ${errors.length} error(s), ${warnings.length} warning(s)`)
  console.log('')

  for (const issue of errors) {
    console.log(`  ✗ [error]   ${issue.message}`)
  }
  for (const issue of warnings) {
    console.log(`  ⚠ [warning] ${issue.message}`)
  }

  if (errors.length > 0) process.exit(1)
}

async function handleContractPlan(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const description = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!description || !clientId) {
    console.error('Usage: kairos contract plan "<business description>" --client-id <slug> [--json]')
    console.error('')
    console.error('Drafts a ProcessContract from a plain-language description of a business')
    console.error('promise (e.g. "every referral gets contacted within 4 business hours,')
    console.error('outcome logged, escalated after 3 failed attempts"). The draft is always run')
    console.error("through Kairos's deterministic contract validator (`kairos contract")
    console.error('validate`) before being returned. If the draft has a validation error or a')
    console.error('blocking assumption, it is still saved and shown in full -- never withheld --')
    console.error('but flagged as needing human review rather than treated as ready to use.')
    console.error('No compilation, no deployment: this only produces a reviewable draft.')
    process.exit(1)
  }

  const anthropicApiKey = getEnvOrExit('ANTHROPIC_API_KEY')

  const { planProcessContract } = await import('./promise/plan.js')
  const { loadProcessContract, amendProcessContract } = await import('./promise/store.js')

  console.error('Drafting ProcessContract...\n')
  const result = await planProcessContract({ description, clientId, anthropicApiKey })
  // P0 measurement-integrity fix (2026-07-20): checked before saving, deliberately a WARNING
  // here rather than contract import's hard refusal -- `contract plan` already always saves the
  // draft unconditionally ("never withheld", see the usage text above), so a version conflict
  // here surfaces loudly but doesn't fight that established behavior. A version collision under
  // `plan` (deriveContractId() is a name slug, version always 1 for a fresh draft) generally only
  // happens if two different business descriptions happen to produce the same contract name.
  // Roadmap item 12 (docs/plans/contract-evolution-ops-roadmap-plan.md §3, item 12): even though
  // this path always saves regardless of conflict, it now archives whatever it overwrites first,
  // same as every other save-a-contract path -- "never withheld" was never a promise that the
  // prior version would be destroyed, just that a draft wouldn't be silently dropped.
  const priorForPlan = await loadProcessContract(clientId, result.contract.id)
  const existingVersion = priorForPlan && priorForPlan.version !== result.contract.version ? priorForPlan.version : null
  const { path } = await amendProcessContract(result.contract, existingVersion !== null ? priorForPlan! : undefined, 'contract_plan')

  if (flags['json'] === true) {
    console.log(JSON.stringify({ ...result, savedTo: path, ...(existingVersion !== null ? { overwroteVersion: existingVersion } : {}) }, null, 2))
    if (!result.readyToProceed) process.exit(2)
    return
  }

  const { contract, validationIssues, readyToProceed } = result
  console.log(`\n${contract.name}`)
  console.log('─'.repeat(50))
  console.log(contract.description)
  console.log('')
  console.log(`Entity: ${contract.entity.name}`)
  console.log(`States: ${contract.states.length}   Transitions: ${contract.transitions.length}   SLAs: ${contract.sla.length}`)

  const errors = validationIssues.filter(i => i.severity === 'error')
  const warnings = validationIssues.filter(i => i.severity === 'warn')
  if (validationIssues.length > 0) {
    console.log(`\nValidator: ${errors.length} error(s), ${warnings.length} warning(s)`)
    for (const issue of errors) console.log(`  ✗ [error] [Rule ${issue.rule}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
    for (const issue of warnings) console.log(`  ⚠ [warn]  [Rule ${issue.rule}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
  } else {
    console.log('\nValidator: passed, no issues')
  }

  const blocking = contract.assumptions.filter(a => a.type === 'blocking')
  const needsConfirmation = contract.assumptions.filter(a => a.type === 'needs_confirmation')
  if (blocking.length > 0) {
    console.log(`\nBlocking Issues (resolve before this contract is usable)`)
    for (const a of blocking) console.log(`  ✗ ${a.text}`)
  }
  if (needsConfirmation.length > 0) {
    console.log(`\nNeeds Confirmation`)
    for (const a of needsConfirmation) console.log(`  ? ${a.text}`)
  }

  console.log(`\nSaved to: ${path}`)
  if (existingVersion !== null) {
    console.log(`⚠ Overwrote an existing contract at this id (was v${existingVersion}, now v${contract.version}). Ledger evidence recorded against the old version's own ids may no longer match this contract's current shape -- review before trusting historical reports.`)
  }
  console.log(readyToProceed ? '\n✓ Ready for human review -- no blocking issues.' : '\n⚠ Needs human review before this contract can be trusted.')

  if (!readyToProceed) process.exit(2)
}

async function handleContractIntake(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]

  if (subcommand === 'status') {
    await handleContractIntakeStatus(positional, flags)
    return
  }

  if (subcommand !== 'start') {
    console.error('Usage: kairos contract intake start --client-id <slug> [--context <file>] [--resume <session-id>] [--json]')
    console.error('       kairos contract intake status <session-id> --client-id <slug> [--json]')
    process.exit(1)
  }

  await handleContractIntakeStart(positional, flags)
}

/** Formats one question for the terminal, including a plain 1-of-N progress indicator when it's
 * a fixed-bank question -- never shown for a generated follow-up, since there's no fixed total
 * for those (a bounded, but not pre-known, count). */
function formatIntakeQuestionPrompt(question: import('./promise/intake-types.js').IntakeQuestion, allQuestions: import('./promise/intake-types.js').IntakeQuestion[]): string {
  const idx = allQuestions.findIndex(q => q.id === question.id)
  const label = idx >= 0 ? `[${idx + 1}/${allQuestions.length}] ` : '[follow-up] '
  return `\n${label}${question.text}\n> `
}

async function handleContractIntakeStart(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  if (!clientId) {
    console.error('Usage: kairos contract intake start --client-id <slug> [--context <file>] [--resume <session-id>] [--json]')
    console.error('')
    console.error('A guided, multi-turn interview that produces a ProcessContract draft --')
    console.error('11 focused questions (what starts it, what counts as done, branches,')
    console.error('exceptions, owners, SLAs, evidence, handoffs, missing data, duplicates, what')
    console.error('to never automate), answered interactively at the terminal, then one')
    console.error('synthesis call (same deterministic validator + human-review gate as')
    console.error('`contract plan`) drafts the contract -- with up to 2 further bounded rounds of')
    console.error('targeted follow-up questions if the draft has blocking assumptions or')
    console.error('validation errors. Saves progress after every answer -- safe to interrupt and')
    console.error('resume with --resume <session-id>. --context <file> includes a plain-text')
    console.error('file (e.g. an existing SOP snippet) verbatim as extra context for synthesis --')
    console.error('no document ingestion, chunking, or retrieval, just literal inclusion.')
    process.exit(1)
  }

  const anthropicApiKey = getEnvOrExit('ANTHROPIC_API_KEY')
  const { createIntakeSession, runIntakeToCompletion, INTAKE_QUESTIONS } = await import('./promise/intake.js')
  const { saveIntakeSession, loadIntakeSession } = await import('./promise/intake-store.js')
  const { loadProcessContract, amendProcessContract } = await import('./promise/store.js')

  const resumeId = typeof flags['resume'] === 'string' ? flags['resume'] : undefined
  let session: import('./promise/intake-types.js').IntakeSession
  if (resumeId) {
    const existing = await loadIntakeSession(clientId, resumeId)
    if (!existing) {
      console.error(`No intake session ${resumeId} found for client ${clientId}.`)
      process.exit(1)
    }
    if (existing.status !== 'in_progress') {
      console.error(`Session ${resumeId} is already ${existing.status} -- nothing to resume. Run 'kairos contract intake status ${resumeId} --client-id ${clientId}' to see it.`)
      process.exit(1)
    }
    session = existing
    console.error(`Resuming session ${session.id} (${session.turns.length} answer(s) so far)...\n`)
  } else {
    session = createIntakeSession(clientId)
    console.error(`Starting intake session ${session.id}. Ctrl-C at any time is safe -- resume later with --resume ${session.id}.\n`)
  }

  let contextText: string | undefined
  const contextPath = typeof flags['context'] === 'string' ? flags['context'] : undefined
  if (contextPath) {
    const { readFile } = await import('node:fs/promises')
    try {
      contextText = await readFile(contextPath, 'utf-8')
    } catch (err) {
      console.error(`Could not read --context file ${contextPath}: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const askQuestion = (question: import('./promise/intake-types.js').IntakeQuestion): Promise<string> =>
    new Promise<string>(resolve => rl.question(formatIntakeQuestionPrompt(question, INTAKE_QUESTIONS), resolve))

  const finalSession = await runIntakeToCompletion(
    session,
    { clientId, anthropicApiKey, ...(contextText !== undefined ? { contextText } : {}) },
    {
      askQuestion,
      persistSession: async s => {
        await saveIntakeSession(s)
      },
      onSynthesisStart: round => {
        console.error(`\nDrafting from your answers${round > 1 ? ` (refinement round ${round})` : ''}... this typically takes 60-90 seconds.\n`)
      },
    },
  )
  rl.close()

  if (!finalSession.draftContract) {
    console.error('\nIntake ended with no draft contract -- this should not happen; please report it.')
    process.exit(1)
  }

  // Roadmap item 12 (docs/plans/contract-evolution-ops-roadmap-plan.md §3, item 12): same
  // archive-before-overwrite guarantee as `contract plan`'s own save path above.
  const priorForIntake = await loadProcessContract(clientId, finalSession.draftContract.id)
  const existingVersion = priorForIntake && priorForIntake.version !== finalSession.draftContract.version ? priorForIntake.version : null
  const { path } = await amendProcessContract(finalSession.draftContract, existingVersion !== null ? priorForIntake! : undefined, 'contract_intake')

  const readyToProceed = finalSession.status === 'ready_for_review'
  const lastAttempt = finalSession.synthesisAttempts[finalSession.synthesisAttempts.length - 1]

  if (flags['json'] === true) {
    console.log(JSON.stringify({ session: finalSession, savedTo: path, ...(existingVersion !== null ? { overwroteVersion: existingVersion } : {}) }, null, 2))
    if (!readyToProceed) process.exit(2)
    return
  }

  const contract = finalSession.draftContract
  console.log(`\n${contract.name}`)
  console.log('─'.repeat(50))
  console.log(contract.description)
  console.log('')
  console.log(`Entity: ${contract.entity.name}`)
  console.log(`States: ${contract.states.length}   Transitions: ${contract.transitions.length}   SLAs: ${contract.sla.length}`)
  console.log(`Synthesis rounds: ${finalSession.synthesisAttempts.length}`)

  if (lastAttempt) {
    const errors = lastAttempt.validationIssues.filter(i => i.severity === 'error')
    const warnings = lastAttempt.validationIssues.filter(i => i.severity === 'warn')
    console.log(`\nValidator: ${errors.length} error(s), ${warnings.length} warning(s)`)
    for (const issue of errors) console.log(`  ✗ [error] [Rule ${issue.rule}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
    for (const issue of warnings) console.log(`  ⚠ [warn]  [Rule ${issue.rule}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
  }

  const blocking = contract.assumptions.filter(a => a.type === 'blocking')
  const needsConfirmation = contract.assumptions.filter(a => a.type === 'needs_confirmation')
  if (blocking.length > 0) {
    console.log(`\nBlocking Issues (resolve before this contract is usable)`)
    for (const a of blocking) console.log(`  ✗ ${a.text}`)
  }
  if (needsConfirmation.length > 0) {
    console.log(`\nNeeds Confirmation`)
    for (const a of needsConfirmation) console.log(`  ? ${a.text}`)
  }

  console.log(`\nSaved to: ${path}`)
  if (existingVersion !== null) {
    console.log(`⚠ Overwrote an existing contract at this id (was v${existingVersion}, now v${contract.version}). Ledger evidence recorded against the old version's own ids may no longer match this contract's current shape -- review before trusting historical reports.`)
  }
  console.log(readyToProceed ? '\n✓ Ready for human review -- no blocking issues.' : '\n⚠ Reached the refinement-round limit still needing review -- the draft is saved in full; resolve the issues above by hand or re-run intake with --resume.')

  if (!readyToProceed) process.exit(2)
}

async function handleContractIntakeStatus(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sessionId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  if (!sessionId || !clientId) {
    console.error('Usage: kairos contract intake status <session-id> --client-id <slug> [--json]')
    process.exit(1)
  }

  const { loadIntakeSession } = await import('./promise/intake-store.js')
  const { INTAKE_QUESTIONS } = await import('./promise/intake.js')
  const session = await loadIntakeSession(clientId, sessionId)
  if (!session) {
    console.error(`No intake session ${sessionId} found for client ${clientId}.`)
    process.exit(1)
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify(session, null, 2))
    return
  }

  console.log(`Session ${session.id} (${session.status})`)
  console.log(`Client: ${session.clientId}`)
  console.log(`Fixed questions answered: ${session.turns.filter(t => t.category !== 'follow_up').length}/${INTAKE_QUESTIONS.length}`)
  console.log(`Follow-up questions answered: ${session.turns.filter(t => t.category === 'follow_up').length}`)
  console.log(`Pending follow-up questions: ${session.pendingFollowUpQuestions.length}`)
  console.log(`Synthesis rounds so far: ${session.synthesisAttempts.length}`)
  if (session.draftContract) {
    console.log(`Current draft: "${session.draftContract.name}" (v${session.draftContract.version})`)
  }
  console.log(`Created: ${session.createdAt}`)
  console.log(`Updated: ${session.updatedAt}`)
  if (session.status === 'in_progress') {
    console.log(`\nResume with: kairos contract intake start --client-id ${clientId} --resume ${sessionId}`)
  }
}

async function readContractFile(filePath: string): Promise<import('./promise/types.js').ProcessContract> {
  const { readFile } = await import('node:fs/promises')
  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as import('./promise/types.js').ProcessContract
  } catch (err) {
    console.error(`Could not read or parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

async function handleContractScenarios(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  if (subcommand !== 'generate') {
    console.error('Usage: kairos contract scenarios generate <file.json> [--categories <list>] [--out <dir>] [--json]')
    console.error('')
    console.error('Deterministically generates synthetic ContractScenarios from a valid')
    console.error('ProcessContract -- no LLM call. Categories: happy_path, missing_data,')
    console.error('failure_terminal, no_response, duplicate_correlation, after_hours,')
    console.error('in_progress (default: all). A category is skipped, with a stated reason,')
    console.error('rather than faked when the contract cannot support it (e.g. no')
    console.error('EvidenceRequirement covers any transition into a success terminal outcome).')
    process.exit(1)
  }

  const filePath = positional[1]
  if (!filePath) {
    console.error('Usage: kairos contract scenarios generate <file.json> [--categories <list>] [--out <dir>] [--json]')
    process.exit(1)
  }

  const contract = await readContractFile(filePath)
  const { generateContractScenarios, ALL_SCENARIO_CATEGORIES } = await import('./promise/scenario.js')

  let categories = ALL_SCENARIO_CATEGORIES
  const categoriesFlag = typeof flags['categories'] === 'string' ? flags['categories'] : undefined
  if (categoriesFlag) {
    const requested = categoriesFlag.split(',').map(c => c.trim())
    const invalid = requested.filter(c => !(ALL_SCENARIO_CATEGORIES as string[]).includes(c))
    if (invalid.length > 0) {
      console.error(`Unknown categor${invalid.length === 1 ? 'y' : 'ies'}: ${invalid.join(', ')}. Valid: ${ALL_SCENARIO_CATEGORIES.join(', ')}`)
      process.exit(1)
    }
    categories = requested as typeof ALL_SCENARIO_CATEGORIES
  }

  const { scenarios, skipped } = generateContractScenarios(contract, categories)

  const outDir = typeof flags['out'] === 'string' ? flags['out'] : undefined
  const written: string[] = []
  if (outDir) {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(outDir, { recursive: true })
    for (const s of scenarios) {
      const path = join(outDir, `${s.id}.json`)
      await writeFile(path, JSON.stringify(s, null, 2) + '\n', 'utf-8')
      written.push(path)
    }
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify({ scenarios, skipped, ...(outDir ? { writtenTo: written } : {}) }, null, 2))
    return
  }

  console.log(`\n${contract.name} — Generated Scenarios (${scenarios.length}, ${skipped.length} skipped)`)
  console.log('─'.repeat(50))
  for (const s of scenarios) {
    console.log(`\n  [${s.category}] ${s.name}`)
    console.log(`    ${s.description}`)
    console.log(`    Expected: ${s.expected.reportStatus}${s.expected.evidenceQuality ? ` (${s.expected.evidenceQuality})` : ''}, ${s.expected.expectedExceptionCount} exception(s)${s.expected.expectedExceptionKinds?.length ? ` [${s.expected.expectedExceptionKinds.join(', ')}]` : ''}`)
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped`)
    for (const sk of skipped) console.log(`  [${sk.category}] ${sk.reason}`)
  }
  if (written.length > 0) {
    console.log(`\nWrote ${written.length} scenario file(s) to ${outDir}`)
  }
}

async function loadScenariosFromPath(path: string): Promise<import('./promise/scenario-types.js').ContractScenario[]> {
  const { readFile, readdir, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const stats = await stat(path)
  if (stats.isDirectory()) {
    const files = (await readdir(path)).filter(f => f.endsWith('.json'))
    const scenarios: import('./promise/scenario-types.js').ContractScenario[] = []
    for (const f of files) {
      scenarios.push(JSON.parse(await readFile(join(path, f), 'utf-8')))
    }
    return scenarios
  }

  const content = JSON.parse(await readFile(path, 'utf-8'))
  return Array.isArray(content) ? content : [content]
}

async function handleContractHarness(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  if (subcommand !== 'run') {
    console.error('Usage: kairos contract harness run <file.json> [--scenarios <dir-or-file>] [--json]')
    console.error('')
    console.error('Runs ContractScenarios through the REAL checkSlaCompliance()/')
    console.error('updateExceptionDesk()/classifyPromiseInstance() functions -- purely')
    console.error('in-memory, no n8n, no network, no LLM call. Without --scenarios, generates')
    console.error('scenarios for every category first (same as "contract scenarios generate").')
    console.error('Exits 1 if any scenario fails to match its own expected outcome.')
    process.exit(1)
  }

  const filePath = positional[1]
  if (!filePath) {
    console.error('Usage: kairos contract harness run <file.json> [--scenarios <dir-or-file>] [--json]')
    process.exit(1)
  }

  const contract = await readContractFile(filePath)
  const { runContractHarness } = await import('./promise/harness.js')

  let scenarios: import('./promise/scenario-types.js').ContractScenario[]
  let skipped: import('./promise/scenario-types.js').ScenarioGenerationSkip[] = []
  const scenariosPath = typeof flags['scenarios'] === 'string' ? flags['scenarios'] : undefined
  if (scenariosPath) {
    scenarios = await loadScenariosFromPath(scenariosPath)
  } else {
    const { generateContractScenarios } = await import('./promise/scenario.js')
    const generated = generateContractScenarios(contract)
    scenarios = generated.scenarios
    skipped = generated.skipped
  }

  const result = runContractHarness(contract, scenarios)

  if (flags['json'] === true) {
    console.log(JSON.stringify({ ...result, skipped }, null, 2))
    if (result.failCount > 0) process.exit(1)
    return
  }

  console.log(`\n${contract.name} — Contract Harness (${result.passCount} passed, ${result.failCount} failed)`)
  console.log('─'.repeat(50))
  for (const r of result.scenarioResults) {
    console.log(`\n  [${r.passed ? '✓' : '✗'}] [${r.category}] ${r.scenarioName}`)
    if (!r.passed) {
      for (const m of r.mismatches) console.log(`      MISMATCH: ${m}`)
    }
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped (not run)`)
    for (const sk of skipped) console.log(`  [${sk.category}] ${sk.reason}`)
  }

  if (result.failCount > 0) process.exit(1)
}

async function handleContractCompile(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const filePath = positional[1]
  if (!filePath) {
    console.error('Usage: kairos contract compile <file.json> [--build] [--dry-run] [--activate] [--yes] [--despite-blocking] [--confirm-registration-drop] [--json]')
    console.error('')
    console.error('Compiles a valid ProcessContract into a PackPlan -- deterministic, no LLM call')
    console.error('in this step. Without --build, only prints the compiled plan and its')
    console.error('per-workflow traceability back to contract element ids. With --build, feeds')
    console.error('the plan into the exact same PackBuilder.build()/Kairos.build() machinery')
    console.error('`kairos build-pack` uses -- full generation, validation, and (unless')
    console.error('--dry-run) deployment. Refuses to compile at all -- exit 2, no plan produced')
    console.error('-- if the contract fails validation or still has a blocking assumption.')
    console.error('This step does not attempt to prove the built workflows fulfill the contract')
    console.error('at runtime -- that is ProofLedger and, later, the Replay Upgrade.')
    console.error('A real (non-dry-run) build with at least one deployed workflow also runs')
    console.error('Contract Compiler Verification (roadmap item 10): fetches each deployed')
    console.error('workflow back from n8n and statically checks it contains an evidence node for')
    console.error('every EvidenceRequirement, the correlation key referenced, and every start')
    console.error('condition covered -- structural presence only, never a runtime-correctness')
    console.error('proof. A gap here means ProofLedger would silently never see that evidence;')
    console.error('surfaced loudly (exit 2) but never blocks registration itself.')
    console.error('A real (non-dry-run) rebuild that would silently stop tracking a previously')
    console.error('registered workflow (e.g. one generation failure among several) refuses (exit 2)')
    console.error('to save the new registration -- the previous one keeps being polled -- unless')
    console.error('--confirm-registration-drop is passed.')
    process.exit(1)
  }

  const { readFile } = await import('node:fs/promises')
  let contract: import('./promise/types.js').ProcessContract
  try {
    const content = await readFile(filePath, 'utf-8')
    contract = JSON.parse(content) as import('./promise/types.js').ProcessContract
  } catch (err) {
    console.error(`Could not read or parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const { compileToPackPlan } = await import('./promise/compile.js')
  const result = compileToPackPlan(contract)

  if (result.escalation) {
    if (flags['json'] === true) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      const label = result.escalation.source === 'validation_errors' ? 'validation errors' : 'blocking assumptions'
      console.log(`\n⚠ Compilation refused -- ${label}`)
      console.log('─'.repeat(50))
      console.log(result.escalation.reason)
      console.log('')
      for (const q of result.escalation.questions) console.log(`  - ${q}`)
    }
    process.exit(2)
  }

  if (flags['build'] !== true) {
    if (flags['json'] === true) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log(`\n${contract.name} — Compiled PackPlan (${result.plan.workflows.length} workflow(s))`)
    console.log('─'.repeat(50))
    for (let i = 0; i < result.plan.workflows.length; i++) {
      const wf = result.plan.workflows[i]!
      const trace = result.traceability[i]!
      console.log(`\n  ${i + 1}. ${wf.name}`)
      console.log(`     ${wf.purpose}`)
      console.log(`     Trace: ${trace.sourceElements.join(', ')}`)
    }
    const needsConfirmation = result.plan.assumptions.filter(a => a.type === 'needs_confirmation')
    if (needsConfirmation.length > 0) {
      console.log(`\nNeeds Confirmation`)
      for (const a of needsConfirmation) console.log(`  ? ${a.text}`)
    }
    console.log('\nRun again with --build to generate these workflows via the real kairos build machinery (add --dry-run to skip deployment).')
    return
  }

  const anthropicKey = getEnvOrExit('ANTHROPIC_API_KEY')
  const { PackBuilder } = await import('./pack/pack-builder.js')
  const isDryRun = flags['dry-run'] === true
  const kairos = isDryRun ? await createDryRunClient() : await createClient()
  const builder = new PackBuilder({ anthropicApiKey: anthropicKey, kairos })

  console.error(`\n${contract.name} — Compiled Workflows (${result.plan.workflows.length})\n`)
  for (let i = 0; i < result.plan.workflows.length; i++) {
    const wf = result.plan.workflows[i]!
    console.error(`  ${i + 1}. ${wf.name}`)
    console.error(`     ${wf.purpose}`)
  }

  const needsConfirmation = result.plan.assumptions.filter(a => a.type === 'needs_confirmation')
  if (needsConfirmation.length > 0) {
    console.error(`\nNeeds Confirmation`)
    for (const a of needsConfirmation) console.error(`  ? ${a.text}`)
  }

  if (flags['yes'] !== true) {
    const readline = await import('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>(resolve => rl.question('\nBuild all of these? [y/N] ', resolve))
    rl.close()
    if (!answer.toLowerCase().startsWith('y')) {
      console.error('Aborted.')
      process.exit(0)
    }
  }

  console.error('\nBuilding...\n')
  const buildResult = await builder.build(result.plan, {
    dryRun: isDryRun,
    activate: flags['activate'] === true,
    buildDespiteBlocking: flags['despite-blocking'] === true,
    onProgress: (wf, i, total) => {
      console.error(`  [${i + 1}/${total}] ${wf.name}...`)
    },
  })

  if (flags['json'] === true) {
    console.log(JSON.stringify({ ...buildResult, traceability: result.traceability }, null, 2))
  } else {
    printPackResult(buildResult)
  }

  const { writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const packsDir = join(homedir(), '.kairos', 'packs')
  await mkdir(packsDir, { recursive: true })
  const packPath = join(packsDir, `${buildResult.packName}.json`)
  await writeFile(packPath, JSON.stringify(buildResult, null, 2), 'utf-8')
  console.error(`\nPack saved to: ${packPath}`)

  // Real deployed workflow ids only exist once built for real -- a dry run never has anything
  // to register, and a blocked build (escalation) never built anything either. Without this
  // registration, `kairos ledger poll` has no way to know which n8n workflow ids implement this
  // contract at all (the Phase 3 design spike's own named gap, plan doc §6.0).
  let compilerVerificationHasGaps = false
  if (!isDryRun && !buildResult.escalation) {
    const registeredAt = new Date().toISOString()
    const registeredWorkflows = buildResult.workflows
      .filter((w): w is typeof w & { workflowId: string } => w.workflowId !== null && !w.error)
      .map(w => ({
        n8nWorkflowId: w.workflowId,
        workflowName: w.name,
        sourceElements: result.traceability.find(t => t.workflowName === w.name)?.sourceElements ?? [],
        contractVersion: contract.version,
        status: 'active' as const,
        registeredAt,
      }))

    if (registeredWorkflows.length > 0) {
      // Contract Compiler Verification (roadmap item 10, docs/plans/intake-scenario-harness-plan.md
      // §10): fetches each just-deployed workflow's REAL JSON back from n8n (read-only GET) and
      // statically checks it against the contract's own requirements -- an evidence node for every
      // EvidenceRequirement, the correlation key referenced somewhere, every StartCondition
      // covered. A real gap here means ProofLedger will silently never see evidence for that
      // transition; surfaced loudly, but never blocks registration itself -- the deployed
      // workflows and this registration are both still real and correct, and refusing to track
      // them at all would throw away visibility into every OTHER evidence requirement that IS
      // correctly wired. Sets the command's own exit code at the very end instead.
      const n8nBaseUrl = getEnvOrExit('N8N_BASE_URL')
      const n8nApiKey = getEnvOrExit('N8N_API_KEY')
      const { N8nApiClient } = await import('./providers/n8n/api-client.js')
      const { verifyCompiledWorkflows } = await import('./promise/compiler-verify.js')
      const apiClient = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)

      const fetchedWorkflows: import('./promise/compiler-verify.js').CompiledWorkflowForVerification[] = []
      const fetchErrors: string[] = []
      for (const w of registeredWorkflows) {
        try {
          const real = await apiClient.getWorkflow(w.n8nWorkflowId)
          fetchedWorkflows.push({ workflowName: w.workflowName, workflow: { nodes: real.nodes } })
        } catch (err) {
          fetchErrors.push(`"${w.workflowName}" (${w.n8nWorkflowId}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const verification = verifyCompiledWorkflows(contract, fetchedWorkflows, result.traceability)
      compilerVerificationHasGaps = verification.verdict === 'gaps_found'

      if (flags['json'] === true) {
        console.log(JSON.stringify({ compilerVerification: verification, fetchErrors }, null, 2))
      } else {
        if (fetchErrors.length > 0) {
          console.error(`\n⚠ Could not fetch ${fetchErrors.length} workflow(s) back from n8n to verify -- skipped, not counted as a gap:`)
          for (const e of fetchErrors) console.error(`  - ${e}`)
        }
        if (compilerVerificationHasGaps) {
          console.error(`\n✗ Contract compiler verification found ${verification.findings.length} gap(s) -- ProofLedger may silently never see some evidence:`)
          for (const f of verification.findings) console.error(`  [${f.severity}] ${f.contractElement}: ${f.message}`)
        } else {
          console.error(`\n✓ Contract compiler verification: every evidence node, the correlation key, and every start condition are structurally present in the deployed workflows.`)
          console.error(`  (Structural presence only -- this does not prove the wiring behaves correctly at runtime. See "kairos ledger poll" and, later, the Replay Upgrade for that.)`)
        }
      }

      const { loadContractWorkflowRegistration, saveContractWorkflowRegistration, computeDroppedWorkflows } = await import('./promise/registry.js')
      // Finding 2 fix (supplemental measurement-integrity audit, 2026-07-20), narrowed by
      // roadmap item 12 (docs/plans/contract-evolution-ops-roadmap-plan.md §3, item 12):
      // registration is now append-only (registry.ts's own doc comment), so a "dropped"
      // workflow name is never silently lost from tracking anymore -- this gate now means "this
      // rebuild no longer produces a workflow name that's currently active; confirm that's
      // intentional before those old entries are marked retired." Only compares against
      // currently-active entries -- an already-retired entry from an earlier amendment is
      // expected to stay missing from a fresh compile and must not re-trigger this gate forever.
      const existing = await loadContractWorkflowRegistration(contract.clientId, contract.id)
      const activeExisting = (existing?.workflows ?? []).filter(w => w.status === 'active')
      const dropped = computeDroppedWorkflows(activeExisting, new Set(registeredWorkflows.map(w => w.workflowName)))

      if (dropped.length > 0 && flags['confirm-registration-drop'] !== true) {
        if (flags['json'] === true) {
          console.log(JSON.stringify({ ...buildResult, traceability: result.traceability, registrationRefused: true, droppedWorkflows: dropped.map(w => w.workflowName) }, null, 2))
        } else {
          console.error(`\n✗ Refusing to save workflow registration -- this rebuild no longer produces ${dropped.length} currently-active previously-registered workflow(s):`)
          for (const w of dropped) console.error(`  - "${w.workflowName}" (was: ${w.n8nWorkflowId})`)
          console.error(`\nThe pack itself was built successfully above -- only the registration write is refused, so "kairos ledger poll"/"kairos contract report" keep polling the PREVIOUS workflow(s) for ${dropped.length === 1 ? 'this name' : 'these names'} until you decide (nothing is ever silently un-polled -- registration is append-only).`)
          console.error(`Re-run with --confirm-registration-drop to mark ${dropped.length === 1 ? 'it' : 'them'} retired -- their history stays in the registration file, just no longer polled.`)
        }
        process.exit(2)
      }

      // Confirmed drops are marked retired, not deleted -- registration is append-only, so this
      // is the one place `status` ever transitions away from 'active' in this v0 (no separate
      // retire command exists yet). The retired entries are included in the write so the merge
      // in saveContractWorkflowRegistration() actually updates their status, not just leaves
      // them untouched at 'active'.
      const retiredEntries = dropped.map(w => ({ ...w, status: 'retired' as const }))

      const { path: registrationPath } = await saveContractWorkflowRegistration({
        contractId: contract.id,
        contractVersion: contract.version,
        clientId: contract.clientId,
        workflows: [...registeredWorkflows, ...retiredEntries],
        registeredAt,
      })
      console.error(`Registered ${registeredWorkflows.length} workflow(s) for evidence polling ("kairos ledger poll"): ${registrationPath}`)
      if (dropped.length > 0) {
        console.error(`⚠ Marked ${dropped.length} previously-registered workflow(s) retired (--confirm-registration-drop was passed): ${dropped.map(w => w.workflowName).join(', ')} -- no longer polled, but still present in the registration file's own history.`)
      }
    }
  }

  if (buildResult.escalation) process.exit(2)
  if (compilerVerificationHasGaps) process.exit(2)
}

/**
 * Closes a real gap found during the Promise Engine v0 closeout pass: `kairos contract compile
 * <file.json>` only ever reads a file, it never saves the contract anywhere -- only
 * `kairos contract plan` does that. A hand-authored or externally-sourced contract, compiled and
 * built directly from a file, therefore had no path into `kairos ledger poll`/`watch --contracts`/
 * `contract report` afterward (all three load a saved contract by client id + contract id, and
 * none existed). Deliberately a separate command, not a `compile --save` flag (Codex's own
 * preference, 2026-07-20): compiling and persisting are two different concerns, and a dedicated
 * `import` makes it obvious a file is being adopted into the local store, not silently mutating
 * disk as a side effect of an otherwise-read-only compile step.
 */
async function handleContractImport(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const filePath = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!filePath || !clientId) {
    console.error('Usage: kairos contract import <file.json> --client-id <slug> [--confirm-version-change] [--json]')
    console.error('')
    console.error('Saves a valid ProcessContract file into the local store')
    console.error('(~/.kairos/contracts/<client-id>/<id>.json) so kairos ledger poll,')
    console.error('kairos watch --contracts, and kairos contract report can find it afterward --')
    console.error('kairos contract compile only ever reads a file, it never saves one. Always')
    console.error('runs the deterministic validator first; refuses to import at all (exit 2,')
    console.error('nothing written) on a validation error or a blocking assumption, the same gate')
    console.error('kairos contract compile itself uses. Contract provenance/version/status are')
    console.error('preserved exactly as given -- never rewritten, never bumped -- importing is not')
    console.error('authoring. Also refuses (exit 2, nothing written) if a contract already exists')
    console.error('at this id with a DIFFERENT version -- pass --confirm-version-change to proceed;')
    console.error('the prior version is archived first (kairos contract versions/diff can still')
    console.error('read it), never destroyed, but ProofLedger evidence recorded against its own')
    console.error('state/transition/SLA ids may no longer match the newly-imported shape. For a')
    console.error('reviewed diff before writing anything, use "kairos contract amend" instead.')
    process.exit(1)
  }

  const { readFile } = await import('node:fs/promises')
  let contract: import('./promise/types.js').ProcessContract
  try {
    const content = await readFile(filePath, 'utf-8')
    contract = JSON.parse(content) as import('./promise/types.js').ProcessContract
  } catch (err) {
    console.error(`Could not read or parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (contract.clientId !== clientId) {
    console.error(`Refusing to import: this contract's own clientId is "${contract.clientId}", not "${clientId}" -- --client-id must match exactly, so a contract can never be silently imported into the wrong client's namespace.`)
    process.exit(1)
  }

  const { validateProcessContract } = await import('./promise/validate.js')
  const issues = validateProcessContract(contract)
  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warn')
  const blocking = contract.assumptions.filter(a => a.type === 'blocking')

  if (errors.length > 0 || blocking.length > 0) {
    if (flags['json'] === true) {
      console.log(JSON.stringify({ imported: false, validationIssues: issues, blockingAssumptions: blocking }, null, 2))
      process.exit(2)
    }
    console.error(`\nRefusing to import "${filePath}" -- nothing written.`)
    if (errors.length > 0) {
      console.error(`\nValidation errors:`)
      for (const e of errors) console.error(`  ✗ [Rule ${e.rule}] ${e.message}${e.path ? ` (${e.path})` : ''}`)
    }
    if (blocking.length > 0) {
      console.error(`\nBlocking assumptions:`)
      for (const a of blocking) console.error(`  ✗ ${a.text}`)
    }
    process.exit(2)
  }

  const { loadProcessContract, amendProcessContract } = await import('./promise/store.js')
  const existing = await loadProcessContract(clientId, contract.id)
  const existingVersion = existing && existing.version !== contract.version ? existing.version : null
  if (existingVersion !== null && flags['confirm-version-change'] !== true) {
    if (flags['json'] === true) {
      console.log(JSON.stringify({ imported: false, versionConflict: { existingVersion, attemptedVersion: contract.version } }, null, 2))
      process.exit(2)
    }
    console.error(`\nRefusing to import "${filePath}" -- nothing written.`)
    console.error(`A contract with id "${contract.id}" already exists at version ${existingVersion}, but this file is version ${contract.version}.`)
    console.error(`Overwriting it would silently orphan any ProofLedger evidence recorded against the old version's own state/transition/SLA ids --`)
    console.error(`stateReachSignals() would simply stop matching those ids against the new contract shape.`)
    console.error(`Re-run with --confirm-version-change if you understand this and want to proceed anyway (the old version is archived first, never destroyed).`)
    process.exit(2)
  }

  // Roadmap item 12 (docs/plans/contract-evolution-ops-roadmap-plan.md §3, item 12): routes
  // through the same archive-before-overwrite primitive `kairos contract amend --confirm` uses,
  // so import never destroys a prior version either -- the gap this whole item exists to close
  // applies to both call sites, not just the new one.
  const { path } = await amendProcessContract(contract, existingVersion !== null ? existing! : undefined, 'contract_import')

  if (flags['json'] === true) {
    console.log(JSON.stringify({ imported: true, path, validationIssues: issues, ...(existingVersion !== null ? { overwroteVersion: existingVersion } : {}) }, null, 2))
    return
  }

  console.log(`✓ Imported "${contract.name}" (${contract.id} v${contract.version}) to: ${path}`)
  if (existingVersion !== null) {
    console.log(`⚠ Archived the prior version (v${existingVersion}, --confirm-version-change was passed) and overwrote the live contract. Ledger evidence recorded against the old version's own ids may no longer match this contract's current shape -- run "kairos contract versions ${contract.id} --client-id ${clientId}" to see it, or "kairos contract diff" to compare.`)
  }
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of warnings) console.log(`  ⚠ [Rule ${w.rule}] ${w.message}${w.path ? ` (${w.path})` : ''}`)
  }
  const needsConfirmation = contract.assumptions.filter(a => a.type === 'needs_confirmation')
  if (needsConfirmation.length > 0) {
    console.log(`\nNeeds Confirmation:`)
    for (const a of needsConfirmation) console.log(`  ? ${a.text}`)
  }
  console.log(`\nRun "kairos contract compile ${filePath} --build" to generate and register its workflows.`)
}

async function handleContractVersions(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!contractId || !clientId) {
    console.error('Usage: kairos contract versions <contract-id> --client-id <slug> [--json]')
    console.error('')
    console.error('Lists every archived (superseded) version of a saved contract, newest first,')
    console.error('plus the current live version. Empty archive list is normal for a contract')
    console.error('that has never been amended/re-imported over a different version.')
    process.exit(1)
  }

  const { loadProcessContract, listContractVersions } = await import('./promise/store.js')
  const live = await loadProcessContract(clientId, contractId)
  if (!live) {
    console.error(`No ProcessContract found for client "${clientId}" with id "${contractId}".`)
    process.exit(1)
  }
  const archived = await listContractVersions(clientId, contractId)

  if (flags['json'] === true) {
    console.log(JSON.stringify({ liveVersion: live.version, archived }, null, 2))
    return
  }

  console.log(`${live.name} (${contractId}) — Version History`)
  console.log('─'.repeat(50))
  console.log(`  v${live.version}  (live)`)
  for (const record of archived) {
    console.log(`  v${record.contract.version}  superseded ${record.supersededAt} (${record.supersededBy})`)
  }
  if (archived.length === 0) {
    console.log('\n(No archived versions -- this contract has never been amended/re-imported over a different version.)')
  } else {
    console.log(`\nRun "kairos contract diff ${contractId} --client-id ${clientId} --from <v> --to <v>" to compare any two.`)
  }
}

/** Resolves a specific version number to a real ProcessContract -- either the live one (if `v`
 * matches its own version) or an archived one. Shared by diff/amend so both commands resolve
 * versions identically rather than two subtly different lookup paths. */
async function resolveContractVersion(clientId: string, contractId: string, version: number): Promise<import('./promise/types.js').ProcessContract | null> {
  const { loadProcessContract, loadContractVersion } = await import('./promise/store.js')
  const live = await loadProcessContract(clientId, contractId)
  if (live && live.version === version) return live
  return loadContractVersion(clientId, contractId, version)
}

function printContractDiff(diff: import('./promise/diff-types.js').ContractDiff): void {
  console.log(`Diff: v${diff.fromVersion} -> v${diff.toVersion}`)
  console.log('─'.repeat(50))
  if (diff.changes.length === 0) {
    console.log('(No differences.)')
    return
  }
  for (const c of diff.changes) {
    const icon = c.breaking ? '✗ BREAKING' : '  compatible'
    console.log(`  [${icon}] ${c.changeType} ${c.path}`)
    console.log(`      ${c.reason}`)
  }
  console.log('')
  console.log(diff.hasBreakingChanges
    ? `${diff.changes.filter(c => c.breaking).length} of ${diff.changes.length} change(s) are BREAKING -- existing ProofLedger/ExceptionDesk evidence recorded under v${diff.fromVersion} may be misinterpreted against v${diff.toVersion}'s shape for the affected ids.`
    : `All ${diff.changes.length} change(s) are compatible -- existing evidence should still be correctly interpreted under the new version.`)
}

async function handleContractDiff(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  const fromRaw = typeof flags['from'] === 'string' ? flags['from'] : undefined
  const toRaw = typeof flags['to'] === 'string' ? flags['to'] : undefined

  if (!contractId || !clientId || !fromRaw || !toRaw) {
    console.error('Usage: kairos contract diff <contract-id> --client-id <slug> --from <v> --to <v> [--json]')
    console.error('')
    console.error('Pure, offline structural diff between two versions of a saved contract (the')
    console.error('live version, or any archived one from "kairos contract versions"). Classifies')
    console.error('each change as breaking (could cause existing ProofLedger/ExceptionDesk')
    console.error('evidence to be misinterpreted against the new shape) or compatible -- see')
    console.error('src/promise/diff.ts\'s own doc comment for the full field-by-field rule.')
    console.error('Never writes anything.')
    process.exit(1)
  }

  const fromVersion = parseInt(fromRaw, 10)
  const toVersion = parseInt(toRaw, 10)
  const [from, to] = await Promise.all([
    resolveContractVersion(clientId, contractId, fromVersion),
    resolveContractVersion(clientId, contractId, toVersion),
  ])
  if (!from) {
    console.error(`No version ${fromVersion} found for contract "${contractId}" (client "${clientId}") -- neither live nor archived.`)
    process.exit(1)
  }
  if (!to) {
    console.error(`No version ${toVersion} found for contract "${contractId}" (client "${clientId}") -- neither live nor archived.`)
    process.exit(1)
  }

  const { diffProcessContracts } = await import('./promise/diff.js')
  const diff = diffProcessContracts(from, to)

  if (flags['json'] === true) {
    console.log(JSON.stringify(diff, null, 2))
    return
  }
  printContractDiff(diff)
}

async function handleContractAmend(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  const newFile = typeof flags['new'] === 'string' ? flags['new'] : undefined

  if (!contractId || !clientId || !newFile) {
    console.error('Usage: kairos contract amend <contract-id> --client-id <slug> --new <file.json> [--confirm] [--confirm-breaking-with-active-instances] [--from-proposal <proposal-id>] [--json]')
    console.error('')
    console.error('Without --confirm (the default): validates the new contract, shows the diff')
    console.error('against the current live version and its breaking/compatible classification,')
    console.error('and writes nothing -- a preview, same posture as "contract compile" without')
    console.error('--build.')
    console.error('')
    console.error('With --confirm: also archives the current version (never destroyed -- see')
    console.error('"kairos contract versions") and saves the new one as live. Refuses (exit 2,')
    console.error('nothing written) if the new contract fails validation or has a blocking')
    console.error('assumption (same gate as "contract import"), OR if the diff has any breaking')
    console.error('change while this contract currently has any in_progress promise instance --')
    console.error('pass --confirm-breaking-with-active-instances too if you understand an')
    console.error('in-flight instance\'s evidence may be misinterpreted against the new shape and')
    console.error('want to proceed anyway.')
    console.error('')
    console.error('--from-proposal <proposal-id> links this amendment back to a Contract Evolution')
    console.error('proposal (kairos contract evolve) once it succeeds -- marks that proposal')
    console.error('\'applied\' with the resulting version. The proposal never causes the amendment;')
    console.error('you always still hand-author the new contract file yourself, since this v0')
    console.error('never infers a specific replacement value.')
    console.error('')
    console.error('Never recompiles or redeploys anything -- run')
    console.error('"kairos contract compile <file.json> --build" yourself afterward.')
    process.exit(1)
  }

  const { readFile } = await import('node:fs/promises')
  let next: import('./promise/types.js').ProcessContract
  try {
    const content = await readFile(newFile, 'utf-8')
    next = JSON.parse(content) as import('./promise/types.js').ProcessContract
  } catch (err) {
    console.error(`Could not read or parse ${newFile}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (next.clientId !== clientId) {
    console.error(`Refusing to amend: the new contract's own clientId is "${next.clientId}", not "${clientId}" -- --client-id must match exactly.`)
    process.exit(1)
  }
  if (next.id !== contractId) {
    console.error(`Refusing to amend: the new contract's own id is "${next.id}", not "${contractId}" -- an amendment must keep the same contract id (a different id is a new contract, not an amendment of this one).`)
    process.exit(1)
  }

  const { loadProcessContract, amendProcessContract } = await import('./promise/store.js')
  const current = await loadProcessContract(clientId, contractId)
  if (!current) {
    console.error(`No existing ProcessContract found for client "${clientId}" with id "${contractId}" -- nothing to amend. Use "kairos contract import" for a first import.`)
    process.exit(1)
  }
  if (current.version === next.version) {
    console.error(`Refusing to amend: the new contract's version (${next.version}) is the same as the current live version -- bump ProcessContract.version in the new file first, so this amendment is distinguishable from the version it supersedes.`)
    process.exit(1)
  }

  const { validateProcessContract } = await import('./promise/validate.js')
  const issues = validateProcessContract(next)
  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warn')
  const blocking = next.assumptions.filter(a => a.type === 'blocking')

  if (errors.length > 0 || blocking.length > 0) {
    if (flags['json'] === true) {
      console.log(JSON.stringify({ amended: false, validationIssues: issues, blockingAssumptions: blocking }, null, 2))
      process.exit(2)
    }
    console.error(`\nRefusing to amend "${contractId}" -- nothing written.`)
    if (errors.length > 0) {
      console.error(`\nValidation errors:`)
      for (const e of errors) console.error(`  ✗ [Rule ${e.rule}] ${e.message}${e.path ? ` (${e.path})` : ''}`)
    }
    if (blocking.length > 0) {
      console.error(`\nBlocking assumptions:`)
      for (const a of blocking) console.error(`  ✗ ${a.text}`)
    }
    process.exit(2)
  }

  const { diffProcessContracts } = await import('./promise/diff.js')
  const diff = diffProcessContracts(current, next)

  const confirm = flags['confirm'] === true
  if (!confirm) {
    if (flags['json'] === true) {
      console.log(JSON.stringify({ amended: false, preview: true, diff, validationIssues: issues }, null, 2))
      return
    }
    printContractDiff(diff)
    console.log(`\n(Preview only -- nothing written. Re-run with --confirm to apply.)`)
    return
  }

  // Active-instance version pinning (roadmap item 12, docs/plans/
  // contract-evolution-ops-roadmap-plan.md §3, item 12, design-verification note resolved
  // before implementation): a breaking amendment is refused by default while any promise
  // instance is still in_progress, since checkSlaCompliance()/classifyPromiseInstance() have no
  // version-cohort logic (they match every entry against ONE current contract shape) -- an
  // in-flight instance's already-recorded evidence could be silently reinterpreted against ids
  // that now mean something structurally different. Reuses only already-shipped, read-only
  // functions; does not touch sla-compliance.ts/report.ts at all.
  if (diff.hasBreakingChanges && flags['confirm-breaking-with-active-instances'] !== true) {
    const { getProofLedgerEntries } = await import('./promise/ledger-store.js')
    const { loadExceptionDeskItems } = await import('./promise/exception-store.js')
    const { buildPromiseReportData } = await import('./promise/report.js')
    const entries = await getProofLedgerEntries(clientId, contractId, 10000)
    const exceptions = await loadExceptionDeskItems(clientId, contractId)
    const reportData = buildPromiseReportData(current, entries, exceptions)
    const inProgressCount = reportData.instanceCounts.in_progress

    if (inProgressCount > 0) {
      if (flags['json'] === true) {
        console.log(JSON.stringify({ amended: false, refusedBreakingWithActiveInstances: true, inProgressCount, diff }, null, 2))
        process.exit(2)
      }
      console.error(`\nRefusing to amend "${contractId}" -- nothing written.`)
      console.error(`This amendment has ${diff.changes.filter(c => c.breaking).length} breaking change(s), and ${inProgressCount} promise instance(s) are currently in_progress under the CURRENT version.`)
      console.error(`Their already-recorded evidence may be misinterpreted against the new contract shape for the affected ids -- see the diff above for exactly which ones.`)
      console.error(`Either wait for those instances to reach a terminal outcome, or re-run with --confirm --confirm-breaking-with-active-instances if you understand the risk and want to proceed anyway.`)
      process.exit(2)
    }
  }

  const { path, archivedVersion } = await amendProcessContract(next, current, 'contract_amend')

  // Roadmap item 11 (docs/plans/contract-evolution-ops-roadmap-plan.md §3, item 11): the bridge
  // back from a Contract Evolution proposal to the real amendment that acted on it -- "Accepted
  // proposals should flow through the amendment/diff gate," Codex's own explicit requirement.
  // Never the other direction: a proposal never causes an amendment by itself, this only ever
  // records that one already happened, after the fact, once this command's own gates above have
  // already passed.
  const fromProposal = typeof flags['from-proposal'] === 'string' ? flags['from-proposal'] : undefined
  let updatedProposal: import('./promise/evolution-types.js').ContractAmendmentProposal | null = null
  if (fromProposal) {
    const { updateProposalStatus } = await import('./promise/evolution-store.js')
    updatedProposal = await updateProposalStatus(clientId, contractId, fromProposal, 'applied', undefined, next.version)
    if (!updatedProposal) {
      console.error(`⚠ --from-proposal "${fromProposal}" does not match any stored proposal for this contract -- the amendment above still succeeded and was NOT rolled back, but no proposal record was linked to it. Check the proposal id with "kairos contract evolve list".`)
    }
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify({ amended: true, path, archivedVersion, diff, ...(fromProposal ? { linkedProposal: updatedProposal } : {}) }, null, 2))
    return
  }
  printContractDiff(diff)
  console.log(`\n✓ Amended "${next.name}" (${contractId}): v${archivedVersion} archived, v${next.version} is now live. Path: ${path}`)
  if (updatedProposal) {
    console.log(`✓ Proposal "${fromProposal}" marked applied -> v${next.version}.`)
  }
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of warnings) console.log(`  ⚠ [Rule ${w.rule}] ${w.message}${w.path ? ` (${w.path})` : ''}`)
  }
  console.log(`\nNothing was recompiled or redeployed. Run "kairos contract compile ${newFile} --build" to generate and register updated workflows.`)
}

function proposalStatusIcon(status: import('./promise/evolution-types.js').ProposalStatus): string {
  return { proposed: '?', accepted: '~', rejected: '✗', applied: '✓' }[status]
}

function printAmendmentProposal(p: import('./promise/evolution-types.js').ContractAmendmentProposal, stale: boolean): void {
  console.log(`  [${proposalStatusIcon(p.status)} ${p.status}] ${p.id}`)
  console.log(`      category: ${p.category}   affects: ${p.affectedElementId}   confidence: ${p.confidence}   sample: ${p.occurrenceCount}/${p.sampleSize}`)
  console.log(`      ${p.summary}`)
  console.log(`      next action: ${p.recommendedNextAction}`)
  if (stale) console.log(`      ⚠ computed against contract v${p.contractVersion}, which is no longer the live version -- re-run "kairos contract evolve run" to refresh.`)
}

async function handleContractEvolve(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  const validSubcommands = ['run', 'list', 'show', 'accept', 'reject']

  if (!subcommand || !validSubcommands.includes(subcommand) || !contractId || !clientId) {
    console.error('Usage: kairos contract evolve run <contract-id> --client-id <slug> [--from <date>] [--to <date>] [--with-harness] [--json]')
    console.error('       kairos contract evolve list <contract-id> --client-id <slug> [--status <status>] [--json]')
    console.error('       kairos contract evolve show <contract-id> <proposal-id> --client-id <slug> [--json]')
    console.error('       kairos contract evolve accept <contract-id> <proposal-id> --client-id <slug> [--reason <text>] [--json]')
    console.error('       kairos contract evolve reject <contract-id> <proposal-id> --client-id <slug> [--reason <text>] [--json]')
    console.error('')
    console.error('Contract Evolution v0: treats ProcessContract as a hypothesis, not permanent')
    console.error('truth. run reads this contract\'s own real ProofLedger + ExceptionDesk data')
    console.error('(plus, with --with-harness, generated-scenario mismatches -- always confidence')
    console.error('\'low\', never blended with real-evidence confidence) and produces evidence-')
    console.error('linked proposals: frequency/existence hotspots only, never a specific')
    console.error('replacement value (e.g. never "3 attempts should become 2") -- that would need')
    console.error('inferring a number from unstructured data this v0 deliberately does not')
    console.error('attempt. Read-only against the contract itself; writes only to this contract\'s')
    console.error('own stored proposal list, never the contract.')
    console.error('')
    console.error('accept/reject record a human decision (audited, never auto) -- they do NOT')
    console.error('change the contract either. To actually act on an accepted proposal, hand-')
    console.error('author a new contract version yourself, then run "kairos contract amend ...')
    console.error('--from-proposal <proposal-id>" (item 12\'s own diff/amend/version gate is the')
    console.error('only thing allowed to write a new contract version).')
    process.exit(1)
  }

  const { loadProcessContract } = await import('./promise/store.js')
  const contract = await loadProcessContract(clientId, contractId)
  if (!contract) {
    console.error(`No ProcessContract found for client "${clientId}" with id "${contractId}".`)
    process.exit(1)
  }

  if (subcommand === 'run') {
    const { getProofLedgerEntries } = await import('./promise/ledger-store.js')
    const { loadExceptionDeskItems } = await import('./promise/exception-store.js')
    const { analyzeContractForAmendments } = await import('./promise/evolution.js')
    const { upsertContractAmendmentProposals } = await import('./promise/evolution-store.js')

    const allEntries = await getProofLedgerEntries(clientId, contractId, 10000)
    const window = {
      ...(typeof flags['from'] === 'string' ? { from: flags['from'] } : {}),
      ...(typeof flags['to'] === 'string' ? { to: flags['to'] } : {}),
    }
    const entries = allEntries.filter(e => (!window.from || (e.eventTime ?? e.observedAt) >= window.from) && (!window.to || (e.eventTime ?? e.observedAt) <= window.to))
    const exceptions = await loadExceptionDeskItems(clientId, contractId)

    let harnessResult: import('./promise/harness-types.js').HarnessResult | undefined
    if (flags['with-harness'] === true) {
      const { generateContractScenarios } = await import('./promise/scenario.js')
      const { runContractHarness } = await import('./promise/harness.js')
      const { scenarios } = generateContractScenarios(contract)
      harnessResult = runContractHarness(contract, scenarios)
    }

    const fresh = analyzeContractForAmendments(contract, entries, exceptions, harnessResult)
    const merged = await upsertContractAmendmentProposals(clientId, contractId, fresh)
    const freshIds = new Set(fresh.map(p => p.id))

    if (flags['json'] === true) {
      console.log(JSON.stringify({ generated: fresh, allStored: merged }, null, 2))
      return
    }
    console.log(`${contract.name} (${contractId}) — Contract Evolution run`)
    console.log('─'.repeat(50))
    if (fresh.length === 0) {
      console.log('No new/refreshed proposals from this run\'s evidence.')
    } else {
      for (const p of fresh) printAmendmentProposal(p, false)
    }
    const untouchedCount = merged.filter(p => !freshIds.has(p.id)).length
    if (untouchedCount > 0) {
      console.log(`\n(${untouchedCount} previously-stored proposal(s) not re-detected this run -- unchanged, run "kairos contract evolve list" to see all.)`)
    }
    return
  }

  if (subcommand === 'list') {
    const { loadContractAmendmentProposals } = await import('./promise/evolution-store.js')
    const proposals = await loadContractAmendmentProposals(clientId, contractId)
    const statusFilter = typeof flags['status'] === 'string' ? flags['status'] : undefined
    const filtered = statusFilter ? proposals.filter(p => p.status === statusFilter) : proposals

    if (flags['json'] === true) {
      console.log(JSON.stringify(filtered.map(p => ({ ...p, stale: p.contractVersion !== contract.version })), null, 2))
      return
    }
    console.log(`${contract.name} (${contractId}) — Amendment Proposals${statusFilter ? ` (status: ${statusFilter})` : ''}`)
    console.log('─'.repeat(50))
    if (filtered.length === 0) {
      console.log('(None. Run "kairos contract evolve run" first.)')
      return
    }
    for (const p of filtered) printAmendmentProposal(p, p.contractVersion !== contract.version)
    return
  }

  const proposalId = positional[2]
  if (!proposalId) {
    console.error(`Usage: kairos contract evolve ${subcommand} <contract-id> <proposal-id> --client-id <slug> [--json]`)
    process.exit(1)
  }

  if (subcommand === 'show') {
    const { loadContractAmendmentProposals } = await import('./promise/evolution-store.js')
    const proposals = await loadContractAmendmentProposals(clientId, contractId)
    const p = proposals.find(x => x.id === proposalId)
    if (!p) {
      console.error(`No proposal "${proposalId}" found for contract "${contractId}".`)
      process.exit(1)
    }
    if (flags['json'] === true) {
      console.log(JSON.stringify({ ...p, stale: p!.contractVersion !== contract.version }, null, 2))
      return
    }
    printAmendmentProposal(p!, p!.contractVersion !== contract.version)
    console.log(`\n  evidence:`)
    for (const e of p!.evidence) console.log(`    - ${e.kind}: ${e.id}`)
    if (p!.history.length > 0) {
      console.log(`\n  history:`)
      for (const h of p!.history) console.log(`    ${h.ts}  ${h.from ?? '(created)'} -> ${h.to}${h.reason ? `  (${h.reason})` : ''}`)
    }
    return
  }

  // subcommand === 'accept' | 'reject'
  const { updateProposalStatus } = await import('./promise/evolution-store.js')
  const reason = typeof flags['reason'] === 'string' ? flags['reason'] : undefined
  const updated = await updateProposalStatus(clientId, contractId, proposalId, subcommand === 'accept' ? 'accepted' : 'rejected', reason)
  if (!updated) {
    console.error(`No proposal "${proposalId}" found for contract "${contractId}".`)
    process.exit(1)
  }
  if (flags['json'] === true) {
    console.log(JSON.stringify(updated, null, 2))
    return
  }
  console.log(`✓ Proposal "${proposalId}" marked ${updated!.status}.`)
  if (subcommand === 'accept') {
    console.log(`Nothing has changed yet -- hand-author a new contract version addressing this, then run:`)
    console.log(`  kairos contract amend ${contractId} --client-id ${clientId} --new <file.json> --confirm --from-proposal ${proposalId}`)
  }
}

async function handleContractReport(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!contractId || !clientId) {
    console.error('Usage: kairos contract report <contract-id> --client-id <slug> [--from <iso-date>] [--to <iso-date>] [--bundle <dir>] [--json]')
    console.error('')
    console.error('Generates a client-facing promise report from this contract\'s own ProofLedger')
    console.error('and ExceptionDesk data -- purely local, no network calls. Counts kept/at-risk/')
    console.error('missed/unverifiable/in-progress instances (never counts unverifiable as kept),')
    console.error('open/acknowledged/resolved exceptions, an evidence-quality breakdown, and an')
    console.error('owner/action summary for open exceptions. Always states plainly when evidence')
    console.error('is incomplete -- no fake ROI math, no raw PII beyond the hashed correlation')
    console.error('key, no dashboard, no autonomous decisions. Without --bundle, only prints to')
    console.error('stdout; with --bundle <dir>, also writes promise-report.md + a manifest there,')
    console.error("reusing the same Delivery Bundle artifact/manifest pattern kairos pack export's")
    console.error('--bundle already uses.')
    process.exit(1)
  }

  const { loadProcessContract } = await import('./promise/store.js')
  const contract = await loadProcessContract(clientId, contractId)
  if (!contract) {
    console.error(`No ProcessContract found for client "${clientId}" with id "${contractId}".`)
    process.exit(1)
  }

  const { getProofLedgerEntries, loadContractPollWatermark } = await import('./promise/ledger-store.js')
  const { loadExceptionDeskItems } = await import('./promise/exception-store.js')
  const { loadContractWorkflowRegistration } = await import('./promise/registry.js')
  const { buildPromiseReportData, generatePromiseReport } = await import('./promise/report.js')

  const entries = await getProofLedgerEntries(clientId, contractId, 10000)
  const exceptions = await loadExceptionDeskItems(clientId, contractId)
  const window = {
    ...(typeof flags['from'] === 'string' ? { from: flags['from'] } : {}),
    ...(typeof flags['to'] === 'string' ? { to: flags['to'] } : {}),
  }

  // P0 measurement-integrity fix (2026-07-20, fix #11): summed across every workflow ever
  // registered to this contract, not just the ones with entries in the current window -- a
  // structural count of executions that never became ledger entries at all, read from the
  // watermark rather than requiring a fresh poll.
  const registration = await loadContractWorkflowRegistration(clientId, contractId)
  let unattributedExecutionCount = 0
  for (const wf of registration?.workflows ?? []) {
    const watermark = await loadContractPollWatermark(clientId, contractId, wf.n8nWorkflowId)
    unattributedExecutionCount += watermark?.cumulativeUnattributedCount ?? 0
  }

  const data = buildPromiseReportData(contract, entries, exceptions, window, new Date(), unattributedExecutionCount)

  const bundleDir = typeof flags['bundle'] === 'string' ? flags['bundle'] : undefined
  if (bundleDir) {
    const { writePromiseReport } = await import('./promise/report-bundle.js')
    const manifest = await writePromiseReport(data, bundleDir)
    console.error(`\nPromise report written to: ${manifest.files[0]!.path}`)
    console.error(`Manifest: ${bundleDir}/promise-report-manifest.json`)
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(generatePromiseReport(data))
}

async function handleContractValue(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!contractId || !clientId) {
    console.error('Usage: kairos contract value <contract-id> --client-id <slug> [--assumptions <file.json>] [--from <iso-date>] [--to <iso-date>] [--bundle <dir>] [--json]')
    console.error('')
    console.error('Automation P&L / Value Report (roadmap item 13): an "Observed" section --')
    console.error('identical to "kairos contract report", zero assumptions needed -- plus an')
    console.error('optional "Estimated Value" section, present only when --assumptions <file.json>')
    console.error('supplies at least one per-unit multiplier (minutesSavedPerKeptInstance,')
    console.error('minutesSavedPerResolvedException, dollarValuePerResolvedException,')
    console.error('dollarValuePerAvoidedMiss, currency, enteredBy, enteredAt -- all optional, all')
    console.error('human-entered). No dollar or time figure is ever computed without an explicit')
    console.error('assumption for that specific multiplier -- Kairos never infers, benchmarks, or')
    console.error('defaults one on your behalf (the same discipline "kairos pack export')
    console.error('--impact-notes" already uses; a prior automatic-ROI-math concept was proposed')
    console.error('and explicitly rejected in this codebase\'s own history for exactly this risk).')
    console.error('Every value line shows its own formula inline. Refuses (exit 1, nothing')
    console.error('printed) if a dollar-denominated assumption is present with no currency.')
    console.error('Without --bundle, only prints to stdout; with --bundle <dir>, also writes')
    console.error('automation-value-report.md + a manifest there.')
    process.exit(1)
  }

  const { loadProcessContract } = await import('./promise/store.js')
  const contract = await loadProcessContract(clientId, contractId)
  if (!contract) {
    console.error(`No ProcessContract found for client "${clientId}" with id "${contractId}".`)
    process.exit(1)
  }

  let assumptions: import('./promise/value-types.js').ImpactAssumptions | undefined
  const assumptionsPath = typeof flags['assumptions'] === 'string' ? flags['assumptions'] : undefined
  if (assumptionsPath) {
    const { readFile } = await import('node:fs/promises')
    try {
      const content = await readFile(assumptionsPath, 'utf-8')
      assumptions = JSON.parse(content) as import('./promise/value-types.js').ImpactAssumptions
    } catch (err) {
      console.error(`Could not read or parse ${assumptionsPath}: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    const { validateImpactAssumptions } = await import('./promise/value-report.js')
    const issues = validateImpactAssumptions(assumptions)
    if (issues.length > 0) {
      console.error(`\nRefusing to compute an Estimated Value section -- nothing printed.`)
      for (const issue of issues) console.error(`  ✗ ${issue}`)
      process.exit(1)
    }
  }

  const { getProofLedgerEntries, loadContractPollWatermark } = await import('./promise/ledger-store.js')
  const { loadExceptionDeskItems } = await import('./promise/exception-store.js')
  const { loadContractWorkflowRegistration } = await import('./promise/registry.js')
  const { buildPromiseReportData } = await import('./promise/report.js')
  const { buildAutomationValueReport, generateAutomationValueReport } = await import('./promise/value-report.js')

  const entries = await getProofLedgerEntries(clientId, contractId, 10000)
  const exceptions = await loadExceptionDeskItems(clientId, contractId)
  const window = {
    ...(typeof flags['from'] === 'string' ? { from: flags['from'] } : {}),
    ...(typeof flags['to'] === 'string' ? { to: flags['to'] } : {}),
  }

  const registration = await loadContractWorkflowRegistration(clientId, contractId)
  let unattributedExecutionCount = 0
  for (const wf of registration?.workflows ?? []) {
    const watermark = await loadContractPollWatermark(clientId, contractId, wf.n8nWorkflowId)
    unattributedExecutionCount += watermark?.cumulativeUnattributedCount ?? 0
  }

  const reportData = buildPromiseReportData(contract, entries, exceptions, window, new Date(), unattributedExecutionCount)
  const valueReport = buildAutomationValueReport(reportData, assumptions)

  const bundleDir = typeof flags['bundle'] === 'string' ? flags['bundle'] : undefined
  if (bundleDir) {
    const { writeAutomationValueReport } = await import('./promise/report-bundle.js')
    const manifest = await writeAutomationValueReport(valueReport, bundleDir)
    console.error(`\nAutomation value report written to: ${manifest.files[0]!.path}`)
    console.error(`Manifest: ${bundleDir}/automation-value-report-manifest.json`)
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify(valueReport, null, 2))
    return
  }

  console.log(generateAutomationValueReport(valueReport))
}

async function handleContract(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]

  if (subcommand === 'plan') {
    await handleContractPlan(positional, flags)
    return
  }

  if (subcommand === 'compile') {
    await handleContractCompile(positional, flags)
    return
  }

  if (subcommand === 'report') {
    await handleContractReport(positional, flags)
    return
  }

  if (subcommand === 'value') {
    await handleContractValue(positional, flags)
    return
  }

  if (subcommand === 'import') {
    await handleContractImport(positional, flags)
    return
  }

  if (subcommand === 'versions') {
    await handleContractVersions(positional, flags)
    return
  }

  if (subcommand === 'diff') {
    await handleContractDiff(positional, flags)
    return
  }

  if (subcommand === 'amend') {
    await handleContractAmend(positional, flags)
    return
  }

  if (subcommand === 'evolve') {
    await handleContractEvolve(positional.slice(1), flags)
    return
  }

  if (subcommand === 'intake') {
    await handleContractIntake(positional.slice(1), flags)
    return
  }

  if (subcommand === 'scenarios') {
    await handleContractScenarios(positional.slice(1), flags)
    return
  }

  if (subcommand === 'harness') {
    await handleContractHarness(positional.slice(1), flags)
    return
  }

  if (subcommand !== 'validate') {
    console.error('Usage: kairos contract plan "<business description>" --client-id <slug> [--json]')
    console.error('       kairos contract intake start --client-id <slug> [--context <file>] [--resume <session-id>]')
    console.error('       kairos contract intake status <session-id> --client-id <slug> [--json]')
    console.error('       kairos contract scenarios generate <file.json> [--categories <list>] [--out <dir>] [--json]')
    console.error('       kairos contract harness run <file.json> [--scenarios <dir>] [--json]')
    console.error('       kairos contract compile <file.json> [--build] [--dry-run] [--json]')
    console.error('       kairos contract validate <file.json> [--json]')
    console.error('       kairos contract import <file.json> --client-id <slug> [--confirm-version-change] [--json]')
    console.error('       kairos contract versions <contract-id> --client-id <slug> [--json]')
    console.error('       kairos contract diff <contract-id> --client-id <slug> --from <v> --to <v> [--json]')
    console.error('       kairos contract amend <contract-id> --client-id <slug> --new <file.json> [--confirm] [--confirm-breaking-with-active-instances] [--from-proposal <id>] [--json]')
    console.error('       kairos contract evolve run|list|show|accept|reject <contract-id> [<proposal-id>] --client-id <slug> [--json]')
    console.error('       kairos contract report <contract-id> --client-id <slug> [--from <date>] [--to <date>] [--bundle <dir>] [--json]')
    console.error('       kairos contract value <contract-id> --client-id <slug> [--assumptions <file.json>] [--from <date>] [--to <date>] [--bundle <dir>] [--json]')
    console.error('')
    console.error('plan drafts a ProcessContract from a plain-language description via an LLM,')
    console.error('then always runs it through the deterministic validator before returning it.')
    console.error('')
    console.error('intake is a guided, multi-turn alternative to plan -- 11 focused questions')
    console.error('(what starts it, what counts as done, branches, exceptions, owners, SLAs,')
    console.error('evidence, handoffs, missing data, duplicates, what to never automate) instead')
    console.error('of one free-text paragraph. Answers are collected with no LLM call; a single')
    console.error('synthesis call (same validator/review-gate as plan) then drafts the contract,')
    console.error('with up to 2 bounded rounds of targeted follow-up questions if the draft has')
    console.error('blocking assumptions or validation errors. Resumable via --resume.')
    console.error('')
    console.error('scenarios generate deterministically derives synthetic business scenarios from')
    console.error('a valid ProcessContract -- no LLM call. Never fabricates evidence for a')
    console.error('transition the contract has no EvidenceRequirement for; a category is skipped')
    console.error('(with a reason) rather than faked when the contract cannot support it.')
    console.error('')
    console.error('harness run executes scenarios through the REAL checkSlaCompliance()/')
    console.error('updateExceptionDesk()/classifyPromiseInstance() functions -- the same ones')
    console.error('production uses -- purely in-memory, no n8n, no network. Compares the result')
    console.error('against each scenario\'s own expected outcome and reports mismatches.')
    console.error('')
    console.error('compile deterministically translates a valid ProcessContract into a PackPlan')
    console.error('(no LLM call in this step) and, with --build, feeds it into the same')
    console.error('PackBuilder/Kairos.build() machinery `kairos build-pack` uses. compile only')
    console.error('ever reads a file -- it never saves the contract; see import below.')
    console.error('')
    console.error("validate checks a ProcessContract JSON file against Kairos's deterministic")
    console.error('contract validator -- reachability, terminal-state consistency, dangling')
    console.error('references, business-calendar consistency, and more. Fully offline: no')
    console.error('Anthropic/n8n API calls, no credentials required.')
    console.error('')
    console.error('import validates a contract file and saves it into the local store so ledger')
    console.error('poll/watch --contracts/contract report can find it afterward -- required')
    console.error('before those, since compile itself never saves anything. Refuses (exit 2) to')
    console.error('overwrite an already-saved contract at a DIFFERENT version unless')
    console.error('--confirm-version-change is passed -- overwriting silently would orphan any')
    console.error("ProofLedger evidence recorded against the old version's own ids.")
    console.error('')
    console.error('versions lists every archived (superseded) version of a saved contract, newest')
    console.error('first -- empty until the contract has been amended/re-imported at least once.')
    console.error('')
    console.error('diff renders a structural diff between two versions of a saved contract --')
    console.error('what changed, and whether each change is classified breaking (could cause')
    console.error('existing ProofLedger/ExceptionDesk evidence to be misinterpreted against the')
    console.error('new shape) or compatible. Pure, offline, no writes.')
    console.error('')
    console.error('amend previews (default) or applies (--confirm) replacing a saved contract')
    console.error('with a new version from a file -- always shows the diff and its breaking/')
    console.error('compatible classification first. --confirm validates (same gate as import),')
    console.error('archives the current version (never destroyed, see versions/diff above), then')
    console.error('saves the new one. Refuses a breaking amendment while any promise instance is')
    console.error('still in_progress unless --confirm-breaking-with-active-instances is also')
    console.error('passed -- amending never recompiles/redeploys anything; run')
    console.error('"kairos contract compile <file.json> --build" yourself afterward.')
    console.error('')
    console.error('evolve treats this contract as a hypothesis, not permanent truth. run reads')
    console.error('real ProofLedger/ExceptionDesk evidence (plus, with --with-harness, generated-')
    console.error('scenario mismatches, always low confidence) and produces frequency/existence')
    console.error('hotspot proposals -- never a specific replacement value. list/show inspect them;')
    console.error('accept/reject record a human decision (audited, never automatic) but do NOT')
    console.error('change the contract -- only "kairos contract amend ... --from-proposal <id>" can')
    console.error('do that, and even then only after you hand-author the new contract yourself.')
    console.error('')
    console.error('report generates a client-facing promise-report.md from ProofLedger +')
    console.error('ExceptionDesk data -- see "kairos contract report" with no args for detail.')
    console.error('')
    console.error('value (roadmap item 13) is report\'s own Observed section (identical, zero')
    console.error('assumptions needed) plus an optional Estimated Value section -- present only')
    console.error('with --assumptions <file.json> supplying at least one human-entered per-unit')
    console.error('multiplier. No dollar/time figure is ever computed without one; refuses (exit')
    console.error('1) if a dollar assumption is present with no currency. See "kairos contract')
    console.error('value" with no args for the full field list.')
    process.exit(1)
  }

  const filePath = positional[1]
  if (!filePath) {
    console.error('Usage: kairos contract validate <file.json> [--json]')
    process.exit(1)
  }

  const { validateProcessContract } = await import('./promise/validate.js')
  const { readFile } = await import('node:fs/promises')

  let contract: import('./promise/types.js').ProcessContract
  try {
    const content = await readFile(filePath, 'utf-8')
    contract = JSON.parse(content) as import('./promise/types.js').ProcessContract
  } catch (err) {
    console.error(`Could not read or parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const issues = validateProcessContract(contract)

  if (flags['json'] === true) {
    console.log(JSON.stringify({ valid: issues.filter(i => i.severity === 'error').length === 0, issues }, null, 2))
    if (issues.some(i => i.severity === 'error')) process.exit(1)
    return
  }

  if (issues.length === 0) {
    console.log(`✓ ${filePath} passed all contract validator checks`)
    return
  }

  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warn')

  console.log(`\n${filePath} — Contract Validation`)
  console.log('─'.repeat(50))
  console.log(`Issues: ${errors.length} error(s), ${warnings.length} warning(s)`)
  console.log('')

  for (const issue of errors) {
    console.log(`  ✗ [error] [Rule ${issue.rule}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
  }
  for (const issue of warnings) {
    console.log(`  ⚠ [warn]  [Rule ${issue.rule}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
  }

  if (errors.length > 0) process.exit(1)
}

async function handleLedgerPoll(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!contractId || !clientId) {
    console.error('Usage: kairos ledger poll <contract-id> --client-id <slug> [--limit <n>] [--json]')
    console.error('')
    console.error('Polls n8n execution data (read-only -- GET only, never a write) for every')
    console.error('workflow registered against this contract (see "kairos contract compile')
    console.error('--build"), extracts evidence only from the exact fields each')
    console.error('EvidenceRequirement whitelists, and appends observed/unverifiable entries to')
    console.error('the local ProofLedger. Never re-processes an execution already covered by the')
    console.error('stored watermark; --limit controls how many recent executions are fetched per')
    console.error('workflow per run (default 20).')
    process.exit(1)
  }

  const { loadProcessContract } = await import('./promise/store.js')
  const contract = await loadProcessContract(clientId, contractId)
  if (!contract) {
    console.error(`No ProcessContract found for client "${clientId}" with id "${contractId}".`)
    process.exit(1)
  }

  const { loadContractWorkflowRegistration } = await import('./promise/registry.js')
  const registration = await loadContractWorkflowRegistration(clientId, contractId)
  const activeWorkflows = registration?.workflows.filter(w => w.status === 'active') ?? []
  if (activeWorkflows.length === 0) {
    console.error('No active workflows registered for this contract.')
    if (registration && registration.workflows.length > activeWorkflows.length) {
      console.error(`(${registration.workflows.length - activeWorkflows.length} registered workflow(s) exist but are retired -- see "kairos contract report" for their historical evidence.)`)
    }
    console.error('Run "kairos contract compile <file.json> --build" (without --dry-run) first --')
    console.error('registration happens automatically once a real build succeeds.')
    process.exit(1)
  }

  const n8nBaseUrl = getEnvOrExit('N8N_BASE_URL')
  const n8nApiKey = getEnvOrExit('N8N_API_KEY')
  const { N8nApiClient } = await import('./providers/n8n/api-client.js')
  const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)

  const { pollWorkflowEvidence } = await import('./promise/ledger.js')
  const { loadContractPollWatermark, saveContractPollWatermark, appendProofLedgerEntries } = await import('./promise/ledger-store.js')

  const limit = typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : 20

  const results: Array<{ workflowName: string } & Awaited<ReturnType<typeof pollWorkflowEvidence>>> = []
  for (const wf of activeWorkflows) {
    const watermark = await loadContractPollWatermark(clientId, contractId, wf.n8nWorkflowId)
    const result = await pollWorkflowEvidence(contract, wf.n8nWorkflowId, client, watermark, limit, wf.sourceElements)
    await appendProofLedgerEntries(clientId, contractId, result.entries)
    await saveContractPollWatermark(clientId, result.newWatermark)
    results.push({ workflowName: wf.workflowName, ...result })
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  console.log(`\n${contract.name} — Evidence Poll`)
  console.log('─'.repeat(50))
  for (const r of results) {
    const extracted = r.outcomes.filter(o => o.outcome === 'extracted').length
    const unverifiable = r.outcomes.filter(o => o.outcome === 'unverifiable').length
    const skipped = r.outcomes.filter(o => o.outcome === 'skipped').length

    console.log(`\n${r.workflowName} (${r.n8nWorkflowId})`)
    console.log(`  Checked: ${r.executionsChecked} execution(s) -- extracted: ${extracted}, unverifiable: ${unverifiable}, skipped: ${skipped}`)
    if (r.possibleGap) {
      console.log(`  ⚠ Every fetched execution was new -- the poll window may be smaller than the real gap since the last check. Consider --limit or polling more often.`)
    }
    if (r.unattributedCount > 0) {
      console.log(`  ⚠ ${r.unattributedCount} execution(s) this poll had evidence expected but NO readable correlation key -- no ledger entry was written for them, and they will NOT appear in "kairos contract report"'s counts. Cumulative total for this workflow: ${r.newWatermark.cumulativeUnattributedCount ?? r.unattributedCount}.`)
    }
    for (const o of r.outcomes) {
      if (o.outcome === 'skipped') continue
      const icon = o.outcome === 'extracted' ? '✓' : '⚠'
      console.log(`    ${icon} [${o.outcome}] exec ${o.executionId}${o.transitionId ? ` (${o.transitionId})` : ''}: ${o.detail}`)
    }
  }
}

async function handleLedgerShow(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  if (!contractId || !clientId) {
    console.error('Usage: kairos ledger show <contract-id> --client-id <slug> [--instance <promise-instance-id>] [--limit <n>] [--json]')
    console.error('')
    console.error('Reads back stored ProofLedger entries for a contract -- purely local, no')
    console.error('n8n/Anthropic calls. Run "kairos ledger poll" first to populate it.')
    console.error('--client-id is required (Finding 1 fix, 2026-07-20): ProofLedger storage is')
    console.error('scoped per client, so this refuses rather than falling back to any unscoped')
    console.error('or ambiguous lookup.')
    process.exit(1)
  }

  const { getProofLedgerEntries } = await import('./promise/ledger-store.js')
  const limit = typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : 200
  let entries = await getProofLedgerEntries(clientId, contractId, limit)

  const instanceFilter = typeof flags['instance'] === 'string' ? flags['instance'] : undefined
  if (instanceFilter) entries = entries.filter(e => e.promiseInstanceId === instanceFilter)

  if (flags['json'] === true) {
    console.log(JSON.stringify(entries, null, 2))
    return
  }

  if (entries.length === 0) {
    console.log(`No ProofLedger entries found${instanceFilter ? ` for instance "${instanceFilter}"` : ''}.`)
    console.log('Run "kairos ledger poll <contract-id> --client-id <slug>" first.')
    return
  }

  console.log(`\nProofLedger — ${contractId}${instanceFilter ? ` (instance ${instanceFilter})` : ''}`)
  console.log('─'.repeat(50))
  for (const e of entries) {
    const icon = e.status === 'observed' ? '✓' : e.status === 'unverifiable' ? '⚠' : '?'
    console.log(`  ${icon} [${e.status}] ${e.eventTime ?? e.observedAt}  transition=${e.transitionId}  instance=${e.promiseInstanceId.slice(0, 12)}...`)
    if (e.eventTime && e.eventTime !== e.observedAt) console.log(`     (Kairos discovered this on ${e.observedAt})`)
    console.log(`     ${e.detail}`)
  }
}

async function handleLedger(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]

  if (subcommand === 'poll') {
    await handleLedgerPoll(positional, flags)
    return
  }
  if (subcommand === 'show') {
    await handleLedgerShow(positional, flags)
    return
  }

  console.error('Usage: kairos ledger poll <contract-id> --client-id <slug> [--limit <n>] [--json]')
  console.error('       kairos ledger show <contract-id> --client-id <slug> [--instance <promise-instance-id>] [--json]')
  console.error('')
  console.error('ProofLedger v0 (Phase 3, docs/plans/process-contract-promise-engine-plan.md §6):')
  console.error('read-only, polling-based evidence tracking. poll fetches new n8n executions for')
  console.error('every workflow registered against a contract and extracts only whitelisted')
  console.error('evidence fields; show reads back what has already been recorded locally.')
  console.error('SLA compliance + ExceptionDesk (Phase 4) run only inside `kairos watch --contracts`')
  console.error('-- see "kairos exceptions" for reading/resolving what it opens.')
  process.exit(1)
}

async function handleExceptionsList(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  if (!contractId || !clientId) {
    console.error('Usage: kairos exceptions list <contract-id> --client-id <slug> [--status open|acknowledged|resolved] [--json]')
    console.error('')
    console.error('--client-id is required (Finding 1 fix, 2026-07-20): ExceptionDesk storage is')
    console.error('scoped per client, so this refuses rather than falling back to any unscoped')
    console.error('or ambiguous lookup.')
    process.exit(1)
  }

  const { loadExceptionDeskItems } = await import('./promise/exception-store.js')
  let items = await loadExceptionDeskItems(clientId, contractId)
  const statusFilter = typeof flags['status'] === 'string' ? flags['status'] : undefined
  if (statusFilter) items = items.filter(i => i.status === statusFilter)

  if (flags['json'] === true) {
    console.log(JSON.stringify(items, null, 2))
    return
  }

  if (items.length === 0) {
    console.log(`No exception items${statusFilter ? ` with status "${statusFilter}"` : ''} for contract "${contractId}".`)
    return
  }

  console.log(`\nExceptionDesk — ${contractId} (${items.length} item(s))`)
  console.log('─'.repeat(50))
  for (const item of items) {
    const icon = item.status === 'open' ? '⚠' : item.status === 'acknowledged' ? '·' : '✓'
    console.log(`  ${icon} [${item.status}] ${item.kind}  ${item.id}`)
    console.log(`     Instance: ${item.promiseInstanceId.slice(0, 16)}...  Owner: ${item.owner}`)
    console.log(`     ${item.reason}`)
  }
}

async function handleExceptionsShow(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const contractId = positional[1]
  const itemId = positional[2]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  if (!contractId || !itemId || !clientId) {
    console.error('Usage: kairos exceptions show <contract-id> <item-id> --client-id <slug> [--json]')
    console.error('')
    console.error('--client-id is required (Finding 1 fix, 2026-07-20): ExceptionDesk storage is')
    console.error('scoped per client, so this refuses rather than falling back to any unscoped')
    console.error('or ambiguous lookup.')
    process.exit(1)
  }

  const { loadExceptionDeskItems } = await import('./promise/exception-store.js')
  const items = await loadExceptionDeskItems(clientId, contractId)
  const item = items.find(i => i.id === itemId)
  if (!item) {
    console.error(`No exception item "${itemId}" found for contract "${contractId}".`)
    process.exit(1)
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify(item, null, 2))
    return
  }

  console.log(`\n${item.id}`)
  console.log('─'.repeat(50))
  console.log(`Kind: ${item.kind}      Status: ${item.status}`)
  console.log(`Contract: ${item.contractId}      Instance: ${item.promiseInstanceId}`)
  if (item.slaId) console.log(`SLA: ${item.slaId}`)
  if (item.expirationRuleId) console.log(`Expiration rule: ${item.expirationRuleId}`)
  console.log(`Owner: ${item.owner}`)
  console.log(`Next action: ${item.nextAction}`)
  console.log(`\nReason: ${item.reason}`)
  if (item.evidence.length > 0) {
    console.log(`\nEvidence:`)
    for (const e of item.evidence) console.log(`  - ${e}`)
  }
  console.log(`\nHistory:`)
  for (const h of item.history) {
    console.log(`  ${h.ts}  ${h.from ?? '(none)'} → ${h.to}  [${h.actor}]${h.reason ? `  ${h.reason}` : ''}`)
  }
}

async function handleExceptionsSetStatus(positional: string[], flags: Record<string, string | boolean>, to: 'acknowledged' | 'resolved'): Promise<void> {
  const contractId = positional[1]
  const itemId = positional[2]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined
  if (!contractId || !itemId || !clientId) {
    console.error(`Usage: kairos exceptions ${to === 'acknowledged' ? 'ack' : 'resolve'} <contract-id> <item-id> --client-id <slug> [--reason <text>] [--json]`)
    console.error('')
    console.error('--client-id is required (Finding 1 fix, 2026-07-20): ExceptionDesk storage is')
    console.error('scoped per client, so this refuses rather than falling back to any unscoped')
    console.error('or ambiguous lookup.')
    process.exit(1)
  }

  const { loadExceptionDeskItems, saveExceptionDeskItem } = await import('./promise/exception-store.js')
  const { applyHumanStatusChange } = await import('./promise/exception-desk.js')
  const items = await loadExceptionDeskItems(clientId, contractId)
  const item = items.find(i => i.id === itemId)
  if (!item) {
    console.error(`No exception item "${itemId}" found for contract "${contractId}".`)
    process.exit(1)
  }

  const reason = typeof flags['reason'] === 'string' ? flags['reason'] : undefined
  const updated = applyHumanStatusChange(item, to, new Date(), reason)
  await saveExceptionDeskItem(clientId, contractId, updated)

  if (flags['json'] === true) {
    console.log(JSON.stringify(updated, null, 2))
    return
  }
  console.log(`${item.id}: ${item.status} → ${updated.status}${reason ? ` (${reason})` : ''}`)
}

async function handleExceptions(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]

  if (subcommand === 'list') return handleExceptionsList(positional, flags)
  if (subcommand === 'show') return handleExceptionsShow(positional, flags)
  if (subcommand === 'ack') return handleExceptionsSetStatus(positional, flags, 'acknowledged')
  if (subcommand === 'resolve') return handleExceptionsSetStatus(positional, flags, 'resolved')

  console.error('Usage: kairos exceptions list <contract-id> --client-id <slug> [--status <status>] [--json]')
  console.error('       kairos exceptions show <contract-id> <item-id> --client-id <slug> [--json]')
  console.error('       kairos exceptions ack <contract-id> <item-id> --client-id <slug> [--reason <text>] [--json]')
  console.error('       kairos exceptions resolve <contract-id> <item-id> --client-id <slug> [--reason <text>] [--json]')
  console.error('')
  console.error('ExceptionDesk v0 (Phase 4, docs/plans/process-contract-promise-engine-plan.md §7):')
  console.error('human resolution only -- ack/resolve are the ONLY way an item\'s status ever')
  console.error('changes; items are opened/refreshed automatically, only inside')
  console.error('`kairos watch --contracts`, never here. No auto-resolution, no workflow edits.')
  process.exit(1)
}

async function handleDrift(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  const n8nWorkflowId = positional[1]

  if ((subcommand !== 'baseline' && subcommand !== 'check') || !n8nWorkflowId) {
    console.error('Usage: kairos drift baseline <n8n-workflow-id> [--json]')
    console.error('       kairos drift check <n8n-workflow-id> [--live] [--original-build-hash <hash>] [--json]')
    console.error('')
    console.error('baseline reports what Kairos currently knows for this workflow -- which of the')
    console.error('9 named drift checks have real data to evaluate (captured) vs. which do not yet')
    console.error('or structurally cannot (skipped), and why. It does not compute a drift verdict.')
    console.error('')
    console.error('check runs all 9 checks now and reports HEALTHY or DRIFTING, with a full')
    console.error('diagnosis (confidence-tiered cause, recommended action, repair class) for any')
    console.error('drifting finding. Exits 1 only when something is actually drifting -- never for')
    console.error('insufficient_data or not_applicable, which are not failures.')
    console.error('')
    console.error('D9 (build-vs-live structural drift): with --live and no --original-build-hash,')
    console.error('check automatically compares the library\'s stored workflow against a fresh live')
    console.error('fetch (the same computation kairos repair propose uses) -- an explicit')
    console.error('--original-build-hash always overrides this. Without --live, D9 stays')
    console.error('not_applicable (no fresh live workflow to compare against).')
    process.exit(1)
  }

  const lib = createLibrary()
  await lib.initialize()
  const all = await lib.list()
  const match = all.find(w => w.n8nWorkflowId === n8nWorkflowId)

  if (!match) {
    console.error(`No library entry found with n8nWorkflowId="${n8nWorkflowId}".`)
    console.error('Build and deploy a workflow with kairos first to create a library entry, or')
    console.error('run "kairos trace record <n8n-workflow-id>" to link an existing n8n workflow.')
    process.exit(1)
  }

  let traces = match.executionTraces ?? []
  let liveBuildHashes: { originalBuildHash: string; liveExportHash: string } | undefined

  if (flags['live'] === true) {
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --live.')
      process.exit(1)
    }
    const { fetchLatestTrace, mergeTraces } = await import('./telemetry/execution-tracer.js')
    const latest = await fetchLatestTrace(n8nWorkflowId, n8nBaseUrl, n8nApiKey)
    if (latest) {
      await lib.recordTrace(match.id, latest)
      traces = mergeTraces(traces, latest)
    } else {
      console.error('--live: no executions found, or could not reach n8n. Proceeding with stored traces only.')
    }

    // D9 fallback (fixes a real gap found in the 2026-07-19 closeout checkpoint): without
    // --original-build-hash, `drift check` used to always report D9 as not_applicable, even
    // for a workflow that had genuinely drifted -- `kairos repair propose` already computed
    // this same signal correctly, from the library's own stored workflow JSON (propose.ts),
    // so a user running drift check alone would see "not_applicable" and reasonably conclude
    // nothing structural changed, while repair propose would have caught it. Mirrors
    // propose.ts's own computation exactly: hash the library's stored copy (the last state
    // Kairos itself is known to have deployed) against a fresh live fetch. An explicit
    // --original-build-hash always wins over this fallback, unchanged.
    if (subcommand === 'check' && typeof flags['original-build-hash'] !== 'string') {
      const { N8nProvider } = await import('./providers/n8n/provider.js')
      const { N8nFieldStripper } = await import('./providers/n8n/stripper.js')
      const { computeWorkflowHash } = await import('./utils/workflow-hash.js')
      try {
        const provider = new N8nProvider(new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER), new N8nFieldStripper())
        const liveWorkflow = await provider.get(n8nWorkflowId)
        liveBuildHashes = { originalBuildHash: computeWorkflowHash(match.workflow), liveExportHash: computeWorkflowHash(liveWorkflow) }
      } catch (err) {
        console.error(`--live: could not fetch the live workflow for D9 comparison: ${String(err)}`)
      }
    }
  }

  const { buildDriftBaselineReport, buildDriftCheckReport, formatDriftBaselineReport, formatDriftCheckReport } = await import('./reliability/drift/report.js')
  const context = { workflowId: n8nWorkflowId, workflowName: match.description }
  const inputs = {
    traces,
    ...(liveBuildHashes ?? {}),
    ...(typeof flags['original-build-hash'] === 'string' ? { originalBuildHash: flags['original-build-hash'] } : {}),
  }

  if (subcommand === 'baseline') {
    const report = buildDriftBaselineReport(context, inputs)
    if (flags['json'] === true) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(formatDriftBaselineReport(report))
    }
    return
  }

  // subcommand === 'check'
  const report = buildDriftCheckReport(context, inputs)
  if (flags['json'] === true) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatDriftCheckReport(report))
  }

  const telemetry = await createTelemetryCollector()
  if (telemetry) {
    // Best-effort -- see preflight/bundle-export precedent: telemetry is a side-effecting
    // log, never allowed to throw out of or change the command's own result/exit behavior.
    try {
      await telemetry.emit('drift_check_completed', {
        workflowId: n8nWorkflowId,
        verdict: report.verdict,
        traceCount: report.traceCount,
        driftingCount: report.findings.filter(f => f.status === 'drifting').length,
        live: flags['live'] === true,
      })
    } catch {
      // Swallowed deliberately -- see comment above.
    }
  }

  // Exit 1 only for real drifting -- insufficient_data and not_applicable are not failures
  // and must never trip an alert (Jordan/Codex, 2026-07-19).
  if (report.verdict === 'DRIFTING') process.exit(1)
}

async function handleSandbox(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  const { bootSandbox, sandboxStatus, stopSandbox } = await import('./reliability/sandbox/manager.js')

  if (subcommand === 'up') {
    const port = typeof flags['port'] === 'string' ? parseInt(flags['port'], 10) : undefined
    console.error('Booting sandbox (first run downloads and provisions n8n -- may take a few minutes; subsequent runs are fast)...')
    const config = await bootSandbox(port !== undefined ? { port } : {})
    console.log(`Sandbox running at ${config.baseUrl} (n8n ${config.n8nVersion}).`)
    return
  }
  if (subcommand === 'status') {
    const status = await sandboxStatus()
    if (flags['json'] === true) {
      console.log(JSON.stringify(status, null, 2))
    } else {
      console.log(status.running ? `Running at ${status.config?.baseUrl}` : 'Not running.')
    }
    return
  }
  if (subcommand === 'down') {
    await stopSandbox()
    console.log('Sandbox stopped.')
    return
  }

  console.error('Usage: kairos sandbox up [--port <n>]')
  console.error('       kairos sandbox status [--json]')
  console.error('       kairos sandbox down')
  process.exit(1)
}

async function loadWorkflowByN8nId(n8nWorkflowId: string): Promise<{ libraryId: string; workflow: import('./types/workflow.js').N8nWorkflow; description: string }> {
  const lib = createLibrary()
  await lib.initialize()
  const all = await lib.list()
  const match = all.find(w => w.n8nWorkflowId === n8nWorkflowId)
  if (!match) {
    console.error(`No library entry found with n8nWorkflowId="${n8nWorkflowId}".`)
    console.error('Build and deploy a workflow with kairos first to create a library entry, or')
    console.error('run "kairos trace record <n8n-workflow-id>" to link an existing n8n workflow.')
    process.exit(1)
  }
  return { libraryId: match.id, workflow: match.workflow, description: match.description }
}

async function handleReplay(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  const n8nWorkflowId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!subcommand || !['capture', 'run', 'purge'].includes(subcommand) || !n8nWorkflowId || !clientId) {
    console.error('Usage: kairos replay capture <n8n-workflow-id> --client-id <slug> [--limit <n>] [--scrub] [--json]')
    console.error('       kairos replay run <n8n-workflow-id> --candidate <file> --client-id <slug> [--live] [--verbose] [--json]')
    console.error('       kairos replay run <n8n-workflow-id> --candidate <file> --client-id <slug> --contract <file.json> [--scenario <id>] [--verbose] [--json]')
    console.error('       kairos replay purge <n8n-workflow-id> --client-id <slug> [--json]')
    console.error('')
    console.error('capture records real production payloads (opt-in, local-only, chmod 600) for later replay.')
    console.error('run replays every captured payload against both the currently-deployed workflow and a')
    console.error('  candidate file, in an isolated sandbox -- never against production.')
    console.error('purge deletes every captured payload for a workflow (the revocation path).')
    console.error('')
    console.error('run --live boots its OWN sandbox internally, separate from whatever N8N_BASE_URL')
    console.error('points at. If N8N_BASE_URL happens to be a Kairos-managed sandbox itself (a local')
    console.error('test/demo setup), it refuses rather than risk confusing "production" with a')
    console.error('sandbox -- N8N_BASE_URL must be a genuinely different host (your real n8n) for')
    console.error('--live to run.')
    console.error('')
    console.error('run --contract <file.json> (roadmap item 7, see docs/plans/')
    console.error('intake-scenario-harness-plan.md §7) additionally replays a ContractScenario\'s own')
    console.error('intake payload against the CANDIDATE workflow and checks the real resulting')
    console.error('instance_start evidence (via the same extractExecutionEvidence() the production')
    console.error('ProofLedger poller uses) against what the scenario expects -- reported as a')
    console.error('separate "Contract Outcome Check" section, alongside (never replacing) the')
    console.error('existing structural baseline-vs-candidate diff. Auto-generates scenarios for the')
    console.error('contract\'s first startCondition when --scenario is omitted (all of them checked);')
    console.error('--scenario <id> narrows to one. Checks ONLY the intake workflow\'s own')
    console.error('instance_start evidence -- never the scenario\'s full expected classification,')
    console.error('which assumes state-transition evidence from a separate, differently-triggered')
    console.error('processing workflow this check does not touch. Evidence-graded, not a semantic')
    console.error('proof the whole business promise was kept.')
    process.exit(1)
  }

  if (subcommand === 'purge') {
    const { deleteCapturedPayloads } = await import('./reliability/replay/capture.js')
    const result = await deleteCapturedPayloads(clientId, n8nWorkflowId)
    if (flags['json'] === true) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Deleted ${result.deletedCount} captured payload(s) for workflow ${n8nWorkflowId} (client "${clientId}").`)
    }
    return
  }

  if (subcommand === 'capture') {
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for capture (reads real recent executions).')
      process.exit(1)
    }
    const { workflow, libraryId } = await loadWorkflowByN8nId(n8nWorkflowId)
    const { capturePayloads } = await import('./reliability/replay/capture.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
    const result = await capturePayloads(client, workflow, n8nWorkflowId, clientId, {
      ...(typeof flags['limit'] === 'string' ? { limit: parseInt(flags['limit'], 10) } : {}),
      ...(flags['scrub'] === true ? { scrub: true } : {}),
    })

    if (flags['json'] === true) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (result.skippedNonWebhook) {
      console.log(`Skipped: workflow ${libraryId} has no webhook trigger. Capture only supports webhook-triggered workflows today.`)
      return
    }
    console.log(`Captured ${result.captured.length} payload(s) for workflow ${n8nWorkflowId} (client "${clientId}").`)
    if (result.sweptCount > 0) console.log(`Retention swept ${result.sweptCount} older/excess capture(s).`)
    return
  }

  // subcommand === 'run'
  const candidateFile = typeof flags['candidate'] === 'string' ? flags['candidate'] : undefined
  if (!candidateFile) {
    console.error('Usage: kairos replay run <n8n-workflow-id> --candidate <file> --client-id <slug> [--live] [--verbose] [--json]')
    process.exit(1)
  }

  const { workflow: baselineWorkflow } = await loadWorkflowByN8nId(n8nWorkflowId)

  const { readFile } = await import('node:fs/promises')
  let candidateWorkflow: import('./types/workflow.js').N8nWorkflow
  try {
    candidateWorkflow = JSON.parse(await readFile(candidateFile, 'utf-8')) as import('./types/workflow.js').N8nWorkflow
  } catch (err) {
    console.error(`Could not read/parse candidate workflow file "${candidateFile}": ${String(err)}`)
    process.exit(1)
  }

  if (flags['live'] === true) {
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --live (captures a fresh payload before replaying).')
      process.exit(1)
    }
    const { capturePayloads } = await import('./reliability/replay/capture.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
    console.error('--live: capturing a fresh payload before replay...')
    await capturePayloads(client, baselineWorkflow, n8nWorkflowId, clientId, { limit: 1 })
  }

  const { bootSandbox } = await import('./reliability/sandbox/manager.js')
  const { runReplay, formatReplayReportForHumans, formatReplayRunResult } = await import('./reliability/replay/runner.js')

  console.error('Booting sandbox (reuses an already-running instance if present)...')
  const sandboxConfig = await bootSandbox()

  const result = await runReplay(sandboxConfig, baselineWorkflow, candidateWorkflow, n8nWorkflowId, clientId)

  // Contract Outcome Check (roadmap item 7, docs/plans/intake-scenario-harness-plan.md §7) --
  // deliberately a separate, independent block from runReplay() above, never conflated into
  // one code path: this check needs no captured payloads at all (it builds its own synthetic
  // one from a ContractScenario), so it runs regardless of whether the structural diff above
  // had anything to compare or how it came out.
  let contractOutcomeResults: import('./reliability/replay/contract-outcome.js').ContractOutcomeCheckResult[] = []
  const contractFile = typeof flags['contract'] === 'string' ? flags['contract'] : undefined
  if (contractFile) {
    const contract = await readContractFile(contractFile)
    const startCondition = contract.startConditions[0]
    if (!startCondition) {
      console.error(`⚠ Contract "${contract.id}" has no startConditions -- skipping contract outcome check.`)
    } else {
      const { generateContractScenarios } = await import('./promise/scenario.js')
      const { checkScenarioIntakeOutcome } = await import('./reliability/replay/contract-outcome.js')
      const { scenarios } = generateContractScenarios(contract)
      const scenarioFlag = typeof flags['scenario'] === 'string' ? flags['scenario'] : undefined
      const scenariosToCheck = scenarioFlag ? scenarios.filter(s => s.id === scenarioFlag || s.category === scenarioFlag) : scenarios

      if (scenarioFlag && scenariosToCheck.length === 0) {
        console.error(`⚠ No generated scenario matched "${scenarioFlag}" -- skipping contract outcome check. Available: ${scenarios.map(s => s.id).join(', ')}`)
      }

      console.error(`\nRunning contract outcome check against the CANDIDATE workflow for ${scenariosToCheck.length} scenario(s)...`)
      for (const scenario of scenariosToCheck) {
        const checkResult = await checkScenarioIntakeOutcome(sandboxConfig, candidateWorkflow, contract, startCondition, scenario)
        contractOutcomeResults.push(checkResult)
      }
    }
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify({ ...result, ...(contractFile ? { contractOutcomeResults } : {}) }, null, 2))
  } else {
    console.log(formatReplayReportForHumans(result))
    if (flags['verbose'] === true) {
      console.log('')
      console.log('--- Technical detail (--verbose) ---')
      console.log(formatReplayRunResult(result))
    }
    if (contractFile) {
      console.log('')
      console.log('=== Contract Outcome Check ===')
      if (contractOutcomeResults.length === 0) {
        console.log('(No scenarios checked -- see warning above.)')
      }
      for (const r of contractOutcomeResults) {
        const icon = r.status !== 'checked' ? '?' : r.matched ? '✓' : '✗'
        console.log(`\n  [${icon}] ${r.scenarioName} -- ${r.status}${r.status === 'checked' ? (r.matched ? ' (matched)' : ' (MISMATCH)') : ''}`)
        console.log(`      ${r.detail}`)
        for (const m of r.mismatches) console.log(`      MISMATCH: ${m}`)
      }
      console.log('')
      console.log(`  Scope: ${contractOutcomeResults[0]?.scopeCaveat ?? 'This check replays only a scenario\'s own intake payload -- never the full contract.'}`)
    }
  }

  const telemetry = await createTelemetryCollector()
  if (telemetry) {
    try {
      const comparedCount = result.status === 'completed' ? result.outcomes.filter(o => o.status === 'compared').length : 0
      const incompleteCount = result.status === 'completed' ? result.outcomes.filter(o => o.status === 'no_execution_found').length : 0
      await telemetry.emit('replay_completed', {
        workflowId: n8nWorkflowId,
        verdict: result.verdict,
        status: result.status,
        payloadCount: comparedCount,
        incompleteCount,
        partialVerification: result.partialVerification,
      })
    } catch {
      // Swallowed deliberately -- telemetry must never change this command's outcome.
    }
  }

  // Exit 1 for anything short of a clean, fully-or-benignly-verified pass -- matches
  // kairos drift check's own "only real problems trip the exit code" philosophy, but here
  // that includes an incomplete/uncomparable run, since a candidate that couldn't be tested
  // is not something a caller should treat as safe.
  const structuralFailed = result.status !== 'completed' || (result.verdict !== 'IDENTICAL' && result.verdict !== 'BENIGN_VARIANCE')
  // The combined verdict is the worse of the two (docs/plans/intake-scenario-harness-plan.md
  // §7): a clean structural diff must never mask a contract-outcome mismatch -- an unmatched
  // or unresolvable ('no_execution_found') scenario check fails the whole command exactly like
  // a structural BROKEN/INCOMPLETE would, never silently ignored just because the workflows
  // otherwise looked identical to each other.
  const contractOutcomeFailed = contractOutcomeResults.some(r => r.status !== 'checked' || !r.matched)
  if (structuralFailed || contractOutcomeFailed) {
    process.exit(1)
  }
}

async function handleChaos(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  const n8nWorkflowId = positional[1]

  if ((subcommand !== 'audit' && subcommand !== 'run') || !n8nWorkflowId) {
    console.error('Usage: kairos chaos audit <n8n-workflow-id> [--json]')
    console.error('       kairos chaos run <n8n-workflow-id> [--contract <file>] [--json]')
    console.error('')
    console.error('audit statically predicts how this workflow would handle adversarial webhook')
    console.error('payloads (missing/null/wrong-type/oversized fields, injection-shaped strings,')
    console.error('unprotected external calls) -- no sandbox required, no execution happens.')
    console.error('Findings are heuristic predictions, not confirmed failures; exit code is always 0.')
    console.error('')
    console.error('run confirms audit\'s predictions live: replays every adversarial payload variant')
    console.error('against this workflow in an isolated sandbox and reports HANDLED/CRASHED/')
    console.error('SILENT_MISBEHAVIOR/BLOCKED_AT_CREDENTIAL per variant. Exits 1 for any confirmed')
    console.error('crash or incomplete result -- never for blocked-at-credential or silent')
    console.error('misbehavior, which require human judgment.')
    console.error('')
    console.error('run boots its OWN sandbox internally, separate from whatever N8N_BASE_URL points')
    console.error('at. If N8N_BASE_URL happens to be a Kairos-managed sandbox itself (a local')
    console.error('test/demo setup), it refuses rather than risk confusing "production" with a')
    console.error('sandbox -- N8N_BASE_URL must be a genuinely different host (your real n8n) for')
    console.error('run to execute.')
    console.error('')
    console.error('run --contract <file.json> additionally injects ProcessContract-derived')
    console.error('business scenarios (happy path, missing correlation key, duplicate')
    console.error('correlation) against this same workflow, and reports expected business')
    console.error('outcome vs actual sandbox outcome for each -- alongside, never instead of,')
    console.error('the structural adversarial-payload run above.')
    process.exit(1)
  }

  const { workflow } = await loadWorkflowByN8nId(n8nWorkflowId)

  if (subcommand === 'audit') {
    const { runStaticChaosAudit, formatStaticChaosAuditResult } = await import('./reliability/chaos/static-audit.js')
    const result = runStaticChaosAudit(workflow)

    if (flags['json'] === true) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatStaticChaosAuditResult(result, n8nWorkflowId))
    }
    return
  }

  // subcommand === 'run'
  const { bootSandbox } = await import('./reliability/sandbox/manager.js')
  const { runChaosSandbox, formatChaosSandboxRunResult } = await import('./reliability/chaos/sandbox-run.js')

  console.error('Booting sandbox (reuses an already-running instance if present)...')
  const sandboxConfig = await bootSandbox()

  const result = await runChaosSandbox(sandboxConfig, workflow)

  if (flags['json'] !== true) {
    console.log(formatChaosSandboxRunResult(result, n8nWorkflowId))
  }

  // Chaos Upgrade: business-level scenarios (roadmap item 8, docs/plans/
  // intake-scenario-harness-plan.md §8) -- deliberately a separate, additive block, never
  // conflated into runChaosSandbox() above: it needs a contract, the structural run above
  // doesn't, and Codex's own scope explicitly requires "keep existing malformed-payload chaos
  // behavior intact." Only runs when --contract is passed.
  let contractChaosResult: import('./reliability/chaos/contract-outcome.js').ContractChaosRunResult | undefined
  const contractFile = typeof flags['contract'] === 'string' ? flags['contract'] : undefined
  if (contractFile) {
    const contract = await readContractFile(contractFile)
    const startCondition = contract.startConditions[0]
    if (!startCondition) {
      console.error(`⚠ Contract "${contract.id}" has no startConditions -- skipping contract-derived chaos.`)
    } else {
      const { runContractChaos, formatContractChaosRunResult } = await import('./reliability/chaos/contract-outcome.js')
      console.error('\nRunning contract-derived chaos variants...')
      contractChaosResult = await runContractChaos(sandboxConfig, workflow, contract, startCondition)
      if (flags['json'] !== true) {
        console.log('')
        console.log(formatContractChaosRunResult(contractChaosResult, n8nWorkflowId))
      }
    }
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify({ ...result, ...(contractChaosResult ? { contractChaosResult } : {}) }, null, 2))
  }

  const telemetry = await createTelemetryCollector()
  if (telemetry) {
    try {
      await telemetry.emit('chaos_completed', {
        workflowId: n8nWorkflowId,
        status: result.status,
        handledCount: result.summary.handled,
        crashedCount: result.summary.crashed,
        silentMisbehaviorCount: result.summary.silentMisbehavior,
        blockedAtCredentialCount: result.summary.blockedAtCredential,
        incompleteCount: result.summary.incomplete,
      })
    } catch {
      // Swallowed deliberately -- telemetry must never change this command's outcome.
    }
  }

  // Exit 1 only for confirmed, unambiguous problems -- a real crash, or a payload that
  // couldn't be run at all. Never for blocked-at-credential (expected sandbox limitation, not
  // a finding) or silent misbehavior (may be an intentional difference -- needs a human to
  // judge, not an automatic failure). A contract-derived chaos mismatch is treated the same way
  // -- a confirmed problem, not a judgment call -- matching kairos replay run's own combined
  // exit-code discipline for its own --contract flag.
  const contractChaosFailed = contractChaosResult !== undefined && (contractChaosResult.status === 'completed'
    ? contractChaosResult.outcomes.some(o => o.status !== 'checked' || !o.businessOutcomeMatched)
    : contractChaosResult.status !== 'no_contract_scenarios')
  if (result.status !== 'completed' || result.summary.crashed > 0 || result.summary.incomplete > 0 || contractChaosFailed) {
    process.exit(1)
  }
}

// Conservative by design (Phase 6 design-verification pass, docs/plans/reliability-suite-plan.md
// 11): fetchLatestTrace is cheap (2 API calls/workflow/tick) and N8nApiClient already retries
// 429s with backoff, but no live rate-limit ceiling was empirically probed against production-
// adjacent infrastructure to find a tighter "safe" number -- erring long is the safer default,
// tightened later from real usage data, not guessed tighter now.
const DEFAULT_WATCH_INTERVAL_SECONDS = 300

/**
 * One contract's compliance tick (Phase 4): poll new evidence for every registered workflow,
 * evaluate SLA/expiration-rule compliance over the full local ledger, open/refresh exception
 * items for any 'drifting' finding, print a report, and alert (stdout + optional --on-exception
 * hook) for anything newly opened. Read-only against n8n (reuses pollWorkflowEvidence()
 * unchanged); the only writes are to Kairos's own local ledger/exception storage. Per Codex's
 * explicit scope: "Integrate with kairos watch only as detect/report/notify, not repair" -- this
 * function never proposes or applies anything, and never edits a workflow.
 */
async function runContractComplianceTick(
  contractId: string,
  clientId: string,
  n8nBaseUrl: string,
  n8nApiKey: string,
  asJson: boolean,
  onExceptionCommand: string | undefined,
): Promise<void> {
  const { loadProcessContract } = await import('./promise/store.js')
  const contract = await loadProcessContract(clientId, contractId)
  if (!contract) {
    console.error(`[contracts] No ProcessContract found for client "${clientId}" with id "${contractId}" -- skipping this tick.`)
    return
  }

  const { loadContractWorkflowRegistration } = await import('./promise/registry.js')
  const registration = await loadContractWorkflowRegistration(clientId, contractId)
  const activeWorkflows = registration?.workflows.filter(w => w.status === 'active') ?? []
  if (activeWorkflows.length === 0) {
    console.error(`[contracts] No active workflows registered for contract "${contractId}" -- skipping this tick. Run "kairos contract compile <file.json> --build" first.`)
    return
  }

  const { N8nApiClient } = await import('./providers/n8n/api-client.js')
  const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
  const { pollWorkflowEvidence } = await import('./promise/ledger.js')
  const { loadContractPollWatermark, saveContractPollWatermark, appendProofLedgerEntries, getProofLedgerEntries } = await import('./promise/ledger-store.js')

  for (const wf of activeWorkflows) {
    const watermark = await loadContractPollWatermark(clientId, contractId, wf.n8nWorkflowId)
    const result = await pollWorkflowEvidence(contract, wf.n8nWorkflowId, client, watermark, 20, wf.sourceElements)
    await appendProofLedgerEntries(clientId, contractId, result.entries)
    await saveContractPollWatermark(clientId, result.newWatermark)
  }

  const { checkSlaCompliance, complianceVerdict } = await import('./promise/sla-compliance.js')
  const { updateExceptionDesk } = await import('./promise/exception-desk.js')
  const { loadExceptionDeskItems, upsertExceptionDeskItems } = await import('./promise/exception-store.js')

  const entries = await getProofLedgerEntries(clientId, contractId, 1000)
  const findings = checkSlaCompliance(contract, entries)
  const existingItems = await loadExceptionDeskItems(clientId, contractId)
  const { opened, refreshed } = updateExceptionDesk(contract, findings, existingItems)
  await upsertExceptionDeskItems(clientId, contractId, [...opened, ...refreshed])

  const verdict = complianceVerdict(findings)

  if (asJson) {
    console.log(JSON.stringify({ contractId, verdict, findings, openedExceptions: opened, refreshedExceptions: refreshed }, null, 2))
  } else {
    console.log(`\n[contracts] ${contract.name} (${contractId}) -- ${verdict}`)
    const reportable = findings.filter(f => f.status !== 'insufficient_data' && f.status !== 'not_applicable')
    if (reportable.length === 0) {
      console.log('  No SLA/expiration findings with real data yet.')
    }
    for (const f of reportable) {
      const icon = f.status === 'drifting' ? '⚠' : f.status === 'unverifiable' ? '?' : '✓'
      const label = f.kind === 'sla' ? `SLA ${f.slaId}` : `Expiration ${f.expirationRuleId}`
      console.log(`  ${icon} [${f.status}] ${label} (instance ${f.promiseInstanceId.slice(0, 12)}...) -- ${f.summary}`)
    }
  }

  for (const item of opened) {
    console.log(`\n[EXCEPTION OPENED] ${item.kind} -- contract ${item.contractId}, instance ${item.promiseInstanceId.slice(0, 12)}...`)
    console.log(`  Owner: ${item.owner}`)
    console.log(`  Next action: ${item.nextAction}`)
    console.log(`  Reason: ${item.reason}`)

    if (onExceptionCommand) {
      const { invokeOnDriftHook } = await import('./reliability/watch/notify.js')
      await invokeOnDriftHook(onExceptionCommand, item)
    }
  }
}

async function handleWatch(_positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const workflowsFlag = typeof flags['workflows'] === 'string' ? flags['workflows'] : undefined
  const contractsFlag = typeof flags['contracts'] === 'string' ? flags['contracts'] : undefined
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if (!workflowsFlag && !contractsFlag) {
    console.error('Usage: kairos watch --workflows <ids|all> [--interval <s>] [--on-drift <cmd>] [--once] [--json]')
    console.error('       kairos watch --contracts <contract-id>[,...] --client-id <slug> [--interval <s>] [--on-exception <cmd>] [--once] [--json]')
    console.error('')
    console.error('Detect -> diagnose -> notify -> audit only -- no propose/apply/rollback. Runs a')
    console.error('foreground loop by default (Ctrl-C to stop); --once runs a single tick and')
    console.error('exits, for cron/launchd. --workflows all watches every deployed library entry;')
    console.error('a comma-separated list of n8n workflow IDs watches only those. Every workflow')
    console.error('tick is appended to ~/.kairos/reliability-audit.jsonl regardless of verdict.')
    console.error('')
    console.error('--contracts (Phase 4) runs SLA/promise compliance instead: polls new evidence')
    console.error('for every workflow registered against each named contract, evaluates')
    console.error('SLA/expiration-rule compliance, and opens/refreshes ExceptionDesk items for any')
    console.error('drifting finding -- detect/report/notify only, never repair, never a workflow')
    console.error('edit. Both flags may be given together in one watch loop.')
    process.exit(1)
  }

  if (contractsFlag && !clientId) {
    console.error('--client-id is required when using --contracts.')
    process.exit(1)
  }

  const n8nBaseUrlEnv = process.env['N8N_BASE_URL']
  const n8nApiKeyEnv = process.env['N8N_API_KEY']
  if (!n8nBaseUrlEnv || !n8nApiKeyEnv) {
    console.error('N8N_BASE_URL and N8N_API_KEY are required for kairos watch.')
    process.exit(1)
  }
  // Hoisted function declarations below don't retain the above narrowing, so capture typed
  // locals explicitly rather than relying on TS to carry it through the closure.
  const n8nBaseUrl: string = n8nBaseUrlEnv
  const n8nApiKey: string = n8nApiKeyEnv

  const intervalSeconds = typeof flags['interval'] === 'string' ? parseInt(flags['interval'], 10) : DEFAULT_WATCH_INTERVAL_SECONDS
  const onDriftCommand = typeof flags['on-drift'] === 'string' ? flags['on-drift'] : undefined
  const onExceptionCommand = typeof flags['on-exception'] === 'string' ? flags['on-exception'] : undefined
  const once = flags['once'] === true
  const asJson = flags['json'] === true

  const lib = createLibrary()
  await lib.initialize()

  const requestedIds = workflowsFlag === 'all' ? null : workflowsFlag?.split(',').map(s => s.trim()) ?? null
  const contractIds = contractsFlag ? contractsFlag.split(',').map(s => s.trim()) : []

  async function resolveTargets(): Promise<Array<{ libraryId: string; n8nWorkflowId: string; workflowName?: string; existingTraces: import('./library/types.js').ExecutionTrace[] }>> {
    const all = await lib.list()
    const deployed = all.filter((w): w is typeof w & { n8nWorkflowId: string } => Boolean(w.n8nWorkflowId))
    const matched = requestedIds === null ? deployed : deployed.filter(w => requestedIds.includes(w.n8nWorkflowId))
    return matched.map(w => ({
      libraryId: w.id,
      n8nWorkflowId: w.n8nWorkflowId,
      ...(w.description ? { workflowName: w.description } : {}),
      existingTraces: w.executionTraces ?? [],
    }))
  }

  async function runOnce(): Promise<void> {
    if (workflowsFlag) {
      const { runWatchTick, formatWatchTickForHumans } = await import('./reliability/watch/loop.js')
      const { notifyTick } = await import('./reliability/watch/notify.js')

      const targets = await resolveTargets()
      if (targets.length === 0) {
        console.error('No deployed workflows match --workflows. Nothing to check this tick.')
      } else {
        const results = await runWatchTick(lib, targets, n8nBaseUrl, n8nApiKey)
        if (asJson) {
          console.log(JSON.stringify(results, null, 2))
        } else {
          console.log(formatWatchTickForHumans(results))
        }
        await notifyTick(results, onDriftCommand ? { onDriftCommand } : {})
      }
    }

    for (const contractId of contractIds) {
      await runContractComplianceTick(contractId, clientId!, n8nBaseUrl, n8nApiKey, asJson, onExceptionCommand)
    }
  }

  if (once) {
    await runOnce()
    return
  }

  console.error(`Watching (interval ${intervalSeconds}s). Press Ctrl-C to stop.`)
  for (;;) {
    await runOnce()
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000))
  }
}

// Large enough that the auto-mode eligibility check (§8.4: "one attempt per distinct cause,
// ever") never misses an old repair_write entry just because it fell outside a small recent-N
// window -- reliability-audit.jsonl is a small, local, append-only file; reading it in full for
// a safety-critical check is the correct trade, not a real cost.
const REPAIR_AUDIT_FULL_SCAN_LIMIT = 1_000_000

async function handleRepair(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  const n8nWorkflowId = positional[1]
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined

  if ((subcommand !== 'propose' && subcommand !== 'apply') || !n8nWorkflowId || !clientId) {
    console.error('Usage: kairos repair propose <n8n-workflow-id> --client-id <slug> [--json]')
    console.error('       kairos repair apply <n8n-workflow-id> --client-id <slug> [--yes] [--auto] [--json]')
    console.error('')
    console.error('propose checks this workflow for D9 (build-vs-live structural) drift and, if')
    console.error('found, produces a proposed restore -- rationale, diff, an explicit three-hash')
    console.error('comparison, verification availability, risk level, and the exact next command.')
    console.error('Read-only: never boots a sandbox, never writes to n8n.')
    console.error('')
    console.error('apply snapshots the live workflow, attempts a replay verification (when a')
    console.error('webhook trigger and captured payloads exist), writes the proposed restore, then')
    console.error('structurally re-verifies and auto-rolls-back on failure. Requires interactive')
    console.error('confirmation, OR --yes (human, non-interactive), OR --auto (whitelist-only,')
    console.error('one attempt per cause ever, requires a clean replay verification -- refuses')
    console.error('outright, never falls back to prompting, if any condition is not met).')
    process.exit(1)
  }

  const n8nBaseUrlEnv = process.env['N8N_BASE_URL']
  const n8nApiKeyEnv = process.env['N8N_API_KEY']
  if (!n8nBaseUrlEnv || !n8nApiKeyEnv) {
    console.error(`N8N_BASE_URL and N8N_API_KEY are required for kairos repair ${subcommand}.`)
    process.exit(1)
  }

  const lib = createLibrary()
  await lib.initialize()
  const all = await lib.list()
  const match = all.find(w => w.n8nWorkflowId === n8nWorkflowId)
  if (!match) {
    console.error(`No library entry found with n8nWorkflowId="${n8nWorkflowId}".`)
    console.error('Build and deploy a workflow with kairos first to create a library entry, or')
    console.error('run "kairos trace record <n8n-workflow-id>" to link an existing n8n workflow.')
    process.exit(1)
  }

  const { N8nProvider } = await import('./providers/n8n/provider.js')
  const { N8nFieldStripper } = await import('./providers/n8n/stripper.js')
  const client = new N8nApiClient(n8nBaseUrlEnv, n8nApiKeyEnv, CLI_LOGGER)
  const provider = new N8nProvider(client, new N8nFieldStripper())

  let currentWorkflow: import('./types/workflow.js').N8nWorkflow
  try {
    currentWorkflow = await provider.get(n8nWorkflowId)
  } catch (err) {
    console.error(`Could not fetch the live workflow from n8n: ${String(err)}`)
    process.exit(1)
  }

  const { proposeRepair, formatRepairProposal } = await import('./reliability/repair/propose.js')
  const result = await proposeRepair({
    workflowId: n8nWorkflowId,
    ...(match.description ? { workflowName: match.description } : {}),
    clientId,
    currentWorkflow,
    storedWorkflow: match.workflow,
    traces: match.executionTraces ?? [],
  })

  const { appendReliabilityAudit, getReliabilityAuditTrail } = await import('./reliability/watch/audit.js')
  const auditTs = new Date().toISOString()
  try {
    if (result.status === 'proposed') {
      await appendReliabilityAudit([{
        kind: 'repair_propose', ts: auditTs, workflowId: n8nWorkflowId,
        ...(match.description ? { workflowName: match.description } : {}),
        checkId: result.proposal.checkId, riskLevel: result.proposal.riskLevel,
        verificationAvailability: result.proposal.verificationAvailability,
        produced: true,
        detail: `Proposed a ${result.proposal.checkId} restore (risk: ${result.proposal.riskLevel}).`,
      }])
    } else {
      await appendReliabilityAudit([{
        kind: 'repair_propose', ts: auditTs, workflowId: n8nWorkflowId,
        ...(match.description ? { workflowName: match.description } : {}),
        checkId: 'D9', produced: false, detail: result.detail,
      }])
    }
  } catch {
    // Best-effort, matching every other audit-writing call site in this codebase.
  }

  if (result.status === 'not_drifting') {
    if (flags['json'] === true) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`No proposal for ${match.description} (${n8nWorkflowId}) -- ${result.detail}`)
    }
    return
  }

  if (result.status === 'internal_error') {
    console.error(`kairos repair ${subcommand} refused: ${result.detail}`)
    process.exit(1)
  }

  const proposal = result.proposal

  if (subcommand === 'propose') {
    if (flags['json'] === true) {
      console.log(JSON.stringify(proposal, null, 2))
    } else {
      console.log(formatRepairProposal(proposal))
    }
    return
  }

  // subcommand === 'apply'
  console.log(formatRepairProposal(proposal))
  console.log('')

  const autoRequested = flags['auto'] === true
  const yesRequested = flags['yes'] === true
  let confirmedBy: 'human_prompt' | 'yes_flag' | 'auto_flag'

  if (autoRequested) {
    const { checkAutoModeEligibility } = await import('./reliability/repair/apply.js')
    const fullTrail = await getReliabilityAuditTrail(REPAIR_AUDIT_FULL_SCAN_LIMIT)
    const priorAutoWrites = fullTrail.filter((e): e is import('./reliability/watch/audit.js').RepairWriteAuditEntry => e.kind === 'repair_write')
    const eligibility = checkAutoModeEligibility(proposal, priorAutoWrites)
    if (!eligibility.eligible) {
      console.error(`--auto refuses: ${eligibility.reason}`)
      process.exit(1)
    }
    confirmedBy = 'auto_flag'
  } else if (yesRequested) {
    confirmedBy = 'yes_flag'
  } else {
    const readline = await import('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>(resolve => rl.question('Apply this restore? [y/N] ', resolve))
    rl.close()
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Not applied.')
      return
    }
    confirmedBy = 'human_prompt'
  }

  let sandboxConfig: import('./reliability/sandbox/manager.js').SandboxConfig | undefined
  if (proposal.verificationAvailability === 'available') {
    const { bootSandbox } = await import('./reliability/sandbox/manager.js')
    console.error('Booting sandbox for replay verification (reuses an already-running instance if present)...')
    sandboxConfig = await bootSandbox()
  }

  const { applyRepair } = await import('./reliability/repair/apply.js')
  const applyResult = await applyRepair(proposal, provider, clientId, { confirmedBy, auto: autoRequested }, sandboxConfig)

  if (flags['json'] === true) {
    console.log(JSON.stringify(applyResult, null, 2))
  } else {
    console.log('')
    console.log(`Status: ${applyResult.status.toUpperCase()}`)
    if (applyResult.replayVerdict) console.log(`Replay verdict: ${applyResult.replayVerdict} (partial verification: ${applyResult.replayPartialVerification})`)
    if (applyResult.snapshotPath) console.log(`Snapshot: ${applyResult.snapshotPath}`)
    console.log(applyResult.detail)
  }

  const telemetry = await createTelemetryCollector()
  if (telemetry) {
    try {
      await telemetry.emit('repair_completed', {
        workflowId: n8nWorkflowId,
        checkId: proposal.checkId,
        status: applyResult.status,
        auto: autoRequested,
        ...(applyResult.replayVerdict ? { replayVerdict: applyResult.replayVerdict } : {}),
        postVerifyPassed: applyResult.postVerifyPassed ?? null,
      })
    } catch {
      // Swallowed deliberately -- telemetry must never change this command's outcome.
    }
  }

  if (applyResult.status !== 'applied') {
    process.exit(1)
  }
}

async function handleRollback(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const n8nWorkflowId = positional[0]
  if (!n8nWorkflowId) {
    console.error('Usage: kairos rollback <n8n-workflow-id> [--to <iso-timestamp>] [--yes]')
    console.error('')
    console.error('Restores the most recent (or a named, via --to) snapshot for this workflow.')
    console.error('Snapshots are written automatically before every kairos repair apply write --')
    console.error('this command works even if you never ran repair propose, as long as a snapshot')
    console.error('exists. Requires interactive confirmation, or --yes for non-interactive use.')
    process.exit(1)
  }

  const n8nBaseUrlEnv = process.env['N8N_BASE_URL']
  const n8nApiKeyEnv = process.env['N8N_API_KEY']
  if (!n8nBaseUrlEnv || !n8nApiKeyEnv) {
    console.error('N8N_BASE_URL and N8N_API_KEY are required for kairos rollback.')
    process.exit(1)
  }

  const { listSnapshots, loadSnapshot } = await import('./reliability/repair/snapshot.js')
  const requestedTs = typeof flags['to'] === 'string' ? flags['to'] : undefined

  const snapshots = await listSnapshots(n8nWorkflowId)
  const target = requestedTs ? snapshots.find(s => s.ts === requestedTs) : snapshots[0]
  if (!target) {
    console.error(`No snapshot found for workflow "${n8nWorkflowId}"${requestedTs ? ` at timestamp ${requestedTs}` : ''}.`)
    if (snapshots.length === 0) console.error('No snapshots exist for this workflow at all -- nothing to roll back to.')
    process.exit(1)
  }
  const snapshotWorkflow = await loadSnapshot(n8nWorkflowId, target.ts)
  if (!snapshotWorkflow) {
    console.error(`Snapshot at ${target.ts} could not be read.`)
    process.exit(1)
  }

  if (flags['yes'] !== true) {
    const readline = await import('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>(resolve => rl.question(`Restore workflow ${n8nWorkflowId} from the snapshot at ${target.ts}? [y/N] `, resolve))
    rl.close()
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Not restored.')
      return
    }
  }

  const { N8nProvider } = await import('./providers/n8n/provider.js')
  const { N8nFieldStripper } = await import('./providers/n8n/stripper.js')
  const client = new N8nApiClient(n8nBaseUrlEnv, n8nApiKeyEnv, CLI_LOGGER)
  const provider = new N8nProvider(client, new N8nFieldStripper())

  try {
    await provider.update(n8nWorkflowId, snapshotWorkflow)
  } catch (err) {
    console.error(`Could not write the restored workflow to n8n: ${String(err)}`)
    process.exit(1)
  }

  const { appendReliabilityAudit } = await import('./reliability/watch/audit.js')
  try {
    await appendReliabilityAudit([{
      kind: 'repair_rollback', ts: new Date().toISOString(), workflowId: n8nWorkflowId,
      snapshotPath: target.path, reason: 'Standalone kairos rollback invocation.',
      detail: `Restored workflow ${n8nWorkflowId} from the snapshot taken at ${target.ts}.`,
    }])
  } catch {
    // Best-effort, matching every other audit-writing call site in this codebase.
  }

  if (flags['json'] === true) {
    console.log(JSON.stringify({ workflowId: n8nWorkflowId, restoredFrom: target.ts, snapshotPath: target.path }, null, 2))
  } else {
    console.log(`Restored workflow ${n8nWorkflowId} from the snapshot taken at ${target.ts}.`)
  }
}

async function handlePreflight(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const packName = positional[0]
  if (!packName) {
    console.error('Usage: kairos preflight <pack-name> [--live] [--bundle-dir <dir>] [--client-id <slug>] [--json]')
    process.exit(1)
  }

  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const packPath = join(homedir(), '.kairos', 'packs', `${packName}.json`)

  let pack: import('./pack/pack-builder.js').WorkflowPackResult
  try {
    const content = await readFile(packPath, 'utf-8')
    pack = JSON.parse(content) as import('./pack/pack-builder.js').WorkflowPackResult
  } catch {
    console.error(`Pack not found: ${packPath}`)
    console.error('Run "kairos build-pack <context>" to create one.')
    process.exit(1)
  }

  const { runPreflight, formatPreflightChecklist } = await import('./pack/preflight.js')

  let client: N8nApiClient | undefined
  if (flags['live'] === true) {
    const n8nBaseUrl = process.env['N8N_BASE_URL']
    const n8nApiKey = process.env['N8N_API_KEY']
    if (!n8nBaseUrl || !n8nApiKey) {
      console.error('N8N_BASE_URL and N8N_API_KEY are required for --live (fetches each workflow live from n8n).')
      process.exit(1)
    }
    client = new N8nApiClient(n8nBaseUrl, n8nApiKey, CLI_LOGGER)
  }

  const telemetry = await createTelemetryCollector()
  const result = await runPreflight(pack, {
    live: flags['live'] === true,
    ...(client ? { client } : {}),
    ...(typeof flags['bundle-dir'] === 'string' ? { bundleDir: flags['bundle-dir'] } : {}),
    ...(typeof flags['client-id'] === 'string' ? { clientId: flags['client-id'] } : {}),
    ...(telemetry ? { telemetry } : {}),
  })

  if (flags['json'] === true) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatPreflightChecklist(result))
  }

  if (result.verdict === 'NO-GO' || result.verdict === 'BLOCKED') process.exit(1)
}

async function handleInit(): Promise<void> {
  const { writeFile, readFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const readline = await import('node:readline')

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve))

  console.error('')
  console.error('  Kairos SDK — Setup Wizard')
  console.error('  ─────────────────────────')
  console.error('')

  const envPath = join(process.cwd(), '.env')
  let existingEnv = ''
  try {
    existingEnv = await readFile(envPath, 'utf-8')
  } catch {}

  const has = (key: string) => existingEnv.includes(key) || !!process.env[key]

  const lines: string[] = []

  if (!has('ANTHROPIC_API_KEY')) {
    const key = await ask('  Anthropic API key (from console.anthropic.com): ')
    if (key.trim()) lines.push(`ANTHROPIC_API_KEY=${key.trim()}`)
  } else {
    console.error('  Anthropic API key: already set')
  }

  if (!has('N8N_BASE_URL')) {
    const url = await ask('  n8n instance URL (e.g. https://your-name.app.n8n.cloud): ')
    if (url.trim()) lines.push(`N8N_BASE_URL=${url.trim().replace(/\/$/, '')}`)
  } else {
    console.error('  n8n base URL: already set')
  }

  if (!has('N8N_API_KEY')) {
    const key = await ask('  n8n API key: ')
    if (key.trim()) lines.push(`N8N_API_KEY=${key.trim()}`)
  } else {
    console.error('  n8n API key: already set')
  }

  rl.close()

  if (lines.length > 0) {
    const newContent = existingEnv
      ? existingEnv.trimEnd() + '\n' + lines.join('\n') + '\n'
      : lines.join('\n') + '\n'
    await writeFile(envPath, newContent, 'utf-8')
    console.error(`\n  Saved to ${envPath}`)
  } else {
    console.error('\n  All credentials already configured.')
  }

  console.error('')
  console.error('  Seeding template library...')

  const library = createLibrary()
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  const syncer = new TemplateSyncer(library, logger)

  await library.initialize()
  const existing = await library.list()

  if (existing.length >= 50) {
    console.error(`  Library already has ${existing.length} entries — skipping sync.`)
  } else {
    const result = await syncer.sync({
      maxTemplates: 500,
      onProgress: (p) => {
        if (p.processed % 100 === 0 && p.processed > 0) {
          process.stderr.write(`  ${p.processed}/${p.total} processed, ${p.saved} saved...\r`)
        }
      },
    })
    console.error(`  Synced ${result.saved} templates (${result.blocked} blocked, ${result.skippedDuplicate} duplicates)`)
  }

  const kairosDir = join(homedir(), '.kairos')
  await mkdir(join(kairosDir, 'telemetry'), { recursive: true })

  const kairosPath = process.execPath
    ? `${process.execPath.replace(/node$/, 'kairos-mcp')}`
    : 'kairos-mcp'

  console.error('')
  console.error('  Setup complete! Try:')
  console.error('')
  console.error('    kairos build "Send a Slack message when a webhook fires" --dry-run')
  console.error('')
  console.error('  ─── Claude Desktop MCP config ───────────────────────────────')
  console.error('  Add this to ~/Library/Application Support/Claude/claude_desktop_config.json:')
  console.error('')
  console.error('  {')
  console.error('    "mcpServers": {')
  console.error('      "kairos": {')
  console.error(`        "command": "${kairosPath}",`)
  console.error('        "env": {')
  console.error(`          "ANTHROPIC_API_KEY": "${process.env['ANTHROPIC_API_KEY'] ? '<set>' : 'your-key-here'}",`)
  console.error(`          "N8N_BASE_URL": "${process.env['N8N_BASE_URL'] ?? 'https://your-n8n-instance'}",`)
  console.error(`          "N8N_API_KEY": "${process.env['N8N_API_KEY'] ? '<set>' : 'your-n8n-api-key'}"`)
  console.error('        }')
  console.error('      }')
  console.error('    }')
  console.error('  }')
  console.error('')
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv)

  if (!command || command === 'help' || command === '--help' || flags['help'] === true) {
    console.log(HELP)
    return
  }

  switch (command) {
    case 'init':
      await handleInit()
      break
    case 'build':
      await handleBuild(positional, flags)
      break
    case 'build-pack':
      await handleBuildPack(positional, flags)
      break
    case 'replace':
      await handleReplace(positional, flags)
      break
    case 'patterns': {
      const subcommand = positional[0]
      if (subcommand === 'approve') {
        await handlePatternApprove(positional.slice(1))
      } else if (subcommand === 'reject') {
        await handlePatternReject(positional.slice(1))
      } else if (subcommand === 'share') {
        await handlePatternShare()
      } else if (subcommand === 'ingest') {
        await handlePatternIngest(positional.slice(1))
      } else if (subcommand === 'sync') {
        await handlePatternSync(flags)
      } else {
        await handlePatterns(flags)
      }
      break
    }
    case 'sessions':
      await handleSessions(flags)
      break
    case 'list':
      await handleList()
      break
    case 'get':
      await handleGet(positional)
      break
    case 'activate':
      await handleActivate(positional)
      break
    case 'deactivate':
      await handleDeactivate(positional)
      break
    case 'delete':
      await handleDelete(positional, flags)
      break
    case 'sync-templates':
      await handleSyncTemplates(flags)
      break
    case 'sync-nodes':
      await handleSyncNodes()
      break
    case 'pack': {
      const subcommand = positional[0]
      const subPositional = positional.slice(1)
      if (subcommand === 'export') {
        await handlePackExport(subPositional, flags)
      } else if (subcommand === 'wire') {
        await handlePackWire(subPositional, flags)
      } else {
        console.error(`Unknown pack subcommand: ${subcommand ?? '(none)'}`)
        console.error('Available: kairos pack export <name> [--handoff] | kairos pack wire <name> [options]')
        process.exit(1)
      }
      break
    }
    case 'memory': {
      const subcommand = positional[0]
      const subPositional = positional.slice(1)
      if (subcommand === 'add') {
        await handleMemoryAdd(subPositional, flags)
      } else if (subcommand === 'list') {
        await handleMemoryList(subPositional, flags)
      } else if (subcommand === 'search') {
        await handleMemorySearch(subPositional, flags)
      } else if (subcommand === 'forget') {
        await handleMemoryForget(subPositional)
      } else if (subcommand === 'rebuild-index') {
        await handleMemoryRebuildIndex(subPositional)
      } else {
        console.error(`Unknown memory subcommand: ${subcommand ?? '(none)'}`)
        console.error('Available: kairos memory add|list|search|forget|rebuild-index <client-id> [...]')
        process.exit(1)
      }
      break
    }
    case 'validate-pack':
      await handleValidatePack(positional)
      break
    case 'preflight':
      await handlePreflight(positional, flags)
      break
    case 'trace':
      await handleTrace(positional)
      break
    case 'contract':
      await handleContract(positional, flags)
      break
    case 'ledger':
      await handleLedger(positional, flags)
      break
    case 'exceptions':
      await handleExceptions(positional, flags)
      break
    case 'drift':
      await handleDrift(positional, flags)
      break
    case 'sandbox':
      await handleSandbox(positional, flags)
      break
    case 'replay':
      await handleReplay(positional, flags)
      break
    case 'chaos':
      await handleChaos(positional, flags)
      break
    case 'watch':
      await handleWatch(positional, flags)
      break
    case 'repair':
      await handleRepair(positional, flags)
      break
    case 'rollback':
      await handleRollback(positional, flags)
      break
    case 'library': {
      const subcommand = positional[0]
      if (subcommand === 'prune') {
        await handleLibraryPrune(flags)
      } else {
        console.error(`Unknown library subcommand: ${subcommand ?? '(none)'}`)
        console.error('Available: kairos library prune --source <organic|n8n-template|imported> [--dry-run]')
        process.exit(1)
      }
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`)
    if ('issues' in err && Array.isArray((err as Record<string, unknown>).issues)) {
      for (const issue of (err as Record<string, unknown>).issues as Array<{ rule: number; message: string }>) {
        console.error(`  [Rule ${issue.rule}] ${issue.message}`)
      }
    }
  } else {
    console.error(String(err))
  }
  process.exit(1)
})
