// ECONNRESET/ETIMEDOUT/ECONNREFUSED mean the request never completed — safe to retry.
// Walks the .cause chain up to 4 levels because Node's fetch wraps errors:
// ProviderError → TypeError("fetch failed") → SystemError { code: 'ECONNRESET' }
export function isTransientNetworkError(err: unknown): boolean {
  const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNABORTED'])
  let current: unknown = err
  for (let i = 0; i < 4; i++) {
    if (current === null || typeof current !== 'object') break
    const code = (current as { code?: string }).code
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  delayMs: number,
  shouldRetry?: (err: unknown) => boolean,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const jitter = Math.random() * delayMs * 0.5
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1) + jitter))
    }
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (shouldRetry && !shouldRetry(err)) throw err
    }
  }
  throw lastError
}

export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}
