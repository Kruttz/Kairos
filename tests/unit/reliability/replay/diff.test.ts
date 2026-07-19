import { describe, it, expect } from 'vitest'
import {
  diffPayloadExecution,
  aggregateReplayResults,
  formatPayloadDiffResult,
  formatReplaySuiteResult,
  type ReplayExecutionSnapshot,
} from '../../../../src/reliability/replay/diff.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'

// Webhook -> Set (no credential) -> HTTP Request (credentialed) -> Send Email (credentialed,
// only reachable through HTTP Request) -- the realistic shape almost every real Kairos
// workflow has: a credential-free trigger/logic prefix, then a credentialed tail.
function makeWorkflow(overrides?: Partial<N8nWorkflow>): N8nWorkflow {
  return {
    nodes: [
      { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} },
      { id: '2', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [250, 0], parameters: {} },
      { id: '3', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [500, 0], parameters: {}, credentials: { httpBasicAuth: { id: 'c1', name: 'Cred' } } },
      { id: '4', name: 'Send Email', type: 'n8n-nodes-base.gmail', typeVersion: 2, position: [750, 0], parameters: {}, credentials: { gmailOAuth2: { id: 'c2', name: 'Cred' } } },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
      Set: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
      'HTTP Request': { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] },
    },
    settings: {},
    ...overrides,
  }
}

function snapshot(overrides: Partial<ReplayExecutionSnapshot> & { nodes: ReplayExecutionSnapshot['nodes'] }): ReplayExecutionSnapshot {
  return { executionId: 'exec-1', ...overrides }
}

describe('diffPayloadExecution -- no fake equivalence', () => {
  it('does NOT report IDENTICAL when both sides fail identically at a credentialed node -- partialVerification must be true', () => {
    const workflow = makeWorkflow()
    const bothSameFailure: ReplayExecutionSnapshot['nodes'] = {
      Webhook: { ran: true, status: 'success', outputShape: { body: 'object' } },
      Set: { ran: true, status: 'success', outputShape: { customerName: 'string' } },
      'HTTP Request': { ran: true, status: 'error', errorType: 'NodeApiError' },
      // Send Email never runs -- HTTP Request failed before reaching it
    }
    const result = diffPayloadExecution(
      'exec-1', workflow, workflow,
      snapshot({ nodes: bothSameFailure }),
      snapshot({ nodes: { ...bothSameFailure } }),
    )

    expect(result.partialVerification).toBe(true)
    // The credentialed node itself and everything downstream of it must appear in the
    // boundary as unverifiable -- not silently folded into a clean verdict.
    const unverifiableNames = result.verificationBoundary.unverifiable.map(u => u.node)
    expect(unverifiableNames).toContain('HTTP Request')
    expect(unverifiableNames).toContain('Send Email')
    for (const u of result.verificationBoundary.unverifiable) {
      expect(u.reason).toMatch(/credential_stripped|downstream_of_unverifiable/)
    }
  })

  it('the rendered report makes the boundary loud, not a footnote', () => {
    const workflow = makeWorkflow()
    const nodes: ReplayExecutionSnapshot['nodes'] = {
      Webhook: { ran: true, status: 'success', outputShape: {} },
      Set: { ran: true, status: 'success', outputShape: {} },
      'HTTP Request': { ran: true, status: 'error', errorType: 'NodeApiError' },
    }
    const result = diffPayloadExecution('exec-1', workflow, workflow, snapshot({ nodes }), snapshot({ nodes: { ...nodes } }))
    const rendered = formatPayloadDiffResult(result)
    expect(rendered).toContain('PARTIAL VERIFICATION')
    expect(rendered).toContain('VERIFICATION BOUNDARY')
    expect(rendered).toContain('not exercised')
    expect(rendered).toContain('HTTP Request')
  })

  it('still catches a real behavioral change in the credential-free prefix, not swallowed by downstream credential noise', () => {
    const workflow = makeWorkflow()
    const baselineNodes: ReplayExecutionSnapshot['nodes'] = {
      Webhook: { ran: true, status: 'success', outputShape: { body: 'object' } },
      Set: { ran: true, status: 'success', outputShape: { customerName: 'string' } },
      'HTTP Request': { ran: true, status: 'error', errorType: 'NodeApiError' },
    }
    const candidateNodes: ReplayExecutionSnapshot['nodes'] = {
      Webhook: { ran: true, status: 'success', outputShape: { body: 'object' } },
      // Set's output shape changed -- a real, verifiable behavioral difference in the
      // credential-free part of the workflow.
      Set: { ran: true, status: 'success', outputShape: { customerName: 'string', customerEmail: 'string' } },
      'HTTP Request': { ran: true, status: 'error', errorType: 'NodeApiError' },
    }
    const result = diffPayloadExecution('exec-1', workflow, workflow, snapshot({ nodes: baselineNodes }), snapshot({ nodes: candidateNodes }))

    expect(result.verdict).toBe('BEHAVIORAL_CHANGE')
    expect(result.partialVerification).toBe(true) // still true -- HTTP Request/Send Email remain unverifiable
    const setDiff = result.nodeDiffs.find(d => d.node === 'Set')
    expect(setDiff?.status).toBe('changed')
    // Structured before/after shapes, not just a formatted string -- so any formatter
    // (technical or operator-facing) can build its own field-level breakdown.
    expect(setDiff?.baselineOutputShape).toEqual({ customerName: 'string' })
    expect(setDiff?.candidateOutputShape).toEqual({ customerName: 'string', customerEmail: 'string' })
  })

  it('trusts a genuine successful run over the structural credential assumption when both sides actually succeed', () => {
    // A credentialed node that happens to run fine in the sandbox on both sides (e.g. it
    // no-ops instead of throwing) is trusted as real, verified data -- not forced into
    // "unverifiable" against the evidence.
    const workflow = makeWorkflow()
    const nodes: ReplayExecutionSnapshot['nodes'] = {
      Webhook: { ran: true, status: 'success', outputShape: {} },
      Set: { ran: true, status: 'success', outputShape: {} },
      'HTTP Request': { ran: true, status: 'success', outputShape: { statusCode: 'number' } },
      'Send Email': { ran: true, status: 'success', outputShape: { messageId: 'string' } },
    }
    const result = diffPayloadExecution('exec-1', workflow, workflow, snapshot({ nodes }), snapshot({ nodes: { ...nodes } }))
    expect(result.partialVerification).toBe(false)
    expect(result.verdict).toBe('IDENTICAL')
    const httpDiff = result.nodeDiffs.find(d => d.node === 'HTTP Request')
    expect(httpDiff?.status).toBe('match')
  })
})

