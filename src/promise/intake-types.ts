import type { ContractValidationIssue } from './validate.js'
import type { ProcessContract } from './types.js'

/**
 * Intake Interview v0 (roadmap item 4, docs/plans/intake-scenario-harness-plan.md §4).
 *
 * Deliberately a fixed, ordered question bank plus ONE synthesis call over the full transcript
 * -- not an LLM call per turn. Two reasons, both load-bearing: (1) it directly reuses
 * plan.ts's existing single-call pattern (prompt -> parse -> validate) almost unchanged, rather
 * than inventing a new incremental-JSON-merge design with no real precedent in this codebase;
 * (2) it keeps the question-asking half of this feature fully deterministic and testable with
 * zero LLM mocking, isolating the one real non-determinism (contract synthesis) to a single,
 * already-proven call shape.
 */

export type IntakeQuestionCategory =
  | 'trigger'
  | 'terminal'
  | 'branch'
  | 'exception'
  | 'owner'
  | 'sla'
  | 'evidence'
  | 'handoff'
  | 'missing_data'
  | 'duplicate'
  | 'do_not_automate'
  /** Generated during a refinement round (one per remaining blocking assumption or validation
   * error after a synthesis attempt) -- never part of the fixed bank itself. */
  | 'follow_up'

export interface IntakeQuestion {
  id: string
  category: IntakeQuestionCategory
  text: string
}

export interface IntakeTurn {
  id: string
  questionId: string
  category: IntakeQuestionCategory
  question: string
  askedAt: string
  answer: string
  answeredAt: string
}

/** One synthesis call's result, kept for audit/status purposes -- lets `intake status` show
 * whether refinement is actually converging (fewer issues each round) rather than just
 * reporting a final pass/fail with no visibility into the rounds in between. */
export interface IntakeSynthesisAttempt {
  round: number
  attemptedAt: string
  validationIssues: ContractValidationIssue[]
  blockingAssumptionCount: number
  readyToProceed: boolean
}

export interface IntakeSession {
  id: string
  clientId: string
  /** 'ready_for_review' -- a synthesis round produced a contract with no blocking assumptions
   * and no validation errors. 'needs_more_review' -- the refinement-round cap was reached
   * without getting there; the draft is still saved and shown in full, never withheld, exactly
   * like a single-shot `contract plan` draft that needed review. */
  status: 'in_progress' | 'ready_for_review' | 'needs_more_review'
  turns: IntakeTurn[]
  synthesisAttempts: IntakeSynthesisAttempt[]
  /** Non-empty only mid-refinement-round, between generating follow-up questions and finishing
   * asking all of them -- lets a resumed session pick up exactly where an interruption left off,
   * the same resumability guarantee the fixed-question phase already has, rather than silently
   * re-synthesizing from a partially-answered round. */
  pendingFollowUpQuestions: IntakeQuestion[]
  /** Present once at least one synthesis call has run. Absent while only fixed questions have
   * been answered and no draft exists yet. */
  draftContract?: ProcessContract
  createdAt: string
  updatedAt: string
}
