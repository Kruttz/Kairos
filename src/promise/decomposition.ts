import { validateProcessContract } from './validate.js'
import type { ProcessContract } from './types.js'

/**
 * Execution Substrate Boundary v0, Phase 2 (docs/plans/execution-substrate-boundary-plan.md §5) --
 * the target-neutral half of what compileToPackPlan() used to do in one step: deciding WHICH
 * workflows a ProcessContract implies and WHY (traceable to specific contract element ids),
 * with zero n8n concept, zero prose generation, and zero LLM call. compile.ts (n8n's own
 * compiler) is the only caller -- see prepareContract()'s own doc comment below for the
 * one-caller discipline this file is built around.
 *
 * This module has zero imports from compile.ts, or from any other target-specific module -- the
 * architectural dependency runs one way only, target-specific code depends on this neutral core,
 * never the reverse. `ContractPreparationEscalation` (below) is the canonical definition of what
 * used to be compile.ts's own `CompileEscalationInfo`; compile.ts now re-exports it under that
 * name (a type alias) purely for its own external callers' backward compatibility.
 */

export type WorkflowSlotKind = 'intake' | 'processing' | 'escalation'

export interface WorkflowSlot {
  name: string
  kind: WorkflowSlotKind
  sourceElements: string[]
  startConditionId?: string
}

export interface ContractDecomposition {
  slots: WorkflowSlot[]
}

/**
 * Pure, deterministic, target-neutral: decides which WorkflowSlots a validated, non-blocked
 * ProcessContract implies, in the same order compileToPackPlan() has always emitted them in --
 * one intake slot per StartCondition (in declaration order), then at most one processing slot,
 * then at most one escalation slot. Never called directly outside prepareContract() (see below).
 */
export function decomposeContract(contract: ProcessContract): ContractDecomposition {
  const slots: WorkflowSlot[] = []

  for (let i = 0; i < contract.startConditions.length; i++) {
    const sc = contract.startConditions[i]!
    const name = contract.startConditions.length === 1
      ? `${contract.entity.name} Intake`
      : `${contract.entity.name} Intake ${i + 1}`
    slots.push({
      name,
      kind: 'intake',
      startConditionId: sc.id,
      sourceElements: [`startCondition:${sc.id}`, `state:${sc.initialState}`, 'correlationKey'],
    })
  }

  if (contract.transitions.length > 0) {
    slots.push({
      name: `${contract.entity.name} Processing & Outcome Logging`,
      kind: 'processing',
      sourceElements: [
        ...contract.transitions.map(t => `transition:${t.id}`),
        ...contract.evidenceRequirements.map(e => `evidenceRequirement:${e.transitionId}`),
      ],
    })
  }

  const expirationRules = contract.expirationRules ?? []
  if (contract.sla.length > 0 || expirationRules.length > 0) {
    slots.push({
      name: `${contract.entity.name} SLA Escalation`,
      kind: 'escalation',
      sourceElements: [
        ...contract.sla.map(s => `sla:${s.id}`),
        ...expirationRules.map(e => `expirationRule:${e.id}`),
        ...contract.exceptions.map(e => `exception:${e.id}`),
      ],
    })
  }

  return { slots }
}

/** Why prepareContract() refused to prepare a contract for compilation. Named neutrally --
 * every target's own compileContract() hits this same gate, not just n8n's. */
export interface ContractPreparationEscalation {
  reason: string
  questions: string[]
  /** validation_errors takes priority when both are present -- structural correctness (can this
   * contract even be reasoned about at all) is checked before business-completeness (does a
   * human still need to resolve something). */
  source: 'validation_errors' | 'blocking_assumptions'
}

export type ContractPreparationResult =
  | { outcome: 'ready'; decomposition: ContractDecomposition }
  | { outcome: 'blocked'; escalation: ContractPreparationEscalation }

/**
 * The single, target-neutral gate every target's compileContract() runs a ProcessContract
 * through before doing any of its own target-specific work: deterministic validation first
 * (structural correctness), then blocking assumptions (business completeness) -- the same
 * order and the same two escalation strings compileToPackPlan() has always used, preserved
 * byte-for-byte here so no existing golden-fixture output changes.
 *
 * decomposeContract() is never called directly by any CLI code, by a future
 * resolveContractCompiler(), or by anything outside a target's own compileContract()
 * implementation -- it has exactly one caller, this function, and this function has exactly
 * one caller today (compile.ts's compileToPackPlan()), with a second (a future non-n8n target)
 * anticipated but not yet built.
 */
export function prepareContract(contract: ProcessContract): ContractPreparationResult {
  const errors = validateProcessContract(contract).filter(i => i.severity === 'error')
  if (errors.length > 0) {
    return {
      outcome: 'blocked',
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
      outcome: 'blocked',
      escalation: {
        reason: 'This ProcessContract has blocking assumptions that must be resolved before compiling. Resolve them (edit the contract and re-validate), or compile anyway once they no longer apply.',
        questions: blocking.map(a => a.text),
        source: 'blocking_assumptions',
      },
    }
  }

  return { outcome: 'ready', decomposition: decomposeContract(contract) }
}
