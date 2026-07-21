import { describe, it, expect, vi } from 'vitest'
import {
  INTAKE_QUESTIONS,
  createIntakeSession,
  nextUnansweredQuestion,
  recordAnswer,
  buildIntakeTranscript,
  buildFollowUpQuestions,
  runIntakeToCompletion,
  type IntakeRunDeps,
} from '../../../src/promise/intake.js'
import type { AnthropicMessagesClient } from '../../../src/promise/plan.js'
import type { ContractValidationIssue } from '../../../src/promise/validate.js'
import type { ProcessContract } from '../../../src/promise/types.js'
import type { IntakeSession } from '../../../src/promise/intake-types.js'

function mockClient(responseText: string): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: responseText }] }),
    },
  }
}

// Mirrors plan.test.ts's own validDraftResponse() shape -- deliberately small and otherwise
// valid, since these tests are about intake.ts's own plumbing (transcript building, question
// sequencing, refinement rounds), not about re-proving the validator or planProcessContract()
// itself.
function validDraftResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'Test Contract',
    description: 'A thing is handled promptly.',
    entity: { name: 'Thing', description: 'A thing.' },
    correlationKey: { fieldPath: 'body.id', description: 'The thing id.' },
    promise: { text: 'The thing is handled.' },
    startConditions: [{ id: 'sc1', description: 'A thing arrives.', trigger: 'webhook', initialState: 's1' }],
    states: [
      { id: 's1', name: 'Received', description: 'Just arrived.', terminal: false },
      { id: 's2', name: 'Done', description: 'Handled.', terminal: true },
    ],
    events: [{ id: 'e1', name: 'Handled', description: 'The thing was handled.' }],
    transitions: [{ id: 't1', fromState: 's1', event: 'e1', toState: 's2' }],
    terminalOutcomes: [{ state: 's2', outcome: 'success', description: 'Handled successfully.' }],
    owners: [{ state: 's1', owner: 'coordinator' }],
    sla: [{ id: 'sla1', measuredFrom: { state: 's1' }, expectedBy: { state: 's2' }, duration: { amount: 1, unit: 'hours' } }],
    exceptions: [],
    evidenceRequirements: [],
    assumptions: [],
    ...overrides,
  })
}

// Blocking-assumption response -- forces runIntakeToCompletion into a refinement round so that
// path gets real coverage, not just the clean-first-pass case.
function blockingDraftResponse(): string {
  return validDraftResponse({ assumptions: [{ type: 'blocking', text: 'SLA duration was not stated.' }] })
}

describe('INTAKE_QUESTIONS', () => {
  it('is a fixed, non-empty, uniquely-ided bank covering the required categories', () => {
    expect(INTAKE_QUESTIONS.length).toBeGreaterThan(0)
    const ids = INTAKE_QUESTIONS.map(q => q.id)
    expect(new Set(ids).size).toBe(ids.length)
    const categories = new Set(INTAKE_QUESTIONS.map(q => q.category))
    for (const required of ['trigger', 'terminal', 'branch', 'exception', 'owner', 'sla', 'evidence', 'handoff', 'missing_data', 'duplicate', 'do_not_automate']) {
      expect(categories.has(required as never)).toBe(true)
    }
  })
})

describe('createIntakeSession / nextUnansweredQuestion / recordAnswer', () => {
  it('starts with no turns and the first fixed question as next', () => {
    const session = createIntakeSession('client-a')
    expect(session.turns).toEqual([])
    expect(session.status).toBe('in_progress')
    expect(nextUnansweredQuestion(session)?.id).toBe(INTAKE_QUESTIONS[0]!.id)
  })

  it('recordAnswer never mutates the input session, and advances nextUnansweredQuestion', () => {
    const session = createIntakeSession('client-a')
    const q0 = INTAKE_QUESTIONS[0]!
    const after = recordAnswer(session, q0, 'A webhook.')

    expect(session.turns).toEqual([]) // original untouched
    expect(after.turns).toHaveLength(1)
    expect(after.turns[0]!.questionId).toBe(q0.id)
    expect(after.turns[0]!.answer).toBe('A webhook.')
    expect(nextUnansweredQuestion(after)?.id).toBe(INTAKE_QUESTIONS[1]!.id)
  })

  it('returns null once every fixed question has a turn', () => {
    let session = createIntakeSession('client-a')
    for (const q of INTAKE_QUESTIONS) {
      session = recordAnswer(session, q, `answer for ${q.id}`)
    }
    expect(nextUnansweredQuestion(session)).toBeNull()
  })
})

