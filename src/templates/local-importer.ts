import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { N8nWorkflow, N8nNode } from '../types/workflow.js'
import type { IWorkflowLibrary, TrustLevel, StoredWorkflow } from '../library/types.js'
import type { ILogger } from '../utils/logger.js'
import { N8nValidator } from '../validation/validator.js'
import { assessTemplateSafety } from './safety.js'
import { cleanMarkdownText } from './text-clean.js'
import { DEFAULT_SETTINGS } from './syncer.js'
import { MAX_LIBRARY_SIZE } from '../library/file-library.js'
import { clusterWorkflows } from '../library/cluster.js'
import { inferWorkflowType } from '../utils/workflow-type.js'

const STICKY_NOTE_TYPE = 'n8n-nodes-base.stickyNote'

export interface LocalImportOptions {
  limit?: number
  dryRun?: boolean
  // 'review' (default) demotes code-node-only findings to the review trust tier — see
  // the locked Phase 0 decision in docs/plans/repo-integration-plan.md §5.1. 'block'
  // opts back into the stricter n8n.io-template-sync behavior for this run.
  codeNodePolicy?: 'block' | 'review'
  // Frequency distribution of Kairos's own build workflow types (from telemetry),
  // used to bias diversity selection toward clusters matching what Kairos actually
  // gets asked to build. Omit or pass an empty map for plain round-robin (e.g. no
  // telemetry history yet on a fresh install).
  workflowTypeWeights?: Map<string, number>
  onProgress?: (progress: LocalImportProgress) => void
}

export interface LocalImportProgress {
  filesFound: number
  parsed: number
  parseErrors: number
  duplicates: number
  blocked: number
  reviewed: number
  invalid: number
  candidatesAfterGating: number
  selected: number
  saved: number
}

export interface LocalImportReport extends LocalImportProgress {
  capacityAvailable: number
  stoppedReason?: string
}

export interface ImportCandidate {
  workflow: N8nWorkflow
  description: string
  hash: string
  filePath: string
  trustLevel: TrustLevel
  safetyReasons: string[]
}

// ── Normalization ────────────────────────────────────────────────────────

/**
 * Accepts raw n8n workflow JSON in the shapes commonly found in community
 * datasets: a bare {name, nodes, connections, settings} object, or the same
 * wrapped under a "workflow" key (matching n8n.io's template API shape).
 * Extra fields (id, active, createdAt, versionId, pinData, ...) are dropped —
 * only the fields Kairos itself generates and validates are kept.
 */
export function normalizeImportedWorkflow(raw: unknown): N8nWorkflow | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const inner = (obj['workflow'] && typeof obj['workflow'] === 'object')
    ? obj['workflow'] as Record<string, unknown>
    : obj

  const nodesRaw = inner['nodes']
  const connectionsRaw = inner['connections']
  if (!Array.isArray(nodesRaw) || !connectionsRaw || typeof connectionsRaw !== 'object') return null

  const nodes = (nodesRaw as N8nNode[]).filter((n) => n && typeof n === 'object' && n.type && n.name)
  if (nodes.length === 0) return null

  const name = typeof inner['name'] === 'string' && inner['name'].trim() ? inner['name'] : 'Imported Workflow'
  const settings = (inner['settings'] && typeof inner['settings'] === 'object')
    ? { executionOrder: 'v1' as const, ...(inner['settings'] as Record<string, unknown>) }
    : { ...DEFAULT_SETTINGS }

  return {
    name,
    nodes,
    connections: connectionsRaw as N8nWorkflow['connections'],
    settings,
  }
}

// ── Sticky-note description synthesis ───────────────────────────────────

function harvestStickyNotes(workflow: N8nWorkflow): string[] {
  return workflow.nodes
    .filter((n) => n.type === STICKY_NOTE_TYPE)
    .map((n) => (n.parameters as Record<string, unknown> | undefined)?.['content'])
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
}

/**
 * Community n8n workflows very often carry their real human-written documentation
 * in sticky-note nodes rather than in the workflow name. Harvesting that content
 * gives far richer retrieval signal than a bare node-type summary — this is the
 * difference between imports actually improving retrieval quality and being inert
 * filler (see AMENDMENT A in the repo-integration plan).
 *
 * A short hash suffix is always appended so two structurally-different workflows
 * that happen to produce the same generic fallback text can never collide with
 * FileLibrary.save()'s description-based dedup and silently overwrite each other.
 */
