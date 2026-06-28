import { describe, it, expect } from 'vitest'
import { isTransientNetworkError } from '../../../src/utils/retry.js'

describe('isTransientNetworkError', () => {
  it('returns true when the error itself has a transient code', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    expect(isTransientNetworkError(err)).toBe(true)
  })

  it('returns true when code is one level deep in cause chain', () => {
    const cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const err = new Error('fetch failed')
    ;(err as { cause?: unknown }).cause = cause
    expect(isTransientNetworkError(err)).toBe(true)
  })

  // Node.js fetch wraps: ProviderError → TypeError("fetch failed") → SystemError { code }
  it('returns true when code is two levels deep (real Node fetch chain)', () => {
    const sysErr = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const typeErr = new Error('fetch failed')
    ;(typeErr as { cause?: unknown }).cause = sysErr
    const providerErr = new Error('provider failed')
    ;(providerErr as { cause?: unknown }).cause = typeErr
    expect(isTransientNetworkError(providerErr)).toBe(true)
  })

  it('returns true for all transient codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNABORTED']) {
      const sysErr = Object.assign(new Error(code), { code })
      const typeErr = new Error('fetch failed')
      ;(typeErr as { cause?: unknown }).cause = sysErr
      expect(isTransientNetworkError(typeErr)).toBe(true)
    }
  })

  it('returns false for non-transient error codes', () => {
    const err = Object.assign(new Error('bad input'), { code: 'EINVAL' })
    expect(isTransientNetworkError(err)).toBe(false)
  })

  it('returns false when no code exists anywhere in the chain', () => {
    const inner = new Error('no code')
    const outer = new Error('wrapper')
    ;(outer as { cause?: unknown }).cause = inner
    expect(isTransientNetworkError(outer)).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isTransientNetworkError(null)).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
    expect(isTransientNetworkError('string error')).toBe(false)
  })
})
