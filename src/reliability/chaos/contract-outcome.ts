import { extractExecutionEvidence, hashCorrelationKeyValue } from '../../promise/ledger.js'
import { generateContractScenarios } from '../../promise/scenario.js'
import { findWebhookTrigger } from '../../utils/webhook-verify.js'
import { nullLogger } from '../../utils/logger.js'
import { N8nApiClient } from '../../providers/n8n/api-client.js'
import { assertNotProduction, importToSandbox, type SandboxConfig, type SandboxImportResult } from '../sandbox/manager.js'
import { replayOnePayload, resolveReplayRunOptions, type ReplayRunOptions } from '../replay/runner.js'
import { diffPayloadExecution } from '../replay/diff.js'
import { scenarioIntakePayloadBody } from '../replay/contract-outcome.js'
import { classifyChaosPayloadDiff, type ChaosPayloadClassification } from './sandbox-run.js'
import type { CapturedPayload } from '../replay/capture.js'
import type { ChaosPayloadVariant } from './payloads.js'
import type { ProcessContract, StartCondition } from '../../promise/types.js'
import type { ProofLedgerEntry } from '../../promise/ledger-types.js'
import type { N8nWorkflow } from '../../types/workflow.js'

/**
 * Chaos Upgrade: business-level scenarios (roadmap item 8, docs/plans/
 * intake-scenario-harness-plan.md §8). Extends chaos testing so it can inject
 * ProcessContract-derived payloads -- not only the structural, field-shape mutations
 * payloads.ts already produces -- and check the result against what the contract says should
 * happen, reusing reliability/replay/contract-outcome.ts's own payload-construction and
 * SCOPE_CAVEAT discipline (Phase 7) rather than re-deriving either.
 *
 * **Same architectural constraint Phase 7 found, re-confirmed against compile.ts for this
 * phase, not assumed carried over**: buildIntakeWorkflow() only ever handles a contract's
 * StartConditions; buildProcessingWorkflow() owns every ProcessTransition, including the ones
 * evidencing a failure terminal. A chaos run injects payloads at ONE workflow's webhook -- for
 * the intake workflow, that means only instance_start-shaped evidence is producible/checkable
 * here, exactly as Phase 7 found for replay.
 *
 * **Category coverage decided against that constraint, not assumed** -- of Codex's named list
 * (missing data, duplicate/correlation ambiguity, late/no response, after-hours, failure
 * terminal, in-progress), only three survive as real, single-or-double webhook injections:
 *   - happy_path: a complete, valid intake payload -- this run's own positive control, and the
 *     reference every other variant's crash-classification is diffed against (same convention
 *     sandbox-run.ts's own valid-baseline variant already uses).
 *   - missing_correlation_key: the intake payload itself is missing the field the contract's
 *     own correlationKey.fieldPath names. Deliberately NOT the harness's own 'missing_data'
 *     category (that one is about an incomplete EvidenceRequirement marker node in the
 *     processing workflow) -- a different, intake-shaped kind of "missing data," named
 *     differently on purpose so the two are never confused with each other.
 *   - duplicate_correlation: the SAME payload (same correlationKeyValue) injected twice, close
 *     together -- reachable at intake alone, since generateContractScenarios()'s own
 *     duplicate_correlation category already models exactly this as two instance_start events
 *     under one correlation key.
 * Skipped, with reasons carried in this module's own return value rather than silently
 * omitted (SKIPPED_CATEGORIES below):
 *   - failure_terminal: its EvidenceRequirement lives in the processing workflow, unreachable
 *     from an intake-only injection.
 *   - no_response: chaos injects one request and reads its own immediate result -- "no second
 *     event ever arrives" is an absence over time, not a payload shape, and does not fit
 *     chaos's single-request model at all.
 *   - after_hours: which business-hours bucket a submission lands in depends on the real
 *     wall-clock instant the sandbox executes it, not on anything the payload itself carries --
 *     a live injection cannot backdate itself into the past the way the (purely synthetic, no
 *     real execution) Scenario Generator can.
 *   - in_progress: structurally identical, at the intake-payload level, to happy_path -- the
 *     difference is elapsed time / further evidence, neither of which the intake payload's own
 *     content encodes. Folded into happy_path instead of a redundant duplicate variant.
 */

