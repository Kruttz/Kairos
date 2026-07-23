import type { PackPlan, WorkflowPlan, TypedAssumption } from '../pack/pack-builder.js'
import { prepareContract, type WorkflowSlot, type ContractPreparationEscalation } from './decomposition.js'
import { evidenceNodeName } from '../providers/n8n/evidence.js'
import type { ProcessContract, StartCondition } from './types.js'

/**
 * ProcessContract v0, Phase 2 (docs/plans/process-contract-promise-engine-plan.md) --
 * compiles a validated ProcessContract into a PackPlan, reusing PackBuilder.build()/
 * Kairos.build() completely unchanged downstream (Codex's own instruction: "reuse existing
 * PackBuilder/Kairos build machinery; do not bypass workflow validation/generation").
 * ProcessContract stays the source of truth; PackPlan is compiled output, never edited by hand
 * in place of the contract.
 *
 * Deliberately deterministic -- no Anthropic call happens in this module. Two reasons, both
 * load-bearing, not just a style preference:
 *  1. "Compiler" is the framing this whole arc uses (Codex's original thesis: "Kairos should
 *     become a compiler/runtime for verifiable business promises"). A second LLM authoring pass
 *     between an already-validated contract and its workflow descriptions would reintroduce the
 *     exact class of risk §11 of the plan doc names explicitly ("LLM-authored contracts can be
 *     wrong in a new, higher-stakes way") one layer downstream, for no real benefit -- every
 *     fact this module needs is already structured data sitting on the contract.
 *  2. Traceability (an explicit Phase 2 scope item) is exact and mechanical this way -- each
 *     generated WorkflowPlan can cite precisely which contract element IDs produced it, rather
 *     than an LLM's paraphrase of them.
 * Plan doc §5.1's own wording ("the resulting PackPlan.workflows[] build descriptions are still
 * generated exactly the way they are today, through Kairos.build()") is read here as referring
 * to Kairos.build()'s own per-workflow n8n-JSON generation step -- which this module does not
 * touch and could not bypass even if it wanted to -- not as requiring a second planning-level
 * LLM call inside compileToPackPlan() itself.
 *
 * Per Codex's explicit caution: this module only produces a PackPlan. It does not attempt to
 * verify, simulate, or prove that a compiled workflow will actually fulfill the contract once
 * built -- that is ProofLedger's job (a later, unstarted phase), not this one's.
 *
 * Execution Substrate Boundary v0, Phase 2 (docs/plans/execution-substrate-boundary-plan.md §5):
 * the "which workflows does this contract imply, and why" decision now lives in decomposition.ts
 * as target-neutral WorkflowSlots, reached via prepareContract() -- this module's own job has
 * narrowed to n8n's specific prose generation for each slot decomposeContract() produces. The
 * validation-then-blocking-assumptions gate and both escalation strings are unchanged, just
 * relocated; compileToPackPlan()'s observable output is identical to before this refactor.
 */

/** Backward-compatible alias -- the canonical definition now lives in decomposition.ts
 * (`ContractPreparationEscalation`), the target-neutral module that actually produces this
 * value. Kept exported under this name so nothing that already imports `CompileEscalationInfo`
 * from compile.ts needs to change. */
export type CompileEscalationInfo = ContractPreparationEscalation

/** Which ProcessContract element IDs a given compiled WorkflowPlan was derived from -- e.g.
 * `startCondition:sc-intake`, `transition:t-received-to-attempted`, `sla:sla-first-contact`.
 * Deliberately a separate, additive structure rather than a new field on WorkflowPlan itself --
 * PackPlan's shape stays exactly what PackBuilder.build() already expects, unmodified. */
export interface ContractWorkflowTrace {
  workflowName: string
  sourceElements: string[]
}

export interface CompileToPackPlanResult {
  plan: PackPlan
  traceability: ContractWorkflowTrace[]
  /** Present only when compilation was refused -- `plan.workflows` is `[]` in that case, mirroring
   * PackBuilder.build()'s own blocked-early-return shape (a full, well-typed result with an
   * empty workflow list, not a null/throw). */
  escalation?: CompileEscalationInfo
}

function emptyPlanFor(contract: ProcessContract): PackPlan {
  return {
    businessContext: contract.promise.text,
    workflows: [],
    assumptions: contract.assumptions,
    sheetsColumns: [],
    testChecklist: [],
  }
}

function lookupState(contract: ProcessContract, id: string) {
  return contract.states.find(s => s.id === id)
}

