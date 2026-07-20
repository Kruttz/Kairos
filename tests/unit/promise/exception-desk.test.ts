import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkSlaCompliance } from '../../../src/promise/sla-compliance.js'
import { updateExceptionDesk, applyHumanStatusChange } from '../../../src/promise/exception-desk.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'
import type { ExceptionDeskItem } from '../../../src/promise/exception-types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

const INSTANCE = 'instance-hash-abc'
const MON_8AM = '2024-01-01T15:00:00.000Z'
const TUE_8AM = '2024-01-02T15:00:00.000Z' // 9 business hours later -- past the 4h SLA

function instanceStart(observedAt: string): ProofLedgerEntry {
  return {
    id: `start:${observedAt}`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: INSTANCE,
    correlationKeyValueHash: INSTANCE,
    kind: 'instance_start',
    initialState: 'received',
    observedAt,
    sourceWorkflowId: 'wf-intake',
    sourceExecutionId: `exec-${observedAt}`,
    status: 'observed',
    detail: 'instance started',
  }
}

function evidence(transitionId: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `evidence:${transitionId}:${observedAt}`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: INSTANCE,
    correlationKeyValueHash: INSTANCE,
    kind: 'evidence',
    transitionId,
    observedAt,
    sourceWorkflowId: 'wf-processing',
    sourceExecutionId: `exec-${observedAt}`,
    status: 'observed',
    detail: 'evidence',
  }
}

describe('updateExceptionDesk', () => {
  it('opens a missed_sla item for an absence-based (specific confidence) drifting SLA finding', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))

    const { opened, refreshed } = updateExceptionDesk(contract, findings, [], new Date(TUE_8AM))
    expect(refreshed).toEqual([])
    const item = opened.find(i => i.slaId === 'sla-first-contact')!
    expect(item.kind).toBe('missed_sla')
    expect(item.status).toBe('open')
    expect(item.contractId).toBe(contract.id)
    expect(item.promiseInstanceId).toBe(INSTANCE)
    // Empire Homecare declares exactly one ExceptionRule -- reused directly.
    expect(item.owner).toBe('on-call rep')
    expect(item.nextAction).toBe('Call the referral immediately and log the outcome.')
    expect(item.reason).toContain('SLA "sla-first-contact" missed')
    expect(item.history).toEqual([{ ts: item.detectedAt, from: null, to: 'open', actor: 'auto', reason: item.reason }])
  })

  it('opens an ambiguous_evidence item for a generic-confidence drifting SLA finding', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM), evidence('t-attempted-to-contacted', TUE_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))

    const { opened } = updateExceptionDesk(contract, findings, [], new Date(TUE_8AM))
    const item = opened.find(i => i.slaId === 'sla-first-contact')!
    expect(item.kind).toBe('ambiguous_evidence')
  })

  it('opens a stuck item for a drifting expiration-rule finding', () => {
    const contract = empireHomecare()
    contract.evidenceRequirements.push({ transitionId: 't-received-to-attempted', requiredFields: ['x'], description: 'entry' })
    const entries = [instanceStart(MON_8AM), evidence('t-received-to-attempted', MON_8AM)]
    const farLater = new Date('2024-01-04T18:00:00.000Z')
    const findings = checkSlaCompliance(contract, entries, farLater)

    const { opened } = updateExceptionDesk(contract, findings, [], farLater)
    const item = opened.find(i => i.expirationRuleId === 'exp-no-answer')!
    expect(item.kind).toBe('stuck')
    expect(item.evidence.some(e => e.includes('expiresTo=no_answer'))).toBe(true)
  })

  it('never opens anything for insufficient_data, not_applicable, or healthy findings', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    // Well within the SLA window -- insufficient_data.
    const findings = checkSlaCompliance(contract, entries, new Date('2024-01-01T17:30:00.000Z'))
    expect(findings.every(f => f.status !== 'drifting')).toBe(true)

    const { opened, refreshed } = updateExceptionDesk(contract, findings, [])
    expect(opened).toEqual([])
    expect(refreshed).toEqual([])
  })

  it('refreshes (not duplicates) an existing open item when the same finding still applies', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))
    const first = updateExceptionDesk(contract, findings, [], new Date(TUE_8AM))
    const originalItem = first.opened.find(i => i.slaId === 'sla-first-contact')!

    const evenLater = new Date('2024-01-03T15:00:00.000Z')
    const laterFindings = checkSlaCompliance(contract, entries, evenLater)
    const second = updateExceptionDesk(contract, laterFindings, [originalItem], evenLater)

    expect(second.opened).toEqual([])
    const refreshedItem = second.refreshed.find(i => i.slaId === 'sla-first-contact')!
    expect(refreshedItem.id).toBe(originalItem.id)
    expect(refreshedItem.status).toBe('open') // untouched by a refresh
    expect(refreshedItem.history).toEqual(originalItem.history) // history untouched by a refresh
    expect(refreshedItem.updatedAt).toBe(evenLater.toISOString())
  })

  it('never reopens an item a human has already resolved', () => {
    const contract = empireHomecare()
    const entries = [instanceStart(MON_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))
    const opened = updateExceptionDesk(contract, findings, [], new Date(TUE_8AM)).opened[0]!
    const resolved = applyHumanStatusChange(opened, 'resolved', new Date(TUE_8AM), 'Called and scheduled.')

    const stillDrifting = checkSlaCompliance(contract, entries, new Date('2024-01-05T15:00:00.000Z'))
    const { opened: reOpened, refreshed } = updateExceptionDesk(contract, stillDrifting, [resolved], new Date('2024-01-05T15:00:00.000Z'))
    expect(reOpened).toEqual([])
    expect(refreshed).toEqual([])
  })

  it('falls back to a neutral, finding-derived nextAction when the contract declares more than one ExceptionRule (no guessing which applies)', () => {
    const contract = empireHomecare()
    contract.exceptions.push({ id: 'exc-2', condition: 'Some other condition', owner: 'someone else', suggestedAction: 'Do something else.' })
    const entries = [instanceStart(MON_8AM)]
    const findings = checkSlaCompliance(contract, entries, new Date(TUE_8AM))

    const { opened } = updateExceptionDesk(contract, findings, [], new Date(TUE_8AM))
    const item = opened.find(i => i.slaId === 'sla-first-contact')!
    expect(item.nextAction).not.toBe('Call the referral immediately and log the outcome.')
    expect(item.nextAction).not.toBe('Do something else.')
    expect(item.nextAction).toContain('contact_attempted')
    // Owner still comes from the direct OwnerAssignment lookup, unaffected by the ambiguity.
    expect(item.owner).toBe('on-call rep')
  })
})

