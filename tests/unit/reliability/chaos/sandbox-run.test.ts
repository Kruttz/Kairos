import { describe, it, expect } from 'vitest'
import { classifyChaosPayloadDiff, formatChaosSandboxRunResult, type ChaosSandboxRunResult, type ChaosPayloadOutcome } from '../../../../src/reliability/chaos/sandbox-run.js'
import type { PayloadDiffResult } from '../../../../src/reliability/replay/diff.js'

function makeDiff(overrides: Partial<PayloadDiffResult> = {}): PayloadDiffResult {
  return {
    payloadId: 'chaos:missing-field:email',
    verdict: 'IDENTICAL',
    verificationBoundary: { verified: [], unverifiable: [] },
    nodeDiffs: [],
    partialVerification: false,
    ...overrides,
  }
}

describe('classifyChaosPayloadDiff', () => {
  it('maps BROKEN to CRASHED', () => {
    expect(classifyChaosPayloadDiff(makeDiff({ verdict: 'BROKEN' }))).toBe('CRASHED')
  })

  it('maps BEHAVIORAL_CHANGE to SILENT_MISBEHAVIOR', () => {
    expect(classifyChaosPayloadDiff(makeDiff({ verdict: 'BEHAVIORAL_CHANGE' }))).toBe('SILENT_MISBEHAVIOR')
  })

  it('maps IDENTICAL with no partial verification to HANDLED', () => {
    expect(classifyChaosPayloadDiff(makeDiff({ verdict: 'IDENTICAL', partialVerification: false }))).toBe('HANDLED')
  })

  it('maps BENIGN_VARIANCE with no partial verification to HANDLED', () => {
    expect(classifyChaosPayloadDiff(makeDiff({ verdict: 'BENIGN_VARIANCE', partialVerification: false }))).toBe('HANDLED')
  })

  it('maps IDENTICAL with partial verification to BLOCKED_AT_CREDENTIAL -- never silently asserted HANDLED', () => {
    expect(classifyChaosPayloadDiff(makeDiff({ verdict: 'IDENTICAL', partialVerification: true }))).toBe('BLOCKED_AT_CREDENTIAL')
  })

  it('prioritizes CRASHED over BLOCKED_AT_CREDENTIAL when both a real crash and an unrelated unverifiable node are present', () => {
    // BROKEN can only be set from a verified (non-credentialed) node per diff.ts's own
    // traversal -- a real, attributable crash must never be masked by an unrelated credential
    // wall elsewhere in the workflow.
    expect(classifyChaosPayloadDiff(makeDiff({ verdict: 'BROKEN', partialVerification: true }))).toBe('CRASHED')
  })
})

function makeOutcome(overrides: Partial<ChaosPayloadOutcome> = {}): ChaosPayloadOutcome {
  return {
    variantName: 'missing-field:email',
    rationale: 'Referenced field "email" is absent entirely.',
    status: 'evaluated',
    classification: 'HANDLED',
    detail: 'Behaved equivalently to the valid-baseline reference -- this payload variant is handled.',
    ...overrides,
  }
}

function makeResult(overrides: Partial<ChaosSandboxRunResult> = {}): ChaosSandboxRunResult {
  return {
    status: 'completed',
    detail: 'Ran 1 adversarial payload variant(s) against the valid-baseline reference.',
    importedWorkflowName: '[kairos-sandbox] chaos: Missed Call Text-Back',
    referenceExecutionId: '1',
    outcomes: [makeOutcome()],
    summary: { handled: 1, crashed: 0, silentMisbehavior: 0, blockedAtCredential: 0, incomplete: 0 },
    ...overrides,
  }
}

describe('formatChaosSandboxRunResult', () => {
  it('includes the summary counts and every outcome with its classification', () => {
    const result = makeResult({
      outcomes: [
        makeOutcome({ variantName: 'missing-field:phone', classification: 'CRASHED', detail: 'Caused a crash at "Send SMS".' }),
      ],
      summary: { handled: 0, crashed: 1, silentMisbehavior: 0, blockedAtCredential: 0, incomplete: 0 },
    })
    const text = formatChaosSandboxRunResult(result, 'wf-1')
    expect(text).toContain('1 crashed')
    expect(text).toContain('[CRASHED] missing-field:phone')
    expect(text).toContain('Send SMS')
  })

  it('marks no_execution_found outcomes as INCOMPLETE, never silently as HANDLED', () => {
    const result = makeResult({
      outcomes: [makeOutcome({ status: 'no_execution_found', classification: undefined, detail: 'No fresh execution appeared.' })],
      summary: { handled: 0, crashed: 0, silentMisbehavior: 0, blockedAtCredential: 0, incomplete: 1 },
    })
    const text = formatChaosSandboxRunResult(result, 'wf-1')
    expect(text).toContain('[INCOMPLETE]')
    expect(text).not.toContain('[HANDLED]')
  })

  it('gives a real next action when something crashed', () => {
    const result = makeResult({ summary: { handled: 0, crashed: 1, silentMisbehavior: 0, blockedAtCredential: 0, incomplete: 0 } })
    const text = formatChaosSandboxRunResult(result, 'wf-1')
    expect(text.toLowerCase()).toContain('fix the crashing node')
  })

  it('gives a distinct next action for silent misbehavior with no crashes', () => {
    const result = makeResult({ summary: { handled: 0, crashed: 0, silentMisbehavior: 1, blockedAtCredential: 0, incomplete: 0 } })
    const text = formatChaosSandboxRunResult(result, 'wf-1')
    expect(text.toLowerCase()).toContain('review the silent-misbehavior')
  })

  it('gives a real next action for not_webhook_shaped, not a blank/generic message', () => {
    const result: ChaosSandboxRunResult = { status: 'not_webhook_shaped', detail: 'Only webhook-triggered workflows supported.', outcomes: [], summary: { handled: 0, crashed: 0, silentMisbehavior: 0, blockedAtCredential: 0, incomplete: 0 } }
    const text = formatChaosSandboxRunResult(result, 'wf-1')
    expect(text).toContain('webhook-triggered')
  })

  it('gives a real next action for no_reference_execution, not a blank/generic message', () => {
    const result: ChaosSandboxRunResult = { status: 'no_reference_execution', detail: 'The valid-baseline payload itself produced no fresh execution.', outcomes: [], summary: { handled: 0, crashed: 0, silentMisbehavior: 0, blockedAtCredential: 0, incomplete: 0 } }
    const text = formatChaosSandboxRunResult(result, 'wf-1')
    expect(text).toContain('valid-baseline payload itself produced no fresh execution')
  })
})
