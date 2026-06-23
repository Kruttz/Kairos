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
import { z } from 'zod'
import { FileLibrary } from './library/file-library.js'
import { N8nValidator } from './validation/validator.js'
import { N8nFieldStripper } from './providers/n8n/stripper.js'
import { N8nApiClient } from './providers/n8n/api-client.js'
import { PromptBuilder } from './generation/prompt-builder.js'
import { TelemetryReader } from './telemetry/reader.js'
import { nullLogger } from './utils/logger.js'
import type { N8nWorkflow } from './types/workflow.js'

const library = new FileLibrary()
const validator = new N8nValidator()
const stripper = new N8nFieldStripper()
const promptBuilder = new PromptBuilder()

function getTelemetryReader(): TelemetryReader | null {
  try {
    return new TelemetryReader()
  } catch {
    return null
  }
}

function getApiClient(): N8nApiClient {
  const baseUrl = process.env['N8N_BASE_URL']
  const apiKey = process.env['N8N_API_KEY']
  if (!baseUrl || !apiKey) {
    throw new Error('N8N_BASE_URL and N8N_API_KEY environment variables are required for n8n operations')
  }
  return new N8nApiClient(baseUrl, apiKey, nullLogger)
}

const server = new McpServer({
  name: 'kairos',
  version: '0.3.0',
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
    await library.initialize()
    const matches = await library.search(description)
    const telemetryReader = getTelemetryReader()
    const failureRates = await telemetryReader?.getFailureRates() ?? []

    const request = { description, ...(name ? { name } : {}) }
    const built = promptBuilder.build(request, matches, failureRates)

    const systemText = built.system.map(block => block.text).join('\n\n---\n\n')

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          mode: built.mode,
          matchCount: matches.length,
          topMatchScore: matches[0]?.score ?? null,
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
        }, null, 2),
      }],
    }
  },
)

server.tool(
  'kairos_validate',
  'Validate n8n workflow JSON against 23 structural rules. Returns pass/fail with specific issues. If validation fails, fix the issues and call this again. Errors block deployment; warnings are advisory.',
  {
    workflow: z.string().describe('The workflow JSON string to validate'),
  },
  async ({ workflow: workflowStr }) => {
    let parsed: N8nWorkflow
    try {
      parsed = JSON.parse(workflowStr) as N8nWorkflow
    } catch (e) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            valid: false,
            error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
          }, null, 2),
        }],
      }
    }

    const result = validator.validate(parsed)
    const errors = result.issues.filter(i => i.severity === 'error')
    const warnings = result.issues.filter(i => i.severity === 'warn')

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          valid: result.valid,
          errorCount: errors.length,
          warningCount: warnings.length,
          errors: errors.map(i => ({
            rule: i.rule,
            message: i.message,
            nodeId: i.nodeId ?? null,
          })),
          warnings: warnings.map(i => ({
            rule: i.rule,
            message: i.message,
            nodeId: i.nodeId ?? null,
          })),
          deployable: errors.length === 0,
        }, null, 2),
      }],
    }
  },
)

server.tool(
  'kairos_deploy',
  'Deploy a validated workflow to n8n. Pass the workflow JSON that passed kairos_validate. Strips server-assigned fields automatically. Requires N8N_BASE_URL and N8N_API_KEY.',
  {
    workflow: z.string().describe('The validated workflow JSON string to deploy'),
    activate: z.boolean().default(false).describe('Activate the workflow immediately after deployment'),
  },
  async ({ workflow: workflowStr, activate }) => {
    let parsed: N8nWorkflow
    try {
      parsed = JSON.parse(workflowStr) as N8nWorkflow
    } catch (e) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }),
        }],
      }
    }

    const validation = validator.validate(parsed)
    const errors = validation.issues.filter(i => i.severity === 'error')
    if (errors.length > 0) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Workflow has validation errors — fix them before deploying',
            errors: errors.map(i => ({ rule: i.rule, message: i.message })),
          }, null, 2),
        }],
      }
    }

    const client = getApiClient()
    const stripped = stripper.stripForCreate(parsed)
    const response = await client.createWorkflow(stripped)

    if (activate) {
      await client.activateWorkflow(response.id)
    }

    // Save to library for future retrieval
    await library.initialize()
    await library.save(parsed, {
      description: parsed.name,
      generationMode: 'scratch',
      generationAttempts: 1,
    })

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          workflowId: response.id,
          name: response.name,
          activated: activate,
          url: `${process.env['N8N_BASE_URL']}/workflow/${response.id}`,
        }, null, 2),
      }],
    }
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(
          matches.slice(0, limit).map(m => ({
            score: Number(m.score.toFixed(3)),
            mode: m.mode,
            description: m.workflow.description,
            nodeCount: m.workflow.workflow.nodes.length,
            nodes: m.workflow.workflow.nodes.map(n => n.name),
            failurePatterns: m.workflow.failurePatterns ?? [],
          })),
          null,
          2,
        ),
      }],
    }
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(workflows, null, 2),
      }],
    }
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(workflow, null, 2),
      }],
    }
  },
)

server.tool(
  'kairos_activate',
  'Activate a deployed workflow so it starts running on triggers.',
  {
    workflow_id: z.string().describe('The n8n workflow ID to activate'),
  },
  async ({ workflow_id }) => {
    const client = getApiClient()
    await client.activateWorkflow(workflow_id)

    return {
      content: [{
        type: 'text' as const,
        text: `Activated workflow ${workflow_id}`,
      }],
    }
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

    return {
      content: [{
        type: 'text' as const,
        text: `Deactivated workflow ${workflow_id}`,
      }],
    }
  },
)

server.tool(
  'kairos_delete',
  'Delete a workflow from n8n. This is irreversible.',
  {
    workflow_id: z.string().describe('The n8n workflow ID to delete'),
  },
  async ({ workflow_id }) => {
    const client = getApiClient()
    await client.deleteWorkflow(workflow_id)

    return {
      content: [{
        type: 'text' as const,
        text: `Deleted workflow ${workflow_id}`,
      }],
    }
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(executions, null, 2),
      }],
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err: unknown) => {
  console.error('Kairos MCP server failed to start:', err)
  process.exit(1)
})
