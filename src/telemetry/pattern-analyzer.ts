import { writeFile, readFile as fsReadFile, appendFile, mkdir, rename } from 'node:fs/promises'
import { readTelemetryEvents } from './event-reader.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { RULE_MITIGATIONS, RULE_PIPELINE_STAGES, VALIDATOR_RULE_IDS, type PipelineStage } from '../validation/rule-metadata.js'

export interface CredentialFailure {
  type: string
  count: number
}

export type PatternState = 'draft' | 'confirmed' | 'resolved'
export type PatternTrend = 'new' | 'worsening' | 'stable' | 'improving'
export type { PipelineStage } from '../validation/rule-metadata.js'

export interface ScoringFactors {
  rawConfidence: number
  impact: number
  recency: number
  stickinessBoost: number
}

export interface Pattern {
  rule: number
  failureCount: number
  confidence: number
  compositeScore: number
  scoringFactors: ScoringFactors
  state: PatternState
  trend: PatternTrend
  pipelineStage: PipelineStage
  exampleMessages: string[]
  mitigation: string | null
  resolvedAt?: string
  regressed?: boolean
  workflowTypeBreakdown?: Record<string, number>
}

export interface DriftAlert {
  type: 'stale_pattern' | 'uncovered_rule' | 'missing_mitigation' | 'missing_stage_mapping'
  rule: number
  message: string
}

export interface DriftReport {
  healthy: boolean
  alerts: DriftAlert[]
  coveredRules: number
  totalRules: number
}

export interface WarningEffectiveness {
  rule: number
  timesWarned: number
  timesWarnedAndPassed: number
  timesWarnedAndFailed: number
  effectivenessRate: number
}

export interface SessionSummary {
  sessionId: string
  date: string
  description: string
  workflowType: string | null
  attempts: number
  success: boolean
  failedRules: number[]
  workflowName: string | null
}

export interface PatternAnalysis {
  schemaVersion: number
  generatedAt: string
  summary: {
    totalBuilds: number
    totalAttempts: number
    firstTryPassRate: number
    correctionRate: number
    singleAttemptFailRate: number
    avgDurationMs: number
    totalTokensInput: number
    totalTokensOutput: number
    attemptDistribution?: Record<number, number>
  }
  topFailureRules: Pattern[]
  failingCredentialTypes: CredentialFailure[]
  drift: DriftReport
  warningEffectiveness: WarningEffectiveness[]
  ruleCoOccurrence?: Array<{ rules: [number, number]; count: number }>
}

const PATTERN_SCHEMA_VERSION = 2


export class PatternAnalyzer {
  private readonly telemetryDir: string
  private readonly outputDir: string
  private _cachedEvents: Awaited<ReturnType<typeof readTelemetryEvents>> | null = null
  private _cachedPreviousPatterns: Pattern[] | null = null

  constructor(telemetryDir?: string) {
    const defaultDir = join(homedir(), '.kairos', 'telemetry')
    this.telemetryDir = telemetryDir ?? defaultDir
    this.outputDir = telemetryDir
      ? join(telemetryDir, '..')
      : join(homedir(), '.kairos')
  }

  private async loadPreviousPatterns(): Promise<Pattern[]> {
    if (this._cachedPreviousPatterns !== null) return this._cachedPreviousPatterns
    try {
      const raw = await fsReadFile(join(this.outputDir, 'patterns.json'), 'utf-8')
      const prev = JSON.parse(raw) as PatternAnalysis & { schemaVersion?: number }
      const version = prev.schemaVersion ?? 0
      const patterns = prev.topFailureRules ?? []
      this._cachedPreviousPatterns = version === PATTERN_SCHEMA_VERSION
        ? patterns
        : this.migratePatterns(patterns, version)
    } catch {
      this._cachedPreviousPatterns = []
    }
    return this._cachedPreviousPatterns
  }

  private migratePatterns(patterns: Pattern[], fromVersion: number): Pattern[] {
    let migrated = patterns
    if (fromVersion < 1) {
      migrated = migrated.map(p => ({
        ...p,
        compositeScore: p.compositeScore ?? 0,
        scoringFactors: p.scoringFactors ?? { rawConfidence: 0, impact: 0, recency: 0, stickinessBoost: 0 },
        pipelineStage: p.pipelineStage ?? ('node_generation' as PipelineStage),
      }))
    }
    if (fromVersion < 2) {
      migrated = migrated.map(p => {
        const sf = p.scoringFactors ?? { rawConfidence: 0, impact: 0, recency: 0, stickinessBoost: 0 }
        return {
          ...p,
          scoringFactors: {
            ...sf,
            stickinessBoost: sf.stickinessBoost ?? (sf as unknown as Record<string, number>)['validationBoost'] ?? 0,
          },
        }
      })
    }
    return migrated
  }

