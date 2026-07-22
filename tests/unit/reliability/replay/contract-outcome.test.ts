import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateScenarioIntakeOutcome, checkScenarioIntakeOutcome, scenarioIntakePayloadBody } from '../../../../src/reliability/replay/contract-outcome.js'
import { generateContractScenarios } from '../../../../src/promise/scenario.js'
import { hashCorrelationKeyValue } from '../../../../src/promise/ledger.js'
import type { ProcessContract } from '../../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../../src/promise/ledger-types.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'
import type { SandboxConfig } from '../../../../src/reliability/sandbox/manager.js'

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contracts')

function loadFixture(name: string): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ProcessContract
}

function makeSandboxConfig(): SandboxConfig {
  return { baseUrl: 'http://localhost:15679', apiKey: 'x', isKairosSandbox: true, n8nVersion: '2.30.7', provisionedAt: new Date().toISOString() }
}

function makeInstanceStartEntry(contract: ProcessContract, correlationKeyValue: string, initialState: string): ProofLedgerEntry {
  const promiseInstanceId = hashCorrelationKeyValue(correlationKeyValue)
  return {
    id: 'exec-1:instance_start',
    contractId: contract.id,
    contractVersion: contract.version,
    promiseInstanceId,
    correlationKeyValueHash: promiseInstanceId,
    kind: 'instance_start',
    initialState,
    observedAt: new Date().toISOString(),
    sourceWorkflowId: 'sandbox-wf-1',
    sourceExecutionId: 'exec-1',
    status: 'observed',
    detail: 'instance started',
  }
}

describe('scenarioIntakePayloadBody -- P0 REGRESSION GUARD: a real live-checkpoint-caught bug (2026-07-21)', () => {
  // The first version of this function set the correlation key at the FULL fieldPath
  // ("body.email") directly on the raw HTTP payload sent to the webhook -- but n8n's webhook
  // trigger automatically wraps whatever raw JSON is POSTed under its own output's `.body` key,
  // so the real trigger output ended up with the key at body.body.email, not body.email, and a
  // real live sandbox run genuinely extracted zero entries. Confirmed directly against a real
  // n8n execution's runData (Phase 7 live checkpoint) before this was understood as a bug, not
  // a limitation. This test locks the fix in permanently.
  const contract = loadFixture('website-contact-form-ack.json') // correlationKey.fieldPath: "body.email"

  it('strips the "body." prefix so the raw payload, once wrapped by n8n, lands at the exact fieldPath', () => {
    const scenario = generateContractScenarios(contract, ['happy_path']).scenarios[0]!
    const body = scenarioIntakePayloadBody(contract, scenario)
    // The raw payload itself must be {email: <value>} -- NOT {body: {email: <value>}}, which is
    // exactly the double-nesting bug this test guards against.
    expect(body).toEqual({ email: scenario.correlationKeyValue })
  })

  it('supports a nested field path within the body (e.g. "body.customer.email")', () => {
    const nestedContract: ProcessContract = { ...contract, correlationKey: { fieldPath: 'body.customer.email', description: 'nested' } }
    const scenario = generateContractScenarios(nestedContract, ['happy_path']).scenarios[0]!
    const body = scenarioIntakePayloadBody(nestedContract, scenario)
    expect(body).toEqual({ customer: { email: scenario.correlationKeyValue } })
  })

  it('falls back to the literal fieldPath for a non-"body."-prefixed correlation key (a named, honest v0 limitation, not silently guessed at)', () => {
    const headerContract: ProcessContract = { ...contract, correlationKey: { fieldPath: 'headers.x-customer-id', description: 'header-sourced' } }
    const scenario = generateContractScenarios(headerContract, ['happy_path']).scenarios[0]!
    const body = scenarioIntakePayloadBody(headerContract, scenario)
    // Not wrong exactly, but not "correctly wired for headers" either -- documents the real
    // current behavior for this unsupported case rather than asserting an unverified fix.
    expect(body).toEqual({ headers: { 'x-customer-id': scenario.correlationKeyValue } })
  })
})

