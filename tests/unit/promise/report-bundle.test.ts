import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePromiseReport } from '../../../src/promise/report-bundle.js'
import type { PromiseReportData } from '../../../src/promise/report.js'

function makeData(overrides: Partial<PromiseReportData> = {}): PromiseReportData {
  return {
    contractId: 'empire-homecare-referral-intake',
    contractName: 'Referral Intake & Contact',
    contractVersion: 1,
    clientId: 'empire-homecare',
    promiseText: 'Every referral is contacted within 4 business hours.',
    contractStatus: 'active',
    provenance: { kairosVersion: '0.11.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    generatedAt: '2026-01-01T00:00:00.000Z',
    window: {},
    totalInstances: 0,
    instanceCounts: { kept: 0, missed: 0, at_risk: 0, unverifiable: 0, in_progress: 0 },
    instances: [],
    openExceptionCount: 0,
    acknowledgedExceptionCount: 0,
    resolvedExceptionCount: 0,
    openExceptions: [],
    evidenceQualityBreakdown: { specific: 0, generic: 0 },
    disclaimers: [],
    ...overrides,
  }
}

let scratchDir: string

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'kairos-report-bundle-test-'))
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('writePromiseReport', () => {
  it('writes promise-report.md with the rendered content', async () => {
    await writePromiseReport(makeData(), scratchDir)
    const content = await readFile(join(scratchDir, 'promise-report.md'), 'utf-8')
    expect(content).toContain('# Promise Report — Referral Intake & Contact')
  })

  it('writes a manifest recording the artifact and provenance', async () => {
    const manifest = await writePromiseReport(makeData(), scratchDir)
    expect(manifest.contractId).toBe('empire-homecare-referral-intake')
    expect(manifest.files).toEqual([{ artifact: 'promise-report.md', path: join(scratchDir, 'promise-report.md') }])
    expect(manifest.provenance.kairosVersion).toBeTruthy()

    const onDisk = JSON.parse(await readFile(join(scratchDir, 'promise-report-manifest.json'), 'utf-8'))
    expect(onDisk).toEqual(manifest)
  })

  it('the manifest does not list itself in its own files array', async () => {
    const manifest = await writePromiseReport(makeData(), scratchDir)
    expect(manifest.files.some(f => f.artifact === 'promise-report-manifest.json')).toBe(false)
  })

  it('both written files are chmod 600', async () => {
    await writePromiseReport(makeData(), scratchDir)
    const reportStats = await stat(join(scratchDir, 'promise-report.md'))
    const manifestStats = await stat(join(scratchDir, 'promise-report-manifest.json'))
    expect(reportStats.mode & 0o777).toBe(0o600)
    expect(manifestStats.mode & 0o777).toBe(0o600)
  })

  it('creates the output directory if it does not exist yet', async () => {
    const nested = join(scratchDir, 'a', 'b', 'c')
    await writePromiseReport(makeData(), nested)
    const content = await readFile(join(nested, 'promise-report.md'), 'utf-8')
    expect(content).toContain('Promise Report')
  })
})
