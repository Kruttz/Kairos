import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, chmod, open } from 'node:fs/promises'
import { GuardError } from '../../errors/guard-error.js'
import { N8nApiClient } from '../../providers/n8n/api-client.js'
import { nullLogger } from '../../utils/logger.js'
import { fetchWithTimeout } from '../../utils/retry.js'
import type { N8nWorkflow, N8nNode } from '../../types/workflow.js'

/**
 * Sandbox lifecycle: boot/provision a disposable local n8n, guarantee it can never be
 * mistaken for or point at production, and scope every write to workflows Kairos itself
 * created there. Every guardrail in this module is enforced in code and tested directly
 * (Jordan/Codex, 2026-07-19) -- not documentation, not convention.
 *
 * Design is entirely the product of the Phase 0 spikes (docs/plans/reliability-suite-plan.md
 * S2/S3), not guessed: exact scopes, exact endpoints, and the readiness-timing gotcha below
 * all came from actually booting a real local n8n and watching what happened.
 */

/** Every workflow this module creates in the sandbox carries this prefix. The one and only
 * thing cleanup ever deletes -- never "everything in the sandbox," always "things bearing
 * this exact mark," so a bug elsewhere in this module can never widen the blast radius of a
 * delete. */
export const SANDBOX_WORKFLOW_PREFIX = '[kairos-sandbox]'

/** Pinned, not `@latest` -- S2's own finding: n8n's deprecation warnings already signal
 * upcoming behavior changes (forced Docker, env-var default changes). An unpinned version
 * could silently invalidate the spike's verified findings (scopes, endpoints, readiness
 * timing) on a future run. Bump deliberately, re-verify against this same spike process, not
 * automatically. */
const PINNED_N8N_VERSION = '2.30.7'

const DEFAULT_SANDBOX_PORT = 15679
const SANDBOX_DIR = join(homedir(), '.kairos', 'sandbox')
const SANDBOX_USER_FOLDER = join(SANDBOX_DIR, 'n8n-data')
const SANDBOX_CONFIG_PATH = join(SANDBOX_DIR, 'sandbox.json')
const SANDBOX_PIDFILE_PATH = join(SANDBOX_DIR, 'sandbox.pid')
const SANDBOX_LOG_PATH = join(SANDBOX_DIR, 'boot.log')

/** Local-only marker credentials for a disposable sandbox instance nothing external ever
 * authenticates against -- not a secret, the value doesn't matter, only that it's stable
 * across boots so the same owner account is reused rather than re-created. */
const SANDBOX_OWNER_EMAIL = 'kairos-sandbox@localhost.kairos'
const SANDBOX_OWNER_PASSWORD = 'KairosSandboxLocalOnly!2026'

/** Confirmed working set from S2 -- the minimum covering everything N8nApiClient calls
 * (create/read/update/delete/list/activate/deactivate workflows, read/list/delete
 * executions, create/list tags, update workflow tags). Recorded verbatim, not re-derived by
 * trial and error: `workflow:execute` does not exist as a scope name (a real 400 from the
 * spike), `workflow:activate`/`workflow:deactivate` do. */
const SANDBOX_API_KEY_SCOPES = [
  'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:list',
  'workflow:activate', 'workflow:deactivate',
  'execution:read', 'execution:list', 'execution:delete',
  'tag:create', 'tag:list', 'workflowTags:update',
]

export interface SandboxConfig {
  baseUrl: string
  apiKey: string
  /** Distinguishes a loaded config from an arbitrary object by shape, not just file
   * location, before it's ever treated as sandbox-authoritative anywhere in this module. */
  isKairosSandbox: true
  n8nVersion: string
  provisionedAt: string
}

/**
 * Refuses to treat a URL as a sandbox if it resolves to the same origin as the configured
 * production N8N_BASE_URL. This is the single guardrail every other function in this module
 * calls before doing anything -- not a one-time check at boot, a re-check at every write
 * path, so a bug or stale config elsewhere can never bypass it (defense in depth, cheap: a
 * string comparison).
 */
export function assertNotProduction(candidateBaseUrl: string): void {
  const productionUrl = process.env['N8N_BASE_URL']
  if (!productionUrl) return

  let candidateOrigin: string
  let productionOrigin: string
  try {
    candidateOrigin = new URL(candidateBaseUrl).origin
    productionOrigin = new URL(productionUrl).origin
  } catch {
    // An unparseable URL on either side can't be proven equal -- fail open on the guard
    // (don't block), the caller's own URL validation (N8nApiClient's constructor) will
    // reject a malformed URL on its own terms.
    return
  }

  if (candidateOrigin === productionOrigin) {
    throw new GuardError(
      `Refusing to treat ${candidateBaseUrl} as a sandbox -- it resolves to the same origin as the configured production N8N_BASE_URL (${productionUrl}). Chaos and replay must never execute against production.`,
    )
  }
}

