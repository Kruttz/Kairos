import type { ExecutionHistorySource } from '../../promise/targets/execution-history.js'
import type { TargetDeploymentRef } from '../../promise/targets/types.js'
import type { N8nApiClient } from './api-client.js'
import { GuardError } from '../../errors/guard-error.js'

/**
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4). The raw shape n8n's own execution API returns, and a real wrapper class around
 * N8nApiClient.getExecutions()/getExecution() -- not "already satisfies the interface": those
 * real methods are named differently (not listExecutions/fetchExecution) and don't take a
 * TargetDeploymentRef as their first argument.
 */
export interface RawExecutionDetail {
  id: string
  startedAt: string | null
  data?: unknown
}

/**
 * Sorts and truncates defensively rather than trusting n8n's own API response to stay
 * newest-first forever. n8n's real Executions API is empirically confirmed (Phase 3 design
 * spike) to return results in that order today -- but that is an observed fact about today's
 * n8n version, not a documented contract n8n itself guarantees to preserve. This wrapper
 * enforces the ordering itself, structurally.
 */
export class N8nExecutionHistorySource implements ExecutionHistorySource<RawExecutionDetail> {
  readonly targetId = 'n8n'
  constructor(private readonly client: N8nApiClient) {}

  async listExecutions(ref: TargetDeploymentRef, limit: number): Promise<Array<{ id: string; startedAt: string | null }>> {
    if (ref.targetId !== this.targetId) {
      throw new GuardError(`N8nExecutionHistorySource received a ref for target "${ref.targetId}", not "n8n".`)
    }
    const raw = await this.client.getExecutions(ref.targetDeploymentId, { limit })
    return raw.slice().sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, limit)
  }

  async fetchExecution(ref: TargetDeploymentRef, executionId: string): Promise<RawExecutionDetail> {
    if (ref.targetId !== this.targetId) {
      throw new GuardError(`N8nExecutionHistorySource received a ref for target "${ref.targetId}", not "n8n".`)
    }
    return this.client.getExecution(executionId, { includeData: true })
  }
}