describe('buildIntakeTranscript', () => {
  it('renders every answered turn as a Q/A pair, in order', () => {
    let session = createIntakeSession('client-a')
    session = recordAnswer(session, INTAKE_QUESTIONS[0]!, 'A webhook from the intake form.')
    session = recordAnswer(session, INTAKE_QUESTIONS[1]!, 'The customer is contacted.')

    const transcript = buildIntakeTranscript(session)
    expect(transcript).toContain(INTAKE_QUESTIONS[0]!.text)
    expect(transcript).toContain('A webhook from the intake form.')
    expect(transcript).toContain(INTAKE_QUESTIONS[1]!.text)
    expect(transcript).toContain('The customer is contacted.')
    expect(transcript.indexOf(INTAKE_QUESTIONS[0]!.text)).toBeLessThan(transcript.indexOf(INTAKE_QUESTIONS[1]!.text))
  })

  it('includes provided context text verbatim, ahead of the interview', () => {
    const session = createIntakeSession('client-a')
    const transcript = buildIntakeTranscript(session, 'Existing SOP: always confirm insurance first.')
    expect(transcript).toContain('Existing SOP: always confirm insurance first.')
    // 'do not ignore any of them' only appears in the interview-intro paragraph, not the
    // context-intro paragraph (which itself happens to contain the words "structured
    // interview", making that phrase an unreliable anchor here).
    expect(transcript.indexOf('Existing SOP')).toBeLessThan(transcript.indexOf('do not ignore any of them'))
  })

  it('truncates context text past the length cap rather than sending it unbounded', () => {
    const session = createIntakeSession('client-a')
    const huge = 'x'.repeat(20_000)
    const transcript = buildIntakeTranscript(session, huge)
    expect(transcript).toContain('[... truncated]')
    expect(transcript.length).toBeLessThan(huge.length)
  })
})

describe('buildFollowUpQuestions', () => {
  const baseContract = JSON.parse(validDraftResponse()) as ProcessContract

  it('produces one question per blocking assumption', () => {
    const contract = { ...baseContract, assumptions: [{ type: 'blocking' as const, text: 'Missing SLA duration.' }, { type: 'blocking' as const, text: 'Missing owner.' }] }
    const questions = buildFollowUpQuestions([], contract, 1)
    expect(questions).toHaveLength(2)
    expect(questions[0]!.category).toBe('follow_up')
    expect(questions[0]!.text).toContain('Missing SLA duration.')
    expect(questions[1]!.text).toContain('Missing owner.')
  })

  it('produces one question per validation error, ignoring warnings', () => {
    const issues: ContractValidationIssue[] = [
      { rule: 3, severity: 'error', message: 'Unreachable state.', path: 'states[1]' },
      { rule: 9, severity: 'warn', message: 'Just a warning.' },
    ]
    const questions = buildFollowUpQuestions(issues, baseContract, 1)
    expect(questions).toHaveLength(1)
    expect(questions[0]!.text).toContain('Unreachable state.')
    expect(questions[0]!.text).toContain('states[1]')
  })

  it('produces no questions when there is nothing to resolve', () => {
    expect(buildFollowUpQuestions([], baseContract, 1)).toEqual([])
  })
})

