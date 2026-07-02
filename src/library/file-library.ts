import { readFile, writeFile, rename, mkdir, stat, readdir, unlink, open } from 'node:fs/promises'
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
  EmbeddingFn,
} from './types.js'
import { generateUUID } from '../utils/uuid.js'
import { scoreToMode } from '../utils/thresholds.js'
import { hybridScore } from './scorer.js'
import type { EmbeddingData } from './scorer.js'
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

const _rawSize = parseInt(process.env['KAIROS_LIBRARY_SIZE'] ?? '500', 10)
const MAX_LIBRARY_SIZE = Number.isFinite(_rawSize) && _rawSize >= 10 ? _rawSize : 500

function evictionScore(m: StoredWorkflowMeta): number {
  return (m.deployCount ?? 0) * 3 + (m.timesRetrieved ?? 0) + (m.outcomeStats?.totalUses ?? 0)
}

/**
 * Internal per-file format: everything from StoredWorkflow except the workflow field,
 * plus two cache fields used to rebuild search corpus without loading workflow files.
 */
type StoredWorkflowMeta = Omit<StoredWorkflow, 'workflow'> & {
  workflowName: string       // n8n workflow name (copied at save time for search)
  cachedNodeTypes: string[]  // full node type strings (e.g. "n8n-nodes-base.slack")
}

function isValidMeta(item: unknown): item is StoredWorkflowMeta {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as Record<string, unknown>).id === 'string' &&
    typeof (item as Record<string, unknown>).description === 'string' &&
    typeof (item as Record<string, unknown>).workflowName === 'string' &&
    Array.isArray((item as Record<string, unknown>).cachedNodeTypes)
  )
}

function isValidOldEntry(item: unknown): item is StoredWorkflow {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as Record<string, unknown>).id === 'string' &&
    typeof (item as Record<string, unknown>).description === 'string' &&
    typeof (item as Record<string, unknown>).workflow === 'object' &&
    (item as Record<string, unknown>).workflow !== null &&
    Array.isArray(
      ((item as Record<string, unknown>).workflow as Record<string, unknown>).nodes,
    )
  )
}

const EMBEDDING_CACHE_FILE = 'embedding-cache.json'
const EMBEDDING_TIMEOUT_MS = 2_000

export class FileLibrary implements IWorkflowLibrary {
  private readonly dir: string
  private meta: StoredWorkflowMeta[] = []
  private initPromise: Promise<void> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly embeddingFn: EmbeddingFn | undefined
  private embeddingCache: Map<string, number[]> = new Map()
  private embeddingCacheLoaded = false
  private embeddingWriteQueue: Promise<void> = Promise.resolve()

  constructor(dir?: string, options?: { embeddingFn?: EmbeddingFn }) {
    this.dir = dir ?? join(homedir(), '.kairos', 'library')
    this.embeddingFn = options?.embeddingFn
  }

  private get workflowsDir(): string {
    return join(this.dir, 'workflows')
  }

