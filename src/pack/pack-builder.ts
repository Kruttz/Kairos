import Anthropic from '@anthropic-ai/sdk'
import type { Kairos } from '../client.js'
import { DEFAULT_MAX_TOKENS } from '../client.js'
import type { CredentialRequirement, BuildProvenance } from '../types/result.js'
import type { ValidationIssue } from '../validation/types.js'
import { extractScheduleIntervals } from '../utils/schedule-intervals.js'
import { assignWorkflowKeys, resolveBuildOrder, seedAvailabilityMap, canBuildWithDependencies } from './dependency-graph.js'
import type { AvailabilityMap } from './dependency-graph.js'
import { toWorkflowReference } from './workflow-reference.js'
import type { WorkflowReference } from './workflow-reference.js'
import { slugifyWorkflowName } from './pack-bundle.js'

export type AssumptionType = 'safe' | 'needs_confirmation' | 'blocking'
export type PackStatus = 'draft' | 'blocked' | 'ready_for_test' | 'ready_for_activation' | 'active' | 'needs_attention'

export interface TypedAssumption {
  type: AssumptionType
  text: string
}

export interface WorkflowPlan {
  name: string
  description: string
  purpose: string
  /**
   * Stable key derived from `name` at plan-normalization time (see
   * src/pack/dependency-graph.ts's assignWorkflowKeys()) -- absent on a freshly-parsed plan
   * straight from the LLM, populated before build() runs. Dependency declarations resolve to
   * this, never to raw display names, since two workflows can share a name.
   */
  workflowKey?: string
  /**
   * Raw, untrusted dependency declaration straight from the LLM's plan JSON -- other
   * workflows' *names* (not keys) that this workflow needs to reference. Deliberately typed
   * `unknown`, not `string[]`: resolveBuildOrder()'s own job (src/pack/dependency-graph.ts) is
   * to validate this into a well-formed, resolved form, so the type must allow arriving as
   * anything (missing, a bare string, an array of numbers, ...) for that validation to have
   * something real to check. Never read this field directly -- always go through
   * resolveBuildOrder()'s resolvedDependsOn output.
   */
  dependsOn?: unknown
}

export interface PackPlan {
  businessContext: string
  workflows: WorkflowPlan[]
  assumptions: TypedAssumption[]
  sheetsColumns: Array<{ sheet: string; columns: string[] }>
  testChecklist: Array<{ workflow: string; steps: string[] }>
}

export interface PackWorkflowResult {
  name: string
  purpose: string
  workflowId: string | null
  deployed: boolean
  generationAttempts: number
  credentialsNeeded: CredentialRequirement[]
  error?: string
  /**
   * Normalized rule.interval arrays from every scheduleTrigger node in this
   * workflow (one entry per trigger node), used by validatePack() to detect
   * cross-workflow schedule conflicts. Absent on workflows that errored
   * before a workflow JSON was produced, on workflows with no schedule
   * trigger, and on packs persisted before this field existed.
   */
  scheduleIntervals?: unknown[][]
  /**
   * The final generation attempt's structured validation issues (see BuildResult.finalIssues).
   * Absent on packs persisted before this field existed and on workflows that errored before
   * a build result was produced — treat undefined as "no structured data available", not "no issues".
   */
  finalIssues?: ValidationIssue[]
  /**
   * This workflow's actual build-time provenance (see BuildResult.provenance) -- carried
   * through from Kairos.build()'s result rather than re-derived, so it reflects what was
   * genuinely true the moment THIS workflow was generated, not whatever the pack-level export
   * step considers "current" later. Absent on packs persisted before this field existed and
   * on workflows that errored before a build result was produced.
   */
  provenance?: BuildProvenance
  /**
   * This workflow's assigned dependency-graph key (see assignWorkflowKeys()) -- persisted so
   * the dependency topology resolveBuildOrder() computed doesn't disappear after one build()
   * call. Present for every workflow, built or rejected. Absent on packs persisted before
   * chaining existed.
   */
  workflowKey?: string
  /**
   * This workflow's final, resolved-and-deduplicated dependency keys (see
   * resolveBuildOrder()'s resolvedDependsOn) -- not the raw LLM-provided names. May be absent
   * or partial on a rejected workflow, depending on which validation pass rejected it (a
   * workflow rejected for a malformed or unresolvable dependsOn never produced a resolvable
   * edge set at all). Absent on packs persisted before chaining existed.
   */
  dependsOn?: string[]
}

