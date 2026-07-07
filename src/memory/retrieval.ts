import type { MemoryNode } from './types.js'

// Standard BM25 parameters.
const K1 = 1.5
const B = 0.75
// Recency half-life in days (SOLIVEN's formula) — a memory's relevance halves every 90
// days, floored so old-but-still-true facts (e.g. a preference set once) don't vanish.
const RECENCY_HALF_LIFE_DAYS = 90
const RECENCY_FLOOR = 0.5
const PREFERENCE_TYPE_BOOST = 1.15

/**
 * Minimal, conservative suffix stripping — not a real stemmer, just enough to catch the
 * most common singular/plural mismatch (e.g. "notification" vs "notifications") that exact
 * BM25 token matching would otherwise miss entirely. Confirmed live: a real client-memory
 * query missed a directly-relevant preference purely because of this exact plural mismatch,
 * before this normalization existed.
 */
function normalizeToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y'
  if (token.length > 4 && /[sxz]es$|[cs]hes$/.test(token)) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(normalizeToken)
}

function nodeDocument(node: MemoryNode): string[] {
  return tokenize([node.description, node.body, node.tags.join(' ')].join(' '))
}

function recencyMultiplier(updatedAt: string): number {
  const days = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24)
  if (!Number.isFinite(days) || days < 0) return 1
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS))
}

function scoreNodesBm25(query: string, nodes: MemoryNode[]): Array<{ node: MemoryNode; score: number }> {
  if (nodes.length === 0) return []

  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return []

  const docs = nodes.map((node) => nodeDocument(node))
  const docLengths = docs.map((d) => d.length)
  const avgDocLength = docLengths.reduce((s, l) => s + l, 0) / docLengths.length || 1
  const n = nodes.length

  const docFreq = new Map<string, number>()
  for (const term of queryTerms) {
    let count = 0
    for (const doc of docs) if (doc.includes(term)) count++
    docFreq.set(term, count)
  }

  return nodes.map((node, i) => {
    const doc = docs[i]!
    const docLength = docLengths[i]!
    let bm25 = 0
    for (const term of queryTerms) {
      const df = docFreq.get(term) ?? 0
      const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1)
      const tf = doc.filter((t) => t === term).length
      if (tf === 0) continue
      const denom = tf + K1 * (1 - B + (B * docLength) / avgDocLength)
      bm25 += idf * ((tf * (K1 + 1)) / denom)
    }
    const typeBoost = node.type === 'preference' ? PREFERENCE_TYPE_BOOST : 1
    const score = bm25 * recencyMultiplier(node.updatedAt) * typeBoost
    return { node, score }
  })
}

/**
 * Pure-TS BM25 over each node's description + body + tags, weighted by recency and a small
 * boost for `preference`-type nodes (durable facts about how a client wants things done).
 * No embeddings, no external services — this is the fallback ranker whenever the optional
 * embedding provider isn't installed/enabled, and the sole ranker in that case.
 */
export function rankMemories(query: string, nodes: MemoryNode[], k = 5): MemoryNode[] {
  return scoreNodesBm25(query, nodes)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.node)
}

/** Full BM25 ranking (node IDs only, not truncated) — the raw input to RRF fusion. */
export function bm25RankedIds(query: string, nodes: MemoryNode[]): string[] {
  return scoreNodesBm25(query, nodes)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.node.id)
}

/**
 * Reciprocal Rank Fusion — SOLIVEN's exact recipe (Score(d) = Σ 1/(k+rank+1)), used to
 * combine a BM25 ranking with a vector-similarity ranking into one. Rank-based (not
 * score-based) so it works regardless of the two rankings' very different score scales.
 */
export function rrfFuse(rankingA: string[], rankingB: string[], k = 60): Map<string, number> {
  const scores = new Map<string, number>()
  for (const ranking of [rankingA, rankingB]) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return scores
}

/**
 * Hybrid retrieval: fuses the BM25 ranking (which already carries recency + preference-type
 * weighting) with a vector-similarity ranking via RRF. `vectorScores` is nodeId -> cosine
 * similarity, computed by the caller (store.ts) from its persisted embedding sidecar — pass
 * `null` when no embedding provider is available, which degrades this to plain `rankMemories`.
 */
export function rankMemoriesHybrid(
  query: string,
  nodes: MemoryNode[],
  vectorScores: Map<string, number> | null,
  k = 5,
): MemoryNode[] {
  if (!vectorScores || vectorScores.size === 0) {
    return rankMemories(query, nodes, k)
  }

  const bm25Top20 = bm25RankedIds(query, nodes).slice(0, 20)
  const vectorTop20 = [...vectorScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, 20)

  if (bm25Top20.length === 0 && vectorTop20.length === 0) return []

  const fused = rrfFuse(bm25Top20, vectorTop20)
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => nodesById.get(id))
    .filter((n): n is MemoryNode => n !== undefined)
    .slice(0, k)
}