describe('diffPayloadExecution -- verdicts on fully credential-free workflows', () => {
  const freeWorkflow: N8nWorkflow = {
    nodes: [
      { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} },
      { id: '2', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [250, 0], parameters: {} },
    ],
    connections: { Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
    settings: {},
  }

  it('reports IDENTICAL with no partial verification when everything matches', () => {
    const nodes: ReplayExecutionSnapshot['nodes'] = {
      Webhook: { ran: true, status: 'success', outputShape: { body: 'object' } },
      Set: { ran: true, status: 'success', outputShape: { x: 'string' } },
    }
    const result = diffPayloadExecution('exec-1', freeWorkflow, freeWorkflow, snapshot({ nodes, durationMs: 500 }), snapshot({ nodes: { ...nodes }, durationMs: 520 }))
    expect(result.verdict).toBe('IDENTICAL')
    expect(result.partialVerification).toBe(false)
  })

  it('reports BROKEN when candidate errors where baseline succeeded', () => {
    const baselineNodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: true, status: 'success', outputShape: {} } }
    const candidateNodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: true, status: 'error', errorType: 'ExpressionError' } }
    const result = diffPayloadExecution('exec-1', freeWorkflow, freeWorkflow, snapshot({ nodes: baselineNodes }), snapshot({ nodes: candidateNodes }))
    expect(result.verdict).toBe('BROKEN')
  })

  it('reports BEHAVIORAL_CHANGE, not BROKEN, when candidate succeeds where baseline errored (an improvement, still surfaced)', () => {
    const baselineNodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: true, status: 'error', errorType: 'ExpressionError' } }
    const candidateNodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: true, status: 'success', outputShape: { x: 'string' } } }
    const result = diffPayloadExecution('exec-1', freeWorkflow, freeWorkflow, snapshot({ nodes: baselineNodes }), snapshot({ nodes: candidateNodes }))
    expect(result.verdict).toBe('BEHAVIORAL_CHANGE')
  })

  it('reports BENIGN_VARIANCE when only duration diverges beyond the threshold, nothing else changed', () => {
    const nodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: true, status: 'success', outputShape: {} } }
    const result = diffPayloadExecution('exec-1', freeWorkflow, freeWorkflow, snapshot({ nodes, durationMs: 500 }), snapshot({ nodes: { ...nodes }, durationMs: 2000 }))
    expect(result.verdict).toBe('BENIGN_VARIANCE')
  })

  it('reports a coverage change (branch flip) as BEHAVIORAL_CHANGE', () => {
    const baselineNodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: true, status: 'success', outputShape: {} } }
    const candidateNodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: false, status: null } }
    const result = diffPayloadExecution('exec-1', freeWorkflow, freeWorkflow, snapshot({ nodes: baselineNodes }), snapshot({ nodes: candidateNodes }))
    expect(result.verdict).toBe('BEHAVIORAL_CHANGE')
  })

  it('does not flag a node neither side reached as a finding -- an untaken conditional branch, not a diff', () => {
    const withBranch: N8nWorkflow = {
      nodes: [...freeWorkflow.nodes, { id: '3', name: 'Escalation Path', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [500, 0], parameters: {} }],
      connections: freeWorkflow.connections,
      settings: {},
    }
    const nodes: ReplayExecutionSnapshot['nodes'] = { Webhook: { ran: true, status: 'success', outputShape: {} }, Set: { ran: true, status: 'success', outputShape: {} } }
    const result = diffPayloadExecution('exec-1', withBranch, withBranch, snapshot({ nodes }), snapshot({ nodes: { ...nodes } }))
    const escalationDiff = result.nodeDiffs.find(d => d.node === 'Escalation Path')
    expect(escalationDiff?.status).toBe('not_reached_by_this_payload')
    expect(result.verdict).toBe('IDENTICAL')
  })
})

