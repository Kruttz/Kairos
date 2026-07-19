import { N8nApiClient } from '../../providers/n8n/api-client.js'
import { nullLogger } from '../../utils/logger.js'
import { findWebhookTrigger } from '../../utils/webhook-verify.js'
import { assertNotProduction, importToSandbox, type SandboxConfig, type SandboxImportResult } from '../sandbox/manager.js'
import { replayOnePayload, resolveReplayRunOptions, type ReplayRunOptions } from '../replay/runner.js'
import { diffPayloadExecution, type PayloadDiffResult } from '../replay/diff.js'
import type { CapturedPayload } from '../replay/capture.js'
import { generateChaosPayloads, type ChaosPayloadVariant } from './payloads.js'
import type { N8nWorkflow } from '../../types/workflow.js'

/**
 * Tier B: confirms Tier A's (static-audit.ts) predictions live, in the sandbox. Per the plan's
 * precision correction (9.2, 2026-07-19): this is NOT a call into replay/runner.ts's
 * `runReplay()` -- that orchestrator is shaped for "two workflow versions, one shared payload
 * list," which isn't chaos's shape ("one workflow, many payload variants"). This module reuses
 * `runner.ts`'s and `diff.ts`'s *primitives* instead: `replayOnePayload()` (generic over
 * client/config/workflowId/trigger/payload, unmodified) and `diffPayloadExecution()` (doesn't
 * care *why* two snapshots differ -- passing the same workflow object as both its "baseline"
 * and "candidate" params is correct here, since there's only one real workflow version and its
 * credential set is identical either way).
 *
 * The valid-baseline payload (`generateChaosPayloads()`'s first variant, always) is replayed
 * once and used as the reference every adversarial variant is diffed against -- not "did this
 * variant succeed" in isolation, but "did this variant behave differently than a normal
 * request would." Same guardrails as replay/runner.ts, reused for the same reasons: cleanup
 * always runs (`finally`), the imported workflow name is unmistakably prefixed, only the
 * sandbox is ever executed against, polling is bounded/backs off, "no execution found" is its
 * own outcome (never silently a pass), and a node blocked by a stripped credential is reported
 * as unverifiable, never asserted as a real HANDLED/CRASHED/SILENT_MISBEHAVIOR finding.
 */

export type ChaosPayloadClassification = 'HANDLED' | 'CRASHED' | 'SILENT_MISBEHAVIOR' | 'BLOCKED_AT_CREDENTIAL'

export interface ChaosPayloadOutcome {
  variantName: string
  rationale: string
  status: 'evaluated' | 'no_execution_found'
  /** Present only when status === 'evaluated'. */
  classification?: ChaosPayloadClassification
  referenceExecutionId?: string
  variantExecutionId?: string
  /** The underlying diff this outcome's classification was derived from -- present only when
   * status === 'evaluated'. Carried through rather than re-summarized so a consumer can find
   * exactly which node crashed (nodeDiffs) or which nodes were unverifiable
   * (verificationBoundary) without this module re-deriving/duplicating that from the snapshot. */
  diff?: PayloadDiffResult
  detail: string
}

export interface ChaosSandboxRunSummary {
  handled: number
  crashed: number
  silentMisbehavior: number
  blockedAtCredential: number
  incomplete: number
}

export type ChaosSandboxRunStatus = 'completed' | 'not_webhook_shaped' | 'no_reference_execution'

export interface ChaosSandboxRunResult {
  status: ChaosSandboxRunStatus
  detail: string
  importedWorkflowName?: string
  referenceExecutionId?: string
  outcomes: ChaosPayloadOutcome[]
  summary: ChaosSandboxRunSummary
}

const EMPTY_SUMMARY: ChaosSandboxRunSummary = { handled: 0, crashed: 0, silentMisbehavior: 0, blockedAtCredential: 0, incomplete: 0 }

function toCapturedPayload(variant: ChaosPayloadVariant): CapturedPayload {
  return {
    executionId: `chaos:${variant.name}`,
    capturedAt: new Date().toISOString(),
    triggerNodeName: 'chaos-synthetic',
    payload: { body: variant.body },
    scrubbed: false,
  }
}

