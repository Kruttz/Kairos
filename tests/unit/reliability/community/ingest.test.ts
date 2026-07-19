import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  aggregateCommunityPatterns,
  parseShareReportFile,
  ingestCommunityPatternsFromFile,
  loadCommunityPatternStore,
  syncCommunityPatternsFromUrl,
  annotateWithCommunityData,
  type CommunityPatternStore,
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

describe('syncCommunityPatternsFromUrl', () => {
  let scratchHome: string
  const ORIGINAL_HOME = homedir()

  beforeEach(async () => {
    scratchHome = await mkdtemp(join(tmpdir(), 'kairos-sync-test-'))
    process.env['HOME'] = scratchHome
  })

  afterEach(async () => {
    process.env['HOME'] = ORIGINAL_HOME
    await rm(scratchHome, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('fetches, ingests, and persists a valid remote report -- one request, no retries', async () => {
    const report: PatternShareReport = { kairosVersion: '0.11.0', generatedAt: '2026-07-19T00:00:00.000Z', patterns: [pattern({ rule: 55, failureCount: 7 })] }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(report) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncCommunityPatternsFromUrl('https://example.invalid/community-patterns.json')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://example.invalid/community-patterns.json')
    expect(result.entries).toEqual([{ rule: 55, pipelineStage: 'credential_injection', reportCount: 1, totalOccurrences: 7 }])

    const loaded = await loadCommunityPatternStore()
    expect(loaded).toEqual(result)
  })

  it('throws (not a silent empty result) on a non-2xx response, and does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' })
    vi.stubGlobal('fetch', fetchMock)

    await expect(syncCommunityPatternsFromUrl('https://example.invalid/missing.json')).rejects.toThrow(/404/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shape-validates the fetched body exactly like a local file -- malformed entries are dropped, not trusted blindly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ patterns: [pattern({ rule: 1 }), { rule: 'garbage' }] }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncCommunityPatternsFromUrl('https://example.invalid/mixed.json')
    expect(result.entries.map(e => e.rule)).toEqual([1])
  })
})

describe('annotateWithCommunityData', () => {
  function communityStore(entries: CommunityPatternStore['entries']): CommunityPatternStore {
    return { ingestedAt: '2026-07-19T00:00:00.000Z', provenance: 'community', entries }
  }

  it('returns empty annotations when no community store exists', () => {
    const result = annotateWithCommunityData([{ rule: 1 }], null)
    expect(result.localMatches.size).toBe(0)
    expect(result.communityOnly).toEqual([])
  })

  it('a rule present in both local and community data becomes a localMatches annotation, not a communityOnly entry', () => {
    const store = communityStore([{ rule: 17, pipelineStage: 'credential_injection', reportCount: 4, totalOccurrences: 20 }])
    const result = annotateWithCommunityData([{ rule: 17 }], store)
    expect(result.localMatches.get(17)).toEqual({ rule: 17, pipelineStage: 'credential_injection', reportCount: 4, totalOccurrences: 20 })
    expect(result.communityOnly).toEqual([])
  })

  it('a community rule absent locally becomes communityOnly, never localMatches', () => {
    const store = communityStore([{ rule: 99, pipelineStage: 'node_generation', reportCount: 2, totalOccurrences: 8 }])
    const result = annotateWithCommunityData([{ rule: 1 }], store)
    expect(result.localMatches.size).toBe(0)
    expect(result.communityOnly).toEqual([{ rule: 99, pipelineStage: 'node_generation', reportCount: 2, totalOccurrences: 8 }])
  })

  it('does not mutate or add score-shaped fields to the local pattern list it is given', () => {
    const localPatterns = [{ rule: 17 }]
    const store = communityStore([{ rule: 17, pipelineStage: 'credential_injection', reportCount: 999, totalOccurrences: 999999 }])
    annotateWithCommunityData(localPatterns, store)
    expect(localPatterns).toEqual([{ rule: 17 }])
  })

  it('an artificially enormous community record still produces no field that could be compared against a local compositeScore', () => {
    const store = communityStore([{ rule: 99, pipelineStage: 'node_generation', reportCount: 999999, totalOccurrences: 999999999 }])
    const result = annotateWithCommunityData([], store)
    const entry = result.communityOnly[0]!
    expect(entry).not.toHaveProperty('compositeScore')
    expect(entry).not.toHaveProperty('score')
    expect(entry).not.toHaveProperty('confidence')
    expect(entry).not.toHaveProperty('state')
  })
})
