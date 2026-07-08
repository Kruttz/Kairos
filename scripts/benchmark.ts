/**
 * Kairos SDK benchmark — measures generation success rate, retry frequency,
 * token usage, and per-rule failure distribution.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... N8N_API_KEY=... N8N_BASE_URL=... \
 *     npx tsx scripts/benchmark.ts [--count 20] [--output results.json] [--no-library] [--compare baseline.json]
 *     npx tsx scripts/benchmark.ts --tier complex [--output results.json]
 *
 * Flags:
 *   --no-library   Run without library (NullLibrary) for baseline measurement
 *   --compare      Compare results against a previous run's JSON file. Prints aggregate
 *                  summary deltas plus, when the baseline file has a `results` array,
 *                  an explicit list of any prompt that passed in the baseline and fails
 *                  now (see scripts/benchmark-compare.ts) -- an aggregate delta alone can
 *                  mask one regression if other prompts improve at the same time. This
 *                  is manual and human-triggered by design (real Anthropic API calls,
 *                  non-deterministic by nature) -- never wired into required CI.
 *   --tier <name>  Run only one difficulty tier instead of the first --count prompts.
 *                  One of: simple | medium | complex | edge | realworld | stress |
 *                  additional | backendApi | all. Overrides --count when both are given.
 *   --repeat <n>   Run each selected prompt n times (default 1) — reports a per-prompt
 *                  pass rate instead of a single pass/fail, since generation isn't fully
 *                  deterministic and one sample can't distinguish "reliable" from "got lucky."
 *   --isolated     Point telemetry/patterns at a fresh temp directory for this run only,
 *                  instead of the real ~/.kairos state. Without this flag, every benchmark
 *                  run both reads AND writes the same global telemetry/patterns.json that
 *                  every other kairos build (this script, the CLI, real usage) also writes
 *                  to — a long run's own earlier results can change the system-prompt
 *                  guidance injected into its later prompts mid-run (observed directly:
 *                  patterns.json regenerated mid-way through an 8-run single-prompt test).
 *                  Use --isolated when you want a clean, stationary A/B comparison; omit it
 *                  when you deliberately want to measure against real accumulated state (the
 *                  library is NOT isolated by this flag — dry-run builds never write to it
 *                  regardless, and retrieval against real library contents is part of what's
 *                  being measured).
 *
 *                  As of 2026-07-02 the default --count 20 (the "simple" tier plus
 *                  the first 10 of "medium") scores 100% first-try under every
 *                  library configuration tested — it's saturated and no longer
 *                  discriminates. Use --tier complex (or --tier all) to get a
 *                  signal that isn't already at the ceiling. See
 *                  docs/plans/repo-integration-plan.md, judgment call 3, for why
 *                  this flag exists and why it wasn't paired with an actual re-run
 *                  in the same commit (that's separate spend, ask first).
 *
 * All runs are dry-run (no deployment). Telemetry is written to ~/.kairos/telemetry/
 * unless --isolated is passed.
 */

import { Kairos, FileLibrary } from '../src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRegressions, formatRegressions } from './benchmark-compare.js'

