import { buildDriftCheckReport } from '../drift/report.js'
import { listCapturedPayloads } from '../replay/capture.js'
import { findWebhookTrigger } from '../../utils/webhook-verify.js'
import { computeWorkflowHash } from '../../utils/workflow-hash.js'
import { diffWorkflows, formatDiff } from '../../utils/workflow-diff.js'
import type { N8nWorkflow } from '../../types/workflow.js'
import type { ExecutionTrace } from '../../library/types.js'

/**
 * v1 scope (docs/plans/reliability-suite-plan.md 8.1/8.2, re-verified against shipped code
 * before writing this): D9 (build-vs-live structural drift) only. D9 is the one drift class
 * with a fully deterministic fix -- restore FileLibrary's own stored JSON for this workflow,
 * no LLM call, no freeform pattern-matching (Finding 1: Kairos.replace() cannot express a
 * targeted patch; Finding 2: FileLibrary's stored copy is the correct, safe restore target
 * since an external hand-edit never touches it). D1/D8 stay diagnosed and escalated
 * (buildDriftCheckReport already does this, unchanged) but never reach this module's switch --
 * proposing a fix for either requires real, separate engineering this phase does not build.
 * D2/D3/D4/D5/D6/D7 never produce a proposal, permanently -- their causes are external to the
 * workflow's own structure; a workflow edit would be theater (Codex, 2026-07-19).
 */

export interface RepairHashComparison {
  storedHash: string
  liveHash: string
  proposedHash: string
  /** Should always be true when D9 fired at all -- computed explicitly rather than assumed,
   * so a future bug in D9's own drifting-status logic can never silently propagate here. */
  liveDiffersFromStored: boolean
  /** True by construction in v1 (proposedWorkflow IS the stored workflow, nothing else) --
   * asserted explicitly, not assumed. If this is ever false, proposeRepair() has a real
   * internal-consistency bug and refuses to emit a proposal at all (see proposeRepair()). */
  proposedMatchesStored: boolean
}

export type VerificationAvailability = 'available' | 'no_webhook_trigger' | 'no_captures'

export interface RepairProposal {
  workflowId: string
  workflowName?: string
  checkId: 'D9'
  repairClass: 'mechanical'
  rationale: string
  currentWorkflow: N8nWorkflow
  proposedWorkflow: N8nWorkflow
  diff: string
  hashes: RepairHashComparison
  riskLevel: 'low' | 'medium' | 'high'
  verificationAvailability: VerificationAvailability
  nextAction: string
}

export interface ProposeRepairInput {
  workflowId: string
  workflowName?: string
  clientId: string
  /** Freshly fetched from n8n -- the live, possibly-drifting workflow. */
  currentWorkflow: N8nWorkflow
  /** FileLibrary's stored JSON for this workflow -- the D9 restore target (Finding 2). */
  storedWorkflow: N8nWorkflow
  traces: ExecutionTrace[]
}

function deriveVerificationAvailability(currentWorkflow: N8nWorkflow, hasCaptures: boolean): VerificationAvailability {
  if (!findWebhookTrigger(currentWorkflow)) return 'no_webhook_trigger'
  if (!hasCaptures) return 'no_captures'
  return 'available'
}

function deriveRiskLevel(availability: VerificationAvailability): 'low' | 'medium' | 'high' {
  switch (availability) {
    case 'available': return 'low'
    case 'no_captures': return 'medium'
    case 'no_webhook_trigger': return 'high'
  }
}

function nextActionFor(availability: VerificationAvailability, workflowId: string, clientId: string): string {
  switch (availability) {
    case 'available':
      return `kairos repair apply ${workflowId} --client-id ${clientId}`
    case 'no_captures':
      return `kairos replay capture ${workflowId} --client-id ${clientId}, then kairos repair apply ${workflowId} --client-id ${clientId}`
    case 'no_webhook_trigger':
      return `kairos repair apply ${workflowId} --client-id ${clientId} --yes (verification will never be available for this workflow -- no webhook trigger to replay against)`
  }
}

/**
 * Returns null when there is nothing to propose: D9 is not drifting, or (defensively) the
 * hash-consistency check fails -- proposedWorkflow must always equal storedWorkflow by
 * construction in v1, and if it doesn't, that is a real bug in this function, not a normal
 * "nothing to fix" outcome. Never silently proceeds with a mismatched restore target.
 */
