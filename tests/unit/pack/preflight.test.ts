import { describe, it, expect } from 'vitest'
import { runPreflight, formatPreflightChecklist } from '../../../src/pack/preflight.js'
import type { WorkflowPackResult } from '../../../src/pack/pack-builder.js'
import type { N8nApiClient } from '../../../src/providers/n8n/index.js'
import type { N8nWorkflowResponse } from '../../../src/providers/n8n/types.js'

function makeResponse(overrides: Partial<N8nWorkflowResponse> = {}): N8nWorkflowResponse {
  return {
    id: 'wf-1',
    name: 'Workflow',
    active: true,
    nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mockClient(getWorkflow: (id: string) => Promise<N8nWorkflowResponse>): N8nApiClient {
  return { getWorkflow } as unknown as N8nApiClient
}

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

function cleanWorkflow(overrides: Partial<WorkflowPackResult['workflows'][number]> = {}): WorkflowPackResult['workflows'][number] {
  return {
    name: 'Clean Workflow', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1,
    credentialsNeeded: [], finalIssues: [],
    ...overrides,
  }
}

function checkFor(result: Awaited<ReturnType<typeof runPreflight>>, id: string) {
  return result.checks.find((c) => c.id === id)
}

describe('runPreflight — escalated pack', () => {
  it('verdict is BLOCKED, and every per-workflow check is marked skip (not a naive pass) with an explicit reason', async () => {
    const pack = makePack({
      workflows: [],
      escalation: { reason: 'Blocking assumptions unresolved', questions: ['What CRM does the client use?'], source: 'blocking_assumptions' },
    })
    const result = await runPreflight(pack)

    expect(result.verdict).toBe('BLOCKED')
    expect(checkFor(result, 'escalation')?.status).toBe('fail')
    expect(checkFor(result, 'escalation')?.detail).toContain('Blocking assumptions unresolved')
    expect(checkFor(result, 'escalation')?.detail).toContain('What CRM does the client use?')

    for (const id of ['blocking-assumptions', 'pack-validation', 'undeployed-workflows', 'error-issues', 'warning-issues', 'credentials-checklist']) {
      const check = checkFor(result, id)
      expect(check?.status, `${id} should be 'skip', not a naive pass from an empty array`).toBe('skip')
      expect(check?.detail).toContain('N/A -- pack never built')
    }
  })
})

describe('runPreflight — clean pack', () => {
  it('verdict is GO when every check passes (live-only checks legitimately skip without --live)', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack)
    expect(result.verdict).toBe('GO')
    expect(result.checks.every((c) => c.status === 'pass' || c.status === 'info' || c.status === 'skip')).toBe(true)
  })
})

describe('runPreflight — unresolved blocking assumptions without escalation', () => {
  it('reports NO-GO even when pack.escalation is not set (the buildDespiteBlocking case)', async () => {
    const pack = makePack({
      workflows: [cleanWorkflow()],
      assumptions: [{ type: 'blocking', text: 'Sheet ID not provided' }],
    })
    const result = await runPreflight(pack)
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'blocking-assumptions')?.status).toBe('fail')
    expect(checkFor(result, 'blocking-assumptions')?.detail).toContain('Sheet ID not provided')
    // escalation check itself should still pass -- pack.escalation genuinely isn't set here
    expect(checkFor(result, 'escalation')?.status).toBe('pass')
  })
})

describe('runPreflight — undeployed workflows', () => {
  it('reports NO-GO and names the undeployed workflow', async () => {
    const pack = makePack({ workflows: [cleanWorkflow({ name: 'Not Deployed', deployed: false })] })
    const result = await runPreflight(pack)
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'undeployed-workflows')?.status).toBe('fail')
    expect(checkFor(result, 'undeployed-workflows')?.detail).toContain('Not Deployed')
  })
})

describe('runPreflight — error vs warning severity finalIssues', () => {
  it('an error-severity issue is NO-GO', async () => {
    const pack = makePack({
      workflows: [cleanWorkflow({ finalIssues: [{ rule: 17, severity: 'error', message: 'Bad credential shape' }] })],
    })
    const result = await runPreflight(pack)
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'error-issues')?.status).toBe('fail')
    expect(checkFor(result, 'error-issues')?.detail).toContain('Bad credential shape')
  })

  it('a warning-severity issue is GO WITH WARNINGS, not NO-GO -- this is where missing webhook auth (Rule 59) surfaces with zero new logic', async () => {
    const pack = makePack({
      workflows: [cleanWorkflow({ finalIssues: [{ rule: 59, severity: 'warn', message: 'webhook has no authentication' }] })],
    })
    const result = await runPreflight(pack)
    expect(result.verdict).toBe('GO WITH WARNINGS')
    expect(checkFor(result, 'warning-issues')?.status).toBe('warn')
    expect(checkFor(result, 'warning-issues')?.detail).toContain('webhook has no authentication')
    expect(checkFor(result, 'error-issues')?.status).toBe('pass')
  })
})

describe('runPreflight — pack-structural validation', () => {
  it('a duplicate workflow name (validatePack error) is NO-GO', async () => {
    const pack = makePack({
      workflows: [cleanWorkflow({ name: 'Dup' }), cleanWorkflow({ name: 'Dup', workflowId: 'wf-2' })],
    })
    const result = await runPreflight(pack)
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'pack-validation')?.status).toBe('fail')
    expect(checkFor(result, 'pack-validation')?.detail).toContain('Duplicate workflow names')
  })
})