const SCOPE_CAVEAT =
  'This check injects the contract-derived payload against the registered intake workflow only -- it can verify the instance_start evidence that single execution produces, not state-transition evidence normally produced by a separate, differently-triggered processing workflow. Evidence-graded validation of the intake moment only, not a semantic proof the whole business promise was kept. See this run\'s own "skipped" list for scenario categories this chaos upgrade does not attempt at all (e.g. failure_terminal, no_response, after_hours) and why.'

export type ContractChaosCategory = 'happy_path' | 'missing_correlation_key' | 'duplicate_correlation'

export interface ContractChaosVariant extends ChaosPayloadVariant {
  category: ContractChaosCategory
  scenarioId: string
  correlationKeyValue: string
  /** The instance_start initialState a correctly-behaving intake workflow should record for
   * this payload -- absent for missing_correlation_key, where none should be recorded at all. */
  expectedInitialState?: string
  /** True only for missing_correlation_key: a correctly-behaving intake workflow should NOT
   * attribute any instance_start to this payload. The comparison logic branches on this
   * instead of assuming every variant should always produce a matching entry, the way replay's
   * simpler evaluateScenarioIntakeOutcome() does. */
  expectNoInstanceStart?: boolean
  /** True only for duplicate_correlation -- inject `body`, then this SAME body again shortly
   * after, to produce a genuine duplicate submission under one real correlation key. */
  injectTwice?: boolean
}

export interface ContractChaosSkip {
  category: string
  reason: string
}

export interface ContractChaosGenerationResult {
  variants: ContractChaosVariant[]
  skipped: ContractChaosSkip[]
}

const SKIPPED_CATEGORIES: ContractChaosSkip[] = [
  { category: 'failure_terminal', reason: "Its EvidenceRequirement is produced by the contract's processing workflow, not the intake workflow a chaos run injects against -- unreachable from a single intake-webhook injection (compile.ts always performs this split; confirmed against buildProcessingWorkflow())." },
  { category: 'no_response', reason: "Chaos injects one request and reads its own immediate result. \"No second event ever arrives\" is an absence over time, not a payload shape -- does not fit chaos's single-request model." },
  { category: 'after_hours', reason: 'Which business-hours bucket a submission lands in depends on the real wall-clock instant the sandbox executes it, not on anything the payload itself carries -- a live injection cannot backdate itself into the past.' },
  { category: 'in_progress', reason: "Structurally identical, at the intake-payload level, to happy_path -- the difference is elapsed time / further evidence, neither of which the intake payload's own content encodes. Covered by the happy_path variant instead of a redundant duplicate." },
]

/** Builds the intake payload's raw HTTP body with the field at contract.correlationKey.fieldPath
 * removed entirely -- as opposed to present-but-empty/null (payloads.ts's own structural chaos
 * already covers those shapes for whatever fields a workflow's node parameters happen to
 * reference). Deliberately keyed off the CONTRACT's own correlation key, not a node-parameter
 * scan, since that's the one field this whole system depends on for attribution, whether or not
 * any node parameter happens to reference it. Mirrors reliability/replay/contract-outcome.ts's
 * own "body." prefix-stripping convention exactly, since it's building a path into the same raw
 * HTTP body scenarioIntakePayloadBody() already produced. */