  async analyze(days = 30): Promise<PatternAnalysis> {
    const previousPatterns = await this.loadPreviousPatterns()
    const events = await this.readAllEvents(days)
    this._cachedEvents = events

    const starts = events.filter(e => e.eventType === 'build_start')
    const attempts = events.filter(e => e.eventType === 'generation_attempt')

    const _passed = attempts.filter(a =>
      (a.data as { validationPassed?: boolean }).validationPassed === true
    )
    const failed = attempts.filter(a =>
      (a.data as { validationPassed?: boolean }).validationPassed === false
    )

    const ruleFailures = new Map<number, { count: number; sessions: Set<string>; recencyWeights: number[]; allMessages: string[]; workflowTypes: Map<string, number> }>()
    const credentialFailures = new Map<string, number>()

    for (const a of failed) {
      const weight = this.recencyWeight(a.fileDate)
      const buildId = a.runId ?? a.sessionId
      const data = a.data as { issues?: Array<{ rule: number; severity?: string; message: string }>; workflowType?: string | null }
      for (const issue of data.issues ?? []) {
        if (issue.severity === 'warn') continue
        const entry = ruleFailures.get(issue.rule) ?? { count: 0, sessions: new Set<string>(), recencyWeights: [], allMessages: [], workflowTypes: new Map<string, number>() }
        entry.count++
        entry.sessions.add(buildId)
        entry.recencyWeights.push(weight)
        entry.allMessages.push(issue.message)
        if (data.workflowType) {
          entry.workflowTypes.set(data.workflowType, (entry.workflowTypes.get(data.workflowType) ?? 0) + 1)
        }
        ruleFailures.set(issue.rule, entry)

        if (issue.rule === 17) {
          const credPatterns = [
            /credential\s+"([^"]+)"/,
            /credentialType[:\s]+"?([^"'\s]+)"?/,
            /missing\s+credential\s+(?:for\s+)?["']?([^"'\s]+)/i,
          ]
          let credType = 'unknown'
          for (const re of credPatterns) {
            const m = issue.message.match(re)
            if (m?.[1]) { credType = m[1]; break }
          }
          credentialFailures.set(credType, (credentialFailures.get(credType) ?? 0) + 1)
        }
      }
    }

