import { describe, it, expect, vi } from 'vitest'
import { N8nContractDeployer } from '../../../../src/providers/n8n/contract-target.js'
import { PackBuilder, type PackPlan } from '../../../../src/pack/pack-builder.js'
import type { Kairos } from '../../../../src/client.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.2, correction 1 and correction 3). Direct coverage for N8nContractDeployer's outcome
 * classification -- the true failure signal PackBuilder.build() uses is whether `error` is
 * present, never `workflowId === null` in isolation (a dry-run success and a real failure both
 * have `workflowId: null`). Exercises all three SlotDeployOutcome variants and all four
 * ContractDeployOutcome variants, including the corrected 'generated' overall outcome an
 * all-dry-run build must produce (never 'deployed', under the pre-correction two-outcome-only
 * design).
 */

const MINIMAL_WORKFLOW = { name: 'x', nodes: [], connections: {} }

/** A real PackBuilder wrapping a mocked Kairos.build() -- build() itself never calls the
 * Anthropic client (only .plan() does), so no Anthropic mock is needed at all; this is real,
 * unmodified PackBuilder.build() logic under test, not a re-implementation of it. */
function makeDeployer(buildImpl: (description: string, options: { name?: string; dryRun?: boolean }) => Promise<unknown>): N8nContractDeployer {
  const kairos = { build: vi.fn(buildImpl), drain: vi.fn().mockResolvedValue(undefined) } as unknown as Kairos
  const packBuilder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos })
  return new N8nContractDeployer(packBuilder)
}

function plan(workflowNames: string[], assumptions: PackPlan['assumptions'] = []): PackPlan {
  return {
    businessContext: 'Test contract',
    workflows: workflowNames.map(name => ({ name, description: `Build ${name}`, purpose: 'test' })),
    assumptions,
    sheetsColumns: [],
    testChecklist: [],
  }
}

describe('N8nContractDeployer.deployArtifact() -- outcome classification', () => {
  it('declares targetId "n8n"', () => {
    expect(makeDeployer(() => Promise.resolve({})).targetId).toBe('n8n')
  })

  it('an all-dry-run success: every slot "generated", overall outcome "generated" -- never "deployed"', async () => {
    const deployer = makeDeployer(async () => ({
      workflowId: null, name: 'x', workflow: MINIMAL_WORKFLOW, credentialsNeeded: [], activationRequired: false,
      generationAttempts: 1, dryRun: true, finalIssues: [],
    }))
    const result = await deployer.deployArtifact(plan(['Intake', 'Processing']), { dryRun: true })
    expect(result.slots).toEqual([
      { slotName: 'Intake', outcome: 'generated' },
      { slotName: 'Processing', outcome: 'generated' },
    ])
    expect(result.outcome).toBe('generated')
  })

  it('an all-real-deploy success: every slot "deployed" with a real ref, overall outcome "deployed"', async () => {
    let counter = 0
    const deployer = makeDeployer(async () => ({
      workflowId: `wf-${++counter}`, name: 'x', workflow: MINIMAL_WORKFLOW, credentialsNeeded: [], activationRequired: false,
      generationAttempts: 1, dryRun: false, finalIssues: [],
    }))
    const result = await deployer.deployArtifact(plan(['Intake', 'Processing']), {})
    expect(result.slots).toEqual([
      { slotName: 'Intake', outcome: 'deployed', ref: { targetId: 'n8n', targetDeploymentId: 'wf-1' } },
      { slotName: 'Processing', outcome: 'deployed', ref: { targetId: 'n8n', targetDeploymentId: 'wf-2' } },
    ])
    expect(result.outcome).toBe('deployed')
  })

  it('a mixed real build (one deployed, one throws): overall outcome "partial", the failing slot carries its real error message', async () => {
    const deployer = makeDeployer(async (_desc, options) => {
      if (options.name === 'Escalation') throw new Error('LLM generation failed after 3 attempts')
      return { workflowId: 'wf-ok', name: 'x', workflow: MINIMAL_WORKFLOW, credentialsNeeded: [], activationRequired: false, generationAttempts: 1, dryRun: false, finalIssues: [] }
    })
    const result = await deployer.deployArtifact(plan(['Intake', 'Escalation']), {})
    expect(result.slots).toEqual([
      { slotName: 'Intake', outcome: 'deployed', ref: { targetId: 'n8n', targetDeploymentId: 'wf-ok' } },
      { slotName: 'Escalation', outcome: 'failed', error: 'LLM generation failed after 3 attempts' },
    ])
    expect(result.outcome).toBe('partial')
  })

  it('a mixed dry run (one generated, one throws): overall outcome "partial" -- NOT "generated", since not every slot generated', async () => {
    const deployer = makeDeployer(async (_desc, options) => {
      if (options.name === 'Escalation') throw new Error('validation rejected the generated JSON')
      return { workflowId: null, name: 'x', workflow: MINIMAL_WORKFLOW, credentialsNeeded: [], activationRequired: false, generationAttempts: 1, dryRun: true, finalIssues: [] }
    })
    const result = await deployer.deployArtifact(plan(['Intake', 'Escalation']), { dryRun: true })
    expect(result.slots.map(s => s.outcome)).toEqual(['generated', 'failed'])
    expect(result.outcome).toBe('partial')
  })

  it('a plan with a blocking assumption: PackBuilder.build() itself refuses before any generation spend -- outcome "blocked", zero slots, escalation carried through', async () => {
    const buildFn = vi.fn()
    const deployer = makeDeployer(buildFn)
    const result = await deployer.deployArtifact(plan(['Intake'], [{ type: 'blocking', text: 'Missing Google Sheet ID' }]), {})
    expect(buildFn).not.toHaveBeenCalled()
    expect(result.outcome).toBe('blocked')
    expect(result.slots).toEqual([])
    expect(result.escalation).toBeDefined()
    expect(result.escalation!.source).toBe('blocking_assumptions')
    expect(result.escalation!.questions).toEqual(['Missing Google Sheet ID'])
  })

  it('result.raw is the real, genuinely WorkflowPackResult-typed PackBuilder.build() result -- readable with no cast', async () => {
    const deployer = makeDeployer(async () => ({
      workflowId: 'wf-1', name: 'x', workflow: MINIMAL_WORKFLOW, credentialsNeeded: [], activationRequired: false,
      generationAttempts: 1, dryRun: false, finalIssues: [],
    }))
    const result = await deployer.deployArtifact(plan(['Intake']), {})
    expect(result.raw.workflows).toHaveLength(1)
    expect(result.raw.workflows[0]!.workflowId).toBe('wf-1')
    expect(result.raw.builtAt).toBeTruthy()
  })
})
