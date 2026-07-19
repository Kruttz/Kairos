import { describe, it, expect } from 'vitest'
import {
  checkD1NewlyErroringNodes,
  checkD2DurationAnomaly,
  checkD3MissingCoreNodes,
  checkD4NewNodes,
  checkD5ErrorRateDrift,
  checkD6CadenceDrift,
  checkD7PerNodeDurationAnomaly,
  checkD8PayloadSchemaDrift,
  checkD9BuildVsLiveDrift,
} from '../../../../src/reliability/drift/checks.js'
import type { ExecutionTrace } from '../../../../src/library/types.js'

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    recordedAt: new Date().toISOString(),
    executionId: 'exec-' + Math.random().toString(36).slice(2),
    status: 'success',
    durationMs: 500,
    executedNodes: ['Trigger', 'Process', 'Send'],
    erroredNodes: [],
    itemCount: 10,
    nodeDurations: {},
    ...overrides,
  }
}

describe('checkD1NewlyErroringNodes', () => {
  it('reports insufficient_data with fewer than 2 traces', () => {
    const finding = checkD1NewlyErroringNodes([makeTrace()])
    expect(finding.status).toBe('insufficient_data')
  })

  it('reports healthy when no new errors appear', () => {
    const traces = [makeTrace({ erroredNodes: [] }), makeTrace({ erroredNodes: [] })]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.status).toBe('healthy')
    expect(finding.evidenceQuality).toBeUndefined()
  })

  it('reports drifting with evidenceQuality "specific" when the error carries a real errorType', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '429' }] }),
      makeTrace({ erroredNodes: [] }),
      makeTrace({ erroredNodes: [] }),
    ]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.status).toBe('drifting')
    expect(finding.evidenceQuality).toBe('specific')
  })

  it('reports drifting with evidenceQuality "generic" when the error has no classification beyond UnknownError', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'Code', errorType: 'UnknownError' }] }),
      makeTrace({ erroredNodes: [] }),
      makeTrace({ erroredNodes: [] }),
    ]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.status).toBe('drifting')
    expect(finding.evidenceQuality).toBe('generic')
  })

  it('is conservative: one generic error among several specific ones makes the whole finding generic', () => {
    const traces = [
      makeTrace({
        erroredNodes: [
          { name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '500' },
          { name: 'Code', errorType: 'UnknownError' },
        ],
      }),
      makeTrace({ erroredNodes: [] }),
      makeTrace({ erroredNodes: [] }),
    ]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.evidenceQuality).toBe('generic')
  })

  it('does not flag a node erroring the same way it has before', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError' }] }),
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError' }] }),
    ]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.status).toBe('healthy')
  })
})

describe('checkD2DurationAnomaly', () => {
  it('reports insufficient_data with fewer than 2 traces', () => {
    const finding = checkD2DurationAnomaly([makeTrace()])
    expect(finding.status).toBe('insufficient_data')
  })

  it('reports not_applicable on trivially fast baselines (noise guard)', () => {
    const traces = [makeTrace({ durationMs: 12 }), makeTrace({ durationMs: 5 }), makeTrace({ durationMs: 5 })]
    const finding = checkD2DurationAnomaly(traces)
    expect(finding.status).toBe('not_applicable')
  })

  it('reports drifting when latest run is more than 2x the historical average', () => {
    const traces = [makeTrace({ durationMs: 5000 }), makeTrace({ durationMs: 1000 }), makeTrace({ durationMs: 1000 })]
    const finding = checkD2DurationAnomaly(traces)
    expect(finding.status).toBe('drifting')
    expect((finding.evidence['ratio'] as number)).toBeGreaterThan(2)
  })

  it('reports healthy under the 2x threshold', () => {
    const traces = [makeTrace({ durationMs: 1400 }), makeTrace({ durationMs: 1000 }), makeTrace({ durationMs: 1000 })]
    const finding = checkD2DurationAnomaly(traces)
    expect(finding.status).toBe('healthy')
  })
})

describe('checkD3MissingCoreNodes', () => {
  it('reports drifting when a consistently-run node is missing from the latest run', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const finding = checkD3MissingCoreNodes(traces)
    expect(finding.status).toBe('drifting')
    expect(finding.evidence['missingCoreNodes']).toEqual(['Process'])
  })

  it('does not flag a conditional branch node that only sometimes ran historically', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'EscalationPath', 'Send'] }),
    ]
    const finding = checkD3MissingCoreNodes(traces)
    expect(finding.status).toBe('healthy')
  })
})