    // Event-weighted midpoint: find date where ~50% of failed events occurred before it
    const failedByDate = new Map<string, number>()
    for (const a of failed) {
      failedByDate.set(a.fileDate, (failedByDate.get(a.fileDate) ?? 0) + 1)
    }
    const sortedFailDates = [...failedByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const hasTrendData = sortedFailDates.length >= 3
    let midDate = ''
    if (hasTrendData) {
      const halfTotal = failed.length / 2
      let cumulative = 0
      for (const [date, count] of sortedFailDates) {
        cumulative += count
        if (cumulative >= halfTotal) { midDate = date; break }
      }
    }
    const ruleTrends = new Map<number, { older: number; newer: number }>()
    if (hasTrendData) {
      for (const a of failed) {
        const data = a.data as { issues?: Array<{ rule: number }> }
        const isNewer = a.fileDate > midDate
        for (const issue of data.issues ?? []) {
          const entry = ruleTrends.get(issue.rule) ?? { older: 0, newer: 0 }
          if (isNewer) entry.newer++
          else entry.older++
          ruleTrends.set(issue.rule, entry)
        }
      }
    }

    const sessions = new Map<string, typeof attempts>()
    for (const a of attempts) {
      const buildId = a.runId ?? a.sessionId
      const list = sessions.get(buildId) ?? []
      list.push(a)
      sessions.set(buildId, list)
    }

    let firstTryPass = 0
    let correctionNeeded = 0
    let singleAttemptFail = 0
    for (const sessionAttempts of sessions.values()) {
      const lastAttempt = sessionAttempts[sessionAttempts.length - 1]!
      const lastPassed = (lastAttempt.data as { validationPassed?: boolean }).validationPassed === true

      if (sessionAttempts.length === 1 && lastPassed) {
        firstTryPass++
      } else if (sessionAttempts.length > 1 && lastPassed) {
        correctionNeeded++
      } else {
        singleAttemptFail++
      }
    }

    const durations = attempts
      .map(a => (a.data as { durationMs?: number }).durationMs)
      .filter((d): d is number => typeof d === 'number' && d > 0)
    const avgDuration = durations.length > 0
      ? durations.reduce((s, d) => s + d, 0) / durations.length
      : 0

    const totalInput = attempts.reduce((s, a) =>
      s + ((a.data as { tokensInput?: number }).tokensInput ?? 0), 0)
    const totalOutput = attempts.reduce((s, a) =>
      s + ((a.data as { tokensOutput?: number }).tokensOutput ?? 0), 0)

    const totalSessions = Math.max(sessions.size, 1)

    // Stickiness: rules that persist across consecutive failed attempts within a build (LLM can't self-correct)
    const stickinessCount = new Map<number, number>()
    for (const sessionAttempts of sessions.values()) {
      if (sessionAttempts.length < 2) continue
      for (let i = 0; i < sessionAttempts.length - 1; i++) {
        const curr = sessionAttempts[i]!.data as { validationPassed?: boolean; issues?: Array<{ rule: number }> }
        const next = sessionAttempts[i + 1]!.data as { validationPassed?: boolean; issues?: Array<{ rule: number }> }
        if (curr.validationPassed !== false || next.validationPassed !== false) continue
        const currRules = new Set((curr.issues ?? []).map(iss => iss.rule))
        const nextRules = new Set((next.issues ?? []).map(iss => iss.rule))
        for (const rule of currRules) {
          if (nextRules.has(rule)) {
            stickinessCount.set(rule, (stickinessCount.get(rule) ?? 0) + 1)
          }
        }
      }
    }

    const CONFIRMED_THRESHOLD = 3
    const BUILDS_SINCE_LAST_FAILURE_THRESHOLD = 5
    const RESOLVED_TTL_DAYS = 90

    const activePatterns: Pattern[] = [...ruleFailures.entries()]
      .map(([rule, entry]) => {
        const t = ruleTrends.get(rule) ?? { older: 0, newer: 0 }
        const rawConfidence = Math.min(entry.sessions.size / totalSessions, 1)
        const state = (entry.count >= CONFIRMED_THRESHOLD ? 'confirmed' : 'draft') as PatternState
        const avgRecency = entry.recencyWeights.length > 0
          ? entry.recencyWeights.reduce((s, w) => s + w, 0) / entry.recencyWeights.length
          : 1
        const stickiness = stickinessCount.get(rule) ?? 0
        const { compositeScore, factors } = this.computeCompositeScore(rawConfidence, entry.count, state, avgRecency, stickiness)

        const pattern: Pattern = {
          rule,
          failureCount: entry.count,
          confidence: Math.round(rawConfidence * 1000) / 1000,
          compositeScore,
          scoringFactors: factors,
          state,
          trend: this.classifyTrend(t.older, t.newer),
          pipelineStage: RULE_PIPELINE_STAGES[rule] ?? 'node_generation' as PipelineStage,
          exampleMessages: this.deduplicateMessages(entry.allMessages),
          mitigation: RULE_MITIGATIONS[rule] ?? null,
        }

        if (entry.workflowTypes.size > 0) {
          pattern.workflowTypeBreakdown = Object.fromEntries(entry.workflowTypes)
        }

        return pattern
      })
      .sort((a, b) => b.compositeScore - a.compositeScore)

    const activeRules = new Set(activePatterns.map(p => p.rule))

    // Detect regressions: previously resolved rules that are failing again
    for (const p of activePatterns) {
      const prev = previousPatterns.find(pp => pp.rule === p.rule)
      if (prev?.state === 'resolved') {
        p.trend = 'worsening' as PatternTrend
        p.regressed = true
      }
    }

    // Per-rule last failure date for resolved threshold
    const ruleLastFailureDate = new Map<number, string>()
    for (const a of failed) {
      const data = a.data as { issues?: Array<{ rule: number }> }
      for (const issue of data.issues ?? []) {
        const existing = ruleLastFailureDate.get(issue.rule)
        if (!existing || a.fileDate > existing) {
          ruleLastFailureDate.set(issue.rule, a.fileDate)
        }
      }
    }

    // Newly resolved: previously confirmed, no longer failing, enough builds since last failure
    const newlyResolved: Pattern[] = previousPatterns
      .filter(p => {
        if (p.state !== 'confirmed' || activeRules.has(p.rule)) return false
        const lastFailDate = ruleLastFailureDate.get(p.rule) ?? ''
        const buildsSince = starts.filter(s => s.fileDate > lastFailDate).length
        return buildsSince >= BUILDS_SINCE_LAST_FAILURE_THRESHOLD
      })
      .map(p => ({
        ...p,
        state: 'resolved' as PatternState,
        trend: 'improving' as PatternTrend,
        pipelineStage: p.pipelineStage ?? RULE_PIPELINE_STAGES[p.rule] ?? 'node_generation' as PipelineStage,
        confidence: 0,
        compositeScore: 0,
        scoringFactors: { rawConfidence: 0, impact: 0, recency: 0, stickinessBoost: 0 },
        failureCount: 0,
        resolvedAt: new Date().toISOString(),
      }))

    // Carry forward resolved patterns within TTL
    const ttlCutoff = new Date()
    ttlCutoff.setDate(ttlCutoff.getDate() - RESOLVED_TTL_DAYS)
    const ttlCutoffStr = ttlCutoff.toISOString()

    const carriedResolved: Pattern[] = previousPatterns
      .filter(p => p.state === 'resolved' && !activeRules.has(p.rule)
        && (!p.resolvedAt || p.resolvedAt >= ttlCutoffStr))
      .map(p => ({ ...p }))

    // Carry forward confirmed patterns not yet meeting resolved threshold
    const newlyResolvedRules = new Set(newlyResolved.map(p => p.rule))
    const pendingResolution: Pattern[] = previousPatterns
      .filter(p => p.state === 'confirmed' && !activeRules.has(p.rule)
        && !newlyResolvedRules.has(p.rule))
      .map(p => ({ ...p }))

    const deduped = [
      ...newlyResolved,
      ...carriedResolved.filter(p => !newlyResolvedRules.has(p.rule)),
      ...pendingResolution,
    ]

    const patterns = [...activePatterns, ...deduped]

    const credTypes: CredentialFailure[] = [...credentialFailures.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }))

    const drift = this.detectDrift(patterns)

    // Warning effectiveness: track how often warned rules were prevented
    const warnEffMap = new Map<number, { warned: number; passed: number; failed: number }>()
    const buildCompletes = events.filter(e => e.eventType === 'build_complete')
    for (const bc of buildCompletes) {
      const bcData = bc.data as { warnedRules?: number[] }
      const warned = bcData.warnedRules ?? []
      if (warned.length === 0) continue

      const sessionFailedRules = new Set<number>()
      const sessionAttempts = sessions.get(bc.runId ?? bc.sessionId) ?? []
      for (const a of sessionAttempts) {
        const ad = a.data as { validationPassed?: boolean; issues?: Array<{ rule: number }> }
        if (ad.validationPassed === false) {
          for (const issue of ad.issues ?? []) {
            sessionFailedRules.add(issue.rule)
          }
        }
      }

      for (const rule of warned) {
        const entry = warnEffMap.get(rule) ?? { warned: 0, passed: 0, failed: 0 }
        entry.warned++
        if (sessionFailedRules.has(rule)) entry.failed++
        else entry.passed++
        warnEffMap.set(rule, entry)
      }
    }

    const warningEffectiveness: WarningEffectiveness[] = [...warnEffMap.entries()]
      .map(([rule, e]) => ({
        rule,
        timesWarned: e.warned,
        timesWarnedAndPassed: e.passed,
        timesWarnedAndFailed: e.failed,
        effectivenessRate: e.warned > 0 ? Math.round((e.passed / e.warned) * 1000) / 1000 : 0,
      }))
      .sort((a, b) => b.timesWarned - a.timesWarned)

    // A-3: Rule co-occurrence
    const coOccurrenceMap = new Map<string, number>()
    for (const a of failed) {
      const data = a.data as { issues?: Array<{ rule: number }> }
      const rules = [...new Set((data.issues ?? []).map(i => i.rule))].sort((x, y) => x - y)
      for (let i = 0; i < rules.length; i++) {
        for (let j = i + 1; j < rules.length; j++) {
          const key = `${rules[i]},${rules[j]}`
          coOccurrenceMap.set(key, (coOccurrenceMap.get(key) ?? 0) + 1)
        }
      }
    }
    const ruleCoOccurrence = [...coOccurrenceMap.entries()]
      .filter(([, count]) => count >= 3)
      .map(([key, count]) => {
        const [a, b] = key.split(',').map(Number)
        return { rules: [a!, b!] as [number, number], count }
      })
      .sort((a, b) => b.count - a.count)

    // A-5: Session depth (attempt distribution)
    const attemptDistribution: Record<number, number> = {}
    for (const sessionAttempts of sessions.values()) {
      const depth = sessionAttempts.length
      attemptDistribution[depth] = (attemptDistribution[depth] ?? 0) + 1
    }

    return {
      schemaVersion: PATTERN_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      summary: {
        totalBuilds: starts.length,
        totalAttempts: attempts.length,
        firstTryPassRate: Math.round((firstTryPass / totalSessions) * 1000) / 1000,
        correctionRate: Math.round((correctionNeeded / totalSessions) * 1000) / 1000,
        singleAttemptFailRate: Math.round((singleAttemptFail / totalSessions) * 1000) / 1000,
        avgDurationMs: Math.round(avgDuration),
        totalTokensInput: totalInput,
        totalTokensOutput: totalOutput,
        attemptDistribution,
      },
      topFailureRules: patterns,
      failingCredentialTypes: credTypes,
      drift,
      warningEffectiveness,
      ruleCoOccurrence,
    }
  }

  async analyzeAndSave(days = 30): Promise<PatternAnalysis> {
    const analysis = await this.analyze(days)
    await mkdir(this.outputDir, { recursive: true })
    const outputPath = join(this.outputDir, 'patterns.json')
    const tmpPath = `${outputPath}.tmp`
    await writeFile(tmpPath, JSON.stringify(analysis, null, 2), 'utf-8')
    await rename(tmpPath, outputPath)
    this._cachedPreviousPatterns = null  // invalidate so next loadPreviousPatterns reads fresh file

    const historySummary = {
      timestamp: analysis.generatedAt,
      totalBuilds: analysis.summary.totalBuilds,
      firstTryPassRate: analysis.summary.firstTryPassRate,
      correctionRate: analysis.summary.correctionRate,
      singleAttemptFailRate: analysis.summary.singleAttemptFailRate,
      activePatternCount: analysis.topFailureRules.filter(p => p.state !== 'resolved').length,
      topRules: analysis.topFailureRules.filter(p => p.state !== 'resolved').slice(0, 5)
        .map(p => ({ rule: p.rule, compositeScore: p.compositeScore, state: p.state })),
    }
    const historyPath = join(this.outputDir, 'pattern-history.jsonl')
    await appendFile(historyPath, JSON.stringify(historySummary) + '\n', 'utf-8')

    const sessions = await this.buildSessionSummaries(days)
    const sessionHistoryPath = join(this.outputDir, 'session-history.json')
    const sessionHistoryTmp = `${sessionHistoryPath}.tmp`
    await writeFile(sessionHistoryTmp, JSON.stringify(sessions, null, 2), 'utf-8')
    await rename(sessionHistoryTmp, sessionHistoryPath)

    return analysis
  }

  async getSessions(limit = 20): Promise<SessionSummary[]> {
    try {
      const raw = await fsReadFile(join(this.outputDir, 'session-history.json'), 'utf-8')
      const all = JSON.parse(raw) as SessionSummary[]
      return all.slice(-limit)
    } catch { return [] }
  }

  private async buildSessionSummaries(days = 30): Promise<SessionSummary[]> {
    const events = this._cachedEvents ?? await this.readAllEvents(days)
    const buildCompletes = events.filter(e => e.eventType === 'build_complete')
    const attemptsByBuild = new Map<string, typeof events>()
    for (const e of events.filter(e => e.eventType === 'generation_attempt')) {
      const buildId = e.runId ?? e.sessionId
      const list = attemptsByBuild.get(buildId) ?? []
      list.push(e)
      attemptsByBuild.set(buildId, list)
    }

    const summaries: SessionSummary[] = buildCompletes.map(bc => {
      const data = bc.data as {
        description?: string
        success?: boolean
        totalAttempts?: number
        workflowName?: string | null
        workflowType?: string | null
      }

      const sessionAttempts = attemptsByBuild.get(bc.runId ?? bc.sessionId) ?? []
      const failedRules = Array.from(new Set(
        sessionAttempts.flatMap(a => {
          const ad = a.data as { validationPassed?: boolean; issues?: Array<{ rule: number }> }
          if (ad.validationPassed !== false) return []
          return (ad.issues ?? []).map(i => i.rule)
        })
      ))

      return {
        sessionId: bc.runId ?? bc.sessionId,
        date: bc.fileDate,
        description: data.description ?? '',
        workflowType: data.workflowType ?? null,
        attempts: data.totalAttempts ?? 1,
        success: data.success ?? false,
        failedRules,
        workflowName: data.workflowName ?? null,
      }
    })

    return summaries.sort((a, b) => a.date.localeCompare(b.date))
  }

  async getHistory(limit = 20): Promise<unknown[]> {
    try {
      const raw = await fsReadFile(join(this.outputDir, 'pattern-history.jsonl'), 'utf-8')
      return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-limit)
    } catch { return [] }
  }

  static fromEnv(): PatternAnalyzer {
    const dir = process.env['KAIROS_TELEMETRY']
    return dir && dir !== 'true' && dir !== 'false'
      ? new PatternAnalyzer(dir)
      : new PatternAnalyzer()
  }

  private detectDrift(patterns: Pattern[]): DriftReport {
    const VALIDATOR_RULES = VALIDATOR_RULE_IDS
    const validatorRuleSet = new Set(VALIDATOR_RULES)
    const alerts: DriftAlert[] = []

    for (const p of patterns) {
      if (p.state !== 'resolved' && !validatorRuleSet.has(p.rule)) {
        alerts.push({
          type: 'stale_pattern',
          rule: p.rule,
          message: `Pattern references Rule ${p.rule} which does not exist in the current validator (not in VALIDATOR_RULE_IDS)`,
        })
      }
    }

    for (const rule of VALIDATOR_RULES) {
      if (!(rule in RULE_MITIGATIONS)) {
        alerts.push({
          type: 'missing_mitigation',
          rule,
          message: `Rule ${rule} has no mitigation text — if it fails, the system can't advise the LLM how to fix it`,
        })
      }
      if (!(rule in RULE_PIPELINE_STAGES)) {
        alerts.push({
          type: 'missing_stage_mapping',
          rule,
          message: `Rule ${rule} has no pipeline stage mapping — failures won't be grouped correctly`,
        })
      }
    }

    const coveredRules = VALIDATOR_RULES.filter(r => r in RULE_MITIGATIONS && r in RULE_PIPELINE_STAGES).length

    return {
      healthy: alerts.length === 0,
      alerts,
      coveredRules,
      totalRules: VALIDATOR_RULES.length,
    }
  }

  private computeCompositeScore(
    rawConfidence: number,
    sampleSize: number,
    state: PatternState,
    avgRecency: number,
    stickiness: number,
  ): { compositeScore: number; factors: ScoringFactors } {
    const stateWeights: Record<PatternState, number> = { draft: 0.3, confirmed: 0.8, resolved: 0.1 }
    const stateWeight = stateWeights[state]
    const impact = (1 - Math.exp(-sampleSize / 5)) * stateWeight
    const stickinessBoost = Math.min(0.15, stickiness * 0.05)
    const compositeScore = Math.min(Math.round((rawConfidence * impact * avgRecency * (1 + stickinessBoost)) * 1000) / 1000, 1)

    return {
      compositeScore,
      factors: {
        rawConfidence: Math.round(rawConfidence * 1000) / 1000,
        impact: Math.round(impact * 1000) / 1000,
        recency: Math.round(avgRecency * 1000) / 1000,
        stickinessBoost: Math.round(stickinessBoost * 1000) / 1000,
      },
    }
  }

  private classifyTrend(older: number, newer: number): PatternTrend {
    const total = older + newer
    if (total === 0) return 'stable'
    if (older === 0) return 'new'
    const newerRatio = newer / total
    if (newerRatio >= 0.65) return 'worsening'
    if (newerRatio <= 0.35) return 'improving'
    return 'stable'
  }

  private deduplicateMessages(messages: string[], maxCount = 3): string[] {
    const normalize = (msg: string) =>
      msg
        .replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '...')
        .replace(/\bnode\s+"[^"]+"/g, 'node "..."')
        .replace(/\s+/g, ' ')
        .trim()

    const seen = new Set<string>()
    const unique: string[] = []
    for (const msg of messages) {
      const key = normalize(msg)
      if (!seen.has(key) && unique.length < maxCount) {
        seen.add(key)
        unique.push(msg)
      }
    }
    return unique
  }

  private recencyWeight(fileDate: string, halfLifeDays = 30): number {
    const daysAgo = Math.max(0, (Date.now() - new Date(fileDate + 'T12:00:00Z').getTime()) / (1000 * 60 * 60 * 24))
    return Math.max(0.1, Math.exp(-Math.LN2 * daysAgo / halfLifeDays))
  }

  private async readAllEvents(days: number) {
    return readTelemetryEvents(this.telemetryDir, days)
  }
}
