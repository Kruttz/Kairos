import type { TargetId, TargetDeploymentRef } from './types.js'
import type { ContractWorkflowTrace } from '../compile.js'
import type { CompilerVerificationResult } from '../compiler-verify.js'
import type { ProcessContract } from '../types.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.5). Its own, sixth interface -- keeps the one necessary narrowing of a target's raw
 * deployment shape entirely inside the n8n-specific verifier (compiler-verifier.ts under
 * src/providers/n8n/), never in cli.ts.
 *
 * Fetch errors are preserved as their own field, not merged into or dropped from verification
 * findings, matching today's real cli.ts behavior exactly (fetchErrors reported entirely
 * separately from verification.findings). A workflow that fails to fetch is invisible to
 * verifyCompiledWorkflows() (unchanged, wrapped, never rewritten) -- its own evidence
 * requirements are then reported as structurally missing, indistinguishable from a genuine gap.
 * This is today's real, existing, pre-boundary behavior, preserved exactly by explicit decision
 * (plan §6.5, §13) rather than fixed, since fixing it would require modifying
 * verifyCompiledWorkflows() itself.
 */

/** {slotName, ref} pairs -- exactly ContractDeployResult.slots filtered to outcome ===
 * 'deployed' -- not a bare TargetDeploymentRef[], which would have no name to resolve a
 * compiled workflow back to. */
export interface DeployedSlotRef {
  slotName: string
  ref: TargetDeploymentRef
}

export interface TargetVerificationResult {
  verification: CompilerVerificationResult
  fetchErrors: string[]
}

export interface TargetCompilerVerifier {
  readonly targetId: TargetId
  verifyCompiledArtifact(
    contract: ProcessContract,
    deployedSlots: DeployedSlotRef[],
    traceability: ContractWorkflowTrace[],
  ): Promise<TargetVerificationResult>
}
