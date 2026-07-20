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
Kairos SDK — LLM-powered n8n workflow generation

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
  kairos contract validate <file.json> [--json]
  kairos drift baseline <n8n-workflow-id> [--json]
  kairos drift check <n8n-workflow-id> [--live] [--original-build-hash <hash>] [--json]
  kairos sandbox up [--port <n>]
  kairos sandbox status [--json]
  kairos sandbox down
  kairos replay capture <n8n-workflow-id> --client-id <slug> [--limit <n>] [--scrub] [--json]
  kairos replay run <n8n-workflow-id> --candidate <file> --client-id <slug> [--live] [--verbose] [--json]
  kairos replay purge <n8n-workflow-id> --client-id <slug> [--json]
  kairos chaos audit <n8n-workflow-id> [--json]
  kairos chaos run <n8n-workflow-id> [--json]
  kairos watch --workflows <ids|all> [--interval <s>] [--on-drift <cmd>] [--once] [--json]
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

Contract options (ProcessContract v0, Phase 0+1 -- see docs/plans/process-contract-promise-engine-plan.md):
  contract plan "<description>"  Draft a ProcessContract from a plain-language business
    --client-id <slug>           description via an LLM (requires ANTHROPIC_API_KEY). Always run
                                  through the deterministic validator before being returned;
                                  always saved to ~/.kairos/contracts/<client-id>/<id>.json for
                                  human review, even when it needs review -- never withheld. Exits
                                  2 (not 1) when the draft has a validation error or a blocking
                                  assumption, distinguishing "needs a human" from a hard failure.
  contract validate <file.json>  Validate a ProcessContract JSON file against the deterministic
                                  contract validator (reachability, terminal-state consistency,
                                  dangling references, business-calendar consistency). Fully
                                  offline. ProcessContract is deliberately separate from PackPlan
                                  (a contract describes a business promise; a pack describes
                                  workflows to build). contract compile (Phase 2, PackPlan
                                  compilation) is not built yet -- no ProofLedger, no
                                  ExceptionDesk, no workflow reporting/listener, no autonomous
                                  business decisions.

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
  const { saveProcessContract } = await import('./promise/store.js')

  console.error('Drafting ProcessContract...\n')
  const result = await planProcessContract({ description, clientId, anthropicApiKey })
  const { path } = await saveProcessContract(result.contract)

  if (flags['json'] === true) {
    console.log(JSON.stringify({ ...result, savedTo: path }, null, 2))
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
  console.log(readyToProceed ? '\n✓ Ready for human review -- no blocking issues.' : '\n⚠ Needs human review before this contract can be trusted.')

  if (!readyToProceed) process.exit(2)
}

async function handleContract(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]

  if (subcommand === 'plan') {
    await handleContractPlan(positional, flags)
    return
  }

  if (subcommand === 'compile') {
    console.error(`kairos contract ${subcommand} is not built yet -- Phase 0/1 (docs/plans/process-contract-promise-engine-plan.md) ship the schema, validator, and LLM-assisted authoring only.`)
    console.error('Run "kairos contract plan" to draft a contract, or "kairos contract validate <file.json>" against a hand-authored one.')
    process.exit(1)
  }

  if (subcommand !== 'validate') {
    console.error('Usage: kairos contract plan "<business description>" --client-id <slug> [--json]')
    console.error('       kairos contract validate <file.json> [--json]')
    console.error('')
    console.error('plan drafts a ProcessContract from a plain-language description via an LLM,')
    console.error('then always runs it through the deterministic validator before returning it.')
    console.error('')
    console.error("validate checks a ProcessContract JSON file against Kairos's deterministic")
    console.error('contract validator -- reachability, terminal-state consistency, dangling')
    console.error('references, business-calendar consistency, and more. Fully offline: no')
    console.error('Anthropic/n8n API calls, no credentials required.')
    console.error('')
    console.error('Phase 0/1 only -- there is no `kairos contract compile` yet (docs/plans/')
    console.error('process-contract-promise-engine-plan.md).')
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

  if (flags['json'] === true) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatReplayReportForHumans(result))
    if (flags['verbose'] === true) {
      console.log('')
      console.log('--- Technical detail (--verbose) ---')
      console.log(formatReplayRunResult(result))
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
  if (result.status !== 'completed' || (result.verdict !== 'IDENTICAL' && result.verdict !== 'BENIGN_VARIANCE')) {
    process.exit(1)
  }
}

async function handleChaos(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0]
  const n8nWorkflowId = positional[1]

  if ((subcommand !== 'audit' && subcommand !== 'run') || !n8nWorkflowId) {
    console.error('Usage: kairos chaos audit <n8n-workflow-id> [--json]')
    console.error('       kairos chaos run <n8n-workflow-id> [--json]')
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

  if (flags['json'] === true) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatChaosSandboxRunResult(result, n8nWorkflowId))
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
  // judge, not an automatic failure).
  if (result.status !== 'completed' || result.summary.crashed > 0 || result.summary.incomplete > 0) {
    process.exit(1)
  }
}

// Conservative by design (Phase 6 design-verification pass, docs/plans/reliability-suite-plan.md
// 11): fetchLatestTrace is cheap (2 API calls/workflow/tick) and N8nApiClient already retries
// 429s with backoff, but no live rate-limit ceiling was empirically probed against production-
// adjacent infrastructure to find a tighter "safe" number -- erring long is the safer default,
// tightened later from real usage data, not guessed tighter now.
const DEFAULT_WATCH_INTERVAL_SECONDS = 300

async function handleWatch(_positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const workflowsFlag = typeof flags['workflows'] === 'string' ? flags['workflows'] : undefined
  if (!workflowsFlag) {
    console.error('Usage: kairos watch --workflows <ids|all> [--interval <s>] [--on-drift <cmd>] [--once] [--json]')
    console.error('')
    console.error('Detect -> diagnose -> notify -> audit only -- no propose/apply/rollback (Phase 3,')
    console.error('not built yet). Runs a foreground loop by default (Ctrl-C to stop); --once runs a')
    console.error('single tick and exits, for cron/launchd. --workflows all watches every deployed')
    console.error('library entry; a comma-separated list of n8n workflow IDs watches only those.')
    console.error('Every tick is appended to ~/.kairos/reliability-audit.jsonl regardless of verdict.')
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
  const once = flags['once'] === true
  const asJson = flags['json'] === true

  const { runWatchTick, formatWatchTickForHumans } = await import('./reliability/watch/loop.js')
  const { notifyTick } = await import('./reliability/watch/notify.js')

  const lib = createLibrary()
  await lib.initialize()

  const requestedIds = workflowsFlag === 'all' ? null : workflowsFlag.split(',').map(s => s.trim())

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
    const targets = await resolveTargets()
    if (targets.length === 0) {
      console.error('No deployed workflows match --workflows. Nothing to check this tick.')
      return
    }

    const results = await runWatchTick(lib, targets, n8nBaseUrl, n8nApiKey)

    if (asJson) {
      console.log(JSON.stringify(results, null, 2))
    } else {
      console.log(formatWatchTickForHumans(results))
    }

    await notifyTick(results, onDriftCommand ? { onDriftCommand } : {})
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
