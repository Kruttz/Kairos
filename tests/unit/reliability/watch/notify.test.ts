import { describe, it, expect, vi, afterEach } from 'vitest'
import { shouldNotify, formatDriftAlert, invokeOnDriftHook, notifyTick } from '../../../../src/reliability/watch/notify.js'
import { buildDriftCheckReport } from '../../../../src/reliability/drift/report.js'
import type { WatchTickResult } from '../../../../src/reliability/watch/loop.js'
import type { ExecutionTrace } from '../../../../src/library/types.js'

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

function makeHealthyResult(): WatchTickResult {
  const report = buildDriftCheckReport({ workflowId: 'wf-1', workflowName: 'Test WF' }, { traces: [makeTrace(), makeTrace()] })
  return { workflowId: 'wf-1', workflowName: 'Test WF', checkedAt: '2026-01-01T00:00:00.000Z', status: 'checked', report, detail: 'x' }
}

function makeDriftingResult(): WatchTickResult {
  const traces = [
    makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '500' }] }),
    makeTrace({ erroredNodes: [] }),
  ]
  const report = buildDriftCheckReport({ workflowId: 'wf-2', workflowName: 'Drifting WF' }, { traces })
  return { workflowId: 'wf-2', workflowName: 'Drifting WF', checkedAt: '2026-01-01T00:00:00.000Z', status: 'checked', report, detail: 'x' }
}

function makeFetchFailedResult(): WatchTickResult {
  return { workflowId: 'wf-3', checkedAt: '2026-01-01T00:00:00.000Z', status: 'fetch_failed', detail: 'nothing to evaluate' }
}

describe('shouldNotify', () => {
  it('is false for a healthy checked result', () => {
    expect(shouldNotify(makeHealthyResult())).toBe(false)
  })

  it('is true for a drifting checked result', () => {
    expect(shouldNotify(makeDriftingResult())).toBe(true)
  })

  it('is false for a fetch_failed result -- insufficient data is never an alert', () => {
    expect(shouldNotify(makeFetchFailedResult())).toBe(false)
  })
})

describe('formatDriftAlert', () => {
  it('names the specific drifting check and includes the diagnosis', () => {
    const text = formatDriftAlert(makeDriftingResult())
    expect(text).toContain('D1')
    expect(text).toContain('Recommended:')
    expect(text).toContain('Drifting WF')
  })
})

describe('invokeOnDriftHook', () => {
  it('invokes the command and reports its exit code', async () => {
    const result = await invokeOnDriftHook('cat > /dev/null; exit 0', makeDriftingResult())
    expect(result.invoked).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('reports a non-zero exit code without throwing', async () => {
    const result = await invokeOnDriftHook('cat > /dev/null; exit 7', makeDriftingResult())
    expect(result.invoked).toBe(true)
    expect(result.exitCode).toBe(7)
  })

  it('pipes the result JSON on stdin', async () => {
    // A command that fails unless it can read the workflowId off stdin -- proves the payload
    // actually arrives, not just that some process ran.
    const result = await invokeOnDriftHook('grep -q "wf-2" && exit 0 || exit 1', makeDriftingResult())
    expect(result.exitCode).toBe(0)
  })

  it('reports a nonexistent command as a non-zero exit, never a throw -- shell:true routes "not found" through exit(127), not the error event', async () => {
    const result = await invokeOnDriftHook('/definitely/does/not/exist/kairos-test-binary', makeDriftingResult())
    expect(result.invoked).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })

  it('times out a hanging command rather than waiting indefinitely', async () => {
    const start = Date.now()
    const result = await invokeOnDriftHook('cat > /dev/null; sleep 30', makeDriftingResult(), 200)
    const elapsed = Date.now() - start
    expect(result.invoked).toBe(false)
    expect(result.error).toContain('timed out')
    expect(elapsed).toBeLessThan(2000)
  }, 3000)
})

describe('notifyTick', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not print or alert for a healthy result', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const outcomes = await notifyTick([makeHealthyResult()])
    expect(logSpy).not.toHaveBeenCalled()
    expect(outcomes[0]!.alerted).toBe(false)
  })

  it('prints an alert for a drifting result even with no hook configured', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const outcomes = await notifyTick([makeDriftingResult()])
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(outcomes[0]!.alerted).toBe(true)
    expect(outcomes[0]!.hook).toBeUndefined()
  })

  it('invokes the shell hook only for drifting results, not healthy ones, in a mixed batch', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const outcomes = await notifyTick([makeHealthyResult(), makeDriftingResult()], { onDriftCommand: 'cat > /dev/null; exit 0' })
    expect(outcomes[0]!.hook).toBeUndefined()
    expect(outcomes[1]!.hook).toBeDefined()
    expect(outcomes[1]!.hook!.invoked).toBe(true)
  })

  it('a hook failure does not throw out of notifyTick -- the outcome just records the non-zero exit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const outcomes = await notifyTick([makeDriftingResult()], { onDriftCommand: '/definitely/does/not/exist/kairos-test-binary' })
    expect(outcomes[0]!.hook!.exitCode).not.toBe(0)
  })
})
