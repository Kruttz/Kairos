import { describe, it, expect } from 'vitest'
import {
  parseExecutionTrace,
  computeRuntimeReliability,
  mergeTraces,
  getSlowestNodes,
} from '../../../src/telemetry/execution-tracer.js'
import type { ExecutionDetail } from '../../../src/types/result.js'
import type { ExecutionTrace } from '../../../src/library/types.js'

function makeExecution(overrides?: Partial<ExecutionDetail>): ExecutionDetail {
  return {
    id: 'exec-001',
    workflowId: 'wf-001',
    status: 'success',
    startedAt: '2026-07-01T10:00:00.000Z',
    stoppedAt: '2026-07-01T10:00:05.000Z',
    mode: 'manual',
    ...overrides,
  }
}

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    recordedAt: new Date().toISOString(),
    executionId: 'exec-' + Math.random().toString(36).slice(2),
    status: 'success',
    durationMs: 5000,
    executedNodes: ['Trigger', 'Process', 'Send'],
    erroredNodes: [],
    itemCount: 10,
    nodeDurations: {},
    ...overrides,
  }
}

describe('parseExecutionTrace', () => {
  it('captures execution ID and status', () => {
    const execution = makeExecution({ id: 'exec-42', status: 'error' })
    const trace = parseExecutionTrace(execution)
    expect(trace.executionId).toBe('exec-42')
    expect(trace.status).toBe('error')
  })

  it('computes duration from startedAt/stoppedAt', () => {
    const execution = makeExecution({
      startedAt: '2026-07-01T10:00:00.000Z',
      stoppedAt: '2026-07-01T10:00:05.000Z',
    })
    const trace = parseExecutionTrace(execution)
    expect(trace.durationMs).toBe(5000)
  })

  it('returns null duration when stoppedAt is missing', () => {
    const execution = makeExecution({ stoppedAt: undefined })
    const trace = parseExecutionTrace(execution)
    expect(trace.durationMs).toBeNull()
  })

  it('extracts executed node names from runData', () => {
    const execution = makeExecution({
      data: {
        resultData: {
          runData: {
            'Trigger': [{ data: { main: [[{ json: {} }]] } }],
            'Process': [{ data: { main: [[{ json: {} }]] } }],
          },
        },
      },
    })
    const trace = parseExecutionTrace(execution)
    expect(trace.executedNodes).toContain('Trigger')
    expect(trace.executedNodes).toContain('Process')
  })

  it('captures errored nodes with their error type (not message)', () => {
    const execution = makeExecution({
      data: {
        resultData: {
          runData: {
            'HTTP Request': [{
              error: { name: 'NodeApiError', message: 'Sensitive error message with user data' },
            }],
          },
        },
      },
    })
    const trace = parseExecutionTrace(execution)
    expect(trace.erroredNodes).toHaveLength(1)
    expect(trace.erroredNodes[0]!.name).toBe('HTTP Request')
    expect(trace.erroredNodes[0]!.errorType).toBe('NodeApiError')
    // Privacy: message must NOT be stored
    expect(JSON.stringify(trace)).not.toContain('Sensitive error message')
  })

  it('counts items processed (privacy-safe count only)', () => {
    const execution = makeExecution({
      data: {
        resultData: {
          runData: {
            'Process': [{
              data: {
                main: [
                  [{ json: { name: 'Alice' } }, { json: { name: 'Bob' } }],
                ],
              },
            }],
          },
        },
      },
    })
    const trace = parseExecutionTrace(execution)
    expect(trace.itemCount).toBe(2)
    // Privacy: actual values must NOT be stored
    expect(JSON.stringify(trace)).not.toContain('Alice')
    expect(JSON.stringify(trace)).not.toContain('Bob')
  })

  it('handles missing data gracefully', () => {
    const execution = makeExecution({ data: undefined })
    const trace = parseExecutionTrace(execution)
    expect(trace.executedNodes).toEqual([])
    expect(trace.erroredNodes).toEqual([])
    expect(trace.itemCount).toBe(0)
    expect(trace.nodeDurations).toEqual({})
  })

  it('extracts per-node execution time from executionTime', () => {
    const execution = makeExecution({
      data: {
        resultData: {
          runData: {
            'HTTP Request': [{ executionTime: 1250, data: { main: [[{ json: {} }]] } }],
            'Fast Node': [{ executionTime: 5, data: { main: [[{ json: {} }]] } }],
          },
        },
      },
    })
    const trace = parseExecutionTrace(execution)
    expect(trace.nodeDurations['HTTP Request']).toBe(1250)
    expect(trace.nodeDurations['Fast Node']).toBe(5)
  })

  it('sums execution time across multiple runs of a looped node', () => {
    const execution = makeExecution({
      data: {
        resultData: {
          runData: {
            'Loop Body': [
              { executionTime: 100, data: { main: [[{ json: {} }]] } },
              { executionTime: 150, data: { main: [[{ json: {} }]] } },
              { executionTime: 120, data: { main: [[{ json: {} }]] } },
            ],
          },
        },
      },
    })
    const trace = parseExecutionTrace(execution)
    expect(trace.nodeDurations['Loop Body']).toBe(370)
  })
})

