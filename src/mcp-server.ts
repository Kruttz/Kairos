#!/usr/bin/env node

/**
 * Kairos MCP Server — decomposed architecture.
 *
 * The host LLM (Claude, GPT, Gemini, whatever) generates the workflow.
 * Kairos provides the knowledge (system prompt, library, failure patterns)
 * and guardrails (validator, deployer). Zero Anthropic API key needed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'
import { z } from 'zod'
import { FileLibrary } from './library/file-library.js'
import { N8nValidator } from './validation/validator.js'
import { N8nFieldStripper } from './providers/n8n/stripper.js'
import { N8nApiClient } from './providers/n8n/api-client.js'
import { PromptBuilder } from './generation/prompt-builder.js'
import { TelemetryReader } from './telemetry/reader.js'
import { PatternAnalyzer } from './telemetry/pattern-analyzer.js'
import { NodeSyncer, type SyncResult } from './validation/node-syncer.js'
import { TelemetryCollector } from './telemetry/collector.js'
import { nullLogger } from './utils/logger.js'
import { GuardError } from './errors/guard-error.js'
import { generateUUID } from './utils/uuid.js'
import { inferWorkflowType } from './utils/workflow-type.js'
import type { N8nWorkflow } from './types/workflow.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readCatalogCache, writeCatalogCache } from './utils/node-catalog-cache.js'
import { coalesceAsync } from './utils/coalesce-async.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }

const library = new FileLibrary()
let _validator = new N8nValidator()
// Accessor so kairos_sync can swap the registry without callers closing over the old instance
function getValidator(): N8nValidator { return _validator }
const nodeSyncer = new NodeSyncer()
let lastSync: SyncResult | null = null
const AUTO_SYNC_TIMEOUT_MS = 5_000  // cap how long kairos_prompt waits for n8n node sync
const stripper = new N8nFieldStripper()
const promptBuilder = new PromptBuilder(getMcpPatternsPath())

function getMcpTelemetry(): TelemetryCollector | null {
  const val = process.env['KAIROS_TELEMETRY']
  if (!val || val === 'false') return null
  return val === 'true' ? new TelemetryCollector() : new TelemetryCollector(val)
}

/**
 * Derive the patterns.json path from KAIROS_TELEMETRY so the MCP server's
 * PromptBuilder reads from the same location that PatternAnalyzer.fromEnv() writes to.
 */
function getMcpPatternsPath(): string {
  const val = process.env['KAIROS_TELEMETRY']
  if (val && val !== 'false' && val !== 'true') {
    return join(val, '..', 'patterns.json')
  }
  return join(homedir(), '.kairos', 'patterns.json')
}

const mcpTelemetry = getMcpTelemetry()

interface McpBuildSession {
  description: string
  startTime: number
  validateAttempts: number
  warnedRules: number[]
  workflowType: string | null
  matchCount: number
}
const mcpSessions = new Map<string, McpBuildSession>()
const SESSION_TTL_MS = 60 * 60 * 1000  // 1 hour: abandon sessions not completed by deploy

function evictStaleSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, session] of mcpSessions) {
    if (session.startTime < cutoff) mcpSessions.delete(id)
  }
}

function getTelemetryReader(): TelemetryReader | null {
  try {
    return new TelemetryReader()
  } catch {
    return null
  }
}

type McpMode = 'readonly' | 'validate' | 'deploy'

function getMcpMode(): McpMode {
  const mode = process.env['KAIROS_MCP_MODE']?.toLowerCase()
  if (mode === 'readonly' || mode === 'validate') return mode
  return 'deploy'
}

function isAllowed(action: 'deploy' | 'activate' | 'delete'): boolean {
  // readonly and validate modes block all write ops — mode restriction overrides ALLOW_* flags
  const mode = getMcpMode()
  if (mode === 'readonly' || mode === 'validate') return false
  // deploy mode (default): require explicit opt-in via ALLOW_* flags (preserves existing behavior)
  const key = `KAIROS_MCP_ALLOW_${action.toUpperCase()}`
  return process.env[key] === 'true'
}

type McpTextContent = { type: 'text'; text: string }
type McpToolResult = { content: McpTextContent[]; isError?: true }

function mcpText(text: string): McpToolResult { return { content: [{ type: 'text', text }] } }
function mcpError(text: string): McpToolResult { return { content: [{ type: 'text', text }], isError: true } }

