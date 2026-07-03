/**
 * Wraps an async function so that concurrent calls made while one invocation is
 * already in flight share that same promise instead of each triggering a
 * redundant call. Once the in-flight call settles, the next call starts fresh.
 */
export function coalesceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return async (): Promise<T> => {
    if (inFlight) return inFlight
    inFlight = fn()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }
}
