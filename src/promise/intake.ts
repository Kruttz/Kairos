import { generateUUID } from '../utils/uuid.js'
import { planProcessContract, type AnthropicMessagesClient, type PlanContractResult } from './plan.js'
import type { ContractValidationIssue } from './validate.js'
import type { ProcessContract } from './types.js'
import type { IntakeQuestion, IntakeQuestionCategory, IntakeSession, IntakeTurn } from './intake-types.js'

/**
 * Intake Interview v0 (roadmap item 4, docs/plans/intake-scenario-harness-plan.md §4).
 *
 * Deliberately does NOT reimplement contract synthesis. A well-formatted transcript of the
 * fixed Q&A pairs below (plus any refinement-round follow-up pairs) is itself a business
 * description -- a better-structured, more complete one than a single free-text paragraph, but
 * still just a description. So the actual synthesis step is `planProcessContract()`
 * (plan.ts) called unmodified with that transcript as `description` -- zero new prompt
 * template, zero new JSON-parsing/coercion code, and this feature inherits every future
 * improvement to plan.ts's own prompt for free. The value this module adds is entirely in the
 * QUESTION-ASKING discipline (a fixed, curated bank forcing complete answers to the specific
 * things both source documents named -- Futrure copy.txt §B/Phase B, FutureForKairos.txt's
 * intake-interview sections) and in the bounded refinement loop, not in a second authoring
 * implementation.
 */

export const INTAKE_QUESTIONS: IntakeQuestion[] = [
  { id: 'q-trigger', category: 'trigger', text: 'What starts this process? (e.g. a webhook, a form submission, a schedule, an email arriving)' },
  { id: 'q-terminal', category: 'terminal', text: 'What counts as this being done -- both a successful outcome and any acceptable-but-not-ideal outcome (e.g. the customer declined)?' },
  { id: 'q-branch', category: 'branch', text: "What can go wrong or branch differently along the way (e.g. an urgent case, a required approval, a retry)?" },
  { id: 'q-exception', category: 'exception', text: 'When something goes wrong, who needs to be alerted, and what should they do about it?' },
  { id: 'q-owner', category: 'owner', text: 'Who is responsible for this process while it is in progress -- and does that change at different stages?' },
  { id: 'q-sla', category: 'sla', text: "What deadlines matter here (e.g. 'contacted within 1 hour', 'resolved within 2 business days')?" },
  { id: 'q-evidence', category: 'evidence', text: 'What system or record would prove each step actually happened (e.g. a CRM note, an email sent, a field in a spreadsheet)?' },
  { id: 'q-handoff', category: 'handoff', text: 'Does this process ever hand off to a different person, team, or system partway through? What does that handoff look like?' },
  { id: 'q-missing-data', category: 'missing_data', text: 'What should happen if required information is missing when this starts?' },
  { id: 'q-duplicate', category: 'duplicate', text: 'What should happen if the same person or entity shows up again while a prior instance is still open, or after one has already closed?' },
  { id: 'q-do-not-automate', category: 'do_not_automate', text: 'Is there any part of this process that should never be fully automated -- something that must always go to a human?' },
]

const MAX_CONTEXT_CHARS = 8000

export function createIntakeSession(clientId: string, now: Date = new Date()): IntakeSession {
  const iso = now.toISOString()
  return {
    id: generateUUID(),
    clientId,
    status: 'in_progress',
    turns: [],
    synthesisAttempts: [],
    pendingFollowUpQuestions: [],
    createdAt: iso,
    updatedAt: iso,
  }
}

/** Walks INTAKE_QUESTIONS in fixed order, returns the first one with no matching turn yet.
 * Null once every fixed question has an answer -- callers move to pending follow-ups /
 * synthesis at that point. */
export function nextUnansweredQuestion(session: IntakeSession): IntakeQuestion | null {
  const answeredIds = new Set(session.turns.map(t => t.questionId))
  return INTAKE_QUESTIONS.find(q => !answeredIds.has(q.id)) ?? null
}

/** Never mutates `session` -- returns a new session with the turn appended, same discipline
 * exception-desk.ts's updateExceptionDesk() already uses for its own inputs. */
export function recordAnswer(session: IntakeSession, question: IntakeQuestion, answer: string, now: Date = new Date()): IntakeSession {
  const iso = now.toISOString()
  const turn: IntakeTurn = {
    id: generateUUID(),
    questionId: question.id,
    category: question.category,
    question: question.text,
    askedAt: iso,
    answer,
    answeredAt: iso,
  }
  return { ...session, turns: [...session.turns, turn], updatedAt: iso }
}

/** Renders the full interview so far as one plain-text business description --
 * planProcessContract()'s own prompt already asks for exactly this shape of input, just
 * normally as one free-text paragraph instead of a structured transcript. */
