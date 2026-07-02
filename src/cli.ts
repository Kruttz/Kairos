#!/usr/bin/env node

import { Kairos } from './client.js'
import { FileLibrary } from './library/file-library.js'
import { TemplateSyncer } from './templates/syncer.js'
import { PatternAnalyzer } from './telemetry/pattern-analyzer.js'

const HELP = `
Kairos SDK — LLM-powered n8n workflow generation

Usage:
  kairos init                         First-time setup wizard
  kairos build <description> [options]
  kairos build-pack <business context> [options]
  kairos pack export <name> [--handoff]
  kairos pack wire <name> [--sheet-ids <json-or-path>] [--dry-run]
  kairos validate-pack <name>
  kairos trace record <n8n-workflow-id>
  kairos replace <n8n-id> <description>
  kairos patterns [options]
  kairos sessions [options]
  kairos list
  kairos get <id>
  kairos activate <id>
  kairos deactivate <id>
  kairos delete <id> --confirm
  kairos sync-templates [options]
  kairos sync-templates --from-dir <path> [options]
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
  pack wire <name>            Patch deployed workflows with real Google Sheet IDs
  validate-pack <name>        Cross-workflow safety check before activation

Patterns options:
  --days <days>   Analysis window (default: 30)
  --json          Output raw JSON instead of summary

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
  KAIROS_TELEMETRY        Set to "true" or a directory path to enable telemetry logging
  KAIROS_PROMPT_PROFILE   minimal | standard | rich (default: standard)
                          minimal: base prompt only, no library context, top 3 patterns
                          standard: full library context, top 10 patterns (default)
                          rich: full library context, top 15 patterns, proactive expression guidance
  KAIROS_LIBRARY_SIZE     Max library entries before oldest/least-used are evicted (default: 1500)
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

function createClient(): Kairos {
  const telemetry = getTelemetryOption()
  return new Kairos({
    anthropicApiKey: getEnvOrExit('ANTHROPIC_API_KEY'),
    n8nBaseUrl: getEnvOrExit('N8N_BASE_URL'),
    n8nApiKey: getEnvOrExit('N8N_API_KEY'),
    ...(process.env['KAIROS_MODEL'] ? { model: process.env['KAIROS_MODEL'] } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    library: new FileLibrary(),
    logger: CLI_LOGGER,
  })
}

function createDryRunClient(): Kairos {
  const telemetry = getTelemetryOption()
  return new Kairos({
    anthropicApiKey: getEnvOrExit('ANTHROPIC_API_KEY'),
    ...(process.env['N8N_BASE_URL'] ? { n8nBaseUrl: process.env['N8N_BASE_URL'] } : {}),
    ...(process.env['N8N_API_KEY'] ? { n8nApiKey: process.env['N8N_API_KEY'] } : {}),
    ...(process.env['KAIROS_MODEL'] ? { model: process.env['KAIROS_MODEL'] } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    library: new FileLibrary(),
    logger: CLI_LOGGER,
  })
}

async function handleBuild(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const description = positional.join(' ')
  if (!description) {
    console.error('Usage: kairos build <description> [--dry-run] [--name <name>] [--activate] [--smoke-test]')
    process.exit(1)
  }

  const isDryRun = flags['dry-run'] === true
  const kairos = isDryRun ? createDryRunClient() : createClient()
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

  console.log(JSON.stringify({
    workflowId: result.workflowId,
    name: result.name,
    generationAttempts: result.generationAttempts,
    activationRequired: result.activationRequired,
    dryRun: result.dryRun,
    credentialsNeeded: result.credentialsNeeded,
    ...(result.dryRun ? { workflow: result.workflow } : {}),
    ...(result.smokeTest ? { smokeTest: result.smokeTest } : {}),
  }, null, 2))
}

async function handleReplace(positional: string[]): Promise<void> {
  const id = positional[0]
  const description = positional.slice(1).join(' ')

  if (!id || !description) {
    console.error('Usage: kairos replace <n8n-workflow-id> <description>')
    process.exit(1)
  }

  const kairos = createClient()
  const start = Date.now()
  console.error(`Replacing workflow ${id}...`)

  const result = await kairos.replace(id, description)
  await kairos.drain()

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.error(`Done in ${elapsed}s (${result.generationAttempts} attempt${result.generationAttempts > 1 ? 's' : ''})`)
  console.error('')

  console.log(JSON.stringify({
    workflowId: result.workflowId,
    name: result.name,
    generationAttempts: result.generationAttempts,
  }, null, 2))
}

async function handleList(): Promise<void> {
  const kairos = createClient()
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

  const kairos = createClient()
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

  const kairos = createClient()
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

  const kairos = createClient()
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

  const kairos = createClient()
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

  const library = new FileLibrary()
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
  const library = new FileLibrary()
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
  const library = new FileLibrary()
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

  const active = analysis.topFailureRules.filter(p => p.state !== 'resolved')
  const resolved = analysis.topFailureRules.filter(p => p.state === 'resolved')

  if (active.length > 0) {
    console.log(`\nActive Failure Patterns:`)
    for (const p of active) {
      const regressionTag = p.regressed ? '[REGRESSION] ' : ''
      const stateTag = p.state === 'confirmed' ? '[CONFIRMED]' : '[DRAFT]'
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
    }
  } else {
    console.log(`\nNo active failure patterns.`)
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
    console.error('Usage: kairos build-pack <business context description> [--dry-run] [--activate] [--yes]')
    process.exit(1)
  }

  const anthropicKey = getEnvOrExit('ANTHROPIC_API_KEY')
  const { PackBuilder } = await import('./pack/pack-builder.js')
  const isDryRun = flags['dry-run'] === true
  const kairos = isDryRun ? createDryRunClient() : createClient()
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
    onProgress: (wf, i, total) => {
      console.error(`  [${i + 1}/${total}] ${wf.name}...`)
    },
  })

  printPackResult(result)

  const { writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const packsDir = join(homedir(), '.kairos', 'packs')
  await mkdir(packsDir, { recursive: true })
  const packPath = join(packsDir, `${result.packName}.json`)
  await writeFile(packPath, JSON.stringify(result, null, 2), 'utf-8')
  console.error(`\nPack saved to: ${packPath}`)
}

async function handlePackExport(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const packName = positional[0]
  if (!packName) {
    console.error('Usage: kairos pack export <pack-name> [--handoff]')
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

  if (flags['handoff'] === true) {
    const { generateHandoff } = await import('./pack/pack-exporter.js')
    console.log(generateHandoff(pack))
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
    process.exit(1)
  }

  const n8nBaseUrl = process.env['N8N_BASE_URL']
  const n8nApiKey = process.env['N8N_API_KEY']
  if (!n8nBaseUrl || !n8nApiKey) {
    console.error('N8N_BASE_URL and N8N_API_KEY are required for trace record.')
    process.exit(1)
  }

  console.error(`Fetching latest execution for workflow ${n8nWorkflowId}...`)

  const { fetchLatestTrace } = await import('./telemetry/execution-tracer.js')
  const trace = await fetchLatestTrace(n8nWorkflowId, n8nBaseUrl, n8nApiKey)

  if (!trace) {
    console.error('No executions found for this workflow, or could not reach n8n.')
    process.exit(1)
  }

  console.error(`Execution ${trace.executionId}: status=${trace.status}, nodes=${trace.executedNodes.length}, errors=${trace.erroredNodes.length}`)

  // Find matching library entry by n8nWorkflowId
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const { FileLibrary } = await import('./library/file-library.js')
  const lib = new FileLibrary(join(homedir(), '.kairos', 'library'))
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
  console.log(JSON.stringify({
    libraryId: match.id,
    workflowDescription: match.description,
    executionId: trace.executionId,
    status: trace.status,
    durationMs: trace.durationMs,
    executedNodes: trace.executedNodes.length,
    erroredNodes: trace.erroredNodes,
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

  const library = new FileLibrary()
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
      await handleReplace(positional)
      break
    case 'patterns':
      await handlePatterns(flags)
      break
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
    case 'validate-pack':
      await handleValidatePack(positional)
      break
    case 'trace':
      await handleTrace(positional)
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
