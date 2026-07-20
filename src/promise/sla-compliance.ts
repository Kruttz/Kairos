import { elapsedInDurationUnits } from './business-calendar.js'
import type { ProcessContract, SlaSpec, ExpirationRule } from './types.js'
import type { ProofLedgerEntry } from './ledger-types.js'

/**
 * SLA/promise compliance checking (Phase 4, docs/plans/process-contract-promise-engine-plan.md
 * §5.3). Pure, evidence-driven, styled directly on src/reliability/drift/checks.ts's own D1-D9
 * checks -- the same 4-state honesty discipline, reused verbatim rather than reinvented:
 * insufficient_data (not enough evidence yet, will resolve once more accumulates) /
 * not_applicable (this check genuinely does not apply to this instance) / healthy (evaluated,
 * no problem found) / drifting (evaluated, a real miss found).
 *
 * Deliberately never writes to ProofLedger -- Codex's explicit guardrail: "do not fabricate
 * ledger entries for missing evidence; absence should be evaluated by compliance logic." This
 * module only ever reads already-recorded entries and reasons about the absence of an expected
 * one, the same "absence is itself the evidence" pattern D6 (cadence drift/silent-stop) already
 * uses (plan doc §6.5 names this connection explicitly).
 *
 * Never conflates workflow drift with promise failure (Codex's explicit guardrail): this module
 * has no dependency on DriftCheckFinding/DriftCheckStatus and produces its own, separate
 * PromiseComplianceFinding type -- a promise can be missed with a perfectly healthy workflow (a
 * human just never made the call), and a workflow can drift with every promise still on track.
 */

export type PromiseComplianceStatus = 'insufficient_data' | 'not_applicable' | 'healthy' | 'drifting'

export interface PromiseComplianceFinding {
  contractId: string
  promiseInstanceId: string
  kind: 'sla' | 'expiration'
  slaId?: string
  expirationRuleId?: string
  status: PromiseComplianceStatus
  summary: string
  evidence: Record<string, unknown>
  /** Mirrors DriftEvidenceQuality's exact naming/philosophy (checks.ts) -- present only on a
   * 'drifting' finding. 'specific': the timestamps this finding relies on came from evidence
   * that directly confirms the state was entered. 'generic': at least one timestamp is inferred
   * (a later transition's own evidence proves an earlier state was passed through, but not
   * precisely when it was entered) -- conservative by design, the same "if any part of the
   * evidence is uncertain, the whole finding is uncertain" rule D1 already uses. */
  evidenceQuality?: 'specific' | 'generic'
}

interface StateReachSignal {
  observedAt: string
  confidence: 'specific' | 'generic'
}

/** Every real-world signal this instance's ledger entries give for "this instance was in state
 * `stateId` at or before this timestamp." 'specific' -- an instance_start entry naming it as the
 * initial state, or an evidence entry whose transition's toState is it (direct entry evidence).
 * 'generic' -- an evidence entry whose transition's fromState is it (the instance must have
 * passed through it to fire that transition, but the exact entry time isn't separately evidenced
 * -- this entry's own timestamp is used as a conservative upper bound). Sorted earliest-first. */
function stateReachSignals(contract: ProcessContract, entries: ProofLedgerEntry[], stateId: string): StateReachSignal[] {
  const signals: StateReachSignal[] = []
  for (const e of entries) {
    if (e.kind === 'instance_start' && e.initialState === stateId) {
      signals.push({ observedAt: e.observedAt, confidence: 'specific' })
    } else if (e.kind === 'evidence' && e.transitionId) {
      const t = contract.transitions.find(x => x.id === e.transitionId)
      if (!t) continue
      if (t.toState === stateId) signals.push({ observedAt: e.observedAt, confidence: 'specific' })
      else if (t.fromState === stateId) signals.push({ observedAt: e.observedAt, confidence: 'generic' })
    }
  }
  return signals.sort((a, b) => a.observedAt.localeCompare(b.observedAt))
}