describe('runIntakeToCompletion', () => {
  function makeDeps(overrides: Partial<IntakeRunDeps> = {}): { deps: IntakeRunDeps; answers: string[]; persisted: IntakeSession[] } {
    const answers: string[] = []
    const persisted: IntakeSession[] = []
    const deps: IntakeRunDeps = {
      askQuestion: async () => answers.shift() ?? 'a reasonable answer',
      persistSession: async s => { persisted.push(s) },
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      ...overrides,
    }
    return { deps, answers, persisted }
  }

  it('asks every fixed question exactly once, in order, before synthesizing', async () => {
    const asked: string[] = []
    const { deps } = makeDeps({
      askQuestion: async q => { asked.push(q.id); return `answer for ${q.id}` },
      anthropicClient: mockClient(validDraftResponse()),
    })
    const session = createIntakeSession('client-a')
    const result = await runIntakeToCompletion(session, { clientId: 'client-a', anthropicApiKey: 'fake' }, deps)

    expect(asked).toEqual(INTAKE_QUESTIONS.map(q => q.id))
    expect(result.status).toBe('ready_for_review')
    expect(result.synthesisAttempts).toHaveLength(1)
    expect(result.draftContract?.name).toBe('Test Contract')
  })

  it('persists after every answered turn -- an interruption never loses an already-given answer', async () => {
    const { deps, persisted } = makeDeps({ anthropicClient: mockClient(validDraftResponse()) })
    const session = createIntakeSession('client-a')
    await runIntakeToCompletion(session, { clientId: 'client-a', anthropicApiKey: 'fake' }, deps)

    // one persist call per fixed-question answer, plus at least one for the synthesis attempt
    expect(persisted.length).toBeGreaterThanOrEqual(INTAKE_QUESTIONS.length + 1)
    expect(persisted[0]!.turns).toHaveLength(1)
  })

  it('runs a bounded refinement round when the draft has a blocking assumption, then succeeds once resolved', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({ content: [{ type: 'text', text: blockingDraftResponse() }] })
          .mockResolvedValueOnce({ content: [{ type: 'text', text: validDraftResponse() }] }),
      },
    }
    const { deps } = makeDeps({ anthropicClient: client })
    const session = createIntakeSession('client-a')
    const result = await runIntakeToCompletion(session, { clientId: 'client-a', anthropicApiKey: 'fake' }, deps)

    expect(result.status).toBe('ready_for_review')
    expect(result.synthesisAttempts).toHaveLength(2)
    expect(result.synthesisAttempts[0]!.readyToProceed).toBe(false)
    expect(result.synthesisAttempts[0]!.blockingAssumptionCount).toBe(1)
    expect(result.synthesisAttempts[1]!.readyToProceed).toBe(true)
    // the follow-up question and its answer were recorded as a real turn
    expect(result.turns.some(t => t.category === 'follow_up')).toBe(true)
    expect(result.pendingFollowUpQuestions).toEqual([])
  })

  it('never withholds the draft -- reaching the round cap still saves it and reports needs_more_review', async () => {
    const client: AnthropicMessagesClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: blockingDraftResponse() }] }) },
    }
    const { deps } = makeDeps({ anthropicClient: client })
    const session = createIntakeSession('client-a')
    const result = await runIntakeToCompletion(session, { clientId: 'client-a', anthropicApiKey: 'fake' }, deps, 2)

    expect(result.status).toBe('needs_more_review')
    expect(result.synthesisAttempts).toHaveLength(2)
    expect(result.draftContract).toBeDefined() // never withheld even though it never became ready
  })

  it('resuming a session with fixed questions already answered skips straight to synthesis', async () => {
    let session = createIntakeSession('client-a')
    for (const q of INTAKE_QUESTIONS) session = recordAnswer(session, q, `answer for ${q.id}`)

    const asked: string[] = []
    const { deps } = makeDeps({
      askQuestion: async q => { asked.push(q.id); return 'ok' },
      anthropicClient: mockClient(validDraftResponse()),
    })
    const result = await runIntakeToCompletion(session, { clientId: 'client-a', anthropicApiKey: 'fake' }, deps)

    expect(asked).toEqual([]) // no fixed question re-asked
    expect(result.status).toBe('ready_for_review')
  })

  it('resuming mid-refinement-round with a pending follow-up asks only the pending one, not a fresh synthesis first', async () => {
    let session = createIntakeSession('client-a')
    for (const q of INTAKE_QUESTIONS) session = recordAnswer(session, q, `answer for ${q.id}`)
    session = {
      ...session,
      synthesisAttempts: [{ round: 1, attemptedAt: '2026-07-21T00:00:00.000Z', validationIssues: [], blockingAssumptionCount: 1, readyToProceed: false }],
      pendingFollowUpQuestions: [{ id: 'followup-r1-assumption-0', category: 'follow_up', text: 'Clarify the SLA.' }],
    }

    const asked: string[] = []
    const { deps } = makeDeps({
      askQuestion: async q => { asked.push(q.id); return 'Within 4 business hours.' },
      anthropicClient: mockClient(validDraftResponse()),
    })
    const result = await runIntakeToCompletion(session, { clientId: 'client-a', anthropicApiKey: 'fake' }, deps)

    expect(asked).toEqual(['followup-r1-assumption-0'])
    expect(result.status).toBe('ready_for_review')
    expect(result.synthesisAttempts).toHaveLength(2) // continues from round 2, not restarted at round 1
  })
})
