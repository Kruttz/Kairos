import type { MemoryNode } from './types.js'

/** Renders retrieved memory nodes into a system-prompt block. Returns null when there's
 * nothing to inject, so callers can skip appending an empty block. */
export function formatClientContext(nodes: MemoryNode[]): string | null {
  if (nodes.length === 0) return null
  const lines = ['[Client Context — accumulated from prior work with this client]', '']
  for (const node of nodes) {
    lines.push(`- (${node.type}) ${node.description}`)
    if (node.body.trim()) {
      lines.push(`  ${node.body.trim().replace(/\n/g, '\n  ')}`)
    }
  }
  return lines.join('\n')
}
