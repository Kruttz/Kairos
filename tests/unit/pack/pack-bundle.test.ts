import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchWorkflowJson, writeWorkflowJsonFiles, slugifyWorkflowName, generateCredentialsDoc, generateRiskReport, generateMonitoringPlan, writeTestPayloadFiles, writeOpenApiFiles, writeBundle } from '../../../src/pack/pack-bundle.js'
import type { N8nApiClient } from '../../../src/providers/n8n/index.js'
import type { N8nWorkflowResponse } from '../../../src/providers/n8n/types.js'
import type { WorkflowPackResult } from '../../../src/pack/pack-builder.js'
import { computeWorkflowHash } from '../../../src/utils/workflow-hash.js'
import { getRuleSetVersion, getPromptVersion, getNodeCatalogVersion } from '../../../src/validation/provenance-versions.js'

function makePack(overrides: Partial<WorkflowPackResult> = {}): WorkflowPackResult {
  return {
    businessContext: 'Empire Homecare',
    packName: 'empire-homecare',
    status: 'ready_for_test',
    workflows: [],
    allCredentials: [],
    sheetsColumns: [],
    assumptions: [],
    testChecklist: [],
    builtAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeResponse(overrides: Partial<N8nWorkflowResponse> = {}): N8nWorkflowResponse {
  return {
    id: 'wf-123',
    name: 'Missed-Call Text-Back',
    active: true,
    nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versionId: 'v1',
    ...overrides,
  }
}

function mockClient(getWorkflow: (id: string) => Promise<N8nWorkflowResponse>): N8nApiClient {
  return { getWorkflow } as unknown as N8nApiClient
}

let tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-pack-bundle-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
  tmpDirs = []
})

describe('slugifyWorkflowName', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugifyWorkflowName('Missed-Call Text-Back!')).toBe('missed-call-text-back')
  })

  it('falls back to a default for an all-symbol name', () => {
    expect(slugifyWorkflowName('!!!')).toBe('workflow')
  })
})

describe('fetchWorkflowJson', () => {
  it('returns the workflow stripped of n8n-internal fields on success', async () => {
    const client = mockClient(async () => makeResponse())
    const workflow = await fetchWorkflowJson('wf-123', client)
    expect(workflow).toEqual({
      name: 'Missed-Call Text-Back',
      nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    })
    expect(workflow).not.toHaveProperty('id')
    expect(workflow).not.toHaveProperty('active')
    expect(workflow).not.toHaveProperty('versionId')
  })

  it('preserves settings/tags when present', async () => {
    const client = mockClient(async () => makeResponse({ settings: { timezone: 'America/New_York' }, tags: [{ id: 't1', name: 'client-a' }] }))
    const workflow = await fetchWorkflowJson('wf-123', client)
    expect(workflow?.settings).toEqual({ timezone: 'America/New_York' })
    expect(workflow?.tags).toEqual([{ id: 't1', name: 'client-a' }])
  })

  it('returns null (does not throw) when the n8n API call fails', async () => {
    const client = mockClient(async () => { throw new Error('404 not found') })
    const workflow = await fetchWorkflowJson('wf-missing', client)
    expect(workflow).toBeNull()
  })
})

