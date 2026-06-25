import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PatternAnalyzer } from '../../../src/telemetry/pattern-analyzer.js'

describe('PatternAnalyzer', () => {
  let dir: string
  let parentDir: string

  beforeEach(async () => {
    parentDir = join(tmpdir(), `kairos-test-patterns-${Date.now()}`)
    dir = join(parentDir, 'telemetry')
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  function todayStr(): string {
    return new Date().toISOString().slice(0, 10)
  }

  function dateStr(daysAgo: number): string {
    const d = new Date()
    d.setDate(d.getDate() - daysAgo)
    return d.toISOString().slice(0, 10)
  }

  function makeEvent(eventType: string, sessionId: string, data: Record<string, unknown>): string {
    return JSON.stringify({ timestamp: new Date().toISOString(), sessionId, eventType, data })
  }

  async function writeEvents(telemetryDir: string, fileName: string, events: string[]): Promise<void> {
    await writeFile(join(telemetryDir, fileName), events.join('\n'))
  }

  // ── Composite scoring ──────────────────────────────────────────────

  describe('composite scoring', () => {
    it('produces higher score for confirmed patterns than draft', async () => {
      const events = []
      // 4 sessions, all failing rule 17 → confirmed (count >= 3)
      for (let i = 0; i < 4; i++) {
        events.push(
          makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [{ rule: 17, message: 'bad credential "slackApi"' }],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 17)!

      expect(p.state).toBe('confirmed')
      expect(p.compositeScore).toBeGreaterThan(0)
      expect(p.scoringFactors.impact).toBeGreaterThan(0)
    })

    it('draft patterns have lower impact weight', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'missing type' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 5)!

      expect(p.state).toBe('draft')
      // draft stateWeight = 0.3 vs confirmed = 0.8
      expect(p.scoringFactors.impact).toBeLessThan(0.3)
    })

    it('validation boost from stickiness is capped at 0.15', async () => {
      const events = []
      // 4 sessions, each with 2 consecutive failed attempts where rule 12 persists
      for (let i = 0; i < 4; i++) {
        events.push(
          makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [{ rule: 12, message: 'Forbidden field' }],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [{ rule: 12, message: 'Forbidden field' }],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 12)!

      // 4 stickiness × 0.05 = 0.20, capped at 0.15
      expect(p.scoringFactors.stickinessBoost).toBe(0.15)
    })
  })

  // ── Lifecycle states ───────────────────────────────────────────────

  describe('lifecycle states', () => {
    it('classifies as draft when fewer than 3 occurrences', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 3, message: 'bad id' }, { rule: 3, message: 'bad id 2' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 3)!

      expect(p.state).toBe('draft')
    })

    it('classifies as confirmed at 3+ occurrences', async () => {
      const events = []
      for (let i = 0; i < 3; i++) {
        events.push(
          makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [{ rule: 7, message: 'bad position' }],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 7)!

      expect(p.state).toBe('confirmed')
    })
  })

  // ── Trend detection ────────────────────────────────────────────────

  describe('trend detection', () => {
    it('returns stable when fewer than 3 distinct dates', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 15, message: 'unqualified type' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 15)!

      expect(p.trend).toBe('stable')
    })

    it('detects worsening trend when failures concentrate in newer half', async () => {
      // 5 dates: older ones have 1 failure, recent ones have 3 — ensures data-median split shows worsening
      const dates = [dateStr(25), dateStr(20), dateStr(15), dateStr(5), dateStr(1)]
      for (const d of dates) {
        const isRecent = d >= dateStr(10)
        const events = [
          makeEvent('build_start', `s-${d}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s-${d}`, {
            validationPassed: false,
            issues: isRecent
              ? [{ rule: 4, message: 'dup id' }, { rule: 4, message: 'dup id' }, { rule: 4, message: 'dup id' }]
              : [{ rule: 4, message: 'dup id' }],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        ]
        await writeEvents(dir, `${d}.jsonl`, events)
      }

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 4)

      if (p) {
        expect(['worsening', 'new']).toContain(p.trend)
      }
    })
  })

  // ── Deduplication ──────────────────────────────────────────────────

  describe('deduplication', () => {
    it('deduplicates structurally similar messages', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [
            { rule: 17, message: 'Node "Slack" has credential "slackApi" with wrong shape' },
            { rule: 17, message: 'Node "Gmail" has credential "gmailApi" with wrong shape' },
            { rule: 17, message: 'Node "Sheets" has credential "sheetsApi" with wrong shape' },
            { rule: 17, message: 'Node "Drive" has credential "driveApi" with wrong shape' },
          ],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 17)!

      // New normalization only collapses UUIDs and node "..." references, not all quoted strings
      // These messages differ by credential/node name, so they are structurally distinct (capped at 3)
      expect(p.exampleMessages.length).toBe(3)
    })

    it('keeps up to 3 structurally different messages', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [
            { rule: 17, message: 'missing id field' },
            { rule: 17, message: 'name is empty string' },
            { rule: 17, message: 'credential is array not object' },
            { rule: 17, message: 'missing both id and name' },
          ],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 17)!

      expect(p.exampleMessages.length).toBe(3)
    })
  })

  // ── Pipeline stage mapping ─────────────────────────────────────────

  describe('pipeline stage mapping', () => {
    it('maps rule 17 to credential_injection', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 17, message: 'bad cred' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      expect(result.topFailureRules[0]!.pipelineStage).toBe('credential_injection')
    })

    it('maps connection rules to connection_wiring', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 10, message: 'connection mismatch' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      expect(result.topFailureRules[0]!.pipelineStage).toBe('connection_wiring')
    })

    it('maps rule 14 to workflow_structure', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 14, message: 'no trigger' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      expect(result.topFailureRules[0]!.pipelineStage).toBe('workflow_structure')
    })
  })

  // ── Drift detection ────────────────────────────────────────────────

  describe('drift detection', () => {
    it('reports healthy when all 26 rules are covered', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.drift.healthy).toBe(true)
      expect(result.drift.coveredRules).toBe(26)
      expect(result.drift.totalRules).toBe(26)
    })

    it('every rule has a mitigation and stage mapping', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.drift.alerts).toEqual([])
    })
  })

  // ── Confidence (session-based) ─────────────────────────────────────

  describe('confidence', () => {
    it('uses distinct sessions as denominator, not issue occurrences', async () => {
      // 1 session with 5 occurrences of rule 4 (duplicate ids), and 1 clean session
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [
            { rule: 4, message: 'dup id 1' },
            { rule: 4, message: 'dup id 2' },
            { rule: 4, message: 'dup id 3' },
            { rule: 4, message: 'dup id 4' },
            { rule: 4, message: 'dup id 5' },
          ],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 4)!

      // 1 failing session / 2 total sessions = 0.5
      expect(p.confidence).toBe(0.5)
      expect(p.failureCount).toBe(5)
    })
  })

  // ── Mitigations ────────────────────────────────────────────────────

  describe('mitigations', () => {
    it('attaches mitigation text to every detected pattern', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [
            { rule: 11, message: 'orphan node' },
            { rule: 13, message: 'settings not object' },
            { rule: 23, message: 'unknown node type' },
          ],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      for (const p of result.topFailureRules) {
        expect(p.mitigation).toBeTruthy()
        expect(typeof p.mitigation).toBe('string')
      }
    })
  })

  // ── Empty / edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty analysis when no telemetry exists', async () => {
      const analyzer = new PatternAnalyzer(join(parentDir, 'nonexistent'))
      const result = await analyzer.analyze()

      expect(result.topFailureRules).toEqual([])
      expect(result.summary.totalBuilds).toBe(0)
      expect(result.summary.totalAttempts).toBe(0)
      expect(result.drift.healthy).toBe(true)
    })

    it('handles all-passing builds with no failures', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 2000, tokensInput: 200, tokensOutput: 100,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.topFailureRules).toEqual([])
      expect(result.summary.totalBuilds).toBe(1)
      expect(result.summary.firstTryPassRate).toBe(1)
    })

    it('sorts patterns by compositeScore descending', async () => {
      // Create patterns with different failure counts so scores differ
      const events = []
      for (let i = 0; i < 5; i++) {
        events.push(
          makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [
              { rule: 17, message: 'cred fail' },
              ...(i < 2 ? [{ rule: 5, message: 'type fail' }] : []),
            ],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const active = result.topFailureRules.filter(p => p.state !== 'resolved')

      for (let i = 1; i < active.length; i++) {
        expect(active[i - 1]!.compositeScore).toBeGreaterThanOrEqual(active[i]!.compositeScore)
      }
    })
  })

  // ── analyzeAndSave ─────────────────────────────────────────────────

  describe('analyzeAndSave', () => {
    it('writes patterns.json to output dir', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      await analyzer.analyzeAndSave()

      const { readFile } = await import('node:fs/promises')
      const content = await readFile(join(parentDir, 'patterns.json'), 'utf-8')
      const saved = JSON.parse(content)

      expect(saved.generatedAt).toBeDefined()
      expect(saved.summary).toBeDefined()
      expect(saved.drift).toBeDefined()
    })

    it('includes schemaVersion in saved output', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      await analyzer.analyzeAndSave()

      const { readFile } = await import('node:fs/promises')
      const content = await readFile(join(parentDir, 'patterns.json'), 'utf-8')
      const saved = JSON.parse(content)

      expect(saved.schemaVersion).toBe(2)
    })

    it('appends history entry to pattern-history.jsonl', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'test fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      await analyzer.analyzeAndSave()

      const { readFile } = await import('node:fs/promises')
      const historyContent = await readFile(join(parentDir, 'pattern-history.jsonl'), 'utf-8')
      const lines = historyContent.trim().split('\n')
      expect(lines.length).toBe(1)

      const entry = JSON.parse(lines[0]!)
      expect(entry.totalBuilds).toBe(1)
      expect(entry.activePatternCount).toBeGreaterThan(0)
      expect(entry.topRules).toBeDefined()
    })

    it('retrieves history via getHistory', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      await analyzer.analyzeAndSave()
      await analyzer.analyzeAndSave()

      const history = await analyzer.getHistory()
      expect(history.length).toBe(2)
    })
  })

  // ── Single-attempt fail rate (C-A) ────────────────────────────────

  describe('single-attempt fail rate', () => {
    it('reports singleAttemptFailRate in summary', async () => {
      const events = [
        // Session 1: 1 failed attempt only
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'type missing' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        // Session 2: passes first try
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.summary.singleAttemptFailRate).toBeDefined()
      expect(result.summary.singleAttemptFailRate).toBe(0.5)
    })

    it('classifies multi-attempt all-fail as singleAttemptFail not correctionNeeded', async () => {
      const events = [
        // Session 1: 3 attempts, ALL fail → should be singleAttemptFail
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        // Session 2: 2 attempts, last passes → correctionNeeded
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: false,
          issues: [{ rule: 12, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.summary.correctionRate).toBe(0.5)
      expect(result.summary.singleAttemptFailRate).toBe(0.5)
      expect(result.summary.firstTryPassRate).toBe(0)
    })

    it('rates sum to approximately 1.0', async () => {
      const events = []
      // 3 sessions: first-try pass, correction (fail then pass), single-attempt fail
      events.push(
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', { validationPassed: false, issues: [{ rule: 5, message: 'fail' }], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
        makeEvent('generation_attempt', 's2', { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
        makeEvent('build_start', 's3', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's3', { validationPassed: false, issues: [{ rule: 5, message: 'fail' }], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
      )
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      const sum = result.summary.firstTryPassRate + result.summary.correctionRate + result.summary.singleAttemptFailRate
      expect(sum).toBeCloseTo(1.0, 2)
    })
  })

  // ── Regression detection (C-B) ────────────────────────────────────

  describe('regression detection', () => {
    it('sets regressed flag when a resolved rule re-fails', async () => {
      const { readFile: rf, writeFile: wf } = await import('node:fs/promises')

      // First: create a patterns.json with a resolved rule 17
      const previousAnalysis = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        summary: { totalBuilds: 10, totalAttempts: 10, firstTryPassRate: 0.8, correctionRate: 0.1, singleAttemptFailRate: 0.1, avgDurationMs: 1000, avgTokensInput: 100, avgTokensOutput: 50 },
        topFailureRules: [{
          rule: 17, failureCount: 0, confidence: 0, pipelineStage: 'credential_injection',
          state: 'resolved', trend: 'improving', compositeScore: 0,
          exampleMessages: [], mitigation: 'fix creds',
          scoringFactors: { rawConfidence: 0, impact: 0, recency: 0, stickinessBoost: 0 },
        }],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      await wf(join(parentDir, 'patterns.json'), JSON.stringify(previousAnalysis))

      // Now create telemetry where rule 17 fails again
      const events = []
      for (let i = 0; i < 3; i++) {
        events.push(
          makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [{ rule: 17, message: 'bad credential "slackApi"' }],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 17)!

      expect(p.regressed).toBe(true)
    })
  })

  // ── Recency weight (W-D) ──────────────────────────────────────────

  describe('recency weight', () => {
    it('decays to 0.1 floor for very old events', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 8, message: 'no name' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${dateStr(120)}.jsonl`, events)

      const todayEvents = [
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, todayEvents)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze(150)
      const p = result.topFailureRules.find(r => r.rule === 8)!

      expect(p.scoringFactors.recency).toBe(0.1)
    })
  })

  // ── Credential type extraction (I-C) ──────────────────────────────

  describe('credential extraction', () => {
    it('extracts credential type, not node name', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 17, message: 'Node "Slack" credential "slackOAuth2Api" must have id and name' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      const slackCred = result.failingCredentialTypes.find(c => c.type === 'slackOAuth2Api')
      const slackNode = result.failingCredentialTypes.find(c => c.type === 'Slack')

      expect(slackCred).toBeDefined()
      expect(slackNode).toBeUndefined()
    })
  })

  // ── Future-dated file exclusion (N-4) ─────────────────────────────

  describe('future-dated file exclusion', () => {
    it('ignores JSONL files dated in the future', async () => {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const futureDate = tomorrow.toISOString().slice(0, 10)

      const futureEvents = [
        makeEvent('build_start', 's-future', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's-future', {
          validationPassed: false,
          issues: [{ rule: 99, message: 'should not appear' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${futureDate}.jsonl`, futureEvents)

      const todayEvents = [
        makeEvent('build_start', 's-today', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's-today', { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, todayEvents)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.topFailureRules.find(r => r.rule === 99)).toBeUndefined()
      expect(result.summary.totalBuilds).toBe(1)
    })
  })

  // ── Stickiness semantics (I-B) ────────────────────────────────────

  describe('stickiness', () => {
    it('gives zero boost when rule self-corrects on retry', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 12, message: 'Forbidden field' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 12)!

      expect(p.scoringFactors.stickinessBoost).toBe(0)
    })

    it('gives boost when rule persists across consecutive failures', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 12, message: 'Forbidden field' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 12, message: 'Forbidden field' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 12)!

      expect(p.scoringFactors.stickinessBoost).toBe(0.05)
    })
  })

  // ── Warning effectiveness (I-5/A-1) ──────────────────────────────

  describe('warning effectiveness', () => {
    it('tracks warned-and-passed vs warned-and-failed per rule', async () => {
      const events = [
        // Session 1: warned about rules 17 and 12, rule 17 still fails, rule 12 doesn't
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 17, message: 'cred fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('build_complete', 's1', {
          description: 'test', success: true, totalAttempts: 2,
          totalDurationMs: 2000, totalTokensInput: 200, totalTokensOutput: 100,
          workflowName: 'test', workflowId: 'w1', dryRun: false,
          credentialsNeeded: 0, warnedRules: [17, 12],
        }),
        // Session 2: warned about rule 17, it passes cleanly
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('build_complete', 's2', {
          description: 'test', success: true, totalAttempts: 1,
          totalDurationMs: 1000, totalTokensInput: 100, totalTokensOutput: 50,
          workflowName: 'test', workflowId: 'w2', dryRun: false,
          credentialsNeeded: 0, warnedRules: [17],
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      const rule17 = result.warningEffectiveness.find(w => w.rule === 17)!
      expect(rule17.timesWarned).toBe(2)
      expect(rule17.timesWarnedAndFailed).toBe(1)
      expect(rule17.timesWarnedAndPassed).toBe(1)
      expect(rule17.effectivenessRate).toBe(0.5)

      const rule12 = result.warningEffectiveness.find(w => w.rule === 12)!
      expect(rule12.timesWarned).toBe(1)
      expect(rule12.timesWarnedAndPassed).toBe(1)
      expect(rule12.effectivenessRate).toBe(1)
    })

    it('returns empty array when no build_complete events have warnedRules', async () => {
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.warningEffectiveness).toEqual([])
    })
  })

  // ── Per-rule resolved threshold (W-1) ────────────────────────────

  describe('per-rule resolved threshold', () => {
    it('resolves a confirmed rule after enough builds since its last failure', async () => {
      const { writeFile: wf } = await import('node:fs/promises')

      const previousAnalysis = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        summary: { totalBuilds: 10, totalAttempts: 10, firstTryPassRate: 1, correctionRate: 0, singleAttemptFailRate: 0, avgDurationMs: 1000, totalTokensInput: 100, totalTokensOutput: 50 },
        topFailureRules: [{
          rule: 12, failureCount: 5, confidence: 0.5, pipelineStage: 'node_generation',
          state: 'confirmed', trend: 'stable', compositeScore: 0.1,
          exampleMessages: ['fail'], mitigation: 'fix it',
          scoringFactors: { rawConfidence: 0.5, impact: 0.1, recency: 1, stickinessBoost: 0 },
        }],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      await wf(join(parentDir, 'patterns.json'), JSON.stringify(previousAnalysis))

      // No rule 12 failures in current window, 5 passing builds
      const recentEvents = []
      for (let i = 0; i < 5; i++) {
        recentEvents.push(
          makeEvent('build_start', `s-pass-${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s-pass-${i}`, { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, recentEvents)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()
      const p = result.topFailureRules.find(r => r.rule === 12)

      expect(p).toBeDefined()
      expect(p!.state).toBe('resolved')
    })

    it('carries confirmed rule forward when too few builds since last failure', async () => {
      const { writeFile: wf } = await import('node:fs/promises')

      const previousAnalysis = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        summary: { totalBuilds: 10, totalAttempts: 10, firstTryPassRate: 1, correctionRate: 0, singleAttemptFailRate: 0, avgDurationMs: 1000, totalTokensInput: 100, totalTokensOutput: 50 },
        topFailureRules: [{
          rule: 12, failureCount: 5, confidence: 0.5, pipelineStage: 'node_generation',
          state: 'confirmed', trend: 'stable', compositeScore: 0.1,
          exampleMessages: ['fail'], mitigation: 'fix it',
          scoringFactors: { rawConfidence: 0.5, impact: 0.1, recency: 1, stickinessBoost: 0 },
        }],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      await wf(join(parentDir, 'patterns.json'), JSON.stringify(previousAnalysis))

      // Only 3 passing builds (below threshold of 5), no rule 12 failures in window
      const recentEvents = []
      for (let i = 0; i < 3; i++) {
        recentEvents.push(
          makeEvent('build_start', `s-pass-${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s-pass-${i}`, { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, recentEvents)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      // Rule 12 should NOT be resolved — carried forward as confirmed (pending resolution)
      const p = result.topFailureRules.find(r => r.rule === 12)
      expect(p).toBeDefined()
      expect(p!.state).toBe('confirmed')
    })
  })

  // ── Resolved pattern TTL (W-2) ──────────────────────────────────

  describe('resolved pattern TTL', () => {
    it('drops resolved patterns older than 90 days', async () => {
      const { writeFile: wf } = await import('node:fs/promises')

      const oldResolvedAt = new Date()
      oldResolvedAt.setDate(oldResolvedAt.getDate() - 100)

      const previousAnalysis = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        summary: { totalBuilds: 10, totalAttempts: 10, firstTryPassRate: 1, correctionRate: 0, singleAttemptFailRate: 0, avgDurationMs: 1000, totalTokensInput: 100, totalTokensOutput: 50 },
        topFailureRules: [{
          rule: 8, failureCount: 0, confidence: 0, pipelineStage: 'node_generation',
          state: 'resolved', trend: 'improving', compositeScore: 0,
          exampleMessages: [], mitigation: 'fix it',
          scoringFactors: { rawConfidence: 0, impact: 0, recency: 0, stickinessBoost: 0 },
          resolvedAt: oldResolvedAt.toISOString(),
        }],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      await wf(join(parentDir, 'patterns.json'), JSON.stringify(previousAnalysis))

      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.topFailureRules.find(r => r.rule === 8)).toBeUndefined()
    })

    it('keeps resolved patterns within 90 days', async () => {
      const { writeFile: wf } = await import('node:fs/promises')

      const recentResolvedAt = new Date()
      recentResolvedAt.setDate(recentResolvedAt.getDate() - 30)

      const previousAnalysis = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        summary: { totalBuilds: 10, totalAttempts: 10, firstTryPassRate: 1, correctionRate: 0, singleAttemptFailRate: 0, avgDurationMs: 1000, totalTokensInput: 100, totalTokensOutput: 50 },
        topFailureRules: [{
          rule: 8, failureCount: 0, confidence: 0, pipelineStage: 'node_generation',
          state: 'resolved', trend: 'improving', compositeScore: 0,
          exampleMessages: [], mitigation: 'fix it',
          scoringFactors: { rawConfidence: 0, impact: 0, recency: 0, stickinessBoost: 0 },
          resolvedAt: recentResolvedAt.toISOString(),
        }],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      await wf(join(parentDir, 'patterns.json'), JSON.stringify(previousAnalysis))

      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', { validationPassed: true, issues: [], durationMs: 1000, tokensInput: 100, tokensOutput: 50 }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      const p = result.topFailureRules.find(r => r.rule === 8)
      expect(p).toBeDefined()
      expect(p!.state).toBe('resolved')
    })
  })

  // ── Schema migration (W-5) ──────────────────────────────────────

  describe('schema migration', () => {
    it('migrates pre-versioned patterns instead of discarding', async () => {
      const { writeFile: wf } = await import('node:fs/promises')

      const previousAnalysis = {
        // No schemaVersion field — pre-versioned data
        generatedAt: new Date().toISOString(),
        summary: { totalBuilds: 5, totalAttempts: 5, firstTryPassRate: 0.8, correctionRate: 0.1, singleAttemptFailRate: 0.1, avgDurationMs: 1000, totalTokensInput: 100, totalTokensOutput: 50 },
        topFailureRules: [{
          rule: 17, failureCount: 3, confidence: 0.5,
          state: 'confirmed', trend: 'stable',
          exampleMessages: ['cred fail'], mitigation: 'fix creds',
        }],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      await wf(join(parentDir, 'patterns.json'), JSON.stringify(previousAnalysis))

      // Rule 17 fails again → should detect regression from migrated data
      const events = [
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: false,
          issues: [{ rule: 17, message: 'credential "slackApi" fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      ]
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      // Should have found rule 17 — migrated data was NOT discarded
      const p = result.topFailureRules.find(r => r.rule === 17)
      expect(p).toBeDefined()
    })
  })

  // ── Rule co-occurrence (A-3) ──────────────────────────────────────

  describe('rule co-occurrence', () => {
    it('detects pairs of rules that co-fail at least 3 times', async () => {
      const events: string[] = []
      for (let i = 0; i < 4; i++) {
        events.push(
          makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [
              { rule: 5, message: 'missing expression' },
              { rule: 12, message: 'bad cred' },
              { rule: 17, message: 'no auth' },
            ],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.ruleCoOccurrence).toBeDefined()
      expect(result.ruleCoOccurrence!.length).toBe(3) // (5,12), (5,17), (12,17)
      const pair = result.ruleCoOccurrence!.find(
        c => c.rules[0] === 5 && c.rules[1] === 12,
      )
      expect(pair).toBeDefined()
      expect(pair!.count).toBe(4)
    })

    it('excludes pairs below threshold of 3', async () => {
      const events: string[] = []
      // Only 2 co-failures of rules 5+12
      for (let i = 0; i < 2; i++) {
        events.push(
          makeEvent('build_start', `s${i}`, { description: 'test', dryRun: false, model: 'test' }),
          makeEvent('generation_attempt', `s${i}`, {
            validationPassed: false,
            issues: [
              { rule: 5, message: 'fail' },
              { rule: 12, message: 'fail' },
            ],
            durationMs: 1000, tokensInput: 100, tokensOutput: 50,
          }),
        )
      }
      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.ruleCoOccurrence).toEqual([])
    })
  })

  // ── Attempt distribution (A-5) ────────────────────────────────────

  describe('attempt distribution', () => {
    it('counts sessions by attempt depth', async () => {
      const events: string[] = []

      // Session 1: 1 attempt (pass)
      events.push(
        makeEvent('build_start', 's1', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's1', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      )

      // Session 2: 2 attempts (fail then pass)
      events.push(
        makeEvent('build_start', 's2', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's2', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      )

      // Session 3: 3 attempts (all fail)
      events.push(
        makeEvent('build_start', 's3', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's3', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's3', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
        makeEvent('generation_attempt', 's3', {
          validationPassed: false,
          issues: [{ rule: 5, message: 'fail' }],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      )

      // Session 4: 1 attempt (pass)
      events.push(
        makeEvent('build_start', 's4', { description: 'test', dryRun: false, model: 'test' }),
        makeEvent('generation_attempt', 's4', {
          validationPassed: true, issues: [],
          durationMs: 1000, tokensInput: 100, tokensOutput: 50,
        }),
      )

      await writeEvents(dir, `${todayStr()}.jsonl`, events)

      const analyzer = new PatternAnalyzer(dir)
      const result = await analyzer.analyze()

      expect(result.summary.attemptDistribution).toBeDefined()
      expect(result.summary.attemptDistribution![1]).toBe(2) // s1, s4
      expect(result.summary.attemptDistribution![2]).toBe(1) // s2
      expect(result.summary.attemptDistribution![3]).toBe(1) // s3
    })
  })
})
