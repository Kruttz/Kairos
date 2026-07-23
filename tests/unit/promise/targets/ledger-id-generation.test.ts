import { describe, it, expect } from 'vitest'
import { buildEntryId } from '../../../../src/promise/evidence-extraction.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4). Ledger identity is (targetId, id), never id alone -- buildEntryId() is where that
 * requirement is actually enforced: for n8n, the id is byte-identical to every id the
 * pre-boundary extractor ever produced (no target prefix at all); for any other targetId, the
 * target is folded directly into the id string itself, so two different targets can never
 * collide even if they happen to reuse the same raw executionRef/suffix.
 */
describe('buildEntryId', () => {
  it('is byte-identical to the pre-boundary format for n8n -- "${executionRef}:${suffix}", no target prefix', () => {
    expect(buildEntryId({ targetId: 'n8n', targetDeploymentId: 'wf-1' }, 'exec-1', 't-attempted-to-contacted:0.0.0'))
      .toBe('exec-1:t-attempted-to-contacted:0.0.0')
    expect(buildEntryId({ targetId: 'n8n', targetDeploymentId: 'wf-1' }, 'exec-1', 'instance_start:0.0.0'))
      .toBe('exec-1:instance_start:0.0.0')
  })

  it('self-distinguishes a non-n8n target by folding targetId directly into the id string', () => {
    expect(buildEntryId({ targetId: 'in-memory-test', targetDeploymentId: 'dep-1' }, 'exec-1', 't1:0'))
      .toBe('in-memory-test:exec-1:t1:0')
  })

  it('two different non-n8n targets that happen to reuse the exact same executionRef and suffix never collide', () => {
    const idA = buildEntryId({ targetId: 'target-a', targetDeploymentId: 'dep-1' }, 'exec-shared', 't1:0')
    const idB = buildEntryId({ targetId: 'target-b', targetDeploymentId: 'dep-1' }, 'exec-shared', 't1:0')
    expect(idA).not.toBe(idB)
  })
})
