import { describe, it, expect, vi } from 'vitest'
import { N8nCompilerVerifier } from '../../../../src/providers/n8n/compiler-verifier.js'
import { N8nDeploymentLookup } from '../../../../src/providers/n8n/deployment-lookup.js'
import { evidenceNodeName, type ContractWorkflowTrace } from '../../../../src/promise/compile.js'
import type { DeployedSlotRef } from '../../../../src/promise/targets/compiler-verifier.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'
import type { ProcessContract } from '../../../../src/promise/types.js'
import type { N8nNode, N8nWorkflow } from '../../../../src/types/workflow.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.5). N8nCompilerVerifier wraps N8nDeploymentLookup (a real GET-by-id per slot) and the
 * existing, unmodified verifyCompiledWorkflows() -- these tests prove: (1) slot-name resolution
 * (a DeployedSlotRef's own slotName becomes the workflowName verifyCompiledWorkflows() sees),
 * (2) fetch errors are preserved in their own field, never merged into verification.findings,
 * and (3) the documented, accepted indirect-gap conflation (plan §6.5, §13, correction 4) is
 * pinned by a real test, not left as prose alone: a fetch failure for the one workflow holding
 * an evidence node makes that evidence requirement report as a structural gap, indistinguishable
 * from a genuine one, even though the real cause is "could not check."
 */

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'verifier-test-contract',
    version: 1,
    clientId: 'test-client',
    name: 'Test Contract',
    description: 'A minimal contract for N8nCompilerVerifier tests.',
    entity: { name: 'Thing', description: 'A thing.' },
    correlationKey: { fieldPath: 'body.phone', description: 'The customer phone number.' },
    promise: { text: 'The thing is handled.' },
    startConditions: [{ id: 'sc1', description: 'A thing arrives.', trigger: 'webhook', initialState: 's1' }],
    states: [
      { id: 's1', name: 'Received', description: 'Just arrived.', terminal: false },
      { id: 's2', name: 'Done', description: 'Handled.', terminal: true },
    ],
    events: [{ id: 'e1', name: 'Handled', description: 'The thing was handled.' }],
    transitions: [{ id: 't1', fromState: 's1', event: 'e1', toState: 's2' }],
    terminalOutcomes: [{ state: 's2', outcome: 'success', description: 'Handled successfully.' }],
    owners: [],
    sla: [],
    exceptions: [],
    evidenceRequirements: [{ transitionId: 't1', requiredFields: ['outcome'], description: 'Proves the transition happened.' }],
    assumptions: [],
    provenance: { kairosVersion: '0.13.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'draft',
    ...overrides,
  }
}

function makeNode(overrides: Partial<N8nNode> = {}): N8nNode {
  return { id: 'node-1', name: 'Some Node', type: 'n8n-nodes-base.set', typeVersion: 1, position: [0, 0], parameters: {}, ...overrides }
}

const TRACEABILITY: ContractWorkflowTrace[] = [
  { workflowName: 'Thing Intake', sourceElements: ['startCondition:sc1', 'state:s1', 'correlationKey'] },
  { workflowName: 'Thing Processing', sourceElements: ['transition:t1', 'evidenceRequirement:t1'] },
]

