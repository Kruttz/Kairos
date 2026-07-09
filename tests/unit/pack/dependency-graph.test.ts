import { describe, it, expect } from 'vitest'
import { assignWorkflowKeys, resolveBuildOrder, seedAvailabilityMap, canBuildWithDependencies } from '../../../src/pack/dependency-graph.js'
import type { KeyedWorkflowPlan, AvailabilityMap } from '../../../src/pack/dependency-graph.js'
import type { WorkflowPlan } from '../../../src/pack/pack-builder.js'
import type { WorkflowReference } from '../../../src/pack/workflow-reference.js'

function makeWorkflow(name: string): WorkflowPlan {
  return { name, description: 'x', purpose: 'x' }
}

describe('assignWorkflowKeys', () => {
  it('assigns a slugified key to a single workflow', () => {
    const [result] = assignWorkflowKeys([makeWorkflow('Missed Call Webhook')])
    expect(result!.workflowKey).toBe('missed-call-webhook')
  })

  it('assigns distinct keys to workflows with distinct names', () => {
    const results = assignWorkflowKeys([makeWorkflow('Referral Intake'), makeWorkflow('Weekly Summary Email')])
    expect(results.map((r) => r.workflowKey)).toEqual(['referral-intake', 'weekly-summary-email'])
  })

  it('appends a numeric suffix when two workflows share a name (dedup case)', () => {
    const results = assignWorkflowKeys([makeWorkflow('Send Confirmation Email'), makeWorkflow('Send Confirmation Email')])
    expect(results.map((r) => r.workflowKey)).toEqual(['send-confirmation-email', 'send-confirmation-email-2'])
  })

  it('increments the suffix correctly for three or more identically-named workflows', () => {
    const results = assignWorkflowKeys([makeWorkflow('Send Email'), makeWorkflow('Send Email'), makeWorkflow('Send Email')])
    expect(results.map((r) => r.workflowKey)).toEqual(['send-email', 'send-email-2', 'send-email-3'])
  })

  it('does not mutate the input array or its elements', () => {
    const input = [makeWorkflow('Referral Intake')]
    const inputCopy = JSON.parse(JSON.stringify(input)) as WorkflowPlan[]
    assignWorkflowKeys(input)
    expect(input).toEqual(inputCopy)
  })

  it('preserves every other field on the workflow', () => {
    const [result] = assignWorkflowKeys([{ name: 'Referral Intake', description: 'Handles referrals', purpose: 'Speed' }])
    expect(result!.description).toBe('Handles referrals')
    expect(result!.purpose).toBe('Speed')
  })
})

