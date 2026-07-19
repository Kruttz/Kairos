import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import type { PatternShareReport } from './whitelist.js'

/**
 * The share flow (docs/plans/reliability-suite-plan.md §10.3). Deliberately split the same
 * way every other confirm-gated command in this codebase splits: the actual y/N prompt lives
 * in cli.ts (matching repair apply's/rollback's own precedent), not here -- this module only
 * does the two things that happen strictly *after* a human has already said yes: write the
 * report file, and optionally hand it to `gh issue create`. No function in this file can be
 * called before that confirmation without the caller doing so on purpose.
 *
 * No network primitive (fetch/http/https) is imported anywhere in this file -- the only
 * network-adjacent action is the human-confirmed `gh` subprocess spawn below, itself gated on
 * `gh` actually being present. That's a checkable property (grep this file's imports), not
 * just a promise.
 */

export const COMMUNITY_REPO = 'Kruttz/Kairos'
const DEFAULT_GH_TIMEOUT_MS = 15_000

export function formatReportPreview(report: PatternShareReport): string {
  return JSON.stringify(report, null, 2)
}

export async function writePatternReportFile(report: PatternShareReport, path = 'pattern-report.json'): Promise<string> {
  await writeFile(path, formatReportPreview(report) + '\n', 'utf-8')
  return path
}

export interface GhIssueCreateResult {
  attempted: boolean
  opened: boolean
  exitCode: number | null
  error?: string
}

/** Same spawn/timeout/graceful-failure shape as watch/notify.ts's invokeOnDriftHook() (Phase
 * 6) -- reused deliberately rather than inventing a new subprocess pattern (Finding 6, plan
 * doc §10.0). Distinct function because the arguments are gh-specific (--repo/--title/
 * --body-file), not a generic piped-stdin hook. A missing `gh` binary is not a failure worth
 * alarming over -- it's the expected, documented fallback path (print the URL manually), so
 * `error` on spawn (ENOENT) resolves calmly rather than throwing. */
export function attemptGhIssueCreate(reportPath: string, kairosVersion: string, timeoutMs = DEFAULT_GH_TIMEOUT_MS, binary = 'gh'): Promise<GhIssueCreateResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: GhIssueCreateResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      child.kill()
      settle({ attempted: true, opened: false, exitCode: null, error: `gh issue create timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    const child = spawn(binary, [
      'issue', 'create',
      '--repo', COMMUNITY_REPO,
      '--title', `Community pattern report (kairos ${kairosVersion})`,
      '--body-file', reportPath,
    ], { stdio: ['ignore', 'ignore', 'ignore'] })

    child.on('error', (err) => settle({ attempted: false, opened: false, exitCode: null, error: String(err) }))
    child.on('exit', (code) => settle({ attempted: true, opened: code === 0, exitCode: code }))
  })
}

export function manualIssueUrl(): string {
  return `https://github.com/${COMMUNITY_REPO}/issues/new`
}
