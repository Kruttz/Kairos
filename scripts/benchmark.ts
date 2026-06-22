/**
 * Kairos SDK benchmark — measures generation success rate, retry frequency,
 * token usage, and per-rule failure distribution.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... N8N_API_KEY=... N8N_BASE_URL=... \
 *     npx tsx scripts/benchmark.ts [--count 20] [--output results.json] [--no-library] [--compare baseline.json]
 *
 * Flags:
 *   --no-library   Run without library (NullLibrary) for baseline measurement
 *   --compare      Compare results against a previous run's JSON file
 *
 * All runs are dry-run (no deployment). Telemetry is written to ~/.kairos/telemetry/
 */

import { Kairos, FileLibrary } from '../src/index.js'

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
]

interface BenchmarkResult {
  prompt: string
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

interface BenchmarkSummary {
  total: number
  successes: number
  failures: number
  firstTry: number
  neededCorrection: number
  avgDurationMs: number
  avgAttempts: number
  firstTryRate: number
  correctionRate: number
  libraryUsed: boolean
}

async function runBenchmark(count: number, outputPath?: string, useLibrary = true, comparePath?: string): Promise<void> {
  const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY']
  const N8N_API_KEY = process.env['N8N_API_KEY']
  const N8N_BASE_URL = process.env['N8N_BASE_URL'] ?? 'https://your-instance.app.n8n.cloud'

  if (!ANTHROPIC_API_KEY || !N8N_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY or N8N_API_KEY')
    process.exit(1)
  }

  const kairos = new Kairos({
    anthropicApiKey: ANTHROPIC_API_KEY,
    n8nBaseUrl: N8N_BASE_URL,
    n8nApiKey: N8N_API_KEY,
    telemetry: true,
    ...(useLibrary ? { library: new FileLibrary() } : {}),
  })

  const prompts = PROMPTS.slice(0, count)
  const results: BenchmarkResult[] = []

  console.log(`Kairos SDK Benchmark — ${prompts.length} prompts (dry run)`)
  console.log('═'.repeat(60))

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!
    const label = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt
    process.stdout.write(`[${String(i + 1).padStart(3)}/${prompts.length}] ${label}\n`)

    const start = Date.now()
    try {
      const result = await kairos.build(prompt, { dryRun: true })

      results.push({
        prompt,
        success: true,
        attempts: result.generationAttempts,
        durationMs: Date.now() - start,
        tokensInput: 0,
        tokensOutput: 0,
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
        success: false,
        attempts: 3,
        durationMs: Date.now() - start,
        tokensInput: 0,
        tokensOutput: 0,
        credentialsCount: 0,
        error: err instanceof Error ? err.message : String(err),
        failedRules,
      })
      console.log(`         ❌ FAILED (${Date.now() - start}ms)`)
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
    correctionRate: successes.length > 0 ? neededCorrection.length / successes.length : 0,
    libraryUsed: useLibrary,
  }

  console.log(`Total prompts:       ${summary.total}`)
  console.log(`Success rate:        ${summary.successes}/${summary.total} (${((summary.successes / summary.total) * 100).toFixed(1)}%)`)
  console.log(`First-try pass:      ${summary.firstTry}/${summary.successes} (${(summary.firstTryRate * 100).toFixed(1)}%)`)
  console.log(`Needed correction:   ${summary.neededCorrection}/${summary.successes} (${(summary.correctionRate * 100).toFixed(1)}%)`)
  console.log(`Failures:            ${summary.failures}`)
  console.log(`Avg duration:        ${(summary.avgDurationMs / 1000).toFixed(1)}s`)
  console.log(`Avg attempts:        ${summary.avgAttempts.toFixed(2)}`)

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
      const baseline = JSON.parse(raw) as { summary: BenchmarkSummary }
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
    } catch {
      console.log(`\nCould not load comparison file: ${comparePath}`)
    }
  }

  if (outputPath) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outputPath, JSON.stringify({ results, summary }, null, 2))
    console.log(`\nFull results written to ${outputPath}`)
  }
}

const countArg = process.argv.indexOf('--count')
const count = countArg !== -1 ? parseInt(process.argv[countArg + 1] ?? '20', 10) : 20
const outputArg = process.argv.indexOf('--output')
const output = outputArg !== -1 ? process.argv[outputArg + 1] : undefined
const noLibrary = process.argv.includes('--no-library')
const compareArg = process.argv.indexOf('--compare')
const compare = compareArg !== -1 ? process.argv[compareArg + 1] : undefined

runBenchmark(count, output, !noLibrary, compare).catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