function omitCorrelationKeyField(contract: ProcessContract, body: Record<string, unknown>): Record<string, unknown> {
  const fieldPath = contract.correlationKey.fieldPath
  const bodyPrefix = 'body.'
  const pathWithinRawBody = fieldPath.startsWith(bodyPrefix) ? fieldPath.slice(bodyPrefix.length) : fieldPath
  const parts = pathWithinRawBody.split('.')
  const clone = structuredClone(body)
  let cursor: Record<string, unknown> = clone
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cursor[parts[i]!]
    if (typeof next !== 'object' || next === null) return clone // path doesn't exist -- nothing to omit
    cursor = next as Record<string, unknown>
  }
  delete cursor[parts[parts.length - 1]!]
  return clone
}

/**
 * Builds this run's contract-derived chaos variants. Deterministic, no I/O, no sandbox --
 * directly unit-testable, matching the "pure generation, live-checkpointed orchestrator" split
 * this whole arc has used since Phase 5/6. Grounded in generateContractScenarios() (roadmap
 * item 5) for happy_path/duplicate_correlation rather than inventing a parallel payload
 * construction, per Codex's explicit "Reuse Contract Scenario Generator" instruction --
 * missing_correlation_key is the one genuinely new, chaos-specific payload shape, since none of
 * the harness's 7 scenario categories model "the raw intake payload is missing its own
 * correlation key field."
 */
export function generateContractChaosVariants(contract: ProcessContract, now: Date = new Date()): ContractChaosGenerationResult {
  const { scenarios, skipped: generatorSkips } = generateContractScenarios(contract, ['happy_path', 'duplicate_correlation'], now)
  const variants: ContractChaosVariant[] = []
  const skipped: ContractChaosSkip[] = [...SKIPPED_CATEGORIES]

  const happy = scenarios.find(s => s.category === 'happy_path')
  if (happy) {
    const body = scenarioIntakePayloadBody(contract, happy)
    const happyInitialState = happy.timeline.find(e => e.kind === 'instance_start')?.initialState
    variants.push({
      name: 'contract:happy-path',
      rationale: `A complete, valid intake payload for "${contract.entity.name}" -- this run's own positive control, using the contract's real correlation key field and a realistic scenario-generated value rather than a synthesized placeholder.`,
      body,
      category: 'happy_path',
      scenarioId: happy.id,
      correlationKeyValue: happy.correlationKeyValue,
      ...(happyInitialState ? { expectedInitialState: happyInitialState } : {}),
    })

    variants.push({
      name: 'contract:missing-correlation-key',
      rationale: `The same payload with "${contract.correlationKey.fieldPath}" (the contract's own correlation key) removed entirely -- probes whether the intake workflow fabricates or mis-attributes an instance_start when it has nothing real to key it by, rather than a generic missing-field guess against whatever a node parameter happens to reference.`,
      body: omitCorrelationKeyField(contract, body),
      category: 'missing_correlation_key',
      scenarioId: happy.id,
      correlationKeyValue: happy.correlationKeyValue,
      expectNoInstanceStart: true,
    })
  } else {
    const reason = generatorSkips.find(s => s.category === 'happy_path')?.reason ?? 'Scenario Generator could not produce a happy_path scenario for this contract.'
    skipped.push({ category: 'happy_path', reason })
    skipped.push({ category: 'missing_correlation_key', reason: `Depends on a happy_path scenario to derive a realistic payload from; none was available. ${reason}` })
  }

  const duplicate = scenarios.find(s => s.category === 'duplicate_correlation')
  if (duplicate) {
    const duplicateInitialState = duplicate.timeline.find(e => e.kind === 'instance_start')?.initialState
    variants.push({
      name: 'contract:duplicate-correlation',
      rationale: 'The same intake payload submitted twice in close succession -- e.g. the same email used for a second, unrelated occurrence, or simply submitted twice -- probes whether the intake workflow (and, downstream, classifyPromiseInstance()) correctly records two real instance_start entries under one correlation key rather than silently dropping or merging them.',
      body: scenarioIntakePayloadBody(contract, duplicate),
      category: 'duplicate_correlation',
      scenarioId: duplicate.id,
      correlationKeyValue: duplicate.correlationKeyValue,
      ...(duplicateInitialState ? { expectedInitialState: duplicateInitialState } : {}),
      injectTwice: true,
    })
  } else {
    const reason = generatorSkips.find(s => s.category === 'duplicate_correlation')?.reason ?? 'Scenario Generator could not produce a duplicate_correlation scenario for this contract.'
    skipped.push({ category: 'duplicate_correlation', reason })
  }

  return { variants, skipped }
}

