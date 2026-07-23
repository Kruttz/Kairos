import { checkSlaCompliance } from './sla-compliance.js'
import { buildPromiseReportData } from './report.js'
import type { ProcessContract } from './types.js'
import type { ProofLedgerEntry } from './ledger-types.js'
import type { ExceptionDeskItem } from './exception-types.js'
import type { HarnessResult } from './harness-types.js'
import type { ContractAmendmentProposal, AmendmentCategory, AmendmentEvidenceRef } from './evolution-types.js'
import type { TargetId } from './targets/types.js'

/**
 * Contract Evolution v0 (roadmap item 11, docs/plans/contract-evolution-ops-roadmap-plan.md §3,
 * item 11). Pure, deterministic, no I/O -- `analyzeContractForAmendments()` is the only export
 * the rest of this item depends on. Reuses `checkSlaCompliance()` and `buildPromiseReportData()`
 * (both already-shipped, pure) as its only two real data sources -- no new evidence extraction
 * logic anywhere in this file.
 *
 * **Version filtering, decided here rather than left implicit**: `entries`/`exceptions` are
 * filtered to exactly `contract.version` before anything else runs (mirroring
 * `checkSlaCompliance()`'s own "filters defensively regardless" convention). An entry recorded
 * under an older, since-amended version may reference an id whose meaning has changed (Item 12's
 * whole `diffProcessContracts()` breaking-change classification exists because of exactly this
 * risk) -- mixing versions into one hotspot count would risk exactly the kind of "confidently
 * report the wrong thing" failure this whole arc has spent multiple phases guarding against.
 *
 * **v0 scope, decided against what the real data model actually supports, not the roadmap's own
 * most literal wording**: every category here is frequency/existence-based ("this element is a
 * hotspot," "this element is never reached"), never value-inference-based ("the right number is
 * 2, not 3"). `ExceptionStatusChange.reason` (exception-types.ts) is free text with no structured
 * field recording what actually happened -- inferring a specific replacement number from it would
 * mean either NLP over a small, noisy sample (unreliable) or guessing (dishonest). Neither is
 * attempted here, per Codex's own explicit guardrail. `recommendedNextAction` on every proposal
 * is deliberately a general "go look at this," never a specific new value.
 *
 * **Category-by-category evidence source, confirmed against real types before writing any
 * detection logic**:
 * - sla_threshold_hotspot / expiration_rule_hotspot: `checkSlaCompliance()`'s own
 *   `PromiseComplianceFinding[]`, grouped by `slaId`/`expirationRuleId`, rate = drifting /
 *   (healthy + drifting) -- 'insufficient_data'/'not_applicable'/'unverifiable' findings are
 *   excluded from both numerator and denominator (they're not real "did it hold" answers).
 *   Corroborated by `ExceptionDeskItem`s carrying a matching `slaId`/`expirationRuleId` (the
 *   ExceptionDesk-pattern evidence source Codex named) -- confirmed directly against
 *   exception-types.ts that ExceptionDeskItem has no direct link to ExceptionRule.id at all, only
 *   to slaId/expirationRuleId/transitionId, so an "exception_rule_hotspot" category as originally
 *   sketched in the plan doc would have had nothing real to key against; folded into these two
 *   categories instead, which DO have a direct id link.
 * - unreached_state / unused_transition: direct presence/absence scan over `entries` (the
 *   ProofLedger-pattern evidence source) against the contract's own declared states/transitions.
 * - high_miss_rate: `buildPromiseReportData()`'s own `instanceCounts` (the Promise-Report-outcome
 *   evidence source Codex named explicitly) -- a whole-contract signal, not tied to one element.
 * - harness_mismatch: an optional `HarnessResult` parameter (Codex: "harness mismatches if
 *   available") -- always confidence 'low', never blended into the same scoring as real evidence,
 *   per this plan's own Risks section (a harness failure is evidence about internal consistency
 *   between the contract's own stated expectation and Kairos's own evaluation logic, not
 *   evidence about real-world business behavior).
 */

const MIN_RATE_SAMPLE_SIZE = 3
const HOTSPOT_RATE_THRESHOLD = 0.3
const MIN_EXISTENCE_SAMPLE_SIZE = 3
const HIGH_MISS_RATE_THRESHOLD = 0.25
const MIN_MISS_RATE_SAMPLE_SIZE = 5

function confidenceForRate(sampleSize: number, rate: number): 'low' | 'medium' | 'high' {
  if (sampleSize < 5) return 'low'
  if (rate >= 0.75) return 'high'
  if (rate >= 0.5) return 'medium'
  return 'low'
}

function confidenceForSampleSize(sampleSize: number): 'low' | 'medium' | 'high' {
  if (sampleSize >= 10) return 'high'
  if (sampleSize >= 5) return 'medium'
  return 'low'
}