describe('checkD4NewNodes', () => {
  it('reports drifting when the latest run has a node never seen historically', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send', 'NewBranch'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const finding = checkD4NewNodes(traces)
    expect(finding.status).toBe('drifting')
    expect(finding.evidence['newNodes']).toEqual(['NewBranch'])
  })

  it('reports healthy when node set is unchanged', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const finding = checkD4NewNodes(traces)
    expect(finding.status).toBe('healthy')
  })
})

describe('checkD5ErrorRateDrift', () => {
  it('reports insufficient_data with fewer than 6 traces', () => {
    const traces = Array.from({ length: 5 }, () => makeTrace())
    const finding = checkD5ErrorRateDrift(traces)
    expect(finding.status).toBe('insufficient_data')
  })

  it('reports healthy when error rate is stable across windows', () => {
    const traces = Array.from({ length: 8 }, (_, i) => makeTrace({ status: i % 4 === 0 ? 'error' : 'success' }))
    const finding = checkD5ErrorRateDrift(traces)
    expect(finding.status).toBe('healthy')
  })

  it('reports drifting when recent-window error rate is much higher than older-window', () => {
    // recent half (index 0-3, most recent) all error; older half (4-7) all success
    const traces = [
      ...Array.from({ length: 4 }, () => makeTrace({ status: 'error' })),
      ...Array.from({ length: 4 }, () => makeTrace({ status: 'success' })),
    ]
    const finding = checkD5ErrorRateDrift(traces)
    expect(finding.status).toBe('drifting')
    expect(finding.evidence['recentErrorRate']).toBe(1)
    expect(finding.evidence['olderErrorRate']).toBe(0)
  })

  it('has no not_applicable case -- every workflow with enough executions has a computable error rate', () => {
    // Documenting the design decision, not asserting a specific input triggers it (there isn't one).
    const traces = Array.from({ length: 8 }, () => makeTrace())
    const finding = checkD5ErrorRateDrift(traces)
    expect(finding.status).not.toBe('not_applicable')
  })
})

describe('checkD6CadenceDrift', () => {
  const HOUR = 60 * 60 * 1000

  it('reports insufficient_data with fewer than 3 traces', () => {
    const finding = checkD6CadenceDrift([makeTrace(), makeTrace()])
    expect(finding.status).toBe('insufficient_data')
  })

  it('reports not_applicable when historical gaps are too irregular for a meaningful cadence', () => {
    const now = new Date('2026-07-19T12:00:00Z')
    const MIN = 60 * 1000
    // Three back-to-back runs a minute apart, then a long silent stretch before that --
    // coefficient of variation on gaps this lopsided (several near-identical tiny gaps plus
    // one huge one) comfortably clears the irregularity threshold. Verified by direct
    // computation, not just intuition: mean ~45000.75min, stdDev ~77942min, CoV ~1.73.
    const traces = [
      makeTrace({ recordedAt: new Date(now.getTime() - 1 * MIN).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 2 * MIN).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 3 * MIN).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 4 * MIN).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - (4 * MIN + 3000 * HOUR)).toISOString() }),
    ]
    const finding = checkD6CadenceDrift(traces, now)
    expect(finding.status).toBe('not_applicable')
  })

  it('reports healthy when time since latest execution is within normal range of a regular cadence', () => {
    const now = new Date('2026-07-19T12:00:00Z')
    // Executed roughly every hour, most recent 30 min ago
    const traces = [
      makeTrace({ recordedAt: new Date(now.getTime() - 0.5 * HOUR).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 1.5 * HOUR).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 2.5 * HOUR).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 3.5 * HOUR).toISOString() }),
    ]
    const finding = checkD6CadenceDrift(traces, now)
    expect(finding.status).toBe('healthy')
  })

  it('reports drifting (possible silent stop) when time since latest far exceeds the established cadence', () => {
    const now = new Date('2026-07-19T12:00:00Z')
    // Historically ran every hour, but nothing recorded in the last 10 hours
    const traces = [
      makeTrace({ recordedAt: new Date(now.getTime() - 10 * HOUR).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 11 * HOUR).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 12 * HOUR).toISOString() }),
      makeTrace({ recordedAt: new Date(now.getTime() - 13 * HOUR).toISOString() }),
    ]
    const finding = checkD6CadenceDrift(traces, now)
    expect(finding.status).toBe('drifting')
    expect(finding.severity).toBe('critical')
  })
})

