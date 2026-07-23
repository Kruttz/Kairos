import { describe, it, expect, vi } from 'vitest'
import { assertConsistentTargetIds } from '../../../../src/promise/targets/execution-history.js'
import { N8nExecutionHistorySource } from '../../../../src/providers/n8n/execution-history.js'
import { N8nEvidenceNormalizer } from '../../../../src/providers/n8n/evidence.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'
import { GuardError } from '../../../../src/errors/guard-error.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4, correction 9). Target-consistency and defensive execution-history ordering --
 * pollWorkflowEvidence()'s own watermark/possibleGap logic depends on
 * ExecutionHistorySource.listExecutions() genuinely returning newest-first and respecting
 * `limit`, not just usually doing so.
 */

describe('assertConsistentTargetIds', () => {
  const n8nHistorySource = new N8nExecutionHistorySource({} as unknown as N8nApiClient)
  const n8nNormalizer = new N8nEvidenceNormalizer()

  it('does not throw when ref, historySource, and normalizer all agree', () => {
    expect(() => assertConsistentTargetIds({ targetId: 'n8n', targetDeploymentId: 'wf-1' }, n8nHistorySource, n8nNormalizer)).not.toThrow()
  })

  it('throws GuardError naming all three target ids when the ref disagrees with a consistent historySource/normalizer pair', () => {
    expect(() => assertConsistentTargetIds({ targetId: 'in-memory-test', targetDeploymentId: 'x' }, n8nHistorySource, n8nNormalizer))
      .toThrow(GuardError)
    try {
      assertConsistentTargetIds({ targetId: 'in-memory-test', targetDeploymentId: 'x' }, n8nHistorySource, n8nNormalizer)
    } catch (err) {
      expect((err as Error).message).toContain('ref="in-memory-test"')
      expect((err as Error).message).toContain('historySource="n8n"')
      expect((err as Error).message).toContain('normalizer="n8n"')
    }
  })

  it('throws when the historySource and normalizer disagree with EACH OTHER, even if the ref matches one of them', () => {
    const mismatchedNormalizer = { targetId: 'some-other-target', normalize: vi.fn() }
    expect(() => assertConsistentTargetIds({ targetId: 'n8n', targetDeploymentId: 'wf-1' }, n8nHistorySource, mismatchedNormalizer)).toThrow(GuardError)
  })
})

function makeMockClient(executions: Array<{ id: string; startedAt: string | null }>): N8nApiClient {
  return {
    getExecutions: vi.fn().mockResolvedValue(executions),
  } as unknown as N8nApiClient
}

describe('N8nExecutionHistorySource', () => {
  it('declares targetId "n8n"', () => {
    expect(new N8nExecutionHistorySource({} as unknown as N8nApiClient).targetId).toBe('n8n')
  })

  it('sorts defensively into newest-first order even when the underlying API returns items out of order', async () => {
    const client = makeMockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z' },
      { id: 'e3', startedAt: '2026-07-20T11:00:00.000Z' },
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z' },
    ])
    const source = new N8nExecutionHistorySource(client)
    const result = await source.listExecutions({ targetId: 'n8n', targetDeploymentId: 'wf-1' }, 20)
    expect(result.map(e => e.id)).toEqual(['e3', 'e2', 'e1'])
  })

  it('truncates defensively to the requested limit even when the underlying API returns more items than asked for', async () => {
    const client = makeMockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z' },
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z' },
      { id: 'e3', startedAt: '2026-07-20T11:00:00.000Z' },
      { id: 'e4', startedAt: '2026-07-20T12:00:00.000Z' },
    ])
    const source = new N8nExecutionHistorySource(client)
    const result = await source.listExecutions({ targetId: 'n8n', targetDeploymentId: 'wf-1' }, 2)
    expect(result).toHaveLength(2)
    expect(result.map(e => e.id)).toEqual(['e4', 'e3']) // newest two, not just the first two returned
  })

  it('calls the real client with the ref\'s own targetDeploymentId and the requested limit', async () => {
    const client = makeMockClient([])
    const source = new N8nExecutionHistorySource(client)
    await source.listExecutions({ targetId: 'n8n', targetDeploymentId: 'wf-42' }, 7)
    expect(client.getExecutions).toHaveBeenCalledWith('wf-42', { limit: 7 })
  })

  it('throws GuardError, never calling the API client, when listExecutions() receives a ref for a different target', async () => {
    const client = makeMockClient([])
    const source = new N8nExecutionHistorySource(client)
    await expect(source.listExecutions({ targetId: 'in-memory-test', targetDeploymentId: 'x' }, 20)).rejects.toThrow(GuardError)
    expect(client.getExecutions).not.toHaveBeenCalled()
  })

  it('throws GuardError, never calling the API client, when fetchExecution() receives a ref for a different target', async () => {
    const client = { getExecution: vi.fn() } as unknown as N8nApiClient
    const source = new N8nExecutionHistorySource(client)
    await expect(source.fetchExecution({ targetId: 'in-memory-test', targetDeploymentId: 'x' }, 'exec-1')).rejects.toThrow(GuardError)
    expect((client as unknown as { getExecution: ReturnType<typeof vi.fn> }).getExecution).not.toHaveBeenCalled()
  })

  it('fetchExecution() requests includeData: true', async () => {
    const getExecution = vi.fn().mockResolvedValue({ id: 'exec-1', startedAt: '2026-07-20T09:00:00.000Z', data: {} })
    const client = { getExecution } as unknown as N8nApiClient
    const source = new N8nExecutionHistorySource(client)
    await source.fetchExecution({ targetId: 'n8n', targetDeploymentId: 'wf-1' }, 'exec-1')
    expect(getExecution).toHaveBeenCalledWith('exec-1', { includeData: true })
  })
})
