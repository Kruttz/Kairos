import type { N8nWorkflow } from '../types/workflow.js'

export interface WorkflowDiff {
  addedNodes: Array<{ name: string; type: string }>
  removedNodes: Array<{ name: string; type: string }>
  changedTypeNodes: Array<{ name: string; oldType: string; newType: string }>
  addedCredentialTypes: string[]
  removedCredentialTypes: string[]
}

/**
 * Structural diff between the previously-deployed workflow and a newly-generated
 * replacement — matched by node name (n8n workflows don't carry a stable cross-redeploy
 * node ID a client can rely on). Deliberately node-name-based rather than a full deep diff:
 * enough to answer "what changed" for a human reviewer, not a byte-for-byte comparison.
 */
export function diffWorkflows(before: N8nWorkflow, after: N8nWorkflow): WorkflowDiff {
  const beforeByName = new Map(before.nodes.map((n) => [n.name, n]))
  const afterByName = new Map(after.nodes.map((n) => [n.name, n]))

  const addedNodes: Array<{ name: string; type: string }> = []
  const changedTypeNodes: Array<{ name: string; oldType: string; newType: string }> = []

  for (const [name, afterNode] of afterByName) {
    const beforeNode = beforeByName.get(name)
    if (!beforeNode) {
      addedNodes.push({ name, type: afterNode.type })
    } else if (beforeNode.type !== afterNode.type) {
      changedTypeNodes.push({ name, oldType: beforeNode.type, newType: afterNode.type })
    }
  }

  const removedNodes: Array<{ name: string; type: string }> = []
  for (const [name, beforeNode] of beforeByName) {
    if (!afterByName.has(name)) {
      removedNodes.push({ name, type: beforeNode.type })
    }
  }

  const beforeCredTypes = new Set(before.nodes.flatMap((n) => Object.keys(n.credentials ?? {})))
  const afterCredTypes = new Set(after.nodes.flatMap((n) => Object.keys(n.credentials ?? {})))

  const addedCredentialTypes = [...afterCredTypes].filter((t) => !beforeCredTypes.has(t))
  const removedCredentialTypes = [...beforeCredTypes].filter((t) => !afterCredTypes.has(t))

  return { addedNodes, removedNodes, changedTypeNodes, addedCredentialTypes, removedCredentialTypes }
}

export function formatDiff(diff: WorkflowDiff): string {
  const hasChanges =
    diff.addedNodes.length > 0 ||
    diff.removedNodes.length > 0 ||
    diff.changedTypeNodes.length > 0 ||
    diff.addedCredentialTypes.length > 0 ||
    diff.removedCredentialTypes.length > 0

  if (!hasChanges) {
    return 'What changed since the previous version:\n  No structural changes.'
  }

  const lines: string[] = ['What changed since the previous version:']
  for (const n of diff.addedNodes) lines.push(`  + added "${n.name}" (${n.type})`)
  for (const n of diff.removedNodes) lines.push(`  - removed "${n.name}" (${n.type})`)
  for (const n of diff.changedTypeNodes) lines.push(`  ~ "${n.name}" changed from ${n.oldType} to ${n.newType}`)
  for (const t of diff.addedCredentialTypes) lines.push(`  + now needs a "${t}" credential`)
  for (const t of diff.removedCredentialTypes) lines.push(`  - no longer needs a "${t}" credential`)
  return lines.join('\n')
}
