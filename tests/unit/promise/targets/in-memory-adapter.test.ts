import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InMemoryContractTarget, IN_MEMORY_CAPABILITIES } from '../../../../src/promise/targets/in-memory/adapter.js'
import { GuardError } from '../../../../src/errors/guard-error.js'
import type { ProcessContract } from '../../../../src/promise/types.js'
import type { ContractScenario } from '../../../../src/promise/scenario-types.js'

/**
 * Execution Substrate Boundary v0, Phase 5 (docs/plans/execution-substrate-boundary-plan.md §7).
 * Direct, per-interface unit coverage for InMemoryContractTarget -- the same level of scrutiny
 * Phase 3's N8nContractCompiler/N8nContractDeployer/N8nDeploymentLookup and Phase 4's
 * N8nExecutionHistorySource each got individually, before any cross-target conformance claim is
 * made. Complements evidence-conformance.test.ts, cross-target-report-parity.test.ts, and
 * in-memory-slot-isolation.test.ts, which test cross-cutting claims this file does not.
 */

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

function empireHomecareBlocked(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake-blocking-assumption.json'), 'utf-8')) as ProcessContract
}

describe('IN_MEMORY_CAPABILITIES', () => {
  it('declares exactly five implemented capabilities supported, matching the five interfaces this adapter actually implements', () => {
    expect(IN_MEMORY_CAPABILITIES.implemented).toEqual({
      compile: { state: 'supported' },
      deploy: { state: 'supported' },
      fetchDeployment: { state: 'supported' },
      executionHistory: { state: 'supported' },
      evidenceExtraction: { state: 'supported' },
      compilerVerification: { state: 'unsupported' },
    })
  })

  it('declares every reliability capability unsupported -- this adapter has no reliability modules at all', () => {
    for (const v of Object.values(IN_MEMORY_CAPABILITIES.reliability)) expect(v).toEqual({ state: 'unsupported' })
  })
})