describe('resolveBuildOrder', () => {
  function keyed(entries: Array<{ name: string; dependsOn?: unknown }>): KeyedWorkflowPlan[] {
    const plans: WorkflowPlan[] = entries.map((e) => ({ name: e.name, description: 'x', purpose: 'x', ...(('dependsOn' in e) ? { dependsOn: e.dependsOn } : {}) }))
    return assignWorkflowKeys(plans)
  }

  it('no dependencies: trivial order equals plan order, nothing rejected', () => {
    const workflows = keyed([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const result = resolveBuildOrder(workflows)
    expect(result.order.map((w) => w.workflowKey)).toEqual(['a', 'b', 'c'])
    expect(result.rejected.size).toBe(0)
    expect(result.deduped.size).toBe(0)
  })

  it('a simple valid chain: B depends on A, builds after it', () => {
    const workflows = keyed([{ name: 'A' }, { name: 'B', dependsOn: ['A'] }])
    const result = resolveBuildOrder(workflows)
    const orderKeys = result.order.map((w) => w.workflowKey)
    expect(orderKeys.indexOf('a')).toBeLessThan(orderKeys.indexOf('b'))
    expect(result.rejected.size).toBe(0)
    expect(result.resolvedDependsOn.get('b')).toEqual(['a'])
  })

  it('a forward-declared dependency (B listed before A in the plan, but B depends on A) still reorders correctly', () => {
    const workflows = keyed([{ name: 'B', dependsOn: ['A'] }, { name: 'A' }])
    const result = resolveBuildOrder(workflows)
    const orderKeys = result.order.map((w) => w.workflowKey)
    expect(orderKeys.indexOf('a')).toBeLessThan(orderKeys.indexOf('b'))
    expect(result.rejected.size).toBe(0)
  })

  it('unknown dependency: rejects only the declaring workflow, unrelated workflows unaffected', () => {
    const workflows = keyed([{ name: 'A', dependsOn: ['Nonexistent Workflow'] }, { name: 'B' }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.get('a')).toEqual([{ reason: 'unknown_dependency', detail: 'Nonexistent Workflow' }])
    expect(result.order.map((w) => w.workflowKey)).toEqual(['b'])
  })

  it('ambiguous dependency: two workflows share a name, a third depending on that name is rejected', () => {
    const workflows = keyed([{ name: 'Send Email' }, { name: 'Send Email' }, { name: 'C', dependsOn: ['Send Email'] }])
    const result = resolveBuildOrder(workflows)
    const cRejection = result.rejected.get('c')
    expect(cRejection).toBeDefined()
    expect(cRejection![0]!.reason).toBe('ambiguous_dependency')
    expect(cRejection![0]!.detail).toContain('send-email')
    expect(cRejection![0]!.detail).toContain('send-email-2')
    // The two ambiguously-named workflows themselves have no dependsOn problem of their own.
    expect(result.order.map((w) => w.workflowKey)).toEqual(expect.arrayContaining(['send-email', 'send-email-2']))
  })

  it('malformed dependency (a bare string instead of an array) is rejected, not silently coerced to []', () => {
    const workflows = keyed([{ name: 'A', dependsOn: 'Some Workflow' }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.get('a')).toEqual([{ reason: 'malformed_dependency', detail: JSON.stringify('Some Workflow') }])
    expect(result.order).toEqual([])
  })

  it('malformed dependency (an array containing a non-string element) is rejected', () => {
    const workflows = keyed([{ name: 'A', dependsOn: ['B', 42] }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.get('a')?.[0]?.reason).toBe('malformed_dependency')
  })

  it('missing dependsOn (undefined) resolves to an empty dependency set, not a rejection', () => {
    const workflows = keyed([{ name: 'A' }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.size).toBe(0)
    expect(result.resolvedDependsOn.get('a')).toEqual([])
  })

  it('self-dependency: a workflow depending on its own name is rejected', () => {
    const workflows = keyed([{ name: 'A', dependsOn: ['A'] }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.get('a')).toEqual([{ reason: 'self_dependency', detail: 'a' }])
    expect(result.order).toEqual([])
  })

  it('a 2-workflow cycle rejects both participants, unrelated workflows unaffected', () => {
    const workflows = keyed([{ name: 'A', dependsOn: ['B'] }, { name: 'B', dependsOn: ['A'] }, { name: 'C' }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.get('a')?.[0]?.reason).toBe('cycle')
    expect(result.rejected.get('b')?.[0]?.reason).toBe('cycle')
    expect(result.order.map((w) => w.workflowKey)).toEqual(['c'])
  })

  it('a 3-workflow cycle rejects all three participants', () => {
    const workflows = keyed([{ name: 'A', dependsOn: ['B'] }, { name: 'B', dependsOn: ['C'] }, { name: 'C', dependsOn: ['A'] }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.get('a')?.[0]?.reason).toBe('cycle')
    expect(result.rejected.get('b')?.[0]?.reason).toBe('cycle')
    expect(result.rejected.get('c')?.[0]?.reason).toBe('cycle')
    expect(result.order).toEqual([])
  })

  it('duplicate dependency: deduped, not rejected -- the workflow still builds against the collapsed edge set', () => {
    const workflows = keyed([{ name: 'A' }, { name: 'B', dependsOn: ['A', 'A'] }])
    const result = resolveBuildOrder(workflows)
    expect(result.rejected.size).toBe(0)
    expect(result.deduped.get('b')).toEqual(['a'])
    expect(result.resolvedDependsOn.get('b')).toEqual(['a'])
    expect(result.order.map((w) => w.workflowKey)).toEqual(['a', 'b'])
  })

  it('never assigns a topological position to any rejected workflow, across every rejection category', () => {
    const workflows = keyed([
      { name: 'Unknown Dep', dependsOn: ['Nope'] },
      { name: 'Ambiguous A' }, { name: 'Ambiguous A' }, { name: 'Uses Ambiguous', dependsOn: ['Ambiguous A'] },
      { name: 'Malformed', dependsOn: 'not-an-array' },
      { name: 'Self Dep', dependsOn: ['Self Dep'] },
      { name: 'Cycle A', dependsOn: ['Cycle B'] }, { name: 'Cycle B', dependsOn: ['Cycle A'] },
      { name: 'Clean' },
    ])
    const result = resolveBuildOrder(workflows)
    const orderKeys = new Set(result.order.map((w) => w.workflowKey))
    for (const rejectedKey of result.rejected.keys()) {
      expect(orderKeys.has(rejectedKey)).toBe(false)
    }
    expect(orderKeys.has('clean')).toBe(true)
  })
})

describe('cascading build-time availability gate', () => {
  function fakeReference(workflowKey: string, deployed: boolean): WorkflowReference {
    // activated mirrors deployed here -- these availability-gate simulation tests only care
    // about the deployed-vs-dry-run distinction, not the separate deployed/activated split
    // (that's exercised directly in prompt-builder.test.ts and workflow-reference.test.ts).
    return { workflowKey, workflowName: workflowKey, deployed, activated: deployed, workflowId: deployed ? `wf-${workflowKey}` : null, nodeNames: [], credentialsUsed: [] }
  }

  /** Simulates what commit 8's real pack-builder loop will do: iterate resolveBuildOrder()'s
   * order, gate each workflow on canBuildWithDependencies(), and record either a real
   * WorkflowReference or 'unavailable' depending on simulateBuild's outcome for that key. */
  function simulateLoop(
    order: KeyedWorkflowPlan[],
    resolvedDependsOn: Map<string, string[]>,
    availability: AvailabilityMap,
    simulateBuild: (key: string) => WorkflowReference | 'throw',
  ): { attempted: string[]; skipped: string[] } {
    const attempted: string[] = []
    const skipped: string[] = []
    for (const wf of order) {
      const deps = resolvedDependsOn.get(wf.workflowKey) ?? []
      if (!canBuildWithDependencies(availability, deps)) {
        availability.set(wf.workflowKey, 'unavailable')
        skipped.push(wf.workflowKey)
        continue
      }
      attempted.push(wf.workflowKey)
      const outcome = simulateBuild(wf.workflowKey)
      availability.set(wf.workflowKey, outcome === 'throw' ? 'unavailable' : outcome)
    }
    return { attempted, skipped }
  }

  it('pre-seeds every rejected workflow as unavailable before any building happens', () => {
    const rejected = new Map([['a', [{ reason: 'unknown_dependency' as const, detail: 'x' }]]])
    const availability = seedAvailabilityMap(rejected)
    expect(availability.get('a')).toBe('unavailable')
  })

  it('canBuildWithDependencies is true only when every dependency resolved to a real WorkflowReference', () => {
    const availability: AvailabilityMap = new Map([
      ['a', fakeReference('a', true)],
      ['b', 'unavailable'],
    ])
    expect(canBuildWithDependencies(availability, ['a'])).toBe(true)
    expect(canBuildWithDependencies(availability, ['b'])).toBe(false)
    expect(canBuildWithDependencies(availability, ['a', 'b'])).toBe(false)
    expect(canBuildWithDependencies(availability, [])).toBe(true)
    expect(canBuildWithDependencies(availability, ['nonexistent'])).toBe(false)
  })

  it('a 3-workflow chain (C depends on B depends on A) where A\'s build throws cascades: B and C are both skipped, neither attempted', () => {
    const workflows = assignWorkflowKeys([{ name: 'A', description: 'x', purpose: 'x' }, { name: 'B', description: 'x', purpose: 'x', dependsOn: ['A'] }, { name: 'C', description: 'x', purpose: 'x', dependsOn: ['B'] }])
    const { order, rejected, resolvedDependsOn } = resolveBuildOrder(workflows)
    const availability = seedAvailabilityMap(rejected)

    const { attempted, skipped } = simulateLoop(order, resolvedDependsOn, availability, (key) => (key === 'a' ? 'throw' : fakeReference(key, true)))

    expect(attempted).toEqual(['a'])
    expect(skipped).toEqual(['b', 'c'])
  })

  it('the same chain where A is instead rejected by resolveBuildOrder() (not a build failure) produces the identical cascade', () => {
    const workflows = assignWorkflowKeys([{ name: 'A', description: 'x', purpose: 'x', dependsOn: ['Nonexistent'] }, { name: 'B', description: 'x', purpose: 'x', dependsOn: ['A'] }, { name: 'C', description: 'x', purpose: 'x', dependsOn: ['B'] }])
    const { order, rejected, resolvedDependsOn } = resolveBuildOrder(workflows)
    expect(rejected.has('a')).toBe(true)
    const availability = seedAvailabilityMap(rejected)

    const { attempted, skipped } = simulateLoop(order, resolvedDependsOn, availability, (key) => fakeReference(key, true))

    // A was never in `order` at all (rejected before generation spend), so it can't appear in
    // `attempted`. B and C are both skipped via the pre-seeded 'unavailable' cascade.
    expect(attempted).toEqual([])
    expect(skipped).toEqual(['b', 'c'])
  })

  it('the same chain fully dry-run builds all three normally -- dry-run is never treated as unavailable', () => {
    const workflows = assignWorkflowKeys([{ name: 'A', description: 'x', purpose: 'x' }, { name: 'B', description: 'x', purpose: 'x', dependsOn: ['A'] }, { name: 'C', description: 'x', purpose: 'x', dependsOn: ['B'] }])
    const { order, rejected, resolvedDependsOn } = resolveBuildOrder(workflows)
    const availability = seedAvailabilityMap(rejected)

    const { attempted, skipped } = simulateLoop(order, resolvedDependsOn, availability, (key) => fakeReference(key, false))

    expect(attempted).toEqual(['a', 'b', 'c'])
    expect(skipped).toEqual([])
    expect(availability.get('a')).toEqual(fakeReference('a', false))
  })

  it('an unrelated workflow with no path back to a failure still builds normally', () => {
    const workflows = assignWorkflowKeys([
      { name: 'A', description: 'x', purpose: 'x' },
      { name: 'B', description: 'x', purpose: 'x', dependsOn: ['A'] },
      { name: 'D', description: 'x', purpose: 'x' },
    ])
    const { order, rejected, resolvedDependsOn } = resolveBuildOrder(workflows)
    const availability = seedAvailabilityMap(rejected)

    const { attempted, skipped } = simulateLoop(order, resolvedDependsOn, availability, (key) => (key === 'a' ? 'throw' : fakeReference(key, true)))

    expect(attempted).toEqual(['a', 'd'])
    expect(skipped).toEqual(['b'])
  })
})
