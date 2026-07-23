import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractExecutionEvidence } from '../../../src/promise/ledger.js'
import { extractNormalizedEvidence } from '../../../src/promise/evidence-extraction.js'
import { normalizeN8nExecution, evidenceNodeName } from '../../../src/providers/n8n/evidence.js'
import type { RawExecutionDetail } from '../../../src/providers/n8n/execution-history.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { NormalizedExecution, TargetDeploymentRef } from '../../../src/promise/targets/types.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4, §12). Two distinct kinds of coverage, deliberately not conflated:
 *
 * 1. Fixture-level output-equivalence checks (below): every case runs the exact same raw n8n
 *    execution through two independent paths -- (a) extractExecutionEvidence() (ledger.ts's own
 *    backward-compatible facade, the one src/reliability/replay+chaos/contract-outcome.ts still
 *    call directly) and (b) normalizeN8nExecution() + extractNormalizedEvidence() composed by
 *    hand, exactly how pollWorkflowEvidence() itself now composes them internally -- and asserts
 *    the two are deep-equal FOR THESE FIXTURES, today. This proves current fixture-level output
 *    equivalence between the facade and the direct composition; it does NOT, by itself,
 *    independently prove historical pre-refactor parity (that is what ledger.test.ts's own 33
 *    pre-existing tests, unchanged in their own assertions, are for), and does NOT by itself
 *    prove the facade genuinely delegates rather than coincidentally agreeing (that is a claim
 *    about source structure, confirmed by directly reading ledger.ts's own
 *    extractExecutionEvidence() -- it calls normalizeN8nExecution() then extractNormalizedEvidence(),
 *    nothing else, no second parsing path exists to coincidentally agree with).
 *
 * 2. Direct, target-neutral extractNormalizedEvidence() coverage (further down): calls the
 *    neutral extractor directly with hand-built NormalizedExecution data, never touching
 *    normalizeN8nExecution() or any n8n concept at all -- including a synthetic non-n8n
 *    TargetDeploymentRef, to prove targetId/target-aware entry-id construction work independent
 *    of the n8n adapter entirely, and the sourceItemRef-absent array-index fallback specifically.
 */

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

const TRANSITION_ID = 't-attempted-to-contacted'
const START_CONDITION = { id: 'sc-intake', description: 'A new referral arrives via the intake form or Google Sheet row', trigger: 'webhook', initialState: 'received' }

function makeExecutionData(nodes: Array<[name: string, json: Record<string, unknown>]>): unknown {
  const runData: Record<string, unknown> = {}
  for (const [name, json] of nodes) {
    runData[name] = [{ data: { main: [[{ json, pairedItem: { item: 0 } }]] } }]
  }
  return { version: 1, resultData: { runData } }
}

function viaDirectNeutralPath(contract: ProcessContract, execution: RawExecutionDetail, n8nWorkflowId: string, startCondition?: typeof START_CONDITION) {
  const normalized = normalizeN8nExecution(contract, execution)
  return extractNormalizedEvidence(contract, normalized, { targetId: 'n8n', targetDeploymentId: n8nWorkflowId }, startCondition)
}

/** `observedAt` is computed fresh via `new Date().toISOString()` inside extractNormalizedEvidence()
 * on every independent call -- calling it twice in a row (once via the facade, once directly) can
 * legitimately differ by a millisecond, which is real, correct, non-deterministic behavior, not a
 * parity bug. Every OTHER field must still match exactly; this strips only that one
 * wall-clock-dependent field before comparing, and callers separately assert both sides produced
 * a real (non-empty) observedAt of their own. */
function withoutObservedAt<T extends { entries: Array<{ observedAt: string }> }>(result: T): T {
  return { ...result, entries: result.entries.map(e => ({ ...e, observedAt: '' })) }
}

describe('extractExecutionEvidence() (facade) vs. normalizeN8nExecution()+extractNormalizedEvidence() (direct neutral path) -- fixture-level output equivalence', () => {
  it('a complete evidence match: identical outcomes and entries via both paths', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-1',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([
        ['Webhook: Intake', { body: { phone: '555-0100' } }],
        [evidenceNodeName(TRANSITION_ID), { callOutcome: 'no_answer', callTimestamp: '2026-07-20T09:05:00.000Z' }],
      ]),
    }
    const viaFacade = extractExecutionEvidence(contract, execution, 'wf-processing')
    const viaDirect = viaDirectNeutralPath(contract, execution, 'wf-processing')
    expect(withoutObservedAt(viaFacade)).toEqual(withoutObservedAt(viaDirect))
    expect(viaFacade.entries).toHaveLength(1)
    expect(viaFacade.entries[0]!.observedAt).toBeTruthy()
    expect(viaDirect.entries[0]!.observedAt).toBeTruthy()
  })

  it('an instance_start execution: identical outcomes and entries via both paths', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-intake-1',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([['Webhook: Intake', { body: { phone: '555-0100' } }]]),
    }
    const viaFacade = extractExecutionEvidence(contract, execution, 'wf-intake', START_CONDITION)
    const viaDirect = viaDirectNeutralPath(contract, execution, 'wf-intake', START_CONDITION)
    expect(withoutObservedAt(viaFacade)).toEqual(withoutObservedAt(viaDirect))
    expect(viaFacade.entries[0]!.kind).toBe('instance_start')
  })

  it('a skipped execution (no evidence match, no startCondition): identical via both paths', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-skip',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([['Webhook: Intake', { body: { phone: '555-0100' } }], ['Some Other Node', { foo: 'bar' }]]),
    }
    const viaFacade = extractExecutionEvidence(contract, execution, 'wf-processing')
    const viaDirect = viaDirectNeutralPath(contract, execution, 'wf-processing')
    expect(viaFacade).toEqual(viaDirect)
    expect(viaFacade.outcomes[0]!.outcome).toBe('skipped')
  })

  it('an unreadable-correlation-key execution: identical unattributed outcomes via both paths', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-nokey',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([['Webhook: Intake', { headers: {} }], [evidenceNodeName(TRANSITION_ID), { callOutcome: 'no_answer', callTimestamp: 't1' }]]),
    }
    const viaFacade = extractExecutionEvidence(contract, execution, 'wf-processing')
    const viaDirect = viaDirectNeutralPath(contract, execution, 'wf-processing')
    expect(viaFacade).toEqual(viaDirect)
    expect(viaFacade.entries).toEqual([])
  })

  it('every ProofLedgerEntry produced by the facade carries targetId "n8n" -- new entries always populate provenance', () => {
    const contract = empireHomecare()
    const execution: RawExecutionDetail = {
      id: 'exec-1',
      startedAt: '2026-07-20T09:00:00.000Z',
      data: makeExecutionData([
        ['Webhook: Intake', { body: { phone: '555-0100' } }],
        [evidenceNodeName(TRANSITION_ID), { callOutcome: 'no_answer', callTimestamp: '2026-07-20T09:05:00.000Z' }],
      ]),
    }
    const { entries } = extractExecutionEvidence(contract, execution, 'wf-processing')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.targetId).toBe('n8n')
  })
})