/** Signals for "this instance experienced event `eventId`" -- evidence entries whose transition
 * uses that event. Used for SlaSpec.measuredFrom's {event} variant (v0's only mechanism for it;
 * the SaaS pressure-test contract uses this shape, Empire Homecare's own checkpoint SLA does
 * not). */
function eventSignals(contract: ProcessContract, entries: ProofLedgerEntry[], eventId: string): StateReachSignal[] {
  const signals: StateReachSignal[] = []
  for (const e of entries) {
    if (e.kind !== 'evidence' || !e.transitionId) continue
    const t = contract.transitions.find(x => x.id === e.transitionId)
    if (t?.event === eventId) signals.push({ observedAt: e.observedAt, confidence: 'specific' })
  }
  return signals.sort((a, b) => a.observedAt.localeCompare(b.observedAt))
}

function measuredFromSignals(contract: ProcessContract, entries: ProofLedgerEntry[], measuredFrom: SlaSpec['measuredFrom']): StateReachSignal[] {
  return 'state' in measuredFrom
    ? stateReachSignals(contract, entries, measuredFrom.state)
    : eventSignals(contract, entries, measuredFrom.event)
}

function checkSlaForInstance(
  contract: ProcessContract,
  sla: SlaSpec,
  instanceEntries: ProofLedgerEntry[],
  promiseInstanceId: string,
  now: Date,
): PromiseComplianceFinding {
  const base = { contractId: contract.id, promiseInstanceId, kind: 'sla' as const, slaId: sla.id }
  const durationLabel = `${sla.duration.amount} ${sla.duration.unit}`

  const startSignals = measuredFromSignals(contract, instanceEntries, sla.measuredFrom)
  if (startSignals.length === 0) {
    return {
      ...base,
      status: 'insufficient_data',
      summary: `No evidence yet of when this instance reached SLA "${sla.id}"'s clock-start condition.`,
      evidence: {},
    }
  }
  const clockStart = startSignals[0]!

  const endSignals = stateReachSignals(contract, instanceEntries, sla.expectedBy.state)
  if (endSignals.length > 0) {
    const clockEnd = endSignals[0]!
    const elapsed = elapsedInDurationUnits(clockStart.observedAt, clockEnd.observedAt, sla.duration.unit, contract.businessCalendar)
    const met = elapsed <= sla.duration.amount
    const confidence: 'specific' | 'generic' = clockStart.confidence === 'generic' || clockEnd.confidence === 'generic' ? 'generic' : 'specific'
    return {
      ...base,
      status: met ? 'healthy' : 'drifting',
      summary: met
        ? `SLA "${sla.id}" met: reached "${sla.expectedBy.state}" ${elapsed.toFixed(2)} ${sla.duration.unit} after clock start (limit ${durationLabel}).`
        : `SLA "${sla.id}" missed: reached "${sla.expectedBy.state}" ${elapsed.toFixed(2)} ${sla.duration.unit} after clock start -- over the ${durationLabel} limit.`,
      evidence: { measuredFromAt: clockStart.observedAt, expectedByAt: clockEnd.observedAt, elapsed, limit: sla.duration.amount, unit: sla.duration.unit },
      ...(met ? {} : { evidenceQuality: confidence }),
    }
  }

  const elapsedSoFar = elapsedInDurationUnits(clockStart.observedAt, now.toISOString(), sla.duration.unit, contract.businessCalendar)
  if (elapsedSoFar <= sla.duration.amount) {
    return {
      ...base,
      status: 'insufficient_data',
      summary: `SLA "${sla.id}" still within its ${durationLabel} window (${elapsedSoFar.toFixed(2)} ${sla.duration.unit} elapsed so far) -- no evidence "${sla.expectedBy.state}" was reached yet, and none is expected yet either.`,
      evidence: { measuredFromAt: clockStart.observedAt, elapsedSoFar },
    }
  }

  // Deadline passed, zero evidence the expected state was ever reached -- the absence itself is
  // the finding, matching D6's own "absence is itself the evidence" precedent (plan doc §6.5).
  return {
    ...base,
    status: 'drifting',
    summary: `SLA "${sla.id}" missed: ${elapsedSoFar.toFixed(2)} ${sla.duration.unit} have passed since clock start with no evidence "${sla.expectedBy.state}" was ever reached (limit ${durationLabel}).`,
    evidence: { measuredFromAt: clockStart.observedAt, elapsedSoFar, limit: sla.duration.amount, unit: sla.duration.unit },
    evidenceQuality: 'specific',
  }
}

