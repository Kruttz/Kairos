import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WhitelistedPattern, PatternShareReport } from './whitelist.js'

/**
 * Ingestion (docs/plans/reliability-suite-plan.md §10.4), scoped small and experimental per
 * Jordan's explicit 2026-07-19 instruction: local/explicit ingestion only, no marketplace, no
 * moderation system, no accounts. A "community corpus" today is nothing more than whatever a
 * maintainer hand-copies from reviewed GitHub issues (see share.ts) into one file -- there is
 * no automated merge/dedup/review pipeline, deliberately, because building one before any real
 * submissions exist would be platform-shaped speculation, exactly what was ruled out.
 *
 * The single most important property of this module: it is a dead end for data, not a
 * junction. `aggregateCommunityPatterns` and everything downstream of it only ever produces
 * CommunityPatternRecord -- a type with no `compositeScore`, no `state`, nothing that could be
 * mistaken for or merged into a local Pattern. src/telemetry/pattern-analyzer.ts does not
 * import anything from this module (enforced by module-boundaries.test.ts's reverse check) --
 * community data cannot reach local scoring, not by discipline, by the absence of any code
 * path that could carry it there.
 *
 * Input format deliberately reuses WhitelistedPattern/PatternShareReport (whitelist.ts) rather
 * than inventing a second wire type -- the file `kairos patterns share` writes on one machine
 * is already valid input to `kairos patterns ingest` on another, including the trivial
 * self-consistency case of ingesting your own prior share report.
 */

export interface CommunityPatternRecord {
  rule: number
  pipelineStage: string
  reportCount: number
  totalOccurrences: number
}

export interface CommunityPatternStore {
  ingestedAt: string
  provenance: 'community'
  entries: CommunityPatternRecord[]
}

function communityStorePath(): string {
  return join(homedir(), '.kairos', 'community-patterns.json')
}

/** Pure aggregation: one or more share-report-shaped inputs, collapsed to one record per rule.
 * `reportCount` counts how many source entries mentioned the rule (a rough proxy for "how many
 * installs saw this"); `totalOccurrences` sums their failureCount. Neither number is a
 * confidence score, a composite score, or anything else that resembles the local Pattern
 * scoring machinery -- deliberately, so there is nothing here that could be confused for one. */
export function aggregateCommunityPatterns(reports: Array<Pick<PatternShareReport, 'patterns'>>): CommunityPatternStore {
  const byRule = new Map<number, CommunityPatternRecord>()

  for (const report of reports) {
    for (const p of report.patterns) {
      const existing = byRule.get(p.rule)
      if (existing) {
        existing.reportCount += 1
        existing.totalOccurrences += p.failureCount
      } else {
        byRule.set(p.rule, {
          rule: p.rule,
          pipelineStage: p.pipelineStage,
          reportCount: 1,
          totalOccurrences: p.failureCount,
        })
      }
    }
  }

  return {
    ingestedAt: new Date().toISOString(),
    provenance: 'community',
    entries: [...byRule.values()].sort((a, b) => a.rule - b.rule),
  }
}

function isWhitelistedPatternShape(v: unknown): v is WhitelistedPattern {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r['kind'] === 'validator-rule'
    && typeof r['rule'] === 'number'
    && typeof r['pipelineStage'] === 'string'
    && typeof r['failureCount'] === 'number'
    && typeof r['confidence'] === 'number'
}

/** Validates untrusted parsed JSON against the exact shape ingestion is willing to trust,
 * rather than assuming a file (local or fetched) is well-formed. A malformed or malicious
 * entry is dropped, not fatal to the rest of a real file. */
export function parseShareReportFile(raw: string): Pick<PatternShareReport, 'patterns'> {
  const parsed: unknown = JSON.parse(raw)
  const patternsRaw = (parsed as { patterns?: unknown })?.patterns
  if (!Array.isArray(patternsRaw)) return { patterns: [] }
  return { patterns: patternsRaw.filter(isWhitelistedPatternShape) }
}

/** Reads one local file (no network), aggregates it, and overwrites ~/.kairos/community-
 * patterns.json. Overwrite, not accumulate-across-calls -- deliberately simple for this
 * experimental first version; re-ingesting the same or a newer file is the whole update model. */
export async function ingestCommunityPatternsFromFile(path: string): Promise<CommunityPatternStore> {
  const raw = await readFile(path, 'utf-8')
  const report = parseShareReportFile(raw)
  const store = aggregateCommunityPatterns([report])
  await writeCommunityPatternStore(store)
  return store
}

async function writeCommunityPatternStore(store: CommunityPatternStore): Promise<void> {
  const path = communityStorePath()
  await mkdir(join(homedir(), '.kairos'), { recursive: true })
  await writeFile(path, JSON.stringify(store, null, 2) + '\n', 'utf-8')
  await chmod(path, 0o600)
}

/** Returns null, not a throw, when nothing has been ingested yet -- "no community data" is the
 * default, expected state for this experimental feature, not an error. */
export async function loadCommunityPatternStore(): Promise<CommunityPatternStore | null> {
  try {
    const raw = await readFile(communityStorePath(), 'utf-8')
    return JSON.parse(raw) as CommunityPatternStore
  } catch {
    return null
  }
}

/** The one network-capable path this feature adds: a single explicit fetch, no retries, no
 * polling, no default URL (there is no real hosted community corpus yet -- implying one exists
 * via a plausible-looking default would be dishonest for a feature this experimental). Reuses
 * the exact same shape-validation and aggregation as the local-file path; a fetched response is
 * untrusted input exactly like a local file is. */
export async function syncCommunityPatternsFromUrl(url: string): Promise<CommunityPatternStore> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`kairos patterns sync: fetching ${url} returned HTTP ${response.status}`)
  }
  const raw = await response.text()
  const report = parseShareReportFile(raw)
  const store = aggregateCommunityPatterns([report])
  await writeCommunityPatternStore(store)
  return store
}

export interface CommunityAnnotations {
  /** Keyed by rule number -- only for rules where a local Pattern already exists. */
  localMatches: Map<number, CommunityPatternRecord>
  /** Community records with no corresponding local Pattern at all -- unconfirmed locally. */
  communityOnly: CommunityPatternRecord[]
}

/** Pure display-composition: splits a community store's entries by whether this install's own
 * local telemetry has independently produced a Pattern for the same rule ("corroboration").
 * Deliberately produces no ranking, no merged list, no score -- callers render `localMatches`
 * as an inline annotation next to the existing local pattern line, and `communityOnly` in a
 * separate, always-lower-priority section. There is no code path here by which a community
 * record could be sorted into or above the local ranked list. */
export function annotateWithCommunityData(localPatterns: Array<{ rule: number }>, community: CommunityPatternStore | null): CommunityAnnotations {
  if (!community) return { localMatches: new Map(), communityOnly: [] }
  const localRules = new Set(localPatterns.map(p => p.rule))
  const localMatches = new Map<number, CommunityPatternRecord>()
  const communityOnly: CommunityPatternRecord[] = []
  for (const entry of community.entries) {
    if (localRules.has(entry.rule)) localMatches.set(entry.rule, entry)
    else communityOnly.push(entry)
  }
  return { localMatches, communityOnly }
}