  private workflowFilePath(id: string): string {
    return join(this.workflowsDir, `${id}.json`)
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

    // New format has a 'workflows/' subdirectory; old format does not
    let workflowsDirExists = false
    try {
      await stat(this.workflowsDir)
      workflowsDirExists = true
    } catch {
      // Directory absent — old format or fresh start
    }

    if (workflowsDirExists) {
      // New per-file format: index.json holds lightweight meta only
      try {
        const raw = await readFile(indexPath, 'utf-8')
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.meta = parsed.filter(isValidMeta)
        }
      } catch {
        this.meta = []
      }
      await this.scanForOrphansAndCleanup()
    } else {
      // Attempt to read old monolithic format
      try {
        const raw = await readFile(indexPath, 'utf-8')
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0 && isValidOldEntry(parsed[0])) {
          await this.migrateFromMonolithic(parsed.filter(isValidOldEntry))
          return
        }
      } catch {
        // No index.json — fresh start
      }
      this.meta = []
      await mkdir(this.workflowsDir, { recursive: true })
    }
  }

  private async scanForOrphansAndCleanup(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.workflowsDir)
    } catch {
      return
    }

    const indexedIds = new Set(this.meta.map((m) => m.id))
    const orphanIds: string[] = []

    for (const filename of entries) {
      if (filename.endsWith('.tmp')) {
        // Leftover from an interrupted atomic rename — safe to delete
        await unlink(join(this.workflowsDir, filename)).catch(() => {})
        continue
      }
      if (!filename.endsWith('.json')) continue
      const id = filename.slice(0, -5)
      if (!indexedIds.has(id)) {
        orphanIds.push(id)
      }
    }

    if (orphanIds.length > 0) {
      // Log but do not delete — caller can decide what to do
      console.warn(`[FileLibrary] Found ${orphanIds.length} orphaned workflow file(s) not in index: ${orphanIds.join(', ')}`)
    }
  }

  /**
   * One-time transparent migration from v0.4.x monolithic index.json.
   * Splits each stored workflow into a per-file workflow JSON and a lightweight
   * meta entry. Rewrites index.json in the new format.
   */
  private async migrateFromMonolithic(oldEntries: StoredWorkflow[]): Promise<void> {
    await mkdir(this.workflowsDir, { recursive: true })

    const newMeta: StoredWorkflowMeta[] = []
    for (const entry of oldEntries) {
      const wfPath = this.workflowFilePath(entry.id)
      const tmpPath = `${wfPath}.tmp`
      await writeFile(tmpPath, JSON.stringify(entry.workflow), 'utf-8')
      await rename(tmpPath, wfPath)

      const { workflow, ...metaFields } = entry
      newMeta.push({
        ...metaFields,
        workflowName: workflow.name,
        cachedNodeTypes: workflow.nodes.map((n) => n.type),
      })
    }

    this.meta = newMeta
    // Write new lightweight index.json (no workflow fields)
    await this.persistNow()
  }

  private async loadWorkflowFile(id: string): Promise<N8nWorkflow | null> {
    try {
      const raw = await readFile(this.workflowFilePath(id), 'utf-8')
      return JSON.parse(raw) as N8nWorkflow
    } catch {
      return null
    }
  }

  private async writeWorkflowFile(id: string, workflow: N8nWorkflow): Promise<void> {
    const wfPath = this.workflowFilePath(id)
    const tmpPath = `${wfPath}.tmp`
    await writeFile(tmpPath, JSON.stringify(workflow), 'utf-8')
    await rename(tmpPath, wfPath)
  }

  /**
   * Build a lightweight StoredWorkflow shell from a meta entry for use in
   * scoring / clustering. Only node.type is populated in each node — no other
   * node fields are used by hybridScore or clusterWorkflows.
   */
  private makeSearchShell(m: StoredWorkflowMeta): StoredWorkflow {
    return {
      ...m,
      workflow: {
        name: m.workflowName,
        nodes: m.cachedNodeTypes.map((type) => ({
          id: '',
          name: '',
          type,
          typeVersion: 1,
          position: [0, 0] as [number, number],
          parameters: {},
        })),
        connections: {},
      },
    } as StoredWorkflow
  }

  private get embeddingCachePath(): string {
    return join(this.dir, EMBEDDING_CACHE_FILE)
  }

  private async loadEmbeddingCache(): Promise<void> {
    if (this.embeddingCacheLoaded) return
    this.embeddingCacheLoaded = true
    try {
      const raw = await readFile(this.embeddingCachePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, number[]>
      for (const [id, vec] of Object.entries(parsed)) {
        if (Array.isArray(vec)) this.embeddingCache.set(id, vec)
      }
    } catch {
      // Cache doesn't exist yet — start fresh
    }
  }

  private async saveEmbeddingCache(): Promise<void> {
    const obj: Record<string, number[]> = {}
    for (const [id, vec] of this.embeddingCache) obj[id] = vec
    const tmpPath = `${this.embeddingCachePath}.tmp`
    await writeFile(tmpPath, JSON.stringify(obj), 'utf-8')
    await rename(tmpPath, this.embeddingCachePath)
  }

  private async computeEmbedding(text: string): Promise<number[] | null> {
    if (!this.embeddingFn) return null
    try {
      const result = await Promise.race([
        this.embeddingFn(text),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), EMBEDDING_TIMEOUT_MS)),
      ])
      return result
    } catch {
      return null
    }
  }

  async search(description: string, options?: SearchOptions): Promise<WorkflowMatch[]> {
    const filteredMeta = this.meta.filter((m) => m.trustLevel !== 'blocked')
    if (filteredMeta.length === 0) return []

    const limit = options?.limit ?? 3
    const queryTokens = tokenize(description)
    if (queryTokens.length === 0) return []

    // Build lightweight shells — no file I/O, all data comes from cached meta
    const shells = filteredMeta.map((m) => this.makeSearchShell(m))

    const docTokenArrays = shells.map((w) => tokenize(buildSearchCorpus(w)))
    const docTokenSets = docTokenArrays.map((tokens) => new Set(tokens))

    const docCount = shells.length
    const idf = new Map<string, number>()
    const idfCeiling = Math.log(docCount + 1) + 1  // max IDF when term appears in 0 docs
    const allTokens = new Set(queryTokens)
    for (const token of allTokens) {
      const docsWithToken = docTokenSets.filter((d) => d.has(token)).length
      const rawIdf = Math.log((docCount + 1) / (docsWithToken + 1)) + 1
      idf.set(token, rawIdf / idfCeiling)  // normalize to [0, 1] regardless of corpus size
    }

    // Embedding-based hybrid scoring (optional — falls back to BM25 if fn not provided or times out)
    let embeddingData: EmbeddingData | undefined
    if (this.embeddingFn) {
      await this.loadEmbeddingCache()

      // Lazily compute embeddings for workflows not yet in cache (max 5 per search to cap latency)
      const uncached = filteredMeta
        .filter((m) => !this.embeddingCache.has(m.id))
        .slice(0, 5)
      if (uncached.length > 0) {
        const newEntries = await Promise.all(
          uncached.map(async (m) => {
            const text = `${m.description} ${m.tags.join(' ')}`
            const vec = await this.computeEmbedding(text)
            return { id: m.id, vec }
          }),
        )
        let cacheUpdated = false
        for (const { id, vec } of newEntries) {
          if (vec) { this.embeddingCache.set(id, vec); cacheUpdated = true }
        }
        if (cacheUpdated) {
          this.embeddingWriteQueue = this.embeddingWriteQueue.then(() =>
            this.saveEmbeddingCache().catch(() => {}),
          )
        }
      }

      const queryVector = await this.computeEmbedding(description)
      if (queryVector) {
        embeddingData = { queryVector, workflowVectors: this.embeddingCache }
      }
    }

    const scored = hybridScore(queryTokens, description, shells, docTokenArrays, idf, embeddingData)
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)

    const clusters = clusterWorkflows(shells)
    const reranked = rerank(scored, clusters).slice(0, limit)

    if (reranked.length === 0) return []

    // Update timesRetrieved in meta before persisting
    for (const r of reranked) {
      const m = this.meta.find((m) => m.id === r.workflow.id)
      if (m) m.timesRetrieved = (m.timesRetrieved ?? 0) + 1
    }
    this.persist()

    // Lazy-load full workflow files for the top matches only
    const results = await Promise.all(
      reranked.map(async (r) => {
        const m = this.meta.find((meta) => meta.id === r.workflow.id)!
        const workflow = await this.loadWorkflowFile(r.workflow.id)
        if (!workflow) return null
        return {
          workflow: { ...m, workflow } as StoredWorkflow,
          score: r.score,
          mode: scoreToMode(r.score),
        } as WorkflowMatch
      }),
    )

    return results.filter((r): r is WorkflowMatch => r !== null)
  }

  async save(workflow: N8nWorkflow, metadata: WorkflowMetadataInput): Promise<string> {
    // Prefer matching by n8nWorkflowId when redeploying — prevents duplicate library entries
    const existingByN8nId = metadata.n8nWorkflowId
      ? this.meta.find((m) => m.n8nWorkflowId === metadata.n8nWorkflowId)
      : undefined

    // Fall back to description dedup for newly saved workflows
    const normalizedDesc = metadata.description.trim().toLowerCase()
    const existing = existingByN8nId
      ?? this.meta.find((m) => m.description.trim().toLowerCase() === normalizedDesc)

    if (existing) {
      existing.description = metadata.description  // update description on redeploy
      existing.workflowName = workflow.name
      existing.cachedNodeTypes = workflow.nodes.map((n) => n.type)
      if (metadata.n8nWorkflowId) existing.n8nWorkflowId = metadata.n8nWorkflowId
      if (metadata.generationAttempts != null) {
        existing.generationAttempts = metadata.generationAttempts
      }
      if (metadata.failurePatterns?.length) {
        existing.failurePatterns = this.deduplicateFailurePatterns(metadata.failurePatterns)!
      }
      if (metadata.tags?.length) {
        existing.tags = [...new Set([...existing.tags, ...metadata.tags])]
      }
      await this.writeWorkflowFile(existing.id, workflow)
      await this.persist()
      return existing.id
    }

    const id = generateUUID()

    // Write workflow file first (data before index entry — crash-safe WAL pattern)
    await this.writeWorkflowFile(id, workflow)

    const failurePatterns = this.deduplicateFailurePatterns(metadata.failurePatterns)
    const meta: StoredWorkflowMeta = {
      id,
      description: metadata.description,
      tags: metadata.tags ?? [],
      platform: metadata.platform ?? 'n8n',
      deployCount: 0,
      createdAt: new Date().toISOString(),
      workflowName: workflow.name,
      cachedNodeTypes: workflow.nodes.map((n) => n.type),
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
      ...(metadata.n8nWorkflowId ? { n8nWorkflowId: metadata.n8nWorkflowId } : {}),
    }

    this.meta.push(meta)
    if (this.meta.length > MAX_LIBRARY_SIZE) {
      // Evict by composite usage score ascending; always keep the newly-added entry
      this.meta.sort((a, b) => {
        if (a.id === id) return -1
        if (b.id === id) return 1
        return evictionScore(b) - evictionScore(a)
      })
      this.meta = this.meta.slice(0, MAX_LIBRARY_SIZE)
    }

    await this.persist()
    return id
  }

  async recordDeployment(id: string, n8nWorkflowId?: string): Promise<void> {
    const m = this.meta.find((m) => m.id === id)
    if (m) {
      m.deployCount++
      m.lastDeployedAt = new Date().toISOString()
      if (n8nWorkflowId) m.n8nWorkflowId = n8nWorkflowId
      await this.persist()
    }
  }

  async recordOutcome(id: string, outcome: OutcomeData): Promise<void> {
    const m = this.meta.find((m) => m.id === id)
    if (!m) return

    if (outcome.mode === 'direct') {
      m.timesUsedAsDirect = (m.timesUsedAsDirect ?? 0) + 1
    } else {
      m.timesUsedAsReference = (m.timesUsedAsReference ?? 0) + 1
    }

    const stats = m.outcomeStats ?? { totalUses: 0, totalAttempts: 0, firstTryPasses: 0, failedRules: {} }
    stats.totalUses++
    stats.totalAttempts += outcome.attempts
    if (outcome.firstTryPass) stats.firstTryPasses++
    for (const rule of outcome.failedRules) {
      const key = String(rule)
      stats.failedRules[key] = (stats.failedRules[key] ?? 0) + 1
    }
    m.outcomeStats = stats

    await this.persist()
  }

  async recordTrace(id: string, trace: import('../library/types.js').ExecutionTrace): Promise<void> {
    const m = this.meta.find((m) => m.id === id)
    if (!m) return

    const { mergeTraces, computeRuntimeReliability } = await import('../telemetry/execution-tracer.js')
    const existing = m.executionTraces ?? []
    m.executionTraces = mergeTraces(existing, trace)
    m.runtimeReliabilityScore = computeRuntimeReliability(m.executionTraces)
    await this.persist()
  }

  async drain(): Promise<void> {
    await Promise.all([this.writeQueue, this.embeddingWriteQueue])
  }

  async get(id: string): Promise<StoredWorkflow | null> {
    const m = this.meta.find((m) => m.id === id)
    if (!m) return null
    const workflow = await this.loadWorkflowFile(id)
    if (!workflow) return null
    return { ...m, workflow } as StoredWorkflow
  }

  async list(filters?: LibraryFilters): Promise<StoredWorkflow[]> {
    let filtered = this.meta
    if (filters?.platform) {
      filtered = filtered.filter((m) => m.platform === filters.platform)
    }
    if (filters?.tags && filters.tags.length > 0) {
      filtered = filtered.filter((m) => filters.tags!.some((t) => m.tags.includes(t)))
    }

    const results = await Promise.all(
      filtered.map(async (m) => {
        const workflow = await this.loadWorkflowFile(m.id)
        if (!workflow) return null
        return { ...m, workflow } as StoredWorkflow
      }),
    )

    return results.filter((r): r is StoredWorkflow => r !== null)
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

  // ── Cross-process file locking ────────────────────────────────────────────
  // Uses O_EXCL (exclusive create) which is atomic on POSIX and Windows NTFS.
  // Protects the read-modify-write cycle in persist() from concurrent writers
  // in separate OS processes (e.g. MCP server + CLI running simultaneously).

  private get lockPath(): string {
    return join(this.dir, '.index.lock')
  }

  private async acquireLock(timeoutMs = 3_000): Promise<() => Promise<void>> {
    const deadline = Date.now() + timeoutMs
    let delayMs = 10

    while (true) {
      try {
        // O_EXCL: fail if the file already exists — atomic on POSIX + NTFS
        const fh = await open(this.lockPath, 'wx')
        await fh.writeFile(String(process.pid))
        await fh.close()
        return async () => { await unlink(this.lockPath).catch(() => {}) }
      } catch {
        // Lock file exists — check if it's stale
        try {
          const content = await readFile(this.lockPath, 'utf-8')
          const lockPid = parseInt(content.trim(), 10)
          const fileStat = await stat(this.lockPath)
          const ageMs = Date.now() - fileStat.mtimeMs

          if (ageMs > 10_000) {
            // Lock is over 10 seconds old — definitely stale
            await unlink(this.lockPath).catch(() => {})
            continue
          }

          if (!isNaN(lockPid)) {
            try {
              process.kill(lockPid, 0) // throws ESRCH if PID is dead
            } catch {
              await unlink(this.lockPath).catch(() => {})
              continue
            }
          }
        } catch {
          // Lock file was removed between our read and check — retry immediately
          continue
        }

        if (Date.now() > deadline) {
          // Can't acquire within timeout — proceed with a warning (degraded mode)
          return async () => {}
        }
        await new Promise<void>((r) => setTimeout(r, delayMs))
        delayMs = Math.min(delayMs * 1.5, 200)
      }
    }
  }

  /**
   * Direct write used only during migration (before writeQueue is needed).
   */
  private async persistNow(): Promise<void> {
    const releaseLock = await this.acquireLock()
    try {
      const indexPath = join(this.dir, 'index.json')
      const tmpPath = `${indexPath}.tmp`
      await writeFile(tmpPath, JSON.stringify(this.meta, null, 2), 'utf-8')
      await rename(tmpPath, indexPath)
    } finally {
      await releaseLock()
    }
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const releaseLock = await this.acquireLock()
      try {
        const indexPath = join(this.dir, 'index.json')

        // Re-read disk state to preserve concurrent additions from other processes
        let onDisk: StoredWorkflowMeta[] = []
        try {
          const raw = await readFile(indexPath, 'utf-8')
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            onDisk = parsed.filter(isValidMeta)
          }
        } catch { /* index.json doesn't exist yet */ }

        // Our in-memory state wins for IDs we manage; add any entries added by other processes
        const ourIds = new Set(this.meta.map((m) => m.id))
        const external = onDisk.filter((m) => !ourIds.has(m.id))
        let merged = [...this.meta, ...external]
        if (merged.length > MAX_LIBRARY_SIZE) {
          merged.sort((a, b) => evictionScore(b) - evictionScore(a))
          merged = merged.slice(0, MAX_LIBRARY_SIZE)
        }

        const tmpPath = `${indexPath}.tmp`
        await writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf-8')
        await rename(tmpPath, indexPath)
      } finally {
        await releaseLock()
      }
    })
    return this.writeQueue
  }
}
