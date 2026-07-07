import { describe, it, expect } from 'vitest'
import { rankMemories, rrfFuse, rankMemoriesHybrid, bm25RankedIds } from '../../../src/memory/retrieval.js'
import type { MemoryNode } from '../../../src/memory/types.js'

function node(overrides: Partial<MemoryNode>): MemoryNode {
  const now = new Date().toISOString()
  return {
    id: 'id',
    createdAt: now,
    updatedAt: now,
    source: 'system',
    type: 'reference',
    confidence: 1,
    tags: [],
    description: 'A memory node',
    body: '',
    ...overrides,
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

describe('rankMemories', () => {
  it('returns empty array when there are no nodes', () => {
    expect(rankMemories('query', [])).toEqual([])
  })

  it('returns empty array when the query has no matchable terms', () => {
    const nodes = [node({ description: 'Slack notifications' })]
    expect(rankMemories('   ', nodes)).toEqual([])
  })

  it('ranks the node whose description/body actually matches the query terms above an unrelated one', () => {
    const nodes = [
      node({ id: 'a', description: 'Client prefers Slack for urgent alerts', body: 'Never email for urgent issues.' }),
      node({ id: 'b', description: 'Client uses Google Sheets for inventory', body: 'Column A is SKU.' }),
    ]
    const results = rankMemories('urgent slack alerts', nodes)
    expect(results[0]!.id).toBe('a')
  })

  it('matches against body text, not just description (fixing a SOLIVEN gap)', () => {
    const nodes = [
      node({ id: 'a', description: 'General note', body: 'The client wants concise webhook responses.' }),
      node({ id: 'b', description: 'Unrelated note', body: 'Something about scheduling.' }),
    ]
    const results = rankMemories('webhook responses', nodes)
    expect(results[0]!.id).toBe('a')
  })

  it('gives a small boost to preference-type nodes over otherwise-similar reference nodes', () => {
    const nodes = [
      node({ id: 'ref', type: 'reference', description: 'concise messages preferred', body: 'concise messages preferred', updatedAt: daysAgo(0) }),
      node({ id: 'pref', type: 'preference', description: 'concise messages preferred', body: 'concise messages preferred', updatedAt: daysAgo(0) }),
    ]
    const results = rankMemories('concise messages preferred', nodes)
    expect(results[0]!.id).toBe('pref')
  })

  it('matches a singular query term against a plural stored term (regression: found live, "notification" vs "notifications" scored zero overlap before token normalization)', () => {
    const nodes = [
      node({ id: 'match', description: 'Always use Telegram instead of Slack for notifications', body: 'Always use Telegram instead of Slack for notifications' }),
      node({ id: 'nomatch', description: 'Unrelated billing preference', body: 'Unrelated billing preference' }),
    ]
    const results = rankMemories('Send a notification when a new order comes in via webhook', nodes)
    expect(results.map((n) => n.id)).toEqual(['match'])
  })

  it('ranks a recently-updated node above an old one with otherwise identical relevance', () => {
    const nodes = [
      node({ id: 'old', description: 'invoice automation preference', body: 'invoice automation preference', updatedAt: daysAgo(400) }),
      node({ id: 'fresh', description: 'invoice automation preference', body: 'invoice automation preference', updatedAt: daysAgo(1) }),
    ]
    const results = rankMemories('invoice automation preference', nodes)
    expect(results[0]!.id).toBe('fresh')
  })

  it('still surfaces an old node, just deprioritized (floor prevents total disappearance)', () => {
    const nodes = [
      node({ id: 'old', description: 'invoice automation', body: 'invoice automation', updatedAt: daysAgo(1000) }),
    ]
    const results = rankMemories('invoice automation', nodes)
    expect(results).toHaveLength(1)
  })

  it('respects the k limit', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node({ id: `n${i}`, description: 'shared keyword', body: 'shared keyword' }))
    const results = rankMemories('shared keyword', nodes, 3)
    expect(results).toHaveLength(3)
  })

  it('excludes nodes with zero relevance to the query', () => {
    const nodes = [
      node({ id: 'match', description: 'gmail credentials', body: 'gmail credentials' }),
      node({ id: 'nomatch', description: 'completely different topic', body: 'nothing shared here' }),
    ]
    const results = rankMemories('gmail credentials', nodes)
    expect(results.map((n) => n.id)).toEqual(['match'])
  })
})

