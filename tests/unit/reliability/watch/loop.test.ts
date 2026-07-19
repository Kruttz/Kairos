import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTickResult, runWatchTick, formatWatchTickForHumans, type WatchTarget, type WatchTraceRecorder } from '../../../../src/reliability/watch/loop.js'
import { getReliabilityAuditTrail } from '../../../../src/reliability/watch/audit.js'
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

function makeTarget(overrides: Partial<WatchTarget> = {}): WatchTarget {
  return {
    libraryId: 'lib-1',
    n8nWorkflowId: 'wf-1',
    workflowName: 'Test Workflow',
    existingTraces: [],
    ...overrides,
  }
}

describe('buildTickResult', () => {
  it('is fetch_failed when there is no fresh trace and no existing history -- nothing to evaluate', () => {
    const result = buildTickResult(makeTarget({ existingTraces: [] }), null, '2026-01-01T00:00:00.000Z')
    expect(result.status).toBe('fetch_failed')
    expect(result.report).toBeUndefined()
  })

  it('is checked (not fetch_failed) when there is no fresh trace but existing history exists -- the normal steady state', () => {
    const result = buildTickResult(makeTarget({ existingTraces: [makeTrace(), makeTrace()] }), null, '2026-01-01T00:00:00.000Z')
    expect(result.status).toBe('checked')
    expect(result.report).toBeDefined()
    expect(result.report!.traceCount).toBe(2)
  })

  it('merges a fresh trace into existing history before checking', () => {
    const existing = [makeTrace({ executionId: 'exec-old' })]
    const fresh = makeTrace({ executionId: 'exec-new' })
    const result = buildTickResult(makeTarget({ existingTraces: existing }), fresh, '2026-01-01T00:00:00.000Z')
    expect(result.status).toBe('checked')
    expect(result.report!.traceCount).toBe(2)
  })

  it('reports HEALTHY verdict honestly when nothing is drifting', () => {
    const result = buildTickResult(makeTarget({ existingTraces: [makeTrace(), makeTrace()] }), null, '2026-01-01T00:00:00.000Z')
    expect(result.report!.verdict).toBe('HEALTHY')
  })

  it('reports DRIFTING verdict when a real check fires, with the diagnosis attached', () => {
    const traces = [
      makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '500' }] }),
      makeTrace({ erroredNodes: [] }),
    ]
    const result = buildTickResult(makeTarget({ existingTraces: traces }), null, '2026-01-01T00:00:00.000Z')
    expect(result.report!.verdict).toBe('DRIFTING')
    expect(result.report!.diagnoses.some(d => d.checkId === 'D1')).toBe(true)
  })

  it('never treats insufficient_data or not_applicable findings as the reason for a fetch_failed status', () => {
    // Two traces is enough for buildTickResult to proceed to 'checked' even though most
    // individual checks (which need more history) will report insufficient_data internally --
    // that must never surface as this target's own top-level status.
    const result = buildTickResult(makeTarget({ existingTraces: [makeTrace()] }), null, '2026-01-01T00:00:00.000Z')
    expect(result.status).toBe('checked')
    expect(result.report!.findings.some(f => f.status === 'insufficient_data')).toBe(true)
  })

  it('carries the workflow name through when present, omits it when absent', () => {
    const withName = buildTickResult(makeTarget({ workflowName: 'Named' }), null, '2026-01-01T00:00:00.000Z')
    expect(withName.workflowName).toBe('Named')

    const noName = makeTarget()
    delete noName.workflowName
    const withoutName = buildTickResult(noName, null, '2026-01-01T00:00:00.000Z')
    expect(withoutName.workflowName).toBeUndefined()
  })
})

let tmpDir: string | undefined
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

