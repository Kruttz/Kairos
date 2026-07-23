import { generateUUID } from '../../../utils/uuid.js'
import { GuardError } from '../../../errors/guard-error.js'
import { prepareContract } from '../../decomposition.js'
import type { ContractDecomposition, WorkflowSlot } from '../../decomposition.js'
import type { ProcessContract } from '../../types.js'
import type { ContractScenario, ScenarioTimelineEvent } from '../../scenario-types.js'
import type { ContractCompiler, ContractCompileResult } from '../contract-compiler.js'
import type { ContractDeployer, ContractDeployOptions, ContractDeployOutcome, ContractDeployResult, DeployedSlotResult } from '../contract-deployer.js'
import type { DeploymentLookup, TargetDeploymentSnapshot } from '../deployment-lookup.js'
import type { ExecutionHistorySource, EvidenceNormalizer } from '../execution-history.js'
import type { TargetCapabilities, TargetDeploymentRef, NormalizedExecution } from '../types.js'

/**
 * Execution Substrate Boundary v0, Phase 5 (docs/plans/execution-substrate-boundary-plan.md §7).
 * Test-only reference adapter -- its purpose is not "a second target Kairos can run against," it
 * will never be a production runtime. Its purpose is to PROVE the interfaces in §6 represent
 * genuine Kairos concepts, not n8n concepts wearing a generic name: a design that merely asserts
 * the interfaces are neutral proves nothing; a second, honest, non-n8n implementation of the
 * same interfaces is the actual evidence.
 *
 * Implements exactly five interfaces -- ContractCompiler, ContractDeployer, DeploymentLookup,
 * ExecutionHistorySource, EvidenceNormalizer -- never TargetCompilerVerifier, matching its own
 * honest `compilerVerification: {state: 'unsupported'}` declaration below. Its "artifact" is its
 * own decomposition by construction -- there is no LLM-authored JSON that could structurally
 * diverge from what the contract asked for, so the whole category of question compiler
 * verification answers ("does the generated artifact actually contain what it's supposed to")
 * does not apply here, not merely "isn't built yet."
 */

export const IN_MEMORY_CAPABILITIES: TargetCapabilities = {
  implemented: {
    compile: { state: 'supported' },
    deploy: { state: 'supported' },
    fetchDeployment: { state: 'supported' },
    executionHistory: { state: 'supported' },
    evidenceExtraction: { state: 'supported' },
    compilerVerification: { state: 'unsupported' },
  },
  reliability: {
    replay: { state: 'unsupported' },
    chaos: { state: 'unsupported' },
    sandbox: { state: 'unsupported' },
    drift: { state: 'unsupported' },
    repair: { state: 'unsupported' },
    rollback: { state: 'unsupported' },
  },
}

/** The raw shape this adapter's own ExecutionHistorySource produces and its own
 * EvidenceNormalizer consumes -- deliberately trivial (`normalize()` below is a bare
 * pass-through) since seedExecution() (the only producer of these) already builds the real,
 * final NormalizedExecution up front; there is no separate "raw n8n-shaped data" concept for
 * this target to parse. */
export interface InMemoryRawExecution {
  id: string
  startedAt: string | null
  asNormalizedExecution: NormalizedExecution
}

function offsetToMs(offset: ScenarioTimelineEvent['offset']): number {
  switch (offset.unit) {
    case 'minutes': return offset.amount * 60_000
    case 'hours': return offset.amount * 60 * 60_000
    case 'days': return offset.amount * 24 * 60 * 60_000
  }
}

/** Builds a nested object from a dot-separated field path and a leaf value -- e.g.
 * ('body.phone', '555-0100') -> { body: { phone: '555-0100' } }, matching
 * ProcessContract.correlationKey.fieldPath's own documented shape (relative to a trigger item's
 * own payload). */
function nestedFields(path: string, value: string): Record<string, unknown> {
  const parts = path.split('.')
  const root: Record<string, unknown> = {}
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {}
    cur[parts[i]!] = next
    cur = next
  }
  cur[parts[parts.length - 1]!] = value
  return root
}

/** Test-only. Never a production runtime -- no code path anywhere lets a real build/deploy/poll
 * cycle route here by accident; no `--target` flag exists to select it; it is only ever
 * constructed directly by test code. */
