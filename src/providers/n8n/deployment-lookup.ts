import type { DeploymentLookup, TargetDeploymentSnapshot } from '../../promise/targets/deployment-lookup.js'
import type { TargetDeploymentRef } from '../../promise/targets/types.js'
import type { N8nApiClient } from './api-client.js'
import { GuardError } from '../../errors/guard-error.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.3). Thin wrapper around N8nApiClient.getWorkflow() -- a real, non-trivial GET-by-id call,
 * not a "already satisfies the interface" claim.
 */
export class N8nDeploymentLookup implements DeploymentLookup {
  readonly targetId = 'n8n'
  constructor(private readonly client: N8nApiClient) {}

  async fetchDeployment(ref: TargetDeploymentRef): Promise<TargetDeploymentSnapshot> {
    if (ref.targetId !== this.targetId) {
      throw new GuardError(`N8nDeploymentLookup received a ref for target "${ref.targetId}", not "n8n".`)
    }
    return { ref, raw: await this.client.getWorkflow(ref.targetDeploymentId) }
  }
}