describe('evaluateScenarioIntakeOutcome -- pure comparison, no I/O (passing scenario)', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const { scenarios } = generateContractScenarios(contract, ['happy_path'])
  const scenario = scenarios[0]!

  it('matches when a real instance_start entry with the right correlation key AND initial state was extracted', () => {
    const entries = [makeInstanceStartEntry(contract, scenario.correlationKeyValue, 'received')]
    const result = evaluateScenarioIntakeOutcome(scenario, entries)
    expect(result.matched).toBe(true)
    expect(result.mismatches).toEqual([])
    expect(result.matchingStart).toBeDefined()
  })

  it('ignores an instance_start entry for a DIFFERENT correlation key -- proving the match is genuinely keyed, not just "any instance_start exists"', () => {
    const entries = [makeInstanceStartEntry(contract, 'someone-else@kairos-scenario.test', 'received')]
    const result = evaluateScenarioIntakeOutcome(scenario, entries)
    expect(result.matched).toBe(false)
    expect(result.matchingStart).toBeUndefined()
  })
})

describe('evaluateScenarioIntakeOutcome -- pure comparison, no I/O (mismatch scenarios)', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const { scenarios } = generateContractScenarios(contract, ['happy_path'])
  const scenario = scenarios[0]!

  it('reports a mismatch when the real execution produced NO instance_start entry at all', () => {
    const result = evaluateScenarioIntakeOutcome(scenario, [])
    expect(result.matched).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toContain('No instance_start entry was extracted')
  })

  it('reports a mismatch when the real instance_start entry recorded the WRONG initialState -- the exact "workflow ran green but was wrong" class of bug this phase exists to catch', () => {
    // Same correlation key (so it IS attributed to the right instance), but the real workflow
    // put it in the wrong state -- e.g. a branch mis-wired during generation.
    const entries = [makeInstanceStartEntry(contract, scenario.correlationKeyValue, 'wrong_state')]
    const result = evaluateScenarioIntakeOutcome(scenario, entries)
    expect(result.matched).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toContain('initialState')
    expect(result.mismatches[0]).toContain('wrong_state')
    expect(result.mismatches[0]).toContain('received')
  })

  it('ignores an evidence-kind entry (not instance_start) even if it happens to share the correlation key hash', () => {
    const promiseInstanceId = hashCorrelationKeyValue(scenario.correlationKeyValue)
    const evidenceEntry: ProofLedgerEntry = {
      id: 'exec-1:t-received-to-acknowledged',
      contractId: contract.id,
      contractVersion: contract.version,
      promiseInstanceId,
      correlationKeyValueHash: promiseInstanceId,
      kind: 'evidence',
      transitionId: 't-received-to-acknowledged',
      observedAt: new Date().toISOString(),
      sourceWorkflowId: 'sandbox-wf-1',
      sourceExecutionId: 'exec-1',
      status: 'observed',
      detail: 'evidence',
    }
    const result = evaluateScenarioIntakeOutcome(scenario, [evidenceEntry])
    expect(result.matched).toBe(false)
  })
})

describe('checkScenarioIntakeOutcome -- not_webhook_shaped is testable without any network I/O', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const { scenarios } = generateContractScenarios(contract, ['happy_path'])
  const scenario = scenarios[0]!
  const startCondition = contract.startConditions[0]!

  it('returns not_webhook_shaped immediately for a workflow with no webhook trigger node, before any sandbox/network call', async () => {
    const nonWebhookWorkflow: N8nWorkflow = {
      name: 'Not Webhook Triggered',
      nodes: [{ id: 'n1', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    }
    const result = await checkScenarioIntakeOutcome(makeSandboxConfig(), nonWebhookWorkflow, contract, startCondition, scenario)
    expect(result.status).toBe('not_webhook_shaped')
    expect(result.mismatches).toEqual([])
    expect(result.scopeCaveat.length).toBeGreaterThan(0)
  })
})
