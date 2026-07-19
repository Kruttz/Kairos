import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { proposeRepair, formatRepairProposal, type RepairProposal } from '../../../../src/reliability/repair/propose.js'
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

async function proposeForDrift(): Promise<RepairProposal> {
  const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
  const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])
  const result = await proposeRepair({
    workflowId: 'wf-1', workflowName: 'Test WF', clientId: 'acme',
    currentWorkflow: live, storedWorkflow: stored,
    traces: [makeTrace()],
  })
  if (result.status !== 'proposed') throw new Error(`expected 'proposed', got '${result.status}'`)
  return result.proposal
}

describe('proposeRepair', () => {
  it('returns not_drifting when live matches stored -- nothing to propose', async () => {
    const workflow = makeWorkflow()
    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: workflow, storedWorkflow: workflow,
      traces: [makeTrace()],
    })
    expect(result.status).toBe('not_drifting')
  })

  it('produces a D9 proposal when live genuinely differs from stored', async () => {
    const proposal = await proposeForDrift()
    expect(proposal.checkId).toBe('D9')
    expect(proposal.repairClass).toBe('mechanical')
  })

  it('the proposed/current workflows are exactly the stored/live inputs', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])
    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })
    if (result.status !== 'proposed') throw new Error('expected proposed')
    expect(result.proposal.proposedWorkflow).toEqual(stored)
    expect(result.proposal.currentWorkflow).toEqual(live)
  })

  it('the hash comparison correctly identifies live-differs-from-stored and proposed-matches-stored', async () => {
    const proposal = await proposeForDrift()
    expect(proposal.hashes.liveDiffersFromStored).toBe(true)
    expect(proposal.hashes.proposedMatchesStored).toBe(true)
    expect(proposal.hashes.storedHash).not.toBe(proposal.hashes.liveHash)
    expect(proposal.hashes.proposedHash).toBe(proposal.hashes.storedHash)
  })

  it('verificationAvailability is no_webhook_trigger for a non-webhook workflow, riskLevel high', async () => {
    const stored = makeWorkflow([NON_WEBHOOK_NODE])
    const live = makeWorkflow([{ ...NON_WEBHOOK_NODE, parameters: { changed: true } }])
    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace({ executedNodes: ['Schedule'] })],
    })
    if (result.status !== 'proposed') throw new Error('expected proposed')
    expect(result.proposal.verificationAvailability).toBe('no_webhook_trigger')
    expect(result.proposal.riskLevel).toBe('high')
  })

  it('verificationAvailability is no_captures for a webhook workflow with no captures on record, riskLevel medium', async () => {
    const proposal = await proposeForDrift()
    expect(proposal.verificationAvailability).toBe('no_captures')
    expect(proposal.riskLevel).toBe('medium')
  })

  it('nextAction is a concrete, runnable command, not a generic message', async () => {
    const stored = makeWorkflow([makeNode({ parameters: { path: 'original', httpMethod: 'POST' } })])
    const live = makeWorkflow([makeNode({ parameters: { path: 'hand-edited', httpMethod: 'POST' } })])
    const result = await proposeRepair({
      workflowId: 'wf-abc123', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })
    if (result.status !== 'proposed') throw new Error('expected proposed')
    expect(result.proposal.nextAction).toContain('wf-abc123')
    expect(result.proposal.nextAction).toContain('acme')
  })

  it('includes a real diff, not an empty string', async () => {
    const proposal = await proposeForDrift()
    expect(proposal.diff.length).toBeGreaterThan(0)
  })

  it('names the specific node when only a parameter value differs -- real finding from the live checkpoint: formatDiff() alone says "No structural changes" for this exact case, which is misleading', async () => {
    // Same node name/type on both sides, only the parameter value differs -- diffWorkflows()
    // alone would report zero changes even though the hash (and D9) correctly show drift.
    const proposal = await proposeForDrift()
    expect(proposal.diff).toContain('No structural changes')
    expect(proposal.diff).toContain('parameter(s) changed on: Webhook')
  })

  it('names connections changed when only wiring differs, not node parameters', async () => {
    const nodeA = makeNode({ id: '1', name: 'Webhook' })
    const nodeB: N8nNode = { id: '2', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: {} }
    const stored = { name: 'x', nodes: [nodeA, nodeB], connections: { Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } }, settings: {} }
    const live = { name: 'x', nodes: [nodeA, nodeB], connections: {}, settings: {} }

    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })
    if (result.status !== 'proposed') throw new Error(`expected proposed, got ${result.status}`)
    expect(result.proposal.diff).toContain('connections changed')
  })

  it('names settings changed when only settings differ', async () => {
    const nodes = [makeNode()]
    const stored: N8nWorkflow = { name: 'x', nodes, connections: {}, settings: { timezone: 'America/New_York' } }
    const live: N8nWorkflow = { name: 'x', nodes, connections: {}, settings: {} }

    const result = await proposeRepair({
      workflowId: 'wf-1', clientId: 'acme',
      currentWorkflow: live, storedWorkflow: stored,
      traces: [makeTrace()],
    })
    if (result.status !== 'proposed') throw new Error(`expected proposed, got ${result.status}`)
    expect(result.proposal.diff).toContain('settings changed')
  })

  it('the rationale carries the confidence-tiered diagnosis language, not a reworded summary', async () => {
    const proposal = await proposeForDrift()
    // D9's diagnosis is high-confidence per diagnose.ts -- "Likely caused by:"
    expect(proposal.rationale).toContain('Likely caused by:')
  })
})

describe('formatRepairProposal', () => {
  it('always states all four Codex-required facts, unconditionally', async () => {
    const proposal = await proposeForDrift()
    const text = formatRepairProposal(proposal)

    expect(text).toContain('Live differs from the known Kairos-stored version')
    expect(text).toContain('The restore target equals the known Kairos-stored version')
    expect(text).toContain('overwrite whatever is currently live, including any manual edits made outside Kairos')
    expect(text).toContain('Post-apply verification is structural only')
    expect(text).toContain('does not fire any webhook or trigger any request')
  })

  it('shows all three hashes and the diff', async () => {
    const proposal = await proposeForDrift()
    const text = formatRepairProposal(proposal)

    expect(text).toContain('Stored (Kairos-known-good)')
    expect(text).toContain('Live (current, on n8n)')
    expect(text).toContain('Proposed (restore target)')
    expect(text).toContain('Diff:')
  })

  it('includes the exact next action', async () => {
    const proposal = await proposeForDrift()
    const text = formatRepairProposal(proposal)
    expect(text).toContain('Next action:')
  })
})
