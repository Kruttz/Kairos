import type { N8nWorkflow, Tag } from '../../types/workflow.js'
import type { WorkflowListItem, ExecutionSummary, ExecutionDetail } from '../../types/result.js'
import type { ExecutionFilter } from '../../types/options.js'
import type { ILogger } from '../../utils/logger.js'
import { ApiError } from '../../errors/api-error.js'
import { ProviderError } from '../../errors/provider-error.js'
import { withRetry, fetchWithTimeout } from '../../utils/retry.js'
import type {
  N8nWorkflowResponse,
  N8nWorkflowListResponse,
  N8nExecutionResponse,
  N8nExecutionListResponse,
  N8nTagResponse,
  N8nTagListResponse,
  N8nNodeTypeInfo,
  N8nNodeTypeListResponse,
} from './types.js'

const EXECUTION_LIMIT_CAP = 100
const REQUEST_TIMEOUT_MS = 30_000
const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

export class N8nApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly logger: ILogger,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`
    this.logger.debug(`n8n ${method} ${path}`)

    const isSafe = method === 'GET'
    if (!isSafe) {
      return this.singleRequest<T>(url, method, path, body)
    }

    return withRetry(
      () => this.singleRequest<T>(url, method, path, body),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
      (err) => err instanceof ProviderError || (err instanceof ApiError && err.statusCode === 429),
    )
  }

  private async singleRequest<T>(url: string, method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetchWithTimeout(url, {
        method,
        headers: {
          'X-N8N-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }, REQUEST_TIMEOUT_MS)
    } catch (err) {
      throw new ProviderError(`Network error calling n8n API: ${path}`, err)
    }

    if (!response.ok) {
      let errorBody: unknown
      try {
        errorBody = await response.json()
      } catch {
        errorBody = await response.text().catch(() => '')
      }
      this.logger.error(`n8n API error ${response.status} on ${method} ${path}`, {
        status: response.status,
        body: String(errorBody),
      })
      throw new ApiError(
        `n8n API returned ${response.status} for ${method} ${path}: ${JSON.stringify(errorBody)}`,
        response.status,
        errorBody,
      )
    }

    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  async createWorkflow(workflow: N8nWorkflow): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('POST', '/workflows', workflow)
  }

  async updateWorkflow(id: string, workflow: N8nWorkflow): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('PUT', `/workflows/${id}`, workflow)
  }

  async getWorkflow(id: string): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('GET', `/workflows/${id}`)
  }

  async listWorkflows(): Promise<WorkflowListItem[]> {
    const all: WorkflowListItem[] = []
    let path = '/workflows?limit=250'

    for (;;) {
      const response: N8nWorkflowListResponse = await this.request<N8nWorkflowListResponse>('GET', path)
      for (const w of response.data) {
        all.push({
          id: w.id,
          name: w.name,
          active: w.active,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          ...(w.tags !== undefined ? { tags: w.tags } : {}),
        })
      }
      if (!response.nextCursor) break
      path = `/workflows?limit=250&cursor=${response.nextCursor}`
    }

    return all
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.request<void>('DELETE', `/workflows/${id}`)
  }

  async activateWorkflow(id: string): Promise<void> {
    await this.request<void>('POST', `/workflows/${id}/activate`)
  }

  async deactivateWorkflow(id: string): Promise<void> {
    await this.request<void>('POST', `/workflows/${id}/deactivate`)
  }

  async getExecutions(workflowId?: string, filter?: ExecutionFilter): Promise<ExecutionSummary[]> {
    const params = new URLSearchParams()
    if (workflowId) params.set('workflowId', workflowId)
    if (filter?.status) params.set('status', filter.status)
    const limit = Math.min(filter?.limit ?? 20, EXECUTION_LIMIT_CAP)
    params.set('limit', String(limit))
    if (filter?.cursor) params.set('cursor', filter.cursor)

    const qs = params.toString()
    const response = await this.request<N8nExecutionListResponse>('GET', `/executions${qs ? `?${qs}` : ''}`)
    return response.data.map(this.mapExecution)
  }

  async getExecution(id: string): Promise<ExecutionDetail> {
    const response = await this.request<N8nExecutionResponse>('GET', `/executions/${id}`)
    return { ...this.mapExecution(response), data: response.data, workflowData: response.workflowData }
  }

  async listTags(): Promise<Tag[]> {
    const all: Tag[] = []
    let path = '/tags?limit=250'

    for (;;) {
      const response: N8nTagListResponse = await this.request<N8nTagListResponse>('GET', path)
      for (const t of response.data) {
        all.push({ id: t.id, name: t.name })
      }
      if (!response.nextCursor) break
      path = `/tags?limit=250&cursor=${response.nextCursor}`
    }

    return all
  }

  async createTag(name: string): Promise<Tag> {
    const response = await this.request<N8nTagResponse>('POST', '/tags', { name })
    return { id: response.id, name: response.name }
  }

  async tagWorkflow(workflowId: string, tagIds: string[]): Promise<void> {
    await this.request<void>('PUT', `/workflows/${workflowId}/tags`, tagIds.map((id) => ({ id })))
  }

  async untagWorkflow(workflowId: string, tagIds: string[]): Promise<void> {
    const current = await this.getWorkflow(workflowId)
    const remaining = (current.tags ?? [])
      .filter((t) => !tagIds.includes(t.id))
      .map((t) => ({ id: t.id }))
    await this.request<void>('PUT', `/workflows/${workflowId}/tags`, remaining)
  }

  async getNodeTypes(): Promise<N8nNodeTypeInfo[]> {
    try {
      const response = await this.request<N8nNodeTypeListResponse>('GET', '/node-types')
      return response.data ?? response as unknown as N8nNodeTypeInfo[]
    } catch {
      return []
    }
  }

  private mapExecution(e: N8nExecutionResponse): ExecutionSummary {
    return {
      id: e.id,
      workflowId: e.workflowId,
      status: e.status,
      startedAt: e.startedAt,
      ...(e.stoppedAt !== undefined ? { stoppedAt: e.stoppedAt } : {}),
      mode: e.mode,
    }
  }
}
