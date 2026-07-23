import type { TargetCompilerVerifier, DeployedSlotRef, TargetVerificationResult } from '../../promise/targets/compiler-verifier.js'
import type { ContractWorkflowTrace } from '../../promise/compile.js'
import { verifyCompiledWorkflows, type CompiledWorkflowForVerification } from '../../promise/compiler-verify.js'
import type { ProcessContract } from '../../promise/types.js'
import type { N8nWorkflow } from '../../types/workflow.js'
import type { N8nDeploymentLookup } from './deployment-lookup.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.5). The one cast this whole arc needs to narrow a target's raw deployment shape into
 * something verifyCompiledWorkflows() can read lives here, inside this n8n-specific verifier,
 * never in cli.ts and never in the neutral TargetCompilerVerifier interface itself.
 *
 * Preserves today's exact per-slot try/catch loop (cli.ts:2338-2345 pre-refactor) and its
 * two-channel reporting: a fetch failure is pushed to `fetchErrors`, never merged into
 * `verification.findings` -- but is also, by verifyCompiledWorkflows()'s own unchanged internal
 * logic, indistinguishable from a genuine structural gap for that workflow's own evidence
 * requirements (since a workflow that fails to fetch is simply absent from the array
 * verifyCompiledWorkflows() receives). This documented, accepted conflation (plan §6.5, §13) is
 * preserved exactly, not fixed -- fixing it would require modifying verifyCompiledWorkflows()
 * itself, which this whole arc has committed to wrap, never rewrite.
 */
export class N8nCompilerVerifier implements TargetCompilerVerifier {
  readonly targetId = 'n8n'
  constructor(private readonly deploymentLookup: N8nDeploymentLookup) {}

  async verifyCompiledArtifact(
    contract: ProcessContract,
    deployedSlots: DeployedSlotRef[],
    traceability: ContractWorkflowTrace[],
  ): Promise<TargetVerificationResult> {
    const fetched: CompiledWorkflowForVerification[] = []
    const fetchErrors: string[] = []

    for (const { slotName, ref } of deployedSlots) {
      try {
        const snapshot = await this.deploymentLookup.fetchDeployment(ref)
        const workflow = snapshot.raw as N8nWorkflow
        fetched.push({ workflowName: slotName, workflow: { nodes: workflow.nodes } })
      } catch (err) {
        fetchErrors.push(`"${slotName}" (${ref.targetDeploymentId}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { verification: verifyCompiledWorkflows(contract, fetched, traceability), fetchErrors }
  }
}
