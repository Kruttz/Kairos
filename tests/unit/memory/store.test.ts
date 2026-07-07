import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClientMemoryStore, findSecretPattern } from '../../../src/memory/store.js'

// This file exercises pure storage/dedup/eviction/scrubber mechanics, not the optional
// embedding path (see embeddings.test.ts / retrieval.test.ts's hybrid cases for that) --
// force it off so these tests stay fast and deterministic even when fastembed happens to be
// installed (it's a devDependency here, so it always is within this repo's own test runs).
process.env['KAIROS_MEMORY_EMBEDDINGS'] = 'off'

let tmpDirs: string[] = []

async function makeTmpBase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-memory-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
  tmpDirs = []
})

describe('ClientMemoryStore — clientId validation (fail-closed)', () => {
  it('accepts a valid lowercase-alphanumeric-hyphen id', async () => {
    const baseDir = await makeTmpBase()
    expect(() => new ClientMemoryStore('empire-homecare', { baseDir })).not.toThrow()
  })

  it('is inert (isActive false) when clientId is undefined', () => {
    const store = new ClientMemoryStore(undefined)
    expect(store.isActive).toBe(false)
  })

  it('rejects uppercase', async () => {
    const baseDir = await makeTmpBase()
    expect(() => new ClientMemoryStore('Empire-Homecare', { baseDir })).toThrow(/Invalid clientId/)
  })

  it('rejects path traversal attempts', async () => {
    const baseDir = await makeTmpBase()
    expect(() => new ClientMemoryStore('../../etc', { baseDir })).toThrow(/Invalid clientId/)
    expect(() => new ClientMemoryStore('foo/../bar', { baseDir })).toThrow(/Invalid clientId/)
  })

  it('rejects empty string', async () => {
    const baseDir = await makeTmpBase()
    expect(() => new ClientMemoryStore('', { baseDir })).toThrow(/Invalid clientId/)
  })

  it('rejects ids over 64 characters', async () => {
    const baseDir = await makeTmpBase()
    expect(() => new ClientMemoryStore('a'.repeat(65), { baseDir })).toThrow(/Invalid clientId/)
  })

  it('accepts exactly 64 characters', async () => {
    const baseDir = await makeTmpBase()
    expect(() => new ClientMemoryStore('a'.repeat(64), { baseDir })).not.toThrow()
  })
})

describe('ClientMemoryStore — inert when no clientId (never touches filesystem)', () => {
  it('remember() returns null, retrieve()/loadAllNodes() return empty, forget() returns false', async () => {
    const store = new ClientMemoryStore(undefined)
    const result = await store.remember({ type: 'preference', description: 'test', body: 'test' })
    expect(result).toBeNull()
    expect(await store.retrieve('test')).toEqual([])
    expect(await store.loadAllNodes()).toEqual([])
    expect(await store.forget('any-id')).toBe(false)
    expect(await store.rebuildIndex()).toBe(0)
  })
})

describe('ClientMemoryStore — write/read round-trip', () => {
  it('writes a node and reads it back with frontmatter intact', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })

    const node = await store.remember({
      type: 'preference',
      description: 'Prefers concise Slack notifications',
      body: 'Client has explicitly asked for short messages, no emoji.',
      tags: ['slack', 'tone'],
      confidence: 0.9,
    })

    expect(node).not.toBeNull()
    expect(node!.id).toBeTruthy()
    expect(node!.type).toBe('preference')
    expect(node!.tags).toEqual(['slack', 'tone'])
    expect(node!.confidence).toBe(0.9)

    const all = await store.loadAllNodes()
    expect(all).toHaveLength(1)
    expect(all[0]!.description).toBe('Prefers concise Slack notifications')
    expect(all[0]!.body).toContain('short messages')
  })

  it('creates separate .md files per memory type directory', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await store.remember({ type: 'preference', description: 'A preference', body: 'body' })
    await store.remember({ type: 'history', description: 'A history event', body: 'body' })

    const all = await store.loadAllNodes()
    expect(all.map((n) => n.type).sort()).toEqual(['history', 'preference'])
  })
})

describe('ClientMemoryStore — dedup on write', () => {
  it('updates the existing node instead of creating a duplicate for the same description+type', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })

    const first = await store.remember({ type: 'preference', description: 'Likes short emails', body: 'v1' })
    const second = await store.remember({ type: 'preference', description: 'Likes short emails', body: 'v2' })

    expect(second!.id).toBe(first!.id)
    const all = await store.loadAllNodes()
    expect(all).toHaveLength(1)
    expect(all[0]!.body).toBe('v2')
  })

  it('is case/whitespace insensitive for dedup matching', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await store.remember({ type: 'preference', description: 'Likes short emails', body: 'v1' })
    await store.remember({ type: 'preference', description: '  LIKES SHORT EMAILS  ', body: 'v2' })

    const all = await store.loadAllNodes()
    expect(all).toHaveLength(1)
  })

  it('does not dedup across different types with the same description', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await store.remember({ type: 'preference', description: 'Same text', body: 'a' })
    await store.remember({ type: 'history', description: 'Same text', body: 'b' })

    const all = await store.loadAllNodes()
    expect(all).toHaveLength(2)
  })
})

