import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { GuardError } from '../errors/guard-error.js'
import { generateUUID } from '../utils/uuid.js'
import { nullLogger, type ILogger } from '../utils/logger.js'
import type { MemoryNode, MemoryType, MemorySource, RememberInput, MemoryIndexEntry } from './types.js'
import { rankMemories, rankMemoriesHybrid } from './retrieval.js'
import { getEmbeddingProvider, cosineSimilarity, type EmbeddingProvider } from './embeddings.js'

interface EmbeddingSidecarEntry {
  nodeId: string
  contentHash: string
  vector: number[]
}

// Fail-closed boundary: every on-disk path derives from a validated clientId, so a rejected
// id can never traverse outside its own directory or collide with another client's. Exported
// -- reliability/replay/capture.ts reuses this exact pattern for the same reason (payload
// captures are also stored under a per-client directory), rather than duplicating a
// security-relevant regex in two places where they could silently drift apart.
export const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const DEFAULT_CAP = 500
const MEMORY_TYPES: MemoryType[] = ['preference', 'history', 'incident', 'reference']
// Eviction order when over cap — oldest history first, then incident. preference/reference
// are never auto-evicted; they represent durable facts, not an accumulating log.
const EVICTION_ORDER: MemoryType[] = ['history', 'incident']

// Deliberately conservative shapes — a false positive (rejecting safe text) is far cheaper
// than a false negative (storing a real secret). Note the 40+ hex pattern also catches git
// SHAs; that's an accepted tradeoff, not an oversight — rephrase or truncate if you hit it.
// Exported -- reliability/replay/capture.ts's --scrub option redacts using this same list
// rather than duplicating it, so the two "what counts as a secret" definitions can never
// diverge.
export const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['an Anthropic API key', /sk-ant-[a-zA-Z0-9_-]{10,}/],
  ['an OpenAI-shaped API key', /sk-[a-zA-Z0-9]{20,}/],
  ['a Bearer token', /Bearer\s+[a-zA-Z0-9._-]{15,}/i],
  ['an API key assignment', /"?api[_-]?key"?\s*[:=]\s*["'`]?[a-zA-Z0-9._-]{12,}/i],
  ['a long hex string (possible token/hash/git SHA)', /\b[a-f0-9]{40,}\b/i],
  ['a long base64 string (possible secret)', /\b[A-Za-z0-9+/]{40,}={0,2}\b/],
]

export function findSecretPattern(text: string): string | null {
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return name
  }
  return null
}

function hashDescription(description: string): string {
  return createHash('sha256').update(description.trim().toLowerCase()).digest('hex')
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'memory'
}

function serializeNode(node: MemoryNode): string {
  const frontmatter = [
    '---',
    `id: ${node.id}`,
    `createdAt: ${node.createdAt}`,
    `updatedAt: ${node.updatedAt}`,
    `source: ${node.source}`,
    `type: ${node.type}`,
    `confidence: ${node.confidence}`,
    `tags: ${node.tags.join(', ')}`,
    `description: ${node.description.replace(/\n/g, ' ')}`,
    '---',
    '',
  ].join('\n')
  return frontmatter + node.body
}

function parseNode(raw: string): MemoryNode {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new GuardError('Malformed memory node: missing frontmatter')
  const [, fm, body] = match
  const fields: Record<string, string> = {}
  for (const line of fm!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    id: fields['id'] ?? '',
    createdAt: fields['createdAt'] ?? '',
    updatedAt: fields['updatedAt'] ?? '',
    source: (fields['source'] ?? 'system') as MemorySource,
    type: (fields['type'] ?? 'reference') as MemoryType,
    confidence: Number(fields['confidence'] ?? '1'),
    tags: fields['tags'] ? fields['tags'].split(',').map((t) => t.trim()).filter(Boolean) : [],
    description: fields['description'] ?? '',
    body: body ?? '',
  }
}

/**
 * Per-client persistent memory — typed markdown nodes as source of truth, a derived
 * index.json that's always rebuildable, never a hand-maintained count. No clientId means
 * the whole layer is inert: every method becomes a safe no-op, never touching the filesystem.
 */
export class ClientMemoryStore {
  private readonly logger: ILogger
  private readonly cap: number
  private readonly valid: boolean
  private readonly baseDir: string
  private readonly indexPath: string
  private readonly embeddingsPath: string