const PROMPTS = [
  // --- Simple (single trigger + 1-2 nodes) ---
  'Every day at 8am, send an email reminder to team@company.com saying "Stand-up in 30 minutes"',
  'When a webhook receives a POST request, return a JSON response with { "status": "ok" }',
  'Every Monday at 9am, post "Weekly sync time!" to a Slack channel called #engineering',
  'When a form is submitted via webhook, save the data to a Google Sheet',
  'Every hour, make a GET request to https://api.example.com/health and log the result',
  'Send a Telegram message saying "Build complete" when a webhook is triggered',
  'Every 5 minutes, check https://httpbin.org/status/200 and alert on failure via email',
  'When receiving a webhook, extract the "name" field and respond with "Hello, {name}"',
  'Schedule a daily report email at 6pm with a summary from an HTTP API endpoint',
  'Receive a webhook with user data, validate the email field, and return success/failure',

  // --- Medium (3-5 nodes, conditional logic) ---
  'Receive a webhook with order data, check if total > 100, send a Slack alert for high-value orders, otherwise log to a spreadsheet',
  'Every morning at 7am, fetch weather data from an API, format it nicely, and post to Slack #general',
  'When a webhook receives a support ticket, classify priority based on keywords, route high-priority to Slack and low-priority to email',
  'Receive a webhook POST, call https://httpbin.org/json, merge the response with the original data, and return the combined result',
  'Every day at midnight, fetch all GitHub issues from a repo, filter open ones, and send a summary email',
  'When a new email arrives, extract attachments, upload them to S3, and send a confirmation Slack message',
  'Receive a webhook with product data, check inventory levels, send restock alerts for items below threshold',
  'Every 30 minutes, poll an RSS feed, check for new entries, and post new items to a Slack channel',
  'When triggered by webhook, look up a customer in a database, enrich with external API data, and return the profile',
  'Receive form submissions via webhook, validate required fields, store valid entries in Airtable, respond with status',
  'Fetch data from two different APIs, merge the results, transform the combined data, and save to Google Sheets',
  'Every week on Friday at 5pm, aggregate weekly metrics from an API and email a summary report',
  'When a webhook receives an event, check the event type with a switch node, and route to different Slack channels based on type',
  'Receive customer feedback via webhook, analyze sentiment using a simple keyword check, and route to appropriate team',
  'Every day, fetch exchange rates from an API, compare with yesterday, and alert via Slack if change exceeds 2%',

  // --- Complex (5+ nodes, AI agents, memory, multiple integrations) ---
  'Build a chat-triggered AI agent using GPT-4o with window buffer memory that can answer questions about a company knowledge base',
  'Create an AI agent with OpenAI that has access to a calculator tool and a web search tool, triggered by chat messages',
  'When a webhook receives a document URL, fetch the document, split it into chunks, generate embeddings, and store in a vector database',
  'Build a customer support chatbot using an AI agent with memory that can look up order status via an HTTP tool',
  'Create an AI-powered email classifier: receive emails, use an LLM to categorize them, route to appropriate folders, and send auto-replies',
  'Build a Slack bot that uses an AI agent to answer questions about internal documentation, with conversation memory',
  'When a webhook receives a long text, use an AI chain to summarize it, extract key entities, and store the results',
  'Create a workflow that monitors a GitHub repo for new issues, uses AI to suggest labels, and auto-assigns based on content',
  'Build an AI agent with tools for querying a PostgreSQL database and formatting results as tables',
  'Create a multi-step AI pipeline: receive text via webhook, translate to English, summarize, extract sentiment, return structured result',

  // --- Edge cases and specific node types ---
  'Merge data from three different webhook endpoints using a merge node and return the combined payload',
  'Use a code node to calculate the fibonacci sequence for a number received via webhook',
  'Receive a webhook, wait 5 seconds using a wait node, then send a delayed response',
  'Create a workflow with error handling: try an HTTP request, catch failures, and send error details to Slack',
  'Receive a CSV file via webhook, parse it using a code node, and insert rows into a Google Sheet',
  'Use a switch node to route incoming webhooks to 4 different processing paths based on the "action" field',
  'Receive a webhook with an image URL, download the image via HTTP request, and upload it to S3',
  'Create a workflow that processes items in a loop: receive an array via webhook, iterate, transform each item, and return results',
  'Build a webhook endpoint that rate-limits requests: check a counter in Redis, reject if over limit, process if under',
  'Receive a webhook, encrypt sensitive fields using a code node, store in a database, and return a receipt ID',

  // --- Real-world automation patterns ---
  'When a new row is added to Google Sheets, check for duplicates, send a welcome email to new contacts, and update CRM',
  'Monitor a website for changes every hour, compare with previous version, and alert via Telegram if content changed',
  'When a Stripe payment webhook arrives, update the customer record, send a receipt email, and log to accounting spreadsheet',
  'Sync contacts between two systems: fetch from API A, compare with API B, create missing entries, update changed ones',
  'When a GitHub PR is merged, trigger a deployment webhook, wait for completion, and post the result to Slack',
  'Process incoming invoice emails: extract amount and vendor using regex, categorize, and add to an expense tracking sheet',
  'When a user signs up via webhook, create accounts in 3 services, send a welcome email, and log the onboarding event',
  'Monitor server metrics via HTTP endpoint every 5 minutes, check thresholds, escalate alerts through email then Slack then PagerDuty',
  'When a form submission arrives, validate the data, check against a blocklist, send to approval queue or auto-approve',
  'Aggregate data from 5 different API sources daily, normalize formats, merge into a unified report, and email to stakeholders',

  // --- Stress tests (complex descriptions) ---
  'Build a complete lead scoring system: receive lead data via webhook, enrich from Clearbit API, score based on multiple criteria using a code node, route high-score leads to sales Slack channel and CRM, low-score to nurture email sequence',
  'Create an automated content pipeline: monitor RSS feeds for industry news, use AI to summarize each article, generate social media posts for Twitter and LinkedIn, schedule posts, and track engagement metrics',
  'Build an incident response workflow: receive PagerDuty alerts via webhook, create a Slack channel for the incident, gather system metrics from monitoring APIs, use AI to suggest diagnosis, and create a Jira ticket with all context',
  'Create a data pipeline that extracts data from a PostgreSQL database, transforms it with custom code, loads it into Google BigQuery, generates a summary report, and emails it to the data team every morning',
  'Build an employee onboarding automation: when HR submits a form, create user accounts in Google Workspace and Slack, assign to appropriate groups, schedule orientation meetings, send welcome package details, and create a 30-day check-in reminder',
  'Create a customer feedback loop: collect NPS survey responses via webhook, analyze sentiment using AI, categorize feedback themes, route critical issues to support, generate weekly trend reports, and update a dashboard',
  'Build a content moderation pipeline: receive user-generated content via webhook, scan for prohibited content using AI, flag suspicious items for human review, auto-approve clean content, and maintain an audit log',
  'Create an automated invoice processing system: receive invoices via email, extract line items using AI, match against purchase orders in the database, flag discrepancies, route for approval based on amount thresholds, and update the accounting system',
  'Build a competitive intelligence workflow: monitor competitor websites daily for pricing changes, use AI to analyze and summarize changes, compare against internal pricing, generate strategy recommendations, and brief the sales team via Slack',
  'Create a multi-channel customer support router: receive tickets from email webhook Slack and web form, unify format, use AI to classify urgency and category, assign to appropriate team member based on skills and availability, set SLA timers, and escalate overdue tickets',

  // --- Additional varied prompts to reach 100 ---
  'Send a Slack message when a Google Calendar event is about to start in 15 minutes',
  'Receive a webhook with a URL, take a screenshot using an HTTP API, and save it to cloud storage',
  'Every day at noon, count the number of open support tickets from an API and post the count to Slack',
  'When a webhook receives a JSON array, split it into individual items, process each one, and aggregate the results',
  'Create a workflow that backs up a Notion database to Google Sheets every night at 2am',
  'Receive a webhook with search terms, query multiple APIs in parallel, merge results, rank by relevance, and return top 10',
  'Monitor an e-commerce API for low stock items every 4 hours and generate reorder requests via email',
  'When a new GitHub release is published, download release notes, format for multiple channels, and post to Slack Discord and email',
  'Build a simple approval workflow: receive request via webhook, send approval message to Slack, wait for response, and proceed or reject',
  'Create a data validation pipeline: receive CSV data via webhook, validate each row against business rules using code node, separate valid and invalid rows, store valid rows and email error report for invalid ones',
  'Every morning fetch the top 5 news headlines from a news API and send them as a formatted Slack message',
  'Receive a webhook with a YouTube URL, fetch video metadata via API, extract title and description, and save to a spreadsheet',
  'Build a periodic cleanup workflow: every Sunday at midnight, find inactive records older than 90 days via API, archive them, and send a summary',
  'When a webhook receives a long URL, call a URL shortener API, store the mapping, and return the short URL',
  'Create a workflow that monitors a Supabase database for new entries every 10 minutes and syncs them to Airtable',
  'Receive a payment notification via webhook, verify the signature using a code node, update order status, and send confirmation email',
  'Build a simple chatbot workflow: receive chat messages via webhook, use OpenAI to generate responses, and send them back',
  'Every first of the month, pull usage metrics from an API, generate a PDF report via an HTTP service, and email it to management',
  'When a user submits a bug report via webhook, create a GitHub issue, add appropriate labels based on keywords, and notify the dev team on Slack',
  'Receive a webhook with geographic coordinates, look up the nearest store via API, calculate distance, and return directions',

  // --- Backend API contract prompts: CRUD/API-shaped tasks stressing consistent
  // response shape, structured validation, not-found paths, batch per-item status,
  // and auth -- gaps identified in the "is Kairos viable as an app backend" review,
  // deliberately absent from every prompt above (which are automation-shaped) ---
  'Build a webhook endpoint that accepts a new user signup with email and name fields, validates the email format, checks a Postgres table for an existing user with that email, inserts a new record if not found, and returns a consistent JSON response shaped like {success, data, error} for every path including validation failures and duplicates',
  'Build a webhook endpoint that accepts a customer ID as a query parameter, looks up the customer in a Supabase table, and returns the customer record as JSON if found or a structured {success: false, error} response if no matching record exists',
  'Build a webhook endpoint that accepts an array of items to import, validates each item has required name and email fields, inserts valid items into an Airtable base, and returns a JSON array with one status object per item indicating whether it succeeded or failed and why',
  "Build a webhook endpoint that accepts a product ID and updated fields, checks if the product exists in a NocoDB table, updates it if found, and returns a structured JSON response with the updated record or a clear error if the product ID doesn't exist",
  'Build a webhook endpoint for creating a support ticket that requires title, description, and priority fields, validates priority is one of low, medium, or high, rejects the request with a detailed list of which fields are missing or invalid if validation fails, and only writes to the database if all fields pass validation',
  "Build a webhook endpoint that requires an API key passed in a header, rejects requests with a structured 401-style JSON error if the key is missing or doesn't match an expected value, and only proceeds to look up account data in Postgres if the key is valid",
  'Build a webhook endpoint that returns a paginated list of orders from a Postgres table, accepting page and pageSize query parameters, and returning the matching rows along with total count and page metadata in the JSON response',
  'Build a webhook endpoint that accepts an order creation request with an idempotency key, checks if a request with that idempotency key was already processed by looking it up in Redis, returns the previously stored result if it was, and otherwise processes the order and stores the result keyed by that idempotency key',
  "Build a webhook endpoint that accepts a user ID, fetches the user's profile from Postgres and their recent orders from a separate HTTP API, combines both into a single JSON response shaped like {success: true, data: {profile, orders}}, and returns a clear error response if either lookup fails",
]

