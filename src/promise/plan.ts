import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_MAX_TOKENS } from '../client.js'
import { getKairosVersion } from '../validation/provenance-versions.js'
import { normalizeAssumptions } from '../pack/pack-builder.js'
import { slugifyWorkflowName } from '../pack/pack-bundle.js'
import { validateProcessContract, type ContractValidationIssue } from './validate.js'
import type { ProcessContract } from './types.js'

/**
 * ProcessContract v0, Phase 1 (docs/plans/process-contract-promise-engine-plan.md) --
 * LLM-assisted authoring from a plain-language business description. Deliberately mirrors
 * PackBuilder.plan()'s shape (one LLM call, markdown-fence stripping, JSON.parse, light
 * top-level coercion) rather than inventing a new pattern -- confirmed directly against
 * pack-builder.ts before writing this, not assumed from memory.
 *
 * Unlike PackBuilder, which splits plan() (draft only) from build() (the step that checks for
 * blocking assumptions), this module does both in one call -- Codex's own instruction: "Run the
 * deterministic ProcessContract validator on the draft. If invalid or blocking assumptions
 * exist, return a review/escalation result rather than pretending it is usable." There is no
 * separate "build" step for a contract in Phase 1 (compilation is Phase 2, not built yet), so
 * the contract itself is the artifact this phase produces, and gating happens at the same
 * point it's drafted.
 *
 * Fields the LLM is never asked to author, and which this module always overwrites even if a
 * response includes them: id, version, clientId, provenance, status. These are Kairos's own
 * bookkeeping, not business content -- the same "never trust the model for fields it shouldn't
 * own" discipline BuildProvenance/ContractProvenance already establishes elsewhere.
 */

const PLAN_CONTRACT_PROMPT = `You are drafting a ProcessContract -- a structured description of a business promise, for a system that tracks whether real-world commitments are actually kept. This is NOT a workflow or a technical system description -- it describes an ENTITY (a real-world thing, like a referral or an incident), the STATES that entity's promise instance can be in, the EVENTS that move it between states, and the DEADLINES (SLAs) the business has committed to.

Business description: {DESCRIPTION}

Draft a complete ProcessContract as JSON, matching this exact shape:

{
  "name": "Short descriptive name for this contract",
  "description": "One or two sentences: the plain-language commitment, the sentence a human would actually say out loud.",
  "entity": { "name": "The real-world thing this tracks, e.g. Referral, Incident, Order", "description": "What this entity is." },
  "correlationKey": { "fieldPath": "A dot-path into the start trigger's payload that identifies one instance, e.g. body.phone or body.incidentId", "description": "What this field actually identifies." },
  "promise": { "text": "The commitment, restated as a single sentence." },
  "startConditions": [
    { "id": "sc1", "description": "What creates a new instance", "trigger": "How this is detected -- a webhook, a form, a schedule, etc.", "initialState": "The id of the state a new instance begins in -- must match a state id below" }
  ],
  "states": [
    { "id": "state_id", "name": "Human name", "description": "What this state means", "terminal": false }
  ],
  "events": [
    { "id": "event_id", "name": "Human name", "description": "What real-world signal this represents" }
  ],
  "transitions": [
    { "id": "t1", "fromState": "a real state id", "event": "a real event id", "toState": "a real state id", "condition": "OPTIONAL: a guard, e.g. only after the 3rd attempt -- omit if none" }
  ],
  "terminalOutcomes": [
    { "state": "a state id flagged terminal: true", "outcome": "success | acceptable | failure", "description": "Why this outcome earns this label" }
  ],
  "owners": [
    { "state": "a real state id", "owner": "Free-text role, e.g. intake coordinator, on-call engineer" }
  ],
  "sla": [
    {
      "id": "sla1",
      "measuredFrom": { "state": "a real state id" },
      "expectedBy": { "state": "a real state id" },
      "duration": { "amount": 4, "unit": "minutes | hours | business_hours | business_days" }
    }
  ],
  "exceptions": [
    { "id": "exc1", "condition": "Plain-language description of when a human needs to be alerted, e.g. no contact-attempt evidence 4 business hours after intake", "owner": "Free-text role", "suggestedAction": "What the owner should do -- advisory text only, never an automated action" }
  ],
  "evidenceRequirements": [
    { "transitionId": "a real transition id", "requiredFields": ["exact field names that would prove this transition happened, e.g. callOutcome, callTimestamp"], "description": "What this evidence proves" }
  ],
  "assumptions": [
    { "type": "safe" | "needs_confirmation" | "blocking", "text": "Description of the assumption" }
  ]
}

Four fields above are conditional or optional -- add them to the JSON only when they genuinely apply, never as a placeholder or empty value:

- Add "recurring": { "whileInState": "a real state id" } to an sla entry ONLY if that deadline repeats on a fixed cadence for as long as the instance stays in one state (e.g. a status update every 30 minutes while an incident is open). Omit the field entirely for a normal, one-time deadline -- most SLAs are one-time.
- Add a top-level "businessCalendar": { "timezone": "IANA timezone, e.g. America/Denver", "weeklyHours": [{ "day": "mon", "start": "08:00", "end": "17:00" }, ...one entry per open business day], "holidays": ["OPTIONAL ISO dates"] } ONLY if at least one sla or expirationRules entry uses duration unit business_hours or business_days. Omit this field entirely if every duration unit is minutes/hours (wall-clock, no business-hours limitation) -- do not include an empty or placeholder calendar.
- Add a top-level "pauseRules": [{ "id": "p1", "condition": "when the clock stops", "resumeCondition": "when it starts again" }] ONLY if the business description genuinely describes a condition that should stop an SLA clock (e.g. a customer explicitly asking to be contacted later). Omit entirely otherwise -- most contracts have none.
- Add a top-level "expirationRules": [{ "id": "e1", "state": "a real state id", "after": { "amount": 24, "unit": "business_hours" }, "expiresTo": "a real terminal state id" }] ONLY if a state should automatically resolve to a terminal outcome after a fixed time with nothing happening. Omit entirely otherwise.

For assumptions, classify each one exactly as PackBuilder's own workflow-planning prompt does:
- "safe": a clearly reasonable default the business likely expects.
- "needs_confirmation": should be confirmed before this contract is trusted, but isn't fatal to drafting it.
- "blocking": MUST be resolved before this contract can be considered ready -- a genuinely missing piece of information (e.g. "SLA duration not specified in the description -- assumed 4 hours, confirm with the business"), not a stylistic nitpick.

Every state id, event id, and transition id you reference elsewhere (startConditions.initialState, transitions.fromState/toState/event, terminalOutcomes.state, owners.state, sla.measuredFrom/expectedBy/recurring.whileInState, expirationRules.state/expiresTo, evidenceRequirements.transitionId) MUST exactly match an id you defined in states/events/transitions above -- these will be checked mechanically, and a mismatched id makes the whole contract invalid.

Return ONLY valid JSON with no markdown or extra text.`

