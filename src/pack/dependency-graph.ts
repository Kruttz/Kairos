import type { WorkflowPlan } from './pack-builder.js'
import { slugifyWorkflowName } from './pack-bundle.js'

/** A WorkflowPlan that has definitely been through assignWorkflowKeys() -- workflowKey is
 * required, not optional, at this point in the pipeline. resolveBuildOrder() requires this
 * narrowed type as its input, making "run assignWorkflowKeys() first" a compile-time contract
 * rather than a runtime assumption. */
export type KeyedWorkflowPlan = WorkflowPlan & { workflowKey: string }

/**
 * Assigns a stable workflowKey to every workflow in a plan, derived from its display name via
 * the existing slugifyWorkflowName() (src/pack/pack-bundle.ts) -- reused directly, not
 * duplicated. Two workflows can share a display name (the plan prompt doesn't enforce
 * uniqueness), so a numeric suffix (-2, -3, ...) is appended whenever a later workflow would
 * slug to a key already assigned to an earlier one. Processing is in plan order: the first
 * workflow with a given name always gets the bare slug, later ones get suffixed.
 *
 * Pure -- returns a new array, never mutates the input. dependsOn resolution (which name
 * matches which key) is a separate concern, handled by resolveBuildOrder()'s name-resolution
 * pass, not here.
 */
export function assignWorkflowKeys(workflows: WorkflowPlan[]): KeyedWorkflowPlan[] {
  const usedKeys = new Set<string>()

  return workflows.map((wf) => {
    const baseSlug = slugifyWorkflowName(wf.name)
    let key = baseSlug
    let suffix = 2
    while (usedKeys.has(key)) {
      key = `${baseSlug}-${suffix}`
      suffix++
    }
    usedKeys.add(key)
    return { ...wf, workflowKey: key }
  })
}

export type DependencyRejectionReason = 'malformed_dependency' | 'unknown_dependency' | 'ambiguous_dependency' | 'self_dependency' | 'cycle'

export interface DependencyRejection {
  reason: DependencyRejectionReason
  detail: string
}

export interface ResolveBuildOrderResult {
  /** Topologically sorted -- ONLY workflows that passed every validation pass. A rejected
   * workflow (any reason) never appears here; it exists only as a key in `rejected`. A
   * topological position is mathematically meaningless for a workflow that's part of a cycle
   * or was otherwise rejected, so it is never assigned one. */
  order: KeyedWorkflowPlan[]
  /** workflowKey -> why it was rejected (malformed/unknown/ambiguous/self/cycle). A workflow
   * can accumulate multiple rejection reasons if its dependsOn has more than one problem
   * (e.g. one unknown name and one ambiguous name in the same list). */
  rejected: Map<string, DependencyRejection[]>
  /** workflowKey -> the duplicate resolved keys that were collapsed. Advisory only -- a
   * workflow appearing here still builds normally against its deduplicated edge set. */
  deduped: Map<string, string[]>
  /** workflowKey -> its final, resolved-and-deduplicated dependency keys. Populated for every
   * workflow that passed the shape check and name resolution (Passes 1-2), including ones
   * later rejected for self-dependency or cycle participation (Passes 4-5) -- so a caller can
   * still see what the workflow's edges *would have been* even though it was rejected. Absent
   * only for workflows rejected in Pass 1 (malformed) or Pass 2 (unknown/ambiguous), since
   * those never produced a resolvable edge set at all. */
  resolvedDependsOn: Map<string, string[]>
}

/**
 * Six-pass validation and topological-ordering pipeline for a plan's dependsOn declarations
 * (Step 7 v4 design, docs/plans/hardening-and-chaining-plan.md §3): shape check -> name
 * resolution -> dedup -> self-dependency -> cycle detection -> topological sort. Each pass
 * operates only on what the previous pass left as still-candidate, so the categories can
 * never silently interact in an unspecified way. Pure -- zero Anthropic calls, zero I/O, so by
 * construction nothing here can ever cost generation spend regardless of outcome.
 */
