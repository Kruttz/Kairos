import type { N8nWorkflow, Tag } from '../../types/workflow.js'
import type { DeployResult, WorkflowListItem, ExecutionSummary, ExecutionDetail, SmokeTestResult } from '../../types/result.js'
import type { DeleteOptions, ExecutionFilter } from '../../types/options.js'
import type { IProvider } from '../types.js'
import { GuardError } from '../../errors/guard-error.js'
import { ProviderError } from '../../errors/provider-error.js'
import { ApiError } from '../../errors/api-error.js'
import { N8nApiClient } from './api-client.js'
import { N8nFieldStripper } from './stripper.js'
import { verifyWebhookReachable, type WebhookReachabilityResult } from '../../utils/webhook-verify.js'

const SMOKE_TEST_TIMEOUT_MS = 30_000
const SMOKE_TEST_POLL_INTERVAL_MS = 1_000

type TriggerInfo =
  | { type: 'manual' }
  | { type: 'webhook' }
  | { type: 'unsupported' }

export class N8nProvider implements IProvider {
  readonly platform = 'n8n'

  constructor(
    private readonly client: N8nApiClient,
    private readonly stripper: N8nFieldStripper,
  ) {}

  async deploy(workflow: N8nWorkflow): Promise<DeployResult> {
    const stripped = this.stripper.stripForCreate(workflow)
    const response = await this.client.createWorkflow(stripped)
    return { workflowId: response.id, name: response.name }
  }

  async update(id: string, workflow: N8nWorkflow): Promise<DeployResult> {
    const stripped = this.stripper.stripForUpdate(workflow)
    const response = await this.client.updateWorkflow(id, stripped)
    return { workflowId: response.id, name: response.name }
  }

  async get(id: string): Promise<N8nWorkflow> {
    const response = await this.client.getWorkflow(id)
    return {
      name: response.name,
      nodes: response.nodes,
      connections: response.connections,
      ...(response.settings !== undefined ? { settings: response.settings } : {}),
      ...(response.tags !== undefined ? { tags: response.tags } : {}),
    }
  }

  async list(): Promise<WorkflowListItem[]> {
    return this.client.listWorkflows()
  }

  async activate(id: string): Promise<void> {
    await this.client.activateWorkflow(id)
  }

  async deactivate(id: string): Promise<void> {
    await this.client.deactivateWorkflow(id)
  }

  async delete(id: string, options: DeleteOptions): Promise<void> {
    if (options.confirm !== true) {
      throw new GuardError('delete() requires { confirm: true } to prevent accidental deletion')
    }
    await this.client.deleteWorkflow(id)
  }

  async executions(workflowId?: string, filter?: ExecutionFilter): Promise<ExecutionSummary[]> {
    return this.client.getExecutions(workflowId, filter)
  }

  async execution(id: string): Promise<ExecutionDetail> {
    return this.client.getExecution(id)
  }

  async listTags(): Promise<Tag[]> {
    return this.client.listTags()
  }

  async createTag(name: string): Promise<Tag> {
    return this.client.createTag(name)
  }

  async tag(workflowId: string, tagIds: string[]): Promise<void> {
    await this.client.tagWorkflow(workflowId, tagIds)
  }

  async untag(workflowId: string, tagIds: string[]): Promise<void> {
    await this.client.untagWorkflow(workflowId, tagIds)
  }

  async smokeTest(workflowId: string, workflow: N8nWorkflow): Promise<SmokeTestResult> {
    const start = Date.now()
    const trigger = this.detectTrigger(workflow)

    if (trigger.type === 'unsupported') {
      return { status: 'not-applicable', triggerType: 'not-applicable' }
    }

    if (trigger.type === 'manual') {
      let executionId: string
      try {
        executionId = await this.client.triggerManual(workflowId)
      } catch (err) {
        // 404/405: the /run endpoint doesn't exist on this n8n version or isn't supported
        if (err instanceof ApiError && (err.statusCode === 404 || err.statusCode === 405)) {
          return { status: 'not-applicable', triggerType: 'not-applicable' }
        }
        return { status: 'error', triggerType: 'manual', durationMs: Date.now() - start, error: String(err) }
      }
      try {
        const execution = await this.pollExecution(executionId)
        const durationMs = Date.now() - start
        if (execution.status === 'success') {
          return { status: 'passed', triggerType: 'manual', executionId, durationMs }
        }
        return {
          status: 'failed',
          triggerType: 'manual',
          executionId,
          durationMs,
          error: `Execution ended with status: ${execution.status}`,
        }
      } catch (err) {
        return { status: 'error', triggerType: 'manual', executionId, durationMs: Date.now() - start, error: String(err) }
      }
    }

    // webhook
    const result = await this.checkWebhookReachable(workflow)
    const durationMs = Date.now() - start
    if (!result) {
      // detectTrigger already confirmed a webhook node exists, so this shouldn't happen --
      // defensive fallback only.
      return { status: 'not-applicable', triggerType: 'not-applicable' }
    }
    if (result.reachable === true) {
      return { status: 'passed', triggerType: 'webhook', durationMs }
    }
    if (result.reachable === false) {
      return { status: 'failed', triggerType: 'webhook', durationMs, error: result.detail }
    }
    return { status: 'error', triggerType: 'webhook', durationMs, error: result.detail }
  }

  /**
   * Fires one real request at the workflow's production webhook URL to verify it's actually
   * reachable -- n8n's `active: true` does not reliably mean the webhook route was
   * registered. Returns null if the workflow has no webhook trigger.
   */
  async checkWebhookReachable(workflow: N8nWorkflow): Promise<WebhookReachabilityResult | null> {
    return verifyWebhookReachable(this.client, workflow)
  }

  private detectTrigger(workflow: N8nWorkflow): TriggerInfo {
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.manualTrigger') return { type: 'manual' }
      if (node.type === 'n8n-nodes-base.webhook') return { type: 'webhook' }
    }
    return { type: 'unsupported' }
  }

  private async pollExecution(executionId: string): Promise<ExecutionDetail> {
    const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS
    for (;;) {
      // Only .status is ever read from this polling loop's result (see the caller above) --
      // includeData: false avoids fetching the full execution payload on every poll tick,
      // now that getExecution() defaults to fetching it (a real bug fix, see that method's
      // own doc comment) for callers that actually need .data.
      const execution = await this.client.getExecution(executionId, { includeData: false })
      if (execution.status !== 'running' && execution.status !== 'waiting') {
        return execution
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SMOKE_TEST_POLL_INTERVAL_MS, remaining)))
    }
    throw new ProviderError(`Smoke test: execution ${executionId} did not complete within ${SMOKE_TEST_TIMEOUT_MS}ms`)
  }
}
