import { extractExecutionEvidence, hashCorrelationKeyValue } from '../../promise/ledger.js'
import { findWebhookTrigger } from '../../utils/webhook-verify.js'
import { nullLogger } from '../../utils/logger.js'
import { N8nApiClient } from '../../providers/n8n/api-client.js'
import { assertNotProduction, importToSandbox, type SandboxConfig } from '../sandbox/manager.js'
import { replayOnePayload, resolveReplayRunOptions, type ReplayRunOptions } from './runner.js'
import type { CapturedPayload } from './capture.js'
import type { ProcessContract, StartCondition } from '../../promise/types.js'
import type { ContractScenario } from '../../promise/scenario-types.js'
import type { ProofLedgerEntry } from '../../promise/ledger-types.js'
import type { N8nWorkflow } from '../../types/workflow.js'

/**
 * Replay Upgrade: expected business outcomes (roadmap item 7, docs/plans/
 * intake-scenario-harness-plan.md §7). Extends the existing sandbox-replay machinery so a
 * `ContractScenario` (roadmap item 5) can be replayed for real and its resulting evidence
 * checked against what the contract says should have happened -- not only "did candidate
 * behave like baseline" (diff.ts's own job, completely unchanged by this module).
 *
 * **A real architectural constraint found while designing this, not assumed**: `compile.ts`
 * always splits a contract into separate workflows (an intake workflow, a processing workflow,
 * an SLA-escalation workflow) -- confirmed directly against compile.ts. A single sandbox
 * execution against ONE workflow's own webhook can only ever produce the evidence THAT
 * workflow's own execution generates. For the intake workflow specifically, that is exactly
 * one thing: an `instance_start` entry (ledger.ts's own extractExecutionEvidence(), given a
 * StartCondition, records this automatically -- no marker node needed, since an intake
 * workflow's own trigger firing IS the signal). State-transition evidence (an EvidenceRequirement
 * marker node) normally lives in the SEPARATE processing workflow, which compile.ts's own prose
 * deliberately leaves free to use a non-webhook trigger (a Sheets row, a call log, anything) --
 * meaning it may not even be replay-eligible via findWebhookTrigger()'s existing webhook-only
 * gate at all.
 *
 * **The scope this constraint implies, stated explicitly rather than overclaimed**: this module
 * checks ONE thing, for real, against a real sandbox execution -- does replaying a scenario's
 * own correlation-key-bearing intake payload against the REGISTERED INTAKE WORKFLOW produce a
 * real `instance_start` ProofLedgerEntry with the right initial state and correlation key.
 * Every one of the 7 v0 scenario categories starts with exactly one `instance_start` timeline
 * event, so this check applies universally. It does NOT attempt to validate a scenario's full
 * `expected` classification (which assumes evidence from the processing workflow too, evidence
 * this replay never touches) -- `scopeCaveat` on the result says so plainly, every time, never
 * omitted. This is evidence-graded validation of the intake moment specifically, not a semantic
 * proof the whole business promise was kept end to end.
 */

const SCOPE_CAVEAT =
  'This check replays only the scenario\'s own intake payload against the registered intake workflow -- it can only verify the instance_start evidence that single execution produces. It does NOT verify state-transition evidence (normally produced by a separate, differently-triggered processing workflow) or the scenario\'s own full expected classification, which assumes that evidence exists too. Evidence-graded validation of the intake moment only, not a semantic proof the whole business promise was kept.'

export type ContractOutcomeCheckStatus = 'checked' | 'not_webhook_shaped' | 'no_execution_found'

export interface ContractOutcomeCheckResult {
  scenarioId: string
  scenarioName: string
  status: ContractOutcomeCheckStatus
  detail: string
  expectedInitialState?: string
  expectedCorrelationKeyValue?: string
  /** Real evidence extracted from the real sandbox execution via extractExecutionEvidence() --
   * the exact same function the production ProofLedger poller uses. Present only when
   * status === 'checked'. Never persisted anywhere. */
  actualEntries?: ProofLedgerEntry[]
  matched?: boolean
  mismatches: string[]
  scopeCaveat: string
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]!] = value
}

/** Builds the RAW HTTP payload to POST at the intake workflow's webhook, so its own trigger
 * output ends up with the scenario's correlationKeyValue at exactly `contract.correlationKey
 * .fieldPath`. A real, live-checkpoint-caught bug in this function's first version (2026-07-21):
 * `correlationKey.fieldPath` (e.g. "body.email") is documented (types.ts) as a path INTO the
 * trigger node's own output json -- but n8n's webhook trigger automatically wraps whatever raw
 * JSON is POSTed under its own output's `.body` key (confirmed directly against a real sandbox
 * execution's runData, Phase 7 live checkpoint). Setting the FULL fieldPath directly on the raw
 * payload put the correlation key at output.body.body.email instead of output.body.email --
 * the real execution's trigger output then genuinely had no `body.email` field at all, and
 * extractExecutionEvidence() correctly (and honestly) reported zero entries, not a false match.
 * Fixed by stripping the "body." prefix before constructing the raw payload. `query.`/`headers.`-
 * prefixed correlation keys are a real, named, deliberately-unhandled limitation of this v0 --
 * every checked-in fixture's correlationKey.fieldPath is body-prefixed, and query/header-sourced
 * correlation keys are a materially rarer real-world shape; falls back to the literal fieldPath
 * for that case rather than silently guessing at a different wrapping convention. */
export function scenarioIntakePayloadBody(contract: ProcessContract, scenario: ContractScenario): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const fieldPath = contract.correlationKey.fieldPath
  const bodyPrefix = 'body.'
  const pathWithinRawBody = fieldPath.startsWith(bodyPrefix) ? fieldPath.slice(bodyPrefix.length) : fieldPath
  setPath(body, pathWithinRawBody, scenario.correlationKeyValue)
  return body
}

