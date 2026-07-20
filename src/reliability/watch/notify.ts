import { spawn } from 'node:child_process'
import type { WatchTickResult } from './loop.js'

/**
 * The alert layer: decides which of a tick's results deserve a human's attention, and delivers
 * that alert two ways -- stdout (always) and an optional user-supplied shell-hook command
 * (`--on-drift <cmd>`, opt-in). Kairos deliberately never builds a specific notification
 * integration (Slack/email/PagerDuty) itself -- the hook is the extension point, matching C5's
 * "no hosted infra" and avoiding scope creep into becoming a notification vendor.
 *
 * Only a real 'drifting' verdict notifies. insufficient_data/not_applicable/healthy/fetch_failed
 * never do -- the 4-state honesty discipline (Jordan/Codex, 2026-07-19) applies here exactly as
 * it does to every other report in this arc: uncertainty is not an alert.
 */

const DEFAULT_HOOK_TIMEOUT_MS = 10_000

export function shouldNotify(result: WatchTickResult): boolean {
  return result.status === 'checked' && result.report?.verdict === 'DRIFTING'
}

/** One block per drifting workflow, naming the specific drifting check(s) and the diagnosis --
 * distinct from the full tick's own rendered/--json dump (that's the CLI layer's job, covering
 * every result including healthy ones); this is specifically the alert-worthy subset. */
export function formatDriftAlert(result: WatchTickResult): string {
  const lines: string[] = []
  lines.push(`[DRIFT ALERT] ${result.workflowName ?? result.workflowId} (${result.workflowId}) -- ${result.checkedAt}`)
  const driftingFindings = result.report?.findings.filter(f => f.status === 'drifting') ?? []
  for (const f of driftingFindings) {
    lines.push(`  ⚠ ${f.id} -- ${f.summary}`)
  }
  for (const d of result.report?.diagnoses ?? []) {
    lines.push(`  ${d.checkId} [${d.severity}] ${d.causeStatement}`)
    lines.push(`    Recommended: ${d.recommendedAction}`)
  }
  return lines.join('\n')
}

export interface HookInvocationResult {
  invoked: boolean
  exitCode: number | null
  error?: string
}

/** Runs a user-supplied shell command with the drifting result's JSON piped on stdin. Bounded
 * (never hangs indefinitely -- same "bounded, backs off, never indefinite" discipline as
 * replay/chaos polling), and its own failure is reported, never thrown -- a broken or slow hook
 * must never crash or stall the tick loop that invoked it. */
export function invokeOnDriftHook(command: string, result: WatchTickResult, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS): Promise<HookInvocationResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: HookInvocationResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      child.kill()
      settle({ invoked: false, exitCode: null, error: `Hook command timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', (err) => settle({ invoked: false, exitCode: null, error: String(err) }))
    child.on('exit', (code) => settle({ invoked: true, exitCode: code }))
    // A fast-exiting child (e.g. a "command not found" shell resolution, routed through
    // exit(127) rather than the 'error' event above -- see the module comment on the
    // shell:true finding) can close its end of this pipe before or during the write below,
    // which Node reports as an EPIPE 'error' event on the stdin stream itself, not on `child`.
    // Left unhandled, that's an unhandled stream error -- found live (2026-07-19 closeout) as
    // an occasional stray EPIPE log outside any single test's own pass/fail result. The
    // process's own outcome is already fully handled by the 'error'/'exit' listeners above;
    // this only needs to stop the write from crashing, matching this function's own stated
    // contract ("its own failure is reported, never thrown").
    child.stdin.on('error', () => {})
    child.stdin.write(JSON.stringify(result))
    child.stdin.end()
  })
}

export interface NotifyOutcome {
  workflowId: string
  alerted: boolean
  hook?: HookInvocationResult
}

export interface NotifyOptions {
  onDriftCommand?: string
}

/** Prints an alert block to stdout for every drifting result, and invokes the shell-hook
 * (once per drifting workflow) when configured. Never notifies for a non-drifting result. */
export async function notifyTick(results: WatchTickResult[], options: NotifyOptions = {}): Promise<NotifyOutcome[]> {
  const outcomes: NotifyOutcome[] = []

  for (const result of results) {
    if (!shouldNotify(result)) {
      outcomes.push({ workflowId: result.workflowId, alerted: false })
      continue
    }

    console.log(formatDriftAlert(result))

    if (options.onDriftCommand) {
      const hook = await invokeOnDriftHook(options.onDriftCommand, result)
      outcomes.push({ workflowId: result.workflowId, alerted: true, hook })
      continue
    }

    outcomes.push({ workflowId: result.workflowId, alerted: true })
  }

  return outcomes
}
