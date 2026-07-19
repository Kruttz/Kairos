import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { proposeRepair, formatRepairProposal } from '../../../../src/reliability/repair/propose.js'
import type { N8nWorkflow, N8nNode } from '../../../../src/types/workflow.js'
import type { ExecutionTrace } from '../../../../src/library/types.js'

// Redirect HOME so proposeRepair's internal listCapturedPayloads() call never touches the
// real ~/.kairos/captures directory -- same discipline as capture.test.ts/snapshot.test.ts.
let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-propose-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

function makeNode(overrides: Partial<N8nNode> = {}): N8nNode {
  return { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' }, ...overrides }
}

function makeWorkflow(nodes: N8nNode[] = [makeNode()]): N8nWorkflow {
  return { name: 'Repair Test Workflow', nodes, connections: {}, settings: {} }
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    recordedAt: new Date().toISOString(),
    executionId: 'exec-' + Math.random().toString(36).slice(2),
    status: 'success',
    durationMs: 500,
    executedNodes: ['Webhook'],
    erroredNodes: [],
    itemCount: 1,
    nodeDurations: {},
    ...overrides,
  }
}

const NON_WEBHOOK_NODE: N8nNode = { id: '1', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 0], parameters: {} }

describe('proposeRepair', () => {
  it('returns null when live matches stored -- nothing to propose', async () => {
    const workflow = makeWorkflow()
    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: workflow, storedWorkflow: workflow,
      traces: [makeTrace()],
    })
    expect(result).toBeNull()
  })

  it('produces a D9 proposal when live genuinely differs from stored', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const result = await proposeRepair({
      workflowId: 'wf-1', workflowName: 'Test WF', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })

    expect(result).not.toBeNull()
    expect(result!.checkId).toBe('D9')
    expect(result!.repairClass).toBe('mechanical')
    expect(result!.proposedWorkflow).toEqual(stored)
    expect(result!.currentWorkflow).toEqual(live)
  })

  it('the hash comparison correctly identifies live-differs-from-stored and proposed-matches-stored', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })

    expect(result!.hashes.liveDiffersFromStored).toBe(true)
    expect(result!.hashes.proposedMatchesStored).toBe(true)
    expect(result!.hashes.storedHash).not.toBe(result!.hashes.liveHash)
    expect(result!.hashes.proposedHash).toBe(result!.hashes.storedHash)
  })

  it('verificationAvailability is no_webhook_trigger for a non-webhook workflow, riskLevel high', async () => {
    const stored = makeWorkflow([NON_WEBHOOK_NODE])
    const live = makeWorkflow([{ ...NON_WEBHOOK_NODE, parameters: { changed: true } }])

    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace({ executedNodes: ['Schedule'] })],
    })

    expect(result!.verificationAvailability).toBe('no_webhook_trigger')
    expect(result!.riskLevel).toBe('high')
  })

  it('verificationAvailability is no_captures for a webhook workflow with no captures on record, riskLevel medium', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })

    expect(result!.verificationAvailability).toBe('no_captures')
    expect(result!.riskLevel).toBe('medium')
  })

  it('nextAction is a concrete, runnable command, not a generic message', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const result = await proposeRepair({
      workflowId: 'wf-abc123', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })

    expect(result!.nextAction).toContain('wf-abc123')
    expect(result!.nextAction).toContain('acme')
  })

  it('includes a real diff, not an empty string', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })

    expect(result!.diff.length).toBeGreaterThan(0)
  })

  it('the rationale carries the confidence-tiered diagnosis language, not a reworded summary', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })

    // D9's diagnosis is high-confidence per diagnose.ts -- "Likely caused by:"
    expect(result!.rationale).toContain('Likely caused by:')
  })
})

describe('formatRepairProposal', () => {
  it('always states all four Codex-required facts, unconditionally', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const proposal = await proposeRepair({
      workflowId: 'wf-1', workflowName: 'Test WF', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })
    const text = formatRepairProposal(proposal!)

    expect(text).toContain('Live differs from the known Kairos-stored version')
    expect(text).toContain('The restore target equals the known Kairos-stored version')
    expect(text).toContain('overwrite whatever is currently live, including any manual edits made outside Kairos')
    expect(text).toContain('Post-apply verification is structural only')
    expect(text).toContain('does not fire any webhook or trigger any request')
  })

  it('shows all three hashes and the diff', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const proposal = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })
    const text = formatRepairProposal(proposal!)

    expect(text).toContain('Stored (Kairos-known-good)')
    expect(text).toContain('Live (current, on n8n)')
    expect(text).toContain('Proposed (restore target)')
    expect(text).toContain('Diff:')
  })

  it('includes the exact next action', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])

    const proposal = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })
    const text = formatRepairProposal(proposal!)
    expect(text).toContain('Next action:')
  })
})