function expectedInitialStateFor(scenario: ContractScenario): string | undefined {
  return scenario.timeline.find(e => e.kind === 'instance_start')?.initialState
}

/**
 * The actual comparison this whole module exists to make -- pulled out as its own pure,
 * directly-testable function (no sandbox, no network, no extraction) so "a passing scenario and
 * a mismatch scenario" (the explicit test requirement for this phase) can be proven
 * deterministically, the same "orchestrator validated live, sub-pieces validated by unit test"
 * split this file's own sibling runner.ts already established for replayOnePayload/runReplay.
 * Takes already-extracted entries (real, from extractExecutionEvidence(), or hand-built for a
 * test) rather than raw execution data, so it never needs to know how they were produced.
 */
export function evaluateScenarioIntakeOutcome(scenario: ContractScenario, extractedEntries: ProofLedgerEntry[]): { matched: boolean; mismatches: string[]; matchingStart?: ProofLedgerEntry } {
  const expectedInitialState = expectedInitialStateFor(scenario)
  const expectedHash = hashCorrelationKeyValue(scenario.correlationKeyValue)
  const matchingStart = extractedEntries.find(e => e.kind === 'instance_start' && e.promiseInstanceId === expectedHash)

  const mismatches: string[] = []
  if (!matchingStart) {
    mismatches.push(`No instance_start entry was extracted for correlation key "${scenario.correlationKeyValue}" -- the intake workflow either did not pass the correlation key field through to its own trigger output, or something else prevented attribution.`)
  } else if (expectedInitialState && matchingStart.initialState !== expectedInitialState) {
    mismatches.push(`instance_start recorded initialState "${matchingStart.initialState}", expected "${expectedInitialState}".`)
  }

  return { matched: mismatches.length === 0, mismatches, ...(matchingStart ? { matchingStart } : {}) }
}

/**
 * Replays one scenario's intake payload against one registered (already-deployed) workflow's
 * candidate JSON, imported into the sandbox for this call and always cleaned up afterward.
 * `startCondition` should be the one this workflow's own ContractWorkflowTrace names (the same
 * lookup ledger.ts's own pollWorkflowEvidence()/findStartCondition() already performs against a
 * real registration) -- passed in explicitly rather than re-derived here, since this module has
 * no reason to import registry.ts for a single string lookup the caller (cli.ts) already has
 * cheaply in hand.
 */
export async function checkScenarioIntakeOutcome(
  sandboxConfig: SandboxConfig,
  candidateWorkflow: N8nWorkflow,
  contract: ProcessContract,
  startCondition: StartCondition,
  scenario: ContractScenario,
  options: ReplayRunOptions = {},
): Promise<ContractOutcomeCheckResult> {
  assertNotProduction(sandboxConfig.baseUrl)
  const resolvedOptions = resolveReplayRunOptions(options)

  const trigger = findWebhookTrigger(candidateWorkflow)
  if (!trigger) {
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      status: 'not_webhook_shaped',
      detail: 'This workflow has no webhook trigger -- contract-outcome replay only supports webhook-triggered workflows today, the same constraint kairos replay run already has for structural diffing.',
      mismatches: [],
      scopeCaveat: SCOPE_CAVEAT,
    }
  }

  const expectedInitialState = expectedInitialStateFor(scenario)
  const client = new N8nApiClient(sandboxConfig.baseUrl, sandboxConfig.apiKey, nullLogger)

  let imported: { id: string; webhookTrigger?: { path: string; httpMethod: string } } | undefined
  try {
    imported = await importToSandbox(sandboxConfig, candidateWorkflow, `contract-outcome: ${candidateWorkflow.name ?? 'workflow'}`)
    await client.activateWorkflow(imported.id)
    const injectionTrigger = imported.webhookTrigger ?? trigger

    const syntheticCapture: CapturedPayload = {
      executionId: `scenario:${scenario.id}`,
      capturedAt: new Date().toISOString(),
      triggerNodeName: '(synthetic -- from ContractScenario, never a real capture)',
      payload: { body: scenarioIntakePayloadBody(contract, scenario) },
      scrubbed: false,
    }

    const outcome = await replayOnePayload(client, sandboxConfig, imported.id, injectionTrigger, syntheticCapture, resolvedOptions)

    if (outcome.status !== 'found') {
      return {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        status: 'no_execution_found',
        detail: `No fresh execution appeared within ${resolvedOptions.pollTimeoutMs}ms after injecting the scenario's intake payload. Treated as unverified, not as a pass.`,
        ...(expectedInitialState ? { expectedInitialState } : {}),
        expectedCorrelationKeyValue: scenario.correlationKeyValue,
        mismatches: [],
        scopeCaveat: SCOPE_CAVEAT,
      }
    }

    const { entries } = extractExecutionEvidence(contract, outcome.rawExecution!, imported.id, startCondition)
    const { matched, mismatches, matchingStart } = evaluateScenarioIntakeOutcome(scenario, entries)

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      status: 'checked',
      detail: matchingStart ? 'Real sandbox execution produced a matching instance_start entry.' : 'Real sandbox execution did not produce the expected instance_start entry.',
      ...(expectedInitialState ? { expectedInitialState } : {}),
      expectedCorrelationKeyValue: scenario.correlationKeyValue,
      actualEntries: entries,
      matched,
      mismatches,
      scopeCaveat: SCOPE_CAVEAT,
    }
  } finally {
    if (imported) await client.deleteWorkflow(imported.id).catch(() => {})
  }
}
