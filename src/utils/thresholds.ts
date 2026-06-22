export const DIRECT_THRESHOLD = 0.92
export const REFERENCE_THRESHOLD = 0.72

export function scoreToMode(score: number): 'direct' | 'reference' | 'scratch' {
  if (score >= DIRECT_THRESHOLD) return 'direct'
  if (score >= REFERENCE_THRESHOLD) return 'reference'
  return 'scratch'
}
