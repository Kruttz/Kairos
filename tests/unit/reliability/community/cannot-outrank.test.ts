import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { PatternAnalyzer } from '../../../../src/telemetry/pattern-analyzer.js'
import { ingestCommunityPatternsFromFile } from '../../../../src/reliability/community/ingest.js'
import type { PatternShareReport } from '../../../../src/reliability/community/whitelist.js'

/**
 * Jordan's explicit requirement (2026-07-19, Phase 5b scope): "tests proving community patterns
 * cannot outrank local confirmed patterns." The unit tests in ingest.test.ts already prove this
 * at the display-composition level (annotateWithCommunityData produces no comparable score).
 * This file proves the stronger, behavioral claim: PatternAnalyzer's real scoring output is
 * byte-for-byte unaffected by community-patterns.json existing on disk at all -- not just "the
 * display layer doesn't use it," but "the scoring computation genuinely never sees it," which is
 * what makes "outrank" impossible rather than merely undisplayed.
 */

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function makeEvent(eventType: string, sessionId: string, data: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), sessionId, eventType, data })
}

async function seedIdenticalTelemetry(telemetryDir: string): Promise<void> {
  await mkdir(telemetryDir, { recursive: true })
  const events: string[] = []
  // 4 sessions failing rule 17 -> confirmed state, a real composite score to try to "outrank"
  for (let i = 0; i < 4; i++) {
    events.push(
      makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
      makeEvent('generation_attempt', `s${i}`, {
        validationPassed: false,
        issues: [{ rule: 17, message: 'bad credential' }],
        durationMs: 1000, tokensInput: 100, tokensOutput: 50,
      }),
    )
  }
  await writeFile(join(telemetryDir, `${todayStr()}.jsonl`), events.join('\n'))
}

describe('community patterns cannot outrank local confirmed patterns (behavioral proof)', () => {
  let scratchHomeWithout: string
  let scratchHomeWith: string
  const ORIGINAL_HOME = homedir()

  beforeEach(async () => {
    scratchHomeWithout = await mkdtemp(join(tmpdir(), 'kairos-outrank-without-'))
    scratchHomeWith = await mkdtemp(join(tmpdir(), 'kairos-outrank-with-'))
  })

  afterEach(async () => {
    process.env['HOME'] = ORIGINAL_HOME
    await rm(scratchHomeWithout, { recursive: true, force: true })
    await rm(scratchHomeWith, { recursive: true, force: true })
  })

  it('analyzeAndSave() output is identical (aside from generatedAt) whether or not community-patterns.json exists, even with an artificially enormous community record for the same rule', async () => {
    // Cold-start run A: no community data at all.
    process.env['HOME'] = scratchHomeWithout
    const telemetryDirA = join(scratchHomeWithout, '.kairos', 'telemetry')
    await seedIdenticalTelemetry(telemetryDirA)
    const analyzerA = new PatternAnalyzer(telemetryDirA)
    const resultA = await analyzerA.analyzeAndSave()

    // Cold-start run B: identical telemetry, but with a real community-patterns.json ingested
    // first, deliberately carrying an enormous artificial occurrence count for the SAME rule
    // (17) that a real attacker or careless maintainer submission might try to use to "outrank."
    process.env['HOME'] = scratchHomeWith
    const telemetryDirB = join(scratchHomeWith, '.kairos', 'telemetry')
    await seedIdenticalTelemetry(telemetryDirB)

    const hugeCommunityReport: PatternShareReport = {
      kairosVersion: '0.11.0',
      generatedAt: '2026-07-19T00:00:00.000Z',
      patterns: [{ kind: 'validator-rule', rule: 17, pipelineStage: 'credential_injection', failureCount: 999999, confidence: 0.999 }],
    }
    const sourcePath = join(scratchHomeWith, 'community-source.json')
    await writeFile(sourcePath, JSON.stringify(hugeCommunityReport), 'utf-8')
    await ingestCommunityPatternsFromFile(sourcePath)

    const analyzerB = new PatternAnalyzer(telemetryDirB)
    const resultB = await analyzerB.analyzeAndSave()

    const { generatedAt: _a, ...restA } = resultA
    const { generatedAt: _b, ...restB } = resultB
    expect(restB).toEqual(restA)

    // Specifically confirm rule 17's own composite score/state/confidence are identical --
    // the exact numbers a "community record outranks local" failure would have corrupted.
    const ruleA = resultA.topFailureRules.find(p => p.rule === 17)!
    const ruleB = resultB.topFailureRules.find(p => p.rule === 17)!
    expect(ruleB.compositeScore).toBe(ruleA.compositeScore)
    expect(ruleB.confidence).toBe(ruleA.confidence)
    expect(ruleB.failureCount).toBe(ruleA.failureCount)
    expect(ruleB.state).toBe(ruleA.state)
  })
})