describe('checkD7PerNodeDurationAnomaly', () => {
  it('reports insufficient_data with fewer than 2 traces', () => {
    const finding = checkD7PerNodeDurationAnomaly([makeTrace()])
    expect(finding.status).toBe('insufficient_data')
  })

  it('reports not_applicable when no baseline trace has any per-node duration data', () => {
    const traces = [
      makeTrace({ nodeDurations: { 'HTTP Request': 500 } }),
      makeTrace({ nodeDurations: {} }),
      makeTrace({ nodeDurations: {} }),
    ]
    const finding = checkD7PerNodeDurationAnomaly(traces)
    expect(finding.status).toBe('not_applicable')
  })

  it('reports healthy when node durations are within normal range', () => {
    const traces = [
      makeTrace({ nodeDurations: { 'HTTP Request': 550 } }),
      makeTrace({ nodeDurations: { 'HTTP Request': 500 } }),
      makeTrace({ nodeDurations: { 'HTTP Request': 500 } }),
    ]
    const finding = checkD7PerNodeDurationAnomaly(traces)
    expect(finding.status).toBe('healthy')
  })

  it('reports drifting when a specific node is much slower than its own baseline', () => {
    const traces = [
      makeTrace({ nodeDurations: { 'HTTP Request': 2000, 'Send Email': 200 } }),
      makeTrace({ nodeDurations: { 'HTTP Request': 500, 'Send Email': 200 } }),
      makeTrace({ nodeDurations: { 'HTTP Request': 500, 'Send Email': 200 } }),
    ]
    const finding = checkD7PerNodeDurationAnomaly(traces)
    expect(finding.status).toBe('drifting')
    const anomalous = finding.evidence['anomalousNodes'] as Array<{ name: string }>
    expect(anomalous.map(n => n.name)).toEqual(['HTTP Request'])
  })
})

describe('checkD8PayloadSchemaDrift', () => {
  it('reports not_applicable when capture was never enabled (both shapes undefined)', () => {
    const finding = checkD8PayloadSchemaDrift(undefined, undefined)
    expect(finding.status).toBe('not_applicable')
  })

  it('reports healthy when payload shape matches the baseline', () => {
    const shape = { 'body.customerName': 'string', 'body.customerPhone': 'string' }
    const finding = checkD8PayloadSchemaDrift(shape, shape)
    expect(finding.status).toBe('healthy')
  })

  it('reports drifting when a field is missing from the latest payload', () => {
    const baseline = { 'body.customerName': 'string', 'body.customerPhone': 'string' }
    const latest = { 'body.customerName': 'string' }
    const finding = checkD8PayloadSchemaDrift(latest, baseline)
    expect(finding.status).toBe('drifting')
    expect(finding.evidence['missingKeys']).toEqual(['body.customerPhone'])
  })

  it('reports drifting when a field changes type', () => {
    const baseline = { 'body.customerPhone': 'string' }
    const latest = { 'body.customerPhone': 'number' }
    const finding = checkD8PayloadSchemaDrift(latest, baseline)
    expect(finding.status).toBe('drifting')
    expect(finding.evidence['typeChangedKeys']).toEqual([{ key: 'body.customerPhone', from: 'string', to: 'number' }])
  })

  it('does not drift on a purely additive new field', () => {
    const baseline = { 'body.customerName': 'string' }
    const latest = { 'body.customerName': 'string', 'body.newOptionalField': 'string' }
    const finding = checkD8PayloadSchemaDrift(latest, baseline)
    expect(finding.status).toBe('healthy')
    expect(finding.evidence['newKeys']).toEqual(['body.newOptionalField'])
  })
})

describe('checkD9BuildVsLiveDrift', () => {
  it('reports not_applicable when there is no original build hash on record', () => {
    const finding = checkD9BuildVsLiveDrift(undefined, 'abc123')
    expect(finding.status).toBe('not_applicable')
  })

  it('reports healthy when the live hash matches the original build hash', () => {
    const finding = checkD9BuildVsLiveDrift('abc123', 'abc123')
    expect(finding.status).toBe('healthy')
  })

  it('reports drifting when the live hash differs from the original build hash', () => {
    const finding = checkD9BuildVsLiveDrift('abc123', 'def456')
    expect(finding.status).toBe('drifting')
    expect(finding.severity).toBe('warning')
    expect(finding.evidence).toEqual({ originalBuildHash: 'abc123', liveExportHash: 'def456' })
  })
})