describe('bm25RankedIds', () => {
  it('returns the full ranking (not truncated), best first', () => {
    const nodes = [
      node({ id: 'weak', description: 'slack', body: 'slack' }),
      node({ id: 'strong', description: 'slack notification alert slack', body: 'slack notification alert slack' }),
    ]
    const ranked = bm25RankedIds('slack notification alert', nodes)
    expect(ranked[0]).toBe('strong')
    expect(ranked).toContain('weak')
  })

  it('returns an empty array when nothing matches', () => {
    const nodes = [node({ id: 'a', description: 'x', body: 'x' })]
    expect(bm25RankedIds('completely unrelated query terms', nodes)).toEqual([])
  })
})

describe('rrfFuse', () => {
  it('gives the highest fused score to an id ranked first in both rankings', () => {
    const fused = rrfFuse(['a', 'b', 'c'], ['a', 'c', 'b'])
    const sorted = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
    expect(sorted[0]).toBe('a')
  })

  it('applies SOLIVEN\'s exact formula: score = sum of 1/(k+rank+1) across rankings', () => {
    const fused = rrfFuse(['x'], ['x'], 60)
    // rank 0 in each of two rankings: 1/(60+0+1) + 1/(60+0+1) = 2/61
    expect(fused.get('x')).toBeCloseTo(2 / 61, 10)
  })

  it('includes an id present in only one ranking', () => {
    const fused = rrfFuse(['only-in-a'], ['different'])
    expect(fused.has('only-in-a')).toBe(true)
    expect(fused.has('different')).toBe(true)
  })

  it('handles empty rankings', () => {
    expect(rrfFuse([], []).size).toBe(0)
    expect(rrfFuse(['a'], []).get('a')).toBeGreaterThan(0)
  })
})

describe('rankMemoriesHybrid', () => {
  it('falls back to plain BM25 ranking when vectorScores is null (no embedding provider)', () => {
    const nodes = [
      node({ id: 'match', description: 'concise slack alerts', body: 'concise slack alerts' }),
      node({ id: 'nomatch', description: 'unrelated', body: 'unrelated' }),
    ]
    const results = rankMemoriesHybrid('concise slack alerts', nodes, null)
    expect(results.map((n) => n.id)).toEqual(['match'])
  })

  it('surfaces a node found only by vector similarity (BM25 alone would miss it)', () => {
    const nodes = [
      node({ id: 'semantic-only', description: 'Client likes short and to the point messaging', body: 'Client likes short and to the point messaging' }),
      node({ id: 'unrelated', description: 'Billing cycle is monthly', body: 'Billing cycle is monthly' }),
    ]
    // Simulates an embedding model recognizing "concise" and "short and to the point" as
    // semantically similar even though they share zero exact tokens with the query.
    const vectorScores = new Map([['semantic-only', 0.91], ['unrelated', 0.12]])
    const results = rankMemoriesHybrid('concise communication preference', nodes, vectorScores)
    expect(results[0]!.id).toBe('semantic-only')
  })

  it('fuses BM25 and vector signal, not just one or the other', () => {
    const nodes = [
      node({ id: 'bm25-only', description: 'slack notification tone', body: 'slack notification tone' }),
      node({ id: 'vector-only', description: 'communication style', body: 'communication style' }),
      node({ id: 'both', description: 'slack notification style', body: 'slack notification style' }),
    ]
    const vectorScores = new Map([['vector-only', 0.9], ['both', 0.7], ['bm25-only', 0.1]])
    const results = rankMemoriesHybrid('slack notification communication style', nodes, vectorScores, 3)
    // "both" scores well on BOTH signals, so it should rank at or near the top -- neither
    // pure-BM25 nor pure-vector ranking alone would necessarily put it first.
    expect(results.map((n) => n.id)).toContain('both')
  })

  it('returns empty when there is no BM25 match and no vector scores', () => {
    const nodes = [node({ id: 'a', description: 'x', body: 'x' })]
    expect(rankMemoriesHybrid('unrelated', nodes, new Map())).toEqual([])
  })
})