/** Exported for direct unit testing -- this mapping (ReplayVerdict -> chaos's own labels) is
 * the core rule this module exists to encode; it doesn't need a live sandbox to verify. */
export function classifyChaosPayloadDiff(diff: PayloadDiffResult): ChaosPayloadClassification {
  if (diff.verdict === 'BROKEN') return 'CRASHED'
  if (diff.verdict === 'BEHAVIORAL_CHANGE') return 'SILENT_MISBEHAVIOR'
  // IDENTICAL or BENIGN_VARIANCE from here -- no attributable divergence among verifiable
  // nodes. partialVerification means part of the path was credential-stripped, so "handled"
  // can't be asserted with full confidence even though nothing wrong was actually observed.
  return diff.partialVerification ? 'BLOCKED_AT_CREDENTIAL' : 'HANDLED'
}

function detailFor(classification: ChaosPayloadClassification, diff: PayloadDiffResult): string {
  switch (classification) {
    case 'HANDLED':
      return 'Behaved equivalently to the valid-baseline reference -- this payload variant is handled.'
    case 'CRASHED': {
      const crashedNodes = diff.nodeDiffs.filter(n => n.status === 'changed' && n.detail.includes('Candidate errors'))
      const names = crashedNodes.map(n => n.node).join(', ') || 'an unidentified node'
      return `Caused a crash at "${names}" that did not occur with the valid-baseline reference. See diff.nodeDiffs for the specific error.`
    }
    case 'SILENT_MISBEHAVIOR':
      return 'Completed without crashing, but diverged from the valid-baseline reference (coverage or output shape changed). See diff.nodeDiffs for detail.'
    case 'BLOCKED_AT_CREDENTIAL':
      return "No divergence found among verifiable nodes, but this payload's execution path passed through a credential-stripped node -- cannot assert HANDLED with full confidence. See diff.verificationBoundary for detail."
  }
}

function summarize(outcomes: ChaosPayloadOutcome[]): ChaosSandboxRunSummary {
  return {
    handled: outcomes.filter(o => o.classification === 'HANDLED').length,
    crashed: outcomes.filter(o => o.classification === 'CRASHED').length,
    silentMisbehavior: outcomes.filter(o => o.classification === 'SILENT_MISBEHAVIOR').length,
    blockedAtCredential: outcomes.filter(o => o.classification === 'BLOCKED_AT_CREDENTIAL').length,
    incomplete: outcomes.filter(o => o.status === 'no_execution_found').length,
  }
}

