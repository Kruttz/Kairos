import { describe, it, expect } from 'vitest'

// Verifies the guard installed by tests/setup/no-network-guard.ts actually fires --
// a passing test suite alone doesn't prove the guard works, since no existing test happens
// to reach real fetch (they all mock at the class-method boundary above it). This test
// deliberately calls fetch to confirm the guard intercepts it rather than trusting the
// setup file was written correctly.
describe('no-network guard', () => {
  it('throws instead of making a real network call', async () => {
    await expect(fetch('https://example.com')).rejects.toThrow('Real network call attempted during tests')
  })
})
