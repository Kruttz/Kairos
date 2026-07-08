import { createHash } from 'node:crypto'
import type { N8nWorkflow } from '../types/workflow.js'

/**
 * Recursively sorts object keys so two objects with identical content in a different key
 * order serialize identically. Array element order is preserved, not sorted -- array
 * position is often semantically meaningful (e.g. a connection's port index), unlike object
 * key order which never is in this codebase's JSON shapes.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * Bumped whenever the canonicalization algorithm itself changes (what gets included, how
 * nodes are sorted, etc.) -- without this, a hash computed under a changed algorithm would
 * look exactly like a hash computed under the old one, and two workflows would appear to
 * have "changed" (or not) based on an algorithm difference rather than a real content
 * difference. Prefixed into every returned hash so two hashes computed under different
 * schema versions are immediately recognizable as not comparable, rather than silently
 * compared byte-for-byte as if they meant the same thing.
 */
export const WORKFLOW_HASH_SCHEMA_VERSION = 'w1'

/**
 * Deterministic content hash of a workflow's semantic state: nodes, connections, and
 * settings -- the three fields that define what the workflow actually does. The nodes array
 * is sorted by node id before hashing so array order never affects the result (the same set
 * of nodes always hashes the same regardless of what order n8n or a generator happened to
 * list them in).
 *
 * Deliberately excludes `name` and `tags` -- a rename/retag is a real change but a different
 * kind than "the workflow's behavior changed," and is tracked separately (bundle manifests
 * already record the workflow name); folding it into this hash would make "did this
 * workflow's definition change" and "was this workflow renamed" indistinguishable.
 *
 * This is a different tool from computeTopologyHash() (src/templates/local-importer.ts),
 * which is deliberately INSENSITIVE to node ids/positions/credentials/parameter VALUES so it
 * can match structurally-similar templates for library dedup. This hash is the opposite:
 * sensitive to exact content, for answering "has this specific workflow's definition changed
 * since it was built or last exported" -- a wiring-only edit (same nodes, same parameters,
 * different connections) must produce a different hash here, which is exactly the case
 * computeTopologyHash() is designed to ignore.
 */
export function computeWorkflowHash(workflow: Pick<N8nWorkflow, 'nodes' | 'connections' | 'settings'>): string {
  const sortedNodes = [...workflow.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const payload = [
    canonicalJson(sortedNodes),
    canonicalJson(workflow.connections ?? {}),
    canonicalJson(workflow.settings ?? {}),
  ].join('||')

  return `${WORKFLOW_HASH_SCHEMA_VERSION}:${createHash('sha256').update(payload).digest('hex')}`
}