/** Deterministic, content-derived -- NOT a counter. The same (contract, version, category,
 * element) always produces the same proposal id, so re-running `kairos contract evolve run`
 * against unchanged evidence refreshes the SAME proposal record (evolution-store.ts's own
 * upsert-by-id preserves any human status decision already made on it) rather than piling up a
 * fresh near-duplicate every time. A counter-based id would have made this whole module
 * effectively write-once, silently defeating the store's own upsert semantics. */
function makeProposalId(contractId: string, contractVersion: number, category: AmendmentCategory, elementId: string): string {
  const safeElement = elementId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${contractId}-v${contractVersion}-${category}-${safeElement}`
}

/** Execution Substrate Boundary v0, Phase 4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.8): ledgerEntryIds carries each source ProofLedgerEntry's own optional targetId alongside
 * its id, rather than a bare id string, so detectRateHotspot() below can thread it through into
 * the AmendmentEvidenceRef it builds -- a bare string[] has nowhere to carry that information at
 * all. */
interface LedgerEntryRef {
  id: string
  targetId?: TargetId
}

interface RateHotspotInput {
  elementId: string
  kind: 'sla' | 'expiration'
  drifting: number
  evaluated: number
  ledgerEntryIds: LedgerEntryRef[]
  exceptionItemIds: string[]
}

function toLedgerEntryRefs(entries: ProofLedgerEntry[]): AmendmentEvidenceRef[] {
  return entries.map((e): AmendmentEvidenceRef => ({ kind: 'ledger_entry', id: e.id, ...(e.targetId ? { targetId: e.targetId } : {}) }))
}

function detectRateHotspot(contract: ProcessContract, input: RateHotspotInput): ContractAmendmentProposal | null {
  if (input.evaluated < MIN_RATE_SAMPLE_SIZE) return null
  const rate = input.drifting / input.evaluated
  if (rate < HOTSPOT_RATE_THRESHOLD) return null

  const category: AmendmentCategory = input.kind === 'sla' ? 'sla_threshold_hotspot' : 'expiration_rule_hotspot'
  const label = input.kind === 'sla' ? 'SLA' : 'Expiration rule'
  const pct = Math.round(rate * 100)
  // kind: 'ledger_entry' refs carry targetId, threaded from the source ProofLedgerEntry (plan
  // §6.8); kind: 'exception_item' refs never do -- ExceptionDeskItem has no targetId field to
  // read one from, and none is fabricated here.
  const evidence: AmendmentEvidenceRef[] = [
    ...input.ledgerEntryIds.map((le): AmendmentEvidenceRef => ({ kind: 'ledger_entry', id: le.id, ...(le.targetId ? { targetId: le.targetId } : {}) })),
    ...input.exceptionItemIds.map((id): AmendmentEvidenceRef => ({ kind: 'exception_item', id })),
  ]
  if (evidence.length === 0) return null

  return {
    id: makeProposalId(contract.id, contract.version, category, input.elementId),
    contractId: contract.id,
    clientId: contract.clientId,
    contractVersion: contract.version,
    category,
    summary: `${label} "${input.elementId}" drifted in ${input.drifting} of ${input.evaluated} (${pct}%) evaluated instance(s) this window -- above the ${Math.round(HOTSPOT_RATE_THRESHOLD * 100)}% review threshold.`,
    affectedElementId: input.elementId,
    evidence,
    occurrenceCount: input.drifting,
    sampleSize: input.evaluated,
    confidence: confidenceForRate(input.evaluated, rate),
    recommendedNextAction: `Review whether "${input.elementId}"'s own deadline/condition still matches how this process actually runs -- consider whether the threshold, the owner, or the process itself needs to change. This proposal does not know which.`,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    history: [],
  }
}