  constructor(
    clientId: string | undefined,
    options: { baseDir?: string; logger?: ILogger; cap?: number } = {},
  ) {
    this.logger = options.logger ?? nullLogger
    this.cap = options.cap ?? DEFAULT_CAP

    if (clientId === undefined) {
      this.valid = false
      this.baseDir = ''
      this.indexPath = ''
      this.embeddingsPath = ''
      this.logger.debug('ClientMemoryStore: no clientId set, memory layer is inert')
      return
    }

    if (!CLIENT_ID_PATTERN.test(clientId)) {
      throw new GuardError(
        `Invalid clientId "${clientId}" — must be lowercase alphanumeric plus hyphens, ` +
        `max 64 characters (${CLIENT_ID_PATTERN}). This is a fail-closed check: every memory ` +
        `path derives from this id, so an invalid one could otherwise enable path traversal ` +
        `or cross-client access.`,
      )
    }

    this.valid = true
    const root = options.baseDir ?? join(homedir(), '.kairos', 'clients')
    this.baseDir = join(root, clientId, 'memory')
    this.indexPath = join(this.baseDir, 'index.json')
    this.embeddingsPath = join(this.baseDir, 'embeddings.json')
  }

  get isActive(): boolean {
    return this.valid
  }

  async remember(input: RememberInput): Promise<MemoryNode | null> {
    if (!this.valid) return null

    const secretIssue = findSecretPattern(input.description) ?? findSecretPattern(input.body)
    if (secretIssue) {
      throw new GuardError(
        `Refusing to store this memory — it appears to contain ${secretIssue}. Memory nodes ` +
        `must never contain credential values, only credential types/descriptions. Remove the ` +
        `secret and try again.`,
      )
    }

    await mkdir(this.baseDir, { recursive: true })
    for (const t of MEMORY_TYPES) await mkdir(join(this.baseDir, t), { recursive: true })

    const index = await this.loadIndex()
    const descHash = hashDescription(input.description)
    const existing = index.find((e) => e.type === input.type && hashDescription(e.description) === descHash)
    const now = new Date().toISOString()

    if (existing) {
      const node: MemoryNode = {
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now,
        source: input.source ?? 'system',
        type: input.type,
        confidence: input.confidence ?? 1,
        tags: input.tags ?? [],
        description: input.description,
        body: input.body,
      }
      await writeFile(existing.path, serializeNode(node), 'utf-8')
      existing.updatedAt = now
      existing.description = input.description
      await this.saveIndex(index)
      await this.updateEmbeddingIfNeeded(node)
      return node
    }

    const id = generateUUID()
    const path = join(this.baseDir, input.type, `${slugify(input.description)}-${id.slice(0, 8)}.md`)
    const node: MemoryNode = {
      id,
      createdAt: now,
      updatedAt: now,
      source: input.source ?? 'system',
      type: input.type,
      confidence: input.confidence ?? 1,
      tags: input.tags ?? [],
      description: input.description,
      body: input.body,
    }
    await writeFile(path, serializeNode(node), 'utf-8')
    index.push({ id, path, type: input.type, description: input.description, createdAt: now, updatedAt: now })
    await this.evictIfNeeded(index)
    await this.saveIndex(index)
    await this.updateEmbeddingIfNeeded(node)
    return node
  }

  async retrieve(query: string, k = 5): Promise<MemoryNode[]> {
    if (!this.valid) return []
    try {
      const nodes = await this.loadAllNodes()
      const provider = await getEmbeddingProvider(this.logger)
      if (!provider) return rankMemories(query, nodes, k)

      const vectorScores = await this.computeVectorScores(provider, query, nodes)
      return rankMemoriesHybrid(query, nodes, vectorScores, k)
    } catch (err) {
      this.logger.warn('Memory retrieval failed, proceeding without client context', { err: String(err) })
      return []
    }
  }

  /** Recomputes and persists this node's embedding if its content changed since the last
   * embedding, or it never had one. No-op if no embedding provider is available. Failures
   * are logged, never thrown — a missing embedding just means BM25-only ranking for this
   * node until the next successful write. */
  private async updateEmbeddingIfNeeded(node: MemoryNode): Promise<void> {
    try {
      const provider = await getEmbeddingProvider(this.logger)
      if (!provider) return

      const contentHash = hashContent(`${node.description}\n${node.body}`)
      const sidecar = await this.loadEmbeddingsSidecar()
      const existingEntry = sidecar.find((e) => e.nodeId === node.id)
      if (existingEntry && existingEntry.contentHash === contentHash) return

      const [vector] = await provider.embedDocuments([node.body || node.description])
      if (!vector) return

      const updated = sidecar.filter((e) => e.nodeId !== node.id)
      updated.push({ nodeId: node.id, contentHash, vector })
      await this.saveEmbeddingsSidecar(updated)
    } catch (err) {
      this.logger.warn('Failed to compute embedding for memory node — will retry on next write', { nodeId: node.id, err: String(err) })
    }
  }