/**
 * Returned instead of building anything when a pack has blocking assumptions and the caller
 * hasn't opted to build despite them (`buildDespiteBlocking: true`) — stops before any
 * generation spend, rather than building every workflow and only refusing activation at the end.
 */
export interface EscalationInfo {
  reason: string
  questions: string[]
  source: 'blocking_assumptions'
}

export interface WorkflowPackResult {
  businessContext: string
  packName: string
  status: PackStatus
  workflows: PackWorkflowResult[]
  allCredentials: Array<{ service: string; credentialType: string }>
  sheetsColumns: Array<{ sheet: string; columns: string[] }>
  assumptions: TypedAssumption[]
  testChecklist: Array<{ workflow: string; steps: string[] }>
  builtAt: string
  escalation?: EscalationInfo
}

export function derivePackStatus(
  pack: Pick<WorkflowPackResult, 'assumptions' | 'workflows'> & { status?: PackStatus }
): PackStatus {
  const hasBlocking = pack.assumptions.some(a => a.type === 'blocking')
  const hasFailures = pack.workflows.some(w => w.error)
  const allDeployed = pack.workflows.length > 0 && pack.workflows.every(w => w.deployed)
  const hasNeedsConfirmation = pack.assumptions.some(a => a.type === 'needs_confirmation')

  // Preserve active status if the pack is still in a healthy deployed state
  if (pack.status === 'active' && !hasBlocking && !hasFailures && allDeployed) return 'active'

  if (pack.workflows.length === 0 || (!allDeployed && !hasFailures)) return 'draft'
  if (hasBlocking) return 'blocked'
  if (hasFailures) return 'needs_attention'
  if (hasNeedsConfirmation) return 'ready_for_test'
  return 'ready_for_activation'
}

const PLAN_PROMPT = `You are planning an n8n workflow automation pack for a business.

Business context: {CONTEXT}

Generate a list of 4-8 n8n workflows that would meaningfully automate this business's operations -- UNLESS the business context above explicitly states a specific number or an explicit list of workflows to build (e.g. "exactly two workflows", "build only these three: ..."), in which case build precisely that scope instead, even if it is fewer than 4 or more than 8. An explicit scope in the business context always overrides this default range. Focus on workflows that save time on repetitive tasks, improve customer communication, prevent things falling through the cracks, and are realistic to implement with n8n nodes.

For each workflow, write a detailed build description (2-4 sentences) suitable for passing directly to an n8n workflow generator. Be specific: name the trigger type, data sources (Google Sheets columns if applicable), actions, and outputs.

If a workflow needs to reference something another workflow in this same pack produces (e.g. a confirmation email that mentions the intake webhook's real path, or a summary that reports on a workflow that runs earlier), declare that with "dependsOn": an array of the OTHER workflow's exact "name" values from this same response. Only declare a dependency when the workflow genuinely needs to reference the other one's actual output — most workflows have no dependencies at all, and that's the normal case. Example: a "Missed-Call Text-Back" workflow and a "Daily Missed-Call Summary" workflow that reports on calls handled by the first would have the summary workflow declare "dependsOn": ["Missed-Call Text-Back"]. Omit "dependsOn" entirely for a workflow with no dependencies — do not include an empty array unless the workflow genuinely has zero dependencies and you want to be explicit about it.

For assumptions, classify each one:
- "safe": a clearly reasonable default the business likely expects (e.g. "Schedule runs Monday 9 AM")
- "needs_confirmation": should be confirmed before going live but won't break things immediately (e.g. "Assumed professional email tone — confirm brand voice")
- "blocking": MUST be resolved before activation or the workflow will fail, send duplicates, or surprise customers (e.g. "Google Sheet ID not provided", "emails auto-send without approval gate — add confirmation step")

Treat any open question that would block safe deployment as a blocking assumption.

Return ONLY valid JSON with no markdown or extra text:
{
  "workflows": [
    {
      "name": "Short descriptive name",
      "description": "Detailed generator-ready description specifying trigger, data sources, actions, outputs",
      "purpose": "One sentence explaining the business value",
      "dependsOn": ["Exact name of another workflow in this same list, only if genuinely needed -- omit this field entirely otherwise"]
    }
  ],
  "assumptions": [
    { "type": "safe" | "needs_confirmation" | "blocking", "text": "Description of the assumption" }
  ],
  "sheetsColumns": [
    { "sheet": "Sheet name", "columns": ["col1", "col2"] }
  ],
  "testChecklist": [
    { "workflow": "Workflow name", "steps": ["How to manually test this workflow"] }
  ]
}`

