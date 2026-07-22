import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateContractChaosVariants, evaluateContractChaosOutcome, runContractChaos, type ContractChaosVariant } from '../../../../src/reliability/chaos/contract-outcome.js'
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

function makeInstanceStartEntry(correlationKeyValue: string, initialState: string, idSuffix = ''): ProofLedgerEntry {
  const promiseInstanceId = hashCorrelationKeyValue(correlationKeyValue)
  return {
    id: `exec-1${idSuffix}:instance_start`,
    contractId: 'x',
    contractVersion: 1,
    promiseInstanceId,
    correlationKeyValueHash: promiseInstanceId,
    kind: 'instance_start',
    initialState,
    observedAt: new Date().toISOString(),
    sourceWorkflowId: 'sandbox-wf-1',
    sourceExecutionId: `exec-1${idSuffix}`,
    status: 'observed',
    detail: 'instance started',
  }
}

describe('generateContractChaosVariants -- website-contact-form-ack (primary fixture, evidence-complete)', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const { variants, skipped } = generateContractChaosVariants(contract)

  it('produces exactly the 3 intake-testable categories: happy_path, missing_correlation_key, duplicate_correlation', () => {
    expect(variants.map(v => v.category).sort()).toEqual(['duplicate_correlation', 'happy_path', 'missing_correlation_key'])
  })

  it('honestly reports the 4 categories chaos cannot attempt, with a reason for each', () => {
    expect(skipped.map(s => s.category).sort()).toEqual(['after_hours', 'failure_terminal', 'in_progress', 'no_response'])
    for (const s of skipped) expect(s.reason.length).toBeGreaterThan(0)
  })

  it('happy_path carries a complete payload with the real correlation key field present', () => {
    const happy = variants.find(v => v.category === 'happy_path')!
    expect(happy.body).toHaveProperty('email')
    expect((happy.body as Record<string, unknown>)['email']).toBe(happy.correlationKeyValue)
    expect(happy.expectedInitialState).toBe('received')
    expect(happy.expectNoInstanceStart).toBeUndefined()
    expect(happy.injectTwice).toBeUndefined()
  })

  it('missing_correlation_key omits exactly the field the contract names as its correlation key, nothing else', () => {
    const missing = variants.find(v => v.category === 'missing_correlation_key')!
    expect(missing.body).not.toHaveProperty('email')
    expect(missing.expectNoInstanceStart).toBe(true)
    expect(missing.expectedInitialState).toBeUndefined()
  })

  it('duplicate_correlation is marked to inject twice, under one correlation key', () => {
    const dup = variants.find(v => v.category === 'duplicate_correlation')!
    expect(dup.injectTwice).toBe(true)
    expect(dup.expectNoInstanceStart).toBeUndefined()
  })

  it('every variant reuses the EXACT ChaosPayloadVariant shape (name/rationale/body) unchanged, so it composes with the existing chaos type', () => {
    for (const v of variants) {
      expect(typeof v.name).toBe('string')
      expect(typeof v.rationale).toBe('string')
      expect(v.body).toBeDefined()
    }
  })
})

describe('generateContractChaosVariants -- fixtures with no evidence-backed success terminal (Empire Homecare, SaaS)', () => {
  it('skips happy_path AND missing_correlation_key (which depends on it), but still generates duplicate_correlation', () => {
    for (const fixture of ['empire-homecare-referral-intake.json', 'saas-p1-incident-response.json']) {
      const contract = loadFixture(fixture)
      const { variants, skipped } = generateContractChaosVariants(contract)
      expect(variants.map(v => v.category)).toEqual(['duplicate_correlation'])
      expect(skipped.map(s => s.category).sort()).toEqual(['after_hours', 'failure_terminal', 'happy_path', 'in_progress', 'missing_correlation_key', 'no_response'])
    }
  })
})

