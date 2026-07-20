import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyPromiseInstance, buildPromiseReportData, generatePromiseReport } from '../../../src/promise/report.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { ProofLedgerEntry } from '../../../src/promise/ledger-types.js'
import type { ExceptionDeskItem } from '../../../src/promise/exception-types.js'

const FIXTURES_DIR = join(__dirname, '../../fixtures/contracts')

function empireHomecare(): ProcessContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'empire-homecare-referral-intake.json'), 'utf-8')) as ProcessContract
}

const MON_8AM = '2024-01-01T15:00:00.000Z' // Mon 08:00 America/Denver
const MON_10AM = '2024-01-01T17:00:00.000Z' // 2 business hours later -- within the 4h SLA
const TUE_8AM = '2024-01-02T15:00:00.000Z' // 9 business hours later -- past the 4h SLA

function instanceStart(id: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:start`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: id,
    correlationKeyValueHash: id,
    kind: 'instance_start',
    initialState: 'received',
    observedAt,
    sourceWorkflowId: 'wf-intake',
    sourceExecutionId: `exec-${id}-start`,
    status: 'observed',
    detail: 'instance started',
  }
}

function evidence(id: string, transitionId: string, observedAt: string): ProofLedgerEntry {
  return {
    id: `${id}:${transitionId}:${observedAt}`,
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    promiseInstanceId: id,
    correlationKeyValueHash: id,
    kind: 'evidence',
    transitionId,
    observedAt,
    sourceWorkflowId: 'wf-processing',
    sourceExecutionId: `exec-${id}-${transitionId}`,
    status: 'observed',
    detail: 'evidence',
  }
}

function exceptionItem(id: string, overrides: Partial<ExceptionDeskItem> = {}): ExceptionDeskItem {
  return {
    id: `item-${id}`,
    contractId: 'empire-homecare-referral-intake',
    promiseInstanceId: id,
    kind: 'missed_sla',
    status: 'open',
    owner: 'on-call rep',
    nextAction: 'Call.',
    reason: 'SLA missed.',
    evidence: [],
    slaId: 'sla-first-contact',
    detectedAt: MON_10AM,
    updatedAt: MON_10AM,
    history: [{ ts: MON_10AM, from: null, to: 'open', actor: 'auto' }],
    ...overrides,
  }
}

describe('classifyPromiseInstance', () => {
  it('kept: reached a success terminal state via direct evidence, no drifting', () => {
    const contract = empireHomecare()
    const entries = [
      instanceStart('i1', MON_8AM),
      evidence('i1', 't-received-to-attempted', MON_10AM), // direct: toState contact_attempted
      evidence('i1', 't-attempted-to-contacted', MON_10AM), // direct: toState contacted
      evidence('i1', 't-contacted-to-scheduled', MON_10AM), // direct: toState scheduled (success terminal)
    ]
    const result = classifyPromiseInstance(contract, entries, [], new Date(MON_10AM))
    expect(result.status).toBe('kept')
    expect(result.evidenceQuality).toBe('specific')
  })

  it('kept: reached an acceptable terminal state (declined) -- the promise to attempt contact was still kept', () => {
    const contract = empireHomecare()
    const entries = [
      instanceStart('i1', MON_8AM),
      evidence('i1', 't-received-to-attempted', MON_10AM),
      evidence('i1', 't-attempted-to-contacted', MON_10AM),
      evidence('i1', 't-contacted-to-declined', MON_10AM), // direct: toState declined (acceptable terminal)
    ]
    const result = classifyPromiseInstance(contract, entries, [], new Date(MON_10AM))
    expect(result.status).toBe('kept')
  })

  it('missed: reached the failure terminal state (no_answer)', () => {
    const contract = empireHomecare()
    // no_answer is reached via ExpirationRule.expiresTo, not a ProcessTransition -- so
    // stateReachSignals (transition-based only) won't see it directly. Simulate reaching it via
    // a real evidence entry whose transition targets it directly, using a temporary added
    // transition/evidence requirement to keep this test's own setup self-contained and correct
    // regardless of the ExpirationRule mechanism (already covered by sla-compliance.test.ts).
    contract.transitions.push({ id: 't-attempted-to-noanswer', fromState: 'contact_attempted', event: 'call_no_answer', toState: 'no_answer' })
    const entries = [
      instanceStart('i1', MON_8AM),
      evidence('i1', 't-received-to-attempted', MON_10AM),
      evidence('i1', 't-attempted-to-noanswer', TUE_8AM),
    ]
    const result = classifyPromiseInstance(contract, entries, [], new Date(TUE_8AM))
    expect(result.status).toBe('missed')
  })

  it('missed: reached a success terminal, but a drifting SLA finding still applies -- drifting takes priority', () => {
    const contract = empireHomecare()
    const entries = [
      instanceStart('i1', MON_8AM),
      // Reaches contact_attempted only via this late (9h) indirect evidence -- breaches sla-first-contact.
      evidence('i1', 't-attempted-to-contacted', TUE_8AM),
      evidence('i1', 't-contacted-to-scheduled', TUE_8AM), // direct evidence of reaching the success terminal
    ]
    const result = classifyPromiseInstance(contract, entries, [], new Date(TUE_8AM))
    expect(result.status).toBe('missed')
  })

  it('unverifiable: reached a success terminal only via indirect evidence, no drifting', () => {
    const contract = empireHomecare()
    const entries = [
      instanceStart('i1', MON_8AM),
      evidence('i1', 't-received-to-attempted', MON_10AM),
      // t-contacted-to-scheduled's OWN toState is 'scheduled' -- to get INDIRECT evidence of
      // reaching 'contacted' (not 'scheduled') we'd need a transition FROM contacted. Simplest:
      // add a synthetic transition out of 'scheduled' itself so evidence of leaving it proves --
      // indirectly -- that it was reached, without ever directly confirming entry into it.
      evidence('i1', 't-attempted-to-contacted', MON_10AM),
    ]
    contract.transitions.push({ id: 't-scheduled-to-followup', fromState: 'scheduled', event: 'followup_sent', toState: 'contacted' })
    entries.push(evidence('i1', 't-scheduled-to-followup', MON_10AM))
    const result = classifyPromiseInstance(contract, entries, [], new Date(MON_10AM))
    expect(result.status).toBe('unverifiable')
    expect(result.evidenceQuality).toBe('generic')
  })

  it('at_risk: not terminal, no drifting finding yet, but has an open exception', () => {
    const contract = empireHomecare()
    const entries = [instanceStart('i1', MON_8AM)] // still within the 4h window -- insufficient_data, not drifting
    const exceptions = [exceptionItem('i1')]
    const result = classifyPromiseInstance(contract, entries, exceptions, new Date(MON_10AM))
    expect(result.status).toBe('at_risk')
  })

  it('in_progress: not terminal, no drifting, no exception -- genuinely still active', () => {
    const contract = empireHomecare()
    const entries = [instanceStart('i1', MON_8AM)]
    const result = classifyPromiseInstance(contract, entries, [], new Date(MON_10AM))
    expect(result.status).toBe('in_progress')
  })

  it('missed (not at_risk): a genuinely missed SLA takes priority even with an open exception present', () => {
    const contract = empireHomecare()
    const entries = [instanceStart('i1', MON_8AM)] // no further evidence, deadline will have passed
    const exceptions = [exceptionItem('i1')]
    const result = classifyPromiseInstance(contract, entries, exceptions, new Date(TUE_8AM))
    expect(result.status).toBe('missed')
  })
})

describe('buildPromiseReportData', () => {
  it('computes correct counts across multiple instances with different statuses', () => {
    const contract = empireHomecare()
    const entries = [
      instanceStart('kept-1', MON_8AM),
      evidence('kept-1', 't-received-to-attempted', MON_10AM),
      evidence('kept-1', 't-attempted-to-contacted', MON_10AM),
      evidence('kept-1', 't-contacted-to-scheduled', MON_10AM),
      instanceStart('progress-1', MON_10AM),
    ]
    const data = buildPromiseReportData(contract, entries, [], {}, new Date(MON_10AM))
    expect(data.totalInstances).toBe(2)
    expect(data.instanceCounts.kept).toBe(1)
    expect(data.instanceCounts.in_progress).toBe(1)
    expect(data.instanceCounts.missed).toBe(0)
  })

  it('filters entries and exceptions to the given time window', () => {
    const contract = empireHomecare()
    const entries = [instanceStart('i1', MON_8AM), instanceStart('i2', TUE_8AM)]
    const data = buildPromiseReportData(contract, entries, [], { from: MON_10AM }, new Date(TUE_8AM))
    expect(data.totalInstances).toBe(1) // i1's instance_start is before the window, excluded
  })

  it('excludes exceptions detected outside the window from open/resolved counts', () => {
    const contract = empireHomecare()
    const entries = [instanceStart('i1', MON_8AM)]
    const exceptions = [exceptionItem('i1', { detectedAt: TUE_8AM })]
    const data = buildPromiseReportData(contract, entries, exceptions, { to: MON_10AM }, new Date(MON_10AM))
    expect(data.openExceptionCount).toBe(0)
  })

  it('counts open vs. acknowledged vs. resolved exceptions correctly', () => {
    const contract = empireHomecare()
    const entries = [instanceStart('i1', MON_8AM), instanceStart('i2', MON_8AM), instanceStart('i3', MON_8AM)]
    const exceptions = [
      exceptionItem('i1', { status: 'open' }),
      exceptionItem('i2', { status: 'acknowledged' }),
      exceptionItem('i3', { status: 'resolved' }),
    ]
    const data = buildPromiseReportData(contract, entries, exceptions, {}, new Date(MON_10AM))
    expect(data.openExceptionCount).toBe(1)
    expect(data.acknowledgedExceptionCount).toBe(1)
    expect(data.resolvedExceptionCount).toBe(1)
    expect(data.openExceptions.map(e => e.status).sort()).toEqual(['acknowledged', 'open'])
  })

  it('never counts an unverifiable instance as kept', () => {
    const contract = empireHomecare()
    contract.transitions.push({ id: 't-scheduled-to-followup', fromState: 'scheduled', event: 'followup_sent', toState: 'contacted' })
    const entries = [
      instanceStart('i1', MON_8AM),
      evidence('i1', 't-received-to-attempted', MON_10AM),
      evidence('i1', 't-attempted-to-contacted', MON_10AM),
      evidence('i1', 't-scheduled-to-followup', MON_10AM), // only indirect evidence 'scheduled' was reached
    ]
    const data = buildPromiseReportData(contract, entries, [], {}, new Date(MON_10AM))
    expect(data.instanceCounts.unverifiable).toBe(1)
    expect(data.instanceCounts.kept).toBe(0)
  })

  it('adds a disclaimer when a real share of instances are unverifiable or in-progress', () => {
    const contract = empireHomecare()
    const entries = [instanceStart('i1', MON_8AM)]
    const data = buildPromiseReportData(contract, entries, [], {}, new Date(MON_10AM))
    expect(data.disclaimers.some(d => d.includes('unverifiable'))).toBe(true)
  })

  it('adds a disclaimer when there is no evidence at all in the window', () => {
    const contract = empireHomecare()
    const data = buildPromiseReportData(contract, [], [], {}, new Date(MON_10AM))
    expect(data.totalInstances).toBe(0)
    expect(data.disclaimers.some(d => d.includes('No promise instances'))).toBe(true)
  })

  it('ignores entries and exceptions for a different contract entirely', () => {
    const contract = empireHomecare()
    const entries: ProofLedgerEntry[] = [{ ...instanceStart('i1', MON_8AM), contractId: 'some-other-contract' }]
    const data = buildPromiseReportData(contract, entries, [], {}, new Date(MON_10AM))
    expect(data.totalInstances).toBe(0)
  })
})

describe('generatePromiseReport', () => {
  it('renders the key sections and never leaks a raw correlation key value', () => {
    const contract = empireHomecare()
    const entries = [
      instanceStart('abcdef1234567890', MON_8AM),
      evidence('abcdef1234567890', 't-received-to-attempted', MON_10AM),
      evidence('abcdef1234567890', 't-attempted-to-contacted', MON_10AM),
      evidence('abcdef1234567890', 't-contacted-to-scheduled', MON_10AM),
    ]
    const exceptions = [exceptionItem('abcdef1234567890', { status: 'open' })]
    const data = buildPromiseReportData(contract, entries, exceptions, {}, new Date(MON_10AM))
    const report = generatePromiseReport(data)

    expect(report).toContain('# Promise Report — Referral Intake & Contact')
    expect(report).toContain('empire-homecare-referral-intake')
    expect(report).toContain('## Summary')
    expect(report).toContain('## Open Exceptions — Owner / Action Summary')
    expect(report).toContain('## Per-Instance Detail')
    // The real correlation key value (a phone number, in the real fixture's own schema) never
    // appears anywhere -- report.ts only ever sees the already-hashed promiseInstanceId.
    expect(report).not.toContain('555-')
  })

  it('never prints anything resembling an ROI/dollar figure', () => {
    const contract = empireHomecare()
    const data = buildPromiseReportData(contract, [instanceStart('i1', MON_8AM)], [], {}, new Date(MON_10AM))
    const report = generatePromiseReport(data)
    expect(report).not.toMatch(/\$\d/)
    expect(report.toLowerCase()).not.toContain('roi')
    expect(report.toLowerCase()).not.toContain('hours saved')
  })

  it('states plainly when there is nothing to report', () => {
    const contract = empireHomecare()
    const data = buildPromiseReportData(contract, [], [], {}, new Date(MON_10AM))
    const report = generatePromiseReport(data)
    expect(report).toContain('No promise instances have any recorded evidence')
    expect(report).toContain('No instances recorded in this window.')
    expect(report).toContain('No open or acknowledged exceptions in this window.')
  })
})