describe('writeWorkflowJsonFiles', () => {
  it('writes one file per workflow with a valid workflowId', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({ id, name: 'Referral Intake' }))
    const result = await writeWorkflowJsonFiles(
      [{ name: 'Referral Intake', workflowId: 'wf-1' }],
      client,
      dir,
    )
    expect(result.written).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
    const content = JSON.parse(await readFile(join(dir, 'referral-intake.workflow.json'), 'utf-8'))
    expect(content.name).toBe('Referral Intake')
  })

  it('records fetchedAt (an ISO timestamp) since this is a live fetch that may differ from what Kairos originally generated', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({ id, name: 'Referral Intake' }))
    const before = new Date().toISOString()
    const result = await writeWorkflowJsonFiles([{ name: 'Referral Intake', workflowId: 'wf-1' }], client, dir)
    const after = new Date().toISOString()
    expect(result.written[0]!.fetchedAt >= before).toBe(true)
    expect(result.written[0]!.fetchedAt <= after).toBe(true)
  })

  it('skips a workflow with no workflowId, reporting why, without aborting the rest', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({ id }))
    const result = await writeWorkflowJsonFiles(
      [
        { name: 'Not Deployed', workflowId: null },
        { name: 'Deployed', workflowId: 'wf-2' },
      ],
      client,
      dir,
    )
    expect(result.written).toHaveLength(1)
    expect(result.written[0]!.workflowName).toBe('Deployed')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.workflowName).toBe('Not Deployed')
    expect(result.skipped[0]!.reason).toContain('no workflowId')
  })

  it('skips a workflow whose n8n fetch fails, without aborting the rest', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => {
      if (id === 'wf-bad') throw new Error('network error')
      return makeResponse({ id })
    })
    const result = await writeWorkflowJsonFiles(
      [
        { name: 'Broken', workflowId: 'wf-bad' },
        { name: 'Fine', workflowId: 'wf-ok' },
      ],
      client,
      dir,
    )
    expect(result.written).toHaveLength(1)
    expect(result.written[0]!.workflowName).toBe('Fine')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.workflowName).toBe('Broken')
    expect(result.skipped[0]!.reason).toContain('could not fetch')
  })

  it('creates the output directory if it does not exist', async () => {
    const dir = await makeTmpDir()
    const nestedDir = join(dir, 'nested', 'output')
    const client = mockClient(async (id) => makeResponse({ id }))
    await writeWorkflowJsonFiles([{ name: 'Test', workflowId: 'wf-1' }], client, nestedDir)
    const content = await readFile(join(nestedDir, 'test.workflow.json'), 'utf-8')
    expect(JSON.parse(content).name).toBeDefined()
  })
})

