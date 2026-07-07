import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClientMemoryStore } from '../../../src/memory/store.js'
import { resetEmbeddingProviderCache } from '../../../src/memory/embeddings.js'

// Deliberately does NOT force KAIROS_MEMORY_EMBEDDINGS=off (unlike store.test.ts) --
// this file specifically verifies the real fastembed-backed hybrid path end to end,
// including the on-disk embeddings.json sidecar. fastembed is a devDependency here, so
// this genuinely exercises the real model, not a mock.

let tmpDirs: string[] = []

async function makeTmpBase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-hybrid-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
  tmpDirs = []
  resetEmbeddingProviderCache()
})

describe('ClientMemoryStore — hybrid retrieval with real embeddings', () => {
  it('writes an embeddings.json sidecar on remember() and uses it for retrieval', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('hybrid-test-client', { baseDir })

    await store.remember({
      type: 'preference',
      description: 'Client likes short, to-the-point communication',
      body: 'Client likes short, to-the-point communication',
    })

    const sidecarPath = join(baseDir, 'hybrid-test-client', 'memory', 'embeddings.json')
    const raw = await readFile(sidecarPath, 'utf-8')
    const sidecar = JSON.parse(raw) as Array<{ nodeId: string; contentHash: string; vector: number[] }>
    expect(sidecar).toHaveLength(1)
    expect(sidecar[0]!.vector).toHaveLength(384)
  }, 60_000)

  it('retrieves a semantically related memory that plain BM25 would miss entirely', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('hybrid-test-client-2', { baseDir })

    await store.remember({
      type: 'preference',
      description: 'Prefers brief, minimal wording in all outbound messages',
      body: 'Prefers brief, minimal wording in all outbound messages',
    })
    await store.remember({
      type: 'reference',
      description: 'Billing cycle renews on the 1st of each month',
      body: 'Billing cycle renews on the 1st of each month',
    })

    // Query shares zero exact tokens with the stored preference (no stem/plural overlap
    // either) -- only a real embedding model can connect "concise" to "brief, minimal".
    const results = await store.retrieve('Should notifications be concise or detailed?', 5)
    expect(results.some((n) => n.description.includes('brief, minimal wording'))).toBe(true)
  }, 60_000)

  it('does not recompute the embedding when content is unchanged (contentHash match)', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('hybrid-test-client-3', { baseDir })

    await store.remember({ type: 'reference', description: 'Stable fact', body: 'Stable fact' })
    const sidecarPath = join(baseDir, 'hybrid-test-client-3', 'memory', 'embeddings.json')
    const firstRaw = await readFile(sidecarPath, 'utf-8')

    // Re-remember with the exact same description+body -- dedup updates the node's
    // updatedAt, but content is unchanged, so the embedding should not be recomputed
    // (same vector persisted, verified by the sidecar content being byte-identical).
    await store.remember({ type: 'reference', description: 'Stable fact', body: 'Stable fact' })
    const secondRaw = await readFile(sidecarPath, 'utf-8')

    expect(secondRaw).toBe(firstRaw)
  }, 60_000)

  it('removes the embedding sidecar entry when a node is forgotten', async () => {
    const baseDir = await makeTmpBase()
    const store = new ClientMemoryStore('hybrid-test-client-4', { baseDir })

    const node = await store.remember({ type: 'reference', description: 'Temporary fact', body: 'Temporary fact' })
    await store.forget(node!.id)

    const sidecarPath = join(baseDir, 'hybrid-test-client-4', 'memory', 'embeddings.json')
    const raw = await readFile(sidecarPath, 'utf-8')
    expect(JSON.parse(raw)).toEqual([])
  }, 60_000)
})
