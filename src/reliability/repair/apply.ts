import { runReplay, type ReplayRunResult } from '../replay/runner.js'
import { saveSnapshot } from './snapshot.js'
import { computeWorkflowHash } from '../../utils/workflow-hash.js'
import { appendReliabilityAudit, type ReliabilityAuditEntry, type RepairWriteAuditEntry } from '../watch/audit.js'
import type { RepairProposal } from './propose.js'
import type { SandboxConfig } from '../sandbox/manager.js'
import type { N8nWorkflow } from '../../types/workflow.js'

/**
 * The apply ladder (docs/plans/reliability-suite-plan.md 8.4): snapshot -> replay-verify ->
 * write -> post-verify -> rollback-on-failure. Every rung audits itself immediately as it
 * completes (not batched at the end) -- if this process crashes mid-ladder, the steps that DID
 * complete must still be on record, not lost because they were waiting to be flushed alongside
 * a later step that never happened.
 *
 * Write uses a `RepairWriteTarget` (a `get`/`update` pair matching `N8nProvider`'s own shape)
 * rather than `Kairos.replace()` -- Finding 1 (8.0): `replace()` is a full LLM regeneration
 * from a text description with no way to express "push exactly this JSON," so the write here
 * is a direct, deterministic push through the same field-stripping (`N8nFieldStripper`)
 * `replace()` itself uses internally, just without the regeneration step wrapped around it.
 */

const AUTO_MODE_WHITELIST: ReadonlySet<string> = new Set(['D9'])

export interface RepairWriteTarget {
  get(workflowId: string): Promise<N8nWorkflow>
  update(workflowId: string, workflow: N8nWorkflow): Promise<{ workflowId: string; name: string }>
}

export interface AutoModeEligibility {
  eligible: boolean
  reason?: string
}

/** Checked before any snapshot/write happens for a `--auto` invocation. Reads
 * `reliability-audit.jsonl`'s own `repair_write` entries as its one source of truth for "has
 * this been auto-attempted before" -- no second, parallel state file. Pure and directly
 * testable: the caller passes in only the entries relevant to audit, not the whole trail. */
export function checkAutoModeEligibility(proposal: RepairProposal, priorAutoWrites: RepairWriteAuditEntry[]): AutoModeEligibility {
  if (!AUTO_MODE_WHITELIST.has(proposal.checkId)) {
    return { eligible: false, reason: `${proposal.checkId} is not in the auto-mode whitelist (v1: D9 only).` }
  }
  if (proposal.verificationAvailability !== 'available') {
    return { eligible: false, reason: `Verification is not available (${proposal.verificationAvailability}) -- --auto requires a clean replay verification, which requires a webhook trigger and at least one captured payload.` }
  }

  const priorAttempt = priorAutoWrites.find(w => w.workflowId === proposal.workflowId && w.checkId === proposal.checkId && w.auto)
  if (priorAttempt) {
    return {
      eligible: false,
      reason: `An auto-repair for ${proposal.checkId} on this workflow already ran at ${priorAttempt.ts} -- one attempt per distinct cause, ever; any further occurrence requires a human (--yes or interactive confirmation).`,
    }
  }

  return { eligible: true }
}

export type ApplyRepairStatus = 'applied' | 'rolled_back' | 'refused'

export interface ApplyRepairResult {
  status: ApplyRepairStatus
  proposal: RepairProposal
  snapshotPath?: string
  replayVerdict?: string
  replayPartialVerification?: boolean
  postVerifyPassed?: boolean
  detail: string
}

export interface ApplyRepairOptions {
  confirmedBy: 'human_prompt' | 'yes_flag' | 'auto_flag'
  auto: boolean
}

async function audit(entry: ReliabilityAuditEntry, auditPath?: string): Promise<void> {
  try {
    await appendReliabilityAudit([entry], auditPath)
  } catch {
    // Best-effort, matching every other audit-writing call site in this codebase -- an
    // audit-write failure must never change what the ladder itself does.
  }
}

/**
 * Assumes confirmation has ALREADY happened by the time this is called -- the CLI layer owns
 * the interactive prompt / --yes / --auto flag parsing and (for --auto) calls
 * `checkAutoModeEligibility()` itself before ever reaching this function. This function is the
 * ladder from snapshot onward, not the confirmation step.
 *
 * `sandboxConfig` is optional and should be omitted entirely when
 * `proposal.verificationAvailability !== 'available'` -- there is nothing to verify against
 * without a webhook trigger and captures, so no sandbox needs to be booted at all.
 */
