import type { ILogger } from '../utils/logger.js'

export interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(query: string): Promise<number[]>
  readonly dimensions: number
  readonly modelId: string
}

const BGE_SMALL_DIMENSIONS = 384
const BGE_SMALL_MODEL_ID = 'BAAI/bge-small-en-v1.5'

// undefined = not yet attempted; null = attempted and unavailable (module missing, or
// KAIROS_MEMORY_EMBEDDINGS=off) -- cached so a missing/disabled provider only costs one
// failed dynamic import per process, not one per query.
let cachedProvider: EmbeddingProvider | null | undefined

/**
 * Loads the optional `fastembed` peer dependency (same model SOLIVEN used: bge-small-en-v1.5,
 * local ONNX inference, zero API calls) if installed and not force-disabled. Never throws --
 * a missing package or a disabled flag both resolve to `null`, and callers fall back to
 * BM25-only retrieval.
 */
export async function getEmbeddingProvider(logger?: ILogger): Promise<EmbeddingProvider | null> {
  if (process.env['KAIROS_MEMORY_EMBEDDINGS'] === 'off') return null
  if (cachedProvider !== undefined) return cachedProvider

  try {
    const fastembed = await import('fastembed')
    const model = await fastembed.FlagEmbedding.init({ model: fastembed.EmbeddingModel.BGESmallENV15 })

    cachedProvider = {
      dimensions: BGE_SMALL_DIMENSIONS,
      modelId: BGE_SMALL_MODEL_ID,
      async embedDocuments(texts: string[]): Promise<number[][]> {
        const results: number[][] = []
        for await (const batch of model.passageEmbed(texts)) {
          for (const vec of batch) results.push(Array.from(vec))
        }
        return results
      },
      async embedQuery(query: string): Promise<number[]> {
        return Array.from(await model.queryEmbed(query))
      },
    }
    return cachedProvider
  } catch (err) {
    logger?.debug('fastembed not available — falling back to BM25-only memory retrieval', { err: String(err) })
    cachedProvider = null
    return null
  }
}

/** Test-only: clears the cached provider so getEmbeddingProvider() re-attempts loading. */
export function resetEmbeddingProviderCache(): void {
  cachedProvider = undefined
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