/** Reuses slugifyWorkflowName()'s 60-char cap rather than a second, uncapped slug
 * implementation -- a real-model spot-check (Step 9) crashed on save (ENAMETOOLONG) when a
 * realistic full-paragraph business context produced a 400+ char filename; short synthetic
 * test contexts never surfaced this. */
function derivePackName(businessContext: string): string {
  return slugifyWorkflowName(businessContext)
}

/** Exported so src/promise/plan.ts (ProcessContract's own LLM-assisted authoring, Phase 1 of
 * docs/plans/process-contract-promise-engine-plan.md) can reuse this exact normalization rather
 * than duplicating it -- Codex's own instruction was to reuse PackBuilder's
 * assumptions/blocking-escalation pattern "where appropriate," and a second, drifted copy of
 * the same three-tier coercion logic is exactly the kind of duplication that instruction is
 * meant to avoid. */
export function normalizeAssumptions(raw: unknown[]): TypedAssumption[] {
  const validTypes = new Set<string>(['safe', 'needs_confirmation', 'blocking'])
  return raw.map((a): TypedAssumption => {
    if (typeof a === 'string') {
      return { type: 'needs_confirmation', text: a }
    }
    if (typeof a === 'object' && a !== null) {
      const obj = a as Record<string, unknown>
      const type = typeof obj['type'] === 'string' && validTypes.has(obj['type'])
        ? (obj['type'] as AssumptionType)
        : 'needs_confirmation'
      const text = typeof obj['text'] === 'string' ? obj['text'] : JSON.stringify(obj)
      return { type, text }
    }
    return { type: 'needs_confirmation', text: String(a) }
  })
}

export class PackBuilder {
  private client: Anthropic
  private kairos: Kairos
  private model: string
  /** Used only to construct a chained dependency's webhookUrl (see toWorkflowReference()) --
   * Kairos itself doesn't expose the n8nBaseUrl it was constructed with, so PackBuilder needs
   * its own copy for this one purpose. Falls back to N8N_BASE_URL, matching the same env var
   * Kairos/the CLI already read. Absence just means webhookUrl never populates -- never
   * fabricated, per Step 7 v4 §5. */
  private n8nBaseUrl: string | undefined
  /** Was hardcoded at 4096 -- too small for even a 3-workflow plan (found via a real-model
   * spot-check, Step 9 of docs/plans/hardening-and-chaining-plan.md: the response was silently
   * truncated mid-JSON-string). Reuses client.ts's DEFAULT_MAX_TOKENS/KAIROS_MAX_TOKENS
   * convention rather than a second hardcoded magic number. */
  private maxTokens: number

  constructor(options: { anthropicApiKey: string; kairos: Kairos; model?: string; n8nBaseUrl?: string; maxTokens?: number }) {
    this.client = new Anthropic({ apiKey: options.anthropicApiKey })
    this.kairos = options.kairos
    this.model = options.model ?? 'claude-sonnet-4-6'
    this.n8nBaseUrl = options.n8nBaseUrl ?? process.env['N8N_BASE_URL']
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  }