export async function runChaosSandbox(
  sandboxConfig: SandboxConfig,
  workflow: N8nWorkflow,
  options: ReplayRunOptions = {},
): Promise<ChaosSandboxRunResult> {
  assertNotProduction(sandboxConfig.baseUrl)
  const resolvedOptions = resolveReplayRunOptions(options)

  const trigger = findWebhookTrigger(workflow)
  if (!trigger) {
    return {
      status: 'not_webhook_shaped',
      detail: 'Chaos sandbox runs only support webhook-triggered workflows today (same scope as replay -- the only trigger type verified end-to-end, Phase 0 spike S3).',
      outcomes: [],
      summary: EMPTY_SUMMARY,
    }
  }

  const [referenceVariant, ...adversarialVariants] = generateChaosPayloads(workflow)

  const client = new N8nApiClient(sandboxConfig.baseUrl, sandboxConfig.apiKey, nullLogger)
  let imported: SandboxImportResult | undefined
  let referenceExecutionId: string | undefined
  const outcomes: ChaosPayloadOutcome[] = []

  try {
    imported = await importToSandbox(sandboxConfig, workflow, `chaos: ${workflow.name ?? 'workflow'}`)
    await client.activateWorkflow(imported.id)
    const injectionTrigger = imported.webhookTrigger ?? trigger

    const referenceOutcome = await replayOnePayload(client, sandboxConfig, imported.id, injectionTrigger, toCapturedPayload(referenceVariant!), resolvedOptions)
    if (referenceOutcome.status !== 'found') {
      return {
        status: 'no_reference_execution',
        detail: `The valid-baseline payload itself produced no fresh execution within ${resolvedOptions.pollTimeoutMs}ms -- cannot establish a reference to compare adversarial variants against.`,
        importedWorkflowName: imported.name,
        outcomes: [],
        summary: EMPTY_SUMMARY,
      }
    }
    referenceExecutionId = referenceOutcome.executionId

    for (const variant of adversarialVariants) {
      const variantOutcome = await replayOnePayload(client, sandboxConfig, imported.id, injectionTrigger, toCapturedPayload(variant), resolvedOptions)

      if (variantOutcome.status !== 'found') {
        outcomes.push({
          variantName: variant.name,
          rationale: variant.rationale,
          status: 'no_execution_found',
          ...(referenceExecutionId ? { referenceExecutionId } : {}),
          detail: `No fresh execution appeared within ${resolvedOptions.pollTimeoutMs}ms for this variant. Treated as unverified, not as a pass.`,
        })
        continue
      }

      const diff = diffPayloadExecution(variant.name, workflow, workflow, referenceOutcome.snapshot!, variantOutcome.snapshot!)
      const classification = classifyChaosPayloadDiff(diff)
      outcomes.push({
        variantName: variant.name,
        rationale: variant.rationale,
        status: 'evaluated',
        classification,
        ...(referenceExecutionId ? { referenceExecutionId } : {}),
        ...(variantOutcome.executionId ? { variantExecutionId: variantOutcome.executionId } : {}),
        diff,
        detail: detailFor(classification, diff),
      })
    }
  } finally {
    // Cleanup always runs, even on timeout/failure above -- matches replay/runner.ts's own
    // guardrail; a chaos run that throws mid-loop must not leave sandbox debris behind.
    if (imported) await client.deleteWorkflow(imported.id).catch(() => {})
  }

  return {
    status: 'completed',
    detail: `Ran ${adversarialVariants.length} adversarial payload variant(s) against the valid-baseline reference.`,
    importedWorkflowName: imported.name,
    ...(referenceExecutionId ? { referenceExecutionId } : {}),
    outcomes,
    summary: summarize(outcomes),
  }
}

/** Rendered-text formatter -- the structured `ChaosSandboxRunResult` above is the source of
 * truth (available via `--json`); this is a separate, later step, not the other way around. */
export function formatChaosSandboxRunResult(result: ChaosSandboxRunResult, workflowId: string): string {
  const lines: string[] = []
  lines.push(`Chaos sandbox run — ${workflowId}`)
  lines.push('─'.repeat(50))

  if (result.status === 'not_webhook_shaped') {
    lines.push(result.detail)
    return lines.join('\n')
  }
  if (result.status === 'no_reference_execution') {
    lines.push(result.detail)
    return lines.join('\n')
  }

  const { summary } = result
  lines.push(`${summary.handled} handled, ${summary.crashed} crashed, ${summary.silentMisbehavior} silent misbehavior, ${summary.blockedAtCredential} blocked at credential, ${summary.incomplete} incomplete.`)
  lines.push('')

  for (const outcome of result.outcomes) {
    if (outcome.status === 'no_execution_found') {
      lines.push(`  [INCOMPLETE] ${outcome.variantName} — ${outcome.detail}`)
      continue
    }
    lines.push(`  [${outcome.classification}] ${outcome.variantName} — ${outcome.detail}`)
  }
  lines.push('')

  if (summary.crashed > 0) {
    lines.push('Next action: fix the crashing node(s) above (add a guard/default for the field that triggers it), then re-run.')
  } else if (summary.silentMisbehavior > 0) {
    lines.push('Next action: review the silent-misbehavior variant(s) above -- confirm the behavioral difference is intentional, not a masked bug.')
  } else {
    lines.push('Next action: none required from this run. Blocked-at-credential variants remain unverified in sandbox -- confirm those manually if they matter.')
  }

  return lines.join('\n')
}