export function resolveBuildOrder(workflows: KeyedWorkflowPlan[]): ResolveBuildOrderResult {
  const rejected = new Map<string, DependencyRejection[]>()
  const deduped = new Map<string, string[]>()
  const resolvedDependsOn = new Map<string, string[]>()

  function reject(key: string, reason: DependencyRejectionReason, detail: string): void {
    const list = rejected.get(key) ?? []
    list.push({ reason, detail })
    rejected.set(key, list)
  }

  // Name -> every workflowKey with that exact display name (usually one; more than one is
  // exactly what makes a dependsOn reference to that name ambiguous in Pass 2).
  const nameToKeys = new Map<string, string[]>()
  for (const wf of workflows) {
    const list = nameToKeys.get(wf.name) ?? []
    list.push(wf.workflowKey)
    nameToKeys.set(wf.name, list)
  }

  // Passes 1-3: shape check, name resolution, dedup -- independently per workflow.
  const afterResolution: KeyedWorkflowPlan[] = []
  for (const wf of workflows) {
    const raw = wf.dependsOn

    // Pass 1 -- shape check.
    if (raw === undefined) {
      resolvedDependsOn.set(wf.workflowKey, [])
      afterResolution.push(wf)
      continue
    }
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
      reject(wf.workflowKey, 'malformed_dependency', JSON.stringify(raw))
      continue
    }

    // Pass 2 -- name resolution.
    const names = raw as string[]
    const resolvedKeys: string[] = []
    let hadUnresolvableName = false
    for (const name of names) {
      const matches = nameToKeys.get(name) ?? []
      if (matches.length === 0) {
        reject(wf.workflowKey, 'unknown_dependency', name)
        hadUnresolvableName = true
      } else if (matches.length > 1) {
        reject(wf.workflowKey, 'ambiguous_dependency', `"${name}" matches multiple workflows: ${matches.join(', ')}`)
        hadUnresolvableName = true
      } else {
        resolvedKeys.push(matches[0]!)
      }
    }
    if (hadUnresolvableName) continue

    // Pass 3 -- dedup.
    const seen = new Set<string>()
    const duplicates: string[] = []
    const dedupedKeys: string[] = []
    for (const key of resolvedKeys) {
      if (seen.has(key)) {
        duplicates.push(key)
        continue
      }
      seen.add(key)
      dedupedKeys.push(key)
    }
    if (duplicates.length > 0) {
      deduped.set(wf.workflowKey, duplicates)
    }

    resolvedDependsOn.set(wf.workflowKey, dedupedKeys)
    afterResolution.push(wf)
  }

  // Pass 4 -- self-dependency.
  const afterSelfCheck: KeyedWorkflowPlan[] = []
  for (const wf of afterResolution) {
    const deps = resolvedDependsOn.get(wf.workflowKey) ?? []
    if (deps.includes(wf.workflowKey)) {
      reject(wf.workflowKey, 'self_dependency', wf.workflowKey)
      continue
    }
    afterSelfCheck.push(wf)
  }

  // Pass 5 -- cycle detection (standard white/gray/black DFS) over the survivor graph only.
  const survivorKeys = new Set(afterSelfCheck.map((wf) => wf.workflowKey))
  const color = new Map<string, 'white' | 'gray' | 'black'>()
  for (const wf of afterSelfCheck) color.set(wf.workflowKey, 'white')
  const cyclicKeys = new Set<string>()

  function visit(key: string, path: string[]): void {
    color.set(key, 'gray')
    path.push(key)
    const deps = (resolvedDependsOn.get(key) ?? []).filter((dep) => survivorKeys.has(dep))
    for (const dep of deps) {
      const depColor = color.get(dep)
      if (depColor === 'gray') {
        const cycleStart = path.indexOf(dep)
        for (const cycleKey of path.slice(cycleStart)) cyclicKeys.add(cycleKey)
      } else if (depColor === 'white') {
        visit(dep, path)
      }
    }
    path.pop()
    color.set(key, 'black')
  }

  for (const wf of afterSelfCheck) {
    if (color.get(wf.workflowKey) === 'white') visit(wf.workflowKey, [])
  }

  const afterCycleCheck: KeyedWorkflowPlan[] = []
  for (const wf of afterSelfCheck) {
    if (cyclicKeys.has(wf.workflowKey)) {
      reject(wf.workflowKey, 'cycle', [...cyclicKeys].sort().join(', '))
    } else {
      afterCycleCheck.push(wf)
    }
  }

  // Pass 6 -- topological sort (Kahn's algorithm) of the remaining, by-construction-acyclic
  // candidates. Ties (multiple zero-in-degree nodes) resolve in original plan order, since
  // afterCycleCheck itself preserves original relative order throughout every prior pass --
  // this is what makes "no dependencies at all" trivially return plan order unchanged.
  const finalKeys = new Set(afterCycleCheck.map((wf) => wf.workflowKey))
  const byKey = new Map(afterCycleCheck.map((wf) => [wf.workflowKey, wf]))
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const wf of afterCycleCheck) {
    dependents.set(wf.workflowKey, [])
  }
  for (const wf of afterCycleCheck) {
    const deps = (resolvedDependsOn.get(wf.workflowKey) ?? []).filter((dep) => finalKeys.has(dep))
    inDegree.set(wf.workflowKey, deps.length)
    for (const dep of deps) {
      dependents.get(dep)!.push(wf.workflowKey)
    }
  }

  const queue: string[] = afterCycleCheck.filter((wf) => inDegree.get(wf.workflowKey) === 0).map((wf) => wf.workflowKey)
  const orderedKeys: string[] = []
  while (queue.length > 0) {
    const key = queue.shift()!
    orderedKeys.push(key)
    for (const dependent of dependents.get(key) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) queue.push(dependent)
    }
  }

  const order = orderedKeys.map((key) => byKey.get(key)!)

  return { order, rejected, deduped, resolvedDependsOn }
}
