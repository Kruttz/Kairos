import { describe, it, expect } from 'vitest'
import { detectExecutionDrift } from '../../../src/telemetry/execution-drift.js'
import type { ExecutionTrace } from '../../../src/library/types.js'

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

describe('detectExecutionDrift', () => {
  it('reports insufficient data with fewer than 2 traces', () => {
    const report = detectExecutionDrift([makeTrace()])
    expect(report.sufficientData).toBe(false)
    expect(report.hasDrift).toBe(false)
  })

  it('reports insufficient data with zero traces', () => {
    const report = detectExecutionDrift([])
    expect(report.sufficientData).toBe(false)
  })

  it('reports no drift when the latest run matches historical behavior', () => {
    const traces = [
      makeTrace({ durationMs: 510 }),
      makeTrace({ durationMs: 490 }),
      makeTrace({ durationMs: 500 }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.sufficientData).toBe(true)
    expect(report.hasDrift).toBe(false)
  })

  it('flags a node erroring now that never errored historically', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError' }] }),
      makeTrace({ erroredNodes: [] }),
      makeTrace({ erroredNodes: [] }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.hasDrift).toBe(true)
    expect(report.newlyErroringNodes).toEqual(['HTTP Request'])
  })

  it('does not flag a node erroring the same way it has before', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError' }] }),
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError' }] }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.newlyErroringNodes).toEqual([])
    expect(report.hasDrift).toBe(false)
  })

  it('flags a duration anomaly when latest run is more than 2x the historical average', () => {
    const traces = [
      makeTrace({ durationMs: 5000 }),
      makeTrace({ durationMs: 1000 }),
      makeTrace({ durationMs: 1000 }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.hasDrift).toBe(true)
    expect(report.durationAnomaly).not.toBeNull()
    expect(report.durationAnomaly!.ratio).toBeGreaterThan(2)
  })

  it('does not flag a modest duration increase under the 2x threshold', () => {
    const traces = [
      makeTrace({ durationMs: 1400 }),
      makeTrace({ durationMs: 1000 }),
      makeTrace({ durationMs: 1000 }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.durationAnomaly).toBeNull()
  })

  it('ignores duration ratio noise on trivially fast baselines', () => {
    const traces = [
      makeTrace({ durationMs: 12 }),
      makeTrace({ durationMs: 5 }),
      makeTrace({ durationMs: 5 }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.durationAnomaly).toBeNull()
  })

  it('flags a core node missing from the latest run', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Send'] }), // Process is missing
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.hasDrift).toBe(true)
    expect(report.missingCoreNodes).toEqual(['Process'])
  })

  it('does not flag a conditional branch node that only sometimes ran historically', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'EscalationPath', 'Send'] }), // ran only once before
    ]
    const report = detectExecutionDrift(traces)
    // EscalationPath never ran in every historical trace, so it's not "core" -- absence isn't drift
    expect(report.missingCoreNodes).toEqual([])
  })

  it('flags a node in the latest run that never appeared historically', () => {
    const traces = [
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send', 'NewBranch'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
      makeTrace({ executedNodes: ['Trigger', 'Process', 'Send'] }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.hasDrift).toBe(true)
    expect(report.newNodes).toEqual(['NewBranch'])
  })

  it('uses only the latest trace and the rest as baseline, regardless of array order semantics', () => {
    // traces[0] is always "latest" per mergeTraces' descending sort contract
    const traces = [
      makeTrace({ executionId: 'latest', durationMs: 500 }),
      makeTrace({ executionId: 'older-1', durationMs: 500 }),
      makeTrace({ executionId: 'older-2', durationMs: 500 }),
    ]
    const report = detectExecutionDrift(traces)
    expect(report.hasDrift).toBe(false)
  })
})
