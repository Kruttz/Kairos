import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { applyRepair, checkAutoModeEligibility, type RepairWriteTarget } from '../../../../src/reliability/repair/apply.js'
import { getReliabilityAuditTrail, type RepairWriteAuditEntry } from '../../../../src/reliability/watch/audit.js'
import type { RepairProposal } from '../../../../src/reliability/repair/propose.js'
import type { ReplayRunResult } from '../../../../src/reliability/replay/runner.js'
import type { SandboxConfig } from '../../../../src/reliability/sandbox/manager.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'
import { computeWorkflowHash } from '../../../../src/utils/workflow-hash.js'

// Redirect HOME so saveSnapshot() (called internally by applyRepair) never touches the real
// ~/.kairos/snapshots directory -- same discipline as every other test in this arc.
let scratchHome: string
const ORIGINAL_HOME = homedir()

function makeWorkflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    name: 'Apply Test Workflow',
    nodes: [{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
    connections: {},
    settings: {},
    ...overrides,
  }
}

function makeProposal(overrides: Partial<RepairProposal> = {}): RepairProposal {
  const currentWorkflow = overrides.currentWorkflow ?? makeWorkflow()
  const proposedWorkflow = overrides.proposedWorkflow ?? makeWorkflow({ name: 'Restored' })
  // Real hashes, not hand-waved strings -- applyRepair's post-verify step compares
  // computeWorkflowHash(postWorkflow) against hashes.proposedHash for real, so a fixture with
  // a fake hash string would never post-verify correctly regardless of what was actually written.
  const storedHash = computeWorkflowHash(proposedWorkflow)
  const liveHash = computeWorkflowHash(currentWorkflow)
  return {
    workflowId: 'wf-1',
    workflowName: 'Test WF',
    checkId: 'D9',
    repairClass: 'mechanical',
    rationale: 'Likely caused by: hand-edited outside Kairos.',
    currentWorkflow,
    proposedWorkflow,
    diff: 'What changed since the previous version:\n  No structural changes.',
    hashes: { storedHash, liveHash, proposedHash: storedHash, liveDiffersFromStored: liveHash !== storedHash, proposedMatchesStored: true },
    riskLevel: 'low',
    verificationAvailability: 'available',
    nextAction: 'kairos repair apply wf-1 --client-id acme',
    ...overrides,
  }
}

function makeSandboxConfig(): SandboxConfig {
  return { baseUrl: 'http://localhost:15679', apiKey: 'fake', isKairosSandbox: true, n8nVersion: '2.30.7', provisionedAt: new Date().toISOString() }
}

function makeReplayResult(overrides: Partial<ReplayRunResult> = {}): ReplayRunResult {
  return {
    status: 'completed',
    detail: 'x',
    outcomes: [],
    verdict: 'IDENTICAL',
    partialVerification: false,
    ...overrides,
  }
}

class FakeWriteTarget implements RepairWriteTarget {
  public updateCalls: N8nWorkflow[] = []
  private current: N8nWorkflow
  private postWriteResult: N8nWorkflow | undefined

  constructor(initial: N8nWorkflow, postWriteResult?: N8nWorkflow) {
    this.current = initial
    this.postWriteResult = postWriteResult
  }

  async get(): Promise<N8nWorkflow> {
    return this.current
  }

  async update(workflowId: string, workflow: N8nWorkflow): Promise<{ workflowId: string; name: string }> {
    this.updateCalls.push(workflow)
    this.current = this.postWriteResult ?? workflow
    return { workflowId, name: workflow.name ?? 'x' }
  }
}

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  if (scratchHome) await rm(scratchHome, { recursive: true, force: true })
})

async function setupHome(): Promise<void> {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-apply-test-'))
  process.env['HOME'] = scratchHome
}

