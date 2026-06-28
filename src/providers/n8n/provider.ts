import type { N8nWorkflow, Tag } from '../../types/workflow.js'
import type { DeployResult, WorkflowListItem, ExecutionSummary, ExecutionDetail, SmokeTestResult } from '../../types/result.js'
import type { DeleteOptions, ExecutionFilter } from '../../types/options.js'
import type { IProvider } from '../types.js'
import { GuardError } from '../../errors/guard-error.js'
import { N8nApiClient } from './api-client.js'
import { N8nFieldStripper } from './stripper.js'

const SMOKE_TEST_TIMEOUT_MS = 30_000
const SMOKE_TEST_POLL_INTERVAL_MS = 1_000

type TriggerInfo =
  | { type: 'manual' }
  | { type: 'webhook'; path: string }
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
    try {
      const statusCode = await this.client.triggerWebhookTest(trigger.path)
      const durationMs = Date.now() - start
      if (statusCode >= 200 && statusCode < 300) {
        return { status: 'passed', triggerType: 'webhook', durationMs }
      }
      return { status: 'failed', triggerType: 'webhook', durationMs, error: `Webhook returned HTTP ${statusCode}` }
    } catch (err) {
      return { status: 'error', triggerType: 'webhook', durationMs: Date.now() - start, error: String(err) }
    }
  }

  private detectTrigger(workflow: N8nWorkflow): TriggerInfo {
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.manualTrigger') return { type: 'manual' }
      if (node.type === 'n8n-nodes-base.webhook') {
        const params = node.parameters as Record<string, unknown> | undefined
        const path = typeof params?.['path'] === 'string' ? params['path'] : 'webhook'
        return { type: 'webhook', path }
      }
    }
    return { type: 'unsupported' }
  }

  private async pollExecution(executionId: string): Promise<ExecutionDetail> {
    const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS
    for (;;) {
      const execution = await this.client.getExecution(executionId)
      if (execution.status !== 'running' && execution.status !== 'waiting') {
        return execution
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SMOKE_TEST_POLL_INTERVAL_MS, remaining)))
    }
    throw new Error(`Smoke test: execution ${executionId} did not complete within ${SMOKE_TEST_TIMEOUT_MS}ms`)
  }
}
