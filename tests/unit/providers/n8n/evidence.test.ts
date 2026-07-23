import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeN8nExecution, evidenceNodeName } from '../../../../src/providers/n8n/evidence.js'
import type { RawExecutionDetail } from '../../../../src/providers/n8n/execution-history.js'
import type { ProcessContract } from '../../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4). Direct unit coverage for normalizeN8nExecution() -- the node-name marker-convention
 * interpretation and runData parsing that used to live inside ledger.ts's own
 * extractExecutionEvidence(), now isolated here as its own, independently-testable normalization
 * step. Complements ledger.test.ts's own end-to-end extractExecutionEvidence()/pollWorkflowEvidence()
 * coverage (which proves the FULL pipeline, facade included, is behavior-preserving) by proving
 * this one stage's own contract precisely: what NormalizedExecution shape a given raw execution
 * produces, byte-for-byte, independent of what extractNormalizedEvidence() later does with it.
 */

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

const TRANSITION_ID = 't-attempted-to-contacted'

function makeExecutionData(nodes: Array<[name: string, json: Record<string, unknown>]>): unknown {
  const runData: Record<string, unknown> = {}
  for (const [name, json] of nodes) {
    runData[name] = [{ data: { main: [[{ json, pairedItem: { item: 0 } }]] } }]
  }
  return { version: 1, resultData: { runData } }
}

describe('normalizeN8nExecution', () => {
  it('maps executionRef/eventTime from the raw execution\'s own id/startedAt', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = { id: 'exec-1', startedAt: '2026-07-20T09:00:00.000Z', data: makeExecutionData([]) }
    const normalized = normalizeN8nExecution(contract, execution)
    expect(normalized.executionRef).toBe('exec-1')
    expect(normalized.eventTime).toBe('2026-07-20T09:00:00.000Z')
  })

  it('passes eventTime through as null, unchanged, when n8n reports a null startedAt -- fallback logic belongs to the neutral extractor, not the normalizer', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = { id: 'exec-1', startedAt: null, data: makeExecutionData([]) }
    const normalized = normalizeN8nExecution(contract, execution)
    expect(normalized.eventTime).toBeNull()
  })

  it('resolves the trigger node (first key in runData) into initiatingItems, with a sourceItemRef preserving the exact run.branch.item position', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-1', startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([['Webhook: Intake', { body: { phone: '555-0100' } }]]),
    }
    const normalized = normalizeN8nExecution(contract, execution)
    expect(normalized.initiatingItems).toEqual([{ fields: { body: { phone: '555-0100' } }, sourceItemRef: '0.0.0' }])
  })

  it('resolves evidenceNodeName(transitionId) into a NormalizedTransitionEvidence entry, only for transitions with a real matching node', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-1', startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([
        ['Webhook: Intake', { body: { phone: '555-0100' } }],
        [evidenceNodeName(TRANSITION_ID), { callOutcome: 'no_answer', callTimestamp: 't1' }],
      ]),
    }
    const normalized = normalizeN8nExecution(contract, execution)
    expect(normalized.transitionEvidence).toEqual([
      { transitionId: TRANSITION_ID, items: [{ fields: { callOutcome: 'no_answer', callTimestamp: 't1' }, sourceItemRef: '0.0.0' }] },
    ])
  })

  it('never includes a transitionEvidence entry for a contract evidenceRequirement whose node produced zero items', () => {
    const contract = empireHomecare() // has an evidenceRequirement for TRANSITION_ID
    const execution: RawExecutionDetail = {
      id: 'exec-1', startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([['Webhook: Intake', { body: { phone: '555-0100' } }]]), // no evidence node at all
    }
    const normalized = normalizeN8nExecution(contract, execution)
    expect(normalized.transitionEvidence).toEqual([])
  })

  it('a node carrying multiple items in one run produces one EvidenceFieldItem per item, each with a distinct sourceItemRef', () => {
    const contract = empireHomecare()
    const runData = {
      'Sheets: New Rows': [{ data: { main: [[
        { json: { body: { phone: '555-0001' } }, pairedItem: { item: 0 } },
        { json: { body: { phone: '555-0002' } }, pairedItem: { item: 1 } },
      ]] } }],
    }
    const execution: RawExecutionDetail = { id: 'exec-batch', startedAt: '2026-07-20T09:00:00.000Z', data: { version: 1, resultData: { runData } } }
    const normalized = normalizeN8nExecution(contract, execution)
    expect(normalized.initiatingItems).toEqual([
      { fields: { body: { phone: '555-0001' } }, sourceItemRef: '0.0.0' },
      { fields: { body: { phone: '555-0002' } }, sourceItemRef: '0.0.1' },
    ])
  })

  it('handles missing/empty execution data as an empty NormalizedExecution, not a crash', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = { id: 'exec-empty', startedAt: '2026-07-20T09:00:00.000Z' }
    const normalized = normalizeN8nExecution(contract, execution)
    expect(normalized.initiatingItems).toEqual([])
    expect(normalized.transitionEvidence).toEqual([])
  })
})

describe('evidenceNodeName', () => {
  it('produces the exact "Kairos Evidence: <transitionId>" convention', () => {
    expect(evidenceNodeName('t1')).toBe('Kairos Evidence: t1')
  })
})