describe('ClientMemoryStore — secret scrubber', () => {
  it('rejects an Anthropic-shaped API key in description or body', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await expect(store.remember({
      type: 'reference', description: 'API key is sk-ant-api03-abcdefghij1234567890', body: 'x',
    })).rejects.toThrow(/Refusing to store/)
    await expect(store.remember({
      type: 'reference', description: 'x', body: 'Use sk-ant-api03-abcdefghij1234567890 here',
    })).rejects.toThrow(/Refusing to store/)
  })

  it('rejects a Bearer token', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await expect(store.remember({
      type: 'reference', description: 'x', body: 'Authorization: Bearer abcdef1234567890ghijklmno',
    })).rejects.toThrow(/Refusing to store/)
  })

  it('rejects a long hex string', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await expect(store.remember({
      type: 'reference', description: 'x', body: 'token: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    })).rejects.toThrow(/Refusing to store/)
  })

  it('allows normal prose with no secret shapes', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    const node = await store.remember({
      type: 'reference', description: 'Google Sheet ID for contacts is in the shared drive', body: 'Ask the office manager for access.',
    })
    expect(node).not.toBeNull()
  })

  it('findSecretPattern returns null for safe text', () => {
    expect(findSecretPattern('This is a normal sentence about the client.')).toBeNull()
  })
})

describe('ClientMemoryStore — eviction', () => {
  it('evicts oldest history nodes first when over cap, never preference/reference', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir, cap: 3 })

    await store.remember({ type: 'preference', description: 'pref-1', body: 'x' })
    await store.remember({ type: 'history', description: 'hist-1', body: 'x' })
    await store.remember({ type: 'history', description: 'hist-2', body: 'x' })
    await store.remember({ type: 'history', description: 'hist-3', body: 'x' })

    const all = await store.loadAllNodes()
    expect(all.length).toBeLessThanOrEqual(3)
    expect(all.some((n) => n.description === 'pref-1')).toBe(true)
    // Oldest history (hist-1) should be gone, not the preference
    expect(all.some((n) => n.description === 'hist-1')).toBe(false)
  })

  it('eviction deletes the underlying file, not just the index entry', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir, cap: 1 })
    await store.remember({ type: 'history', description: 'hist-1', body: 'x' })
    await store.remember({ type: 'history', description: 'hist-2', body: 'x' })

    const rebuilt = await store.rebuildIndex()
    // If the evicted file still existed on disk, rebuildIndex would find it again.
    expect(rebuilt).toBe(1)
  })
})

describe('ClientMemoryStore — rebuildIndex (no hand-maintained drift)', () => {
  it('regenerates index.json from files on disk with a correct count', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await store.remember({ type: 'preference', description: 'a', body: 'x' })
    await store.remember({ type: 'history', description: 'b', body: 'x' })
    await store.remember({ type: 'incident', description: 'c', body: 'x' })

    const count = await store.rebuildIndex()
    expect(count).toBe(3)
    const all = await store.loadAllNodes()
    expect(all).toHaveLength(3)
  })
})

describe('ClientMemoryStore — forget', () => {
  it('removes a node by id and its file', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    const node = await store.remember({ type: 'reference', description: 'to be forgotten', body: 'x' })

    expect(await store.forget(node!.id)).toBe(true)
    expect(await store.loadAllNodes()).toEqual([])
  })

  it('returns false for an unknown id', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    expect(await store.forget('nonexistent')).toBe(false)
  })
})

describe('ClientMemoryStore — cross-client isolation', () => {
  it('two different clientIds never see each other\'s memories', async () => {
    const baseDir = await makeTmpBase()
    const storeA = new ClientMemoryStore('client-a', { baseDir })
    const storeB = new ClientMemoryStore('client-b', { baseDir })

    await storeA.remember({ type: 'preference', description: 'client A preference', body: 'x' })
    await storeB.remember({ type: 'preference', description: 'client B preference', body: 'x' })

    const allA = await storeA.loadAllNodes()
    const allB = await storeB.loadAllNodes()
    expect(allA).toHaveLength(1)
    expect(allB).toHaveLength(1)
    expect(allA[0]!.description).toBe('client A preference')
    expect(allB[0]!.description).toBe('client B preference')
  })
})

describe('ClientMemoryStore — frontmatter format sanity', () => {
  it('the .md file on disk is human-readable with visible frontmatter', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('test-client', { baseDir })
    await store.remember({ type: 'preference', description: 'readable check', body: 'The body text.' })

    const all = await store.loadAllNodes()
    const raw = await readFile(join(baseDir, 'test-client', 'memory', 'preference', `readable-check-${all[0]!.id.slice(0, 8)}.md`), 'utf-8')
    expect(raw).toContain('---')
    expect(raw).toContain('type: preference')
    expect(raw).toContain('The body text.')
  })
})