/**
 * Evidence-node marker convention -- Phase 3's first named prerequisite (Codex, 2026-07-20):
 * "compiled workflows need predictable node names/markers so Kairos knows where to extract
 * evidence." The compiled description instructs the LLM-based codegen to name the exact node
 * that sets a given EvidenceRequirement's fields using this convention, so ProofLedger's n8n
 * normalizer (src/providers/n8n/evidence.ts) can find it deterministically by name in a real
 * execution's runData, rather than guessing from field names -- nothing about a generated
 * workflow's structure otherwise guarantees a stable name (the Phase 3 design spike's Finding 6,
 * plan doc §6.0).
 *
 * Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.4): the canonical definition now lives in src/providers/n8n/evidence.ts (a mechanical
 * relocation -- node-name marker interpretation is n8n-specific, and the neutral extraction
 * layer must never know this convention exists at all). Re-exported here under this exact name
 * so this module's own prose-generation use below, and every existing external importer
 * (compiler-verify.ts, and this file's own tests), needs zero changes.
 */
export { evidenceNodeName }

function buildIntakeWorkflow(contract: ProcessContract, sc: StartCondition, slot: WorkflowSlot): WorkflowPlan {
  const name = slot.name
  const initialState = lookupState(contract, sc.initialState)
  const owner = contract.owners.find(o => o.state === sc.initialState)

  const lines: string[] = [
    `Part of the "${contract.name}" promise: ${contract.promise.text}`,
    `Trigger: ${sc.trigger}.`,
    sc.description,
    `On trigger, create a new ${contract.entity.name} promise-instance record beginning in state "${sc.initialState}"${initialState ? ` (${initialState.name}: ${initialState.description})` : ''}.`,
    `Correlate this instance using ${contract.correlationKey.fieldPath} (${contract.correlationKey.description}) as the stable identifier -- capture and persist it exactly as received; every other workflow for this ${contract.entity.name} must reference the same value.`,
  ]
  if (owner) lines.push(`Responsible owner while in this state: ${owner.owner}.`)

  return {
    name,
    description: lines.join(' '),
    purpose: `Captures every new ${contract.entity.name.toLowerCase()} the moment it arrives, per the "${contract.name}" promise.`,
  }
}

function buildProcessingWorkflow(contract: ProcessContract, slot: WorkflowSlot): WorkflowPlan {
  const name = slot.name
  const lines: string[] = [
    `Part of the "${contract.name}" promise: ${contract.promise.text}`,
    `Receives outcome/event data for an existing ${contract.entity.name}, correlated via ${contract.correlationKey.fieldPath}, and updates its recorded state accordingly.`,
  ]

  const touchedStates = new Set<string>()
  for (const t of contract.transitions) {
    touchedStates.add(t.fromState)
    touchedStates.add(t.toState)
    const from = lookupState(contract, t.fromState)
    const to = lookupState(contract, t.toState)
    const ev = contract.events.find(e => e.id === t.event)
    const outcome = contract.terminalOutcomes.find(o => o.state === t.toState)
    let line = `When "${ev?.name ?? t.event}"${ev ? ` (${ev.description})` : ''} occurs while in state "${from?.name ?? t.fromState}", transition to "${to?.name ?? t.toState}"${t.condition ? ` (only if: ${t.condition})` : ''}.`
    if (outcome) line += ` This is a terminal outcome: ${outcome.outcome} -- ${outcome.description}`
    lines.push(line)
  }

  for (const ev of contract.evidenceRequirements) {
    const t = contract.transitions.find(x => x.id === ev.transitionId)
    lines.push(
      `For transition "${t?.id ?? ev.transitionId}", the node that sets these exact fields as evidence (${ev.requiredFields.join(', ')} -- ${ev.description}) MUST be named exactly "${evidenceNodeName(ev.transitionId)}" (a Set/Edit Fields node right after the fields are known is usually the right choice) so this evidence can be located programmatically later. Do not rename, skip, or merge this node with another one.`
    )
  }

  const relevantOwners = contract.owners.filter(o => touchedStates.has(o.state))
  if (relevantOwners.length > 0) {
    lines.push(`Owners: ${relevantOwners.map(o => `"${o.state}" is owned by ${o.owner}`).join('; ')}.`)
  }

  return {
    name,
    description: lines.join(' '),
    purpose: `Logs every state change and its supporting evidence for the "${contract.name}" promise.`,
  }
}