// Machine-readable boundaries matching the comment-marked sections above (verified
// by direct count: 10+15+10+10+10+10+20+9 = 94, matching PROMPTS.length). [start, end)
// half-open ranges into PROMPTS.
const TIER_RANGES: Record<string, [number, number]> = {
  simple: [0, 10],
  medium: [10, 25],
  complex: [25, 35],
  edge: [35, 45],
  realworld: [45, 55],
  stress: [55, 65],
  additional: [65, 85],
  backendApi: [85, 94],
  all: [0, 94],
}

function selectPrompts(count: number, tier?: string): string[] {
  if (tier) {
    const range = TIER_RANGES[tier]
    if (!range) {
      const known = Object.keys(TIER_RANGES).join(', ')
      throw new Error(`Unknown --tier "${tier}". Valid values: ${known}`)
    }
    return PROMPTS.slice(range[0], range[1])
  }
  return PROMPTS.slice(0, count)
}

interface BenchmarkResult {
  prompt: string
  promptIndex: number
  success: boolean
  attempts: number
  durationMs: number
  tokensInput: number
  tokensOutput: number
  workflowName?: string
  credentialsCount: number
  error?: string
  failedRules?: number[]
}

interface PromptReliability {
  promptIndex: number
  prompt: string
  passes: number
  runs: number
  passRate: number
}

