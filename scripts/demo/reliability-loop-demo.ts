/**
 * Kairos reliability loop — end-to-end demo and regression check.
 *
 * Runs the real `kairos` CLI (not internal functions directly) against a real, disposable
 * local n8n sandbox: chaos-audits a workflow statically, deploys it, baselines a healthy
 * execution, induces a real drift condition, then runs `kairos watch --once` and confirms it
 * catches, diagnoses, and notifies. Scope matches Phase 6's corrected shape (Codex, 2026-07-19):
 * stops at notify -- no propose/apply/rollback, since `repair.ts` (Phase 3) doesn't exist yet.
 * When Phase 3 ships, this script gets extended with those steps, not replaced.
 *
 * Uses a hand-built fixture workflow rather than real Claude generation, so this can run
 * without ANTHROPIC_API_KEY and repeatedly without API cost -- the interesting part of this
 * demo is chaos/drift/watch, not generation quality (that's scripts/benchmark.ts's job).
 *
 * Usage:
 *   npx tsx scripts/demo/reliability-loop-demo.ts
 *
 * Requires: nothing pre-existing -- boots its own disposable sandbox (no Docker, no
 * production credentials) and cleans up after itself (sandbox stopped, temp library removed).
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootSandbox, importToSandbox, stopSandbox } from '../../src/reliability/sandbox/manager.js'
import { N8nApiClient } from '../../src/providers/n8n/api-client.js'
import { nullLogger } from '../../src/utils/logger.js'
import { FileLibrary } from '../../src/library/file-library.js'
import type { N8nWorkflow } from '../../src/types/workflow.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../src/cli.ts')

function step(title: string): void {
  console.log('')
  console.log(`━━━ ${title} ━━━`)
}

function runCli(args: string[], env: Record<string, string>): { stdout: string; status: number | null } {
  const result = spawnSync(TSX, [CLI, ...args], { encoding: 'utf-8', env: { ...process.env, ...env }, timeout: 30_000 })
  console.log(result.stdout.trim())
  if (result.stderr.trim()) console.error(result.stderr.trim())
  return { stdout: result.stdout, status: result.status }
}

// Deliberately unguarded reference to $json.body.customerPhone (no || / ?? fallback) --
// Tier A (`chaos audit`) should predict this breaks; the Code node's real logic below (which
// checks the same field via $input, not a {{ }} expression) is what actually crashes.
function demoWorkflow(): N8nWorkflow {
  return {
    name: 'Reliability Loop Demo Workflow',
    nodes: [
      { id: 'trigger', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'reliability-loop-demo', httpMethod: 'POST' } },
      {
        id: 'validate', name: 'Validate Phone', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0],
        parameters: {
          language: 'javaScript',
          // The leading comment is inside the jsCode string on purpose, and wrapped in {{ }} --
          // chaos audit's field-ref scanner (static-audit.ts) only looks inside {{ }} expression
          // blocks (unlike webhook-schema.ts's extractWebhookFieldRefs, which matches anywhere).
          // The actual crash logic below reads the field via plain $input, a different syntax
          // the scanner doesn't recognize -- the comment is what lets Tier A find and predict
          // this specific field reference at all, without changing what the node actually does.
          jsCode: "// References: {{$json.body.customerPhone}}\nconst body = $input.first().json.body || {};\nif (typeof body.customerPhone !== 'string' || body.customerPhone.length === 0) {\n  throw new Error('customerPhone is required');\n}\nreturn $input.all();",
        },
      },
    ],
    connections: { Webhook: { main: [[{ node: 'Validate Phone', type: 'main', index: 0 }]] } },
    settings: {},
  }
}

function brokenDemoWorkflow(registeredPath: string): N8nWorkflow {
  return {
    name: 'Reliability Loop Demo Workflow',
    nodes: [
      { id: 'trigger', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: registeredPath, httpMethod: 'POST' } },
      {
        id: 'validate', name: 'Validate Phone', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0],
        parameters: { language: 'javaScript', jsCode: "throw new Error('reliability-loop-demo: induced failure');" },
      },
    ],
    connections: { Webhook: { main: [[{ node: 'Validate Phone', type: 'main', index: 0 }]] } },
    settings: {},
  }
}

async function waitForExecution(client: N8nApiClient, workflowId: string, beforeIds: Set<string>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const executions = await client.getExecutions(workflowId, { limit: 5 })
    if (executions.some(e => !beforeIds.has(e.id))) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`no fresh execution appeared for workflow ${workflowId} within ${timeoutMs}ms`)
}

async function trigger(client: N8nApiClient, workflowId: string, path: string, method: string, body: unknown = {}): Promise<void> {
  const before = new Set((await client.getExecutions(workflowId, { limit: 5 })).map(e => e.id))
  await client.triggerWebhookProduction(path, method, body)
  await waitForExecution(client, workflowId, before)
}

async function main(): Promise<void> {
  const libraryDir = await mkdtemp(join(tmpdir(), 'kairos-reliability-demo-'))
  const hookLogPath = join(libraryDir, 'drift-alert.json')

  try {
    step('1/6 — Booting a disposable local sandbox (no Docker, never production)')
    const config = await bootSandbox()
    const client = new N8nApiClient(config.baseUrl, config.apiKey, nullLogger)
    console.log(`Sandbox running at ${config.baseUrl}.`)

    step('2/6 — Registering the demo workflow in a disposable library (kairos chaos audit needs a library entry)')
    const imported = await importToSandbox(config, demoWorkflow(), 'reliability-loop-demo')
    await client.activateWorkflow(imported.id)
    const trigger1 = imported.webhookTrigger!

    const lib = new FileLibrary(libraryDir)
    await lib.initialize()
    const libId = await lib.save(demoWorkflow(), { description: 'Reliability loop demo workflow' })
    await lib.recordDeployment(libId, imported.id)

    const cliEnv = { N8N_BASE_URL: config.baseUrl, N8N_API_KEY: config.apiKey, KAIROS_LIBRARY_DIR: libraryDir }

    step('3/6 — kairos chaos audit (Tier A, static prediction, no execution)')
    const audit = runCli(['chaos', 'audit', imported.id], cliEnv)
    if (!audit.stdout.includes('customerPhone')) throw new Error('DEMO CHECK FAILED: chaos audit did not flag the unguarded customerPhone reference')

    step('4/6 — Triggering a healthy execution, then kairos watch --once (baseline tick)')
    await trigger(client, imported.id, trigger1.path, trigger1.httpMethod, { customerPhone: '555-0100' })
    const tick1 = runCli(['watch', '--workflows', imported.id, '--once'], cliEnv)
    if (!tick1.stdout.includes('HEALTHY')) throw new Error('DEMO CHECK FAILED: baseline tick did not report HEALTHY')

    step('5/6 — Inducing real drift (redeploying with a Code node that now always throws), then triggering it again')
    await client.updateWorkflow(imported.id, brokenDemoWorkflow(trigger1.path))
    await new Promise(r => setTimeout(r, 1000))
    await trigger(client, imported.id, trigger1.path, trigger1.httpMethod, { customerPhone: '555-0100' })

    step('6/6 — kairos watch --once again (should now catch, diagnose, and notify)')
    const tick2 = runCli(['watch', '--workflows', imported.id, '--once', '--on-drift', `cat > ${hookLogPath}`], cliEnv)
    if (!tick2.stdout.includes('DRIFTING')) throw new Error('DEMO CHECK FAILED: second tick did not detect the induced drift')
    if (!tick2.stdout.includes('DRIFT ALERT')) throw new Error('DEMO CHECK FAILED: no stdout alert was printed for the drifting workflow')

    const hookPayload = JSON.parse(await readFile(hookLogPath, 'utf-8'))
    if (hookPayload.report?.verdict !== 'DRIFTING') throw new Error('DEMO CHECK FAILED: --on-drift hook did not receive the drifting result')

    step('Done')
    console.log('The reliability loop caught, diagnosed, and notified on a real induced failure --')
    console.log('exactly as far as Phase 6 goes today. Self-healing (propose/apply/rollback) is the')
    console.log('next phase, not built yet -- this script will grow those steps when it ships.')
  } finally {
    await stopSandbox().catch(() => {})
    await rm(libraryDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((err) => {
  console.error('')
  console.error('DEMO FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