  async plan(businessContext: string): Promise<PackPlan> {
    const prompt = PLAN_PROMPT.replace('{CONTEXT}', businessContext)
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    const rawAssumptions = Array.isArray(parsed['assumptions']) ? parsed['assumptions'] : []
    // Fold legacy openQuestions into needs_confirmation assumptions
    const rawOpenQuestions = Array.isArray(parsed['openQuestions']) ? parsed['openQuestions'] : []

    const assumptions = normalizeAssumptions([...rawAssumptions, ...rawOpenQuestions.map((q: unknown) =>
      typeof q === 'string' ? { type: 'needs_confirmation', text: q } : q
    )])

    return {
      businessContext,
      workflows: Array.isArray(parsed['workflows']) ? (parsed['workflows'] as WorkflowPlan[]) : [],
      assumptions,
      sheetsColumns: Array.isArray(parsed['sheetsColumns'])
        ? (parsed['sheetsColumns'] as PackPlan['sheetsColumns'])
        : [],
      testChecklist: Array.isArray(parsed['testChecklist'])
        ? (parsed['testChecklist'] as PackPlan['testChecklist'])
        : [],
    }
  }

  async build(
    plan: PackPlan,
    options: {
      dryRun?: boolean
      activate?: boolean
      /** Build anyway despite blocking assumptions — activation is still suppressed regardless. */
      buildDespiteBlocking?: boolean
      onProgress?: (workflow: WorkflowPlan, index: number, total: number) => void
    } = {}
  ): Promise<WorkflowPackResult> {
    const hasBlockingAssumptions = plan.assumptions.some(a => a.type === 'blocking')

    // Stop before any generation spend when blocking assumptions exist, rather than building
    // every workflow and only refusing activation at the end. Blocking assumption texts are
    // presented as-is in `questions` (not mechanically reworded into question form) — they
    // already describe exactly what needs resolving, and an automatic statement->question
    // transform risks producing more confusing text than the original.
    if (hasBlockingAssumptions && !options.buildDespiteBlocking) {
      const questions = plan.assumptions.filter(a => a.type === 'blocking').map(a => a.text)
      return {
        businessContext: plan.businessContext,
        packName: derivePackName(plan.businessContext),
        status: 'blocked',
        workflows: [],
        allCredentials: [],
        sheetsColumns: plan.sheetsColumns,
        assumptions: plan.assumptions,
        testChecklist: plan.testChecklist,
        builtAt: new Date().toISOString(),
        escalation: {
          reason: 'This pack has blocking assumptions that must be resolved before building. Resolve them and re-plan, or pass buildDespiteBlocking: true to build anyway (activation will still be suppressed).',
          questions,
          source: 'blocking_assumptions',
        },
      }
    }

    // Never activate when blocking assumptions exist — safety gate
    const effectiveActivate = hasBlockingAssumptions ? false : (options.activate ?? false)

    // Step 7 v4's dependency-graph pipeline: assign stable keys, then validate/order against
    // them. `order` (Pass 6's topological sort) is the EXECUTION sequence -- it never contains
    // a rejected workflow, and does not necessarily match plan.workflows' original order. The
    // RETURNED array must still match original plan order regardless (see the reassembly at
    // the end of this method) -- these are two deliberately decoupled concerns.
    const keyedWorkflows = assignWorkflowKeys(plan.workflows)
    const { order, rejected, resolvedDependsOn } = resolveBuildOrder(keyedWorkflows)
    const availability: AvailabilityMap = seedAvailabilityMap(rejected)

    const resultsByKey = new Map<string, PackWorkflowResult>()
    const credentialMap = new Map<string, { service: string; credentialType: string }>()
    let progressIndex = 0
    const totalWorkflows = plan.workflows.length

    // Every rejected workflow (Passes 1/2/4/5 of resolveBuildOrder()) never enters the build
    // loop at all -- no generation spend, synthesized directly. This runs before the loop below
    // so `resultsByKey` already has an entry for every rejected key by the time anything checks
    // dependencies against it (mirrors seedAvailabilityMap()'s "pre-seed before building starts").
    for (const [workflowKey, reasons] of rejected) {
      const wf = keyedWorkflows.find((w) => w.workflowKey === workflowKey)!
      options.onProgress?.(wf, progressIndex++, totalWorkflows)
      resultsByKey.set(workflowKey, {
        name: wf.name,
        purpose: wf.purpose,
        workflowId: null,
        deployed: false,
        generationAttempts: 0,
        credentialsNeeded: [],
        error: `Rejected before generation: ${reasons.map((r) => `${r.reason} (${r.detail})`).join('; ')}`,
        workflowKey,
        dependsOn: resolvedDependsOn.get(workflowKey) ?? [],
      })
    }

    // Execution proper: build order (commit 4), gated by the cascading availability check
    // (commit 7) -- a workflow whose dependency is unavailable (rejected above, or a prior
    // iteration's build failure) is skipped here too, with zero generation spend, and marked
    // unavailable itself so its own dependents cascade correctly.
    for (const wf of order) {
      options.onProgress?.(wf, progressIndex++, totalWorkflows)
      const dependsOnKeys = resolvedDependsOn.get(wf.workflowKey) ?? []

      if (!canBuildWithDependencies(availability, dependsOnKeys)) {
        const unavailableKeys = dependsOnKeys.filter((k) => availability.get(k) === 'unavailable' || !availability.has(k))
        availability.set(wf.workflowKey, 'unavailable')
        resultsByKey.set(wf.workflowKey, {
          name: wf.name,
          purpose: wf.purpose,
          workflowId: null,
          deployed: false,
          generationAttempts: 0,
          credentialsNeeded: [],
          error: `Not built: required dependenc${unavailableKeys.length === 1 ? 'y' : 'ies'} unavailable (${unavailableKeys.join(', ')})`,
          workflowKey: wf.workflowKey,
          dependsOn: dependsOnKeys,
        })
        continue
      }

      const priorContext: WorkflowReference[] = dependsOnKeys.map((k) => availability.get(k) as WorkflowReference)

      try {
        const result = await this.kairos.build(wf.description, {
          name: wf.name,
          dryRun: options.dryRun ?? false,
          activate: effectiveActivate,
          ...(priorContext.length > 0 ? { priorContext } : {}),
        })

        for (const cred of result.credentialsNeeded) {
          credentialMap.set(cred.service, { service: cred.service, credentialType: cred.credentialType })
        }

        const scheduleIntervals = extractScheduleIntervals(result.workflow)

        availability.set(wf.workflowKey, toWorkflowReference(result, wf.workflowKey, this.n8nBaseUrl))
        resultsByKey.set(wf.workflowKey, {
          name: wf.name,
          purpose: wf.purpose,
          workflowId: result.workflowId,
          deployed: !result.dryRun,
          generationAttempts: result.generationAttempts,
          credentialsNeeded: result.credentialsNeeded,
          finalIssues: result.finalIssues,
          ...(scheduleIntervals.length > 0 ? { scheduleIntervals } : {}),
          ...(result.provenance ? { provenance: result.provenance } : {}),
          workflowKey: wf.workflowKey,
          dependsOn: dependsOnKeys,
        })
      } catch (err) {
        availability.set(wf.workflowKey, 'unavailable')
        resultsByKey.set(wf.workflowKey, {
          name: wf.name,
          purpose: wf.purpose,
          workflowId: null,
          deployed: false,
          generationAttempts: 0,
          credentialsNeeded: [],
          error: err instanceof Error ? err.message : String(err),
          workflowKey: wf.workflowKey,
          dependsOn: dependsOnKeys,
        })
      }
    }

    // Result-array reassembly (Step 7 v4 §11): the RETURNED array always matches
    // plan.workflows' original order, regardless of the execution order above -- every
    // existing consumer (CLI progress index, onProgress, handoff.md/credentials.md rendering)
    // assumes that correspondence, and chaining must not silently break it.
    const results = keyedWorkflows.map((wf) => resultsByKey.get(wf.workflowKey)!)

    const partial = {
      businessContext: plan.businessContext,
      packName: derivePackName(plan.businessContext),
      status: 'draft' as PackStatus,
      workflows: results,
      allCredentials: Array.from(credentialMap.values()),
      sheetsColumns: plan.sheetsColumns,
      assumptions: plan.assumptions,
      testChecklist: plan.testChecklist,
      builtAt: new Date().toISOString(),
    }

    return { ...partial, status: derivePackStatus(partial) }
  }
}
