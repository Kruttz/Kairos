import { describe, it, expect } from 'vitest'
import { buildSnapshotFromExecution, replayOnePayload } from '../../../../src/reliability/replay/runner.js'
import type { CapturedPayload } from '../../../../src/reliability/replay/capture.js'
import type { N8nApiClient } from '../../../../src/providers/n8n/api-client.js'

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