/**
 * Returns an error result if KAIROS_MCP_SECRET is set and the provided secret
 * doesn't match. Returns null if auth passes (no secret configured, or correct secret).
 */
function checkMcpAuth(provided: string | undefined): McpToolResult | null {
  const expected = process.env['KAIROS_MCP_SECRET']
  if (!expected) return null
  if (provided === expected) return null
  return mcpError(JSON.stringify({ error: 'Unauthorized: missing or incorrect kairos_secret' }))
}

function getApiClient(): N8nApiClient {
  const baseUrl = process.env['N8N_BASE_URL']
  const apiKey = process.env['N8N_API_KEY']
  if (!baseUrl || !apiKey) {
    throw new GuardError('N8N_BASE_URL and N8N_API_KEY environment variables are required for n8n operations')
  }
  return new N8nApiClient(baseUrl, apiKey, nullLogger)
}

function getCatalogCachePath(): string {
  const telemetry = process.env['KAIROS_TELEMETRY']
  const base = telemetry ? join(telemetry, '..') : join(homedir(), '.kairos')
  return join(base, 'node-catalog-cache.json')
}

// Coalesces concurrent autoSync() calls (e.g. overlapping kairos_prompt requests, or
// kairos_prompt racing kairos_sync) into a single in-flight sync instead of each caller
// triggering its own redundant network fetch to n8n. Correct for kairos_sync's "force
// fresh" reset too: if it nulled lastSync while a sync was already in flight, that
// in-flight sync still produces fresh data once it resolves.
const runSyncOnce = coalesceAsync(performSync)

async function autoSync(): Promise<SyncResult | null> {
  if (lastSync) return lastSync
  return runSyncOnce()
}

async function performSync(): Promise<SyncResult | null> {
  // Try disk cache before hitting the network
  const cachePath = getCatalogCachePath()
  const cached = await readCatalogCache(cachePath)
  if (cached) {
    lastSync = cached
    _validator = new N8nValidator(lastSync.registry)
    return lastSync
  }

  const baseUrl = process.env['N8N_BASE_URL']
  const apiKey = process.env['N8N_API_KEY']
  if (!baseUrl || !apiKey) return null
  try {
    const client = new N8nApiClient(baseUrl, apiKey, nullLogger)
    const nodeTypes = await client.getNodeTypes()
    if (nodeTypes.length === 0) return null
    lastSync = nodeSyncer.sync(nodeTypes)
    _validator = new N8nValidator(lastSync.registry)
    writeCatalogCache(cachePath, lastSync).catch(() => {})
    return lastSync
  } catch {
    return null
  }
}

const server = new McpServer({
  name: 'kairos',
  version: pkg.version,
})

// ── Core generation tools (no API key needed) ──────────────────────────────