/**
 * The actual business-outcome comparison -- pure, directly testable, no sandbox/network/
 * extraction. Takes already-extracted entries (real, from extractExecutionEvidence(), or
 * hand-built for a test) so it never needs to know how they were produced. Branches on the
 * variant's own expectation flags rather than assuming "should always match," since chaos's
 * correct behavior differs by category (missing_correlation_key's own correct outcome is NO
 * instance_start; duplicate_correlation's is exactly two).
 */
export function evaluateContractChaosOutcome(variant: ContractChaosVariant, extractedEntries: ProofLedgerEntry[]): { matched: boolean; mismatches: string[] } {
  const expectedHash = hashCorrelationKeyValue(variant.correlationKeyValue)
  const matchingStarts = extractedEntries.filter(e => e.kind === 'instance_start' && e.promiseInstanceId === expectedHash)

  if (variant.expectNoInstanceStart) {
    if (matchingStarts.length === 0) return { matched: true, mismatches: [] }
    return {
      matched: false,
      mismatches: [`Expected no instance_start to be attributed to correlation key "${variant.correlationKeyValue}" (its own field was missing from the payload), but ${matchingStarts.length} were recorded anyway -- the intake workflow may be fabricating attribution from something other than the contract's own correlation key field.`],
    }
  }

  if (variant.injectTwice) {
    if (matchingStarts.length === 2) return { matched: true, mismatches: [] }
    return {
      matched: false,
      mismatches: [`Expected exactly 2 instance_start entries under correlation key "${variant.correlationKeyValue}" (one per injection), found ${matchingStarts.length}.`],
    }
  }

  if (matchingStarts.length === 0) {
    return { matched: false, mismatches: [`No instance_start entry was extracted for correlation key "${variant.correlationKeyValue}".`] }
  }
  const start = matchingStarts[0]!
  if (variant.expectedInitialState && start.initialState !== variant.expectedInitialState) {
    return { matched: false, mismatches: [`instance_start recorded initialState "${start.initialState}", expected "${variant.expectedInitialState}".`] }
  }
  return { matched: true, mismatches: [] }
}

export type ContractChaosOutcomeStatus = 'checked' | 'no_execution_found'

export interface ContractChaosOutcome {
  variantName: string
  category: ContractChaosCategory
  rationale: string
  status: ContractChaosOutcomeStatus
  scenarioId: string
  detail: string
  /** Real evidence extracted from the real sandbox execution(s) via extractExecutionEvidence()
   * -- the exact same function the production ProofLedger poller uses. For duplicate_correlation
   * this includes entries from BOTH injections. Present only when status === 'checked'. */
  actualEntries?: ProofLedgerEntry[]
  businessOutcomeMatched?: boolean
  businessOutcomeMismatches: string[]
  /** Reuses sandbox-run.ts's own crash-classification unchanged, diffing this variant's
   * execution against the happy_path variant's own execution as reference -- the same
   * "valid-baseline reference" convention the existing structural chaos run already uses.
   * Present only when a happy_path reference execution exists and this variant itself produced
   * one (never present on the happy_path outcome itself, since it IS the reference). */
  crashClassification?: ChaosPayloadClassification
  scopeCaveat: string
}

export type ContractChaosRunStatus = 'completed' | 'not_webhook_shaped' | 'no_contract_scenarios'

