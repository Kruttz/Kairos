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
const START_CONDITION = { id: 'sc-intake', description: 'A new referral arrives via the intake form or Google Sheet row', trigger: 'webhook', initialState: 'received' }

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

/** Same real n8n shape as makeExecutionData(), but a node can carry MULTIPLE items in its one
 * run's main[0] branch (P0 measurement-integrity fix, 2026-07-20, fix #2) -- the real shape a
 * batch-style trigger (e.g. "read every new Sheet row in one execution") produces. */
function makeMultiItemExecutionData(nodes: Array<[name: string, jsons: Record<string, unknown>[]]>): unknown {
  const runData: Record<string, unknown> = {}
  for (const [name, jsons] of nodes) {
    runData[name] = [{ data: { main: [jsons.map((json, i) => ({ json, pairedItem: { item: i } }))] } }]
  }
  return { version: 1, resultData: { runData } }
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
      attributedToInstance: true,
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

  // P0 measurement-integrity fix (2026-07-20): eventTime must come from the real n8n execution's
  // own startedAt, not from whenever extraction happens to run (observedAt) -- the whole point of
  // this fix is that these two can legitimately differ (a poll that runs well after the fact).
  it('populates eventTime from the real execution.startedAt, distinct from observedAt', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-1',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([triggerNode('555-0100'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: '2026-07-20T09:05:00.000Z' })]),
    }
    const { entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(entries[0]!.eventTime).toBe('2026-07-20T09:00:00.000Z')
    // observedAt is Kairos's own extraction-time clock -- a real timestamp, just not the fixed
    // execution.startedAt above, proving the two fields are independently populated.
    expect(entries[0]!.observedAt).not.toBe('')
  })

  it('falls back eventTime to observedAt when n8n reports a null startedAt', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-1',
      startedAt: null,
      data: makeExecutionData([triggerNode('555-0100'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: '2026-07-20T09:05:00.000Z' })]),
    }
    const { entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(entries[0]!.eventTime).toBe(entries[0]!.observedAt)
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
      attributedToInstance: false,
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

  describe('instance_start (Phase 4 addition -- gives SLA compliance a clock-start signal)', () => {
    it('records an instance_start entry for a start-condition execution, with no marker node needed', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-intake-1',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeExecutionData([triggerNode('555-0100')]), // no evidence node at all -- this is the intake execution
      }

      const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-intake', START_CONDITION)

      expect(outcomes).toEqual([{
        executionId: 'exec-intake-1',
        startedAt: '2026-07-20T09:00:00.000Z',
        outcome: 'extracted',
        detail: 'New Referral instance began in state "received" (A new referral arrives via the intake form or Google Sheet row).',
        attributedToInstance: true,
      }])
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry.kind).toBe('instance_start')
      expect(entry.initialState).toBe('received')
      expect(entry.transitionId).toBeUndefined()
      expect(entry.status).toBe('observed')
      expect(entry.promiseInstanceId).toBe(hashCorrelationKeyValue('555-0100'))
      expect(entry.sourceWorkflowId).toBe('wf-intake')
    })

    it('reports unverifiable, writes no entry, when a start-condition execution has no readable correlation key', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-intake-2',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeExecutionData([['Webhook: Intake', { headers: {} }]]),
      }
      const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-intake', START_CONDITION)
      expect(outcomes).toEqual([{
        executionId: 'exec-intake-2',
        startedAt: '2026-07-20T09:00:00.000Z',
        outcome: 'unverifiable',
        detail: 'Start-condition execution (item 0.0.0), but the correlation key (body.phone) could not be read -- no ledger entry written without a known promise instance.',
        attributedToInstance: false,
      }])
      expect(entries).toEqual([])
    })

    it('records both an instance_start AND an evidence entry when a single execution has both (uncommon, but not prevented)', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-intake-3',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeExecutionData([triggerNode('555-0100'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]),
      }
      const { entries } = extractExecutionEvidence(contract, execution, 'wf-intake', START_CONDITION)
      expect(entries.map(e => e.kind)).toEqual(['instance_start', 'evidence'])
      expect(entries.every(e => e.promiseInstanceId === hashCorrelationKeyValue('555-0100'))).toBe(true)
    })

    it('without a startCondition, an execution with no evidence match is still just skipped (unchanged Phase 3 behavior)', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-no-sc',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeExecutionData([triggerNode('555-0100')]),
      }
      const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing') // no startCondition arg
      expect(outcomes[0]!.outcome).toBe('skipped')
      expect(entries).toEqual([])
    })
  })

  // P0 measurement-integrity fix (2026-07-20, fix #2 -- first-item-only extraction). Real n8n
  // shape confirmed in the Phase 3 spike (data.resultData.runData[node][run].data.main[branch]
  // [item].json) always had room for more than one item/run -- only the read path assumed
  // exactly one. A batch-style trigger (e.g. a Sheets-row-batch intake, common in Kairos-
  // generated packs) or a looped evidence node both hit this.
  describe('multi-item / multi-run cardinality', () => {
    it('a batch trigger with multiple items creates one instance_start entry per resolvable item, not just the first', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-batch-1',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeMultiItemExecutionData([
          ['Sheets: New Rows', [
            { body: { phone: '555-0001' } },
            { body: { phone: '555-0002' } },
            { body: { phone: '555-0003' } },
          ]],
        ]),
      }
      const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-intake', START_CONDITION)
      expect(entries).toHaveLength(3)
      expect(entries.every(e => e.kind === 'instance_start')).toBe(true)
      expect(new Set(entries.map(e => e.promiseInstanceId)).size).toBe(3) // three genuinely distinct instances
      expect(entries.map(e => e.promiseInstanceId).sort()).toEqual(
        ['555-0001', '555-0002', '555-0003'].map(hashCorrelationKeyValue).sort()
      )
      expect(outcomes.filter(o => o.outcome === 'extracted')).toHaveLength(3)
      // Every entry gets its own unique id -- no collision between items in the same execution.
      expect(new Set(entries.map(e => e.id)).size).toBe(3)
    })

    it('a batch trigger where some items have no readable correlation key: resolvable ones still extract, others are reported unattributed', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-batch-2',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeMultiItemExecutionData([
          ['Sheets: New Rows', [
            { body: { phone: '555-0001' } },
            { body: { headers: {} } }, // no phone at all
            { body: { phone: '555-0003' } },
          ]],
        ]),
      }
      const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-intake', START_CONDITION)
      expect(entries).toHaveLength(2) // items 0 and 2 only
      expect(entries.map(e => e.promiseInstanceId).sort()).toEqual(
        ['555-0001', '555-0003'].map(hashCorrelationKeyValue).sort()
      )
      const unattributed = outcomes.filter(o => o.outcome === 'unverifiable' && !o.attributedToInstance)
      expect(unattributed).toHaveLength(1) // item 1's missing-key outcome, surfaced not silently dropped
      expect(unattributed[0]!.detail).toContain('item 0.0.1')
    })

    it('a batch evidence node with multiple items, each carrying its own correlation key, produces one entry per item, correctly attributed', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-batch-3',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeMultiItemExecutionData([
          // A Set/Edit Fields node processing a loop of items -- each item still carries its own
          // original body.phone alongside the newly-set evidence fields, the normal n8n
          // pass-through-unset-fields behavior.
          [evidenceNodeName(TRANSITION_ID), [
            { body: { phone: '555-0001' }, callOutcome: 'no_answer', callTimestamp: 't1' },
            { body: { phone: '555-0002' }, callOutcome: 'contacted', callTimestamp: 't2' },
          ]],
        ]),
      }
      const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
      expect(entries).toHaveLength(2)
      const byInstance = new Map(entries.map(e => [e.promiseInstanceId, e]))
      expect(byInstance.get(hashCorrelationKeyValue('555-0001'))?.detail).toContain('callOutcome=no_answer')
      expect(byInstance.get(hashCorrelationKeyValue('555-0002'))?.detail).toContain('callOutcome=contacted')
      expect(outcomes.filter(o => o.outcome === 'extracted')).toHaveLength(2)
    })

    it('falls back to the single trigger item\'s correlation key when the evidence item itself has none AND there is exactly one trigger item (single-item backward-compatible path)', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-fallback-1',
        startedAt: '2026-07-20T09:00:00.000Z',
        // Evidence node's own item has no body.phone at all -- must fall back to the one trigger item.
        data: makeExecutionData([triggerNode('555-0100'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]),
      }
      const { entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.promiseInstanceId).toBe(hashCorrelationKeyValue('555-0100'))
    })

    it('does NOT fall back to a trigger item when there is more than one trigger item -- reports unattributed rather than guessing', () => {
      const contract = empireHomecare()
      const execution: RawExecutionDetail = {
        id: 'exec-no-fallback-1',
        startedAt: '2026-07-20T09:00:00.000Z',
        data: makeMultiItemExecutionData([
          ['Sheets: New Rows', [{ body: { phone: '555-0001' } }, { body: { phone: '555-0002' } }]],
          [evidenceNodeName(TRANSITION_ID), [{ callOutcome: 'no_answer', callTimestamp: 't1' }]], // no body.phone of its own
        ]),
      }
      const { outcomes, entries } = extractExecutionEvidence(contract, execution, 'wf-processing') // no startCondition -- isolates the evidence-attribution path
      expect(entries).toHaveLength(0) // never guesses which of the two trigger items this belongs to
      const unattributed = outcomes.find(o => o.transitionId === TRANSITION_ID)
      expect(unattributed?.outcome).toBe('unverifiable')
      expect(unattributed?.attributedToInstance).toBe(false)
    })

    it('a node that ran more than once (multiple runs, e.g. inside a loop) is fully captured, not just run 0', () => {
      const contract = empireHomecare()
      const runData: Record<string, unknown> = {
        'Webhook: Intake': [{ data: { main: [[{ json: { body: { phone: '555-0100' } }, pairedItem: { item: 0 } }]] } }],
        [evidenceNodeName(TRANSITION_ID)]: [
          { data: { main: [[{ json: { body: { phone: '555-0100' }, callOutcome: 'no_answer', callTimestamp: 't1' }, pairedItem: { item: 0 } }]] } },
          { data: { main: [[{ json: { body: { phone: '555-0100' }, callOutcome: 'contacted', callTimestamp: 't2' }, pairedItem: { item: 0 } }]] } },
        ],
      }
      const execution: RawExecutionDetail = { id: 'exec-multirun-1', startedAt: '2026-07-20T09:00:00.000Z', data: { version: 1, resultData: { runData } } }
      const { entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
      // Both runs captured -- run 0's "no_answer" and run 1's "contacted" both become real entries.
      expect(entries).toHaveLength(2)
      expect(entries.map(e => e.detail).some(d => d.includes('no_answer'))).toBe(true)
      expect(entries.map(e => e.detail).some(d => d.includes('contacted'))).toBe(true)
    })
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
      targetId: 'n8n', targetDeploymentId: 'wf-1', n8nWorkflowId: 'wf-1',
      lastProcessedExecutionId: 'e2',
      lastProcessedStartedAt: '2026-07-20T10:00:00.000Z',
      updatedAt: result.newWatermark.updatedAt,
      cumulativeUnattributedCount: 0,
    })
  })

  it('only processes executions strictly newer than the watermark', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z', data: makeExecutionData([triggerNode('555-0002'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't2' })]) },
    ])
    const watermark = { contractId: contract.id, targetId: 'n8n', targetDeploymentId: 'wf-1', n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

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
    const watermark = { contractId: contract.id, targetId: 'n8n', targetDeploymentId: 'wf-1', n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, watermark)
    expect(result.entries.map(e => e.sourceExecutionId)).toEqual(['e2'])
  })

  it('does not reprocess the exact same execution id at the exact same timestamp', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
    ])
    const watermark = { contractId: contract.id, targetId: 'n8n', targetDeploymentId: 'wf-1', n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

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
    const watermark = { contractId: contract.id, targetId: 'n8n', targetDeploymentId: 'wf-1', n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T08:00:00.000Z', updatedAt: 'x' }

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
    const watermark = { contractId: contract.id, targetId: 'n8n', targetDeploymentId: 'wf-1', n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e1', lastProcessedStartedAt: '2026-07-20T09:00:00.000Z', updatedAt: 'x' }

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

  // P0 measurement-integrity fix (2026-07-20, fix #11 -- the invisible-failure blind spot): an
  // execution with evidence expected but no readable correlation key produces zero ledger
  // entries -- these must not silently vanish with no trace at all.
  it('counts an unreadable-correlation-key outcome as unattributed, distinct from a real unverifiable entry', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      // Evidence marker found, but the trigger node has no body.phone at all -- no correlation
      // key, no ledger entry, would otherwise silently vanish from every downstream count.
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([['Webhook: Intake', { headers: {} }], evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
      // A real, attributed unverifiable entry (missing field, but a real instance id) -- must
      // NOT count toward unattributedCount.
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z', data: makeExecutionData([triggerNode('555-0002'), evidenceNode({ callOutcome: 'no_answer' })]) },
    ])

    const result = await pollWorkflowEvidence(contract, 'wf-1', client, null)
    expect(result.unattributedCount).toBe(1)
    expect(result.entries).toHaveLength(1) // only e2's real (attributed) unverifiable entry
    expect(result.newWatermark.cumulativeUnattributedCount).toBe(1)
  })

  it('accumulates cumulativeUnattributedCount across successive polls rather than resetting each time', async () => {
    const contract = empireHomecare()
    const firstClient = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([['Webhook: Intake', { headers: {} }], evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
    ])
    const firstResult = await pollWorkflowEvidence(contract, 'wf-1', firstClient, null)
    expect(firstResult.newWatermark.cumulativeUnattributedCount).toBe(1)

    const secondClient = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([['Webhook: Intake', { headers: {} }], evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
      { id: 'e2', startedAt: '2026-07-20T10:00:00.000Z', data: makeExecutionData([['Webhook: Intake', { headers: {} }], evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't2' })]) },
    ])
    const secondResult = await pollWorkflowEvidence(contract, 'wf-1', secondClient, firstResult.newWatermark)
    expect(secondResult.unattributedCount).toBe(1) // only e2 is new this poll
    expect(secondResult.newWatermark.cumulativeUnattributedCount).toBe(2) // 1 (carried forward) + 1 (this poll)
  })

  it('unattributedCount is 0 when nothing is unattributed, and a legacy watermark with no field defaults to 0', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001'), evidenceNode({ callOutcome: 'no_answer', callTimestamp: 't1' })]) },
    ])
    // A watermark shaped exactly like one written before this fix -- no cumulativeUnattributedCount field at all.
    const legacyWatermark = { contractId: contract.id, targetId: 'n8n', targetDeploymentId: 'wf-1', n8nWorkflowId: 'wf-1', lastProcessedExecutionId: 'e0', lastProcessedStartedAt: '2026-07-20T08:00:00.000Z', updatedAt: 'x' }
    const result = await pollWorkflowEvidence(contract, 'wf-1', client, legacyWatermark)
    expect(result.unattributedCount).toBe(0)
    expect(result.newWatermark.cumulativeUnattributedCount).toBe(0)
  })

  it('records instance_start entries when sourceElements names a StartCondition', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001')]) },
    ])

    const result = await pollWorkflowEvidence(contract, 'wf-intake', client, null, 20, ['startCondition:sc-intake', 'state:received', 'correlationKey'])
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.kind).toBe('instance_start')
  })

  it('never records instance_start entries when sourceElements is omitted or has no StartCondition', async () => {
    const contract = empireHomecare()
    const client = mockClient([
      { id: 'e1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([triggerNode('555-0001')]) },
    ])

    const result = await pollWorkflowEvidence(contract, 'wf-processing', client, null, 20, ['transition:t-received-to-attempted'])
    expect(result.entries).toEqual([])
    expect(result.outcomes[0]!.outcome).toBe('skipped')
  })
})
