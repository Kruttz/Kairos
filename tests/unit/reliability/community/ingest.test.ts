import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  aggregateCommunityPatterns,
  parseShareReportFile,
  ingestCommunityPatternsFromFile,
  loadCommunityPatternStore,
} from '../../../../src/reliability/community/ingest.js'
import type { WhitelistedPattern, PatternShareReport } from '../../../../src/reliability/community/whitelist.js'

function pattern(overrides: Partial<WhitelistedPattern> = {}): WhitelistedPattern {
  return { kind: 'validator-rule', rule: 17, pipelineStage: 'credential_injection', failureCount: 5, confidence: 0.8, ...overrides }
}

describe('aggregateCommunityPatterns', () => {
  it('aggregates a single report into one record per rule', () => {
    const store = aggregateCommunityPatterns([{ patterns: [pattern({ rule: 17, failureCount: 5 }), pattern({ rule: 42, failureCount: 3 })] }])
    expect(store.entries).toHaveLength(2)
    expect(store.entries.find(e => e.rule === 17)).toEqual({ rule: 17, pipelineStage: 'credential_injection', reportCount: 1, totalOccurrences: 5 })
  })

  it('sums occurrences and counts reports across multiple reports mentioning the same rule', () => {
    const store = aggregateCommunityPatterns([
      { patterns: [pattern({ rule: 17, failureCount: 5 })] },
      { patterns: [pattern({ rule: 17, failureCount: 9 })] },
      { patterns: [pattern({ rule: 17, failureCount: 2 })] },
    ])
    const entry = store.entries.find(e => e.rule === 17)
    expect(entry).toEqual({ rule: 17, pipelineStage: 'credential_injection', reportCount: 3, totalOccurrences: 16 })
  })

  it('produces no compositeScore, state, confidence, or any field resembling local Pattern scoring', () => {
    const store = aggregateCommunityPatterns([{ patterns: [pattern()] }])
    const entry = store.entries[0]!
    expect(entry).not.toHaveProperty('compositeScore')
    expect(entry).not.toHaveProperty('state')
    expect(entry).not.toHaveProperty('confidence')
    expect(entry).not.toHaveProperty('scoringFactors')
    expect(Object.keys(entry).sort()).toEqual(['pipelineStage', 'reportCount', 'rule', 'totalOccurrences'])
  })

  it('handles an empty input list', () => {
    expect(aggregateCommunityPatterns([]).entries).toEqual([])
  })

  it('provenance is always "community"', () => {
    expect(aggregateCommunityPatterns([{ patterns: [pattern()] }]).provenance).toBe('community')
  })
})

describe('parseShareReportFile', () => {
  it('parses a well-formed share-report file', () => {
    const report: PatternShareReport = { kairosVersion: '0.11.0', generatedAt: '2026-07-19T00:00:00.000Z', patterns: [pattern()] }
    const parsed = parseShareReportFile(JSON.stringify(report))
    expect(parsed.patterns).toEqual([pattern()])
  })

  it('drops malformed entries rather than failing the whole file', () => {
    const raw = JSON.stringify({ patterns: [pattern({ rule: 1 }), { rule: 'not-a-number' }, { garbage: true }, pattern({ rule: 2 })] })
    const parsed = parseShareReportFile(raw)
    expect(parsed.patterns.map(p => p.rule)).toEqual([1, 2])
  })

  it('returns an empty patterns array for a file with no patterns field', () => {
    expect(parseShareReportFile(JSON.stringify({ foo: 'bar' })).patterns).toEqual([])
  })

  it('throws on genuinely invalid JSON -- a corrupted file is a real error, not silently swallowed', () => {
    expect(() => parseShareReportFile('{not json')).toThrow()
  })
})

describe('ingestCommunityPatternsFromFile / loadCommunityPatternStore', () => {
  let scratchHome: string
  let scratchSource: string
  const ORIGINAL_HOME = homedir()

  beforeEach(async () => {
    scratchHome = await mkdtemp(join(tmpdir(), 'kairos-ingest-test-'))
    scratchSource = await mkdtemp(join(tmpdir(), 'kairos-ingest-source-'))
    process.env['HOME'] = scratchHome
  })

  afterEach(async () => {
    process.env['HOME'] = ORIGINAL_HOME
    await rm(scratchHome, { recursive: true, force: true })
    await rm(scratchSource, { recursive: true, force: true })
  })

  it('returns null when nothing has been ingested yet', async () => {
    expect(await loadCommunityPatternStore()).toBeNull()
  })

  it('ingests a local file and it becomes loadable', async () => {
    const sourcePath = join(scratchSource, 'community-patterns.json')
    const report: PatternShareReport = { kairosVersion: '0.11.0', generatedAt: '2026-07-19T00:00:00.000Z', patterns: [pattern({ rule: 30, failureCount: 4 })] }
    await writeFile(sourcePath, JSON.stringify(report), 'utf-8')

    const result = await ingestCommunityPatternsFromFile(sourcePath)
    expect(result.entries).toEqual([{ rule: 30, pipelineStage: 'credential_injection', reportCount: 1, totalOccurrences: 4 }])

    const loaded = await loadCommunityPatternStore()
    expect(loaded).toEqual(result)
  })

  it('re-ingesting overwrites rather than accumulating across calls', async () => {
    const sourcePath = join(scratchSource, 'community-patterns.json')
    await writeFile(sourcePath, JSON.stringify({ patterns: [pattern({ rule: 1, failureCount: 1 })] }), 'utf-8')
    await ingestCommunityPatternsFromFile(sourcePath)

    await writeFile(sourcePath, JSON.stringify({ patterns: [pattern({ rule: 2, failureCount: 1 })] }), 'utf-8')
    await ingestCommunityPatternsFromFile(sourcePath)

    const loaded = await loadCommunityPatternStore()
    expect(loaded!.entries.map(e => e.rule)).toEqual([2])
  })

  it('the written file is chmod 600 -- same local-only posture as capture.ts/snapshot.ts', async () => {
    const sourcePath = join(scratchSource, 'community-patterns.json')
    await writeFile(sourcePath, JSON.stringify({ patterns: [pattern()] }), 'utf-8')
    await ingestCommunityPatternsFromFile(sourcePath)

    const { stat } = await import('node:fs/promises')
    const stats = await stat(join(scratchHome, '.kairos', 'community-patterns.json'))
    expect(stats.mode & 0o777).toBe(0o600)
  })
})