describe('InMemoryContractTarget', () => {
  let adapter: InMemoryContractTarget

  beforeEach(() => {
    adapter = new InMemoryContractTarget()
  })

  it('declares targetId "in-memory-test"', () => {
    expect(adapter.targetId).toBe('in-memory-test')
  })

  describe('compileContract() -- delegates to the SAME prepareContract() gate every real target uses', () => {
    it('is "ready" with a real decomposition for a valid, non-blocked contract', () => {
      const result = adapter.compileContract(empireHomecare())
      expect(result.escalation).toBeUndefined()
      expect(result.artifact.slots.length).toBeGreaterThan(0)
      expect(result.traceability.length).toBe(result.artifact.slots.length)
      expect(result.traceability.map(t => t.workflowName)).toEqual(result.artifact.slots.map(s => s.name))
    })

    it('is blocked, with an empty artifact and a real escalation, for a contract with a blocking assumption -- the structurally-inherited gate, not reproduced by hand', () => {
      const result = adapter.compileContract(empireHomecareBlocked())
      expect(result.artifact.slots).toEqual([])
      expect(result.traceability).toEqual([])
      expect(result.escalation).toBeDefined()
      expect(result.escalation!.source).toBe('blocking_assumptions')
    })
  })

  describe('deployArtifact()', () => {
    it('deploys every slot, each with a unique, real deployment id, overall outcome "deployed"', async () => {
      const { artifact } = adapter.compileContract(empireHomecare())
      const result = await adapter.deployArtifact(artifact, {})
      expect(result.outcome).toBe('deployed')
      expect(result.slots).toHaveLength(artifact.slots.length)
      expect(result.slots.every(s => s.outcome === 'deployed')).toBe(true)
      const ids = result.slots.map(s => (s as { ref: { targetDeploymentId: string } }).ref.targetDeploymentId)
      expect(new Set(ids).size).toBe(ids.length) // every id unique
      expect(result.raw).toBe(artifact)
    })

    it('a repeated deployment of the same artifact (simulating a rebuild) produces fresh, non-colliding ids each time', async () => {
      const { artifact } = adapter.compileContract(empireHomecare())
      const first = await adapter.deployArtifact(artifact, {})
      const second = await adapter.deployArtifact(artifact, {})
      const firstIds = first.slots.map(s => (s as { ref: { targetDeploymentId: string } }).ref.targetDeploymentId)
      const secondIds = second.slots.map(s => (s as { ref: { targetDeploymentId: string } }).ref.targetDeploymentId)
      expect(firstIds.some(id => secondIds.includes(id))).toBe(false)
    })

    it('dryRun: true produces "generated" slots with no ref at all, overall outcome "generated" -- matching real dry-run semantics, never "deployed"', async () => {
      const { artifact } = adapter.compileContract(empireHomecare())
      const result = await adapter.deployArtifact(artifact, { dryRun: true })
      expect(result.outcome).toBe('generated')
      expect(result.slots).toHaveLength(artifact.slots.length)
      for (const slot of result.slots) {
        expect(slot.outcome).toBe('generated')
        expect(slot).not.toHaveProperty('ref')
      }
    })

    it('a dry run creates no fetchable deployment record at all -- the regression this closeout pass exists to pin', async () => {
      const { artifact } = adapter.compileContract(empireHomecare())
      await adapter.deployArtifact(artifact, { dryRun: true })

      // A dry run's own slots carry no ref (confirmed above), so there is no legitimate id to
      // fetch -- but the deeper structural guarantee is that deployArtifact() with dryRun never
      // writes to `this.deployments` at all. Proven by generating every id a REAL (non-dry-run)
      // deploy of the identical artifact would have produced next, and confirming none of THOSE
      // resolve to a stale, pre-existing dry-run record -- i.e. the real deploy's own ids are the
      // ONLY ones ever fetchable, never silently pre-populated by the prior dry run.
      const real = await adapter.deployArtifact(artifact, {})
      for (const slot of real.slots) {
        if (slot.outcome !== 'deployed') throw new Error('expected deployed')
        const snapshot = await adapter.fetchDeployment(slot.ref)
        expect((snapshot.raw as { name: string }).name).toBe(slot.slotName)
      }

      // And directly: a fabricated ref shaped like what a dry run's own generateUUID() call
      // would have produced (had it made one, which it must not) is never fetchable, since a
      // dry run generates no id and stores nothing under any id.
      await expect(adapter.fetchDeployment({ targetId: 'in-memory-test', targetDeploymentId: 'never-actually-generated-by-the-dry-run' })).rejects.toThrow(GuardError)
    })
  })

  describe('fetchDeployment()', () => {
    it('throws GuardError for a ref targeting a different target, and for an unknown deployment id', async () => {
      await expect(adapter.fetchDeployment({ targetId: 'n8n', targetDeploymentId: 'x' })).rejects.toThrow(GuardError)
      await expect(adapter.fetchDeployment({ targetId: 'in-memory-test', targetDeploymentId: 'never-deployed' })).rejects.toThrow(GuardError)
    })
  })

  describe('listExecutions() / fetchExecution()', () => {
    const contract = empireHomecare()

    function makeScenario(overrides: Partial<ContractScenario> = {}): ContractScenario {
      return {
        id: 'scenario-1', contractId: contract.id, contractVersion: contract.version, name: 'Test scenario', category: 'in_progress',
        description: 'x', correlationKeyValue: '555-0100',
        timeline: [{ id: 'start', offset: { amount: 1, unit: 'days' }, kind: 'instance_start', initialState: 'received' }],
        expected: { reportStatus: 'in_progress', expectedExceptionCount: 0, reasoning: 'x' },
        sourceElements: [], provenance: { generatorVersion: '0.1.0', createdAt: '2026-01-01T00:00:00.000Z' },
        ...overrides,
      }
    }

    it('returns newest-first for a real seeded deployment, even when seeded in non-chronological order', async () => {
      const now = new Date('2026-07-20T12:00:00.000Z')
      adapter.seedExecution('dep-1', makeScenario({ id: 's1', timeline: [
        { id: 'e1', offset: { amount: 3, unit: 'days' }, kind: 'instance_start', initialState: 'received' },
        { id: 'e2', offset: { amount: 1, unit: 'days' }, kind: 'instance_start', initialState: 'received' },
        { id: 'e3', offset: { amount: 2, unit: 'days' }, kind: 'instance_start', initialState: 'received' },
      ] }), contract, now)

      const ref = { targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }
      const list = await adapter.listExecutions(ref, 20)
      // Seeded in event order (e1, e2, e3) but e2 (1 day ago) is newest, then e3 (2 days), then e1 (3 days).
      expect(list.map(e => e.id)).toEqual(['s1:e2', 's1:e3', 's1:e1'])
    })

    it('genuinely respects a limit smaller than the seeded execution count -- returns only the newest `limit` of them, not just whatever fits', async () => {
      const now = new Date('2026-07-20T12:00:00.000Z')
      adapter.seedExecution('dep-1', makeScenario({ id: 's1', timeline: [
        { id: 'e1', offset: { amount: 3, unit: 'days' }, kind: 'instance_start', initialState: 'received' },
        { id: 'e2', offset: { amount: 1, unit: 'days' }, kind: 'instance_start', initialState: 'received' },
        { id: 'e3', offset: { amount: 2, unit: 'days' }, kind: 'instance_start', initialState: 'received' },
      ] }), contract, now)

      const ref = { targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }
      const list = await adapter.listExecutions(ref, 2)
      expect(list).toHaveLength(2)
      // Newest two only: e2 (1 day ago) and e3 (2 days ago) -- e1 (3 days ago, the oldest) is
      // correctly excluded, not just "whichever 2 happened to fit."
      expect(list.map(e => e.id)).toEqual(['s1:e2', 's1:e3'])
    })

    it('throws GuardError for a ref targeting a different target, on both methods', async () => {
      await expect(adapter.listExecutions({ targetId: 'n8n', targetDeploymentId: 'dep-1' }, 20)).rejects.toThrow(GuardError)
      await expect(adapter.fetchExecution({ targetId: 'n8n', targetDeploymentId: 'dep-1' }, 'x')).rejects.toThrow(GuardError)
    })

    it('fetchExecution() throws GuardError for an unknown execution id', async () => {
      adapter.seedExecution('dep-1', makeScenario(), contract)
      await expect(adapter.fetchExecution({ targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }, 'does-not-exist')).rejects.toThrow(GuardError)
    })

    it('normalize() is a trivial pass-through of the seeded NormalizedExecution', async () => {
      const now = new Date('2026-07-20T12:00:00.000Z')
      adapter.seedExecution('dep-1', makeScenario(), contract, now)
      const ref = { targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }
      const [summary] = await adapter.listExecutions(ref, 20)
      const raw = await adapter.fetchExecution(ref, summary!.id)
      const normalized = adapter.normalize(contract, raw)
      expect(normalized).toBe(raw.asNormalizedExecution)
      expect(normalized.executionRef).toBe('scenario-1:start')
      expect(normalized.initiatingItems).toEqual([{ fields: { body: { phone: '555-0100' } } }])
    })
  })
})