server.tool(
  'kairos_prompt',
  'Get the specialized n8n workflow generation context. Returns a system prompt with node catalog, connection rules, validation rules, plus library matches and failure patterns for the given description. Feed this to yourself as context, then generate the workflow JSON.',
  {
    description: z.string().describe('Plain-English description of the workflow to build'),
    name: z.string().optional().describe('Optional workflow name override'),
  },
  async ({ description, name }) => {
    evictStaleSessions()

    const runId = generateUUID()
    const workflowType = inferWorkflowType(description)
    const hasN8nCreds = !!(process.env['N8N_BASE_URL'] && process.env['N8N_API_KEY'])

    // Start sync in background — race against timeout so slow n8n instances don't block the prompt
    const syncPromise = autoSync()
    const syncTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), AUTO_SYNC_TIMEOUT_MS))

    await library.initialize()
    const [syncResult, matches, failureRates] = await Promise.all([
      Promise.race([syncPromise, syncTimeout]),
      library.search(description),
      (async () => {
        const reader = getTelemetryReader()
        return reader ? reader.getFailureRates() : []
      })(),
    ])

    const request = { description, ...(name ? { name } : {}) }
    const built = promptBuilder.build(request, matches, failureRates, syncResult?.catalogText)

    if (mcpTelemetry) {
      mcpSessions.set(runId, {
        description,
        startTime: Date.now(),
        validateAttempts: 0,
        warnedRules: promptBuilder.getWarnedRules(),
        workflowType,
        matchCount: matches.length,
      })
      await mcpTelemetry.emit('build_start', { description, model: 'mcp-decomposed', dryRun: false }, runId)
    }

    const systemText = built.system.map(block => block.text).join('\n\n---\n\n')

    return mcpText(JSON.stringify({
          kairos_run_id: runId,
          mode: built.mode,
          matchCount: matches.length,
          topMatchScore: matches[0]?.score ?? null,
          nodeCatalog: syncResult ? 'synced' : 'static',
          nodeCount: syncResult?.nodeCount ?? null,
          ...(syncResult ? {} : {
            syncWarning: hasN8nCreds
              ? 'Could not sync node types from your n8n instance. Using static fallback catalog — generated workflows may not match your exact n8n setup.'
              : 'N8N_BASE_URL and N8N_API_KEY are not set. Using static fallback catalog — node types may not match your n8n instance. Set these env vars to enable accurate generation and deployment.',
          }),
          systemPrompt: systemText,
          userMessage: built.userMessage,
          outputFormat: {
            description: 'Generate a JSON object with this exact structure. The workflow field contains the n8n workflow. credentialsNeeded lists services requiring credentials.',
            schema: {
              workflow: {
                name: 'string — descriptive workflow name',
                nodes: 'array — n8n node objects with id (UUID v4), type, typeVersion, name, position, parameters',
                connections: 'object — keyed by source node NAME, maps to target nodes',
                settings: 'object — include executionOrder: "v1"',
              },
              credentialsNeeded: [{
                service: 'string — e.g. "Slack"',
                credentialType: 'string — e.g. "slackOAuth2Api"',
                description: 'string — what the user needs to set up',
              }],
            },
          },
        }, null, 2))
  },
)

server.tool(
  'kairos_validate',
  'Validate n8n workflow JSON against 124 structural rules. Returns pass/fail with specific issues. If validation fails, fix the issues and call this again. Errors block deployment; warnings are advisory.',
  {
    workflow: z.string().describe('The workflow JSON string to validate'),
    kairos_run_id: z.string().optional().describe('Run ID from kairos_prompt — enables telemetry correlation'),
  },
  async ({ workflow: workflowStr, kairos_run_id }) => {
    let parsed: N8nWorkflow
    try {
      parsed = JSON.parse(workflowStr) as N8nWorkflow
    } catch (e) {
      return mcpText(JSON.stringify({ valid: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }, null, 2))
    }

    const result = getValidator().validate(parsed)
    const errors = result.issues.filter(i => i.severity === 'error')
    const warnings = result.issues.filter(i => i.severity === 'warn')

    if (mcpTelemetry && kairos_run_id) {
      const session = mcpSessions.get(kairos_run_id)
      if (session) {
        session.validateAttempts++
        await mcpTelemetry.emit('generation_attempt', {
          description: session.description,
          attempt: session.validateAttempts,
          temperature: 0,
          durationMs: 0,
          tokensInput: 0,
          tokensOutput: 0,
          validationPassed: result.valid,
          issueCount: result.issues.length,
          issues: result.issues.map(i => ({ rule: i.rule, severity: i.severity, message: i.message, nodeId: i.nodeId ?? null })),
          workflowType: session.workflowType,
        }, kairos_run_id)
      }
    }

    return mcpText(JSON.stringify({
      valid: result.valid,
      errorCount: errors.length,
      warningCount: warnings.length,
      errors: errors.map(i => ({ rule: i.rule, message: i.message, nodeId: i.nodeId ?? null })),
      warnings: warnings.map(i => ({ rule: i.rule, message: i.message, nodeId: i.nodeId ?? null })),
      deployable: errors.length === 0,
    }, null, 2))
  },
)

