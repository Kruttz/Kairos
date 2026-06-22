import type { IWorkflowLibrary, WorkflowMetadataInput } from '../library/types.js'
import type { N8nWorkflow, N8nNode } from '../types/workflow.js'
import type { ILogger } from '../utils/logger.js'
import type { TemplateSearchResponse, TemplateDetailResponse, SyncProgress } from './types.js'
import { N8nValidator } from '../validation/validator.js'
import { assessTemplateSafety } from './safety.js'

const N8N_TEMPLATE_API = 'https://api.n8n.io/api/templates'
const PAGE_SIZE = 50
const DELAY_BETWEEN_FETCHES_MS = 200

const DEFAULT_SETTINGS: N8nWorkflow['settings'] = {
  executionOrder: 'v1',
  saveManualExecutions: true,
  timezone: 'UTC',
}

export interface SyncOptions {
  maxTemplates?: number
  onProgress?: (progress: SyncProgress) => void
}

export class TemplateSyncer {
  private readonly validator: N8nValidator
  private readonly logger: ILogger

  constructor(
    private readonly library: IWorkflowLibrary,
    logger: ILogger,
  ) {
    this.validator = new N8nValidator()
    this.logger = logger
  }

  async sync(options?: SyncOptions): Promise<SyncProgress> {
    const maxTemplates = options?.maxTemplates ?? 500

    await this.library.initialize()

    const existing = await this.library.list()
    const existingSourceIds = new Set(
      existing
        .filter((w) => w.sourceKind === 'n8n-template' && w.sourceId)
        .map((w) => w.sourceId!),
    )

    const progress: SyncProgress = {
      total: 0,
      processed: 0,
      saved: 0,
      skippedPaid: 0,
      skippedDuplicate: 0,
      blocked: 0,
      reviewed: 0,
    }

    const templateIds = await this.fetchTemplateIds(maxTemplates, progress)

    for (const id of templateIds) {
      if (existingSourceIds.has(String(id))) {
        progress.skippedDuplicate++
        progress.processed++
        options?.onProgress?.(progress)
        continue
      }

      try {
        await this.processTemplate(id, progress)
      } catch (err) {
        this.logger.warn(`Failed to process template ${id}`, { err: String(err) })
      }

      progress.processed++
      options?.onProgress?.(progress)

      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_FETCHES_MS))
    }

    return progress
  }

  private async fetchTemplateIds(max: number, progress: SyncProgress): Promise<number[]> {
    const ids: number[] = []
    let page = 1

    while (ids.length < max) {
      const url = `${N8N_TEMPLATE_API}/search?page=${page}&rows=${PAGE_SIZE}`
      const response = await fetch(url)
      if (!response.ok) break

      const data = (await response.json()) as TemplateSearchResponse
      progress.total = Math.min(data.totalWorkflows, max)

      for (const template of data.workflows) {
        if (ids.length >= max) break
        if (template.price && template.price > 0) {
          progress.skippedPaid++
          continue
        }
        ids.push(template.id)
      }

      if (data.workflows.length < PAGE_SIZE) break
      page++

      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_FETCHES_MS))
    }

    return ids
  }

  private async processTemplate(id: number, progress: SyncProgress): Promise<void> {
    const url = `${N8N_TEMPLATE_API}/workflows/${id}`
    const response = await fetch(url)
    if (!response.ok) return

    const data = (await response.json()) as TemplateDetailResponse
    const templateMeta = data.workflow
    const rawWorkflow = templateMeta.workflow

    if (!rawWorkflow?.nodes?.length) return

    const workflow: N8nWorkflow = {
      name: templateMeta.name,
      nodes: rawWorkflow.nodes.filter((n) => n.type && n.name) as N8nNode[],
      connections: rawWorkflow.connections as N8nWorkflow['connections'],
      settings: rawWorkflow.settings
        ? { executionOrder: 'v1' as const, ...rawWorkflow.settings }
        : { ...DEFAULT_SETTINGS },
    }

    const validation = this.validator.validate(workflow)
    const validationErrors = validation.issues.filter((i) => i.severity === 'error')

    if (validationErrors.length > 0) {
      progress.blocked++
      this.logger.debug(`Template ${id} blocked: ${validationErrors.length} validation errors`)
      return
    }

    const safety = assessTemplateSafety(workflow)

    if (safety.trustLevel === 'blocked') {
      progress.blocked++
      this.logger.debug(`Template ${id} blocked: ${safety.reasons.join(', ')}`)
      return
    }

    if (safety.trustLevel === 'review') {
      progress.reviewed++
    }

    const description = this.cleanDescription(templateMeta.description)

    const autoTags = Array.from(new Set(
      workflow.nodes.flatMap((n) => {
        const bare = n.type.split('.').pop() ?? ''
        const tags = [bare]
        if (n.type.includes('Trigger') || n.type.includes('trigger')) tags.push(`trigger:${bare}`)
        if (n.type.includes('langchain')) tags.push('ai')
        return tags
      }),
    ))

    const metadata: WorkflowMetadataInput = {
      description,
      tags: autoTags,
      sourceKind: 'n8n-template',
      sourceId: String(id),
      sourceUrl: `https://n8n.io/workflows/${id}`,
      trustLevel: safety.trustLevel,
    }

    await this.library.save(workflow, metadata)
    progress.saved++
    this.logger.debug(`Template ${id} saved: "${templateMeta.name}" (${safety.trustLevel})`)
  }

  private cleanDescription(raw: string): string {
    return raw
      .replace(/#{1,6}\s*/g, '')
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 500)
  }
}
