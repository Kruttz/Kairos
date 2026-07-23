import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pollWorkflowEvidence } from '../../../../src/promise/ledger.js'
import { N8nExecutionHistorySource } from '../../../../src/providers/n8n/execution-history.js'
import { N8nEvidenceNormalizer } from '../../../../src/providers/n8n/evidence.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'
import type { ProcessContract } from '../../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4, correction 8 from the fourth review round): `PollContractResult` gains canonical
 * `targetId`/`targetDeploymentId` fields, dual-written alongside the still-present legacy
 * `n8nWorkflowId`, mirroring `ContractPollWatermark`'s own fix exactly -- assigned to this same
 * phase, not split across Phase 1 and Phase 4 (the sibling watermark fix already landed here;
 * this closes the one type the fourth review round found had been missed).
 */

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

function mockClient(): N8nApiClient {
  return {
    getExecutions: async () => [{ id: 'e1', startedAt: '2026-07-20T09:00:00.000Z' }],
    getExecution: async () => ({
      id: 'e1',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: { version: 1, resultData: { runData: { 'Webhook: Intake': [{ data: { main: [[{ json: { body: { phone: '555-0100' } } }]] } }] } } },
    }),
  } as unknown as N8nApiClient
}

describe('PollContractResult -- target-aware compatibility', () => {
  it('dual-writes targetId/targetDeploymentId alongside the legacy n8nWorkflowId', async () => {
    const contract = empireHomecare()
    const result = await pollWorkflowEvidence(
      contract,
      { targetId: 'n8n', targetDeploymentId: 'wf-1' },
      new N8nExecutionHistorySource(mockClient()),
      new N8nEvidenceNormalizer(),
      null, 20, ['startCondition:sc-intake', 'state:received', 'correlationKey']
    )

    expect(result.targetId).toBe('n8n')
    expect(result.targetDeploymentId).toBe('wf-1')
    expect(result.n8nWorkflowId).toBe('wf-1')
  })

  it('the returned newWatermark also carries the canonical fields', async () => {
    const contract = empireHomecare()
    const result = await pollWorkflowEvidence(
      contract,
      { targetId: 'n8n', targetDeploymentId: 'wf-1' },
      new N8nExecutionHistorySource(mockClient()),
      new N8nEvidenceNormalizer(),
      null, 20, ['startCondition:sc-intake', 'state:received', 'correlationKey']
    )

    expect(result.newWatermark.targetId).toBe('n8n')
    expect(result.newWatermark.targetDeploymentId).toBe('wf-1')
    expect(result.newWatermark.n8nWorkflowId).toBe('wf-1')
  })
})