export interface PlanProcessContractInput {
  description: string
  clientId: string
  anthropicApiKey: string
  model?: string
  maxTokens?: number
}

/** The one method this module actually calls -- typed narrowly rather than as the full
 * Anthropic SDK client, so tests can inject a minimal mock (matching apply.ts's own
 * runReplayFn-style injectable-for-tests precedent from Phase 3) without needing to satisfy
 * or cast around the real client's much larger surface. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: { model: string; max_tokens: number; messages: Array<{ role: 'user'; content: string }> }): Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export interface PlanContractResult {
  contract: ProcessContract
  validationIssues: ContractValidationIssue[]
  /** True only when validationIssues has no severity: 'error' entries AND the drafted
   * contract has no blocking-type assumption -- ready to move toward a later phase without a
   * human needing to resolve anything specific first. False means the contract is still real
   * and fully human-reviewable (never withheld), just not yet clear to act on. Mirrors
   * Codex's own instruction verbatim: "If invalid or blocking assumptions exist, return a
   * review/escalation result rather than pretending it is usable." */
  readyToProceed: boolean
}

function deriveContractId(name: string): string {
  return slugifyWorkflowName(name) || 'contract'
}

function coerceArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export async function planProcessContract(input: PlanProcessContractInput, anthropicClient?: AnthropicMessagesClient): Promise<PlanContractResult> {
  const client = anthropicClient ?? new Anthropic({ apiKey: input.anthropicApiKey })
  const model = input.model ?? 'claude-sonnet-4-6'
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS

  const prompt = PLAN_CONTRACT_PROMPT.replace('{DESCRIPTION}', input.description)
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0]?.type === 'text' ? (response.content[0].text ?? '').trim() : ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const parsed = JSON.parse(cleaned) as Record<string, unknown>

  const name = typeof parsed['name'] === 'string' ? parsed['name'] : 'Untitled Contract'
  const now = new Date().toISOString()

  const assumptions = normalizeAssumptions(coerceArray<unknown>(parsed['assumptions']))

  const draft = {
    ...parsed,
    // Kairos-owned fields -- always overwritten, regardless of what the model returned.
    id: deriveContractId(name),
    version: 1,
    clientId: input.clientId,
    name,
    startConditions: coerceArray(parsed['startConditions']),
    states: coerceArray(parsed['states']),
    events: coerceArray(parsed['events']),
    transitions: coerceArray(parsed['transitions']),
    terminalOutcomes: coerceArray(parsed['terminalOutcomes']),
    owners: coerceArray(parsed['owners']),
    sla: coerceArray(parsed['sla']),
    exceptions: coerceArray(parsed['exceptions']),
    evidenceRequirements: coerceArray(parsed['evidenceRequirements']),
    assumptions,
    provenance: {
      kairosVersion: getKairosVersion(),
      authoredBy: 'llm_assisted' as const,
      model,
      createdAt: now,
      updatedAt: now,
    },
    // status set below, once validation/blocking-assumption results are known.
    status: 'draft' as const,
  } as ProcessContract

  const validationIssues = validateProcessContract(draft)
  const hasErrors = validationIssues.some(i => i.severity === 'error')
  const hasBlockingAssumption = draft.assumptions.some(a => a.type === 'blocking')
  const readyToProceed = !hasErrors && !hasBlockingAssumption

  const contract: ProcessContract = { ...draft, status: readyToProceed ? 'draft' : 'needs_confirmation' }

  return { contract, validationIssues, readyToProceed }
}