describe('evaluateContractChaosOutcome -- pure comparison, no I/O', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const { variants } = generateContractChaosVariants(contract)
  const happy = variants.find(v => v.category === 'happy_path')!
  const missing = variants.find(v => v.category === 'missing_correlation_key')!
  const dup = variants.find(v => v.category === 'duplicate_correlation')!

  describe('happy_path: passing case', () => {
    it('matches when a real instance_start entry with the right correlation key AND initial state was extracted', () => {
      const entries = [makeInstanceStartEntry(happy.correlationKeyValue, 'received')]
      const result = evaluateContractChaosOutcome(happy, entries)
      expect(result.matched).toBe(true)
      expect(result.mismatches).toEqual([])
    })
  })

  describe('happy_path: mismatch cases -- the exact "workflow ran green but was wrong" class of bug this phase exists to catch', () => {
    it('reports a mismatch when no instance_start was extracted at all', () => {
      const result = evaluateContractChaosOutcome(happy, [])
      expect(result.matched).toBe(false)
      expect(result.mismatches[0]).toContain('No instance_start entry was extracted')
    })

    it('reports a mismatch when the recorded initialState is wrong', () => {
      const entries = [makeInstanceStartEntry(happy.correlationKeyValue, 'wrong_state')]
      const result = evaluateContractChaosOutcome(happy, entries)
      expect(result.matched).toBe(false)
      expect(result.mismatches[0]).toContain('wrong_state')
    })
  })

  describe('missing_correlation_key: expects NO instance_start -- the opposite of every other category\'s default expectation', () => {
    it('matches when the real sandbox execution correctly produced no attributable instance_start', () => {
      const result = evaluateContractChaosOutcome(missing, [])
      expect(result.matched).toBe(true)
      expect(result.mismatches).toEqual([])
    })

    it('reports a mismatch if the workflow somehow fabricated an instance_start anyway -- a real safety finding, not a false pass', () => {
      const entries = [makeInstanceStartEntry(missing.correlationKeyValue, 'received')]
      const result = evaluateContractChaosOutcome(missing, entries)
      expect(result.matched).toBe(false)
      expect(result.mismatches[0]).toContain('fabricating attribution')
    })

    it('an instance_start under a DIFFERENT correlation key does not count against this variant -- proving the check is genuinely keyed', () => {
      const entries = [makeInstanceStartEntry('someone-else@kairos-scenario.test', 'received')]
      const result = evaluateContractChaosOutcome(missing, entries)
      expect(result.matched).toBe(true)
    })
  })

  describe('duplicate_correlation: expects EXACTLY two instance_start entries under one key', () => {
    it('matches when both injections produced their own real instance_start entry', () => {
      const entries = [makeInstanceStartEntry(dup.correlationKeyValue, 'received', ':1'), makeInstanceStartEntry(dup.correlationKeyValue, 'received', ':2')]
      const result = evaluateContractChaosOutcome(dup, entries)
      expect(result.matched).toBe(true)
    })

    it('reports a mismatch if only one entry was recorded -- e.g. the intake workflow silently deduped a real duplicate submission', () => {
      const entries = [makeInstanceStartEntry(dup.correlationKeyValue, 'received')]
      const result = evaluateContractChaosOutcome(dup, entries)
      expect(result.matched).toBe(false)
      expect(result.mismatches[0]).toContain('found 1')
    })

    it('reports a mismatch if zero entries were recorded', () => {
      const result = evaluateContractChaosOutcome(dup, [])
      expect(result.matched).toBe(false)
      expect(result.mismatches[0]).toContain('found 0')
    })
  })
})

describe('runContractChaos -- not_webhook_shaped and no_contract_scenarios are testable without any network I/O', () => {
  const contract = loadFixture('website-contact-form-ack.json')
  const startCondition = contract.startConditions[0]!

  it('returns not_webhook_shaped immediately for a workflow with no webhook trigger, before any sandbox/network call', async () => {
    const nonWebhookWorkflow: N8nWorkflow = {
      name: 'Not Webhook Triggered',
      nodes: [{ id: 'n1', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    }
    const result = await runContractChaos(makeSandboxConfig(), nonWebhookWorkflow, contract, startCondition)
    expect(result.status).toBe('not_webhook_shaped')
    expect(result.outcomes).toEqual([])
  })

  it('returns no_contract_scenarios for a contract with no startConditions at all -- nothing to derive a payload from', async () => {
    const noStartConditionsContract: ProcessContract = { ...contract, startConditions: [] }
    const webhookWorkflow: N8nWorkflow = {
      name: 'Webhook Triggered',
      nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } }],
      connections: {},
    }
    const result = await runContractChaos(makeSandboxConfig(), webhookWorkflow, noStartConditionsContract, startCondition)
    expect(result.status).toBe('no_contract_scenarios')
    expect(result.outcomes).toEqual([])
  })
})

describe('ContractChaosVariant type -- a compile-time proof it extends ChaosPayloadVariant, not a parallel type', () => {
  it('is structurally assignable to {name, rationale, body}', () => {
    const contract = loadFixture('website-contact-form-ack.json')
    const { variants } = generateContractChaosVariants(contract)
    const v: ContractChaosVariant = variants[0]!
    const asPlain: { name: string; rationale: string; body: unknown } = v
    expect(asPlain.name).toBe(v.name)
  })
})
