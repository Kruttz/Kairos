import { describe, it, expect } from 'vitest'
import { buildSnapshotFromExecution, replayOnePayload, formatReplayReportForHumans, type ReplayRunResult } from '../../../../src/reliability/replay/runner.js'
import type { CapturedPayload } from '../../../../src/reliability/replay/capture.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'
import type { PayloadDiffResult } from '../../../../src/reliability/replay/diff.js'

describe('buildSnapshotFromExecution', () => {
  it('extracts output shape (keys/types, never values) for a successful node', () => {
    const execution = {
      data: {
        resultData: {
          runData: {
            Webhook: [{ data: { main: [[{ json: { customerName: 'Jane Test', age: 30, tags: ['a', 'b'], active: true } }]] } }],
          },
        },
      },
    }
    const snapshot = buildSnapshotFromExecution('exec-1', execution)
    expect(snapshot.nodes['Webhook']).toEqual({
      ran: true,
      status: 'success',
      outputShape: { customerName: 'string', age: 'number', tags: 'array', active: 'boolean' },
    })
    // Never the real value -- proving shape-only, not value, comparison.
    expect(JSON.stringify(snapshot)).not.toContain('Jane Test')
  })

  it('extracts errorType from name when present (matches S1 spike finding for HTTP-calling nodes)', () => {
    const execution = {
      data: { resultData: { runData: { 'HTTP Request': [{ error: { name: 'NodeApiError', httpCode: '429', message: 'rate limited' } }] } } },
    }
    const snapshot = buildSnapshotFromExecution('exec-1', execution)
    expect(snapshot.nodes['HTTP Request']).toEqual({ ran: true, status: 'error', errorType: 'NodeApiError' })
  })

  it('falls back to HTTP_<code> when name is absent but httpCode is present', () => {
    const execution = {
      data: { resultData: { runData: { 'HTTP Request': [{ error: { httpCode: '500' } }] } } },
    }
    const snapshot = buildSnapshotFromExecution('exec-1', execution)
    expect(snapshot.nodes['HTTP Request']!.errorType).toBe('HTTP_500')
  })

  it('falls back to UnknownError for a Code-node-shaped error with neither name nor httpCode (S1 spike finding)', () => {
    const execution = {
      data: { resultData: { runData: { Code: [{ error: { message: 'deliberate spike error', lineNumber: 1 } }] } } },
    }
    const snapshot = buildSnapshotFromExecution('exec-1', execution)
    expect(snapshot.nodes['Code']!.errorType).toBe('UnknownError')
  })

  it('computes durationMs from startedAt/stoppedAt when both present', () => {
    const execution = { data: { resultData: { runData: {} } }, startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-01-01T00:00:01.500Z' }
    const snapshot = buildSnapshotFromExecution('exec-1', execution)
    expect(snapshot.durationMs).toBe(1500)
  })

  it('omits durationMs (not NaN, not 0) when timestamps are absent', () => {
    const execution = { data: { resultData: { runData: {} } } }
    const snapshot = buildSnapshotFromExecution('exec-1', execution)
    expect(snapshot.durationMs).toBeUndefined()
  })

  it('produces an empty nodes map, not a throw, when execution.data is entirely absent', () => {
    const snapshot = buildSnapshotFromExecution('exec-1', {})
    expect(snapshot.nodes).toEqual({})
  })
})

function makeCapture(body: unknown = { customerName: 'Jane' }): CapturedPayload {
  return {
    executionId: 'capture-exec-1',
    capturedAt: new Date().toISOString(),
    triggerNodeName: 'Webhook',
    payload: { body },
    scrubbed: false,
  }
}

const FAST_OPTIONS = { pollTimeoutMs: 100, pollIntervalMs: 10, maxPollIntervalMs: 20 }

describe('replayOnePayload -- polling, timeout, no-execution-found', () => {
  it('finds a fresh execution appearing after injection and returns its snapshot', async () => {
    let callCount = 0
    const client = {
      getExecutions: async () => {
        callCount++
        // First call (the "before" snapshot) sees nothing; every call after injection sees exec-new.
        return callCount === 1 ? [] : [{ id: 'exec-new' }]
      },
      triggerWebhookProduction: async () => ({ statusCode: 200, body: '{}' }),
      getExecution: async (id: string) => ({ id, data: { resultData: { runData: {} } } }),
    } as unknown as N8nApiClient

    const outcome = await replayOnePayload(
      client,
      { baseUrl: 'http://localhost:15679', apiKey: 'x', isKairosSandbox: true, n8nVersion: '2.30.7', provisionedAt: new Date().toISOString() },
      'wf-1', { path: 'x', httpMethod: 'POST' }, makeCapture(), FAST_OPTIONS,
    )
    expect(outcome.status).toBe('found')
    expect(outcome.executionId).toBe('exec-new')
    expect(outcome.snapshot).toBeDefined()
  })

  it('never mistakes a pre-existing execution for a fresh one -- only IDs absent from the "before" snapshot count', async () => {
    const client = {
      getExecutions: async () => [{ id: 'exec-preexisting' }], // same ID, every call, never changes
      triggerWebhookProduction: async () => ({ statusCode: 200, body: '{}' }),
      getExecution: async () => { throw new Error('should never be called -- no fresh execution should be found') },
    } as unknown as N8nApiClient

    const outcome = await replayOnePayload(
      client,
      { baseUrl: 'http://localhost:15679', apiKey: 'x', isKairosSandbox: true, n8nVersion: '2.30.7', provisionedAt: new Date().toISOString() },
      'wf-1', { path: 'x', httpMethod: 'POST' }, makeCapture(), FAST_OPTIONS,
    )
    expect(outcome.status).toBe('no_execution_found')
  })

  it('returns no_execution_found (not a throw, not a fake pass) when nothing appears within the timeout -- honest, bounded, never hangs', async () => {
    const start = Date.now()
    const client = {
      getExecutions: async () => [],
      triggerWebhookProduction: async () => ({ statusCode: 200, body: '{}' }),
      getExecution: async () => { throw new Error('should never be called') },
    } as unknown as N8nApiClient

    const outcome = await replayOnePayload(
      client,
      { baseUrl: 'http://localhost:15679', apiKey: 'x', isKairosSandbox: true, n8nVersion: '2.30.7', provisionedAt: new Date().toISOString() },
      'wf-1', { path: 'x', httpMethod: 'POST' }, makeCapture(), FAST_OPTIONS,
    )
    const elapsed = Date.now() - start
    expect(outcome.status).toBe('no_execution_found')
    expect(outcome.snapshot).toBeUndefined()
    // Bounded -- didn't hang indefinitely, and didn't return instantly either (it actually polled).
    expect(elapsed).toBeGreaterThanOrEqual(FAST_OPTIONS.pollTimeoutMs)
    expect(elapsed).toBeLessThan(FAST_OPTIONS.pollTimeoutMs + 2000)
  })

  it('refuses to run against a URL matching configured production N8N_BASE_URL (defense in depth)', async () => {
    const ORIGINAL = process.env['N8N_BASE_URL']
    process.env['N8N_BASE_URL'] = 'http://localhost:15679'
    try {
      const client = { getExecutions: async () => [], triggerWebhookProduction: async () => ({ statusCode: 200, body: '{}' }), getExecution: async () => ({}) } as unknown as N8nApiClient
      await expect(replayOnePayload(
        client,
        { baseUrl: 'http://localhost:15679', apiKey: 'x', isKairosSandbox: true, n8nVersion: '2.30.7', provisionedAt: new Date().toISOString() },
        'wf-1', { path: 'x', httpMethod: 'POST' }, makeCapture(), FAST_OPTIONS,
      )).rejects.toThrow(/production/)
    } finally {
      if (ORIGINAL === undefined) delete process.env['N8N_BASE_URL']
      else process.env['N8N_BASE_URL'] = ORIGINAL
    }
  })
})

function makeDiff(overrides: Partial<PayloadDiffResult> = {}): PayloadDiffResult {
  return {
    payloadId: 'exec-1',
    verdict: 'IDENTICAL',
    verificationBoundary: { verified: [], unverifiable: [] },
    nodeDiffs: [],
    partialVerification: false,
    ...overrides,
  }
}

function makeCompletedResult(overrides: Partial<ReplayRunResult> = {}): ReplayRunResult {
  return {
    status: 'completed',
    detail: 'Replayed 1 captured payload(s) against baseline and candidate.',
    baselineImportedName: '[kairos-sandbox] baseline: Missed Call Text-Back',
    candidateImportedName: '[kairos-sandbox] candidate: Missed Call Text-Back',
    outcomes: [{ payloadId: 'exec-1', status: 'compared', baselineExecutionId: '2', candidateExecutionId: '3', diff: makeDiff(), detail: 'Compared successfully -- verdict IDENTICAL.' }],
    verdict: 'IDENTICAL',
    partialVerification: false,
    ...overrides,
  }
}

describe('formatReplayReportForHumans -- operator/client-readable output (Jordan/Codex, 2026-07-19)', () => {
  it('always includes all six required elements: verdict, verification status, payload count, changed nodes, unverifiable nodes, next action', () => {
    const result = makeCompletedResult({
      verdict: 'BEHAVIORAL_CHANGE',
      partialVerification: true,
      outcomes: [{
        payloadId: 'exec-1', status: 'compared', baselineExecutionId: '2', candidateExecutionId: '3',
        diff: makeDiff({
          verdict: 'BEHAVIORAL_CHANGE',
          partialVerification: true,
          nodeDiffs: [
            { node: 'Format', status: 'changed', detail: 'Output shape differs.', baselineOutputShape: { customerName: 'string' }, candidateOutputShape: { customerName: 'string', customerPhone: 'string' } },
            { node: 'CRM Lookup', status: 'unverifiable', detail: 'This node has a credential binding stripped for sandbox execution.' },
          ],
        }),
        detail: 'Compared successfully -- verdict BEHAVIORAL_CHANGE.',
      }],
    })
    const text = formatReplayReportForHumans(result)

    expect(text).toContain('REVIEW BEFORE DEPLOYING') // verdict, plain language
    expect(text).toContain('Verification: PARTIAL') // verification status
    expect(text).toContain('Payloads tested: 1') // payload count
    expect(text).toContain('Format') // changed node named
    expect(text).toContain('CRM Lookup') // unverifiable node named
    expect(text).toContain('Next action:') // exact next action, always present
  })

  it('presents a field-level breakdown of what changed, not raw JSON', () => {
    const result = makeCompletedResult({
      verdict: 'BEHAVIORAL_CHANGE',
      outcomes: [{
        payloadId: 'exec-1', status: 'compared', baselineExecutionId: '2', candidateExecutionId: '3',
        diff: makeDiff({
          verdict: 'BEHAVIORAL_CHANGE',
          nodeDiffs: [{
            node: 'Format', status: 'changed', detail: 'Output shape differs.',
            baselineOutputShape: { customerName: 'string', status: 'string' },
            candidateOutputShape: { customerName: 'string', customerPhone: 'string', status: 'number' },
          }],
        }),
        detail: 'x',
      }],
    })
    const text = formatReplayReportForHumans(result)
    expect(text).toContain('new field(s): customerPhone')
    expect(text).toContain('status changed type: string -> number')
  })

  it('says SAFE TO DEPLOY with confidence when fully verified and identical', () => {
    const result = makeCompletedResult({ verdict: 'IDENTICAL', partialVerification: false })
    const text = formatReplayReportForHumans(result)
    expect(text).toContain('SAFE TO DEPLOY')
    expect(text).toContain('Verification: FULL')
    expect(text).toContain('Deploy with confidence')
  })

  it('recommends manual review, not blind confidence, when identical but only partially verified', () => {
    const result = makeCompletedResult({
      verdict: 'IDENTICAL',
      partialVerification: true,
      outcomes: [{ payloadId: 'exec-1', status: 'compared', baselineExecutionId: '2', candidateExecutionId: '3', diff: makeDiff({ partialVerification: true }), detail: 'x' }],
    })
    const text = formatReplayReportForHumans(result)
    expect(text).toContain('SAFE TO DEPLOY') // still identical -- the verdict itself is accurate
    expect(text.toLowerCase()).toContain('review') // but the next action must still say review the unverified parts
  })

  it('says DO NOT DEPLOY for BROKEN', () => {
    const result = makeCompletedResult({ verdict: 'BROKEN' })
    const text = formatReplayReportForHumans(result)
    expect(text).toContain('DO NOT DEPLOY')
    expect(text).toContain('Do not deploy')
  })

  it('says INCONCLUSIVE and recommends re-running for INCOMPLETE, never a clean pass', () => {
    const result = makeCompletedResult({
      verdict: 'INCOMPLETE',
      partialVerification: true,
      outcomes: [
        { payloadId: 'exec-1', status: 'compared', baselineExecutionId: '2', candidateExecutionId: '3', diff: makeDiff(), detail: 'x' },
        { payloadId: 'exec-2', status: 'no_execution_found', detail: 'No fresh execution appeared.' },
      ],
    })
    const text = formatReplayReportForHumans(result)
    expect(text).toContain('INCONCLUSIVE')
    expect(text).toContain('could not be run at all')
    expect(text).toContain('Re-run the replay test')
    expect(text).not.toContain('SAFE TO DEPLOY')
  })

  it('gives a real next action for no_captures and not_webhook_shaped, not a blank/generic message', () => {
    const noCaptures: ReplayRunResult = { status: 'no_captures', detail: 'No captures found.', outcomes: [], verdict: 'NOT_RUN', partialVerification: false }
    expect(formatReplayReportForHumans(noCaptures)).toContain('kairos replay capture')

    const notWebhook: ReplayRunResult = { status: 'not_webhook_shaped', detail: 'Not a webhook workflow.', outcomes: [], verdict: 'NOT_RUN', partialVerification: false }
    expect(formatReplayReportForHumans(notWebhook)).toContain('webhook-triggered')
  })
})
