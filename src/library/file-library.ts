import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { N8nWorkflow } from '../types/workflow.js'
import type {
  IWorkflowLibrary,
  WorkflowMatch,
  StoredWorkflow,
  WorkflowMetadataInput,
  LibraryFilters,
  SearchOptions,
  OutcomeData,
} from './types.js'
import { generateUUID } from '../utils/uuid.js'
import { scoreToMode } from '../utils/thresholds.js'
import { hybridScore } from './scorer.js'
import { clusterWorkflows, rerank } from './cluster.js'

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
}

export function buildSearchCorpus(w: StoredWorkflow): string {
  const nodeTokens = w.workflow.nodes.map((n) => {
    const bare = n.type.split('.').pop() ?? ''
    const spaced = bare.replace(/([A-Z])/g, ' $1').trim().toLowerCase()
    return `${bare} ${spaced}`
  })
  return `${w.description} ${w.workflow.name} ${w.tags.join(' ')} ${nodeTokens.join(' ')}`
}

const MAX_LIBRARY_SIZE = 500

export class FileLibrary implements IWorkflowLibrary {
  private readonly dir: string
  private workflows: StoredWorkflow[] = []
  private initPromise: Promise<void> | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), '.kairos', 'library')
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize()
    }
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true })

    const indexPath = join(this.dir, 'index.json')
    try {
      const raw = await readFile(indexPath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        this.workflows = []
      } else {
        this.workflows = parsed.filter(
          (item): item is StoredWorkflow =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).id === 'string' &&
            typeof (item as Record<string, unknown>).description === 'string' &&
            typeof (item as Record<string, unknown>).workflow === 'object' &&
            (item as Record<string, unknown>).workflow !== null &&
            Array.isArray(((item as Record<string, unknown>).workflow as Record<string, unknown>).nodes),
        )
      }
    } catch {
      this.workflows = []
    }
  }

  async search(description: string, options?: SearchOptions): Promise<WorkflowMatch[]> {
    const searchable = this.workflows.filter((w) => w.trustLevel !== 'blocked')
    if (searchable.length === 0) return []

    const limit = options?.limit ?? 3
    const queryTokens = tokenize(description)
    if (queryTokens.length === 0) return []

    const docTokenArrays = searchable.map((w) => tokenize(buildSearchCorpus(w)))
    const docTokenSets = docTokenArrays.map((tokens) => new Set(tokens))

    const docCount = searchable.length
    const idf = new Map<string, number>()
    const allTokens = new Set(queryTokens)
    for (const token of allTokens) {
      const docsWithToken = docTokenSets.filter((d) => d.has(token)).length
      idf.set(token, Math.log((docCount + 1) / (docsWithToken + 1)) + 1)
    }

    const scored = hybridScore(queryTokens, description, searchable, docTokenArrays, idf)
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)

    const clusters = clusterWorkflows(searchable)
    const reranked = rerank(scored, clusters).slice(0, limit)

    const results = reranked.map((m) => {
      return { workflow: m.workflow, score: m.score, mode: scoreToMode(m.score) }
    })

    if (results.length > 0) {
      for (const r of results) {
        r.workflow.timesRetrieved = (r.workflow.timesRetrieved ?? 0) + 1
      }
      this.persist()
    }

    return results
  }

  async save(workflow: N8nWorkflow, metadata: WorkflowMetadataInput): Promise<string> {
    const id = generateUUID()
    const failurePatterns = this.deduplicateFailurePatterns(metadata.failurePatterns)
    const stored: StoredWorkflow = {
      id,
      workflow,
      description: metadata.description,
      tags: metadata.tags ?? [],
      platform: metadata.platform ?? 'n8n',
      deployCount: 0,
      createdAt: new Date().toISOString(),
      ...(failurePatterns?.length ? { failurePatterns } : {}),
      ...(metadata.sourceWorkflowIds?.length ? { sourceWorkflowIds: metadata.sourceWorkflowIds } : {}),
      ...(metadata.generationMode ? { generationMode: metadata.generationMode } : {}),
      ...(metadata.topMatchScore != null ? { topMatchScore: metadata.topMatchScore } : {}),
      ...(metadata.generationAttempts != null ? { generationAttempts: metadata.generationAttempts } : {}),
      ...(metadata.credentialsNeeded?.length ? { credentialsNeeded: metadata.credentialsNeeded } : {}),
      ...(metadata.sourceKind ? { sourceKind: metadata.sourceKind } : {}),
      ...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
      ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
      ...(metadata.trustLevel ? { trustLevel: metadata.trustLevel } : {}),
    }
    this.workflows.push(stored)
    if (this.workflows.length > MAX_LIBRARY_SIZE) {
      // Sort by deployCount desc, but always keep the newly-added entry
      this.workflows.sort((a, b) => {
        if (a.id === id) return -1
        if (b.id === id) return 1
        return (b.deployCount ?? 0) - (a.deployCount ?? 0)
      })
      this.workflows = this.workflows.slice(0, MAX_LIBRARY_SIZE)
    }
    await this.persist()
    return id
  }

  async recordDeployment(id: string): Promise<void> {
    const w = this.workflows.find((w) => w.id === id)
    if (w) {
      w.deployCount++
      w.lastDeployedAt = new Date().toISOString()
      await this.persist()
    }
  }

  async recordOutcome(id: string, outcome: OutcomeData): Promise<void> {
    const w = this.workflows.find((w) => w.id === id)
    if (!w) return

    if (outcome.mode === 'direct') {
      w.timesUsedAsDirect = (w.timesUsedAsDirect ?? 0) + 1
    } else {
      w.timesUsedAsReference = (w.timesUsedAsReference ?? 0) + 1
    }

    const stats = w.outcomeStats ?? { totalUses: 0, totalAttempts: 0, firstTryPasses: 0, failedRules: {} }
    stats.totalUses++
    stats.totalAttempts += outcome.attempts
    if (outcome.firstTryPass) stats.firstTryPasses++
    for (const rule of outcome.failedRules) {
      const key = String(rule)
      stats.failedRules[key] = (stats.failedRules[key] ?? 0) + 1
    }
    w.outcomeStats = stats

    await this.persist()
  }

  async drain(): Promise<void> {
    await this.writeQueue
  }

  async get(id: string): Promise<StoredWorkflow | null> {
    return this.workflows.find((w) => w.id === id) ?? null
  }

  async list(filters?: LibraryFilters): Promise<StoredWorkflow[]> {
    let result = this.workflows
    if (filters?.platform) {
      result = result.filter((w) => w.platform === filters.platform)
    }
    if (filters?.tags && filters.tags.length > 0) {
      result = result.filter((w) => filters.tags!.some((t) => w.tags.includes(t)))
    }
    return result
  }

  private deduplicateFailurePatterns(
    patterns?: Array<{ rule: number; message: string }>,
  ): StoredWorkflow['failurePatterns'] | undefined {
    if (!patterns?.length) return undefined
    const map = new Map<number, { rule: number; message: string; occurrences: number }>()
    for (const fp of patterns) {
      const existing = map.get(fp.rule)
      if (existing) {
        existing.occurrences++
      } else {
        map.set(fp.rule, { rule: fp.rule, message: fp.message, occurrences: 1 })
      }
    }
    return [...map.values()]
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const indexPath = join(this.dir, 'index.json')

      // Re-read disk state to merge any concurrent writes from other processes
      let onDisk: StoredWorkflow[] = []
      try {
        const raw = await readFile(indexPath, 'utf-8')
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          onDisk = parsed.filter(
            (item): item is StoredWorkflow =>
              typeof item === 'object' && item !== null &&
              typeof (item as Record<string, unknown>).id === 'string',
          )
        }
      } catch { /* file doesn't exist yet */ }

      // Our in-memory state wins for IDs we know about; preserve external additions
      const ourIds = new Set(this.workflows.map((w) => w.id))
      const external = onDisk.filter((w) => !ourIds.has(w.id))
      let merged = [...this.workflows, ...external]
      if (merged.length > MAX_LIBRARY_SIZE) {
        merged.sort((a, b) => (b.deployCount ?? 0) - (a.deployCount ?? 0))
        merged = merged.slice(0, MAX_LIBRARY_SIZE)
      }

      const tmpPath = `${indexPath}.tmp`
      await writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf-8')
      await rename(tmpPath, indexPath)
    })
    return this.writeQueue
  }
}