export function synthesizeDescription(workflow: N8nWorkflow, hash: string): string {
  const suffix = ` [${hash.slice(0, 8)}]`
  const notes = harvestStickyNotes(workflow)
  if (notes.length > 0) {
    const cleaned = notes.map((n) => cleanMarkdownText(n, 400)).join(' — ')
    return `${workflow.name}: ${cleaned}`.slice(0, 480) + suffix
  }
  const nodeSummary = Array.from(new Set(workflow.nodes.map((n) => n.type.split('.').pop() ?? ''))).slice(0, 8).join(', ')
  return `${workflow.name} (nodes: ${nodeSummary})${suffix}`
}

// ── Content-hash dedup ───────────────────────────────────────────────────

/**
 * Deterministic structural fingerprint: sorted node {type, parameter-keys} plus
 * sorted type-labeled connection edges. Stable across metadata differences (ids,
 * positions, credentials, param VALUES) so trivially-reworded or re-hosted copies
 * of the same workflow still dedup, while genuinely different workflows that just
 * happen to share a node-type multiset do not collide (edge shape disambiguates).
 */
export function computeTopologyHash(workflow: N8nWorkflow): string {
  const nodeSig = workflow.nodes
    .map((n) => `${n.type}:${Object.keys((n.parameters ?? {}) as object).sort().join(',')}`)
    .sort()
    .join('|')

  const nameToType = new Map(workflow.nodes.map((n) => [n.name, n.type]))
  const edges: string[] = []
  for (const [sourceName, connSet] of Object.entries(workflow.connections ?? {})) {
    const sourceType = nameToType.get(sourceName) ?? sourceName
    for (const [connType, portLists] of Object.entries(connSet ?? {})) {
      if (!Array.isArray(portLists)) continue
      portLists.forEach((ports, portIndex) => {
        if (!Array.isArray(ports)) return
        for (const port of ports) {
          const targetType = nameToType.get(port.node) ?? port.node
          edges.push(`${sourceType}>${connType}:${portIndex}>${targetType}`)
        }
      })
    }
  }
  edges.sort()

  return createHash('sha256').update(nodeSig + '||' + edges.join('|')).digest('hex')
}

// ── Diversity-aware selection ────────────────────────────────────────────

function sizeScore(workflow: N8nWorkflow): number {
  return Math.abs(workflow.nodes.length - 12)
}

/**
 * Selects up to `limit` candidates, guaranteeing every structural cluster gets
 * at least one slot (diversity floor) before biasing additional slots toward
 * clusters matching Kairos's own telemetry workflow-type distribution — so a
 * bulk import doesn't spend the limit on exotic integrations Kairos rarely
 * gets asked to build, at the expense of the SMB automation patterns that are
 * actually its business (AMENDMENT D). Falls back to plain round-robin when
 * workflowTypeWeights is empty (e.g. no telemetry history yet).
 */
export function selectDiverse(
  candidates: ImportCandidate[],
  limit: number,
  workflowTypeWeights: Map<string, number>,
): ImportCandidate[] {
  if (candidates.length === 0 || limit <= 0) return []
  if (candidates.length <= limit) return candidates

  const shells = candidates.map((c, i) => ({
    id: String(i),
    workflow: c.workflow,
    description: c.description,
    tags: [],
    platform: 'n8n',
    deployCount: 0,
    createdAt: new Date().toISOString(),
  } as unknown as StoredWorkflow))

  const clusters = clusterWorkflows(shells)

  interface Bucket { items: ImportCandidate[] }
  const buckets: Array<Bucket & { weight: number }> = clusters.map((cluster) => {
    const items = cluster.members
      .map((m) => candidates[Number(m.id)]!)
      .sort((a, b) => sizeScore(a.workflow) - sizeScore(b.workflow))
    const category = inferWorkflowType(items[0]?.description ?? '') ?? '__uncategorized__'
    const weight = workflowTypeWeights.get(category) ?? 0
    return { items, weight }
  })

  buckets.sort((a, b) => b.weight - a.weight || b.items.length - a.items.length)

  const selected: ImportCandidate[] = []
  const cursors = new Array(buckets.length).fill(0)

  // Pass 1: diversity floor — one item per bucket
  for (let i = 0; i < buckets.length && selected.length < limit; i++) {
    const bucket = buckets[i]!
    if (cursors[i]! < bucket.items.length) {
      selected.push(bucket.items[cursors[i]!]!)
      cursors[i]!++
    }
  }

  // Pass 2+: repeated weighted sweeps (highest-weight buckets visited first each
  // sweep) until the limit is reached or every bucket is exhausted
  let progressed = true
  while (selected.length < limit && progressed) {
    progressed = false
    for (let i = 0; i < buckets.length && selected.length < limit; i++) {
      const bucket = buckets[i]!
      if (cursors[i]! < bucket.items.length) {
        selected.push(bucket.items[cursors[i]!]!)
        cursors[i]!++
        progressed = true
      }
    }
  }

  return selected
}

