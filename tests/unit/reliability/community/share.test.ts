import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatReportPreview,
  writePatternReportFile,
  attemptGhIssueCreate,
  manualIssueUrl,
  COMMUNITY_REPO,
} from '../../../../src/reliability/community/share.js'
import type { PatternShareReport } from '../../../../src/reliability/community/whitelist.js'

function makeReport(overrides: Partial<PatternShareReport> = {}): PatternShareReport {
  return {
    kairosVersion: '0.11.0',
    generatedAt: '2026-07-19T00:00:00.000Z',
    patterns: [{ kind: 'validator-rule', rule: 17, pipelineStage: 'credential_injection', failureCount: 5, confidence: 0.8 }],
    ...overrides,
  }
}

describe('formatReportPreview', () => {
  it('produces pretty-printed JSON matching the report exactly', () => {
    const report = makeReport()
    const preview = formatReportPreview(report)
    expect(JSON.parse(preview)).toEqual(report)
    expect(preview).toContain('\n')
  })
})

describe('writePatternReportFile', () => {
  let scratchDir: string

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'kairos-share-test-'))
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('writes the exact report to the given path and returns that path', async () => {
    const report = makeReport()
    const path = join(scratchDir, 'pattern-report.json')
    const returned = await writePatternReportFile(report, path)
    expect(returned).toBe(path)
    const written = JSON.parse(await readFile(path, 'utf-8'))
    expect(written).toEqual(report)
  })

  it('the written file byte-matches formatReportPreview -- no silent divergence between preview and what is actually written', async () => {
    const report = makeReport()
    const path = join(scratchDir, 'pattern-report.json')
    await writePatternReportFile(report, path)
    const written = await readFile(path, 'utf-8')
    expect(written.trimEnd()).toBe(formatReportPreview(report))
  })
})

describe('attemptGhIssueCreate', () => {
  it('reports attempted:false gracefully when the binary does not exist -- never throws', async () => {
    const result = await attemptGhIssueCreate('/tmp/does-not-matter.json', '0.11.0', 5000, 'kairos-definitely-nonexistent-binary-xyz')
    expect(result.attempted).toBe(false)
    expect(result.opened).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('reports opened:true on a zero exit code', async () => {
    // A minimal stand-in "gh" that always exits 0, ignoring its arguments -- proves the
    // success path without depending on a real gh install or network access.
    const result = await attemptGhIssueCreate('/tmp/whatever.json', '0.11.0', 5000, 'true')
    expect(result.attempted).toBe(true)
    expect(result.opened).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('reports opened:false on a non-zero exit code without throwing', async () => {
    const result = await attemptGhIssueCreate('/tmp/whatever.json', '0.11.0', 5000, 'false')
    expect(result.attempted).toBe(true)
    expect(result.opened).toBe(false)
    expect(result.exitCode).not.toBe(0)
  })

  it('times out rather than hanging indefinitely', async () => {
    // A script that ignores its (fixed, hardcoded-by-the-caller) arguments and just sleeps --
    // "sleep"/"cat" themselves would error immediately on the fixed `gh issue create ...` args
    // rather than hang, so this is the only reliable way to exercise the timeout path itself.
    const scratchDir = await mkdtemp(join(tmpdir(), 'kairos-share-hang-test-'))
    const scriptPath = join(scratchDir, 'hang.sh')
    await writeFile(scriptPath, '#!/bin/sh\nsleep 5\n', 'utf-8')
    await chmod(scriptPath, 0o700)

    const result = await attemptGhIssueCreate('/tmp/whatever.json', '0.11.0', 100, scriptPath)
    expect(result.attempted).toBe(true)
    expect(result.opened).toBe(false)
    expect(result.error).toMatch(/timed out/)

    await rm(scratchDir, { recursive: true, force: true })
  }, 2000)
})

describe('manualIssueUrl', () => {
  it('points at the real Kairos repo issues/new page', () => {
    expect(manualIssueUrl()).toBe(`https://github.com/${COMMUNITY_REPO}/issues/new`)
    expect(COMMUNITY_REPO).toBe('Kruttz/Kairos')
  })
})
