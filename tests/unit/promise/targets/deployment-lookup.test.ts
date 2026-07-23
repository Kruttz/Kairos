import { describe, it, expect, vi } from 'vitest'
import { N8nDeploymentLookup } from '../../../../src/providers/n8n/deployment-lookup.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'
import { GuardError } from '../../../../src/errors/guard-error.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.3). N8nDeploymentLookup is a real, non-trivial wrapper around N8nApiClient.getWorkflow()
 * (a genuine GET-by-id call, not "already satisfies the interface") plus its own ref.targetId
 * guard.
 */

const FAKE_WORKFLOW = { id: 'wf-1', name: 'Referral Intake', active: false, nodes: [], connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

function makeMockClient(): N8nApiClient {
  return { getWorkflow: vi.fn().mockResolvedValue(FAKE_WORKFLOW) } as unknown as N8nApiClient
}

describe('N8nDeploymentLookup', () => {
  it('declares targetId "n8n"', () => {
    expect(new N8nDeploymentLookup(makeMockClient()).targetId).toBe('n8n')
  })

  it('fetches the real workflow by targetDeploymentId and returns it as raw, alongside the original ref', async () => {
    const client = makeMockClient()
    const lookup = new N8nDeploymentLookup(client)
    const ref = { targetId: 'n8n', targetDeploymentId: 'wf-1' }
    const snapshot = await lookup.fetchDeployment(ref)
    expect(client.getWorkflow).toHaveBeenCalledWith('wf-1')
    expect(snapshot.ref).toBe(ref)
    expect(snapshot.raw).toEqual(FAKE_WORKFLOW)
  })

  it('throws GuardError, and never calls the API client, when the ref targets a different targetId', async () => {
    const client = makeMockClient()
    const lookup = new N8nDeploymentLookup(client)
    await expect(lookup.fetchDeployment({ targetId: 'in-memory-test', targetDeploymentId: 'x' })).rejects.toThrow(GuardError)
    expect(client.getWorkflow).not.toHaveBeenCalled()
  })
})