interface BenchmarkSummary {
  total: number
  successes: number
  failures: number
  firstTry: number
  neededCorrection: number
  avgDurationMs: number
  avgAttempts: number
  /** First-try passes / total successful builds (excludes complete failures from denominator) */
  firstTryRate: number
  /** First-try passes / ALL builds including complete failures — true overall first-try rate */
  firstTryRateOverAll: number
  correctionRate: number
  libraryUsed: boolean
  /** How many times each distinct prompt was run (1 unless --repeat is passed) */
  repeatsPerPrompt: number
  /** Per-prompt pass rate across repeats — only meaningful when repeatsPerPrompt > 1 */
  promptReliability?: PromptReliability[]
}

async function runBenchmark(count: number, outputPath?: string, useLibrary = true, comparePath?: string, tier?: string, repeat = 1, isolated = false): Promise<void> {
  // Validate --tier before the API key check so a typo fails fast without needing
  // real credentials to discover it.
  const prompts = selectPrompts(count, tier)

  const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY']
  const N8N_API_KEY = process.env['N8N_API_KEY']
  const N8N_BASE_URL = process.env['N8N_BASE_URL'] ?? 'https://your-instance.app.n8n.cloud'

  if (!ANTHROPIC_API_KEY || !N8N_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY or N8N_API_KEY')
    process.exit(1)
  }

  // --isolated: point telemetry (and therefore patterns.json, which client.ts derives as
  // join(telemetryDir, '..', 'patterns.json')) at a fresh temp dir, so this run's own
  // earlier results can't mutate the system-prompt guidance injected into its later
  // prompts. The library is deliberately left shared — dry-run builds never write to it.
  let isolatedTelemetryDir: string | undefined
  if (isolated) {
    isolatedTelemetryDir = await mkdtemp(join(tmpdir(), 'kairos-benchmark-isolated-'))
    console.log(`Isolated run — telemetry/patterns scoped to ${isolatedTelemetryDir} (deleted after this run)`)
  }

  const kairos = new Kairos({
    anthropicApiKey: ANTHROPIC_API_KEY,
    n8nBaseUrl: N8N_BASE_URL,
    n8nApiKey: N8N_API_KEY,
    telemetry: isolatedTelemetryDir ?? true,
    ...(useLibrary ? { library: new FileLibrary() } : {}),
  })

  const results: BenchmarkResult[] = []
  const totalRuns = prompts.length * repeat

  console.log(`Kairos SDK Benchmark — ${prompts.length} prompts${repeat > 1 ? ` × ${repeat} repeats = ${totalRuns} runs` : ''} (dry run)`)
  console.log('═'.repeat(60))

  let runNumber = 0
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!
    for (let r = 0; r < repeat; r++) {
      runNumber++
      const label = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt
      const runSuffix = repeat > 1 ? ` (run ${r + 1}/${repeat})` : ''
      process.stdout.write(`[${String(runNumber).padStart(4)}/${totalRuns}] ${label}${runSuffix}\n`)

      const start = Date.now()
      try {
        const result = await kairos.build(prompt, { dryRun: true })

        results.push({
          prompt,
          promptIndex: i,
          success: true,
          attempts: result.generationAttempts,
          durationMs: Date.now() - start,
          tokensInput: result.tokensInput,
          tokensOutput: result.tokensOutput,
          workflowName: result.name,
          credentialsCount: result.credentialsNeeded.length,
        })
        console.log(`         ✅ ${result.generationAttempts} attempt(s), ${Date.now() - start}ms`)
      } catch (err) {
        const failedRules = 'issues' in (err as Record<string, unknown>)
          ? ((err as { issues: Array<{ rule: number }> }).issues).map((i) => i.rule)
          : undefined

        results.push({
          prompt,
          promptIndex: i,
          success: false,
          attempts: 3,
          durationMs: Date.now() - start,
          tokensInput: 'tokensInput' in (err as Record<string, unknown>) ? Number((err as Record<string, unknown>)['tokensInput']) : 0,
          tokensOutput: 'tokensOutput' in (err as Record<string, unknown>) ? Number((err as Record<string, unknown>)['tokensOutput']) : 0,
          credentialsCount: 0,
          error: err instanceof Error ? err.message : String(err),
          failedRules,
        })
        console.log(`         ❌ FAILED (${Date.now() - start}ms)`)
      }
    }
  }

  console.log('\n' + '═'.repeat(60))
  console.log(`RESULTS SUMMARY ${useLibrary ? '(with library)' : '(no library — baseline)'}`)
  console.log('═'.repeat(60))

  const successes = results.filter((r) => r.success)
  const failures = results.filter((r) => !r.success)
  const firstTry = successes.filter((r) => r.attempts === 1)
  const neededCorrection = successes.filter((r) => r.attempts > 1)
  const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / results.length
  const avgAttempts = successes.length > 0 ? successes.reduce((s, r) => s + r.attempts, 0) / successes.length : 0

  const summary: BenchmarkSummary = {
    total: results.length,
    successes: successes.length,
    failures: failures.length,
    firstTry: firstTry.length,
    neededCorrection: neededCorrection.length,
    avgDurationMs: avgDuration,
    avgAttempts,
    firstTryRate: successes.length > 0 ? firstTry.length / successes.length : 0,
    firstTryRateOverAll: results.length > 0 ? firstTry.length / results.length : 0,
    correctionRate: successes.length > 0 ? neededCorrection.length / successes.length : 0,
    libraryUsed: useLibrary,
    repeatsPerPrompt: repeat,
  }

  if (repeat > 1) {
    const byPrompt = new Map<number, BenchmarkResult[]>()
    for (const r of results) {
      const list = byPrompt.get(r.promptIndex) ?? []
      list.push(r)
      byPrompt.set(r.promptIndex, list)
    }
    summary.promptReliability = [...byPrompt.entries()]
      .map(([promptIndex, runs]) => ({
        promptIndex,
        prompt: runs[0]!.prompt,
        passes: runs.filter((r) => r.success).length,
        runs: runs.length,
        passRate: runs.filter((r) => r.success).length / runs.length,
      }))
      .sort((a, b) => a.passRate - b.passRate) // worst-performing prompts first
  }

  console.log(`Total prompts:       ${summary.total}`)
  console.log(`Success rate:        ${summary.successes}/${summary.total} (${((summary.successes / summary.total) * 100).toFixed(1)}%)`)
  console.log(`First-try pass:      ${summary.firstTry}/${summary.successes} of successes (${(summary.firstTryRate * 100).toFixed(1)}%)`)
  console.log(`First-try overall:   ${summary.firstTry}/${summary.total} of all builds (${(summary.firstTryRateOverAll * 100).toFixed(1)}%)`)
  console.log(`Needed correction:   ${summary.neededCorrection}/${summary.successes} (${(summary.correctionRate * 100).toFixed(1)}%)`)
  console.log(`Failures:            ${summary.failures}`)
  console.log(`Avg duration:        ${(summary.avgDurationMs / 1000).toFixed(1)}s`)
  console.log(`Avg attempts:        ${summary.avgAttempts.toFixed(2)}`)

  if (summary.promptReliability) {
    const inconsistent = summary.promptReliability.filter((p) => p.passRate < 1)
    console.log(`\nPer-prompt reliability (${repeat} runs each):`)
    if (inconsistent.length === 0) {
      console.log('  All prompts passed every repeat — no inconsistency detected.')
    } else {
      console.log(`  ${inconsistent.length}/${summary.promptReliability.length} prompts were inconsistent across repeats:`)
      for (const p of inconsistent) {
        const label = p.prompt.length > 70 ? p.prompt.slice(0, 67) + '...' : p.prompt
        console.log(`    ${p.passes}/${p.runs} (${(p.passRate * 100).toFixed(0)}%) — ${label}`)
      }
    }
  }

  if (failures.length > 0) {
    console.log('\nFailed rules distribution:')
    const ruleCounts = new Map<number, number>()
    for (const f of failures) {
      if (f.failedRules) {
        for (const r of f.failedRules) {
          ruleCounts.set(r, (ruleCounts.get(r) ?? 0) + 1)
        }
      }
    }
    for (const [rule, count] of [...ruleCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  Rule ${rule}: ${count} failure(s)`)
    }
  }

  if (comparePath) {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(comparePath, 'utf-8')
      const baseline = JSON.parse(raw) as { summary: BenchmarkSummary; results?: BenchmarkResult[] }
      const b = baseline.summary

      console.log('\n' + '═'.repeat(60))
      console.log('COMPARISON vs BASELINE')
      console.log('═'.repeat(60))

      const delta = (curr: number, prev: number) => {
        const diff = curr - prev
        return diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)
      }

      console.log(`                     Baseline    Seeded     Delta`)
      console.log(`First-try rate:      ${(b.firstTryRate * 100).toFixed(1)}%       ${(summary.firstTryRate * 100).toFixed(1)}%      ${delta(summary.firstTryRate * 100, b.firstTryRate * 100)}pp`)
      console.log(`Avg attempts:        ${b.avgAttempts.toFixed(2)}        ${summary.avgAttempts.toFixed(2)}       ${delta(summary.avgAttempts, b.avgAttempts)}`)
      console.log(`Correction rate:     ${(b.correctionRate * 100).toFixed(1)}%       ${(summary.correctionRate * 100).toFixed(1)}%      ${delta(summary.correctionRate * 100, b.correctionRate * 100)}pp`)
      console.log(`Avg duration:        ${(b.avgDurationMs / 1000).toFixed(1)}s       ${(summary.avgDurationMs / 1000).toFixed(1)}s      ${delta(summary.avgDurationMs / 1000, b.avgDurationMs / 1000)}s`)
      console.log(`Failures:            ${b.failures}           ${summary.failures}          ${delta(summary.failures, b.failures)}`)

      // Aggregate deltas can mask one prompt flipping pass->fail while others improve --
      // this is a per-prompt check on top of the summary-level comparison above.
      if (baseline.results) {
        const regressions = findRegressions(baseline.results, results)
        const formatted = formatRegressions(regressions)
        if (formatted) console.log(formatted)
      }
    } catch {
      console.log(`\nCould not load comparison file: ${comparePath}`)
    }
  }

  if (outputPath) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outputPath, JSON.stringify({ results, summary }, null, 2))
    console.log(`\nFull results written to ${outputPath}`)
  }

  if (isolatedTelemetryDir) {
    await rm(isolatedTelemetryDir, { recursive: true, force: true })
    console.log(`Isolated telemetry dir cleaned up.`)
  }
}

const countArg = process.argv.indexOf('--count')
const count = countArg !== -1 ? parseInt(process.argv[countArg + 1] ?? '20', 10) : 20
const outputArg = process.argv.indexOf('--output')
const output = outputArg !== -1 ? process.argv[outputArg + 1] : undefined
const noLibrary = process.argv.includes('--no-library')
const compareArg = process.argv.indexOf('--compare')
const compare = compareArg !== -1 ? process.argv[compareArg + 1] : undefined
const tierArg = process.argv.indexOf('--tier')
const tier = tierArg !== -1 ? process.argv[tierArg + 1] : undefined
const repeatArg = process.argv.indexOf('--repeat')
const repeat = repeatArg !== -1 ? parseInt(process.argv[repeatArg + 1] ?? '1', 10) : 1
const isolated = process.argv.includes('--isolated')

runBenchmark(count, output, !noLibrary, compare, tier, repeat, isolated).catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
