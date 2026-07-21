import { extractWebhookFieldRefs } from '../pack/webhook-schema.js'
import { evidenceNodeName, type ContractWorkflowTrace } from './compile.js'
import type { ProcessContract } from './types.js'
import type { N8nWorkflow } from '../types/workflow.js'

/**
 * Contract Compiler Verification (roadmap item 10, docs/plans/intake-scenario-harness-plan.md
 * §10). A real gap found by reading compile.ts directly, not assumed: compileToPackPlan()
 * instructs the generation LLM, in prose, to name a node exactly `Kairos Evidence:
 * <transitionId>` for every EvidenceRequirement (evidenceNodeName(), compile.ts) -- but nothing
 * anywhere checked whether the LLM actually did that in the real generated n8n JSON. A workflow
 * silently missing that node produces zero ledger entries for that transition forever, with no
 * error anywhere -- ledger poll finds nothing to extract because there is genuinely nothing
 * there to find, and a thin, wrong-looking `contract report` is the only eventual symptom, weeks
 * later. This module closes that gap with a purely static, structural check run against the
 * REAL, deployed n8n workflow JSON (fetched back from n8n after a real, non-dry-run
 * `contract compile --build`) -- no LLM call, no sandbox execution, matching compile.ts's own
 * "deterministic, no Anthropic call" design principle for the identical reason: a second LLM
 * pass checking the first LLM pass's own output would not be meaningfully more trustworthy,
 * only slower and more expensive.
 *
 * Deliberately narrow, per explicit instruction (2026-07-21): structural presence only, never a
 * claim of full correctness. A node named correctly but wired wrong (a field mapped to the
 * wrong upstream value, an expression that evaluates to the wrong thing at runtime) is NOT
 * caught here -- that needs a real execution, which is the Replay Upgrade's job (roadmap item
 * 7, not yet built), not this static pass's. Every finding message says "structurally present,"
 * never "correctly wired" -- the same evidence-graded, not-a-guarantee framing this whole
 * project already uses everywhere else.
 */

export interface CompilerVerificationFinding {
  severity: 'error' | 'warning'
  contractElement: string
  workflowName: string
  message: string
}

export interface CompilerVerificationResult {
  verdict: 'satisfied' | 'gaps_found'
  findings: CompilerVerificationFinding[]
}

/** One entry per real, deployed workflow this contract compiled to. `workflow` is the raw n8n
 * JSON fetched back from n8n (or generated in-memory, for a caller that already has it) --
 * intentionally a minimal shape (just `name`/`nodes`), not the full N8nWorkflow type, so a
 * caller doesn't need to satisfy fields (connections, settings) this check never reads. */
export interface CompiledWorkflowForVerification {
  workflowName: string
  workflow: Pick<N8nWorkflow, 'nodes'>
}

function checkEvidenceNodesPresent(contract: ProcessContract, workflows: CompiledWorkflowForVerification[]): CompilerVerificationFinding[] {
  const allNodeNames = new Set<string>()
  for (const w of workflows) {
    for (const node of w.workflow.nodes) allNodeNames.add(node.name)
  }

  const findings: CompilerVerificationFinding[] = []
  for (const ev of contract.evidenceRequirements) {
    const expectedName = evidenceNodeName(ev.transitionId)
    if (!allNodeNames.has(expectedName)) {
      findings.push({
        severity: 'error',
        contractElement: `evidenceRequirement:${ev.transitionId}`,
        workflowName: '(not found in any deployed workflow)',
        message: `No node named "${expectedName}" exists in any deployed workflow -- ProofLedger will never be able to extract evidence for transition "${ev.transitionId}" (${ev.description}). This transition's evidence will silently never appear in the ledger or in any promise report.`,
      })
    }
  }
  return findings
}

function checkCorrelationKeyReferenced(contract: ProcessContract, workflows: CompiledWorkflowForVerification[]): CompilerVerificationFinding[] {
  for (const w of workflows) {
    const refs = extractWebhookFieldRefs(w.workflow as N8nWorkflow)
    const allPaths = [
      ...refs.body.map(p => `body.${p}`),
      ...refs.query.map(p => `query.${p}`),
      ...refs.headers.map(p => `headers.${p}`),
    ]
    if (allPaths.includes(contract.correlationKey.fieldPath)) return []
  }

  return [
    {
      severity: 'error',
      contractElement: 'correlationKey',
      workflowName: '(not found in any deployed workflow)',
      message: `The correlation key field "${contract.correlationKey.fieldPath}" (${contract.correlationKey.description}) is not referenced in any deployed workflow's webhook trigger data. Without it, real executions cannot be correlated back to a promise instance at all -- ledger poll would have no way to attribute evidence to anything.`,
    },
  ]
}

function checkStartConditionsCovered(contract: ProcessContract, traceability: ContractWorkflowTrace[]): CompilerVerificationFinding[] {
  const covered = new Set(traceability.flatMap(t => t.sourceElements).filter(e => e.startsWith('startCondition:')))

  const findings: CompilerVerificationFinding[] = []
  for (const sc of contract.startConditions) {
    if (!covered.has(`startCondition:${sc.id}`)) {
      findings.push({
        severity: 'error',
        contractElement: `startCondition:${sc.id}`,
        workflowName: '(not found in compiled plan)',
        message: `No compiled workflow traces back to start condition "${sc.id}" (${sc.description}) -- this contract's own compilation appears incomplete. This should not happen for a contract that passed validation; treat it as a real bug, not an expected outcome.`,
      })
    }
  }
  return findings
}

/**
 * Runs every static check and combines the results. Structural/static only -- no execution, no
 * network call of its own (callers are responsible for however they obtained `workflows`, e.g.
 * a real GET back from n8n after a build). `traceability` is compileToPackPlan()'s own output,
 * threaded through unchanged rather than re-derived.
 */
export function verifyCompiledWorkflows(
  contract: ProcessContract,
  workflows: CompiledWorkflowForVerification[],
  traceability: ContractWorkflowTrace[],
): CompilerVerificationResult {
  const findings: CompilerVerificationFinding[] = [
    ...checkEvidenceNodesPresent(contract, workflows),
    ...checkCorrelationKeyReferenced(contract, workflows),
    ...checkStartConditionsCovered(contract, traceability),
  ]

  return {
    verdict: findings.some(f => f.severity === 'error') ? 'gaps_found' : 'satisfied',
    findings,
  }
}
