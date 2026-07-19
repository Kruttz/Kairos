import { describe, it, expect } from 'vitest'
import { buildPatternShareReport } from '../../../../src/reliability/community/whitelist.js'
import type { Pattern } from '../../../../src/telemetry/pattern-analyzer.js'

function makePattern(overrides: Partial<Pattern> = {}): Pattern {
  return {
    rule: 17,
    failureCount: 12,
    confidence: 0.82,
    compositeScore: 0.71,
    scoringFactors: { rawConfidence: 0.82, impact: 1, recency: 0.9, stickinessBoost: 0.1 },
    state: 'confirmed',
    trend: 'stable',
    pipelineStage: 'credential_injection',
    exampleMessages: ['Node "Send Customer SMS" credential "twilioApi" must have non-empty string id and name fields'],
    mitigation: 'Provide a real credential id/name pair',
    workflowTypeBreakdown: { messaging: 9, api: 3 },
    ...overrides,
  }
}

describe('buildPatternShareReport', () => {
  it('includes only confirmed patterns', () => {
    const report = buildPatternShareReport([
      makePattern({ rule: 1, state: 'confirmed' }),
      makePattern({ rule: 2, state: 'draft' }),
      makePattern({ rule: 3, state: 'pending_review' }),
      makePattern({ rule: 4, state: 'resolved' }),
    ])
    expect(report.patterns.map(p => p.rule)).toEqual([1])
  })

  it('carries only rule, pipelineStage, failureCount, confidence, kind -- nothing else', () => {
    const report = buildPatternShareReport([makePattern({ rule: 42, failureCount: 7, confidence: 0.55, pipelineStage: 'expression_syntax' })])
    expect(report.patterns).toEqual([
      { kind: 'validator-rule', rule: 42, pipelineStage: 'expression_syntax', failureCount: 7, confidence: 0.55 },
    ])
  })

  it('never includes exampleMessages content anywhere in the serialized report', () => {
    const report = buildPatternShareReport([makePattern({ exampleMessages: ['Node "Empire Homecare Referral Intake" is missing a type'] })])
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('Empire Homecare')
    expect(serialized).not.toContain('exampleMessages')
  })

  it('never includes workflowTypeBreakdown or mitigation text', () => {
    const report = buildPatternShareReport([makePattern()])
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('workflowTypeBreakdown')
    expect(serialized).not.toContain('mitigation')
    expect(serialized).not.toContain('messaging')
  })

  it('report envelope carries kairosVersion and generatedAt, not identifying data', () => {
    const report = buildPatternShareReport([])
    expect(typeof report.kairosVersion).toBe('string')
    expect(report.kairosVersion.length).toBeGreaterThan(0)
    expect(() => new Date(report.generatedAt).toISOString()).not.toThrow()
  })

  it('returns an empty patterns array, not an error, when nothing is confirmed', () => {
    const report = buildPatternShareReport([makePattern({ state: 'draft' })])
    expect(report.patterns).toEqual([])
  })

  it('handles an empty pattern list', () => {
    const report = buildPatternShareReport([])
    expect(report.patterns).toEqual([])
  })

  it('serializes multiple confirmed patterns independently, preserving per-rule fields', () => {
    const report = buildPatternShareReport([
      makePattern({ rule: 5, failureCount: 3, confidence: 0.4, pipelineStage: 'node_generation' }),
      makePattern({ rule: 9, failureCount: 20, confidence: 0.95, pipelineStage: 'connection_wiring' }),
    ])
    expect(report.patterns).toEqual([
      { kind: 'validator-rule', rule: 5, pipelineStage: 'node_generation', failureCount: 3, confidence: 0.4 },
      { kind: 'validator-rule', rule: 9, pipelineStage: 'connection_wiring', failureCount: 20, confidence: 0.95 },
    ])
  })
})
