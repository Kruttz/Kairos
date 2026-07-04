import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kairos } from '../../src/client.js'
import { WorkflowDesigner } from '../../src/generation/designer.js'
import { ResponseParseError } from '../../src/errors/response-parse-error.js'
import { ResponseTruncationError } from '../../src/errors/response-truncation-error.js'

async function readTelemetryEvents(dir: string): Promise<Array<{ eventType: string; data: Record<string, unknown> }>> {
  const files = await readdir(dir)
  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))
  const events: Array<{ eventType: string; data: Record<string, unknown> }> = []
  for (const file of jsonlFiles) {
    const content = await readFile(join(dir, file), 'utf-8')
    for (const line of content.trim().split('\n')) {
      if (line) events.push(JSON.parse(line))
    }
  }
  return events
}

describe('Kairos.build() — parse/truncation failures get the same telemetry visibility as ValidationError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits generation_attempt (with parseFailure) and build_complete(success:false) for a ResponseParseError carrying attemptMetadata', async () => {
    const telemetryDir = await mkdtemp(join(tmpdir(), 'kairos-parse-failure-'))
    try {
      const err = new ResponseParseError(
        'generate_workflow tool call returned workflow as a JSON string that could not be parsed as an object',
        undefined,
        [{ attempt: 1, temperature: 0.2, durationMs: 5000, tokensInput: 100, tokensOutput: 8000, validationPassed: false, issues: [], parseFailure: 'stringified workflow' }],
      )
      vi.spyOn(WorkflowDesigner.prototype, 'design').mockRejectedValue(err)

      const kairos = new Kairos({ anthropicApiKey: 'sk-ant-test', telemetry: telemetryDir })

      await expect(kairos.build('Test description', { dryRun: true })).rejects.toBe(err)

      const events = await readTelemetryEvents(telemetryDir)
      const attemptEvent = events.find((e) => e.eventType === 'generation_attempt')
      const completeEvent = events.find((e) => e.eventType === 'build_complete')

      expect(attemptEvent).toBeDefined()
      expect(attemptEvent!.data['parseFailure']).toBe('stringified workflow')

      expect(completeEvent).toBeDefined()
      expect(completeEvent!.data['success']).toBe(false)
      expect(completeEvent!.data['totalAttempts']).toBe(1)
    } finally {
      await rm(telemetryDir, { recursive: true, force: true })
    }
  })

  it('emits telemetry for a ResponseTruncationError the same way (subclass of GenerationError)', async () => {
    const telemetryDir = await mkdtemp(join(tmpdir(), 'kairos-truncation-'))
    try {
      const err = new ResponseTruncationError(
        'Claude response was truncated (max_tokens reached)',
        undefined,
        [{ attempt: 1, temperature: 0.2, durationMs: 90000, tokensInput: 100, tokensOutput: 16000, validationPassed: false, issues: [], parseFailure: 'truncated' }],
      )
      vi.spyOn(WorkflowDesigner.prototype, 'design').mockRejectedValue(err)

      const kairos = new Kairos({ anthropicApiKey: 'sk-ant-test', telemetry: telemetryDir })

      await expect(kairos.build('Test description', { dryRun: true })).rejects.toBe(err)

      const events = await readTelemetryEvents(telemetryDir)
      const completeEvent = events.find((e) => e.eventType === 'build_complete')
      expect(completeEvent).toBeDefined()
      expect(completeEvent!.data['success']).toBe(false)
    } finally {
      await rm(telemetryDir, { recursive: true, force: true })
    }
  })

  it('does NOT emit failure telemetry for errors with no attemptMetadata (e.g. a plain GuardError)', async () => {
    const telemetryDir = await mkdtemp(join(tmpdir(), 'kairos-no-metadata-'))
    try {
      vi.spyOn(WorkflowDesigner.prototype, 'design').mockRejectedValue(new Error('unrelated failure, not a Kairos error class'))

      const kairos = new Kairos({ anthropicApiKey: 'sk-ant-test', telemetry: telemetryDir })

      await expect(kairos.build('Test description', { dryRun: true })).rejects.toThrow('unrelated failure')

      const events = await readTelemetryEvents(telemetryDir)
      expect(events.some((e) => e.eventType === 'build_complete')).toBe(false)
    } finally {
      await rm(telemetryDir, { recursive: true, force: true })
    }
  })
})