describe('aggregateReplayResults', () => {
  it('the suite verdict is the single worst verdict among all payloads', () => {
    const workflow: N8nWorkflow = { nodes: [], connections: {}, settings: {} }
    const identical = diffPayloadExecution('p1', workflow, workflow, snapshot({ nodes: {} }), snapshot({ nodes: {} }))
    const broken = diffPayloadExecution('p2', workflow, workflow,
      snapshot({ nodes: { X: { ran: true, status: 'success', outputShape: {} } } }),
      snapshot({ nodes: { X: { ran: true, status: 'error', errorType: 'E' } } }))
    const suite = aggregateReplayResults([identical, broken])
    expect(suite.verdict).toBe('BROKEN')
  })

  it('partialVerification is true if ANY payload had partial verification', () => {
    const workflow = makeWorkflow()
    const partial = diffPayloadExecution('p1', workflow, workflow,
      snapshot({ nodes: { 'HTTP Request': { ran: true, status: 'error', errorType: 'E' } } }),
      snapshot({ nodes: { 'HTTP Request': { ran: true, status: 'error', errorType: 'E' } } }))
    const freeWorkflow: N8nWorkflow = { nodes: [], connections: {}, settings: {} }
    const full = diffPayloadExecution('p2', freeWorkflow, freeWorkflow, snapshot({ nodes: {} }), snapshot({ nodes: {} }))
    const suite = aggregateReplayResults([full, partial])
    expect(suite.partialVerification).toBe(true)
  })

  it('formatReplaySuiteResult renders every payload', () => {
    const workflow: N8nWorkflow = { nodes: [], connections: {}, settings: {} }
    const r1 = diffPayloadExecution('p1', workflow, workflow, snapshot({ nodes: {} }), snapshot({ nodes: {} }))
    const suite = aggregateReplayResults([r1])
    const rendered = formatReplaySuiteResult(suite)
    expect(rendered).toContain('Replay suite verdict: IDENTICAL')
    expect(rendered).toContain('1 payload(s) replayed')
    expect(rendered).toContain('p1')
  })
})