function sandboxBaseUrl(port: number): string {
  return `http://localhost:${port}`
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

export async function loadSandboxConfig(): Promise<SandboxConfig | null> {
  const config = await readJsonIfExists<SandboxConfig>(SANDBOX_CONFIG_PATH)
  if (!config || config.isKairosSandbox !== true) return null
  return config
}

async function saveSandboxConfig(config: SandboxConfig): Promise<void> {
  await mkdir(SANDBOX_DIR, { recursive: true })
  await writeFile(SANDBOX_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  // Holds a real, if low-value, API key -- chmod 600 regardless (same discipline as the
  // capture spec's payload files), not because this specific key is high-stakes.
  await chmod(SANDBOX_CONFIG_PATH, 0o600)
}

/**
 * Polls until the instance is genuinely ready to accept API calls, not just until the
 * process is listening. S1's own finding: on a real boot, /healthz returned 200 several
 * seconds before /rest/login stopped 404ing -- a health check alone is not a readiness
 * check for this specific server. Treats any non-404 response (200/401/400 alike -- the
 * actual status doesn't matter, only that the REST router is mounted) as ready.
 */
async function waitUntilReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/rest/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 5_000)
      if (res.status !== 404) return
    } catch (err) {
      lastError = err
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }

  throw new GuardError(`Sandbox at ${baseUrl} did not become ready within ${timeoutMs}ms.${lastError ? ` Last error: ${String(lastError)}` : ''}`)
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0) // signal 0: existence check only, doesn't actually signal anything
    return true
  } catch {
    return false
  }
}

/**
 * Boots the sandbox if not already running, provisions an owner account + API key on first
 * boot only (subsequent boots reuse the persisted config -- the n8n instance's own SQLite DB
 * under SANDBOX_USER_FOLDER already remembers the owner account across restarts, so
 * re-provisioning would be redundant, not just slow).
 */
export async function bootSandbox(options?: { port?: number; bootTimeoutMs?: number }): Promise<SandboxConfig> {
  const port = options?.port ?? DEFAULT_SANDBOX_PORT
  const baseUrl = sandboxBaseUrl(port)
  assertNotProduction(baseUrl)

  const existing = await loadSandboxConfig()
  if (existing && existing.baseUrl === baseUrl) {
    const pid = await readJsonIfExists<{ pid: number }>(SANDBOX_PIDFILE_PATH)
    if (pid && await isProcessAlive(pid.pid)) {
      return existing // already running, already provisioned -- nothing to do
    }
  }

  await mkdir(SANDBOX_DIR, { recursive: true })
  await mkdir(SANDBOX_USER_FOLDER, { recursive: true })

  const logFd = await open(SANDBOX_LOG_PATH, 'a')
  const child = spawn('npx', ['--yes', `n8n@${PINNED_N8N_VERSION}`, 'start'], {
    env: {
      ...process.env,
      N8N_USER_FOLDER: SANDBOX_USER_FOLDER,
      N8N_PORT: String(port),
      // Found live: n8n's internal Task Broker sub-process binds a SEPARATE port,
      // independent of N8N_PORT, defaulting to a fixed 5679 regardless of the main HTTP
      // port. Any other n8n instance already running on this machine (a real user's own
      // dev/production instance, or -- as happened during this arc's own CLI checkpoint -- a
      // second test instance) collides on that fixed port even though the main HTTP ports
      // never overlap ("n8n Task Broker's port 5679 is already in use"). Derived
      // deterministically from the sandbox's own configured port so it's unique per sandbox
      // instance without needing a second port option surfaced to callers.
      N8N_RUNNERS_BROKER_PORT: String(port + 10_000),
      N8N_DIAGNOSTICS_ENABLED: 'false',
      N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    },
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
  })
  child.unref()
  await logFd.close()
  await writeFile(SANDBOX_PIDFILE_PATH, JSON.stringify({ pid: child.pid }), 'utf-8')

  // 120s (the original default) was measured against a warm npm cache and proved too short
  // live: a genuinely cold environment (no prior npx n8n install anywhere under this HOME)
  // took over 120s just installing dependencies before n8n's own boot sequence even started.
  // 300s covers a real cold install with margin; a warm re-boot (the common case -- the
  // package is cached after the first run) still returns in seconds, well under this ceiling.
  await waitUntilReady(baseUrl, options?.bootTimeoutMs ?? 300_000)

  if (existing && existing.baseUrl === baseUrl) {
    // Process had died and was just restarted, but a config already exists (same instance,
    // same persisted n8n DB) -- reuse it rather than re-provisioning against an owner
    // account that already exists.
    return existing
  }

  return provisionSandbox(baseUrl)
}

