import { describe, it, expect } from 'vitest'
import { coalesceAsync } from '../../../src/utils/coalesce-async.js'

describe('coalesceAsync', () => {
  it('shares one in-flight call across concurrent invocations', async () => {
    let calls = 0
    let resolveFn: (v: number) => void
    const pending = new Promise<number>((r) => { resolveFn = r })
    const fn = coalesceAsync(() => {
      calls++
      return pending
    })

    const a = fn()
    const b = fn()
    const c = fn()

    resolveFn!(42)
    const results = await Promise.all([a, b, c])

    expect(calls).toBe(1)
    expect(results).toEqual([42, 42, 42])
  })

  it('starts a fresh call after the previous one settles', async () => {
    let calls = 0
    const fn = coalesceAsync(async () => {
      calls++
      return calls
    })

    const first = await fn()
    const second = await fn()

    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(calls).toBe(2)
  })

  it('starts a fresh call after the previous one rejects', async () => {
    let calls = 0
    const fn = coalesceAsync(async () => {
      calls++
      if (calls === 1) throw new Error('first call fails')
      return 'ok'
    })

    await expect(fn()).rejects.toThrow('first call fails')
    await expect(fn()).resolves.toBe('ok')
    expect(calls).toBe(2)
  })

  it('shares a single failure across concurrent invocations', async () => {
    let calls = 0
    let rejectFn: (e: Error) => void
    const pending = new Promise<string>((_, r) => { rejectFn = r })
    const fn = coalesceAsync(() => {
      calls++
      return pending
    })

    const a = fn()
    const b = fn()
    rejectFn!(new Error('boom'))

    const [aResult, bResult] = await Promise.allSettled([a, b])
    expect(aResult.status).toBe('rejected')
    expect(bResult.status).toBe('rejected')
    expect(calls).toBe(1)
  })
})
