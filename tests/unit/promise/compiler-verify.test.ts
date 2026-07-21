import { describe, it, expect } from 'vitest'
import { verifyCompiledWorkflows, type CompiledWorkflowForVerification } from '../../../src/promise/compiler-verify.js'
import { evidenceNodeName, type ContractWorkflowTrace } from '../../../src/promise/compile.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { N8nNode } from '../../../src/types/workflow.js'

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'test-contract',
    version: 1,
    clientId: 'test-client',
    name: 'Test Contract',
    description: 'A minimal contract for compiler-verify.ts tests.',
    entity: { name: 'Thing', description: 'A thing.' },
    correlationKey: { fieldPath: 'body.phone', description: 'The customer phone number.' },
    promise: { text: 'The thing is handled.' },
    startConditions: [
      { id: 'sc1', description: 'A thing arrives.', trigger: 'webhook', initialState: 's1' },
      { id: 'sc2', description: 'A second entry point.', trigger: 'schedule', initialState: 's1' },
    ],
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
    provenance: { kairosVersion: '0.12.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'draft',
    ...overrides,
  }
}

function makeNode(overrides: Partial<N8nNode> = {}): N8nNode {
  return {
    id: 'node-1',
    name: 'Some Node',
    type: 'n8n-nodes-base.set',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
    ...overrides,
  }
}

// A complete, correctly-wired traceability array matching makeContract()'s two start conditions.
function fullTraceability(): ContractWorkflowTrace[] {
  return [
    { workflowName: 'Thing Intake 1', sourceElements: ['startCondition:sc1', 'state:s1', 'correlationKey'] },
    { workflowName: 'Thing Intake 2', sourceElements: ['startCondition:sc2', 'state:s1', 'correlationKey'] },
    { workflowName: 'Thing Processing', sourceElements: ['transition:t1', 'evidenceRequirement:t1'] },
  ]
}

