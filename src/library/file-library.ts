import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
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

export class FileLibrary implements IWorkflowLibrary {
  private readonly dir: string
  private workflows: StoredWorkflow[] = []
  private initialized = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), '.kairos', 'library')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.dir, { recursive: true })

    const indexPath = join(this.dir, 'index.json')
    try {
      const raw = await readFile(indexPath, 'utf-8')
      this.workflows = JSON.parse(raw) as StoredWorkflow[]
    } catch {
      this.workflows = []
    }
    this.initialized = true
  }

  async search(description: string, options?: SearchOptions): Promise<WorkflowMatch[]> {
    if (this.workflows.length === 0) return []

    const limit = options?.limit ?? 3
    const queryTokens = tokenize(description)
    if (queryTokens.length === 0) return []

    const docTokenSets = this.workflows.map((w) =>
      tokenize(`${w.description} ${w.workflow.name} ${w.tags.join(' ')}`),
    )

    const docCount = this.workflows.length
    const idf = new Map<string, number>()
    const allTokens = new Set(queryTokens)
    for (const token of allTokens) {
      const docsWithToken = docTokenSets.filter((d) => d.includes(token)).length
      idf.set(token, Math.log((docCount + 1) / (docsWithToken + 1)) + 1)
    }

    const scored = this.workflows
      .map((w, i) => ({
        workflow: w,
        score: computeTfIdf(queryTokens, docTokenSets[i]!, idf),
      }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored.map((m) => ({
      workflow: m.workflow,
      score: m.score,
      mode: scoreToMode(m.score),
    }))
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
      deployCount: 1,
      createdAt: new Date().toISOString(),
      ...(failurePatterns?.length ? { failurePatterns } : {}),
      ...(metadata.sourceWorkflowIds?.length ? { sourceWorkflowIds: metadata.sourceWorkflowIds } : {}),
      ...(metadata.generationMode ? { generationMode: metadata.generationMode } : {}),
      ...(metadata.topMatchScore != null ? { topMatchScore: metadata.topMatchScore } : {}),
      ...(metadata.generationAttempts != null ? { generationAttempts: metadata.generationAttempts } : {}),
      ...(metadata.credentialsNeeded?.length ? { credentialsNeeded: metadata.credentialsNeeded } : {}),
    }
    this.workflows.push(stored)
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
      await writeFile(indexPath, JSON.stringify(this.workflows, null, 2), 'utf-8')
    })
    return this.writeQueue
  }
}