export function buildIntakeTranscript(session: IntakeSession, contextText?: string): string {
  const lines: string[] = []
  if (contextText) {
    const truncated = contextText.length > MAX_CONTEXT_CHARS
    lines.push('Additional context provided by the operator (may be partial or informal -- the structured interview answers below are authoritative wherever they conflict with this):')
    lines.push(truncated ? contextText.slice(0, MAX_CONTEXT_CHARS) + '\n[... truncated]' : contextText)
    lines.push('')
  }
  lines.push('The following is a structured interview about this business process. Use every answer below -- do not ignore any of them, and do not invent details an answer did not actually state.')
  lines.push('')
  for (const turn of session.turns) {
    lines.push(`Q (${turn.category}): ${turn.question}`)
    lines.push(`A: ${turn.answer}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** One follow-up question per remaining blocking assumption and per remaining validation
 * error -- never a dynamic, open-ended "ask whatever the LLM thinks is missing" question. Kept
 * this narrow deliberately: every follow-up traces back to a specific, named gap the
 * deterministic validator or the synthesis step's own assumption classification already
 * identified, not a second LLM's guess about what to ask next. */
export function buildFollowUpQuestions(issues: ContractValidationIssue[], contract: ProcessContract, round: number): IntakeQuestion[] {
  const questions: IntakeQuestion[] = []
  contract.assumptions
    .filter(a => a.type === 'blocking')
    .forEach((a, i) => {
      questions.push({
        id: `followup-r${round}-assumption-${i}`,
        category: 'follow_up',
        text: `The draft contract still needs clarification on: "${a.text}"\nPlease answer directly so this can be resolved:`,
      })
    })
  issues
    .filter(i => i.severity === 'error')
    .forEach((e, i) => {
      questions.push({
        id: `followup-r${round}-error-${i}`,
        category: 'follow_up',
        text: `The draft has a structural problem: ${e.message}${e.path ? ` (at ${e.path})` : ''}\nHow should this be resolved?`,
      })
    })
  return questions
}

export interface IntakeRunInput {
  clientId: string
  anthropicApiKey: string
  model?: string
  maxTokens?: number
  contextText?: string
}

export interface IntakeRunDeps {
  askQuestion: (question: IntakeQuestion) => Promise<string>
  persistSession: (session: IntakeSession) => Promise<void>
  anthropicClient?: AnthropicMessagesClient
  now?: () => Date
  /** Called right before each synthesis call. A real live checkpoint (2026-07-21) found a
   * genuine synthesis pass over an 11-question transcript takes ~70-90 seconds wall-clock --
   * long enough that a caller with no progress feedback at all would reasonably assume the
   * process had hung. Optional so tests don't need to supply one. */
  onSynthesisStart?: (round: number) => void
}

async function askAndRecord(question: IntakeQuestion, session: IntakeSession, deps: IntakeRunDeps): Promise<IntakeSession> {
  const answer = await deps.askQuestion(question)
  return recordAnswer(session, question, answer, deps.now?.() ?? new Date())
}

/** Asks and persists every question in `session.pendingFollowUpQuestions`, one at a time,
 * removing each from the pending list as it's answered. Used both for a genuinely fresh round
 * of follow-ups and for resuming a session interrupted mid-round -- same loop either way, since
 * the pending list is the only state that matters. */
async function drainPendingFollowUps(session: IntakeSession, deps: IntakeRunDeps): Promise<IntakeSession> {
  let current = session
  while (current.pendingFollowUpQuestions.length > 0) {
    const q = current.pendingFollowUpQuestions[0]!
    current = await askAndRecord(q, current, deps)
    current = { ...current, pendingFollowUpQuestions: current.pendingFollowUpQuestions.slice(1) }
    await deps.persistSession(current)
  }
  return current
}

/**
 * Drives a session from wherever it currently is through to completion: any remaining fixed
 * questions, any pending follow-ups left over from an interrupted round, then synthesis +
 * bounded refinement. Persists after every single answer and after every synthesis attempt --
 * an interrupted session can always resume from exactly where it stopped, never re-asking an
 * already-answered question and never silently re-synthesizing from a partial round.
 *
 * Never withholds the draft: reaching `maxRefinementRounds` without a clean result still saves
 * the last draft and returns status 'needs_more_review', the identical "always show it, never
 * pretend it's ready" rule plan.ts's own one-shot planProcessContract() already follows.
 */
export async function runIntakeToCompletion(
  session: IntakeSession,
  input: IntakeRunInput,
  deps: IntakeRunDeps,
  maxRefinementRounds = 3,
): Promise<IntakeSession> {
  let current = session

  let next = nextUnansweredQuestion(current)
  while (next) {
    current = await askAndRecord(next, current, deps)
    await deps.persistSession(current)
    next = nextUnansweredQuestion(current)
  }

  current = await drainPendingFollowUps(current, deps)

  const startRound = current.synthesisAttempts.length + 1
  for (let round = startRound; round <= maxRefinementRounds; round++) {
    deps.onSynthesisStart?.(round)
    const transcript = buildIntakeTranscript(current, input.contextText)
    const result: PlanContractResult = await planProcessContract(
      {
        description: transcript,
        clientId: input.clientId,
        anthropicApiKey: input.anthropicApiKey,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      },
      deps.anthropicClient,
    )
    const now = deps.now?.() ?? new Date()

    current = {
      ...current,
      draftContract: result.contract,
      synthesisAttempts: [
        ...current.synthesisAttempts,
        {
          round,
          attemptedAt: now.toISOString(),
          validationIssues: result.validationIssues,
          blockingAssumptionCount: result.contract.assumptions.filter(a => a.type === 'blocking').length,
          readyToProceed: result.readyToProceed,
        },
      ],
      updatedAt: now.toISOString(),
    }
    await deps.persistSession(current)

    if (result.readyToProceed) {
      current = { ...current, status: 'ready_for_review' }
      await deps.persistSession(current)
      return current
    }

    if (round === maxRefinementRounds) break

    const followUps = buildFollowUpQuestions(result.validationIssues, result.contract, round)
    current = { ...current, pendingFollowUpQuestions: followUps }
    await deps.persistSession(current)

    current = await drainPendingFollowUps(current, deps)
  }

  current = { ...current, status: 'needs_more_review' }
  await deps.persistSession(current)
  return current
}

export type { IntakeQuestion, IntakeQuestionCategory, IntakeSession, IntakeTurn }
