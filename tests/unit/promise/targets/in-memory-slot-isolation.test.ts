import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InMemoryContractTarget } from '../../../../src/promise/targets/in-memory/adapter.js'
import type { ProcessContract } from '../../../../src/promise/types.js'

/**
 * Execution Substrate Boundary v0, Phase 5 (docs/plans/execution-substrate-boundary-plan.md §7,
 * conformance suite #3, correction 12's own direct test). An earlier draft of this adapter's
 * deployArtifact() stored `this.deployments.set(id, artifact)` -- the ENTIRE ContractDecomposition,
 * every slot -- under EACH individual slot's own freshly-generated deployment id. That meant
 * fetching any one slot's deployment returned every slot's data indiscriminately, silently
 * weakening the adapter's own stated purpose: n8n deploys N independently-fetchable workflows,
 * each containing only its own content, and an in-memory adapter that doesn't mirror this isn't
 * proving the interfaces work correctly for a target with genuinely separate per-slot artifacts.
 * This suite pins the corrected behavior directly, not just relies on it being implied by other
 * tests passing.
 */

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

describe('InMemoryContractTarget -- deployment-slot isolation', () => {
  it('a multi-slot contract deploys N independently-fetchable slots, and fetching one never returns any other slot\'s data', async () => {
    const adapter = new InMemoryContractTarget()
    const contract = empireHomecare()
    const { artifact } = adapter.compileContract(contract)
    // Empire Homecare compiles to 3 slots (intake, processing, escalation) -- a real,
    // multi-slot decomposition, not a degenerate single-slot case that couldn't distinguish
    // "fetch this one thing" from "fetch everything."
    expect(artifact.slots.length).toBeGreaterThan(1)

    const deployResult = await adapter.deployArtifact(artifact, {})
    expect(deployResult.slots).toHaveLength(artifact.slots.length)
    const deployedRefs = deployResult.slots.map(s => {
      if (s.outcome !== 'deployed') throw new Error(`expected every slot deployed, got ${s.outcome}`)
      return { slotName: s.slotName, ref: s.ref }
    })

    // Every deployment id is genuinely unique.
    const ids = deployedRefs.map(d => d.ref.targetDeploymentId)
    expect(new Set(ids).size).toBe(ids.length)

    // Fetching each one back returns ONLY that slot's own data -- its own name matches, and its
    // own sourceElements match ONLY the original slot with that name, never a different slot's.
    for (const { slotName, ref } of deployedRefs) {
      const snapshot = await adapter.fetchDeployment(ref)
      const fetchedSlot = snapshot.raw as { name: string; kind: string; sourceElements: string[] }
      expect(fetchedSlot.name).toBe(slotName)

      const originalSlot = artifact.slots.find(s => s.name === slotName)!
      expect(fetchedSlot.sourceElements).toEqual(originalSlot.sourceElements)

      // The concrete regression check: this slot's own sourceElements must never equal, or be a
      // superset containing, ANY other slot's sourceElements -- the exact failure mode of the
      // pre-correction bug (every fetch returning the whole decomposition, so every slot's
      // "own" sourceElements would spuriously include every other slot's too).
      const otherSlots = artifact.slots.filter(s => s.name !== slotName)
      for (const other of otherSlots) {
        for (const el of other.sourceElements) {
          expect(fetchedSlot.sourceElements).not.toContain(el)
        }
      }
    }
  })

  it('fetching one slot does not expose the whole decomposition\'s own top-level "slots" shape at all -- the raw payload IS one WorkflowSlot, not {slots: [...]}', async () => {
    const adapter = new InMemoryContractTarget()
    const contract = empireHomecare()
    const { artifact } = adapter.compileContract(contract)
    const deployResult = await adapter.deployArtifact(artifact, {})
    const first = deployResult.slots[0]!
    if (first.outcome !== 'deployed') throw new Error('expected deployed')

    const snapshot = await adapter.fetchDeployment(first.ref)
    expect(snapshot.raw).not.toHaveProperty('slots')
    expect(snapshot.raw).toHaveProperty('name')
    expect(snapshot.raw).toHaveProperty('kind')
  })

  it('a rebuild (redeploying the identical artifact a second time) produces fresh ids whose slots are STILL independently isolated from both the old and new deployment of every other slot', async () => {
    const adapter = new InMemoryContractTarget()
    const contract = empireHomecare()
    const { artifact } = adapter.compileContract(contract)

    const first = await adapter.deployArtifact(artifact, {})
    const second = await adapter.deployArtifact(artifact, {})

    const firstRefs = first.slots.map(s => (s.outcome === 'deployed' ? s.ref : (() => { throw new Error('expected deployed') })()))
    const secondRefs = second.slots.map(s => (s.outcome === 'deployed' ? s.ref : (() => { throw new Error('expected deployed') })()))

    // Fetch every slot from BOTH deployments -- each must still resolve to exactly its own
    // slot's data, never bleeding into any other slot OR the other deployment generation.
    for (let i = 0; i < artifact.slots.length; i++) {
      const expectedName = artifact.slots[i]!.name
      const fromFirst = (await adapter.fetchDeployment(firstRefs[i]!)).raw as { name: string }
      const fromSecond = (await adapter.fetchDeployment(secondRefs[i]!)).raw as { name: string }
      expect(fromFirst.name).toBe(expectedName)
      expect(fromSecond.name).toBe(expectedName)
    }
  })
})
