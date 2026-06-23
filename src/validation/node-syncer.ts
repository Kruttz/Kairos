import type { N8nNodeTypeInfo } from '../providers/n8n/types.js'
import type { NodeDefinition } from './registry.js'
import { NodeRegistry, DEFAULT_REGISTRY } from './registry.js'

const TRIGGER_PATTERNS = [/trigger/i, /Trigger$/]

export interface SyncResult {
  registry: NodeRegistry
  catalogText: string
  nodeCount: number
  newNodes: number
}

export class NodeSyncer {
  private readonly baseRegistry: Map<string, NodeDefinition>

  constructor() {
    this.baseRegistry = new Map(DEFAULT_REGISTRY.map(d => [d.type, d]))
  }

  sync(liveNodes: N8nNodeTypeInfo[]): SyncResult {
    const merged = new Map(this.baseRegistry)
    let newNodes = 0

    for (const node of liveNodes) {
      const versions = Array.isArray(node.version) ? node.version : [node.version]
      const isTrigger = TRIGGER_PATTERNS.some(p => p.test(node.name))
      const credentialType = node.credentials?.[0]?.name

      const existing = merged.get(node.name)
      if (existing) {
        const allVersions = new Set([...existing.safeTypeVersions, ...versions])
        merged.set(node.name, {
          ...existing,
          safeTypeVersions: [...allVersions].sort((a, b) => a - b),
        })
      } else {
        newNodes++
        merged.set(node.name, {
          type: node.name,
          safeTypeVersions: versions.sort((a, b) => a - b),
          requiredParams: [],
          ...(credentialType ? { credentialType } : {}),
          ...(isTrigger ? { isTrigger: true } : {}),
        })
      }
    }

    const definitions = [...merged.values()]
    const registry = new NodeRegistry(definitions)
    const catalogText = this.buildCatalog(definitions)

    return { registry, catalogText, nodeCount: definitions.length, newNodes }
  }

  private buildCatalog(definitions: NodeDefinition[]): string {
    const triggers = definitions.filter(d => d.isTrigger)
    const regular = definitions.filter(d => !d.isTrigger)

    const formatEntry = (d: NodeDefinition): string => {
      const versions = d.safeTypeVersions.join(', ')
      const cred = d.credentialType ? ` — cred: ${d.credentialType}` : ''
      return `${d.type}  typeVersion: ${versions}${cred}`
    }

    const triggerLines = triggers.map(formatEntry).join('\n')
    const regularLines = regular.map(formatEntry).join('\n')

    return `## NODE CATALOG — synced from your n8n instance (${definitions.length} node types)

### Triggers:
${triggerLines}

### Regular nodes:
${regularLines}`
  }
}
