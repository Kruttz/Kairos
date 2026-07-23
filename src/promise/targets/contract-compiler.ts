import type { TargetId } from './types.js'
import type { ContractWorkflowTrace } from '../compile.js'
import type { ContractPreparationEscalation } from '../decomposition.js'
import type { ProcessContract } from '../types.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.2). The compile half of the compile/deploy split -- a `ContractCompiler` needs zero
 * credentials at all, matching `compileToPackPlan()`'s own real signature (`compile.ts`, no
 * network call, no Anthropic key, no n8n client). Bundling this with deploy would force even
 * the plan-only CLI path to hold a fully-constructed deployer just to compile.
 *
 * `escalation` is typed `ContractPreparationEscalation` (`../decomposition.js`), not
 * `CompileEscalationInfo` (`../compile.js`, itself now just a backward-compatible alias for the
 * same type) -- this file lives under `src/promise/targets/`, the target-neutral interface
 * layer, and must not depend on the n8n-specific `compile.ts` module, even for a type-only
 * import (the same principle Phase 2's closeout correction established for `decomposition.ts`
 * itself). `ContractWorkflowTrace` is the one exception: it remains imported from `compile.ts`
 * because the accepted plan's own §6.2 pseudocode specifies exactly that, and relocating it was
 * never authorized or requested -- unlike the escalation type, which had a live, corrected,
 * canonical home already available at the moment this file was written.
 */

export interface ContractCompileResult<TArtifact> {
  /** compileToPackPlan() returns `plan`; the n8n wrapper (contract-target.ts) maps
   * plan -> artifact explicitly (compile.ts:53-60). */
  artifact: TArtifact
  traceability: ContractWorkflowTrace[]
  escalation?: ContractPreparationEscalation
}

export interface ContractCompiler<TArtifact = unknown> {
  readonly targetId: TargetId
  /** Calls prepareContract() (§5) FIRST, internally -- never receives a pre-computed
   * ContractDecomposition as a parameter, and never skips validation. */
  compileContract(contract: ProcessContract): ContractCompileResult<TArtifact>
}