function checkRecurringSlaForInstance(
  contract: ProcessContract,
  sla: SlaSpec & { recurring: NonNullable<SlaSpec['recurring']> },
  instanceEntries: ProofLedgerEntry[],
  promiseInstanceId: string,
  now: Date,
): PromiseComplianceFinding {
  const base = { contractId: contract.id, promiseInstanceId, kind: 'sla' as const, slaId: sla.id }
  const whileInState = sla.recurring.whileInState
  const durationLabel = `${sla.duration.amount} ${sla.duration.unit}`

  const enterSignals = stateReachSignals(contract, instanceEntries, whileInState)
  if (enterSignals.length === 0) {
    return { ...base, status: 'insufficient_data', summary: `No evidence yet this instance entered "${whileInState}", where SLA "${sla.id}" recurs.`, evidence: {} }
  }

  // Same "already moved on" rule as expiration-rule checking: a real transition OUT of
  // whileInState means the recurring obligation no longer applies to this instance.
  const exited = instanceEntries.some(e => {
    if (e.kind !== 'evidence' || !e.transitionId) return false
    const t = contract.transitions.find(x => x.id === e.transitionId)
    return t?.fromState === whileInState
  })
  if (exited) {
    return { ...base, status: 'not_applicable', summary: `Instance already left "${whileInState}" -- recurring SLA "${sla.id}" no longer applies.`, evidence: {} }
  }

  // D6's own cadence-drift pattern, reused directly: the most recent evidence timestamp for
  // this state is the last known "heartbeat"; if too much time has passed since it, that's a
  // cadence miss even with no single missing entry to point to.
  const stateEntries = instanceEntries.filter(e => {
    if (e.kind === 'instance_start') return e.initialState === whileInState
    if (e.kind === 'evidence' && e.transitionId) {
      const t = contract.transitions.find(x => x.id === e.transitionId)
      return t?.toState === whileInState || t?.fromState === whileInState
    }
    return false
  })
  const latest = stateEntries.map(e => e.observedAt).sort().at(-1) ?? enterSignals[0]!.observedAt

  const sinceLatest = elapsedInDurationUnits(latest, now.toISOString(), sla.duration.unit, contract.businessCalendar)
  if (sinceLatest <= sla.duration.amount) {
    return { ...base, status: 'healthy', summary: `Recurring SLA "${sla.id}": last evidence ${sinceLatest.toFixed(2)} ${sla.duration.unit} ago, within the ${durationLabel} cadence.`, evidence: { lastEvidenceAt: latest, sinceLatest } }
  }
  return {
    ...base,
    status: 'drifting',
    summary: `Recurring SLA "${sla.id}" missed: ${sinceLatest.toFixed(2)} ${sla.duration.unit} since the last evidence while in "${whileInState}" -- over the ${durationLabel} cadence.`,
    evidence: { lastEvidenceAt: latest, sinceLatest, limit: sla.duration.amount, unit: sla.duration.unit },
    evidenceQuality: 'specific',
  }
}