export interface ContractChaosRunResult {
  status: ContractChaosRunStatus
  detail: string
  importedWorkflowName?: string
  outcomes: ContractChaosOutcome[]
  skipped: ContractChaosSkip[]
}

function toCapturedPayload(variant: ContractChaosVariant, body: unknown, suffix: string): CapturedPayload {
  return {
    executionId: `chaos-contract:${variant.name}:${suffix}`,
    capturedAt: new Date().toISOString(),
    triggerNodeName: '(synthetic -- from ContractChaosVariant, never a real capture)',
    payload: { body },
    scrubbed: false,
  }
}

/**
 * Imports ONE workflow into the sandbox, injects every contract-derived chaos variant against
 * it (happy_path first, always, so its execution is available as the crash-classification
 * reference for every other variant), and reports both the business-outcome match and the
 * crash classification per variant. Always cleans up the imported workflow (`finally`), same
 * guardrail every sandbox-owning function in this arc already follows.
 */
export async function runContractChaos(
  sandboxConfig: SandboxConfig,
  workflow: N8nWorkflow,
  contract: ProcessContract,
  startCondition: StartCondition,
  options: ReplayRunOptions = {},
  /** Bypasses generateContractChaosVariants() with an explicit variant list -- exposed the same
   * way checkScenarioIntakeOutcome() takes its scenario explicitly (Phase 7), so a live
   * checkpoint can prove a genuine mismatch (a deliberately wrong expectation, checked against
   * REAL extracted sandbox evidence) without needing a fixture contract that's actually broken.
   * Never used by the CLI, which always lets the contract itself decide. */
  variantsOverride?: ContractChaosVariant[],
): Promise<ContractChaosRunResult> {
  assertNotProduction(sandboxConfig.baseUrl)
  const resolvedOptions = resolveReplayRunOptions(options)

  const trigger = findWebhookTrigger(workflow)
  if (!trigger) {
    return {
      status: 'not_webhook_shaped',
      detail: 'This workflow has no webhook trigger -- contract-derived chaos only supports webhook-triggered workflows today, the same constraint kairos chaos run and kairos replay run already have.',
      outcomes: [],
      skipped: [],
    }
  }

  const { variants, skipped } = variantsOverride ? { variants: variantsOverride, skipped: [] as ContractChaosSkip[] } : generateContractChaosVariants(contract)
  if (variants.length === 0) {
    return {
      status: 'no_contract_scenarios',
      detail: 'The Contract Scenario Generator could not produce any chaos-eligible scenario for this contract (see "skipped" for why).',
      outcomes: [],
      skipped,
    }
  }
  // happy_path always processed first, regardless of generation order, since its own execution
  // is the reference every other variant's crash-classification is diffed against.
  const orderedVariants = [...variants].sort((a, b) => (a.category === 'happy_path' ? -1 : b.category === 'happy_path' ? 1 : 0))

  const client = new N8nApiClient(sandboxConfig.baseUrl, sandboxConfig.apiKey, nullLogger)
  let imported: SandboxImportResult | undefined
  const outcomes: ContractChaosOutcome[] = []
  let referenceSnapshot: import('../replay/diff.js').ReplayExecutionSnapshot | undefined

  try {
    imported = await importToSandbox(sandboxConfig, workflow, `chaos-contract: ${workflow.name ?? 'workflow'}`)
    await client.activateWorkflow(imported.id)
    const injectionTrigger = imported.webhookTrigger ?? trigger

    for (const variant of orderedVariants) {
      const injections = variant.injectTwice ? [variant.body, variant.body] : [variant.body]
      const entries: ProofLedgerEntry[] = []
      let firstSnapshot: import('../replay/diff.js').ReplayExecutionSnapshot | undefined
      let anyFound = false

      for (let i = 0; i < injections.length; i++) {
        const outcome = await replayOnePayload(client, sandboxConfig, imported.id, injectionTrigger, toCapturedPayload(variant, injections[i], String(i)), resolvedOptions)
        if (outcome.status !== 'found') continue
        anyFound = true
        if (!firstSnapshot) firstSnapshot = outcome.snapshot
        const { entries: extracted } = extractExecutionEvidence(contract, outcome.rawExecution!, imported.id, startCondition)
        entries.push(...extracted)
      }

      if (!anyFound) {
        outcomes.push({
          variantName: variant.name,
          category: variant.category,
          rationale: variant.rationale,
          status: 'no_execution_found',
          scenarioId: variant.scenarioId,
          detail: `No fresh execution appeared within ${resolvedOptions.pollTimeoutMs}ms for this variant. Treated as unverified, not as a pass.`,
          businessOutcomeMismatches: [],
          scopeCaveat: SCOPE_CAVEAT,
        })
        continue
      }

      if (variant.category === 'happy_path') referenceSnapshot = firstSnapshot

      const { matched, mismatches } = evaluateContractChaosOutcome(variant, entries)

      let crashClassification: ChaosPayloadClassification | undefined
      if (variant.category !== 'happy_path' && referenceSnapshot && firstSnapshot) {
        const diff = diffPayloadExecution(variant.name, workflow, workflow, referenceSnapshot, firstSnapshot)
        crashClassification = classifyChaosPayloadDiff(diff)
      }

      outcomes.push({
        variantName: variant.name,
        category: variant.category,
        rationale: variant.rationale,
        status: 'checked',
        scenarioId: variant.scenarioId,
        detail: matched ? 'Real sandbox execution matched the contract-derived expected outcome.' : 'Real sandbox execution did NOT match the contract-derived expected outcome.',
        actualEntries: entries,
        businessOutcomeMatched: matched,
        businessOutcomeMismatches: mismatches,
        ...(crashClassification ? { crashClassification } : {}),
        scopeCaveat: SCOPE_CAVEAT,
      })
    }
  } finally {
    if (imported) await client.deleteWorkflow(imported.id).catch(() => {})
  }

  return {
    status: 'completed',
    detail: `Ran ${orderedVariants.length} contract-derived chaos variant(s).`,
    importedWorkflowName: imported?.name,
    outcomes,
    skipped,
  }
}

