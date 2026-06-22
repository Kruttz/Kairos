#!/usr/bin/env node

import { Kairos } from './client.js'
import { FileLibrary } from './library/file-library.js'

const HELP = `
Kairos SDK — LLM-powered n8n workflow generation

Usage:
  kairos build <description> [options]
  kairos list
  kairos get <id>
  kairos activate <id>
  kairos deactivate <id>
  kairos delete <id> --confirm

Build options:
  --dry-run       Generate and validate without deploying
  --name <name>   Override the generated workflow name
  --activate      Activate the workflow after deployment

Environment variables:
  ANTHROPIC_API_KEY  Anthropic API key (required)
  N8N_BASE_URL       n8n instance URL (required)
  N8N_API_KEY        n8n API key (required)
  KAIROS_MODEL       Claude model override (default: claude-sonnet-4-6)
  KAIROS_TELEMETRY   Set to "true" or a directory path to enable telemetry logging
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

function createClient(): Kairos {
  const telemetryEnv = process.env['KAIROS_TELEMETRY']
  let telemetry: boolean | string | undefined
  if (telemetryEnv === 'true') {
    telemetry = true
  } else if (telemetryEnv && telemetryEnv !== 'false') {
    telemetry = telemetryEnv
  }

  return new Kairos({
    anthropicApiKey: getEnvOrExit('ANTHROPIC_API_KEY'),
    n8nBaseUrl: getEnvOrExit('N8N_BASE_URL'),
    n8nApiKey: getEnvOrExit('N8N_API_KEY'),
    ...(process.env['KAIROS_MODEL'] ? { model: process.env['KAIROS_MODEL'] } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    library: new FileLibrary(),
    logger: {
      debug: () => {},
      info: () => {},
      warn: (msg) => console.error(`[warn] ${msg}`),
      error: (msg) => console.error(`[error] ${msg}`),
    },
  })
}

async function handleBuild(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const description = positional[0]
  if (!description) {
    console.error('Usage: kairos build <description> [--dry-run] [--name <name>] [--activate]')
    process.exit(1)
  }

  const kairos = createClient()
  const start = Date.now()

  console.error(`Generating workflow...`)

  const result = await kairos.build(description, {
    dryRun: flags['dry-run'] === true,
    ...(typeof flags['name'] === 'string' ? { name: flags['name'] } : {}),
    activate: flags['activate'] === true,
  })

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
  }, null, 2))
}

async function handleList(): Promise<void> {
  const kairos = createClient()
  const workflows = await kairos.list()

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
  console.log(`Deleted workflow ${id}`)
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv)

  if (!command || command === 'help' || flags['help'] === true) {
    console.log(HELP)
    return
  }

  switch (command) {
    case 'build':
      await handleBuild(positional, flags)
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
    default:
      console.error(`Unknown command: ${command}`)
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`)
    if ('issues' in err) {
      const issues = (err as { issues: Array<{ rule: number; message: string }> }).issues
      for (const issue of issues) {
        console.error(`  [Rule ${issue.rule}] ${issue.message}`)
      }
    }
  } else {
    console.error(err)
  }
  process.exit(1)
})