function buildEscalationWorkflow(contract: ProcessContract, slot: WorkflowSlot): WorkflowPlan {
  const expirationRules = contract.expirationRules ?? []
  const name = slot.name
  const lines: string[] = [
    `Part of the "${contract.name}" promise: ${contract.promise.text}`,
    `Scheduled workflow that checks every open ${contract.entity.name} instance against its SLA deadlines and expiration rules, and raises exceptions for the ones that have breached.`,
  ]

  for (const sla of contract.sla) {
    const measuredFrom = 'state' in sla.measuredFrom ? `entering state "${sla.measuredFrom.state}"` : `event "${sla.measuredFrom.event}"`
    let line = `SLA "${sla.id}": expected to reach state "${sla.expectedBy.state}" within ${sla.duration.amount} ${sla.duration.unit} of ${measuredFrom}.`
    if (sla.recurring) line += ` Recurs every ${sla.duration.amount} ${sla.duration.unit} while the instance remains in state "${sla.recurring.whileInState}".`
    lines.push(line)
  }

  for (const exp of expirationRules) {
    lines.push(`Expiration rule "${exp.id}": if the instance remains in state "${exp.state}" for more than ${exp.after.amount} ${exp.after.unit} with no qualifying transition, move it to "${exp.expiresTo}".`)
  }

  for (const exc of contract.exceptions) {
    lines.push(`Exception: when "${exc.condition}", alert ${exc.owner}. Suggested action (advisory only, never auto-executed): ${exc.suggestedAction}`)
  }

  if (contract.businessCalendar) {
    const cal = contract.businessCalendar
    const hours = cal.weeklyHours.map(h => `${h.day} ${h.start}-${h.end}`).join(', ')
    lines.push(`Business-hours-aware durations use this calendar: timezone ${cal.timezone}, hours ${hours}${cal.holidays?.length ? `, holidays excluded: ${cal.holidays.join(', ')}` : ''}.`)
  }

  for (const pr of contract.pauseRules ?? []) {
    lines.push(`Pause rule "${pr.id}": stop the SLA clock when ${pr.condition}; resume when ${pr.resumeCondition}.`)
  }

  return {
    name,
    description: lines.join(' '),
    purpose: `Ensures no ${contract.entity.name.toLowerCase()} silently misses a deadline the "${contract.name}" promise commits to.`,
  }
}

export function compileToPackPlan(contract: ProcessContract): CompileToPackPlanResult {
  const prepared = prepareContract(contract)
  if (prepared.outcome === 'blocked') {
    return {
      plan: emptyPlanFor(contract),
      traceability: [],
      escalation: prepared.escalation,
    }
  }

  const { slots } = prepared.decomposition
  const workflows: WorkflowPlan[] = []
  const traceability: ContractWorkflowTrace[] = []

  const intakeSlots = slots.filter(s => s.kind === 'intake')
  for (let i = 0; i < contract.startConditions.length; i++) {
    const slot = intakeSlots[i]!
    workflows.push(buildIntakeWorkflow(contract, contract.startConditions[i]!, slot))
    traceability.push({ workflowName: slot.name, sourceElements: slot.sourceElements })
  }

  const processingSlot = slots.find(s => s.kind === 'processing')
  if (processingSlot) {
    workflows.push(buildProcessingWorkflow(contract, processingSlot))
    traceability.push({ workflowName: processingSlot.name, sourceElements: processingSlot.sourceElements })
  }

  const escalationSlot = slots.find(s => s.kind === 'escalation')
  if (escalationSlot) {
    workflows.push(buildEscalationWorkflow(contract, escalationSlot))
    traceability.push({ workflowName: escalationSlot.name, sourceElements: escalationSlot.sourceElements })
  }

  const assumptions: TypedAssumption[] = [
    ...contract.assumptions,
    {
      type: 'safe',
      text: `This pack was compiled from ProcessContract "${contract.name}" (id: ${contract.id}, v${contract.version}). Edit the contract and recompile rather than hand-editing this plan.`,
    },
  ]

  const testChecklist = workflows.map(w => ({
    workflow: w.name,
    steps: [
      `Manually trigger "${w.name}" with representative data for a ${contract.entity.name}.`,
      'Confirm the resulting state change and logged evidence match what the ProcessContract describes for this step.',
    ],
  }))

  const plan: PackPlan = {
    businessContext: `${contract.name} (ProcessContract ${contract.id} v${contract.version}): ${contract.promise.text}`,
    workflows,
    assumptions,
    sheetsColumns: [],
    testChecklist,
  }

  return { plan, traceability }
}