describe('runWatchTick', () => {
  it('records a fresh trace back onto the library entry when the fetch finds one', async () => {
    const recorded: Array<{ libraryId: string; trace: ExecutionTrace }> = []
    const lib: WatchTraceRecorder = { recordTrace: async (libraryId, trace) => { recorded.push({ libraryId, trace }) } }
    const fresh = makeTrace({ executionId: 'exec-fresh' })
    const fetchTrace = async () => fresh

    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-loop-test-'))
    const auditPath = join(tmpDir, 'reliability-audit.jsonl')

    await runWatchTick(lib, [makeTarget()], 'https://n8n.example.com', 'fake-key', auditPath, fetchTrace)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.trace.executionId).toBe('exec-fresh')
  })

  it('does not call recordTrace when the fetch finds nothing new', async () => {
    const recorded: unknown[] = []
    const lib: WatchTraceRecorder = { recordTrace: async () => { recorded.push(true) } }
    const fetchTrace = async () => null

    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-loop-test-'))
    const auditPath = join(tmpDir, 'reliability-audit.jsonl')

    await runWatchTick(lib, [makeTarget({ existingTraces: [makeTrace()] })], 'https://n8n.example.com', 'fake-key', auditPath, fetchTrace)
    expect(recorded).toHaveLength(0)
  })

  it('audits every target every tick, regardless of verdict', async () => {
    const lib: WatchTraceRecorder = { recordTrace: async () => {} }
    const fetchTrace = async () => null

    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-loop-test-'))
    const auditPath = join(tmpDir, 'reliability-audit.jsonl')

    const healthyTarget = makeTarget({ n8nWorkflowId: 'wf-healthy', existingTraces: [makeTrace(), makeTrace()] })
    const driftingTarget = makeTarget({
      n8nWorkflowId: 'wf-drifting',
      existingTraces: [
        makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '500' }] }),
        makeTrace({ erroredNodes: [] }),
      ],
    })
    const emptyTarget = makeTarget({ n8nWorkflowId: 'wf-empty', existingTraces: [] })

    await runWatchTick(lib, [healthyTarget, driftingTarget, emptyTarget], 'https://n8n.example.com', 'fake-key', auditPath, fetchTrace)

    const trail = await getReliabilityAuditTrail(50, auditPath)
    expect(trail).toHaveLength(3)
    expect(trail.map(e => e.workflowId).sort()).toEqual(['wf-drifting', 'wf-empty', 'wf-healthy'])

    const driftingEntry = trail.find(e => e.workflowId === 'wf-drifting')!
    expect(driftingEntry.verdict).toBe('DRIFTING')
    expect(driftingEntry.driftingCheckIds).toContain('D1')

    const emptyEntry = trail.find(e => e.workflowId === 'wf-empty')!
    expect(emptyEntry.status).toBe('fetch_failed')
    expect(emptyEntry.verdict).toBeUndefined()
  })

  it('an audit-write failure never breaks the tick -- results are still returned', async () => {
    const lib: WatchTraceRecorder = { recordTrace: async () => {} }
    const fetchTrace = async () => null
    // A regular file used as a path segment forces mkdir(dirname(auditPath)) to fail with
    // ENOTDIR -- a reliable way to force appendReliabilityAudit's write to fail.
    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-loop-test-'))
    const blockingFile = join(tmpDir, 'not-a-directory')
    await writeFile(blockingFile, 'x', 'utf-8')
    const bogusAuditPath = join(blockingFile, 'reliability-audit.jsonl')

    const results = await runWatchTick(lib, [makeTarget({ existingTraces: [makeTrace()] })], 'https://n8n.example.com', 'fake-key', bogusAuditPath, fetchTrace)
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('checked')
  })

  it('returns one result per target, in order', async () => {
    const lib: WatchTraceRecorder = { recordTrace: async () => {} }
    const fetchTrace = async () => null
    tmpDir = await mkdtemp(join(tmpdir(), 'kairos-watch-loop-test-'))
    const auditPath = join(tmpDir, 'reliability-audit.jsonl')

    const targets = [
      makeTarget({ n8nWorkflowId: 'wf-a', existingTraces: [makeTrace()] }),
      makeTarget({ n8nWorkflowId: 'wf-b', existingTraces: [makeTrace()] }),
    ]
    const results = await runWatchTick(lib, targets, 'https://n8n.example.com', 'fake-key', auditPath, fetchTrace)
    expect(results.map(r => r.workflowId)).toEqual(['wf-a', 'wf-b'])
  })
})

describe('formatWatchTickForHumans', () => {
  it('reports zero workflows checked distinctly, not a blank/generic message', () => {
    expect(formatWatchTickForHumans([])).toContain('nothing checked')
  })

  it('summarizes counts and lists each workflow with its verdict', () => {
    const healthy = buildTickResult(makeTarget({ n8nWorkflowId: 'wf-healthy', existingTraces: [makeTrace(), makeTrace()] }), null, '2026-01-01T00:00:00.000Z')
    const drifting = buildTickResult(
      makeTarget({
        n8nWorkflowId: 'wf-drifting',
        existingTraces: [
          makeTrace({ erroredNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '500' }] }),
          makeTrace({ erroredNodes: [] }),
        ],
      }),
      null,
      '2026-01-01T00:00:00.000Z',
    )
    const empty = buildTickResult(makeTarget({ n8nWorkflowId: 'wf-empty', existingTraces: [] }), null, '2026-01-01T00:00:00.000Z')

    const text = formatWatchTickForHumans([healthy, drifting, empty])
    expect(text).toContain('1 healthy, 1 drifting, 1 nothing to evaluate yet')
    expect(text).toContain('wf-healthy')
    expect(text).toContain('wf-drifting')
    expect(text).toContain('wf-empty')
    expect(text).toContain('NO DATA')
  })
})