server.tool(
  'kairos_deploy',
  'Deploy a validated workflow to n8n. Pass the workflow JSON that passed kairos_validate. Strips server-assigned fields automatically. Requires N8N_BASE_URL and N8N_API_KEY.',
  {
    workflow: z.string().describe('The validated workflow JSON string to deploy'),
    activate: z.boolean().default(false).describe('Activate the workflow immediately after deployment'),
    description: z.string().optional().describe('The original user intent / description for this workflow — used to improve library search quality over time'),
    kairos_run_id: z.string().optional().describe('Run ID from kairos_prompt — enables telemetry correlation'),
    kairos_secret: z.string().optional().describe('Required when KAIROS_MCP_SECRET env var is set'),
  },
  async ({ workflow: workflowStr, activate, description: userDescription, kairos_run_id, kairos_secret }) => {
    const authError = checkMcpAuth(kairos_secret)
    if (authError) return authError

    if (!isAllowed('deploy')) {
      return mcpError(JSON.stringify({ error: 'Deploy is disabled. Set KAIROS_MCP_ALLOW_DEPLOY=true to enable.' }))
    }

    let parsed: N8nWorkflow
    try {
      parsed = JSON.parse(workflowStr) as N8nWorkflow
    } catch (e) {
      return mcpError(JSON.stringify({ error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }))
    }

    const validation = getValidator().validate(parsed)
    const errors = validation.issues.filter(i => i.severity === 'error')
    if (errors.length > 0) {
      return mcpError(JSON.stringify({
        error: 'Workflow has validation errors — fix them before deploying',
        errors: errors.map(i => ({ rule: i.rule, message: i.message })),
      }, null, 2))
    }

    const client = getApiClient()
    const stripped = stripper.stripForCreate(parsed)
    const response = await client.createWorkflow(stripped)

    if (activate) {
      if (!isAllowed('activate')) {
        return mcpText(JSON.stringify({
          workflowId: response.id,
          name: response.name,
          activated: false,
          warning: 'Workflow deployed but activation is disabled. Set KAIROS_MCP_ALLOW_ACTIVATE=true to enable.',
          url: `${process.env['N8N_BASE_URL']}/workflow/${response.id}`,
        }, null, 2))
      }
      await client.activateWorkflow(response.id)
    }

    const session = kairos_run_id ? mcpSessions.get(kairos_run_id) : undefined

    // Warn when kairos_run_id is provided but no matching session exists — telemetry will be skipped
    const missingSessionWarning = (kairos_run_id && !session)
      ? `\n\nNote: kairos_run_id "${kairos_run_id}" was provided but no active session was found. This usually means kairos_deploy was called without a prior kairos_prompt call, or the session expired. Telemetry and pattern learning for this build were skipped.`
      : ''

    // Save to library (n8nWorkflowId enables dedup on future redeployment)
    await library.initialize()
    await library.save(parsed, {
      description: session?.description ?? userDescription ?? parsed.name,
      generationMode: session && session.matchCount > 0 ? 'reference' : 'scratch',
      generationAttempts: session?.validateAttempts ?? 1,
      n8nWorkflowId: response.id,
    })

    if (mcpTelemetry && kairos_run_id && session) {
      await mcpTelemetry.emit('build_complete', {
        description: session.description,
        success: true,
        totalAttempts: session.validateAttempts,
        totalDurationMs: Date.now() - session.startTime,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        workflowName: response.name,
        workflowId: response.id,
        dryRun: false,
        credentialsNeeded: 0,
        warnedRules: session.warnedRules,
        workflowType: session.workflowType,
      }, kairos_run_id)
      mcpSessions.delete(kairos_run_id)
      PatternAnalyzer.fromEnv().analyzeAndSave().catch(() => {})
    }

    return mcpText(JSON.stringify({
      workflowId: response.id,
      name: response.name,
      activated: activate,
      url: `${process.env['N8N_BASE_URL']}/workflow/${response.id}`,
    }, null, 2) + missingSessionWarning)
  },
)

