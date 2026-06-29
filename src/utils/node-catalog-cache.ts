import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SyncResult } from '../validation/node-syncer.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface CachedCatalog {
  cachedAt: number
  syncResult: SyncResult
}

export async function readCatalogCache(cachePath: string): Promise<SyncResult | null> {
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as CachedCatalog
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) return null
    return cached.syncResult
  } catch {
    return null
  }
}

export async function writeCatalogCache(cachePath: string, syncResult: SyncResult): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    const payload: CachedCatalog = { cachedAt: Date.now(), syncResult }
    await writeFile(cachePath, JSON.stringify(payload), 'utf-8')
  } catch {
    // Cache write failure is non-fatal — next startup will just re-fetch
  }
}

export function isCacheExpired(cachedAt: number, ttlMs = CACHE_TTL_MS): boolean {
  return Date.now() - cachedAt > ttlMs
}
