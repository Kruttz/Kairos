/**
 * Search latency micro-benchmark — measures FileLibrary.search() latency at
 * increasing library sizes, with cold (cache-empty) vs warm (cache-populated)
 * timings, so a future decision to raise MAX_LIBRARY_SIZE beyond 500 is gated
 * on measured numbers rather than vibes (see docs/plans/repo-integration-plan.md §7.2).
 *
 * Usage:
 *   npx tsx scripts/search-bench.ts [--sizes 100,500,1500,4000] [--queries 20]
 *
 * Each library size is built fresh in its own isolated temp directory and
 * discarded afterward — this script never touches ~/.kairos.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileLibrary } from '../src/library/file-library.js'
import type { N8nWorkflow, N8nNode } from '../src/types/workflow.js'

const NODE_POOL = [
  'n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.slack', 'n8n-nodes-base.gmail', 'n8n-nodes-base.googleSheets',
  'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code', 'n8n-nodes-base.set',
  'n8n-nodes-base.if', 'n8n-nodes-base.airtable', 'n8n-nodes-base.postgres',
  'n8n-nodes-base.telegram', 'n8n-nodes-base.notion', 'n8n-nodes-base.merge',
  '@n8n/n8n-nodes-langchain.agent', '@n8n/n8n-nodes-langchain.lmChatOpenAi',
]

const DESCRIPTION_TOPICS = [
  'send a slack message when a webhook fires',
  'sync new google sheets rows to airtable',
  'daily email digest of open github issues',
  'ai agent that answers questions using a knowledge base',
  'archive email attachments to google drive',
  'post a reminder to telegram every morning',
  'sync postgres records to notion',
  'http api health check with slack alert on failure',
  'merge two data sources and write to a spreadsheet',
  'schedule a weekly report and email the summary',
]

// Deterministic per-size PRNG so repeated runs at the same size are comparable.
function pseudoRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function makeSyntheticWorkflow(i: number, rand: () => number): { workflow: N8nWorkflow; description: string } {
  const nodeCount = 2 + Math.floor(rand() * 6)
  const nodes: N8nNode[] = Array.from({ length: nodeCount }, (_, j) => ({
    id: `node-${i}-${j}`,
    name: `Node ${j}`,
    type: NODE_POOL[Math.floor(rand() * NODE_POOL.length)]!,
    typeVersion: 1,
    position: [j * 200, 0],
    parameters: {},
  }))
  const topic = DESCRIPTION_TOPICS[i % DESCRIPTION_TOPICS.length]!
  return {
    workflow: { name: `Synthetic ${i}`, nodes, connections: {} },
    description: `${topic} (variant ${i})`,
  }
}

async function buildLibrary(size: number): Promise<{ lib: FileLibrary; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-search-bench-'))
  const lib = new FileLibrary(dir)
  await lib.initialize()
  const rand = pseudoRandom(size * 7919 + 1)
  for (let i = 0; i < size; i++) {
    const { workflow, description } = makeSyntheticWorkflow(i, rand)
    await lib.save(workflow, { description })
  }
  await lib.drain()
  return { lib, dir }
}

async function timeSearches(lib: FileLibrary, queries: string[]): Promise<number[]> {
  const timings: number[] = []
  for (const q of queries) {
    const start = performance.now()
    await lib.search(q)
    timings.push(performance.now() - start)
  }
  return timings
}

function stats(timings: number[]): { avg: number; p50: number; p95: number; max: number } {
  const sorted = [...timings].sort((a, b) => a - b)
  const avg = timings.reduce((s, t) => s + t, 0) / timings.length
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? sorted[0] ?? 0
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  return { avg, p50, p95, max }
}

async function run(sizes: number[], queryCount: number): Promise<void> {
  console.log('Search latency benchmark — cold (cache-empty) vs warm (cache-populated) search() calls')
  console.log('='.repeat(90))

  const queries = Array.from({ length: Math.max(queryCount, 2) }, (_, i) => DESCRIPTION_TOPICS[i % DESCRIPTION_TOPICS.length]!)

  for (const size of sizes) {
    process.stdout.write(`\nBuilding library with ${size} entries... `)
    const seedStart = performance.now()
    const { lib, dir } = await buildLibrary(size)
    console.log(`done in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`)

    // Cold: doc-token cache is empty — this first call must tokenize the whole corpus,
    // matching the pre-cache behavior exactly.
    const coldTimings = await timeSearches(lib, queries.slice(0, 1))
    // Warm: the cold call above already populated the cache for every entry — these
    // calls measure what repeated searches cost once the cache is hot.
    const warmTimings = await timeSearches(lib, queries.slice(1))

    const cold = stats(coldTimings)
    const warm = stats(warmTimings)

    let indexSize = 0
    try {
      const s = await stat(join(dir, 'index.json'))
      indexSize = s.size
    } catch { /* ignore */ }

    // Each search() above triggers a fire-and-forget persist() (timesRetrieved counters) —
    // must drain before reading a fresh instance off the same on-disk index.json below.
    await lib.drain()

    // R7: time a fresh FileLibrary reading this already-populated index.json, simulating
    // real process startup (CLI invocation, MCP server boot) against existing data.
    const initStart = performance.now()
    const freshLib = new FileLibrary(dir)
    await freshLib.initialize()
    const initMs = performance.now() - initStart

    console.log(`  Entries:        ${size}`)
    console.log(`  index.json:     ${(indexSize / 1024).toFixed(1)} KB`)
    console.log(`  initialize():   ${initMs.toFixed(1)}ms (fresh instance, cold read of existing index.json)`)
    console.log(`  Cold search:    ${cold.avg.toFixed(1)}ms (first call, empty cache)`)
    console.log(`  Warm search:    avg ${warm.avg.toFixed(1)}ms  p50 ${warm.p50.toFixed(1)}ms  p95 ${warm.p95.toFixed(1)}ms  max ${warm.max.toFixed(1)}ms  (n=${warmTimings.length})`)
    console.log(`  Cache speedup:  ${(cold.avg / Math.max(warm.avg, 0.001)).toFixed(1)}x`)

    await rm(dir, { recursive: true, force: true })
  }

  console.log('\nDone. Use these numbers to decide whether raising MAX_LIBRARY_SIZE beyond 500 is safe')
  console.log('(docs/plans/repo-integration-plan.md §7.2 — gate any cap-raise on measured numbers, not vibes).')
}

const sizesArg = process.argv.indexOf('--sizes')
const sizes = sizesArg !== -1
  ? process.argv[sizesArg + 1]!.split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0)
  : [100, 500, 1500, 4000]
const queriesArg = process.argv.indexOf('--queries')
const queryCount = queriesArg !== -1 ? parseInt(process.argv[queriesArg + 1] ?? '20', 10) : 20

run(sizes, queryCount).catch((err) => {
  console.error('Search benchmark failed:', err)
  process.exit(1)
})