server.tool(
  'kairos_replace',
  'Replace an existing n8n workflow with a new version. Validates before updating. Use kairos_prompt → kairos_validate → kairos_replace for iteration on existing workflows.',
  {
    workflow_id: z.string().describe('The n8n workflow ID to replace'),
    workflow: z.string().describe('The validated workflow JSON string'),
    description: z.string().optional().describe('The original user intent / description for this workflow — used to improve library search quality over time'),
    kairos_run_id: z.string().optional().describe('Run ID from kairos_prompt — enables telemetry correlation'),
    kairos_secret: z.string().optional().describe('Required when KAIROS_MCP_SECRET env var is set'),
  },
  async ({ workflow_id, workflow: workflowStr, description: userDescription, kairos_run_id, kairos_secret }) => {
    const authError = checkMcpAuth(kairos_secret)
    if (authError) return authError

    if (!isAllowed('deploy')) {
      return mcpError(JSON.stringify({ error: 'Replace is disabled. Set KAIROS_MCP_ALLOW_DEPLOY=true or KAIROS_MCP_MODE=deploy to enable.' }))
    }

    let parsed: N8nWorkflow
    try {
      parsed = JSON.parse(workflowStr) as N8nWorkflow
    } catch (e) {
      return mcpError(JSON.stringify({ error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }))
    }

    const validation = getValidator().validate(parsed)
    const errors = validation.issues.filter(i => i.severity === 'error')
    if (errors.length > 0) {
      return mcpError(JSON.stringify({
        error: 'Workflow has validation errors — fix them before replacing',
        errors: errors.map(i => ({ rule: i.rule, message: i.message })),
      }, null, 2))
    }

    const client = getApiClient()
    const stripped = stripper.stripForUpdate(parsed)
    const response = await client.updateWorkflow(workflow_id, stripped)

    const session = kairos_run_id ? mcpSessions.get(kairos_run_id) : undefined
    const missingSessionWarning = (kairos_run_id && !session)
      ? `\n\nNote: kairos_run_id "${kairos_run_id}" was provided but no active session was found.`
      : ''

    // Save to library — D4 dedup updates the existing entry rather than creating a duplicate
    await library.initialize()
    await library.save(parsed, {
      description: session?.description ?? userDescription ?? parsed.name,
      generationMode: session && session.matchCount > 0 ? 'reference' : 'scratch',
      generationAttempts: session?.validateAttempts ?? 1,
      n8nWorkflowId: workflow_id,
    })

    if (mcpTelemetry && kairos_run_id && session) {
      await mcpTelemetry.emit('build_complete', {
        description: session.description,
        success: true,
        totalAttempts: session.validateAttempts,
        totalDurationMs: Date.now() - session.startTime,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        workflowName: response.name,
        workflowId: response.id,
        dryRun: false,
        credentialsNeeded: 0,
        warnedRules: session.warnedRules,
        workflowType: session.workflowType,
      }, kairos_run_id)
      mcpSessions.delete(kairos_run_id)
      PatternAnalyzer.fromEnv().analyzeAndSave().catch(() => {})
    }

    return mcpText(JSON.stringify({
      workflowId: response.id,
      name: response.name,
      url: `${process.env['N8N_BASE_URL']}/workflow/${response.id}`,
    }, null, 2) + missingSessionWarning)
  },
)

server.tool(
  'kairos_search',
  'Search the local workflow library for similar past builds. Returns matching workflows with scores, useful for finding examples and reusing patterns.',
  {
    query: z.string().describe('Search query — a workflow description or keywords'),
    limit: z.number().default(5).describe('Maximum number of results'),
  },
  async ({ query, limit }) => {
    await library.initialize()
    const matches = await library.search(query)

    return mcpText(JSON.stringify(
      matches.slice(0, limit).map(m => ({
        id: m.workflow.id,
        score: Number(m.score.toFixed(3)),
        mode: m.mode,
        description: m.workflow.description,
        nodeCount: m.workflow.workflow.nodes.length,
        nodes: m.workflow.workflow.nodes.map(n => n.name),
        n8nWorkflowId: m.workflow.n8nWorkflowId ?? null,
        failurePatterns: m.workflow.failurePatterns ?? [],
      })),
      null,
      2,
    ))
  },
)

server.tool(
  'kairos_sync',
  'Sync the node catalog from your live n8n instance. Fetches all installed node types and versions so Kairos knows exactly what your n8n supports. Automatically called by kairos_prompt when n8n credentials are set, but you can call this manually to force a refresh.',
  {},
  async () => {
    const baseUrl = process.env['N8N_BASE_URL']
    const apiKey = process.env['N8N_API_KEY']
    if (!baseUrl || !apiKey) {
      return mcpError(JSON.stringify({ error: 'N8N_BASE_URL and N8N_API_KEY are required for sync.' }))
    }

    lastSync = null
    const result = await autoSync()
    if (!result) {
      return mcpError(JSON.stringify({ error: 'Failed to fetch node types from n8n. Check your credentials and that your instance is running.' }))
    }

    return mcpText(JSON.stringify({
      synced: true,
      nodeCount: result.nodeCount,
      newNodes: result.newNodes,
      message: `Synced ${result.nodeCount} node types from your n8n instance (${result.newNodes} not in default catalog).`,
    }, null, 2))
  },
)

