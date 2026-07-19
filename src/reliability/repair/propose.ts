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

/** `diffWorkflows()`/`formatDiff()` (built for `replace()`'s "what changed" summary) are
 * deliberately structural-only -- node added/removed/type-changed, credential-type added/
 * removed -- and say nothing about parameter values, connections, or settings, all three of
 * which `computeWorkflowHash()` DOES include. Found live (2026-07-19, first checkpoint of this
 * module): the most common real D9 scenario -- a hand-edit to an existing node's parameters
 * (a Code node's logic, a URL, a Set node's mapping) -- produced a real hash mismatch but a
 * `formatDiff()` output of "No structural changes," which would have silently misled an
 * operator into thinking nothing meaningful changed. This function closes that gap without
 * building a full field-level diff engine: it names which categories actually differ
 * (parameters/connections/settings), not what the specific new values are -- enough for an
 * operator to know where to look before applying, honest about what it can't tell them. */
function describeNonStructuralChanges(before: N8nWorkflow, after: N8nWorkflow): string[] {
  const notes: string[] = []

  const beforeByName = new Map(before.nodes.map(n => [n.name, n]))
  const changedParamNodes = after.nodes
    .filter(afterNode => {
      const beforeNode = beforeByName.get(afterNode.name)
      return beforeNode !== undefined && beforeNode.type === afterNode.type
        && JSON.stringify(beforeNode.parameters) !== JSON.stringify(afterNode.parameters)
    })
    .map(n => n.name)
  if (changedParamNodes.length > 0) {
    notes.push(`  ~ parameter(s) changed on: ${changedParamNodes.join(', ')} (which nodes differ, not what changed within them -- inspect the full workflow JSON for exact values)`)
  }

  if (JSON.stringify(before.connections ?? {}) !== JSON.stringify(after.connections ?? {})) {
    notes.push('  ~ connections changed (wiring between nodes)')
  }
  if (JSON.stringify(before.settings ?? {}) !== JSON.stringify(after.settings ?? {})) {
    notes.push('  ~ settings changed')
  }

  return notes
}

/** Combines the structural diff with the non-structural notes above, and -- if the content
 * hash differs but somehow none of the categories checked explain why (should not be
 * reachable, since nodes/connections/settings are exactly what the hash covers) -- says so
 * explicitly rather than silently claiming nothing changed. */
function buildProposalDiff(currentWorkflow: N8nWorkflow, proposedWorkflow: N8nWorkflow, hashesDiffer: boolean): string {
  const structural = formatDiff(diffWorkflows(currentWorkflow, proposedWorkflow))
  const nonStructural = describeNonStructuralChanges(currentWorkflow, proposedWorkflow)

  const lines = [structural, ...nonStructural]
  const structuralIsEmpty = structural.includes('No structural changes')
  if (hashesDiffer && structuralIsEmpty && nonStructural.length === 0) {
    lines.push('  ⚠ The content hash differs but no specific change category above explains why -- inspect the full workflow JSON directly before applying.')
  }
  return lines.join('\n')
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

/** Discriminated so a caller (the CLI's audit-entry construction, in particular) can always
 * tell "nothing to propose, normal" apart from "refused, a real bug" -- collapsing both into a
 * bare `null` would make the internal-consistency failure indistinguishable from the ordinary,
 * expected "not drifting" outcome in the audit trail, exactly the kind of silent conflation
 * this codebase's 4-state honesty discipline exists to prevent elsewhere. */
export type ProposeRepairResult =
  | { status: 'proposed'; proposal: RepairProposal }
  | { status: 'not_drifting'; detail: string }
  | { status: 'internal_error'; detail: string }

export async function proposeRepair(input: ProposeRepairInput): Promise<ProposeRepairResult> {
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
  if (d9Finding?.status !== 'drifting') {
    return { status: 'not_drifting', detail: d9Finding?.summary ?? 'D9 (build-vs-live structural drift) is not currently drifting.' }
  }

  if (!hashes.proposedMatchesStored) {
    // Internal-consistency failure, not a drift finding -- proposedWorkflow is always
    // input.storedWorkflow in v1, so this can only mean computeWorkflowHash() itself
    // behaved non-deterministically or this function's own logic changed underneath this
    // guard. Refuse rather than let a mismatched restore target reach apply.
    return {
      status: 'internal_error',
      detail: `Refusing to propose: proposedHash (${proposedHash}) does not equal storedHash (${storedHash}) even though the restore target is always the stored workflow in v1. This indicates a real bug -- do not apply.`,
    }
  }

  const d9Diagnosis = report.diagnoses.find(d => d.checkId === 'D9')
  const rationale = d9Diagnosis
    ? `${d9Diagnosis.causeStatement} ${d9Diagnosis.recommendedAction}`
    : d9Finding.summary

  const captures = await listCapturedPayloads(input.clientId, input.workflowId)
  const verificationAvailability = deriveVerificationAvailability(input.currentWorkflow, captures.length > 0)

  const proposal: RepairProposal = {
    workflowId: input.workflowId,
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    checkId: 'D9',
    repairClass: 'mechanical',
    rationale,
    currentWorkflow: input.currentWorkflow,
    proposedWorkflow,
    diff: buildProposalDiff(input.currentWorkflow, proposedWorkflow, hashes.liveDiffersFromStored),
    hashes,
    riskLevel: deriveRiskLevel(verificationAvailability),
    verificationAvailability,
    nextAction: nextActionFor(verificationAvailability, input.workflowId, input.clientId),
  }
  return { status: 'proposed', proposal }
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