export async function proposeRepair(input: ProposeRepairInput): Promise<RepairProposal | null> {
  const proposedWorkflow = input.storedWorkflow

  const storedHash = computeWorkflowHash(input.storedWorkflow)
  const liveHash = computeWorkflowHash(input.currentWorkflow)
  const proposedHash = computeWorkflowHash(proposedWorkflow)

  const hashes: RepairHashComparison = {
    storedHash,
    liveHash,
    proposedHash,
    liveDiffersFromStored: liveHash !== storedHash,
    proposedMatchesStored: proposedHash === storedHash,
  }

  // D9's own check (checks.ts) is a pure comparison, decoupled from how the caller obtained
  // either hash -- FileLibrary's stored JSON (storedHash) is the "originalBuildHash" input
  // here, per Finding 2: it's the last state Kairos itself is known to have deployed, which is
  // both the correct D9 baseline and the correct restore target, not necessarily the very
  // first build ever (a workflow legitimately redeployed by Kairos several times should be
  // compared against its LATEST Kairos-known state, not its first).
  const report = buildDriftCheckReport(
    { workflowId: input.workflowId, ...(input.workflowName ? { workflowName: input.workflowName } : {}) },
    { traces: input.traces, originalBuildHash: storedHash, liveExportHash: liveHash },
  )

  const d9Finding = report.findings.find(f => f.id === 'D9')
  if (d9Finding?.status !== 'drifting') return null

  const d9Diagnosis = report.diagnoses.find(d => d.checkId === 'D9')
  const rationale = d9Diagnosis
    ? `${d9Diagnosis.causeStatement} ${d9Diagnosis.recommendedAction}`
    : d9Finding.summary

  if (!hashes.proposedMatchesStored) {
    // Internal-consistency failure, not a drift finding -- proposedWorkflow is always
    // input.storedWorkflow in v1, so this can only mean computeWorkflowHash() itself
    // behaved non-deterministically or this function's own logic changed underneath this
    // guard. Refuse rather than let a mismatched restore target reach apply.
    return null
  }

  const captures = await listCapturedPayloads(input.clientId, input.workflowId)
  const verificationAvailability = deriveVerificationAvailability(input.currentWorkflow, captures.length > 0)

  return {
    workflowId: input.workflowId,
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    checkId: 'D9',
    repairClass: 'mechanical',
    rationale,
    currentWorkflow: input.currentWorkflow,
    proposedWorkflow,
    diff: formatDiff(diffWorkflows(input.currentWorkflow, proposedWorkflow)),
    hashes,
    riskLevel: deriveRiskLevel(verificationAvailability),
    verificationAvailability,
    nextAction: nextActionFor(verificationAvailability, input.workflowId, input.clientId),
  }
}

function truncateHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 20)}…` : hash
}

/** Rendered-text formatter -- the structured RepairProposal above is the source of truth
 * (available via --json); this is a separate, later step. Always states all four facts
 * Codex required (2026-07-19) explicitly, never gated on a condition or omitted as "obvious." */
export function formatRepairProposal(proposal: RepairProposal): string {
  const lines: string[] = []
  lines.push(`Repair proposal — ${proposal.workflowName ?? proposal.workflowId} (${proposal.workflowId})`)
  lines.push('─'.repeat(50))
  lines.push(`Check: ${proposal.checkId} (${proposal.repairClass})`)
  lines.push(`Risk level: ${proposal.riskLevel.toUpperCase()}`)
  lines.push(`Verification: ${proposal.verificationAvailability}`)
  lines.push('')
  lines.push(`Rationale: ${proposal.rationale}`)
  lines.push('')
  lines.push('Hash comparison:')
  lines.push(`  Stored (Kairos-known-good):  ${truncateHash(proposal.hashes.storedHash)}`)
  lines.push(`  Live (current, on n8n):      ${truncateHash(proposal.hashes.liveHash)}`)
  lines.push(`  Proposed (restore target):   ${truncateHash(proposal.hashes.proposedHash)}`)
  lines.push('')
  lines.push(proposal.hashes.liveDiffersFromStored
    ? '  ✓ Live differs from the known Kairos-stored version.'
    : '  ⚠ Live does NOT differ from the stored version -- unexpected, since D9 fired. Investigate before applying.')
  lines.push(proposal.hashes.proposedMatchesStored
    ? '  ✓ The restore target equals the known Kairos-stored version.'
    : '  ⚠ The restore target does NOT equal the stored version -- this should never happen; do not apply.')
  lines.push('')
  lines.push('⚠ Applying this will overwrite whatever is currently live, including any manual edits made outside Kairos.')
  lines.push('⚠ Post-apply verification is structural only -- it does not fire any webhook or trigger any request against the live workflow.')
  lines.push('')
  lines.push('Diff:')
  lines.push(proposal.diff)
  lines.push('')
  lines.push(`Next action: ${proposal.nextAction}`)

  return lines.join('\n')
}