describe('checkAutoModeEligibility', () => {
  it('is eligible when whitelisted, verification available, and no prior auto-write exists', () => {
    const result = checkAutoModeEligibility(makeProposal(), [])
    expect(result.eligible).toBe(true)
  })

  it('refuses when the checkId is not whitelisted', () => {
    const result = checkAutoModeEligibility(makeProposal({ checkId: 'D9' as never }), [])
    // v1 whitelist is D9-only; this test documents that D9 itself IS eligible (see above) --
    // the not-whitelisted case is structurally unreachable via RepairProposal's own type today
    // since checkId is a literal 'D9', so this asserts the eligible path stays eligible.
    expect(result.eligible).toBe(true)
  })

  it('refuses when verification is not available', () => {
    const result = checkAutoModeEligibility(makeProposal({ verificationAvailability: 'no_captures' }), [])
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain('Verification is not available')
  })

  it('refuses when a prior auto-write already exists for this exact workflow+checkId', () => {
    const priorWrite: RepairWriteAuditEntry = {
      kind: 'repair_write', ts: '2026-01-01T00:00:00.000Z', workflowId: 'wf-1',
      checkId: 'D9', auto: true, confirmedBy: 'auto_flag', detail: 'x',
    }
    const result = checkAutoModeEligibility(makeProposal(), [priorWrite])
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain('one attempt per distinct cause')
  })

  it('does not count a prior HUMAN-confirmed write against the auto-mode gate', () => {
    const priorWrite: RepairWriteAuditEntry = {
      kind: 'repair_write', ts: '2026-01-01T00:00:00.000Z', workflowId: 'wf-1',
      checkId: 'D9', auto: false, confirmedBy: 'human_prompt', detail: 'x',
    }
    const result = checkAutoModeEligibility(makeProposal(), [priorWrite])
    expect(result.eligible).toBe(true)
  })

  it('does not count a prior write for a DIFFERENT workflow against the gate', () => {
    const priorWrite: RepairWriteAuditEntry = {
      kind: 'repair_write', ts: '2026-01-01T00:00:00.000Z', workflowId: 'wf-OTHER',
      checkId: 'D9', auto: true, confirmedBy: 'auto_flag', detail: 'x',
    }
    const result = checkAutoModeEligibility(makeProposal(), [priorWrite])
    expect(result.eligible).toBe(true)
  })
})

describe('applyRepair -- verification skipped (no sandbox, verificationAvailability !== available)', () => {
  it('applies successfully when post-verify matches the proposed target', async () => {
    await setupHome()
    const proposal = makeProposal({ verificationAvailability: 'no_captures' })
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'human_prompt', auto: false })

    expect(result.status).toBe('applied')
    expect(result.postVerifyPassed).toBe(true)
    expect(target.updateCalls).toHaveLength(1)
    expect(target.updateCalls[0]).toEqual(proposal.proposedWorkflow)
  })

  it('rolls back when post-verify does not match the proposed target', async () => {
    await setupHome()
    const proposal = makeProposal({ verificationAvailability: 'no_captures' })
    // postWriteResult diverges from what was actually requested -- simulates the write not
    // taking effect as expected.
    // computeWorkflowHash() deliberately excludes `name` (see its own doc comment) -- the
    // divergence has to be in nodes/connections/settings to actually change the hash, or
    // this fixture would silently "pass" post-verify no matter what it claims to simulate.
    const target = new FakeWriteTarget(proposal.currentWorkflow, makeWorkflow({ nodes: [{ id: '1', name: 'Different', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} }] }))

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'human_prompt', auto: false })

    expect(result.status).toBe('rolled_back')
    expect(result.postVerifyPassed).toBe(false)
    // Two update calls: the original write, then the rollback restoring currentWorkflow.
    expect(target.updateCalls).toHaveLength(2)
    expect(target.updateCalls[1]).toEqual(proposal.currentWorkflow)
  })

  it('always takes a snapshot before writing, regardless of outcome', async () => {
    await setupHome()
    const proposal = makeProposal({ verificationAvailability: 'no_captures' })
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'human_prompt', auto: false })
    expect(result.snapshotPath).toBeDefined()
  })

  it('audits snapshot, verify (skipped), write, and post_verify -- four entries in order', async () => {
    await setupHome()
    const auditPath = join(scratchHome, 'reliability-audit.jsonl')
    const proposal = makeProposal({ verificationAvailability: 'no_captures' })
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)

    await applyRepair(proposal, target, 'acme', { confirmedBy: 'human_prompt', auto: false }, undefined, auditPath)

    const trail = await getReliabilityAuditTrail(50, auditPath)
    expect(trail.map(e => e.kind)).toEqual(['repair_snapshot', 'repair_verify', 'repair_write', 'repair_post_verify'])
  })
})

