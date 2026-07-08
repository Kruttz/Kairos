import Anthropic from '@anthropic-ai/sdk'
import type { Kairos } from '../client.js'
import type { CredentialRequirement, BuildProvenance } from '../types/result.js'
import type { ValidationIssue } from '../validation/types.js'
import { extractScheduleIntervals } from '../utils/schedule-intervals.js'

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

Generate a list of 4-8 n8n workflows that would meaningfully automate this business's operations. Focus on workflows that save time on repetitive tasks, improve customer communication, prevent things falling through the cracks, and are realistic to implement with n8n nodes.

For each workflow, write a detailed build description (2-4 sentences) suitable for passing directly to an n8n workflow generator. Be specific: name the trigger type, data sources (Google Sheets columns if applicable), actions, and outputs.

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
      "purpose": "One sentence explaining the business value"
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

function derivePackName(businessContext: string): string {
  return businessContext
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeAssumptions(raw: unknown[]): TypedAssumption[] {
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

  constructor(options: { anthropicApiKey: string; kairos: Kairos; model?: string }) {
    this.client = new Anthropic({ apiKey: options.anthropicApiKey })
    this.kairos = options.kairos
    this.model = options.model ?? 'claude-sonnet-4-6'
  }

  async plan(businessContext: string): Promise<PackPlan> {
    const prompt = PLAN_PROMPT.replace('{CONTEXT}', businessContext)
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
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

    const results: PackWorkflowResult[] = []
    const credentialMap = new Map<string, { service: string; credentialType: string }>()

    for (let i = 0; i < plan.workflows.length; i++) {
      const wf = plan.workflows[i]!
      options.onProgress?.(wf, i, plan.workflows.length)

      try {
        const result = await this.kairos.build(wf.description, {
          name: wf.name,
          dryRun: options.dryRun ?? false,
          activate: effectiveActivate,
        })

        for (const cred of result.credentialsNeeded) {
          credentialMap.set(cred.service, { service: cred.service, credentialType: cred.credentialType })
        }

        const scheduleIntervals = extractScheduleIntervals(result.workflow)

        results.push({
          name: wf.name,
          purpose: wf.purpose,
          workflowId: result.workflowId,
          deployed: !result.dryRun,
          generationAttempts: result.generationAttempts,
          credentialsNeeded: result.credentialsNeeded,
          finalIssues: result.finalIssues,
          ...(scheduleIntervals.length > 0 ? { scheduleIntervals } : {}),
          ...(result.provenance ? { provenance: result.provenance } : {}),
        })
      } catch (err) {
        results.push({
          name: wf.name,
          purpose: wf.purpose,
          workflowId: null,
          deployed: false,
          generationAttempts: 0,
          credentialsNeeded: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

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