async function provisionSandbox(baseUrl: string): Promise<SandboxConfig> {
  assertNotProduction(baseUrl)

  // Two separate live-checkpoint failures established that different REST routes mount at
  // different times during n8n's own startup sequence -- waitUntilReady's /rest/login probe
  // succeeding is not proof /rest/owner/setup is mounted yet (observed: a bare 404 on
  // owner/setup after login had already stopped 404ing), and even once mounted, the
  // ownership/session-cookie subsystem can lag a beat behind (observed separately: a 200
  // response with no Set-Cookie header). Both are narrow startup races, not logic bugs --
  // confirmed by two direct follow-up calls (fresh instance, and a repeat against an
  // already-owned one) both behaving correctly and predictably outside the race window. A
  // 4xx/5xx that ISN'T 404 (e.g. "Instance owner already setup") is a real, non-retryable
  // failure and throws immediately -- only "not ready yet" (404, or 200-without-cookie) is
  // retried.
  let cookie: string | null = null
  let lastStatus = 0
  const maxAttempts = 8
  for (let attempt = 0; attempt < maxAttempts && !cookie; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1_500))
    const setupRes = await fetchWithTimeout(
      `${baseUrl}/rest/owner/setup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: SANDBOX_OWNER_EMAIL, firstName: 'Kairos', lastName: 'Sandbox', password: SANDBOX_OWNER_PASSWORD }),
      },
      15_000,
    )
    lastStatus = setupRes.status
    if (setupRes.status === 404) continue // route not mounted yet -- retry
    if (!setupRes.ok) {
      throw new GuardError(`Sandbox owner setup failed: HTTP ${setupRes.status} (a real rejection, not a "not ready yet" signal -- not retried)`)
    }
    cookie = setupRes.headers.get('set-cookie')
  }
  if (!cookie) {
    throw new GuardError(`Sandbox owner setup never produced a usable session cookie after ${maxAttempts} attempts (last HTTP status: ${lastStatus}).`)
  }

  const keyRes = await fetchWithTimeout(
    `${baseUrl}/rest/api-keys`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ label: 'kairos-sandbox-key', expiresAt: null, scopes: SANDBOX_API_KEY_SCOPES }),
    },
    15_000,
  )
  if (!keyRes.ok) {
    throw new GuardError(`Sandbox API key creation failed: HTTP ${keyRes.status}`)
  }
  const keyBody = await keyRes.json() as { data: { rawApiKey: string } }

  const config: SandboxConfig = {
    baseUrl,
    apiKey: keyBody.data.rawApiKey,
    isKairosSandbox: true,
    n8nVersion: PINNED_N8N_VERSION,
    provisionedAt: new Date().toISOString(),
  }
  await saveSandboxConfig(config)
  return config
}

/** Stops the sandbox process. Idempotent -- calling it when nothing is running is a no-op,
 * not an error, since "make sure the sandbox is down" is a reasonable thing to ask for
 * regardless of current state. */
export async function stopSandbox(): Promise<void> {
  const pidInfo = await readJsonIfExists<{ pid: number }>(SANDBOX_PIDFILE_PATH)
  if (!pidInfo) return

  if (await isProcessAlive(pidInfo.pid)) {
    process.kill(pidInfo.pid, 'SIGTERM')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && await isProcessAlive(pidInfo.pid)) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (await isProcessAlive(pidInfo.pid)) {
      process.kill(pidInfo.pid, 'SIGKILL')
    }
  }

  await writeFile(SANDBOX_PIDFILE_PATH, '', 'utf-8').catch(() => {})
}

function isSandboxWorkflowName(name: string): boolean {
  return name.startsWith(SANDBOX_WORKFLOW_PREFIX)
}

export function applySandboxPrefix(workflowName: string): string {
  return isSandboxWorkflowName(workflowName) ? workflowName : `${SANDBOX_WORKFLOW_PREFIX} ${workflowName}`
}

/** Removes every node's `credentials` binding. The sandbox never has real credentials
 * configured anyway (nothing was ever provisioned there) -- stripping explicitly makes that
 * a deliberate, visible property of the import rather than an accidental one where a
 * credential reference silently dangles and fails in some less legible way at execution
 * time. */
export function stripCredentialBindings(workflow: N8nWorkflow): N8nWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node: N8nNode) => {
      if (!node.credentials) return node
      const { credentials: _credentials, ...rest } = node
      return rest as N8nNode
    }),
  }
}

export interface SandboxImportResult {
  id: string
  name: string
  /** Present only when the imported workflow had a webhook trigger. Carries the ACTUAL
   * registered path/method after rewriteWebhookPathForSandbox's uniqueification -- callers
   * (replay/runner.ts) must inject payloads against this, never the original workflow's own
   * `parameters.path`, which is no longer what's live in the sandbox. See that function's
   * own doc comment for why the rewrite exists at all. */
  webhookTrigger?: { path: string; httpMethod: string }
}

/**
 * A candidate is, by definition, meant to replace a workflow at the SAME production webhook
 * path as its baseline -- that's the normal case, not an edge case. Importing both into the
 * sandbox and activating them simultaneously (replay's whole point: compare them side by
 * side) means two active sandbox workflows would claim the identical webhook route at the
 * same time, which n8n correctly refuses (confirmed live: HTTP 409 "conflict with one of the
 * webhooks"). So every sandbox import gets its webhook path rewritten to something unique --
 * a short random suffix appended to the original path -- on a COPY of the workflow, never
 * mutating the caller's own object. The returned `webhookTrigger` on SandboxImportResult
 * carries the path actually registered, which is what any later injection must target.
 */
export function rewriteWebhookPathForSandbox(workflow: N8nWorkflow): { workflow: N8nWorkflow; webhookTrigger?: { path: string; httpMethod: string } } {
  const webhookNode = workflow.nodes.find(n => n.type === 'n8n-nodes-base.webhook')
  if (!webhookNode) return { workflow }

  const params = (webhookNode.parameters ?? {}) as Record<string, unknown>
  const originalPath = typeof params['path'] === 'string' ? params['path'] : 'webhook'
  const httpMethod = typeof params['httpMethod'] === 'string' ? params['httpMethod'].toUpperCase() : 'POST'
  const uniquePath = `${originalPath}-${Math.random().toString(36).slice(2, 10)}`

  const rewrittenNodes = workflow.nodes.map(n =>
    n.id === webhookNode.id
      ? { ...n, parameters: { ...params, path: uniquePath } }
      : n,
  )

  return {
    workflow: { ...workflow, nodes: rewrittenNodes },
    webhookTrigger: { path: uniquePath, httpMethod },
  }
}

/**
 * Imports a workflow into the sandbox: prefixes its name, strips credential bindings,
 * rewrites its webhook path to something collision-free (see rewriteWebhookPathForSandbox),
 * creates it via the real n8n API. Every write path in this module re-runs
 * assertNotProduction rather than trusting that bootSandbox already checked once -- cheap,
 * and it means a stale/hand-edited SandboxConfig can never be used to write to production
 * even if it somehow ended up pointing there.
 */
export async function importToSandbox(config: SandboxConfig, workflow: N8nWorkflow, name: string): Promise<SandboxImportResult> {
  assertNotProduction(config.baseUrl)
  const prefixedName = applySandboxPrefix(name)
  const client = new N8nApiClient(config.baseUrl, config.apiKey, nullLogger)
  const stripped = stripCredentialBindings(workflow)
  const { workflow: pathSafeWorkflow, webhookTrigger } = rewriteWebhookPathForSandbox(stripped)
  const created = await client.createWorkflow({ ...pathSafeWorkflow, name: prefixedName })
  return { id: created.id, name: created.name, ...(webhookTrigger ? { webhookTrigger } : {}) }
}

export interface SandboxCleanupResult {
  deletedIds: string[]
  deletedNames: string[]
}

/**
 * Deletes every sandbox workflow -- and only those. `isSandboxWorkflowName` is the entire
 * safety rail: a workflow surviving on the sandbox instance without the prefix (which
 * shouldn't be reachable via this module's own import path, but might exist if a human
 * manually created something there) is never touched.
 */
export async function cleanupSandboxWorkflows(config: SandboxConfig): Promise<SandboxCleanupResult> {
  assertNotProduction(config.baseUrl)
  const client = new N8nApiClient(config.baseUrl, config.apiKey, nullLogger)
  const all = await client.listWorkflows()
  const toDelete = all.filter(w => isSandboxWorkflowName(w.name))

  const deletedIds: string[] = []
  const deletedNames: string[] = []
  for (const wf of toDelete) {
    await client.deleteWorkflow(wf.id)
    deletedIds.push(wf.id)
    deletedNames.push(wf.name)
  }
  return { deletedIds, deletedNames }
}

export async function sandboxStatus(): Promise<{ running: boolean; config: SandboxConfig | null }> {
  const config = await loadSandboxConfig()
  if (!config) return { running: false, config: null }
  const pidInfo = await readJsonIfExists<{ pid: number }>(SANDBOX_PIDFILE_PATH)
  const running = pidInfo ? await isProcessAlive(pidInfo.pid) : false
  return { running, config }
}