server.tool(
  'kairos_patterns',
  'Analyze telemetry data and return failure patterns, build stats, and credential breakdowns. Useful for understanding what goes wrong most often and how to prevent it.',
  {
    days: z.number().default(30).describe('Number of days of telemetry to analyze'),
    limit: z.number().optional().describe('Maximum number of failure patterns to return'),
  },
  async ({ days, limit }) => {
    const analyzer = PatternAnalyzer.fromEnv()
    const analysis = await analyzer.analyzeAndSave(days)

    if (limit !== undefined && limit > 0) {
      analysis.topFailureRules = analysis.topFailureRules.slice(0, limit)
    }

    return mcpText(JSON.stringify(analysis, null, 2))
  },
)

server.tool(
  'kairos_library',
  'Browse the local Kairos workflow library. Returns saved workflow metadata. Use the optional query to search, or omit it to list all entries.',
  {
    query: z.string().optional().describe('Optional search query — omit to list all entries'),
    limit: z.number().default(20).describe('Maximum entries to return'),
  },
  async ({ query, limit }) => {
    await library.initialize()

    if (query) {
      const matches = await library.search(query)
      return mcpText(JSON.stringify(
        matches.slice(0, limit).map(m => ({
          id: m.workflow.id,
          description: m.workflow.description,
          score: Number(m.score.toFixed(3)),
          mode: m.mode,
          nodeCount: m.workflow.workflow.nodes.length,
          nodes: m.workflow.workflow.nodes.map(n => n.name),
          deployCount: m.workflow.deployCount,
          n8nWorkflowId: m.workflow.n8nWorkflowId ?? null,
          createdAt: m.workflow.createdAt,
        })),
        null, 2,
      ))
    }

    const all = await library.list()
    return mcpText(JSON.stringify(
      all.slice(0, limit).map(w => ({
        id: w.id,
        description: w.description,
        nodeCount: w.workflow.nodes.length,
        nodes: w.workflow.nodes.map(n => n.name),
        deployCount: w.deployCount,
        n8nWorkflowId: w.n8nWorkflowId ?? null,
        timesRetrieved: w.timesRetrieved ?? 0,
        createdAt: w.createdAt,
      })),
      null, 2,
    ))
  },
)

server.tool(
  'kairos_outcome',
  'Record the outcome of a workflow build against a library entry. Trains the pattern learning system to know what works and what fails over time.',
  {
    library_id: z.string().describe('The Kairos library entry ID (returned by kairos_deploy, kairos_replace, or kairos_library)'),
    attempts: z.number().describe('Number of generation+validation attempts before success'),
    first_try_pass: z.boolean().describe('Whether the first attempt passed validation'),
    failed_rules: z.array(z.number()).describe('Validation rule IDs that failed during generation'),
    mode: z.enum(['direct', 'reference']).describe('How the library entry was used during generation'),
  },
  async ({ library_id, attempts, first_try_pass, failed_rules, mode }) => {
    await library.initialize()
    await library.recordOutcome(library_id, {
      attempts,
      firstTryPass: first_try_pass,
      failedRules: failed_rules,
      mode,
    })
    return mcpText(JSON.stringify({ recorded: true, libraryId: library_id }))
  },
)

// ── n8n management tools (need N8N_BASE_URL + N8N_API_KEY) ─────────────────

server.tool(
  'kairos_list',
  'List all workflows deployed on the connected n8n instance.',
  {},
  async () => {
    const client = getApiClient()
    const workflows = await client.listWorkflows()

    return mcpText(JSON.stringify(workflows, null, 2))
  },
)

server.tool(
  'kairos_get',
  'Get the full JSON definition of a specific workflow by ID.',
  {
    workflow_id: z.string().describe('The n8n workflow ID'),
  },
  async ({ workflow_id }) => {
    const client = getApiClient()
    const workflow = await client.getWorkflow(workflow_id)

    return mcpText(JSON.stringify(workflow, null, 2))
  },
)