// ── Auto-tagging (mirrors the existing convention in syncer.ts / client.ts) ─

function deriveAutoTags(workflow: N8nWorkflow): string[] {
  return Array.from(new Set(
    workflow.nodes.flatMap((n) => {
      const bare = n.type.split('.').pop() ?? ''
      const tags = [bare]
      if (n.type.includes('Trigger') || n.type.includes('trigger')) tags.push(`trigger:${bare}`)
      if (n.type.includes('langchain')) tags.push('ai')
      return tags
    }),
  ))
}

// ── Directory walk ───────────────────────────────────────────────────────

async function walkJsonFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkJsonFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full)
    }
  }
  return results
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export class LocalImporter {
  private readonly validator: N8nValidator

  constructor(
    private readonly library: IWorkflowLibrary,
    private readonly logger: ILogger,
  ) {
    this.validator = new N8nValidator()
  }

  async importFromDirectory(dir: string, options?: LocalImportOptions): Promise<LocalImportReport> {
    const limit = options?.limit ?? 1000
    const dryRun = options?.dryRun ?? false
    const codeNodePolicy = options?.codeNodePolicy ?? 'review'
    const workflowTypeWeights = options?.workflowTypeWeights ?? new Map()

    const progress: LocalImportProgress = {
      filesFound: 0,
      parsed: 0,
      parseErrors: 0,
      duplicates: 0,
      blocked: 0,
      reviewed: 0,
      invalid: 0,
      candidatesAfterGating: 0,
      selected: 0,
      saved: 0,
    }

    await this.library.initialize()
    const existing = await this.library.list()
    const existingHashes = new Set(
      existing.filter((w) => w.sourceKind === 'imported' && w.sourceId).map((w) => w.sourceId!),
    )
    const currentLibrarySize = existing.length

    const files = await walkJsonFiles(dir)
    progress.filesFound = files.length

    const candidates: ImportCandidate[] = []
    const seenHashesThisRun = new Set<string>()

    for (const filePath of files) {
      let raw: unknown
      try {
        const content = await readFile(filePath, 'utf-8')
        raw = JSON.parse(content)
      } catch {
        progress.parseErrors++
        continue
      }

      const workflow = normalizeImportedWorkflow(raw)
      if (!workflow) {
        progress.parseErrors++
        continue
      }
      progress.parsed++

      const hash = computeTopologyHash(workflow)
      if (existingHashes.has(hash) || seenHashesThisRun.has(hash)) {
        progress.duplicates++
        continue
      }

      const safety = assessTemplateSafety(workflow, { codeNodePolicy })
      if (safety.trustLevel === 'blocked') {
        progress.blocked++
        continue
      }
      if (safety.trustLevel === 'review') {
        progress.reviewed++
      }

      const validation = this.validator.validate(workflow)
      const errors = validation.issues.filter((i) => i.severity === 'error')
      if (errors.length > 0) {
        progress.invalid++
        continue
      }

      seenHashesThisRun.add(hash)
      candidates.push({
        workflow,
        description: synthesizeDescription(workflow, hash),
        hash,
        filePath,
        trustLevel: safety.trustLevel,
        safetyReasons: safety.reasons,
      })
      options?.onProgress?.({ ...progress })
    }

    progress.candidatesAfterGating = candidates.length

    const capacityAvailable = Math.max(0, MAX_LIBRARY_SIZE - currentLibrarySize)
    if (capacityAvailable <= 0) {
      this.logger.warn('LocalImporter: library at capacity, no room for imports', {
        currentLibrarySize,
        maxLibrarySize: MAX_LIBRARY_SIZE,
      })
      return {
        ...progress,
        capacityAvailable: 0,
        stoppedReason: `Library is at capacity (${currentLibrarySize}/${MAX_LIBRARY_SIZE}) — refusing to evict existing entries to make room for imports. Run "kairos library prune --source imported" to free space, or raise KAIROS_LIBRARY_SIZE.`,
      }
    }

    const effectiveLimit = Math.min(limit, capacityAvailable)
    const selected = selectDiverse(candidates, effectiveLimit, workflowTypeWeights)
    progress.selected = selected.length

    if (!dryRun) {
      for (const candidate of selected) {
        await this.library.save(candidate.workflow, {
          description: candidate.description,
          sourceKind: 'imported',
          sourceId: candidate.hash,
          sourceUrl: candidate.filePath,
          trustLevel: candidate.trustLevel,
          tags: deriveAutoTags(candidate.workflow),
        })
        progress.saved++
        options?.onProgress?.({ ...progress })
      }
    }

    return { ...progress, capacityAvailable }
  }
}
