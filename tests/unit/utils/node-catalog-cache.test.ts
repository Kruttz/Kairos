import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCatalogCache, writeCatalogCache, isCacheExpired } from '../../../src/utils/node-catalog-cache.js'
import type { SyncResult } from '../../../src/validation/node-syncer.js'

const MOCK_SYNC_RESULT: SyncResult = {
  registry: { nodes: {} } as SyncResult['registry'],
  catalogText: 'mock catalog text',
  nodeCount: 42,
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kairos-cache-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('readCatalogCache', () => {
  it('returns null when file does not exist', async () => {
    const result = await readCatalogCache(join(tmpDir, 'nonexistent.json'))
    expect(result).toBeNull()
  })

  it('returns null when cache file is malformed JSON', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpDir, 'cache.json'), 'not valid json')
    const result = await readCatalogCache(join(tmpDir, 'cache.json'))
    expect(result).toBeNull()
  })

  it('returns null when cache is expired (older than 24 hours)', async () => {
    const { writeFile } = await import('node:fs/promises')
    const expired = { cachedAt: Date.now() - 25 * 60 * 60 * 1000, syncResult: MOCK_SYNC_RESULT }
    await writeFile(join(tmpDir, 'cache.json'), JSON.stringify(expired))
    const result = await readCatalogCache(join(tmpDir, 'cache.json'))
    expect(result).toBeNull()
  })

  it('returns SyncResult when cache is fresh', async () => {
    const cachePath = join(tmpDir, 'cache.json')
    await writeCatalogCache(cachePath, MOCK_SYNC_RESULT)
    const result = await readCatalogCache(cachePath)
    expect(result).not.toBeNull()
    expect(result?.catalogText).toBe('mock catalog text')
    expect(result?.nodeCount).toBe(42)
  })
})

describe('writeCatalogCache', () => {
  it('creates parent directories if they do not exist', async () => {
    const cachePath = join(tmpDir, 'deep', 'nested', 'cache.json')
    await writeCatalogCache(cachePath, MOCK_SYNC_RESULT)
    const result = await readCatalogCache(cachePath)
    expect(result).not.toBeNull()
  })

  it('does not throw when path is unwritable (non-fatal)', async () => {
    // Writing to a path that can't be created — should not throw
    await expect(
      writeCatalogCache('/root/no-permission/cache.json', MOCK_SYNC_RESULT)
    ).resolves.not.toThrow()
  })
})

describe('isCacheExpired', () => {
  it('returns false for a fresh timestamp', () => {
    expect(isCacheExpired(Date.now() - 1000)).toBe(false)
  })

  it('returns true when older than TTL', () => {
    expect(isCacheExpired(Date.now() - 25 * 60 * 60 * 1000)).toBe(true)
  })

  it('respects custom TTL', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
    expect(isCacheExpired(fiveMinutesAgo, 10 * 60 * 1000)).toBe(false)  // 10min TTL
    expect(isCacheExpired(fiveMinutesAgo, 1 * 60 * 1000)).toBe(true)    // 1min TTL
  })
})
