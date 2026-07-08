/**
 * Per-prompt regression detection for `scripts/benchmark.ts --compare`. The existing
 * --compare block only diffs aggregate summary numbers (firstTryRate, avgAttempts, ...),
 * which can mask an individual prompt flipping from pass to fail if other prompts improve
 * at the same time. This is a pure function so it can be unit-tested without running the
 * real benchmark (which requires a live Anthropic API call) -- see
 * tests/unit/scripts/benchmark-compare.test.ts.
 */

export interface RegressionCandidate {
  prompt: string
  success: boolean
}

export interface Regression {
  prompt: string
  baselineSuccess: boolean
  currentSuccess: boolean
}

/**
 * Matches results by exact prompt text (benchmark prompts are fixed literal strings in
 * scripts/benchmark.ts, not user input, so exact matching is reliable here). Only reports
 * pass -> fail transitions -- a fail -> pass change is an improvement, not a regression,
 * and prompts absent from one side (e.g. --tier changed between runs) are silently
 * skipped rather than treated as ambiguous regressions.
 */
export function findRegressions(
  baseline: RegressionCandidate[],
  current: RegressionCandidate[],
): Regression[] {
  const baselineByPrompt = new Map(baseline.map(r => [r.prompt, r.success]))
  const regressions: Regression[] = []

  for (const c of current) {
    const baselineSuccess = baselineByPrompt.get(c.prompt)
    if (baselineSuccess === undefined) continue
    if (baselineSuccess && !c.success) {
      regressions.push({ prompt: c.prompt, baselineSuccess, currentSuccess: c.success })
    }
  }

  return regressions
}

export function formatRegressions(regressions: Regression[]): string {
  if (regressions.length === 0) return ''
  const lines = ['', 'REGRESSIONS (passed in baseline, now failing):']
  for (const r of regressions) {
    lines.push(`  ✗ ${r.prompt.slice(0, 90)}${r.prompt.length > 90 ? '…' : ''}`)
  }
  return lines.join('\n')
}
