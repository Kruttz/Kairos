import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TelemetryReader } from '../../../src/telemetry/reader.js'

describe('TelemetryReader', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `kairos-test-telemetry-${Date.now()}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function todayStr(): string {
    return new Date().toISOString().slice(0, 10)
  }

  function makeEvent(eventType: string, sessionId: string, data: Record<string, unknown>): string {
    return JSON.stringify({ timestamp: new Date().toISOString(), sessionId, eventType, data })
  }

  it('returns empty array when no telemetry dir exists', async () => {
    const reader = new TelemetryReader(join(dir, 'nonexistent'))
    const rates = await reader.getFailureRates()
    expect(rates).toEqual([])
  })

  it('returns empty array when no build_complete events exist', async () => {
    const file = join(dir, `${todayStr()}.jsonl`)
    await writeFile(file, makeEvent('generation_attempt', 's1', {
      validationPassed: false,
      issues: [{ rule: 12, message: 'Forbidden field' }],
    }))

    const reader = new TelemetryReader(dir)
    const rates = await reader.getFailureRates()
    expect(rates).toEqual([])
  })

  it('computes failure rates using distinct sessions', async () => {
    const file = join(dir, `${todayStr()}.jsonl`)
    const lines = [
      makeEvent('generation_attempt', 's1', {
        validationPassed: false,
        issues: [{ rule: 12, message: 'Forbidden field "id"' }],
      }),
      makeEvent('generation_attempt', 's1', {
        validationPassed: false,
        issues: [{ rule: 12, message: 'Forbidden field "id"' }],
      }),
      makeEvent('build_complete', 's1', { success: true }),
      makeEvent('generation_attempt', 's2', {
        validationPassed: true,
        issues: [],
      }),
      makeEvent('build_complete', 's2', { success: true }),
    ]
    await writeFile(file, lines.join('\n'))

    const reader = new TelemetryReader(dir)
    const rates = await reader.getFailureRates()
    expect(rates).toHaveLength(1)
    expect(rates[0]!.rule).toBe(12)
    expect(rates[0]!.failureCount).toBe(1)
    expect(rates[0]!.totalBuilds).toBe(2)
    expect(rates[0]!.rate).toBe(0.5)
  })

  it('ignores non-YYYY-MM-DD.jsonl files', async () => {
    await writeFile(join(dir, 'notes.jsonl'), makeEvent('build_complete', 's1', {}))
    await writeFile(join(dir, 'debug.txt'), 'hello')

    const reader = new TelemetryReader(dir)
    const rates = await reader.getFailureRates()
    expect(rates).toEqual([])
  })

  it('skips malformed JSON lines gracefully', async () => {
    const file = join(dir, `${todayStr()}.jsonl`)
    const lines = [
      'not json at all',
      makeEvent('generation_attempt', 's1', {
        validationPassed: false,
        issues: [{ rule: 5, message: 'test' }],
      }),
      makeEvent('build_complete', 's1', { success: true }),
    ]
    await writeFile(file, lines.join('\n'))

    const reader = new TelemetryReader(dir)
    const rates = await reader.getFailureRates()
    expect(rates).toHaveLength(1)
    expect(rates[0]!.rule).toBe(5)
  })

  it('caches results for 5 minutes', async () => {
    const file = join(dir, `${todayStr()}.jsonl`)
    await writeFile(file, [
      makeEvent('generation_attempt', 's1', {
        validationPassed: false,
        issues: [{ rule: 1, message: 'err' }],
      }),
      makeEvent('build_complete', 's1', { success: true }),
    ].join('\n'))

    const reader = new TelemetryReader(dir)
    const first = await reader.getFailureRates()
    expect(first).toHaveLength(1)

    await writeFile(file, '')
    const second = await reader.getFailureRates()
    expect(second).toHaveLength(1)
  })

  it('sorts rates descending by rate', async () => {
    const file = join(dir, `${todayStr()}.jsonl`)
    const lines = [
      makeEvent('generation_attempt', 's1', {
        validationPassed: false,
        issues: [
          { rule: 1, message: 'low' },
          { rule: 2, message: 'high' },
        ],
      }),
      makeEvent('build_complete', 's1', { success: true }),
      makeEvent('generation_attempt', 's2', {
        validationPassed: false,
        issues: [{ rule: 2, message: 'high' }],
      }),
      makeEvent('build_complete', 's2', { success: true }),
      makeEvent('build_complete', 's3', { success: true }),
    ]
    await writeFile(file, lines.join('\n'))

    const reader = new TelemetryReader(dir)
    const rates = await reader.getFailureRates()
    expect(rates.length).toBe(2)
    expect(rates[0]!.rule).toBe(2)
    expect(rates[1]!.rule).toBe(1)
  })
})
