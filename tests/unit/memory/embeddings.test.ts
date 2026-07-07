import { describe, it, expect, afterEach } from 'vitest'
import { getEmbeddingProvider, resetEmbeddingProviderCache, cosineSimilarity } from '../../../src/memory/embeddings.js'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10)
  })

  it('returns 0 for a zero vector (avoids division by zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('is symmetric', () => {
    const a = [0.1, 0.4, -0.2, 0.9]
    const b = [0.3, -0.1, 0.5, 0.2]
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10)
  })
})

describe('getEmbeddingProvider — kill switch and caching', () => {
  afterEach(() => {
    delete process.env['KAIROS_MEMORY_EMBEDDINGS']
    resetEmbeddingProviderCache()
  })

  it('returns null immediately when KAIROS_MEMORY_EMBEDDINGS=off, without attempting to load anything', async () => {
    process.env['KAIROS_MEMORY_EMBEDDINGS'] = 'off'
    const provider = await getEmbeddingProvider()
    expect(provider).toBeNull()
  })

  it('caches the off-result so a second call is instant', async () => {
    process.env['KAIROS_MEMORY_EMBEDDINGS'] = 'off'
    await getEmbeddingProvider()
    const start = Date.now()
    await getEmbeddingProvider()
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('resetEmbeddingProviderCache() clears the cache so a new attempt is made', async () => {
    process.env['KAIROS_MEMORY_EMBEDDINGS'] = 'off'
    const first = await getEmbeddingProvider()
    expect(first).toBeNull()
    resetEmbeddingProviderCache()
    delete process.env['KAIROS_MEMORY_EMBEDDINGS']
    // With the flag cleared and the cache reset, this call genuinely attempts to load
    // fastembed (installed here as a devDependency) -- allowed to take a while on first
    // model load/download, hence the generous timeout on this specific test only.
    const second = await getEmbeddingProvider()
    expect(second).not.toBeNull()
    expect(second?.dimensions).toBe(384)
    expect(second?.modelId).toBe('BAAI/bge-small-en-v1.5')
  }, 60_000)
})

describe('getEmbeddingProvider — real fastembed integration (slow, network on first run)', () => {
  afterEach(() => {
    delete process.env['KAIROS_MEMORY_EMBEDDINGS']
    resetEmbeddingProviderCache()
  })

  it('embeds documents and a query into vectors of the expected dimensionality', async () => {
    const provider = await getEmbeddingProvider()
    expect(provider).not.toBeNull()
    if (!provider) return

    const [docVector] = await provider.embedDocuments(['The client prefers concise Slack notifications.'])
    expect(docVector).toHaveLength(384)

    const queryVector = await provider.embedQuery('short slack messages')
    expect(queryVector).toHaveLength(384)

    // A semantically related document/query pair should score meaningfully above chance.
    const similarity = cosineSimilarity(docVector!, queryVector)
    expect(similarity).toBeGreaterThan(0.3)
  }, 60_000)
})
