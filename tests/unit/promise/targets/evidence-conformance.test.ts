import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateContractScenarios } from '../../../../src/promise/scenario.js'
import { extractNormalizedEvidence } from '../../../../src/promise/evidence-extraction.js'
import { normalizeN8nExecution, evidenceNodeName } from '../../../../src/providers/n8n/evidence.js'
import { InMemoryContractTarget } from '../../../../src/promise/targets/in-memory/adapter.js'
import type { RawExecutionDetail } from '../../../../src/providers/n8n/execution-history.js'
import type { ProcessContract } from '../../../../src/promise/types.js'
import type { ContractScenario, ScenarioTimelineEvent } from '../../../../src/promise/scenario-types.js'
import type { TargetDeploymentRef } from '../../../../src/promise/targets/types.js'

/**
 * Execution Substrate Boundary v0, Phase 5 (docs/plans/execution-substrate-boundary-plan.md §7,
 * conformance suite #1). Evidence-normalization parity: the same fixture contract's real,
 * generator-produced scenarios (scenario.ts's own generateContractScenarios(), not a hand-picked
 * subset) are run through two independent raw-to-normalized paths --
 * (a) a hand-constructed n8n-shaped RawExecutionDetail, through normalizeN8nExecution(), and
 * (b) InMemoryContractTarget.seedExecution() + .normalize() -- and the resulting
 * extractNormalizedEvidence() output is compared for equivalence, under the SAME arbitrary
 * TargetDeploymentRef for both calls (the ref itself is not what this test is about; holding it
 * constant isolates normalization fidelity as the only variable).
 *
 * One field is deliberately NOT compared for byte-identity: `id`'s own trailing suffix. Both
 * paths compute it via buildEntryId(), which folds in `EvidenceFieldItem.sourceItemRef` when
 * present -- n8n's own normalizer always populates it (the exact run.branch.item position, per
 * Phase 4's own design); the in-memory adapter never does (per plan §6.4's own doc comment,
 * `sourceItemRef` is "OPTIONAL, opaque, target-provided" -- a target that doesn't populate it
 * falls back to its own array index, by design, not a bug). Every OTHER field -- promiseInstanceId,
 * status, detail, kind, transitionId, contractId, contractVersion, and (since the ref is held
 * constant) targetId/sourceWorkflowId -- is compared for exact equality.
 */

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

function offsetToMs(offset: ScenarioTimelineEvent['offset']): number {
  switch (offset.unit) {
    case 'minutes': return offset.amount * 60_000
    case 'hours': return offset.amount * 60 * 60_000
    case 'days': return offset.amount * 24 * 60 * 60_000
  }
}

function nestedFields(path: string, value: string): Record<string, unknown> {
  const parts = path.split('.')
  const root: Record<string, unknown> = {}
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {}
    cur[parts[i]!] = next
    cur = next
  }
  cur[parts[parts.length - 1]!] = value
  return root
}

/** The n8n-equivalent raw execution for ONE timeline event -- deliberately mirrors exactly what
 * InMemoryContractTarget.seedExecution() does internally for the in-memory side (same
 * executionRef/eventTime construction, same one-execution-per-event granularity, same
 * correlation-field merge for an evidence event), just expressed as real n8n runData shape
 * instead of a pre-built NormalizedExecution. */
function scenarioEventToRawN8n(contract: ProcessContract, scenario: ContractScenario, event: ScenarioTimelineEvent, now: Date): RawExecutionDetail {
  const eventTime = new Date(now.getTime() - offsetToMs(event.offset)).toISOString()
  const executionRef = `${scenario.id}:${event.id}`
  const correlationFields = nestedFields(contract.correlationKey.fieldPath, scenario.correlationKeyValue)
  const fields = event.kind === 'instance_start' ? correlationFields : { ...correlationFields, ...(event.fields ?? {}) }
  const nodeName = event.kind === 'instance_start' ? 'Webhook: Intake' : evidenceNodeName(event.transitionId!)
  return {
    id: executionRef,
    startedAt: eventTime,
    data: { version: 1, resultData: { runData: { [nodeName]: [{ data: { main: [[{ json: fields, pairedItem: { item: 0 } }]] } }] } } },
  }
}

/** Strips the one field this suite deliberately does not compare for byte-identity (see the
 * module doc comment above), plus `observedAt` (computed fresh via `new Date().toISOString()`
 * inside extractNormalizedEvidence() on each independent call -- a real, expected timing race
 * between two calls in a row, exactly as Phase 4's own closeout fix already established). */
function normalizeForComparison<T extends { entries: Array<{ id: string; observedAt: string }> }>(result: T): T {
  return { ...result, entries: result.entries.map(e => ({ ...e, id: '', observedAt: '' })) }
}

describe('Evidence-normalization parity -- normalizeN8nExecution() vs. InMemoryContractTarget.normalize()', () => {
  const contract = empireHomecare()
  const now = new Date('2026-07-20T12:00:00.000Z')
  const { scenarios } = generateContractScenarios(contract, undefined, now)
  const arbitraryRef: TargetDeploymentRef = { targetId: 'n8n', targetDeploymentId: 'wf-parity-check' }

  it('found real, generator-produced scenarios with at least one instance_start and one evidence event between them -- a sanity check on the sweep itself', () => {
    expect(scenarios.length).toBeGreaterThan(0)
    const allEvents = scenarios.flatMap(s => s.timeline)
    expect(allEvents.some(e => e.kind === 'instance_start')).toBe(true)
    expect(allEvents.some(e => e.kind === 'evidence')).toBe(true)
  })

  for (const scenario of scenarios) {
    for (const event of scenario.timeline) {
      it(`${scenario.name} / ${event.id} (${event.kind}): both normalization paths produce equivalent extractNormalizedEvidence() output`, async () => {
        const startCondition = event.kind === 'instance_start'
          ? contract.startConditions.find(sc => sc.initialState === event.initialState)
          : undefined
        if (event.kind === 'instance_start') expect(startCondition).toBeDefined()

        // -- n8n path --
        const rawN8n = scenarioEventToRawN8n(contract, scenario, event, now)
        const normalizedFromN8n = normalizeN8nExecution(contract, rawN8n)
        const resultFromN8n = extractNormalizedEvidence(contract, normalizedFromN8n, arbitraryRef, startCondition)

        // -- in-memory path --
        const adapter = new InMemoryContractTarget()
        adapter.seedExecution('dep-parity', { ...scenario, timeline: [event] }, contract, now)
        const ref = { targetId: adapter.targetId, targetDeploymentId: 'dep-parity' }
        const list = await adapter.listExecutions(ref, 20)
        const raw = await adapter.fetchExecution(ref, list[0]!.id)
        const normalizedFromInMemory = adapter.normalize(contract, raw)
        const resultFromInMemory = extractNormalizedEvidence(contract, normalizedFromInMemory, arbitraryRef, startCondition)

        expect(normalizeForComparison(resultFromN8n)).toEqual(normalizeForComparison(resultFromInMemory))

        // The id suffix legitimately differs (sourceItemRef vs. array-index fallback) but both
        // must still be real, well-formed, execution-ref-prefixed ids referencing the same
        // execution -- never empty, never masking a real mismatch elsewhere.
        for (let i = 0; i < resultFromN8n.entries.length; i++) {
          const n8nId = resultFromN8n.entries[i]!.id
          const inMemoryId = resultFromInMemory.entries[i]!.id
          expect(n8nId.startsWith(`${rawN8n.id}:`)).toBe(true)
          expect(inMemoryId.startsWith(`${rawN8n.id}:`)).toBe(true)
        }
      })
    }
  }
})
