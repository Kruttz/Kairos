import type { PackPlan, WorkflowPlan, TypedAssumption } from '../pack/pack-builder.js'
import { validateProcessContract } from './validate.js'
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
 */

export interface CompileEscalationInfo {
  reason: string
  questions: string[]
  /** validation_errors takes priority when both are present -- structural correctness (can this
   * contract even be reasoned about at all) is checked before business-completeness (does a
   * human still need to resolve something). */
  source: 'validation_errors' | 'blocking_assumptions'
}

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
 * that sets a given EvidenceRequirement's fields using this convention, so ProofLedger's poller
 * (src/promise/ledger.ts) can find it deterministically by name in a real execution's runData,
 * rather than guessing from field names -- nothing about a generated workflow's structure
 * otherwise guarantees a stable name (the Phase 3 design spike's Finding 6, plan doc §6.0).
 * Exported so ledger.ts imports this exact format rather than a second, driftable copy of the
 * same string.
 */
export function evidenceNodeName(transitionId: string): string {
  return `Kairos Evidence: ${transitionId}`
}

function buildIntakeWorkflow(
  contract: ProcessContract,
  sc: StartCondition,
  index: number,
  total: number
): { workflow: WorkflowPlan; trace: ContractWorkflowTrace } {
  const name = total === 1 ? `${contract.entity.name} Intake` : `${contract.entity.name} Intake ${index + 1}`
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
    workflow: {
      name,
      description: lines.join(' '),
      purpose: `Captures every new ${contract.entity.name.toLowerCase()} the moment it arrives, per the "${contract.name}" promise.`,
    },
    trace: { workflowName: name, sourceElements: [`startCondition:${sc.id}`, `state:${sc.initialState}`, 'correlationKey'] },
  }
}

function buildProcessingWorkflow(contract: ProcessContract): { workflow: WorkflowPlan; trace: ContractWorkflowTrace } | null {
  if (contract.transitions.length === 0) return null

  const name = `${contract.entity.name} Processing & Outcome Logging`
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
    workflow: {
      name,
      description: lines.join(' '),
      purpose: `Logs every state change and its supporting evidence for the "${contract.name}" promise.`,
    },
    trace: {
      workflowName: name,
      sourceElements: [
        ...contract.transitions.map(t => `transition:${t.id}`),
        ...contract.evidenceRequirements.map(e => `evidenceRequirement:${e.transitionId}`),
      ],
    },
  }
}

function buildEscalationWorkflow(contract: ProcessContract): { workflow: WorkflowPlan; trace: ContractWorkflowTrace } | null {
  const expirationRules = contract.expirationRules ?? []
  if (contract.sla.length === 0 && expirationRules.length === 0) return null

  const name = `${contract.entity.name} SLA Escalation`
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
    workflow: {
      name,
      description: lines.join(' '),
      purpose: `Ensures no ${contract.entity.name.toLowerCase()} silently misses a deadline the "${contract.name}" promise commits to.`,
    },
    trace: {
      workflowName: name,
      sourceElements: [
        ...contract.sla.map(s => `sla:${s.id}`),
        ...expirationRules.map(e => `expirationRule:${e.id}`),
        ...contract.exceptions.map(e => `exception:${e.id}`),
      ],
    },
  }
}

export function compileToPackPlan(contract: ProcessContract): CompileToPackPlanResult {
  const validationIssues = validateProcessContract(contract)
  const errors = validationIssues.filter(i => i.severity === 'error')
  if (errors.length > 0) {
    return {
      plan: emptyPlanFor(contract),
      traceability: [],
      escalation: {
        reason: 'This ProcessContract fails deterministic validation and cannot be compiled until fixed. Run `kairos contract validate` for the full list.',
        questions: errors.map(e => `[Rule ${e.rule}] ${e.message}${e.path ? ` (${e.path})` : ''}`),
        source: 'validation_errors',
      },
    }
  }

  const blocking = contract.assumptions.filter(a => a.type === 'blocking')
  if (blocking.length > 0) {
    return {
      plan: emptyPlanFor(contract),
      traceability: [],
      escalation: {
        reason: 'This ProcessContract has blocking assumptions that must be resolved before compiling. Resolve them (edit the contract and re-validate), or compile anyway once they no longer apply.',
        questions: blocking.map(a => a.text),
        source: 'blocking_assumptions',
      },
    }
  }

  const workflows: WorkflowPlan[] = []
  const traceability: ContractWorkflowTrace[] = []

  for (let i = 0; i < contract.startConditions.length; i++) {
    const { workflow, trace } = buildIntakeWorkflow(contract, contract.startConditions[i]!, i, contract.startConditions.length)
    workflows.push(workflow)
    traceability.push(trace)
  }

  const processing = buildProcessingWorkflow(contract)
  if (processing) {
    workflows.push(processing.workflow)
    traceability.push(processing.trace)
  }

  const escalation = buildEscalationWorkflow(contract)
  if (escalation) {
    workflows.push(escalation.workflow)
    traceability.push(escalation.trace)
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
