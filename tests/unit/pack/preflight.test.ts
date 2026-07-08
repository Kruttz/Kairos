import { describe, it, expect } from 'vitest'
import { runPreflight, formatPreflightChecklist } from '../../../src/pack/preflight.js'
import type { WorkflowPackResult } from '../../../src/pack/pack-builder.js'

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
  it('verdict is GO when every check passes', async () => {
    const pack = makePack({ workflows: [cleanWorkflow()] })
    const result = await runPreflight(pack)
    expect(result.verdict).toBe('GO')
    expect(result.checks.every((c) => c.status === 'pass' || c.status === 'info')).toBe(true)
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