function checkExpirationRuleForInstance(
  contract: ProcessContract,
  rule: ExpirationRule,
  instanceEntries: ProofLedgerEntry[],
  promiseInstanceId: string,
  now: Date,
): PromiseComplianceFinding {
  const base = { contractId: contract.id, promiseInstanceId, kind: 'expiration' as const, expirationRuleId: rule.id }

  const enterSignals = stateReachSignals(contract, instanceEntries, rule.state)
  if (enterSignals.length === 0) {
    return { ...base, status: 'insufficient_data', summary: `No evidence yet this instance entered state "${rule.state}".`, evidence: {} }
  }
  const enteredAt = enterSignals[0]!

  const exited = instanceEntries.some(e => {
    if (e.kind !== 'evidence' || !e.transitionId) return false
    const t = contract.transitions.find(x => x.id === e.transitionId)
    return t?.fromState === rule.state
  })
  if (exited) {
    return { ...base, status: 'not_applicable', summary: `Instance already left state "${rule.state}" via a real transition -- expiration rule "${rule.id}" no longer applies.`, evidence: {} }
  }

  const elapsed = elapsedInDurationUnits(enteredAt.observedAt, now.toISOString(), rule.after.unit, contract.businessCalendar)
  const limitLabel = `${rule.after.amount} ${rule.after.unit}`
  if (elapsed <= rule.after.amount) {
    return {
      ...base,
      status: 'insufficient_data',
      summary: `Instance has been in "${rule.state}" for ${elapsed.toFixed(2)} ${rule.after.unit} -- within the ${limitLabel} expiration window.`,
      evidence: { enteredAt: enteredAt.observedAt, elapsed },
    }
  }

  return {
    ...base,
    status: 'drifting',
    summary: `Instance appears stuck in "${rule.state}": ${elapsed.toFixed(2)} ${rule.after.unit} elapsed, past the ${limitLabel} expiration window, with no evidence it moved to "${rule.expiresTo}".`,
    evidence: { enteredAt: enteredAt.observedAt, elapsed, expiresTo: rule.expiresTo },
    evidenceQuality: enteredAt.confidence,
  }
}

/** Evaluates every SLA and ExpirationRule in the contract, for every promise instance that has
 * at least one ProofLedger entry -- an instance with zero entries doesn't exist yet from
 * Kairos's own perspective, so there is nothing to evaluate. Pure: never touches the ledger,
 * n8n, or the network. `entries` should already be filtered/scoped to this contract by the
 * caller in the common case, but this function filters defensively regardless. */
export function checkSlaCompliance(contract: ProcessContract, entries: ProofLedgerEntry[], now: Date = new Date()): PromiseComplianceFinding[] {
  const contractEntries = entries.filter(e => e.contractId === contract.id)
  const instanceIds = [...new Set(contractEntries.map(e => e.promiseInstanceId))]

  const findings: PromiseComplianceFinding[] = []
  for (const instanceId of instanceIds) {
    const instanceEntries = contractEntries.filter(e => e.promiseInstanceId === instanceId)
    for (const sla of contract.sla) {
      findings.push(
        sla.recurring
          ? checkRecurringSlaForInstance(contract, sla as SlaSpec & { recurring: NonNullable<SlaSpec['recurring']> }, instanceEntries, instanceId, now)
          : checkSlaForInstance(contract, sla, instanceEntries, instanceId, now)
      )
    }
    for (const rule of contract.expirationRules ?? []) {
      findings.push(checkExpirationRuleForInstance(contract, rule, instanceEntries, instanceId, now))
    }
  }
  return findings
}

export interface PromiseComplianceReport {
  contractId: string
  contractName: string
  instanceCount: number
  /** 'DRIFTING' iff at least one finding has status 'drifting' -- mirrors DriftCheckReport's own
   * verdict rule exactly (insufficient_data/not_applicable never contribute). */
  verdict: 'HEALTHY' | 'DRIFTING'
  findings: PromiseComplianceFinding[]
}

export function buildPromiseComplianceReport(contract: ProcessContract, entries: ProofLedgerEntry[], now: Date = new Date()): PromiseComplianceReport {
  const findings = checkSlaCompliance(contract, entries, now)
  const instanceIds = new Set(entries.filter(e => e.contractId === contract.id).map(e => e.promiseInstanceId))
  return {
    contractId: contract.id,
    contractName: contract.name,
    instanceCount: instanceIds.size,
    verdict: findings.some(f => f.status === 'drifting') ? 'DRIFTING' : 'HEALTHY',
    findings,
  }
}
