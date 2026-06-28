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
  kairos replace <n8n-id> <description>
  kairos patterns [options]
  kairos sessions [options]
  kairos list
  kairos get <id>
  kairos activate <id>
  kairos deactivate <id>
  kairos delete <id> --confirm
  kairos sync-templates [options]

Build options:
  --dry-run       Generate and validate without deploying
  --name <name>   Override the generated workflow name
  --activate      Activate the workflow after deployment

Patterns options:
  --days <days>   Analysis window (default: 30)
  --json          Output raw JSON instead of summary

Sessions options:
  --limit <n>     Number of recent sessions to show (default: 20)
  --json          Output raw JSON instead of summary

Sync options:
  --max <count>   Maximum templates to fetch (default: 500)

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
    console.error('Usage: kairos build <description> [--dry-run] [--name <name>] [--activate]')
    process.exit(1)
  }

  const isDryRun = flags['dry-run'] === true
  const kairos = isDryRun ? createDryRunClient() : createClient()
  const start = Date.now()

  console.error(`Generating workflow...`)

  const result = await kairos.build(description, {
    dryRun: isDryRun,
    ...(typeof flags['name'] === 'string' ? { name: flags['name'] } : {}),
    activate: flags['activate'] === true,
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

async function handleSyncTemplates(flags: Record<string, string | boolean>): Promise<void> {
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

  console.error('')
  console.error('  Setup complete! Try:')
  console.error('')
  console.error('    kairos build "Send a Slack message when a webhook fires" --dry-run')
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
