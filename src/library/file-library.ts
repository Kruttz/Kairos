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
} from './types.js'
import { generateUUID } from '../utils/uuid.js'
import { scoreToMode } from '../utils/thresholds.js'

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
}

function buildSearchCorpus(w: StoredWorkflow): string {
  const nodeTokens = w.workflow.nodes.map((n) => {
    const bare = n.type.split('.').pop() ?? ''
    const spaced = bare.replace(/([A-Z])/g, ' $1').trim().toLowerCase()
    return `${bare} ${spaced}`
  })
  return `${w.description} ${w.workflow.name} ${w.tags.join(' ')} ${nodeTokens.join(' ')}`
}

function computeTfIdf(queryTokens: string[], docTokens: string[], idf: Map<string, number>): number {
  if (docTokens.length === 0) return 0
  let score = 0
  const docFreq = new Map<string, number>()
  for (const t of docTokens) {
    docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  }
  for (const qt of queryTokens) {
    const tf = (docFreq.get(qt) ?? 0) / docTokens.length
    const idfVal = idf.get(qt) ?? 0
    score += tf * idfVal
  }
  return score
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

    const maxPossibleScore = queryTokens.reduce((sum, qt) => sum + (idf.get(qt) ?? 0), 0)
    const ceiling = maxPossibleScore > 0 ? maxPossibleScore : 1

    const scored = searchable
      .map((w, i) => {
        const raw = computeTfIdf(queryTokens, docTokenArrays[i]!, idf)
        const normalized = Math.min(raw / ceiling, 1)
        const deployBoost = 1 + Math.log(w.deployCount + 1) * 0.05
        const boosted = Math.min(normalized * deployBoost, 1)
        return { workflow: w, score: boosted }
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored.map((m) => {
      return { workflow: m.workflow, score: m.score, mode: scoreToMode(m.score) }
    })
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
      this.workflows.sort((a, b) => (b.deployCount ?? 1) - (a.deployCount ?? 1))
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
      const tmpPath = `${indexPath}.tmp`
      await writeFile(tmpPath, JSON.stringify(this.workflows, null, 2), 'utf-8')
      await rename(tmpPath, indexPath)
    })
    return this.writeQueue
  }
}
