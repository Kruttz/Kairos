import type { WorkflowPlan } from './pack-builder.js'
import { slugifyWorkflowName } from './pack-bundle.js'

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
export function assignWorkflowKeys(workflows: WorkflowPlan[]): WorkflowPlan[] {
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
