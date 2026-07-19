import type { N8nWorkflow, Tag } from '../../types/workflow.js'
import type { WorkflowListItem, ExecutionSummary, ExecutionDetail } from '../../types/result.js'
import type { ExecutionFilter } from '../../types/options.js'
import type { ILogger } from '../../utils/logger.js'
import { ApiError } from '../../errors/api-error.js'
import { ProviderError } from '../../errors/provider-error.js'
import { GuardError } from '../../errors/guard-error.js'
import { withRetry, fetchWithTimeout, isTransientNetworkError } from '../../utils/retry.js'
import { buildWebhookUrl } from '../../utils/webhook-url.js'
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
const N8N_API_PAGE_SIZE = 250
const REQUEST_TIMEOUT_MS = 30_000
const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

export class N8nApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly logger: ILogger,
  ) {
    if (!baseUrl || typeof baseUrl !== 'string') {
      throw new GuardError('N8nApiClient: baseUrl must be a non-empty string')
    }
    try {
      new URL(baseUrl)
    } catch {
      throw new GuardError(`N8nApiClient: baseUrl is not a valid URL: "${baseUrl}"`)
    }
    if (!apiKey || typeof apiKey !== 'string') {
      throw new GuardError('N8nApiClient: apiKey must be a non-empty string')
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`
    this.logger.debug(`n8n ${method} ${path}`)

    const isSafe = method === 'GET'

    // Non-safe (mutating) requests retry only on transient connection errors — these mean
    // the request never reached the server, so re-sending is safe.
    if (!isSafe) {
      return withRetry(
        () => this.singleRequest<T>(url, method, path, body),
        2,
        RETRY_DELAY_MS,
        isTransientNetworkError,
      )
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
    let path = `/workflows?limit=${N8N_API_PAGE_SIZE}`

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
      path = `/workflows?limit=${N8N_API_PAGE_SIZE}&cursor=${response.nextCursor}`
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

  /**
   * Pre-existing bug found and fixed via a live reliability-suite checkpoint
   * (docs/plans/reliability-suite-plan.md, Phase 2 capture work): n8n's real API omits the
   * `data` field entirely unless `?includeData=true` is explicitly passed -- confirmed
   * directly (a raw fetch without it returns 17 fields, none named `data`; the same request
   * with it returns those 17 plus `data`/`workflowData`/`customData`). Every existing caller
   * of this method (execution-tracer.ts's fetchLatestTrace, capture.ts, mcp-server.ts,
   * pack-bundle.ts) reads `.data` and has been silently receiving `undefined` against a real
   * instance this whole time -- ExecutionDetail's own type already declared `data?: unknown`
   * as if it would be populated, so this was always a bug in the implementation, not a
   * deliberately lightweight default. Defaults to true for that reason; the one caller that
   * genuinely doesn't want the larger payload (provider.ts's pollExecution, which only reads
   * `.status` in a tight poll loop) opts out explicitly.
   */
  async getExecution(id: string, options?: { includeData?: boolean }): Promise<ExecutionDetail> {
    const includeData = options?.includeData ?? true
    const response = await this.request<N8nExecutionResponse>('GET', `/executions/${id}${includeData ? '?includeData=true' : ''}`)
    return { ...this.mapExecution(response), data: response.data, workflowData: response.workflowData }
  }

  async listTags(): Promise<Tag[]> {
    const all: Tag[] = []
    let path = `/tags?limit=${N8N_API_PAGE_SIZE}`

    for (;;) {
      const response: N8nTagListResponse = await this.request<N8nTagListResponse>('GET', path)
      for (const t of response.data) {
        all.push({ id: t.id, name: t.name })
      }
      if (!response.nextCursor) break
      path = `/tags?limit=${N8N_API_PAGE_SIZE}&cursor=${response.nextCursor}`
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

  async triggerManual(workflowId: string): Promise<string> {
    const raw = await this.request<Record<string, unknown>>('POST', `/workflows/${workflowId}/run`)
    const inner = raw['data'] as Record<string, unknown> | undefined
    const execId = inner?.['executionId'] ?? raw['executionId']
    if (execId === undefined || execId === null) {
      throw new ProviderError(
        `n8n trigger response missing executionId — got: ${JSON.stringify(raw)}`,
      )
    }
    return String(execId)
  }

  async triggerWebhookTest(path: string): Promise<number> {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    const url = `${this.baseUrl.replace(/\/$/, '')}/webhook-test${cleanPath}`
    this.logger.debug(`n8n POST webhook-test ${cleanPath}`)
    try {
      const response = await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
        REQUEST_TIMEOUT_MS,
      )
      return response.status
    } catch (err) {
      throw new ProviderError(`Webhook test request failed for path "${path}"`, err)
    }
  }

  /**
   * `payload` defaults to `{}` (verifyWebhookReachable's use case -- it only cares whether
   * the route responds, not what comes back) -- optional and backward-compatible so the one
   * existing caller (webhook-verify.ts) is unaffected. replay/runner.ts is the first real
   * caller that passes a genuine captured payload here, reusing this single, already-tested
   * injection path rather than duplicating it.
   */
  async triggerWebhookProduction(path: string, httpMethod: string, payload: unknown = {}): Promise<{ statusCode: number; body: string }> {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    const url = buildWebhookUrl(this.baseUrl, path)
    const method = httpMethod.toUpperCase()
    this.logger.debug(`n8n ${method} webhook ${cleanPath}`)
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
        },
        REQUEST_TIMEOUT_MS,
      )
      const body = await response.text()
      return { statusCode: response.status, body }
    } catch (err) {
      throw new ProviderError(`Production webhook request failed for path "${path}"`, err)
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
