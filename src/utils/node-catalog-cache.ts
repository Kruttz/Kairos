import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NodeRegistry, type NodeDefinition } from '../validation/registry.js'
import type { SyncResult } from '../validation/node-syncer.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Store only plain serializable data — NodeRegistry contains a private Map
// that JSON.stringify destroys, so we store NodeDefinition[] and reconstruct
// the registry on read.
interface CachedCatalog {
  cachedAt: number
  nodeDefinitions: NodeDefinition[]
  catalogText: string
  nodeCount: number
}

export async function readCatalogCache(cachePath: string): Promise<SyncResult | null> {
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as CachedCatalog
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) return null
    // Reconstruct NodeRegistry from the plain NodeDefinition array
    const registry = new NodeRegistry(cached.nodeDefinitions)
    return {
      registry,
      catalogText: cached.catalogText,
      nodeCount: cached.nodeCount,
      newNodes: 0,
    }
  } catch {
    return null
  }
}

export async function writeCatalogCache(cachePath: string, syncResult: SyncResult): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    const payload: CachedCatalog = {
      cachedAt: Date.now(),
      nodeDefinitions: syncResult.registry.definitions,
      catalogText: syncResult.catalogText,
      nodeCount: syncResult.nodeCount,
    }
    await writeFile(cachePath, JSON.stringify(payload), 'utf-8')
  } catch {
    // Cache write failure is non-fatal — next startup will just re-fetch
  }
}

export function isCacheExpired(cachedAt: number, ttlMs = CACHE_TTL_MS): boolean {
  return Date.now() - cachedAt > ttlMs
}
