import type { TargetId, TargetDeploymentRef } from './types.js'
import type { ContractPreparationEscalation } from '../decomposition.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.2). The deploy half of the compile/deploy split. Split from `ContractCompiler` so the
 * plan-only CLI path never needs a deployer at all, and so deployer construction (which needs
 * an Anthropic key) is structurally separate from verification-target construction (which needs
 * n8n credentials, and only after a real deployment exists -- see `resolveVerificationTarget()`
 * in cli.ts).
 *
 * `escalation` is typed `ContractPreparationEscalation` (`../decomposition.js`), not
 * `CompileEscalationInfo` (`../compile.js`) -- same target-neutral-layer reasoning as
 * `contract-compiler.ts`'s own doc comment.
 */

/** Three outcomes: 'generated' is a real, successful completion state -- a dry run
 * intentionally produces no deployment id (PackBuilder.build()'s own dry runs deliberately
 * never register a fake/placeholder workflow id). Confirmed against PackBuilder.build()'s real
 * result construction (pack-builder.ts:386-405): the true failure signal is `error` being
 * present, never `workflowId === null` in isolation -- a dry-run success and a real failure both
 * have `workflowId: null`, distinguished only by whether `error` is set. */
export type SlotDeployOutcome = 'deployed' | 'generated' | 'failed'

/** Discriminated union -- `ref` and `error` are only ever accessible on the variant where
 * they're guaranteed present; no `s.ref!` non-null assertion is possible or needed anywhere
 * downstream. */
export type DeployedSlotResult =
  | { slotName: string; outcome: 'deployed'; ref: TargetDeploymentRef }
  | { slotName: string; outcome: 'generated' }
  | { slotName: string; outcome: 'failed'; error: string }

export interface ContractDeployOptions {
  dryRun?: boolean
  activate?: boolean
  buildDespiteBlocking?: boolean
  onProgress?: (workflowName: string, index: number, total: number) => void
}

/** A fourth overall outcome, 'generated', distinct from 'deployed': without it, an all-dry-run
 * build (every slot 'generated', none 'failed') would incorrectly compute to the overall
 * outcome 'deployed' under a two-outcome-only design. */
export type ContractDeployOutcome = 'deployed' | 'generated' | 'partial' | 'blocked'

/** Generic over the raw result type -- the n8n deployer is typed
 * `ContractDeployer<PackPlan, WorkflowPackResult>`; when the CLI holds a concretely n8n-typed
 * deployer (which it does, `resolveContractDeployer()` in cli.ts returns a concrete class, not
 * a type-erased interface reference), `.raw` is genuinely `WorkflowPackResult`-typed, no cast
 * needed, and every existing `printPackResult()`/JSON-output/pack-persistence call site keeps
 * working exactly as it does today. `unknown` only appears in `TRawResult`'s own default, for a
 * hypothetical caller holding nothing but the abstract interface. */
export interface ContractDeployResult<TRawResult = unknown> {
  outcome: ContractDeployOutcome
  slots: DeployedSlotResult[]
  escalation?: ContractPreparationEscalation
  raw: TRawResult
}

export interface ContractDeployer<TArtifact = unknown, TRawResult = unknown> {
  readonly targetId: TargetId
  deployArtifact(artifact: TArtifact, options: ContractDeployOptions): Promise<ContractDeployResult<TRawResult>>
}
