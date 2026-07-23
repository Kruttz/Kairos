import type { ContractCompiler, ContractCompileResult } from '../../promise/targets/contract-compiler.js'
import type { ContractDeployer, ContractDeployOptions, ContractDeployOutcome, ContractDeployResult, DeployedSlotResult } from '../../promise/targets/contract-deployer.js'
import { compileToPackPlan } from '../../promise/compile.js'
import type { ProcessContract } from '../../promise/types.js'
import type { PackBuilder, PackPlan, WorkflowPackResult } from '../../pack/pack-builder.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.2). n8n's own ContractCompiler/ContractDeployer implementations -- both wrap existing,
 * unmodified machinery (compileToPackPlan(), PackBuilder.build()) rather than reimplementing
 * anything. N8nContractDeployer's constructor takes only a PackBuilder (itself constructed from
 * only an Anthropic key) -- it never imports N8nApiClient and never reads
 * N8N_BASE_URL/N8N_API_KEY, structurally, not by convention. That is the credential-isolation
 * guarantee correction 1 depends on: it is enforced by which class gets constructed and what it
 * can even reach, not by a caller remembering not to touch certain fields.
 */

export class N8nContractCompiler implements ContractCompiler<PackPlan> {
  readonly targetId = 'n8n'

  compileContract(contract: ProcessContract): ContractCompileResult<PackPlan> {
    const { plan, traceability, escalation } = compileToPackPlan(contract)
    return { artifact: plan, traceability, ...(escalation ? { escalation } : {}) }
  }
}

export class N8nContractDeployer implements ContractDeployer<PackPlan, WorkflowPackResult> {
  readonly targetId = 'n8n'
  constructor(private readonly packBuilder: PackBuilder) {}

  async deployArtifact(artifact: PackPlan, options: ContractDeployOptions): Promise<ContractDeployResult<WorkflowPackResult>> {
    const result = await this.packBuilder.build(artifact, {
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      ...(options.activate !== undefined ? { activate: options.activate } : {}),
      ...(options.buildDespiteBlocking !== undefined ? { buildDespiteBlocking: options.buildDespiteBlocking } : {}),
      ...(options.onProgress ? { onProgress: (wf, i, total) => options.onProgress!(wf.name, i, total) } : {}),
    })

    const slots: DeployedSlotResult[] = result.workflows.map((w): DeployedSlotResult => {
      if (w.error) return { slotName: w.name, outcome: 'failed', error: w.error }
      if (w.workflowId !== null) return { slotName: w.name, outcome: 'deployed', ref: { targetId: 'n8n', targetDeploymentId: w.workflowId } }
      return { slotName: w.name, outcome: 'generated' }
    })

    // Corrected overall-outcome classification (plan §6.2, correction 3): a fourth branch for
    // "every slot in this build was a successful dry run" -- without it, an all-'generated'
    // build (no 'failed' slot) would incorrectly compute to 'deployed' under a two-outcome-only
    // design.
    const outcome: ContractDeployOutcome =
      result.status === 'blocked' ? 'blocked'
      : slots.some(s => s.outcome === 'failed') ? 'partial'
      : slots.length > 0 && slots.every(s => s.outcome === 'generated') ? 'generated'
      : 'deployed'

    return { outcome, slots, ...(result.escalation ? { escalation: result.escalation } : {}), raw: result }
  }
}
