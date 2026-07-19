import { describe, it, expect } from 'vitest'
import {
  checkD1NewlyErroringNodes,
  checkD2DurationAnomaly,
  checkD3MissingCoreNodes,
  checkD4NewNodes,
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
  it('reports insufficient data with fewer than 2 traces', () => {
    const finding = checkD1NewlyErroringNodes([makeTrace()])
    expect(finding.sufficientData).toBe(false)
    expect(finding.fired).toBe(false)
  })

  it('does not fire when no new errors appear', () => {
    const traces = [makeTrace({ erroredNodes: [] }), makeTrace({ erroredNodes: [] })]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.fired).toBe(false)
    expect(finding.evidenceQuality).toBeUndefined()
  })

  it('fires with evidenceQuality "specific" when the error carries a real errorType', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '429' }] }),
      makeTrace({ erroredNodes: [] }),
      makeTrace({ erroredNodes: [] }),
    ]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.fired).toBe(true)
    expect(finding.evidenceQuality).toBe('specific')
  })

  it('fires with evidenceQuality "generic" when the error has no classification beyond UnknownError', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'Code', errorType: 'UnknownError' }] }),
      makeTrace({ erroredNodes: [] }),
      makeTrace({ erroredNodes: [] }),
    ]
    const finding = checkD1NewlyErroringNodes(traces)
    expect(finding.fired).toBe(true)
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
    expect(finding.fired).toBe(false)
  })
})

describe('checkD2DurationAnomaly', () => {
  it('reports insufficient data with fewer than 2 traces', () => {
    const finding = checkD2DurationAnomaly([makeTrace()])
    expect(finding.sufficientData).toBe(false)
  })

  it('fires when latest run is more than 2x the historical average', () => {
    const traces = [makeTrace({ durationMs: 5000 }), makeTrace({ durationMs: 1000 }), makeTrace({ durationMs: 1000 })]
    const finding = checkD2DurationAnomaly(traces)
    expect(finding.fired).toBe(true)
    expect((finding.evidence['ratio'] as number)).toBeGreaterThan(2)
  })

  it('does not fire under the 2x threshold', () => {
    const traces = [makeTrace({ durationMs: 1400 }), makeTrace({ durationMs: 1000 }), makeTrace({ durationMs: 1000 })]
    const finding = checkD2DurationAnomaly(traces)
    expect(finding.fired).toBe(false)
  })

  it('does not fire on trivially fast baselines (noise guard)', () => {
    const traces = [makeTrace({ durationMs: 12 }), makeTrace({ durationMs: 5 }), makeTrace({ durationMs: 5 })]
    const finding = checkD2DurationAnomaly(traces)
    expect(finding.fired).toBe(false)
  })
})

describe('checkD3MissingCoreNodes', () => {
  it('fires when a consistently-run node is missing from the latest run', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const finding = checkD3MissingCoreNodes(traces)
    expect(finding.fired).toBe(true)
    expect(finding.evidence['missingCoreNodes']).toEqual(['Process'])
  })

  it('does not flag a conditional branch node that only sometimes ran historically', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'EscalationPath', 'Send'] }),
    ]
    const finding = checkD3MissingCoreNodes(traces)
    expect(finding.fired).toBe(false)
  })
})

describe('checkD4NewNodes', () => {
  it('fires when the latest run has a node never seen historically', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send', 'NewBranch'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const finding = checkD4NewNodes(traces)
    expect(finding.fired).toBe(true)
    expect(finding.evidence['newNodes']).toEqual(['NewBranch'])
  })

  it('does not fire when node set is unchanged', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const finding = checkD4NewNodes(traces)
    expect(finding.fired).toBe(false)
  })
})

describe('checkD9BuildVsLiveDrift', () => {
  it('reports insufficient data when there is no original build hash on record', () => {
    const finding = checkD9BuildVsLiveDrift(undefined, 'abc123')
    expect(finding.sufficientData).toBe(false)
    expect(finding.fired).toBe(false)
  })

  it('does not fire when the live hash matches the original build hash', () => {
    const finding = checkD9BuildVsLiveDrift('abc123', 'abc123')
    expect(finding.fired).toBe(false)
  })

  it('fires when the live hash differs from the original build hash', () => {
    const finding = checkD9BuildVsLiveDrift('abc123', 'def456')
    expect(finding.fired).toBe(true)
    expect(finding.severity).toBe('warning')
    expect(finding.evidence).toEqual({ originalBuildHash: 'abc123', liveExportHash: 'def456' })
  })
})
