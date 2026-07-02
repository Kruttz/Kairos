import { describe, it, expect } from 'vitest'
import {
  parseExecutionTrace,
  computeRuntimeReliability,
  mergeTraces,
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

  it('caps at 10 traces, keeping most recent', () => {
    const existing = Array.from({ length: 10 }, (_, i) => makeTrace({
      executionId: `exec-${i}`,
      recordedAt: new Date(Date.now() - (10 - i) * 1000).toISOString(),
    }))
    const newest = makeTrace({
      executionId: 'exec-newest',
      recordedAt: new Date().toISOString(),
    })
    const merged = mergeTraces(existing, newest)
    expect(merged.length).toBe(10)
    expect(merged.some(t => t.executionId === 'exec-newest')).toBe(true)
    // Oldest should be evicted
    expect(merged.some(t => t.executionId === 'exec-0')).toBe(false)
  })
})
