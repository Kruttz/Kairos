import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PackBuilder } from '../../src/pack/pack-builder.js'
import { writeBundle, type BundleManifest } from '../../src/pack/pack-bundle.js'
import { runPreflight } from '../../src/pack/preflight.js'
import { findWebhookTrigger } from '../../src/utils/webhook-verify.js'
import type { Kairos } from '../../src/client.js'
import type { BuildResult } from '../../src/types/result.js'
import type { N8nApiClient } from '../../src/providers/n8n/index.js'
import type { N8nWorkflowResponse } from '../../src/providers/n8n/types.js'
import type { N8nWorkflow } from '../../src/types/workflow.js'

// Two golden packs -- semantic assertions only, never full-JSON snapshots (node IDs,
// timestamps, and key ordering are non-semantic and change legitimately between runs).
// Every LLM response here is a hand-authored canned string, matching the same
// makeMockAnthropic/mockKairos convention already established in pack-builder.test.ts --
// fully offline, deterministic, no live Anthropic or n8n call. The no-network guard
// (tests/setup/no-network-guard.ts) backstops this: if any of these mocks were forgotten,
// the real fetch call underneath would throw immediately rather than silently succeeding.

function makeMockAnthropic(planJson: Record<string, unknown>) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(planJson) }],
      }),
    },
  }
}

function makeMockKairos(buildResult: BuildResult): Kairos {
  return {
    build: vi.fn().mockResolvedValue(buildResult),
    drain: vi.fn().mockResolvedValue(undefined),
  } as unknown as Kairos
}