function makeWorkflowResponse(id: string, nodes: N8nNode[]): N8nWorkflow & { id: string; active: boolean; createdAt: string; updatedAt: string; connections: Record<string, never> } {
  return { id, name: id, active: false, nodes, connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}

/** getWorkflow(id) resolves/rejects per the supplied per-id behavior map. */
function makeMockApiClient(behavior: Record<string, () => ReturnType<N8nApiClient['getWorkflow']>>): N8nApiClient {
  return {
    getWorkflow: vi.fn((id: string) => {
      const fn = behavior[id]
      if (!fn) throw new Error(`test setup error: no behavior registered for id "${id}"`)
      return fn()
    }),
  } as unknown as N8nApiClient
}

describe('N8nCompilerVerifier', () => {
  it('declares targetId "n8n"', () => {
    const verifier = new N8nCompilerVerifier(new N8nDeploymentLookup(makeMockApiClient({})))
    expect(verifier.targetId).toBe('n8n')
  })

  it('resolves each DeployedSlotRef\'s own slotName to workflowName, and reports "satisfied" when every check passes', async () => {
    const contract = makeContract()
    const apiClient = makeMockApiClient({
      'wf-intake': () => Promise.resolve(makeWorkflowResponse('wf-intake', [
        makeNode({ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'intake' } }),
        makeNode({ name: 'Extract', parameters: { value: '={{$json.body.phone}}' } }),
      ])),
      'wf-processing': () => Promise.resolve(makeWorkflowResponse('wf-processing', [makeNode({ name: evidenceNodeName('t1'), parameters: { outcome: 'handled' } })])),
    })
    const verifier = new N8nCompilerVerifier(new N8nDeploymentLookup(apiClient))
    const deployedSlots: DeployedSlotRef[] = [
      { slotName: 'Thing Intake', ref: { targetId: 'n8n', targetDeploymentId: 'wf-intake' } },
      { slotName: 'Thing Processing', ref: { targetId: 'n8n', targetDeploymentId: 'wf-processing' } },
    ]

    const result = await verifier.verifyCompiledArtifact(contract, deployedSlots, TRACEABILITY)
    expect(result.verification.verdict).toBe('satisfied')
    expect(result.verification.findings).toEqual([])
    expect(result.fetchErrors).toEqual([])
  })

  it('a fetch failure is reported ONLY in fetchErrors, never merged into verification.findings', async () => {
    const contract = makeContract()
    const apiClient = makeMockApiClient({
      'wf-intake': () => Promise.resolve(makeWorkflowResponse('wf-intake', [makeNode({ parameters: { value: '={{$json.body.phone}}' } })])),
      'wf-processing': () => Promise.reject(new Error('n8n API returned 404')),
    })
    const verifier = new N8nCompilerVerifier(new N8nDeploymentLookup(apiClient))
    const deployedSlots: DeployedSlotRef[] = [
      { slotName: 'Thing Intake', ref: { targetId: 'n8n', targetDeploymentId: 'wf-intake' } },
      { slotName: 'Thing Processing', ref: { targetId: 'n8n', targetDeploymentId: 'wf-processing' } },
    ]

    const result = await verifier.verifyCompiledArtifact(contract, deployedSlots, TRACEABILITY)
    expect(result.fetchErrors).toHaveLength(1)
    expect(result.fetchErrors[0]).toContain('Thing Processing')
    expect(result.fetchErrors[0]).toContain('wf-processing')
    expect(result.fetchErrors[0]).toContain('n8n API returned 404')
    // The fetch error itself never appears as a verification.findings entry -- distinct channel.
    expect(result.verification.findings.some(f => f.message.includes('404'))).toBe(false)
  })

  it('documented, accepted conflation (correction 4): a fetch failure for the ONLY workflow holding a required evidence node makes verifyCompiledWorkflows() report that requirement as a structural gap -- indistinguishable from a genuine one, because the failed workflow is simply absent from what it receives', async () => {
    const contract = makeContract()
    const apiClient = makeMockApiClient({
      'wf-intake': () => Promise.resolve(makeWorkflowResponse('wf-intake', [makeNode({ parameters: { value: '={{$json.body.phone}}' } })])),
      'wf-processing': () => Promise.reject(new Error('n8n API returned 404')),
    })
    const verifier = new N8nCompilerVerifier(new N8nDeploymentLookup(apiClient))
    const deployedSlots: DeployedSlotRef[] = [
      { slotName: 'Thing Intake', ref: { targetId: 'n8n', targetDeploymentId: 'wf-intake' } },
      { slotName: 'Thing Processing', ref: { targetId: 'n8n', targetDeploymentId: 'wf-processing' } },
    ]

    const result = await verifier.verifyCompiledArtifact(contract, deployedSlots, TRACEABILITY)
    expect(result.fetchErrors).toHaveLength(1)
    expect(result.verification.verdict).toBe('gaps_found')
    const finding = result.verification.findings.find(f => f.contractElement === 'evidenceRequirement:t1')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain(evidenceNodeName('t1'))
    // The finding's own message has no idea a fetch failure, rather than a genuine missing
    // node, caused it -- that is the conflation this test pins down, not a bug this arc fixes.
    expect(finding!.message).not.toContain('404')
    expect(finding!.message).not.toContain('fetch')
  })
})