export async function applyRepair(
  proposal: RepairProposal,
  target: RepairWriteTarget,
  clientId: string,
  options: ApplyRepairOptions,
  sandboxConfig?: SandboxConfig,
  auditPath?: string,
  // Injectable for tests -- defaults to the real runReplay, which needs a real booted sandbox
  // and so can't exercise the safety-critical BROKEN-verdict gating logic without one otherwise.
  runReplayFn: typeof runReplay = runReplay,
): Promise<ApplyRepairResult> {
  const workflowMeta = { workflowId: proposal.workflowId, ...(proposal.workflowName ? { workflowName: proposal.workflowName } : {}) }

  const snapshot = await saveSnapshot(proposal.workflowId, proposal.currentWorkflow)
  await audit({
    kind: 'repair_snapshot', ts: new Date().toISOString(), ...workflowMeta,
    snapshotPath: snapshot.path, detail: `Snapshot saved before applying a ${proposal.checkId} restore.`,
  }, auditPath)

  let replayResult: ReplayRunResult | undefined
  let verifyStatus: 'verified' | 'unverifiable' | 'skipped'

  if (proposal.verificationAvailability === 'available' && sandboxConfig) {
    replayResult = await runReplayFn(sandboxConfig, proposal.currentWorkflow, proposal.proposedWorkflow, proposal.workflowId, clientId)
    // Allow-list, not a deny-list -- only BROKEN was excluded in an earlier draft (verdict
    // !== 'BROKEN'), which silently let INCOMPLETE and NOT_RUN through as "clean" since
    // neither is literally 'BROKEN'. Caught by this module's own tests before it ever shipped.
    // Only BROKEN ("candidate errors where baseline succeeded" -- diff.ts's own definition)
    // is a genuine safety concern specific to repair; BEHAVIORAL_CHANGE is an ACCEPTABLE,
    // often-expected outcome (the whole point of a repair is reverting a hand-edit, which by
    // definition often changes behavior) -- see the plan doc's "Design correction" note.
    // INCOMPLETE/NOT_RUN are excluded for the ordinary reason: they mean verification didn't
    // actually run to a real conclusion, not that it concluded cleanly.
    const CLEAN_VERDICTS = new Set(['IDENTICAL', 'BENIGN_VARIANCE', 'BEHAVIORAL_CHANGE'])
    const clean = replayResult.status === 'completed' && CLEAN_VERDICTS.has(replayResult.verdict) && !replayResult.partialVerification
    verifyStatus = clean ? 'verified' : 'unverifiable'
  } else {
    verifyStatus = 'skipped'
  }

  await audit({
    kind: 'repair_verify', ts: new Date().toISOString(), ...workflowMeta,
    checkId: proposal.checkId, status: verifyStatus,
    ...(replayResult ? { replayVerdict: replayResult.verdict, partialVerification: replayResult.partialVerification } : {}),
    detail: verifyStatus === 'verified'
      ? `Replay verification passed (verdict: ${replayResult!.verdict}).`
      : verifyStatus === 'unverifiable'
        ? `Replay verification did not pass cleanly${replayResult ? ` (verdict: ${replayResult.verdict}, partialVerification: ${replayResult.partialVerification})` : ''}.`
        : `Verification skipped -- ${proposal.verificationAvailability}.`,
  }, auditPath)

  if (options.auto && verifyStatus !== 'verified') {
    return {
      status: 'refused', proposal, snapshotPath: snapshot.path,
      ...(replayResult ? { replayVerdict: replayResult.verdict, replayPartialVerification: replayResult.partialVerification } : {}),
      detail: '--auto refuses to write: replay verification did not pass cleanly. A snapshot was taken but nothing was written. Use --yes or interactive confirmation for a human-approved apply.',
    }
  }

  await target.update(proposal.workflowId, proposal.proposedWorkflow)
  await audit({
    kind: 'repair_write', ts: new Date().toISOString(), ...workflowMeta,
    checkId: proposal.checkId, auto: options.auto, confirmedBy: options.confirmedBy,
    detail: `Wrote the proposed ${proposal.checkId} restore (confirmed by: ${options.confirmedBy}).`,
  }, auditPath)

  const postWorkflow = await target.get(proposal.workflowId)
  const postHash = computeWorkflowHash(postWorkflow)
  const postVerifyPassed = postHash === proposal.hashes.proposedHash

  await audit({
    kind: 'repair_post_verify', ts: new Date().toISOString(), ...workflowMeta,
    checkId: proposal.checkId, passed: postVerifyPassed,
    detail: postVerifyPassed
      ? 'Post-apply verification passed -- the live workflow structurally matches the applied target.'
      : 'Post-apply verification FAILED -- the live workflow does not match what was just written.',
  }, auditPath)

  if (postVerifyPassed) {
    return {
      status: 'applied', proposal, snapshotPath: snapshot.path,
      ...(replayResult ? { replayVerdict: replayResult.verdict, replayPartialVerification: replayResult.partialVerification } : {}),
      postVerifyPassed: true,
      detail: `Applied the ${proposal.checkId} restore successfully; post-apply verification confirms the live workflow matches the target.`,
    }
  }

  // Post-verify failed -- roll back immediately. Restoring proposal.currentWorkflow directly
  // (already in memory, identical to what was just snapshotted) rather than re-reading the
  // snapshot file back off disk.
  await target.update(proposal.workflowId, proposal.currentWorkflow)
  await audit({
    kind: 'repair_rollback', ts: new Date().toISOString(), ...workflowMeta,
    snapshotPath: snapshot.path, reason: 'Post-apply verification failed.',
    detail: 'Restored the pre-apply snapshot after a failed post-apply verification.',
  }, auditPath)

  return {
    status: 'rolled_back', proposal, snapshotPath: snapshot.path,
    ...(replayResult ? { replayVerdict: replayResult.verdict, replayPartialVerification: replayResult.partialVerification } : {}),
    postVerifyPassed: false,
    detail: `Applied the ${proposal.checkId} restore, but post-apply verification failed -- automatically rolled back to the pre-apply snapshot. Escalate: investigate why the write did not take effect as expected.`,
  }
}
