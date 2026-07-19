import { describe, it, expect } from 'vitest'
import { buildDriftCheckReport, buildDriftBaselineReport, formatDriftBaselineReport, type RunAllChecksInputs } from '../../../../src/reliability/drift/report.js'
import type { ExecutionTrace } from '../../../../src/library/types.js'

const CONTEXT = { workflowId: 'wf-1', workflowName: 'Test Workflow' }

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    recordedAt: new Date().toISOString(),
    executionId: 'exec-' + Math.random().toString(36).slice(2),
    status: 'success',
    durationMs: 500,
    executedNodes: ['Trigger', 'Process'],
    erroredNodes: [],
    itemCount: 5,
    nodeDurations: {},
    ...overrides,
  }
}

describe('buildDriftCheckReport', () => {
  it('verdict is HEALTHY when no check is drifting', () => {
    const inputs: RunAllChecksInputs = { traces: [makeTrace(), makeTrace()] }
    const report = buildDriftCheckReport(CONTEXT, inputs)
    expect(report.verdict).toBe('HEALTHY')
    expect(report.diagnoses).toHaveLength(0)
  })

  it('verdict is DRIFTING when at least one check fires, with a matching diagnosis', () => {
    const inputs: RunAllChecksInputs = {
      traces: [
        makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '500' }] }),
        makeTrace({ erroredNodes: [] }),
      ],
    }
    const report = buildDriftCheckReport(CONTEXT, inputs)
    expect(report.verdict).toBe('DRIFTING')
    expect(report.diagnoses.some(d => d.checkId === 'D1')).toBe(true)
  })

  it('verdict stays HEALTHY when every finding is insufficient_data or not_applicable -- never conflated with drifting', () => {
    // A single trace: every trace-based check reports insufficient_data; D8/D9 report
    // not_applicable (no capture, no build hash supplied). None of that is "drifting".
    const inputs: RunAllChecksInputs = { traces: [makeTrace()] }
    const report = buildDriftCheckReport(CONTEXT, inputs)
    expect(report.verdict).toBe('HEALTHY')
    expect(report.findings.every(f => f.status !== 'drifting')).toBe(true)
  })

  it('all 9 checks run, matching D1-D9', () => {
    const inputs: RunAllChecksInputs = { traces: [makeTrace(), makeTrace()] }
    const report = buildDriftCheckReport(CONTEXT, inputs)
    expect(report.findings.map(f => f.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'])
  })
})

describe('buildDriftBaselineReport', () => {
  it('splits findings into captured vs skipped, never silently omitting the skipped half', () => {
    // 2 traces: enough for D1-D4/D7 (need 2), not enough for D5/D6 (need 6/3 -- wait D6 needs 3).
    const inputs: RunAllChecksInputs = { traces: [makeTrace(), makeTrace()] }
    const report = buildDriftBaselineReport(CONTEXT, inputs)
    expect(report.captured.length + report.skipped.length).toBe(9)
    // D8 (no capture) and D9 (no build hash) are always skipped right now -- the honest,
    // normal current state per the plan.
    expect(report.skipped.some(s => s.id === 'D8')).toBe(true)
    expect(report.skipped.some(s => s.id === 'D9')).toBe(true)
    // Every skipped entry carries a real, non-empty reason -- never blank.
    for (const s of report.skipped) expect(s.reason.length).toBeGreaterThan(0)
  })

  it('reports trace count and date range', () => {
    const older = makeTrace({ recordedAt: '2026-01-01T00:00:00.000Z' })
    const newer = makeTrace({ recordedAt: '2026-06-01T00:00:00.000Z' })
    const inputs: RunAllChecksInputs = { traces: [newer, older] }
    const report = buildDriftBaselineReport(CONTEXT, inputs)
    expect(report.traceCount).toBe(2)
    expect(report.oldestTraceAt).toBe('2026-01-01T00:00:00.000Z')
    expect(report.newestTraceAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('formats without throwing and mentions both captured and skipped sections', () => {
    const inputs: RunAllChecksInputs = { traces: [makeTrace(), makeTrace()] }
    const report = buildDriftBaselineReport(CONTEXT, inputs)
    const text = formatDriftBaselineReport(report)
    expect(text).toContain('Captured (')
    expect(text).toContain('Skipped (')
  })
})
