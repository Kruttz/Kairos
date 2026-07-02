import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCatalogCache, writeCatalogCache, isCacheExpired } from '../../../src/utils/node-catalog-cache.js'
import { NodeRegistry } from '../../../src/validation/registry.js'
import { N8nValidator } from '../../../src/validation/validator.js'
import type { SyncResult } from '../../../src/validation/node-syncer.js'

const MOCK_SYNC_RESULT: SyncResult = {
  registry: new NodeRegistry([
    { type: 'n8n-nodes-base.manualTrigger', safeTypeVersions: [1], requiredParams: [], isTrigger: true },
    { type: 'n8n-nodes-base.httpRequest', safeTypeVersions: [4, 4.1, 4.2], requiredParams: ['url'] },
  ]),
  catalogText: 'mock catalog text',
  nodeCount: 2,
  newNodes: 0,
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
    const expired = {
      cachedAt: Date.now() - 25 * 60 * 60 * 1000,
      nodeDefinitions: [{ type: 'n8n-nodes-base.manualTrigger', safeTypeVersions: [1], requiredParams: [], isTrigger: true }],
      catalogText: 'mock',
      nodeCount: 1,
    }
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
    expect(result?.nodeCount).toBe(2)
  })

  it('reconstructs a live NodeRegistry whose methods work after round-trip', async () => {
    const cachePath = join(tmpDir, 'cache.json')
    await writeCatalogCache(cachePath, MOCK_SYNC_RESULT)
    const result = await readCatalogCache(cachePath)

    expect(result).not.toBeNull()
    // These calls would throw TypeError if registry were a dead plain object
    expect(result!.registry.isTrigger('n8n-nodes-base.manualTrigger')).toBe(true)
    expect(result!.registry.isTrigger('n8n-nodes-base.httpRequest')).toBe(false)
    expect(result!.registry.isKnown('n8n-nodes-base.httpRequest')).toBe(true)
    expect(result!.registry.isKnown('n8n-nodes-base.unknownNode')).toBe(false)
    expect(result!.registry.isVersionSafe('n8n-nodes-base.httpRequest', 4.2)).toBe(true)
  })

  it('reconstructed registry can validate a workflow without throwing', async () => {
    const cachePath = join(tmpDir, 'cache.json')
    await writeCatalogCache(cachePath, MOCK_SYNC_RESULT)
    const result = await readCatalogCache(cachePath)

    const validator = new N8nValidator(result!.registry)
    const workflow = {
      name: 'Test',
      nodes: [
        {
          id: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
          name: 'Manual Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [250, 300] as [number, number],
          parameters: {},
        },
      ],
      connections: {},
      settings: {
        saveExecutionProgress: true,
        saveManualExecutions: true,
        saveDataErrorExecution: 'all' as const,
        saveDataSuccessExecution: 'all' as const,
        executionTimeout: 3600,
        timezone: 'UTC',
        executionOrder: 'v1' as const,
      },
    }

    // Should not throw — this is the exact failure mode of the cache bug
    expect(() => validator.validate(workflow)).not.toThrow()
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
    await expect(
      writeCatalogCache('/root/no-permission/cache.json', MOCK_SYNC_RESULT)
    ).resolves.not.toThrow()
  })

  it('stores node definitions as plain array (not class instance)', async () => {
    const cachePath = join(tmpDir, 'cache.json')
    await writeCatalogCache(cachePath, MOCK_SYNC_RESULT)

    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(cachePath, 'utf-8')) as Record<string, unknown>
    expect(Array.isArray(raw['nodeDefinitions'])).toBe(true)
    // Confirm no 'syncResult' key — old broken format
    expect('syncResult' in raw).toBe(false)
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
    expect(isCacheExpired(fiveMinutesAgo, 10 * 60 * 1000)).toBe(false)
    expect(isCacheExpired(fiveMinutesAgo, 1 * 60 * 1000)).toBe(true)
  })
})