function detectSlaAndExpirationHotspots(contract: ProcessContract, entries: ProofLedgerEntry[], exceptions: ExceptionDeskItem[], now: Date): ContractAmendmentProposal[] {
  const findings = checkSlaCompliance(contract, entries, now)
  const proposals: ContractAmendmentProposal[] = []

  for (const sla of contract.sla) {
    const relevant = findings.filter(f => f.kind === 'sla' && f.slaId === sla.id)
    const evaluated = relevant.filter(f => f.status === 'healthy' || f.status === 'drifting')
    const drifting = evaluated.filter(f => f.status === 'drifting')
    const ledgerEntryIds = entries.filter(e => drifting.some(f => f.promiseInstanceId === e.promiseInstanceId)).map((e): LedgerEntryRef => ({ id: e.id, ...(e.targetId ? { targetId: e.targetId } : {}) }))
    const exceptionItemIds = exceptions.filter(x => x.slaId === sla.id).map(x => x.id)
    const proposal = detectRateHotspot(contract, { elementId: sla.id, kind: 'sla', drifting: drifting.length, evaluated: evaluated.length, ledgerEntryIds, exceptionItemIds })
    if (proposal) proposals.push(proposal)
  }

  for (const rule of contract.expirationRules ?? []) {
    const relevant = findings.filter(f => f.kind === 'expiration' && f.expirationRuleId === rule.id)
    const evaluated = relevant.filter(f => f.status === 'healthy' || f.status === 'drifting')
    const drifting = evaluated.filter(f => f.status === 'drifting')
    const ledgerEntryIds = entries.filter(e => drifting.some(f => f.promiseInstanceId === e.promiseInstanceId)).map((e): LedgerEntryRef => ({ id: e.id, ...(e.targetId ? { targetId: e.targetId } : {}) }))
    const exceptionItemIds = exceptions.filter(x => x.expirationRuleId === rule.id).map(x => x.id)
    const proposal = detectRateHotspot(contract, { elementId: rule.id, kind: 'expiration', drifting: drifting.length, evaluated: evaluated.length, ledgerEntryIds, exceptionItemIds })
    if (proposal) proposals.push(proposal)
  }

  return proposals
}

/** A state is "reached" if it's a StartCondition's own initialState, or if any evidence entry's
 * transitionId maps (via contract.transitions) to a transition whose toState is this state. */
function detectUnreachedStates(contract: ProcessContract, entries: ProofLedgerEntry[]): ContractAmendmentProposal[] {
  const totalInstances = new Set(entries.map(e => e.promiseInstanceId)).size
  if (totalInstances < MIN_EXISTENCE_SAMPLE_SIZE) return []

  const startStates = new Set(contract.startConditions.map(sc => sc.initialState))
  const reachedViaTransition = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'evidence' || !entry.transitionId) continue
    const transition = contract.transitions.find(t => t.id === entry.transitionId)
    if (transition) reachedViaTransition.add(transition.toState)
  }

  // Absence-based findings have no positive evidence about the missing element itself -- instead
  // cite the real entries that establish `totalInstances` is a genuine, non-trivial sample, so
  // "we looked, across N real instances, and it wasn't there" is itself traceable to real data,
  // never an empty evidence array (this file's own invariant, matching evolution-types.ts).
  const sampleEvidence: AmendmentEvidenceRef[] = toLedgerEntryRefs(entries)

  const proposals: ContractAmendmentProposal[] = []
  for (const state of contract.states) {
    if (startStates.has(state.id) || reachedViaTransition.has(state.id)) continue
    proposals.push({
      id: makeProposalId(contract.id, contract.version, 'unreached_state', state.id),
      contractId: contract.id,
      clientId: contract.clientId,
      contractVersion: contract.version,
      category: 'unreached_state',
      summary: `State "${state.id}" ("${state.name}") was never observed as reached across ${totalInstances} instance(s) this window -- no evidence entry's transition led into it, and it is not any StartCondition's own initialState.`,
      affectedElementId: state.id,
      evidence: sampleEvidence,
      occurrenceCount: 0,
      sampleSize: totalInstances,
      confidence: confidenceForSampleSize(totalInstances),
      recommendedNextAction: `Review whether "${state.id}" is actually reachable in practice -- consider whether a transition into it is missing, mis-wired, or whether this state should be removed from the contract.`,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      history: [],
    })
  }
  return proposals
}

/** Only transitions with a real EvidenceRequirement are eligible -- a transition with no
 * EvidenceRequirement was never observable at all, so "unused" would be an unfair/meaningless
 * label for it, not a real finding. */
function detectUnusedTransitions(contract: ProcessContract, entries: ProofLedgerEntry[]): ContractAmendmentProposal[] {
  const totalInstances = new Set(entries.map(e => e.promiseInstanceId)).size
  if (totalInstances < MIN_EXISTENCE_SAMPLE_SIZE) return []

  const observedTransitionIds = new Set(entries.filter(e => e.kind === 'evidence' && e.transitionId).map(e => e.transitionId!))
  const sampleEvidence: AmendmentEvidenceRef[] = toLedgerEntryRefs(entries)
  const proposals: ContractAmendmentProposal[] = []

  for (const req of contract.evidenceRequirements) {
    if (observedTransitionIds.has(req.transitionId)) continue
    const transition = contract.transitions.find(t => t.id === req.transitionId)
    if (!transition) continue // dangling reference -- validateProcessContract()'s own job to catch, not this module's
    proposals.push({
      id: makeProposalId(contract.id, contract.version, 'unused_transition', transition.id),
      contractId: contract.id,
      clientId: contract.clientId,
      contractVersion: contract.version,
      category: 'unused_transition',
      summary: `Transition "${transition.id}" ("${transition.fromState}" -> "${transition.toState}" on "${transition.event}") has an EvidenceRequirement but was never observed across ${totalInstances} instance(s) this window.`,
      affectedElementId: transition.id,
      evidence: sampleEvidence,
      occurrenceCount: 0,
      sampleSize: totalInstances,
      confidence: confidenceForSampleSize(totalInstances),
      recommendedNextAction: `Review whether "${transition.id}" still happens in practice -- consider whether its condition is too narrow, whether the marker node is wired correctly, or whether this path is genuinely obsolete.`,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      history: [],
    })
  }
  return proposals
}