export class InMemoryContractTarget
  implements
    ContractCompiler<ContractDecomposition>,
    ContractDeployer<ContractDecomposition, ContractDecomposition>,
    DeploymentLookup,
    ExecutionHistorySource<InMemoryRawExecution>,
    EvidenceNormalizer<InMemoryRawExecution>
{
  readonly targetId = 'in-memory-test'
  // Keyed by deployment id -> ONE slot, never the whole decomposition (plan §7, correction 12) --
  // fetching any one slot's deployment must never return another slot's data.
  private deployments = new Map<string, WorkflowSlot>()
  private executions = new Map<string, InMemoryRawExecution[]>()

  // -- ContractCompiler -- calls the SAME prepareContract() every real target calls (§5) -- the
  // blocking-assumption gate is structurally inherited, not reproduced by hand.
  compileContract(contract: ProcessContract): ContractCompileResult<ContractDecomposition> {
    const prepared = prepareContract(contract)
    if (prepared.outcome === 'blocked') return { artifact: { slots: [] }, traceability: [], escalation: prepared.escalation }
    return { artifact: prepared.decomposition, traceability: prepared.decomposition.slots.map(s => ({ workflowName: s.name, sourceElements: s.sourceElements })) }
  }

  // -- ContractDeployer -- unique ids via generateUUID() (src/utils/uuid.ts, already used
  // elsewhere in this codebase), never a slot index (which would collide on any repeated
  // deployment, e.g. simulating a rebuild). Each id maps to exactly ONE slot's own data.
  //
  // `options.dryRun` is honored for real, matching ContractDeployOptions'/SlotDeployOutcome's
  // own real dry-run semantics (§6.2): a dry run produces 'generated' slots with no `ref` at
  // all, and never writes anything into `this.deployments` -- there is structurally nothing for
  // fetchDeployment() to find afterward, mirroring n8n's own real behavior exactly ("a dry run
  // deliberately never registers a fake/placeholder workflow id"). `options.activate` remains an
  // explicitly documented no-op below -- an in-memory "deployment" has no real activation state
  // to toggle at all, so there is nothing for that flag to meaningfully do here, unlike
  // `dryRun`, which genuinely changes whether a deployment record is created.
  async deployArtifact(artifact: ContractDecomposition, options: ContractDeployOptions): Promise<ContractDeployResult<ContractDecomposition>> {
    if (options.dryRun) {
      const slots: DeployedSlotResult[] = artifact.slots.map((slot): DeployedSlotResult => ({ slotName: slot.name, outcome: 'generated' }))
      const outcome: ContractDeployOutcome = slots.length > 0 ? 'generated' : 'deployed'
      return { outcome, slots, raw: artifact }
    }

    // options.activate: intentionally unused -- see the doc comment above.
    const slots: DeployedSlotResult[] = artifact.slots.map(slot => {
      const id = generateUUID()
      this.deployments.set(id, slot)
      return { slotName: slot.name, outcome: 'deployed', ref: { targetId: this.targetId, targetDeploymentId: id } }
    })
    return { outcome: 'deployed', slots, raw: artifact }
  }

  // -- DeploymentLookup -- returns only the ONE slot this ref points at, matching n8n's own
  // per-workflow fetch semantics.
  async fetchDeployment(ref: TargetDeploymentRef): Promise<TargetDeploymentSnapshot> {
    if (ref.targetId !== this.targetId) throw new GuardError(`InMemoryContractTarget received a ref for target "${ref.targetId}".`)
    const slot = this.deployments.get(ref.targetDeploymentId)
    if (!slot) throw new GuardError(`No in-memory deployment "${ref.targetDeploymentId}".`)
    return { ref, raw: slot }
  }

  // -- ExecutionHistorySource -- newest-first and limit-respecting, matching §6.4's own stated
  // contract; every method validates ref.targetId, including fetchExecution().
  //
  // Deliberate deviation from the plan's own literal pseudocode here (which used a blind
  // `.reverse()` on insertion order): §6.4's interface contract for this exact method is
  // explicit -- "MUST return executions newest-first... callers depend on this being true, not
  // just usually true" -- and a bare reverse only honors that if seedExecution() is ALWAYS
  // called in strictly oldest-to-newest order, which nothing enforces (seedExecution() iterates
  // a scenario's own timeline array order, not a chronological sort of its computed
  // timestamps). Sorting genuinely by `startedAt` instead makes the guarantee structurally true
  // regardless of seed order, exactly mirroring the defensive-sort discipline Phase 4's own
  // N8nExecutionHistorySource already established for this identical interface method
  // (correction 9) -- consistent with, not a departure from, this plan's own stated principle.
  async listExecutions(ref: TargetDeploymentRef, limit: number): Promise<Array<{ id: string; startedAt: string | null }>> {
    if (ref.targetId !== this.targetId) throw new GuardError(`InMemoryContractTarget received a ref for target "${ref.targetId}".`)
    return (this.executions.get(ref.targetDeploymentId) ?? [])
      .slice()
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, limit)
      .map(e => ({ id: e.id, startedAt: e.startedAt }))
  }

  async fetchExecution(ref: TargetDeploymentRef, executionId: string): Promise<InMemoryRawExecution> {
    if (ref.targetId !== this.targetId) throw new GuardError(`InMemoryContractTarget received a ref for target "${ref.targetId}".`)
    const found = (this.executions.get(ref.targetDeploymentId) ?? []).find(e => e.id === executionId)
    if (!found) throw new GuardError(`No in-memory execution "${executionId}".`)
    return found
  }

  // -- EvidenceNormalizer -- trivial pass-through; seedExecution() (below) already built the
  // real NormalizedExecution when the execution was seeded.
  normalize(_contract: ProcessContract, raw: InMemoryRawExecution): NormalizedExecution {
    return raw.asNormalizedExecution
  }

  /**
   * Test-seam only -- not a "deploy runs code" path. Translates a scenario.ts-generated
   * ContractScenario into this adapter's own InMemoryRawExecution shape and appends one
   * execution PER timeline event (not one execution per scenario) -- the same granularity a
   * real target has: an 'instance_start' event and an 'evidence' event normally arrive via two
   * genuinely separate executions (an intake trigger vs. a later outcome-update trigger), and
   * modeling them as one execution would understate what a real poll actually processes.
   *
   * Deliberately takes `contract` as a third parameter, deviating from the plan's own elided
   * `seedExecution(deploymentId, scenario)` pseudocode (marked `/* ... *\/`, never fully
   * specified) -- building a correct NormalizedExecution requires resolving
   * `contract.correlationKey.fieldPath` into the same nested shape a real trigger payload would
   * carry it in, which is not recoverable from a ContractScenario alone (it only carries the
   * correlation VALUE, never the contract's own field path). `now` is optional (defaults to real
   * "now"), threaded through for the same deterministic-testing reason harness.ts's own
   * `runScenario(contract, scenario, now)` takes it.
   */
  seedExecution(deploymentId: string, scenario: ContractScenario, contract: ProcessContract, now: Date = new Date()): void {
    const existing = this.executions.get(deploymentId) ?? []
    for (const event of scenario.timeline) {
      const eventTime = new Date(now.getTime() - offsetToMs(event.offset)).toISOString()
      const executionRef = `${scenario.id}:${event.id}`
      const correlationFields = nestedFields(contract.correlationKey.fieldPath, scenario.correlationKeyValue)

      const normalized: NormalizedExecution = event.kind === 'instance_start'
        ? {
            executionRef,
            eventTime,
            initiatingItems: [{ fields: correlationFields }],
            transitionEvidence: [],
          }
        : {
            executionRef,
            eventTime,
            initiatingItems: [],
            // A real, separate processing-workflow execution's own trigger payload carries the
            // correlating field directly (an outcome-update webhook that includes the phone
            // number itself) -- merged with the event's own synthetic evidence fields.
            transitionEvidence: [{
              transitionId: event.transitionId!,
              items: [{ fields: { ...correlationFields, ...(event.fields ?? {}) } }],
            }],
          }

      existing.push({ id: executionRef, startedAt: eventTime, asNormalizedExecution: normalized })
    }
    this.executions.set(deploymentId, existing)
  }
}