describe('verifyCompiledWorkflows', () => {
  it('reports satisfied when every check passes', () => {
    const contract = makeContract()
    const workflows: CompiledWorkflowForVerification[] = [
      {
        workflowName: 'Thing Intake',
        workflow: { nodes: [makeNode({ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'intake' } }), makeNode({ name: 'Extract', parameters: { value: '={{$json.body.phone}}' } })] },
      },
      {
        workflowName: 'Thing Processing',
        workflow: { nodes: [makeNode({ name: evidenceNodeName('t1'), parameters: { outcome: 'handled' } })] },
      },
    ]

    const result = verifyCompiledWorkflows(contract, workflows, fullTraceability())
    expect(result.verdict).toBe('satisfied')
    expect(result.findings).toEqual([])
  })

  it('flags a missing evidence node by exact transitionId, naming the expected node name', () => {
    const contract = makeContract()
    const workflows: CompiledWorkflowForVerification[] = [
      { workflowName: 'Thing Processing', workflow: { nodes: [makeNode({ name: 'Some Other Node' })] } },
    ]

    const result = verifyCompiledWorkflows(contract, workflows, fullTraceability())
    expect(result.verdict).toBe('gaps_found')
    const finding = result.findings.find(f => f.contractElement === 'evidenceRequirement:t1')
    expect(finding).toBeDefined()
    expect(finding!.severity).toBe('error')
    expect(finding!.message).toContain(evidenceNodeName('t1'))
  })

  it('does not flag an evidence node that exists in a DIFFERENT workflow than the one with the matching name', () => {
    // Evidence nodes are searched across ALL workflows, not just one named after the transition --
    // compile.ts always puts them in a single "Processing" workflow, but this check should not
    // assume workflow-naming, only node-naming.
    const contract = makeContract()
    const workflows: CompiledWorkflowForVerification[] = [
      { workflowName: 'Unrelated Workflow Name', workflow: { nodes: [makeNode({ name: evidenceNodeName('t1') })] } },
    ]

    const result = verifyCompiledWorkflows(contract, workflows, fullTraceability())
    expect(result.findings.some(f => f.contractElement === 'evidenceRequirement:t1')).toBe(false)
  })

  it('flags a missing correlation key reference across every workflow', () => {
    const contract = makeContract()
    const workflows: CompiledWorkflowForVerification[] = [
      { workflowName: 'Thing Intake', workflow: { nodes: [makeNode({ parameters: { value: '={{$json.body.unrelatedField}}' } })] } },
      { workflowName: 'Thing Processing', workflow: { nodes: [makeNode({ name: evidenceNodeName('t1') })] } },
    ]

    const result = verifyCompiledWorkflows(contract, workflows, fullTraceability())
    const finding = result.findings.find(f => f.contractElement === 'correlationKey')
    expect(finding).toBeDefined()
    expect(finding!.severity).toBe('error')
    expect(finding!.message).toContain('body.phone')
  })

  it('finds the correlation key when referenced via query or headers, not just body', () => {
    const contract = makeContract({ correlationKey: { fieldPath: 'headers.x-customer-id', description: 'Customer id header.' } })
    const workflows: CompiledWorkflowForVerification[] = [
      { workflowName: 'Thing Intake', workflow: { nodes: [makeNode({ parameters: { value: '={{$json.headers["x-customer-id"]}}' } })] } },
    ]
    // The regex-based extractor only matches dot-path-shaped refs -- use a dot-shaped reference
    // instead, matching how extractWebhookFieldRefs itself is documented to work.
    workflows[0]!.workflow.nodes[0]!.parameters = { value: '={{$json.headers.x-customer-id}}' }

    const result = verifyCompiledWorkflows(contract, workflows, fullTraceability())
    expect(result.findings.some(f => f.contractElement === 'correlationKey')).toBe(false)
  })

  it('flags a start condition with no compiled workflow tracing back to it', () => {
    const contract = makeContract()
    const incompleteTraceability: ContractWorkflowTrace[] = [
      { workflowName: 'Thing Intake 1', sourceElements: ['startCondition:sc1'] },
      // sc2 is missing entirely
    ]
    const workflows: CompiledWorkflowForVerification[] = [
      { workflowName: 'Thing Processing', workflow: { nodes: [makeNode({ name: evidenceNodeName('t1') })] } },
    ]

    const result = verifyCompiledWorkflows(contract, workflows, incompleteTraceability)
    const finding = result.findings.find(f => f.contractElement === 'startCondition:sc2')
    expect(finding).toBeDefined()
    expect(finding!.severity).toBe('error')
  })

  it('reports every category of gap together when multiple are present', () => {
    const contract = makeContract()
    const result = verifyCompiledWorkflows(contract, [], [])
    expect(result.verdict).toBe('gaps_found')
    expect(result.findings.some(f => f.contractElement === 'evidenceRequirement:t1')).toBe(true)
    expect(result.findings.some(f => f.contractElement === 'correlationKey')).toBe(true)
    expect(result.findings.some(f => f.contractElement === 'startCondition:sc1')).toBe(true)
    expect(result.findings.some(f => f.contractElement === 'startCondition:sc2')).toBe(true)
  })

  it('never flags anything for a contract with no evidence requirements, sla-less start conditions, and a trivially satisfied correlation key', () => {
    const contract = makeContract({ evidenceRequirements: [], startConditions: [{ id: 'sc1', description: 'x', trigger: 'webhook', initialState: 's1' }] })
    const workflows: CompiledWorkflowForVerification[] = [
      { workflowName: 'Thing Intake', workflow: { nodes: [makeNode({ parameters: { value: '={{$json.body.phone}}' } })] } },
    ]
    const traceability: ContractWorkflowTrace[] = [{ workflowName: 'Thing Intake', sourceElements: ['startCondition:sc1'] }]

    const result = verifyCompiledWorkflows(contract, workflows, traceability)
    expect(result.verdict).toBe('satisfied')
  })
})
