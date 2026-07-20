import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { extractExecutionEvidence, pollWorkflowEvidence, hashCorrelationKeyValue, type RawExecutionDetail } from '../../../src/promise/ledger.js'
import { evidenceNodeName } from '../../../src/promise/compile.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { PollableN8nClient } from '../../../src/promise/ledger-types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

const TRANSITION_ID = 't-attempted-to-contacted' // has an EvidenceRequirement: callOutcome, callTimestamp

/** Builds a synthetic n8n execution `data` object shaped exactly like the real one confirmed in
 * the Phase 3 design-verification spike: data.resultData.runData[nodeName][0].data.main[0][0].json.
 * `nodes` is ordered (object key order = execution order, matching the real trigger-node-first
 * behavior confirmed against a live execution). */
function makeExecutionData(nodes: Array<[name: string, json: Record<string, unknown>]>): unknown {
  const runData: Record<string, unknown> = {}
  for (const [name, json] of nodes) {
    runData[name] = [{ data: { main: [[{ json, pairedItem: { item: 0 } }]] } }]
  }
  return { version: 1, resultData: { runData } }
}

function triggerNode(phone = '555-0100'): [string, Record<string, unknown>] {
  return ['Webhook: Intake', { body: { phone, name: 'Jane Referral' } }]
}

function evidenceNode(fields: Record<string, unknown>): [string, Record<string, unknown>] {
  return [evidenceNodeName(TRANSITION_ID), fields]
}

describe('extractExecutionEvidence', () => {
  it('extracts a complete evidence match as observed, with a hashed promise instance id', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-1',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([triggerNode('555-0100'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: '2026-07-20T09:05:00.000Z' })]),
    }

    const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing')

    expect(outcomes).toEqual([{
      executionId: 'exec-1',
      startedAt: '2026-07-20T09:00:00.000Z',
      outcome: 'extracted',
      transitionId: TRANSITION_ID,
      detail: 'The call log entry recording the attempt\'s result. -- callOutcome=no_answer, callTimestamp=2026-07-20T09:05:00.000Z',
    }])
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.status).toBe('observed')
    expect(entry.transitionId).toBe(TRANSITION_ID)
    expect(entry.sourceExecutionId).toBe('exec-1')
    expect(entry.sourceWorkflowId).toBe('wf-processing')
    expect(entry.contractId).toBe(contract.id)
    expect(entry.contractVersion).toBe(contract.version)
    expect(entry.promiseInstanceId).toBe(hashCorrelationKeyValue('555-0100'))
    expect(entry.correlationKeyValueHash).toBe(hashCorrelationKeyValue('555-0100'))
    // The raw phone number never appears anywhere in the entry.
    expect(JSON.stringify(entry)).not.toContain('555-0100')
  })

  it('marks a partial match unverifiable and lists exactly which fields are missing, without dropping the entry', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-2',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([triggerNode(), evidenceNode({ callOutcome: 'no_answer' })]), // callTimestamp missing
    }

    const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing')

    expect(outcomes[0]!.outcome).toBe('unverifiable')
    expect(outcomes[0]!.detail).toContain('missing: callTimestamp')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.status).toBe('unverifiable')
  })

  it('treats an empty-string field the same as a missing one', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-3',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([triggerNode(), evidenceNode({ callOutcome: '', callTimestamp: '2026-07-20T09:05:00.000Z' })]),
    }
    const { outcomes } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(outcomes[0]!.outcome).toBe('unverifiable')
    expect(outcomes[0]!.detail).toContain('missing: callOutcome')
  })

  it('skips (no entry) an execution with no matching evidence-marker node at all', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-4',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([triggerNode(), ['Some Other Node', { foo: 'bar' }]]),
    }
    const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(outcomes).toEqual([{
      executionId: 'exec-4',
      startedAt: '2026-07-20T09:00:00.000Z',
      outcome: 'skipped',
      detail: 'No evidence-marker node found in this execution -- not relevant to any EvidenceRequirement in this contract.',
    }])
    expect(entries).toEqual([])
  })

  it('handles a missing/empty data field (no execution data at all) as skipped, not a crash', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = { id: 'exec-5', startedAt: '2026-07-20T09:00:00.000Z' }
    const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(outcomes[0]!.outcome).toBe('skipped')
    expect(entries).toEqual([])
  })

  it('reports unverifiable and writes no entry when the correlation key cannot be read, even if evidence fields are complete', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-6',
      startedAt: '2026-07-20T09:00:00.000Z',
      // Trigger node exists but has no body.phone at all.
      data: makeExecutionData([['Webhook: Intake', { headers: {} }], evidenceNode({ callOutcome: 'no_answer', callTimestamp: '2026-07-20T09:05:00.000Z' })]),
    }
    const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(outcomes[0]!.outcome).toBe('unverifiable')
    expect(outcomes[0]!.detail).toContain('correlation key')
    expect(entries).toEqual([])
  })

  it('reads the correlation key from the first node in runData (the trigger), not any other node', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-7',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([
        triggerNode('555-0199'), // first node -- this is what should be read
        ['Some Middle Node', { body: { phone: '555-9999' } }], // must NOT be read
        evidenceNode({ callOutcome: 'no_answer', callTimestamp: '2026-07-20T09:05:00.000Z' }),
      ]),
    }
    const { entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(entries[0]!.promiseInstanceId).toBe(hashCorrelationKeyValue('555-0199'))
  })
})