describe('applyHumanStatusChange', () => {
  function makeItem(overrides: Partial<ExceptionDeskItem> = {}): ExceptionDeskItem {
    return {
      id: 'item-1',
      contractId: 'c1',
      promiseInstanceId: 'p1',
      kind: 'missed_sla',
      status: 'open',
      owner: 'intake coordinator',
      nextAction: 'Call.',
      reason: 'SLA missed.',
      evidence: [],
      slaId: 'sla-first-contact',
      detectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      history: [{ ts: '2026-01-01T00:00:00.000Z', from: null, to: 'open', actor: 'auto' }],
      ...overrides,
    }
  }

  it('transitions status and appends a human-actor history entry, preserving prior history', () => {
    const item = makeItem()
    const now = new Date('2026-01-02T00:00:00.000Z')
    const updated = applyHumanStatusChange(item, 'acknowledged', now, 'Looking into it')

    expect(updated.status).toBe('acknowledged')
    expect(updated.updatedAt).toBe(now.toISOString())
    expect(updated.history).toEqual([
      item.history[0],
      { ts: now.toISOString(), from: 'open', to: 'acknowledged', actor: 'human', reason: 'Looking into it' },
    ])
  })

  it('never mutates the original item', () => {
    const item = makeItem()
    const originalHistoryLength = item.history.length
    applyHumanStatusChange(item, 'resolved', new Date())
    expect(item.status).toBe('open')
    expect(item.history).toHaveLength(originalHistoryLength)
  })
})