  private async computeVectorScores(
    provider: EmbeddingProvider,
    query: string,
    nodes: MemoryNode[],
  ): Promise<Map<string, number>> {
    const sidecar = await this.loadEmbeddingsSidecar()
    if (sidecar.length === 0) return new Map()

    const sidecarById = new Map(sidecar.map((e) => [e.nodeId, e]))
    const queryVector = await provider.embedQuery(query)
    const scores = new Map<string, number>()
    for (const node of nodes) {
      const entry = sidecarById.get(node.id)
      if (entry) scores.set(node.id, cosineSimilarity(queryVector, entry.vector))
    }
    return scores
  }

  private async loadEmbeddingsSidecar(): Promise<EmbeddingSidecarEntry[]> {
    try {
      const raw = await readFile(this.embeddingsPath, 'utf-8')
      return JSON.parse(raw) as EmbeddingSidecarEntry[]
    } catch {
      return []
    }
  }

  private async saveEmbeddingsSidecar(entries: EmbeddingSidecarEntry[]): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await writeFile(this.embeddingsPath, JSON.stringify(entries), 'utf-8')
  }

  async loadAllNodes(): Promise<MemoryNode[]> {
    if (!this.valid) return []
    const index = await this.loadIndex()
    const nodes: MemoryNode[] = []
    for (const entry of index) {
      const node = await this.readNode(entry.path).catch(() => null)
      if (node) nodes.push(node)
    }
    return nodes
  }

  async forget(id: string): Promise<boolean> {
    if (!this.valid) return false
    const index = await this.loadIndex()
    const entry = index.find((e) => e.id === id)
    if (!entry) return false
    await unlink(entry.path).catch(() => {})
    await this.saveIndex(index.filter((e) => e.id !== id))
    await this.removeEmbedding(id)
    return true
  }

  private async removeEmbedding(nodeId: string): Promise<void> {
    const sidecar = await this.loadEmbeddingsSidecar()
    if (!sidecar.some((e) => e.nodeId === nodeId)) return
    await this.saveEmbeddingsSidecar(sidecar.filter((e) => e.nodeId !== nodeId)).catch(() => {})
  }

  /** Regenerates index.json from the .md files on disk — the no-drift guarantee. */
  async rebuildIndex(): Promise<number> {
    if (!this.valid) return 0
    const entries: MemoryIndexEntry[] = []
    for (const type of MEMORY_TYPES) {
      const dir = join(this.baseDir, type)
      if (!existsSync(dir)) continue
      const files = await readdir(dir).catch(() => [] as string[])
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        const path = join(dir, f)
        const node = await this.readNode(path).catch(() => null)
        if (node) {
          entries.push({ id: node.id, path, type: node.type, description: node.description, createdAt: node.createdAt, updatedAt: node.updatedAt })
        }
      }
    }
    await mkdir(this.baseDir, { recursive: true })
    await this.saveIndex(entries)
    return entries.length
  }

  private async readNode(path: string): Promise<MemoryNode> {
    const raw = await readFile(path, 'utf-8')
    return parseNode(raw)
  }

  private async loadIndex(): Promise<MemoryIndexEntry[]> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8')
      return JSON.parse(raw) as MemoryIndexEntry[]
    } catch {
      return []
    }
  }

  private async saveIndex(index: MemoryIndexEntry[]): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8')
  }

  private async evictIfNeeded(index: MemoryIndexEntry[]): Promise<void> {
    if (index.length <= this.cap) return
    let overBy = index.length - this.cap
    const evictedIds: string[] = []
    for (const type of EVICTION_ORDER) {
      if (overBy <= 0) break
      const candidates = index.filter((e) => e.type === type).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      for (const c of candidates) {
        if (overBy <= 0) break
        await unlink(c.path).catch(() => {})
        const idx = index.indexOf(c)
        if (idx >= 0) index.splice(idx, 1)
        evictedIds.push(c.id)
        overBy--
      }
    }
    if (evictedIds.length > 0) {
      const sidecar = await this.loadEmbeddingsSidecar()
      const evictedSet = new Set(evictedIds)
      const remaining = sidecar.filter((e) => !evictedSet.has(e.nodeId))
      if (remaining.length !== sidecar.length) await this.saveEmbeddingsSidecar(remaining).catch(() => {})
    }
  }
}