describe('hashCorrelationKeyValue', () => {
  it('is a real sha256 hash of the exact input, not a placeholder', () => {
    expect(hashCorrelationKeyValue('555-0100')).toBe(createHash('sha256').update('555-0100').digest('hex'))
  })
})

function mockClient(executions: Array<{ id: string; startedAt: string; data?: unknown }>): PollableN8nClient {
  // Real n8n /executions list order confirmed in the Phase 3 spike: most-recent-first.
  const sorted = [...executions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return {
    getExecutions: async (_workflowId, filter) => sorted.slice(0, filter?.limit ?? 20).map(e => ({ id: e.id, startedAt: e.startedAt })),
    getExecution: async (id) => {
      const found = executions.find(e => e.id === id)!
      return { id: found.id, startedAt: found.startedAt, data: found.data }
    },
  }
}

describe('pollWorkflowEvidence', () => {
  it('with no prior watermark, processes every fetched execution oldest-to-newest and never reports a gap', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z', data: makeExecutionData([triggerNode('555-0002'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't2' })]) },
    ])

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, null)

    expect(result.executionsChecked).toBe(2)
    expect(result.entries.map(e => e.sourceExecutionId)).toEqual(['e1', 'e2']) // oldest to newest
    expect(result.possibleGap).toBe(false)
    expect(result.newWatermark).toEqual({
      contractId: contract.id,
      n8nWorkflowId: 'wf-1',
      lastProcessedExecutionId: 'e2',
      lastProcessedStartedAt: '2026-07-20T10:00:00.000Z',
      updatedAt: result.newWatermark.updatedAt,
    })
  })

  it('only processes executions strictly newer than the watermark', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z', data: makeExecutionData([triggerNode('555-0002'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't2' })]) },
    ])
    const watermark = { contractId: contract.id, n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, watermark)

    expect(result.executionsChecked).toBe(1)
    expect(result.entries.map(e => e.sourceExecutionId)).toEqual(['e2'])
    expect(result.possibleGap).toBe(false)
  })

  it('treats a same-timestamp, different-id execution as new (tie-break by id)', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
      { id: 'e2', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0002'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't2' })]) },
    ])
    const watermark = { contractId: contract.id, n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, watermark)
    expect(result.entries.map(e => e.sourceExecutionId)).toEqual(['e2'])
  })

  it('does not reprocess the exact same execution id at the exact same timestamp', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
    ])
    const watermark = { contractId: contract.id, n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, watermark)
    expect(result.executionsChecked).toBe(0)
    expect(result.entries).toEqual([])
  })

  it('flags possibleGap when every fetched execution was new relative to an existing watermark (the fetch page may not have reached it)', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z', data: makeExecutionData([triggerNode('555-0002'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't2' })]) },
      { id: 'e3', startedAt: '2026-07-20T11:00:00.000Z', data: makeExecutionData([triggerNode('555-0003'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't3' })]) },
    ])
    // Watermark references an execution ('e1') that isn't even in this fetched page -- the page
    // may have been too small to reach it.
    const watermark = { contractId: contract.id, n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T08:00:00.000Z', updatedAt: 'x' }

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, watermark, 2)
    expect(result.possibleGap).toBe(true)
  })

  it('never flags possibleGap on a contract\'s first-ever poll (nothing to have missed yet)', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
    ])
    const result = await pollWorkflowEvidence(contract, 'wf-1', client, null)
    expect(result.possibleGap).toBe(false)
  })

  it('leaves the watermark unchanged when there are no executions at all', async () => {
    const contract = empireHomecare()
    const client = mockClient([])
    const watermark = { contractId: contract.id, n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, watermark)
    expect(result.executionsChecked).toBe(0)
    expect(result.newWatermark).toEqual(watermark)
  })

  it('mixes extracted, unverifiable, and skipped outcomes correctly across several executions', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) }, // extracted
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z', data: makeExecutionData([triggerNode('555-0002'), evidenceNode({ callOutcome: 'no_answer' })]) }, // unverifiable
      { id: 'e3', startedAt: '2026-07-20T11:00:00.000Z', data: makeExecutionData([triggerNode('555-0003'), ['Some Other Node', {}]]) }, // skipped
    ])

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, null)
    expect(result.outcomes.map(o => o.outcome)).toEqual(['extracted', 'unverifiable', 'skipped'])
    expect(result.entries).toHaveLength(2) // skipped never produces an entry
  })
})