describe('runPreflight — credentials checklist is always informational', () => {
  it('lists distinct credentials without ever failing on its own', async () => {
    const pack = makePack({
      workflows: [cleanWorkflow({ credentialsNeeded: [{ service: 'Twilio', credentialType: 'twilioApi', description: 'x' }] })],
    })
    const result = await runPreflight(pack)
    expect(checkFor(result, 'credentials-checklist')?.status).toBe('info')
    expect(checkFor(result, 'credentials-checklist')?.detail).toContain('Twilio')
    expect(result.verdict).toBe('GO')
  })

  it('reports "None required" for a pack with no credentials, still informational', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack)
    expect(checkFor(result, 'credentials-checklist')?.detail).toBe('None required')
  })
})

describe('formatPreflightChecklist', () => {
  it('renders the verdict and one line per check with the right status icon', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack)
    const text = formatPreflightChecklist(result)
    expect(text).toContain('# Empire Homecare — Preflight')
    expect(text).toContain('**Verdict: GO**')
    expect(text).toContain('✓ Pack build completed')
  })

  it('renders fail/warn/skip icons distinctly', async () => {
    const pack = makePack({
      workflows: [],
      escalation: { reason: 'x', questions: [], source: 'blocking_assumptions' },
    })
    const result = await runPreflight(pack)
    const text = formatPreflightChecklist(result)
    expect(text).toContain('✗ Pack build completed')
    expect(text).toContain('⊘ No unresolved blocking assumptions')
  })
})

describe('runPreflight — without --live', () => {
  it('marks live-only checks as skip with "needs --live", not silently absent', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack) // no options -- live defaults to false
    expect(checkFor(result, 'placeholder-credentials')?.status).toBe('skip')
    expect(checkFor(result, 'placeholder-credentials')?.detail).toContain('needs --live')
    expect(checkFor(result, 'sheets-ids')?.status).toBe('skip')
    expect(checkFor(result, 'sheets-ids')?.detail).toContain('needs --live')
  })
})

describe('runPreflight — with --live: placeholder credentials', () => {
  it('flags the literal "placeholder-id" convention as NO-GO', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Send SMS', type: 'n8n-nodes-base.twilio', typeVersion: 1, position: [0, 0], parameters: {}, credentials: { twilioApi: { id: 'placeholder-id', name: 'Twilio' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'placeholder-credentials')?.status).toBe('fail')
    expect(checkFor(result, 'placeholder-credentials')?.detail).toContain('Send SMS')
    expect(checkFor(result, 'placeholder-credentials')?.detail).toContain('twilioApi')
  })

  it('also flags an empty/missing credential id, not just the literal placeholder string', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Send SMS', type: 'n8n-nodes-base.twilio', typeVersion: 1, position: [0, 0], parameters: {}, credentials: { twilioApi: { id: '', name: 'Twilio' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'placeholder-credentials')?.status).toBe('fail')
  })

  it('passes when every credential id is a real (non-placeholder, non-empty) value', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Send SMS', type: 'n8n-nodes-base.twilio', typeVersion: 1, position: [0, 0], parameters: {}, credentials: { twilioApi: { id: 'real-cred-abc123', name: 'Twilio' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    expect(checkFor(result, 'placeholder-credentials')?.status).toBe('pass')
  })

  it('degrades to warn (not fail, not abort) when a workflow fetch fails, and still evaluates the rest', async () => {
    const pack = makePack({
      workflows: [cleanWorkflow({ name: 'Broken', workflowId: 'wf-bad' }), cleanWorkflow({ name: 'Fine', workflowId: 'wf-ok' })],
    })
    const client = mockClient(async (id) => {
      if (id === 'wf-bad') throw new Error('network error')
      return makeResponse({ id })
    })
    const result = await runPreflight(pack, { live: true, client })
    expect(checkFor(result, 'placeholder-credentials')?.status).toBe('warn')
    expect(checkFor(result, 'placeholder-credentials')?.detail).toContain('Broken')
  })
})

describe('runPreflight — with --live: Google Sheets ID signal', () => {
  it('confidently flags an empty Sheet ID as NO-GO', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Read Sheet', type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [0, 0], parameters: {} }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'sheets-ids')?.status).toBe('fail')
    expect(checkFor(result, 'sheets-ids')?.detail).toContain('Read Sheet')
  })

  it('never renders a bare pass for a non-empty Sheet ID -- the unverified caveat is always present', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Read Sheet', type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [0, 0], parameters: { documentId: { __rl: true, mode: 'id', value: '1BxiMVs0XRA5real' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    const check = checkFor(result, 'sheets-ids')
    expect(check?.status).toBe('pass')
    expect(check?.detail).toContain('unverified')
    expect(check?.detail).toContain('confirm manually')
  })

  it('passes with no caveat when there are no Google Sheets nodes at all', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({ id }))
    const result = await runPreflight(pack, { live: true, client })
    const check = checkFor(result, 'sheets-ids')
    expect(check?.status).toBe('pass')
    expect(check?.detail).toBeUndefined()
  })
})

describe('runPreflight — webhook-shaped workflow enumeration (--live only, no rendered check)', () => {
  it('populates webhookShapedWorkflows without adding a visible check line', async () => {
    const pack = makePack({ workflows: [cleanWorkflow({ name: 'Has Webhook' })] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    expect(result.webhookShapedWorkflows).toEqual(['Has Webhook'])
    expect(result.checks.some((c) => c.id.includes('webhook'))).toBe(false)
  })

  it('is undefined when --live was not passed', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack)
    expect(result.webhookShapedWorkflows).toBeUndefined()
  })
})