function detectHighMissRate(contract: ProcessContract, entries: ProofLedgerEntry[], exceptions: ExceptionDeskItem[], now: Date): ContractAmendmentProposal[] {
  const data = buildPromiseReportData(contract, entries, exceptions, {}, now)
  if (data.totalInstances < MIN_MISS_RATE_SAMPLE_SIZE) return []

  const rate = data.instanceCounts.missed / data.totalInstances
  if (rate < HIGH_MISS_RATE_THRESHOLD) return []

  const missedIds = data.instances.filter(i => i.status === 'missed').map(i => i.promiseInstanceId)
  const evidence: AmendmentEvidenceRef[] = toLedgerEntryRefs(entries.filter(e => missedIds.includes(e.promiseInstanceId)))
  if (evidence.length === 0) return []

  const pct = Math.round(rate * 100)
  return [{
    id: makeProposalId(contract.id, contract.version, 'high_miss_rate', contract.id),
    contractId: contract.id,
    clientId: contract.clientId,
    contractVersion: contract.version,
    category: 'high_miss_rate',
    summary: `${data.instanceCounts.missed} of ${data.totalInstances} (${pct}%) instance(s) this window were classified 'missed' -- above the ${Math.round(HIGH_MISS_RATE_THRESHOLD * 100)}% review threshold. This is a whole-contract signal, not tied to one specific element.`,
    affectedElementId: contract.id,
    evidence,
    occurrenceCount: data.instanceCounts.missed,
    sampleSize: data.totalInstances,
    confidence: confidenceForRate(data.totalInstances, rate),
    recommendedNextAction: `Review the individual missed instances (kairos contract report) for a common cause -- an SLA/exception hotspot proposal above may already point at one; if not, this may indicate a gap this v0's narrower per-element checks don't cover.`,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    history: [],
  }]
}

function detectHarnessMismatches(contract: ProcessContract, harnessResult: HarnessResult | undefined): ContractAmendmentProposal[] {
  if (!harnessResult) return []
  const failing = harnessResult.scenarioResults.filter(r => !r.passed)
  return failing.map(r => ({
    id: makeProposalId(contract.id, contract.version, 'harness_mismatch', r.scenarioId),
    contractId: contract.id,
    clientId: contract.clientId,
    contractVersion: contract.version,
    category: 'harness_mismatch' as const,
    summary: `Generated scenario "${r.scenarioName}" (${r.category}) did not match Kairos's own evaluation: ${r.mismatches.join('; ')}`,
    affectedElementId: r.scenarioId,
    evidence: [{ kind: 'harness_scenario' as const, id: r.scenarioId }],
    occurrenceCount: 1,
    sampleSize: 1,
    // Always 'low', unconditionally -- this is synthetic evidence about internal consistency
    // between the contract's own stated expectation and Kairos's own evaluation logic, not real
    // evidence about business behavior. Never blended into the same scoring as the categories
    // above, per this file's own doc comment and the plan's own Risks section.
    confidence: 'low' as const,
    recommendedNextAction: `This may be a bug in Kairos's own evaluation logic (report.ts/sla-compliance.ts), or a genuine gap in how this contract models this case -- review the scenario's own expected outcome by hand before assuming either.`,
    status: 'proposed' as const,
    createdAt: new Date().toISOString(),
    history: [],
  }))
}

export function analyzeContractForAmendments(
  contract: ProcessContract,
  allEntries: ProofLedgerEntry[],
  allExceptions: ExceptionDeskItem[],
  harnessResult?: HarnessResult,
  now: Date = new Date(),
): ContractAmendmentProposal[] {
  const entries = allEntries.filter(e => e.contractId === contract.id && e.contractVersion === contract.version)
  const exceptions = allExceptions.filter(x => x.contractId === contract.id)

  return [
    ...detectSlaAndExpirationHotspots(contract, entries, exceptions, now),
    ...detectUnreachedStates(contract, entries),
    ...detectUnusedTransitions(contract, entries),
    ...detectHighMissRate(contract, entries, exceptions, now),
    ...detectHarnessMismatches(contract, harnessResult),
  ]
}