describe('computeRuntimeReliability', () => {
  it('returns neutral 0.5 for empty traces', () => {
    expect(computeRuntimeReliability([])).toBe(0.5)
  })

  it('returns high score for all-success traces', () => {
    const traces = [makeTrace({ status: 'success' }), makeTrace({ status: 'success' })]
    const score = computeRuntimeReliability(traces)
    expect(score).toBeGreaterThan(0.7)
  })

  it('returns low score for all-error traces', () => {
    const traces = [makeTrace({ status: 'error' }), makeTrace({ status: 'error' })]
    const score = computeRuntimeReliability(traces)
    expect(score).toBeLessThan(0.3)
  })

  it('returns value between 0 and 1', () => {
    const traces = [
      makeTrace({ status: 'success' }),
      makeTrace({ status: 'error' }),
      makeTrace({ status: 'success' }),
    ]
    const score = computeRuntimeReliability(traces)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })
})

describe('mergeTraces', () => {
  it('adds a new trace to existing list', () => {
    const existing = [makeTrace({ executionId: 'exec-1' })]
    const newTrace = makeTrace({ executionId: 'exec-2' })
    const merged = mergeTraces(existing, newTrace)
    expect(merged.some(t => t.executionId === 'exec-1')).toBe(true)
    expect(merged.some(t => t.executionId === 'exec-2')).toBe(true)
  })

  it('deduplicates by executionId', () => {
    const existing = [makeTrace({ executionId: 'exec-1' })]
    const duplicate = makeTrace({ executionId: 'exec-1' })
    const merged = mergeTraces(existing, duplicate)
    expect(merged.filter(t => t.executionId === 'exec-1').length).toBe(1)
  })

  it('caps at 50 traces, keeping most recent', () => {
    // Cap raised 10 -> 50 (reliability-suite-plan.md Phase 1 6.1) so drift checks needing a
    // wider window (D5 windowed error-rate, D6 cadence) have enough history to be meaningful.
    const existing = Array.from({ length: 50 }, (_, i) => makeTrace({
      executionId: `exec-${i}`,
      recordedAt: new Date(Date.now() - (50 - i) * 1000).toISOString(),
    }))
    const newest = makeTrace({
      executionId: 'exec-newest',
      recordedAt: new Date().toISOString(),
    })
    const merged = mergeTraces(existing, newest)
    expect(merged.length).toBe(50)
    expect(merged.some(t => t.executionId === 'exec-newest')).toBe(true)
    // Oldest should be evicted
    expect(merged.some(t => t.executionId === 'exec-0')).toBe(false)
  })
})

describe('getSlowestNodes', () => {
  it('returns the top N nodes sorted descending by duration', () => {
    const result = getSlowestNodes({ a: 100, b: 500, c: 300 }, 2)
    expect(result).toEqual([{ name: 'b', ms: 500 }, { name: 'c', ms: 300 }])
  })

  it('returns an empty array for an empty map', () => {
    expect(getSlowestNodes({})).toEqual([])
  })

  it('returns all entries when n exceeds the number available', () => {
    const result = getSlowestNodes({ a: 10, b: 20 }, 10)
    expect(result).toHaveLength(2)
  })

  it('defaults to top 3 when n is not provided', () => {
    const result = getSlowestNodes({ a: 1, b: 2, c: 3, d: 4 })
    expect(result).toHaveLength(3)
    expect(result.map(r => r.name)).toEqual(['d', 'c', 'b'])
  })

  it('handles ties stably (does not throw, includes both)', () => {
    const result = getSlowestNodes({ a: 100, b: 100 }, 2)
    expect(result.map(r => r.ms)).toEqual([100, 100])
  })
})
