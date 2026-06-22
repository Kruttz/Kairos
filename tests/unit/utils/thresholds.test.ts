import { describe, it, expect } from 'vitest'
import { scoreToMode, DIRECT_THRESHOLD, REFERENCE_THRESHOLD } from '../../../src/utils/thresholds.js'

describe('scoreToMode', () => {
  it('returns direct for scores >= 0.92', () => {
    expect(scoreToMode(0.92)).toBe('direct')
    expect(scoreToMode(1.0)).toBe('direct')
    expect(scoreToMode(0.95)).toBe('direct')
  })

  it('returns reference for scores >= 0.72 and < 0.92', () => {
    expect(scoreToMode(0.72)).toBe('reference')
    expect(scoreToMode(0.85)).toBe('reference')
    expect(scoreToMode(0.919)).toBe('reference')
  })

  it('returns scratch for scores < 0.72', () => {
    expect(scoreToMode(0.71)).toBe('scratch')
    expect(scoreToMode(0.5)).toBe('scratch')
    expect(scoreToMode(0)).toBe('scratch')
  })

  it('exports threshold constants', () => {
    expect(DIRECT_THRESHOLD).toBe(0.92)
    expect(REFERENCE_THRESHOLD).toBe(0.72)
  })
})