describe('generateCredentialsDoc', () => {
  it('reports no credentials required when no workflow needs any', () => {
    const pack = makePack({ workflows: [{ name: 'Internal Routing', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] }] })
    const md = generateCredentialsDoc(pack)
    expect(md).toContain('No credentials required')
  })

  it('groups a credential needed by multiple workflows, preserving distinct descriptions', () => {
    const pack = makePack({
      workflows: [
        { name: 'Missed-Call Text-Back', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Twilio', credentialType: 'twilioApi', description: 'Send SMS confirmation' }] },
        { name: 'Reorder Reminder', purpose: 'x', workflowId: 'wf-2', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Twilio', credentialType: 'twilioApi', description: 'Send reorder SMS' }] },
      ],
    })
    const md = generateCredentialsDoc(pack)
    expect(md).toContain('## Twilio')
    expect(md).toContain('`twilioApi`')
    expect(md).toContain('Send SMS confirmation')
    expect(md).toContain('Send reorder SMS')
    expect(md).toContain('Missed-Call Text-Back, Reorder Reminder')
  })

  it('deduplicates identical descriptions for the same credential', () => {
    const pack = makePack({
      workflows: [
        { name: 'A', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Slack', credentialType: 'slackApi', description: 'Post to #alerts' }] },
        { name: 'B', purpose: 'x', workflowId: 'wf-2', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Slack', credentialType: 'slackApi', description: 'Post to #alerts' }] },
      ],
    })
    const md = generateCredentialsDoc(pack)
    const occurrences = md.split('Post to #alerts').length - 1
    expect(occurrences).toBe(1)
  })

  it('handles a workflow with zero credentials alongside one that has some', () => {
    const pack = makePack({
      workflows: [
        { name: 'No Creds', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] },
        { name: 'Has Creds', purpose: 'x', workflowId: 'wf-2', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Gmail', credentialType: 'gmailOAuth2', description: 'Send confirmation emails' }] },
      ],
    })
    const md = generateCredentialsDoc(pack)
    expect(md).toContain('## Gmail')
    expect(md).not.toContain('No credentials required')
  })

  it('includes the business context and a setup-order section', () => {
    const pack = makePack({
      businessContext: 'Empire Homecare',
      workflows: [{ name: 'A', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Gmail', credentialType: 'gmailOAuth2', description: 'x' }] }],
    })
    const md = generateCredentialsDoc(pack)
    expect(md).toContain('Empire Homecare')
    expect(md).toContain('## Setup Order')
  })
})

describe('generateRiskReport', () => {
  it('reports READY when there are no issues anywhere', () => {
    const pack = makePack({
      workflows: [{ name: 'Clean Workflow', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [], finalIssues: [] }],
    })
    const md = generateRiskReport(pack)
    expect(md).toContain('**Overall status:** READY')
    expect(md).toContain('No issues found.')
  })

  it('reports BLOCKED (not READY) for an escalated pack that was never built, with the reason and open questions', () => {
    const pack = makePack({
      workflows: [],
      escalation: {
        reason: 'Blocking assumptions unresolved',
        questions: ['What CRM does the client use?', 'Which Google Sheet holds facility contacts?'],
        source: 'blocking_assumptions',
      },
    })
    const md = generateRiskReport(pack)
    expect(md).toContain('**Overall status:** BLOCKED')
    expect(md).not.toContain('READY')
    expect(md).toContain('Blocking assumptions unresolved')
    expect(md).toContain('What CRM does the client use?')
    expect(md).toContain('Which Google Sheet holds facility contacts?')
  })

  it('reports NOT READY when a workflow has an error-severity issue, with mitigation text', () => {
    const pack = makePack({
      workflows: [{
        name: 'Broken Workflow', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [],
        finalIssues: [{ rule: 17, severity: 'error', message: 'Bad credential shape' }],
      }],
    })
    const md = generateRiskReport(pack)
    expect(md).toContain('**Overall status:** NOT READY')
    expect(md).toContain('Rule 17')
    expect(md).toContain('Bad credential shape')
    expect(md).toContain('Fix:')
    expect(md).toContain('credential entry must be keyed by credential type')
  })

  it('reports NEEDS ATTENTION (not NOT READY) when only warnings exist', () => {
    const pack = makePack({
      workflows: [{
        name: 'Warned Workflow', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [],
        finalIssues: [{ rule: 90, severity: 'warn', message: 'Long unbranched node chain' }],
      }],
    })
    const md = generateRiskReport(pack)
    expect(md).toContain('**Overall status:** NEEDS ATTENTION')
  })

  it('surfaces pack-structural issues from validatePack() (e.g. duplicate names)', () => {
    const pack = makePack({
      workflows: [
        { name: 'Duplicate', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [], finalIssues: [] },
        { name: 'Duplicate', purpose: 'x', workflowId: 'wf-2', deployed: true, generationAttempts: 1, credentialsNeeded: [], finalIssues: [] },
      ],
    })
    const md = generateRiskReport(pack)
    expect(md).toContain('## Pack-Level Issues')
    expect(md).toContain('Duplicate workflow names')
    expect(md).toContain('**Overall status:** NOT READY')
  })

  it('degrades gracefully for a workflow with no finalIssues (pre-existing pack)', () => {
    const pack = makePack({
      workflows: [{ name: 'Old Pack Workflow', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] }],
    })
    const md = generateRiskReport(pack)
    expect(md).toContain('No structured validation data available')
    expect(md).not.toContain('NOT READY')
  })

  it('normalizes ValidationIssue severity "warn" to the same [WARNING] tag PackValidationIssue uses', () => {
    const pack = makePack({
      workflows: [{
        name: 'A', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [],
        finalIssues: [{ rule: 90, severity: 'warn', message: 'workflow-level warn' }],
      }],
    })
    const md = generateRiskReport(pack)
    expect(md).toContain('[WARNING]')
    expect(md).not.toContain('[WARN]')
    expect(md).toContain('workflow-level warn')
  })
})

describe('generateMonitoringPlan', () => {
  interface MockMonitoringClient {
    getWorkflow: (id: string) => Promise<N8nWorkflowResponse>
    getExecutions: (workflowId?: string, filter?: unknown) => Promise<Array<{ id: string; workflowId: string; status: string; startedAt: string; mode: string }>>
    getExecution: (id: string) => Promise<{ id: string; workflowId: string; status: string; startedAt: string; stoppedAt?: string; mode: string; data?: unknown }>
  }

  function mockMonitoringClient(overrides: Partial<MockMonitoringClient> = {}): N8nApiClient {
    return {
      getWorkflow: overrides.getWorkflow ?? (async (id: string) => makeResponse({ id, active: true })),
      getExecutions: overrides.getExecutions ?? (async () => []),
      getExecution: overrides.getExecution ?? (async () => { throw new Error('not implemented') }),
    } as unknown as N8nApiClient
  }

  it('reports not deployed for a workflow with no workflowId', async () => {
    const pack = makePack({ workflows: [{ name: 'Not Deployed', purpose: 'x', workflowId: null, deployed: false, generationAttempts: 0, credentialsNeeded: [] }] })
    const md = await generateMonitoringPlan(pack, mockMonitoringClient())
    expect(md).toContain('Not deployed')
  })

  it('reports active/inactive status and degrades gracefully when n8n is unreachable', async () => {
    const pack = makePack({ workflows: [{ name: 'Unreachable', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] }] })
    const client = mockMonitoringClient({ getWorkflow: async () => { throw new Error('network error') } })
    const md = await generateMonitoringPlan(pack, client)
    expect(md).toContain('Could not reach n8n')
  })

  it('reports active status and "no execution history" when the workflow has never run', async () => {
    const pack = makePack({ workflows: [{ name: 'Never Run', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] }] })
    const client = mockMonitoringClient({ getWorkflow: async (id) => makeResponse({ id, active: true }), getExecutions: async () => [] })
    const md = await generateMonitoringPlan(pack, client)
    expect(md).toContain('**Status:** Active')
    expect(md).toContain('No execution history yet')
  })

  it('reports the latest execution\'s status, node count, and slowest nodes, with an honest "insufficient history" note', async () => {
    const pack = makePack({ workflows: [{ name: 'Has History', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] }] })
    const client = mockMonitoringClient({
      getWorkflow: async (id) => makeResponse({ id, active: true }),
      getExecutions: async () => [{ id: 'exec-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-01-01T00:00:00.000Z', mode: 'trigger' }],
      getExecution: async () => ({
        id: 'exec-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-01-01T00:00:01.000Z', mode: 'trigger',
        data: { resultData: { runData: { 'Slow Node': [{ executionTime: 500 }], 'Fast Node': [{ executionTime: 50 }] } } },
      }),
    })
    const md = await generateMonitoringPlan(pack, client)
    expect(md).toContain('**Latest execution:** success')
    expect(md).toContain('Slow Node (500ms)')
    expect(md).toContain('Insufficient history for drift comparison')
  })

  it('does not abort the rest of the report when one workflow fails, and includes the weekly checklist', async () => {
    const pack = makePack({
      workflows: [
        { name: 'Broken', purpose: 'x', workflowId: 'wf-bad', deployed: true, generationAttempts: 1, credentialsNeeded: [] },
        { name: 'Fine', purpose: 'x', workflowId: 'wf-ok', deployed: true, generationAttempts: 1, credentialsNeeded: [] },
      ],
    })
    const client = mockMonitoringClient({
      getWorkflow: async (id) => { if (id === 'wf-bad') throw new Error('gone'); return makeResponse({ id, active: true }) },
      getExecutions: async () => [],
    })
    const md = await generateMonitoringPlan(pack, client)
    expect(md).toContain('## Broken')
    expect(md).toContain('## Fine')
    expect(md).toContain('Could not reach n8n')
    expect(md).toContain('## Weekly Checklist')
  })
})

describe('writeTestPayloadFiles', () => {
  it('writes a test-payloads.json for a webhook-shaped workflow', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({
      id, name: 'Referral Intake',
      nodes: [
        { id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'referrals', httpMethod: 'POST' } },
        { id: 'n2', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 1, position: [200, 0], parameters: { text: '={{$json.body.email}}' } },
      ],
    }))
    const result = await writeTestPayloadFiles([{ name: 'Referral Intake', workflowId: 'wf-1' }], client, dir)
    expect(result.written).toHaveLength(1)
    const content = JSON.parse(await readFile(join(dir, 'referral-intake.test-payloads.json'), 'utf-8'))
    expect(content.url).toBe('referrals')
    expect(content.method).toBe('POST')
    expect(content.sampleBody).toEqual({ email: 'test@example.com' })
  })

  it('skips a non-webhook workflow silently (no file, reported as not applicable)', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({
      id, name: 'Internal Routing',
      nodes: [{ id: 'n1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    }))
    const result = await writeTestPayloadFiles([{ name: 'Internal Routing', workflowId: 'wf-1' }], client, dir)
    expect(result.written).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toContain('not applicable')
  })

  it('skips a workflow with no workflowId or a failed fetch, without aborting the rest', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => {
      if (id === 'wf-bad') throw new Error('gone')
      return makeResponse({
        id, name: 'Good',
        nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
      })
    })
    const result = await writeTestPayloadFiles(
      [
        { name: 'Not Deployed', workflowId: null },
        { name: 'Broken', workflowId: 'wf-bad' },
        { name: 'Good', workflowId: 'wf-good' },
      ],
      client,
      dir,
    )
    expect(result.written).toHaveLength(1)
    expect(result.written[0]!.workflowName).toBe('Good')
    expect(result.skipped).toHaveLength(2)
  })
})

