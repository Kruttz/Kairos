import { describe, it, expect } from 'vitest'
import { rankMemories } from '../../../src/memory/retrieval.js'
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
