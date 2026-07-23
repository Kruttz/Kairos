import type { TargetId, TargetDeploymentRef } from './types.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.3). Fetches a single, already-deployed artifact back from its target, by reference.
 */

export interface TargetDeploymentSnapshot {
  ref: TargetDeploymentRef
  /** Target-specific full deployment shape (n8n: N8nWorkflow). Narrowed only inside a
   * target-specific consumer (e.g. N8nCompilerVerifier's own single cast, compiler-verifier.ts)
   * -- never narrowed in neutral code, and never in cli.ts. */
  raw: unknown
}

export interface DeploymentLookup {
  readonly targetId: TargetId
  /** MUST throw GuardError if ref.targetId !== this.targetId -- every adapter method taking a
   * TargetDeploymentRef validates this, catching a caller bug (a mismatched ref passed to the
   * wrong adapter) immediately rather than silently returning confusing cross-target data. */
  fetchDeployment(ref: TargetDeploymentRef): Promise<TargetDeploymentSnapshot>
}
