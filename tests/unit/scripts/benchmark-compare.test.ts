import { describe, it, expect } from 'vitest'
import { findRegressions, formatRegressions } from '../../../scripts/benchmark-compare.js'

describe('findRegressions', () => {
  it('flags a prompt that passed in baseline and fails now', () => {
    const baseline = [{ prompt: 'Send an email at 8am', success: true }]
    const current = [{ prompt: 'Send an email at 8am', success: false }]
    expect(findRegressions(baseline, current)).toEqual([
      { prompt: 'Send an email at 8am', baselineSuccess: true, currentSuccess: false },
    ])
  })

  it('does not flag a prompt that failed in both runs', () => {
    const baseline = [{ prompt: 'A', success: false }]
    const current = [{ prompt: 'A', success: false }]
    expect(findRegressions(baseline, current)).toEqual([])
  })

  it('does not flag an improvement (fail -> pass)', () => {
    const baseline = [{ prompt: 'A', success: false }]
    const current = [{ prompt: 'A', success: true }]
    expect(findRegressions(baseline, current)).toEqual([])
  })

  it('does not flag a prompt present in only one run', () => {
    const baseline = [{ prompt: 'Only in baseline', success: true }]
    const current = [{ prompt: 'Only in current', success: false }]
    expect(findRegressions(baseline, current)).toEqual([])
  })

  it('handles multiple prompts, reporting only the regressed ones', () => {
    const baseline = [
      { prompt: 'A', success: true },
      { prompt: 'B', success: true },
      { prompt: 'C', success: false },
    ]
    const current = [
      { prompt: 'A', success: true },
      { prompt: 'B', success: false },
      { prompt: 'C', success: true },
    ]
    expect(findRegressions(baseline, current)).toEqual([
      { prompt: 'B', baselineSuccess: true, currentSuccess: false },
    ])
  })
})

describe('formatRegressions', () => {
  it('returns an empty string when there are no regressions', () => {
    expect(formatRegressions([])).toBe('')
  })

  it('lists each regression with a truncated prompt', () => {
    const long = 'x'.repeat(120)
    const out = formatRegressions([{ prompt: long, baselineSuccess: true, currentSuccess: false }])
    expect(out).toContain('REGRESSIONS')
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(long.length + 60)
  })
})