/** Rendered-text formatter -- the structured ContractChaosRunResult above is the source of
 * truth (available via --json); this is a separate, later step, matching sandbox-run.ts's own
 * formatChaosSandboxRunResult() convention. */
export function formatContractChaosRunResult(result: ContractChaosRunResult, workflowId: string): string {
  const lines: string[] = []
  lines.push(`Contract-derived chaos run — ${workflowId}`)
  lines.push('─'.repeat(50))

  if (result.status !== 'completed') {
    lines.push(result.detail)
    return lines.join('\n')
  }

  for (const outcome of result.outcomes) {
    if (outcome.status === 'no_execution_found') {
      lines.push(`  [INCOMPLETE] ${outcome.category} (${outcome.variantName}) — ${outcome.detail}`)
      continue
    }
    const icon = outcome.businessOutcomeMatched ? '✓' : '✗'
    const crash = outcome.crashClassification ? `, crash-classification: ${outcome.crashClassification}` : ''
    lines.push(`  [${icon}] ${outcome.category} (${outcome.variantName}) — ${outcome.businessOutcomeMatched ? 'matched' : 'MISMATCH'}${crash}`)
    lines.push(`      ${outcome.detail}`)
    for (const m of outcome.businessOutcomeMismatches) lines.push(`      MISMATCH: ${m}`)
  }

  if (result.skipped.length > 0) {
    lines.push('')
    lines.push('Not attempted (see reasons):')
    for (const s of result.skipped) lines.push(`  - ${s.category}: ${s.reason}`)
  }

  lines.push('')
  lines.push(`Scope: ${SCOPE_CAVEAT}`)

  return lines.join('\n')
}
