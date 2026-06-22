import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { TelemetryEvent } from './types.js'

export interface RuleFailureRate {
  rule: number
  failureCount: number
  totalBuilds: number
  rate: number
  commonMessage: string
}

export class TelemetryReader {
  private readonly dir: string
  private cache: RuleFailureRate[] | null = null
  private cacheTime = 0

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), '.kairos', 'telemetry')
  }

  async getFailureRates(days = 30): Promise<RuleFailureRate[]> {
    const now = Date.now()
    if (this.cache && now - this.cacheTime < 5 * 60 * 1000) {
      return this.cache
    }

    const events = await this.readRecentEvents(days)

    const buildSessions = new Set(
      events.filter((e) => e.eventType === 'build_complete').map((e) => e.sessionId),
    )
    if (buildSessions.size === 0) return []

    const ruleSessions = new Map<number, { sessions: Set<string>; messages: Map<string, number> }>()

    for (const event of events) {
      if (event.eventType !== 'generation_attempt') continue
      const data = event.data as { validationPassed?: boolean; issues?: Array<{ rule: number; message: string }> }
      if (data.validationPassed || !data.issues) continue

      for (const issue of data.issues) {
        const entry = ruleSessions.get(issue.rule) ?? { sessions: new Set(), messages: new Map() }
        entry.sessions.add(event.sessionId)
        entry.messages.set(issue.message, (entry.messages.get(issue.message) ?? 0) + 1)
        ruleSessions.set(issue.rule, entry)
      }
    }

    const rates: RuleFailureRate[] = []
    for (const [rule, entry] of ruleSessions) {
      let topMessage = ''
      let topCount = 0
      for (const [msg, count] of entry.messages) {
        if (count > topCount) {
          topMessage = msg
          topCount = count
        }
      }
      rates.push({
        rule,
        failureCount: entry.sessions.size,
        totalBuilds: buildSessions.size,
        rate: entry.sessions.size / buildSessions.size,
        commonMessage: topMessage,
      })
    }

    rates.sort((a, b) => b.rate - a.rate)
    this.cache = rates
    this.cacheTime = now
    return rates
  }

  private async readRecentEvents(days: number): Promise<TelemetryEvent[]> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return []
    }

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffStr = cutoff.toISOString().slice(0, 10)

    const datePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/
    const recentFiles = files
      .filter((f) => datePattern.test(f) && f >= cutoffStr)
      .sort()

    const events: TelemetryEvent[] = []
    for (const file of recentFiles) {
      try {
        const content = await readFile(join(this.dir, file), 'utf-8')
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          try {
            events.push(JSON.parse(line) as TelemetryEvent)
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // skip unreadable files
      }
    }
    return events
  }
}
