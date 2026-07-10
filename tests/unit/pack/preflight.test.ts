import { describe, it, expect, vi } from 'vitest'
import { runPreflight, formatPreflightChecklist, parseCredentialClientSlug } from '../../../src/pack/preflight.js'
import type { TelemetryCollector } from '../../../src/telemetry/collector.js'
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

describe('parseCredentialClientSlug', () => {
  it('parses the client slug from a conforming name, lowercased', () => {
    expect(parseCredentialClientSlug('client:empire:slack:referrals')).toBe('empire')
  })

  it('is case-insensitive on both the "client:" literal and the slug itself', () => {
    expect(parseCredentialClientSlug('Client:Empire:Slack:referrals')).toBe('empire')
    expect(parseCredentialClientSlug('CLIENT:EMPIRE:slack')).toBe('empire')
  })

  it('returns null for a name that does not follow the convention at all', () => {
    expect(parseCredentialClientSlug('Empire Slack')).toBeNull()
    expect(parseCredentialClientSlug('Team Slack')).toBeNull()
    expect(parseCredentialClientSlug('')).toBeNull()
  })

  it('returns null for a name that only superficially resembles the convention', () => {
    expect(parseCredentialClientSlug('client-empire-slack')).toBeNull() // wrong separator
    expect(parseCredentialClientSlug('client:')).toBeNull() // empty slug
    expect(parseCredentialClientSlug('not-client:empire:slack')).toBeNull() // "client:" must lead
  })
})