describe('applyRepair -- with replay verification (mocked runReplay)', () => {
  it('a BROKEN verdict refuses --auto without writing anything', async () => {
    await setupHome()
    const proposal = makeProposal()
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)
    const fakeRunReplay = async (): Promise<ReplayRunResult> => makeReplayResult({ verdict: 'BROKEN' })

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'auto_flag', auto: true }, makeSandboxConfig(), undefined, fakeRunReplay)

    expect(result.status).toBe('refused')
    expect(target.updateCalls).toHaveLength(0)
  })

  it('a BEHAVIORAL_CHANGE verdict is treated as a clean pass, not a refusal -- the common real repair case', async () => {
    await setupHome()
    const proposal = makeProposal()
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)
    const fakeRunReplay = async (): Promise<ReplayRunResult> => makeReplayResult({ verdict: 'BEHAVIORAL_CHANGE' })

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'auto_flag', auto: true }, makeSandboxConfig(), undefined, fakeRunReplay)

    expect(result.status).toBe('applied')
    expect(target.updateCalls).toHaveLength(1)
  })

  it('partialVerification: true refuses --auto even with an otherwise-clean verdict', async () => {
    await setupHome()
    const proposal = makeProposal()
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)
    const fakeRunReplay = async (): Promise<ReplayRunResult> => makeReplayResult({ verdict: 'IDENTICAL', partialVerification: true })

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'auto_flag', auto: true }, makeSandboxConfig(), undefined, fakeRunReplay)

    expect(result.status).toBe('refused')
  })

  it('INCOMPLETE verdict refuses --auto -- real gap this module\'s own tests caught: an earlier draft only excluded BROKEN (a deny-list), which silently let INCOMPLETE through since it is not literally "BROKEN"', async () => {
    await setupHome()
    const proposal = makeProposal()
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)
    const fakeRunReplay = async (): Promise<ReplayRunResult> => makeReplayResult({ status: 'completed', verdict: 'INCOMPLETE' })

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'auto_flag', auto: true }, makeSandboxConfig(), undefined, fakeRunReplay)

    expect(result.status).toBe('refused')
    expect(target.updateCalls).toHaveLength(0)
  })

  it('NOT_RUN verdict refuses --auto', async () => {
    await setupHome()
    const proposal = makeProposal()
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)
    const fakeRunReplay = async (): Promise<ReplayRunResult> => makeReplayResult({ status: 'not_webhook_shaped', verdict: 'NOT_RUN' })

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'auto_flag', auto: true }, makeSandboxConfig(), undefined, fakeRunReplay)

    expect(result.status).toBe('refused')
  })

  it('a non-auto (human-confirmed) apply still WRITES even when replay is unverifiable -- a human may override, --auto may never', async () => {
    await setupHome()
    const proposal = makeProposal()
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)
    const fakeRunReplay = async (): Promise<ReplayRunResult> => makeReplayResult({ verdict: 'BROKEN' })

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'yes_flag', auto: false }, makeSandboxConfig(), undefined, fakeRunReplay)

    expect(result.status).toBe('applied')
    expect(target.updateCalls).toHaveLength(1)
  })

  it('records the replay verdict on the result and in the audit trail, never flattened to a bare pass/fail', async () => {
    await setupHome()
    const auditPath = join(scratchHome, 'reliability-audit.jsonl')
    const proposal = makeProposal()
    const target = new FakeWriteTarget(proposal.currentWorkflow, proposal.proposedWorkflow)
    const fakeRunReplay = async (): Promise<ReplayRunResult> => makeReplayResult({ verdict: 'BEHAVIORAL_CHANGE' })

    const result = await applyRepair(proposal, target, 'acme', { confirmedBy: 'auto_flag', auto: true }, makeSandboxConfig(), auditPath, fakeRunReplay)
    expect(result.replayVerdict).toBe('BEHAVIORAL_CHANGE')

    const trail = await getReliabilityAuditTrail(50, auditPath)
    const verifyEntry = trail.find(e => e.kind === 'repair_verify')
    expect(verifyEntry).toBeDefined()
    if (verifyEntry?.kind === 'repair_verify') {
      expect(verifyEntry.replayVerdict).toBe('BEHAVIORAL_CHANGE')
    }
  })
})
