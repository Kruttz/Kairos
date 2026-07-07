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

/**
 * Pure-TS BM25 over each node's description + body + tags, weighted by recency and a small
 * boost for `preference`-type nodes (durable facts about how a client wants things done).
 * No embeddings, no external services — designed so a hybrid (embedding+BM25) ranker can
 * later replace just the scoring step without changing this function's signature.
 */
export function rankMemories(query: string, nodes: MemoryNode[], k = 5): MemoryNode[] {
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

  const scored = nodes.map((node, i) => {
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

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.node)
}