describe('runPreflight — with --live: credential-client-binding (needs --client-id)', () => {
  it('skips entirely when --client-id is not provided, even with --live -- opt-in, zero behavior change by default', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [0, 0], parameters: {}, credentials: { slackApi: { id: 'real-cred-1', name: 'client:acme:slack:referrals' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('skip')
    expect(checkFor(result, 'credential-client-binding')?.detail).toContain('--client-id not provided')
  })

  it('skips with "needs --live" when --client-id is provided but --live is not', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack, { clientId: 'empire' })
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('skip')
    expect(checkFor(result, 'credential-client-binding')?.detail).toContain('needs --live')
  })

  it('passes when every real credential is named for the preflighted client', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [0, 0], parameters: {}, credentials: { slackApi: { id: 'real-cred-1', name: 'client:empire:slack:referrals' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client, clientId: 'empire' })
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('pass')
  })

  it('matches case-insensitively -- clientId "Empire" matches a credential named "client:empire:..."', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [0, 0], parameters: {}, credentials: { slackApi: { id: 'real-cred-1', name: 'client:empire:slack:referrals' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client, clientId: 'Empire' })
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('pass')
  })

  it('FAILS (NO-GO) on a confirmed mismatch -- a credential named for a different client', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [0, 0], parameters: {}, credentials: { slackApi: { id: 'real-cred-1', name: 'client:acme:slack:referrals' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client, clientId: 'empire' })
    expect(result.verdict).toBe('NO-GO')
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('fail')
    expect(checkFor(result, 'credential-client-binding')?.detail).toContain('Post to Slack')
    expect(checkFor(result, 'credential-client-binding')?.detail).toContain('client "acme"')
    expect(checkFor(result, 'credential-client-binding')?.detail).toContain('client "empire"')
  })

  it('WARNS (not fails) on a credential name that does not follow the convention -- unverifiable, not confirmed wrong', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [0, 0], parameters: {}, credentials: { slackApi: { id: 'real-cred-1', name: 'Empire Slack' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client, clientId: 'empire' })
    expect(result.verdict).toBe('GO WITH WARNINGS')
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('warn')
    expect(checkFor(result, 'credential-client-binding')?.detail).toContain('Empire Slack')
    expect(checkFor(result, 'credential-client-binding')?.detail).toContain('Naming convention')
  })

  it('does not double-flag an unwired/placeholder credential as a mismatch -- placeholder-credentials already covers that case', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [0, 0], parameters: {}, credentials: { slackApi: { id: 'placeholder-id', name: 'Slack' } } }],
    }))
    const result = await runPreflight(pack, { live: true, client, clientId: 'empire' })
    expect(checkFor(result, 'placeholder-credentials')?.status).toBe('fail')
    // The binding check has nothing to say about a credential that isn't wired at all yet.
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('pass')
  })

  it('passes when a pack has no credentials at all', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const client = mockClient(async (id) => makeResponse({ id }))
    const result = await runPreflight(pack, { live: true, client, clientId: 'empire' })
    expect(checkFor(result, 'credential-client-binding')?.status).toBe('pass')
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

describe('runPreflight — test-artifact presence (Phase 3)', () => {
  it('without --live: never claims a specific count -- phrased as "requires --live", not "N workflows may be..."', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack, { bundleDir: '/some/dir' })
    const check = checkFor(result, 'test-artifacts')
    expect(check?.status).toBe('skip')
    expect(check?.detail).toBe('Webhook artifact checks require --live')
  })

  it('--live without --bundle-dir: reports a real count as informational, recommends --bundle-dir', async () => {
    const pack = makePack({ workflows: [cleanWorkflow({ name: 'Has Webhook' })] })
    const client = mockClient(async (id) => makeResponse({
      id,
      nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
    }))
    const result = await runPreflight(pack, { live: true, client })
    const check = checkFor(result, 'test-artifacts')
    expect(check?.status).toBe('info')
    expect(check?.detail).toContain('1 webhook-shaped workflow(s) found')
    expect(check?.detail).toContain('--bundle-dir')
  })

  it('--live + --bundle-dir: warns (not fails) when artifacts are missing -- non-blocking at most GO WITH WARNINGS', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'kairos-preflight-bundle-'))
    try {
      const pack = makePack({ workflows: [cleanWorkflow({ name: 'Has Webhook' })] })
      const client = mockClient(async (id) => makeResponse({
        id,
        nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
      }))
      const result = await runPreflight(pack, { live: true, client, bundleDir: dir })
      expect(result.verdict).not.toBe('NO-GO')
      const check = checkFor(result, 'test-artifacts')
      expect(check?.status).toBe('warn')
      expect(check?.detail).toContain('test-payloads.json')
      expect(check?.detail).toContain('contract.openapi.json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('--live + --bundle-dir: passes when both artifact files exist', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'kairos-preflight-bundle-'))
    try {
      await writeFile(join(dir, 'has-webhook.test-payloads.json'), '{}')
      await writeFile(join(dir, 'has-webhook.contract.openapi.json'), '{}')
      const pack = makePack({ workflows: [cleanWorkflow({ name: 'Has Webhook' })] })
      const client = mockClient(async (id) => makeResponse({
        id,
        nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
      }))
      const result = await runPreflight(pack, { live: true, client, bundleDir: dir })
      expect(checkFor(result, 'test-artifacts')?.status).toBe('pass')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runPreflight — bundle manifest freshness (Phase 3)', () => {
  it('is not rendered at all when --bundle-dir was not given', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack)
    expect(checkFor(result, 'bundle-manifest')).toBeUndefined()
  })

  it('surfaces generatedAt and skipped artifacts when the manifest exists', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'kairos-preflight-manifest-'))
    try {
      await writeFile(join(dir, 'bundle-manifest.json'), JSON.stringify({
        generatedAt: '2026-07-08T20:35:59.000Z',
        packName: 'empire-homecare',
        files: [],
        skipped: [{ artifact: 'workflow.json', workflowName: 'Missed-Call Text-Back', reason: 'n8n fetch failed' }],
      }))
      const pack = makePack({ workflows: [cleanWorkflow()] })
      const result = await runPreflight(pack, { bundleDir: dir })
      const check = checkFor(result, 'bundle-manifest')
      expect(check?.status).toBe('info')
      expect(check?.detail).toContain('2026-07-08T20:35:59.000Z')
      expect(check?.detail).toContain('workflow.json')
      expect(check?.detail).toContain('Missed-Call Text-Back')
      expect(check?.detail).toContain('n8n fetch failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('warns (does not throw) when bundle-manifest.json is missing at the given --bundle-dir', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'kairos-preflight-nomanifest-'))
    try {
      const pack = makePack({ workflows: [cleanWorkflow()] })
      const result = await runPreflight(pack, { bundleDir: dir })
      const check = checkFor(result, 'bundle-manifest')
      expect(check?.status).toBe('warn')
      expect(check?.detail).toContain('Could not read bundle-manifest.json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flags "predates provenance tracking" when the manifest has no provenance field', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'kairos-preflight-old-manifest-'))
    try {
      await writeFile(join(dir, 'bundle-manifest.json'), JSON.stringify({
        generatedAt: '2026-07-08T20:35:59.000Z', packName: 'empire-homecare', files: [], skipped: [],
      }))
      const pack = makePack({ workflows: [cleanWorkflow()] })
      const result = await runPreflight(pack, { bundleDir: dir })
      expect(checkFor(result, 'bundle-manifest')?.detail).toContain('predates provenance tracking')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flags matching versions when the manifest provenance equals current', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { getRuleSetVersion, getPromptTemplateVersion, getPromptProfile, getNodeCatalogVersion, getKairosVersion } = await import('../../../src/validation/provenance-versions.js')
    const dir = await mkdtemp(join(tmpdir(), 'kairos-preflight-same-provenance-'))
    try {
      await writeFile(join(dir, 'bundle-manifest.json'), JSON.stringify({
        generatedAt: '2026-07-08T20:35:59.000Z', packName: 'empire-homecare', files: [], skipped: [],
        provenance: { kairosVersion: getKairosVersion(), ruleSetVersion: getRuleSetVersion(), promptTemplateVersion: getPromptTemplateVersion(), promptProfile: getPromptProfile(), nodeCatalogVersion: getNodeCatalogVersion() },
      }))
      const pack = makePack({ workflows: [cleanWorkflow()] })
      const result = await runPreflight(pack, { bundleDir: dir })
      expect(checkFor(result, 'bundle-manifest')?.detail).toContain('same Kairos version/rule-set/prompt-template/prompt-profile/catalog as current')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flags a version mismatch when the manifest provenance differs from current', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'kairos-preflight-diff-provenance-'))
    try {
      await writeFile(join(dir, 'bundle-manifest.json'), JSON.stringify({
        generatedAt: '2026-07-08T20:35:59.000Z', packName: 'empire-homecare', files: [], skipped: [],
        provenance: { kairosVersion: 'stale-version', ruleSetVersion: 'stale-version', promptTemplateVersion: 'stale-version', promptProfile: 'standard', nodeCatalogVersion: {} },
      }))
      const pack = makePack({ workflows: [cleanWorkflow()] })
      const result = await runPreflight(pack, { bundleDir: dir })
      expect(checkFor(result, 'bundle-manifest')?.detail).toContain('different Kairos version/rule-set/prompt-template/prompt-profile/catalog than current')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runPreflight — provenance stamp', () => {
  it('always includes real content-derived provenance, regardless of --live/--bundle-dir', async () => {
    const { getRuleSetVersion, getPromptTemplateVersion, getPromptProfile, getNodeCatalogVersion } = await import('../../../src/validation/provenance-versions.js')
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack)
    expect(result.provenance.ruleSetVersion).toBe(getRuleSetVersion())
    expect(result.provenance.promptTemplateVersion).toBe(getPromptTemplateVersion())
    expect(result.provenance.promptProfile).toBe(getPromptProfile())
    expect(result.provenance.nodeCatalogVersion).toEqual(getNodeCatalogVersion())
  })

  it('a telemetry emit() rejection does not throw out of runPreflight() or change the returned result', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const failingTelemetry = { emit: vi.fn().mockRejectedValue(new Error('disk full')) } as unknown as TelemetryCollector

    const result = await runPreflight(pack, { telemetry: failingTelemetry })

    expect(failingTelemetry.emit).toHaveBeenCalledOnce()
    expect(result.packName).toBe(pack.packName)
    expect(result.verdict).toBeDefined()
  })
})