function makeMockN8nClient(workflow: N8nWorkflow): N8nApiClient {
  const response: N8nWorkflowResponse = {
    id: 'wf-golden-1',
    name: workflow.name,
    active: false,
    nodes: workflow.nodes,
    connections: workflow.connections,
    ...(workflow.settings ? { settings: workflow.settings } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versionId: 'v1',
  }
  return { getWorkflow: vi.fn().mockResolvedValue(response) } as unknown as N8nApiClient
}

describe('Golden pack: webhook-shaped', () => {
  let outDir: string

  afterEach(async () => {
    vi.restoreAllMocks()
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('plan -> build -> writeBundle -> preflight produces a clean pack with a real extracted webhook path', async () => {
    const webhookWorkflow: N8nWorkflow = {
      name: 'Referral Intake',
      nodes: [
        {
          id: 'n1', name: 'Referral Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2,
          position: [0, 0],
          parameters: { httpMethod: 'POST', path: 'referral-intake', authentication: 'headerAuth', responseMode: 'onReceived' },
          credentials: { httpHeaderAuth: { id: 'cred-1', name: 'Intake Header Auth' } },
        },
        {
          id: 'n2', name: 'Notify Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2,
          position: [250, 0],
          parameters: { resource: 'message', operation: 'post', channelId: { __rl: true, mode: 'name', value: '#referrals' }, text: 'New referral received' },
          credentials: { slackApi: { id: 'cred-2', name: 'Empire Slack' } },
        },
      ],
      connections: {
        'Referral Webhook': { main: [[{ node: 'Notify Slack', type: 'main', index: 0 }]] },
      },
      settings: { executionOrder: 'v1' },
    }

    const buildResult: BuildResult = {
      workflowId: 'wf-golden-1',
      name: 'Referral Intake',
      workflow: webhookWorkflow,
      credentialsNeeded: [
        { service: 'Slack', credentialType: 'slackApi', description: 'Empire Slack workspace' },
      ],
      activationRequired: true,
      generationAttempts: 1,
      tokensInput: 500,
      tokensOutput: 400,
      dryRun: false,
      summary: 'Receives a referral via webhook and posts a Slack notification.',
      finalIssues: [],
    }

    const builder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos: makeMockKairos(buildResult) })
    ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic({
      workflows: [{
        name: 'Referral Intake',
        description: 'Webhook-triggered referral intake that posts a Slack notification.',
        purpose: 'Alert the team immediately when a new referral arrives.',
      }],
      assumptions: [{ type: 'safe', text: 'Slack channel #referrals already exists' }],
      sheetsColumns: [],
      testChecklist: [{ workflow: 'Referral Intake', steps: ['POST a test payload to the webhook'] }],
    })

    const plan = await builder.plan('Empire Homecare referral intake')
    const pack = await builder.build(plan)

    // Semantic assertions on the build result -- never assert full node array structure,
    // node/workflow IDs, or builtAt.
    expect(pack.workflows).toHaveLength(1)
    const wf = pack.workflows[0]!
    expect(wf.deployed).toBe(true)
    expect(wf.finalIssues?.some(i => i.severity === 'error')).toBe(false)
    expect(pack.allCredentials.some(c => c.credentialType === 'slackApi')).toBe(true)

    const extractedWebhook = findWebhookTrigger(webhookWorkflow)
    expect(extractedWebhook).toEqual({ path: 'referral-intake', httpMethod: 'POST' })

    outDir = await mkdtemp(join(tmpdir(), 'kairos-golden-webhook-'))
    const n8nClient = makeMockN8nClient(webhookWorkflow)
    const manifest: BundleManifest = await writeBundle(pack, n8nClient, outDir)

    expect(manifest.skipped).toEqual([])
    const artifacts = manifest.files.map(f => f.artifact)
    expect(artifacts).toEqual(expect.arrayContaining([
      'handoff.md', 'credentials.md', 'risk-report.md', 'workflow.json', 'test-payloads.json', 'contract.openapi.json',
    ]))

    const writtenWorkflowPath = manifest.files.find(f => f.artifact === 'workflow.json')!.path
    const writtenWorkflow = JSON.parse(await readFile(writtenWorkflowPath, 'utf-8')) as N8nWorkflow
    expect(writtenWorkflow.nodes.some(n => n.type === 'n8n-nodes-base.webhook')).toBe(true)
    expect(writtenWorkflow.nodes.some(n => n.type === 'n8n-nodes-base.slack')).toBe(true)

    const preflightResult = await runPreflight(pack)
    expect(preflightResult.verdict).not.toBe('BLOCKED')
    expect(preflightResult.checks.some(c => c.status === 'fail')).toBe(false)
  })
})

describe('Golden pack: non-webhook (schedule + email)', () => {
  let outDir: string

  afterEach(async () => {
    vi.restoreAllMocks()
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('plan -> build -> writeBundle -> preflight produces a clean pack with no webhook-shaped workflows', async () => {
    const scheduleWorkflow: N8nWorkflow = {
      name: 'Weekly Summary Email',
      nodes: [
        {
          id: 'n1', name: 'Every Monday 9am', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2,
          position: [0, 0],
          parameters: { rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 9 }] } },
        },
        {
          id: 'n2', name: 'Send Summary', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1,
          position: [250, 0],
          parameters: { fromEmail: 'ops@empirehomecare.example', toAddresses: 'team@empirehomecare.example', subject: 'Weekly Summary', message: 'Here is this week\'s summary.' },
          credentials: { smtp: { id: 'cred-3', name: 'Empire SMTP' } },
        },
      ],
      connections: {
        'Every Monday 9am': { main: [[{ node: 'Send Summary', type: 'main', index: 0 }]] },
      },
      settings: { executionOrder: 'v1' },
    }

    const buildResult: BuildResult = {
      workflowId: 'wf-golden-2',
      name: 'Weekly Summary Email',
      workflow: scheduleWorkflow,
      credentialsNeeded: [
        { service: 'SMTP', credentialType: 'smtp', description: 'Empire SMTP relay' },
      ],
      activationRequired: true,
      generationAttempts: 1,
      tokensInput: 450,
      tokensOutput: 380,
      dryRun: false,
      summary: 'Sends a weekly summary email every Monday at 9am.',
      finalIssues: [],
    }

    const builder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos: makeMockKairos(buildResult) })
    ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic({
      workflows: [{
        name: 'Weekly Summary Email',
        description: 'Scheduled workflow that emails a weekly summary every Monday at 9am.',
        purpose: 'Keep the team informed without manual reporting.',
      }],
      assumptions: [{ type: 'safe', text: 'SMTP credentials already configured in n8n' }],
      sheetsColumns: [],
      testChecklist: [{ workflow: 'Weekly Summary Email', steps: ['Trigger manually and confirm email arrives'] }],
    })

    const plan = await builder.plan('Empire Homecare weekly reporting')
    const pack = await builder.build(plan)

    expect(pack.workflows).toHaveLength(1)
    const wf = pack.workflows[0]!
    expect(wf.deployed).toBe(true)
    expect(wf.finalIssues?.some(i => i.severity === 'error')).toBe(false)
    expect(findWebhookTrigger(scheduleWorkflow)).toBeNull()

    outDir = await mkdtemp(join(tmpdir(), 'kairos-golden-schedule-'))
    const n8nClient = makeMockN8nClient(scheduleWorkflow)
    const manifest: BundleManifest = await writeBundle(pack, n8nClient, outDir)

    expect(manifest.skipped.filter(s => s.artifact === 'workflow.json' || s.artifact === 'credentials.md' || s.artifact === 'risk-report.md' || s.artifact === 'handoff.md')).toEqual([])
    // test-payloads.json/contract.openapi.json are webhook-only artifacts -- correctly
    // absent (not "skipped due to failure") for a schedule-triggered workflow.
    const artifacts = manifest.files.map(f => f.artifact)
    expect(artifacts).not.toContain('test-payloads.json')
    expect(artifacts).not.toContain('contract.openapi.json')

    const preflightResult = await runPreflight(pack)
    expect(preflightResult.verdict).not.toBe('BLOCKED')
    expect(preflightResult.webhookShapedWorkflows ?? []).toEqual([])
  })
})