describe('writeOpenApiFiles', () => {
  it('writes a contract.openapi.json for a webhook-shaped workflow', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({
      id, name: 'Referral Intake',
      nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'referrals', httpMethod: 'POST' } }],
    }))
    const result = await writeOpenApiFiles([{ name: 'Referral Intake', workflowId: 'wf-1' }], client, dir)
    expect(result.written).toHaveLength(1)
    const content = JSON.parse(await readFile(join(dir, 'referral-intake.contract.openapi.json'), 'utf-8'))
    expect(content.openapi).toBe('3.0.3')
    expect(content.paths['/referrals'].post).toBeDefined()
  })

  it('skips a non-webhook workflow silently (not applicable)', async () => {
    const dir = await makeTmpDir()
    const client = mockClient(async (id) => makeResponse({
      id, name: 'Internal',
      nodes: [{ id: 'n1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    }))
    const result = await writeOpenApiFiles([{ name: 'Internal', workflowId: 'wf-1' }], client, dir)
    expect(result.written).toHaveLength(0)
    expect(result.skipped[0]!.reason).toContain('not applicable')
  })
})

describe('writeBundle', () => {
  function mockBundleClient(): { client: N8nApiClient; workflows: string[] } {
    const workflows: string[] = []
    const client = {
      getWorkflow: async (id: string) => {
        workflows.push(id)
        return makeResponse({
          id, active: true,
          nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
        })
      },
      getExecutions: async () => [],
      getExecution: async () => { throw new Error('not implemented') },
    } as unknown as N8nApiClient
    return { client, workflows }
  }

  it('writes every pack-level and per-workflow artifact plus a manifest', async () => {
    const dir = await makeTmpDir()
    const pack = makePack({
      workflows: [{ name: 'Referral Intake', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Gmail', credentialType: 'gmailOAuth2', description: 'x' }], finalIssues: [] }],
    })
    const { client } = mockBundleClient()

    const manifest = await writeBundle(pack, client, dir)

    for (const name of ['handoff.md', 'credentials.md', 'risk-report.md', 'monitoring-plan.md']) {
      expect(manifest.files.some((f) => f.path.endsWith(name))).toBe(true)
    }
    expect(manifest.files.some((f) => f.path.endsWith('referral-intake.workflow.json'))).toBe(true)
    expect(manifest.files.some((f) => f.path.endsWith('referral-intake.test-payloads.json'))).toBe(true)
    expect(manifest.files.some((f) => f.path.endsWith('referral-intake.contract.openapi.json'))).toBe(true)

    const manifestFile = JSON.parse(await readFile(join(dir, 'bundle-manifest.json'), 'utf-8'))
    expect(manifestFile.packName).toBe(pack.packName)
    expect(manifestFile.files.length).toBe(manifest.files.length)

    // Live-fetched per-workflow artifacts carry their own fetchedAt (may differ from what
    // Kairos originally generated); pure-render pack-level artifacts don't have a fetch moment.
    const workflowJsonEntry = manifest.files.find((f) => f.path.endsWith('referral-intake.workflow.json'))!
    expect(workflowJsonEntry.fetchedAt).toBeDefined()
    const handoffEntry = manifest.files.find((f) => f.path.endsWith('handoff.md'))!
    expect(handoffEntry.fetchedAt).toBeUndefined()
  })

  it('records a skip (not a thrown error) for a non-webhook workflow\'s webhook-only artifacts', async () => {
    const dir = await makeTmpDir()
    const pack = makePack({
      workflows: [{ name: 'Internal', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] }],
    })
    const client = {
      getWorkflow: async (id: string) => makeResponse({
        id, active: true,
        nodes: [{ id: 'n1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      }),
      getExecutions: async () => [],
      getExecution: async () => { throw new Error('not implemented') },
    } as unknown as N8nApiClient

    const manifest = await writeBundle(pack, client, dir)
    const openApiSkip = manifest.skipped.find((s) => s.artifact === 'contract.openapi.json')
    expect(openApiSkip).toBeDefined()
    expect(openApiSkip!.reason).toContain('not applicable')
  })

  it('stamps the manifest with content-derived rule-set/prompt/catalog provenance', async () => {
    const dir = await makeTmpDir()
    const pack = makePack({
      workflows: [{ name: 'Referral Intake', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [], finalIssues: [] }],
    })
    const { client } = mockBundleClient()

    const manifest = await writeBundle(pack, client, dir)

    expect(manifest.provenance).toBeDefined()
    expect(manifest.provenance?.ruleSetVersion).toBe(getRuleSetVersion())
    expect(manifest.provenance?.promptVersion).toBe(getPromptVersion())
    expect(manifest.provenance?.nodeCatalogVersion).toEqual(getNodeCatalogVersion())
  })

  it('records workflowHash on the workflow.json entry, computed from the live-fetched content', async () => {
    const dir = await makeTmpDir()
    const pack = makePack({
      workflows: [{ name: 'Referral Intake', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [], finalIssues: [] }],
    })
    const { client } = mockBundleClient()

    const manifest = await writeBundle(pack, client, dir)

    const workflowJsonEntry = manifest.files.find((f) => f.path.endsWith('referral-intake.workflow.json'))!
    expect(workflowJsonEntry.workflowHash).toMatch(/^[0-9a-f]{64}$/)

    const fetched = JSON.parse(await readFile(workflowJsonEntry.path, 'utf-8'))
    expect(workflowJsonEntry.workflowHash).toBe(computeWorkflowHash(fetched))

    // Derived artifacts (not the workflow definition itself) don't carry a workflowHash.
    const testPayloadEntry = manifest.files.find((f) => f.path.endsWith('referral-intake.test-payloads.json'))!
    expect(testPayloadEntry.workflowHash).toBeUndefined()
  })
})