describe('extractNormalizedEvidence() -- direct, target-neutral coverage (no n8n normalizer involved at all)', () => {
  it('falls back to the array index when sourceItemRef is absent, for multiple initiating items -- distinct, non-colliding entry ids, using a non-n8n TargetDeploymentRef throughout', () => {
    const contract = empireHomecare()
    const nonN8nRef: TargetDeploymentRef = { targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }
    const execution: NormalizedExecution = {
      executionRef: 'exec-synthetic-1',
      eventTime: '2026-07-20T09:00:00.000Z',
      initiatingItems: [
        { fields: { body: { phone: '555-0001' } } }, // no sourceItemRef
        { fields: { body: { phone: '555-0002' } } }, // no sourceItemRef
        { fields: { body: { phone: '555-0003' } } }, // no sourceItemRef
      ],
      transitionEvidence: [],
    }

    const { entries } = extractNormalizedEvidence(contract, execution, nonN8nRef, START_CONDITION)

    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.id)).toEqual([
      'in-memory-test:exec-synthetic-1:instance_start:0',
      'in-memory-test:exec-synthetic-1:instance_start:1',
      'in-memory-test:exec-synthetic-1:instance_start:2',
    ])
    expect(new Set(entries.map(e => e.id)).size).toBe(3) // no collision
    expect(entries.every(e => e.targetId === 'in-memory-test')).toBe(true)
    expect(entries.every(e => e.sourceWorkflowId === 'dep-1')).toBe(true)
  })

  it('falls back to the array index when sourceItemRef is absent, for multiple transition-evidence items on the same transition -- distinct, non-colliding entry ids', () => {
    const contract = empireHomecare()
    const nonN8nRef: TargetDeploymentRef = { targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }
    const execution: NormalizedExecution = {
      executionRef: 'exec-synthetic-2',
      eventTime: '2026-07-20T09:00:00.000Z',
      initiatingItems: [],
      transitionEvidence: [
        {
          transitionId: TRANSITION_ID,
          items: [
            { fields: { body: { phone: '555-0001' }, callOutcome: 'no_answer', callTimestamp: 't1' } }, // no sourceItemRef
            { fields: { body: { phone: '555-0002' }, callOutcome: 'contacted', callTimestamp: 't2' } }, // no sourceItemRef
          ],
        },
      ],
    }

    const { entries } = extractNormalizedEvidence(contract, execution, nonN8nRef)

    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.id)).toEqual([
      `in-memory-test:exec-synthetic-2:${TRANSITION_ID}:0`,
      `in-memory-test:exec-synthetic-2:${TRANSITION_ID}:1`,
    ])
    expect(new Set(entries.map(e => e.id)).size).toBe(2) // no collision
    expect(entries.every(e => e.targetId === 'in-memory-test')).toBe(true)
    expect(entries.map(e => e.detail)).toEqual([
      expect.stringContaining('callOutcome=no_answer'),
      expect.stringContaining('callOutcome=contacted'),
    ])
  })

  it('a mix of sourceItemRef-present and sourceItemRef-absent items in the same list: present ones use their own ref, absent ones fall back to their own array index -- never colliding', () => {
    const contract = empireHomecare()
    const nonN8nRef: TargetDeploymentRef = { targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }
    const execution: NormalizedExecution = {
      executionRef: 'exec-synthetic-3',
      eventTime: '2026-07-20T09:00:00.000Z',
      initiatingItems: [
        { fields: { body: { phone: '555-0001' } }, sourceItemRef: 'custom-ref-a' },
        { fields: { body: { phone: '555-0002' } } }, // no sourceItemRef -- falls back to index 1
      ],
      transitionEvidence: [],
    }

    const { entries } = extractNormalizedEvidence(contract, execution, nonN8nRef, START_CONDITION)

    expect(entries.map(e => e.id)).toEqual([
      'in-memory-test:exec-synthetic-3:instance_start:custom-ref-a',
      'in-memory-test:exec-synthetic-3:instance_start:1',
    ])
    expect(new Set(entries.map(e => e.id)).size).toBe(2)
  })
})