server.tool(
  'kairos_activate',
  'Activate a deployed workflow so it starts running on triggers.',
  {
    workflow_id: z.string().describe('The n8n workflow ID to activate'),
  },
  async ({ workflow_id }) => {
    if (!isAllowed('activate')) {
      return mcpError(JSON.stringify({ error: 'Activate is disabled. Set KAIROS_MCP_ALLOW_ACTIVATE=true to enable.' }))
    }

    const client = getApiClient()
    await client.activateWorkflow(workflow_id)

    return mcpText(`Activated workflow ${workflow_id}`)
  },
)

server.tool(
  'kairos_deactivate',
  'Deactivate a running workflow.',
  {
    workflow_id: z.string().describe('The n8n workflow ID to deactivate'),
  },
  async ({ workflow_id }) => {
    const client = getApiClient()
    await client.deactivateWorkflow(workflow_id)

    return mcpText(`Deactivated workflow ${workflow_id}`)
  },
)

server.tool(
  'kairos_delete',
  'Delete a workflow from n8n. This is irreversible.',
  {
    workflow_id: z.string().describe('The n8n workflow ID to delete'),
    kairos_secret: z.string().optional().describe('Required when KAIROS_MCP_SECRET env var is set'),
  },
  async ({ workflow_id, kairos_secret }) => {
    const authError = checkMcpAuth(kairos_secret)
    if (authError) return authError

    if (!isAllowed('delete')) {
      return mcpError(JSON.stringify({ error: 'Delete is disabled. Set KAIROS_MCP_ALLOW_DELETE=true to enable.' }))
    }

    const client = getApiClient()
    await client.deleteWorkflow(workflow_id)

    return mcpText(`Deleted workflow ${workflow_id}`)
  },
)

server.tool(
  'kairos_executions',
  'List recent executions for a workflow, showing status and timing.',
  {
    workflow_id: z.string().optional().describe('Filter to a specific workflow ID (omit for all)'),
    limit: z.number().default(20).describe('Maximum number of executions to return'),
  },
  async ({ workflow_id, limit }) => {
    const client = getApiClient()
    const executions = await client.getExecutions(workflow_id, { limit })

    return mcpText(JSON.stringify(executions, null, 2))
  },
)

server.tool(
  'kairos_record_trace',
  'Record the most recent execution of a deployed n8n workflow into the Kairos library. This improves future retrieval quality by grounding the library in real runtime behavior. Run after a workflow has executed in production.',
  {
    n8n_workflow_id: z.string().describe('The n8n workflow ID to fetch the latest execution for'),
  },
  async ({ n8n_workflow_id }) => {
    const client = getApiClient()
    const executions = await client.getExecutions(n8n_workflow_id, { limit: 1 })
    if (executions.length === 0) {
      return mcpText(`No executions found for workflow ${n8n_workflow_id}. Run the workflow in n8n first.`)
    }

    const detail = await client.getExecution(executions[0]!.id)
    const { parseExecutionTrace } = await import('./telemetry/execution-tracer.js')
    const trace = parseExecutionTrace(detail)

    await library.initialize()
    const all = await library.list()
    const match = all.find(w => w.n8nWorkflowId === n8n_workflow_id)

    if (!match) {
      return mcpText(`No library entry found for n8n workflow ${n8n_workflow_id}. Deploy with kairos_deploy first.`)
    }

    await library.recordTrace(match.id, trace)

    return mcpText(JSON.stringify({
      recorded: true,
      libraryId: match.id,
      workflowDescription: match.description,
      executionId: trace.executionId,
      status: trace.status,
      durationMs: trace.durationMs,
      executedNodes: trace.executedNodes.length,
      erroredNodes: trace.erroredNodes.length,
    }, null, 2))
  },
)

async function main() {
  const useHttp = process.argv.includes('--http')

  if (useHttp) {
    const port = parseInt(process.env['KAIROS_MCP_PORT'] ?? '3000', 10)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new StreamableHTTPServerTransport() as any
    await server.connect(transport)

    const httpServer = createServer(async (req, res) => {
      if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
        await transport.handleRequest(req, res)
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Method not allowed' }))
      }
    })

    httpServer.listen(port, () => {
      process.stderr.write(`[kairos-mcp] HTTP transport listening on port ${port}\n`)
    })
  } else {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }
}

main().catch((err: unknown) => {
  console.error('Kairos MCP server failed to start:', err)
  process.exit(1)
})
