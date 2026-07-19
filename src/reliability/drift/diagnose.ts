import type { DriftCheckFinding, DriftCheckId, DriftSeverity } from './checks.js'

/**
 * Maps a drifting finding to a structured diagnosis -- evidence, a confidence-tiered causal
 * statement, a recommended next action, and whether the drift class is a candidate for an
 * automated repair proposal once Phase 3 exists, or escalation-only permanently (an external
 * cause no workflow edit can fix). Same philosophy as Phase A escalation: Kairos's default
 * competent behavior is telling a human precisely what's wrong, not guessing at a cause it
 * can't support.
 *
 * Confidence language is intentionally rigid, not a judgment call per-call (Jordan/Codex,
 * 2026-07-19):
 * - high:   "Likely caused by: <cause>"
 * - medium: "Possible cause: <cause>"
 * - low:    "Observed symptom; cause unknown." -- the cause text is never surfaced at low
 *   confidence, even if one was computed internally; naming an unsupported cause is the
 *   exact overclaiming this module exists to prevent.
 */

export type DiagnosisConfidence = 'high' | 'medium' | 'low'

/**
 * 'mechanical' -- this drift class is a structural candidate for an automated repair proposal
 * (Phase 3, not yet built). NOT a claim that Kairos can fix it today.
 * 'escalation_only' -- the underlying cause is external to the workflow's own structure
 * (latency, load, upstream availability, trigger/credential state) -- no workflow edit fixes
 * it, permanently, regardless of what Phase 3 eventually builds. Per
 * docs/plans/reliability-suite-plan.md 8.2: proposing an edit here would be theater.
 */
export type RepairClass = 'mechanical' | 'escalation_only'

export interface DriftDiagnosisContext {
  workflowId: string
  workflowName?: string
}

export interface DriftDiagnosis {
  checkId: DriftCheckId
  workflowId: string
  workflowName?: string
  /** Node names implicated by this finding's own evidence, when the check operates at node
   * granularity (D1, D3, D4, D7). Absent (not empty-array) for workflow/payload-level checks
   * (D2, D5, D6, D8, D9) -- honest absence, not a fabricated empty result. */
  affectedNodes?: string[]
  severity: DriftSeverity
  evidence: Record<string, unknown>
  confidence: DiagnosisConfidence
  /** The full rendered statement -- "Likely caused by: X" / "Possible cause: X" / "Observed
   * symptom; cause unknown." Never construct this string yourself from `confidence` +
   * internal cause reasoning; use this field so the tiered language is never bypassed. */
  causeStatement: string
  recommendedAction: string
  repairClass: RepairClass
}

function renderCauseStatement(confidence: DiagnosisConfidence, cause: string): string {
  switch (confidence) {
    case 'high': return `Likely caused by: ${cause}`
    case 'medium': return `Possible cause: ${cause}`
    case 'low': return 'Observed symptom; cause unknown.'
  }
}

interface CauseAssignment {
  confidence: DiagnosisConfidence
  cause: string
  recommendedAction: string
  repairClass: RepairClass
  affectedNodes?: string[]
}

/**
 * Per-check causal reasoning, kept separate from the generic diagnoseDrift() wiring below so
 * each check's judgment call is independently readable and independently testable. D1 is the
 * only check whose confidence depends on the finding itself (evidenceQuality) rather than
 * being fixed per check -- every other check's confidence reflects how directly its own
 * signal implies a cause, which doesn't vary call to call. Documented per-check, not just
 * asserted, since this is a judgment call other reviewers should be able to check.
 */
function assignCause(finding: DriftCheckFinding): CauseAssignment {
  switch (finding.id) {
    case 'D1': {
      const nodes = (finding.evidence['newlyErroringNodes'] as Array<{ name: string; errorType: string; httpCode?: string }>) ?? []
      const affectedNodes = nodes.map(n => n.name)
      if (finding.evidenceQuality === 'specific') {
        const detail = nodes.map(n => n.httpCode ? `${n.name}: HTTP ${n.httpCode}` : `${n.name}: ${n.errorType}`).join('; ')
        return {
          confidence: 'high',
          cause: `a classifiable error (${detail}) -- an httpCode in the 4xx range typically indicates an auth/credential or client-side issue, 429 indicates rate limiting, 5xx indicates the external service is failing`,
          recommendedAction: `Investigate the specific error per node (see evidence): ${detail}. A repair proposal will be available once Phase 3 ships; for now, inspect and fix manually.`,
          repairClass: 'mechanical',
          affectedNodes,
        }
      }
      return {
        confidence: 'low',
        cause: '',
        recommendedAction: `Inspect these node(s) manually in n8n: ${affectedNodes.join(', ')}. The error carries no structured classification (no name/httpCode beyond a bare exception), so Kairos cannot narrow the cause further from execution data alone.`,
        repairClass: 'escalation_only',
        affectedNodes,
      }
    }
    case 'D2':
      return {
        confidence: 'medium',
        cause: 'an external dependency (API/service) slowing down, or increased data volume passing through this workflow',
        recommendedAction: 'Check whether an external API/service this workflow depends on has become slower, or whether data volume has increased. Workflow-level timing alone cannot distinguish between these.',
        repairClass: 'escalation_only',
      }
    case 'D3': {
      const affectedNodes = (finding.evidence['missingCoreNodes'] as string[]) ?? []
      return {
        confidence: 'medium',
        cause: 'a node being disabled/removed, or upstream data changing in a way that altered a conditional branch',
        recommendedAction: `Check whether ${affectedNodes.join(', ')} was disabled/removed, or whether upstream data changed a conditional branch. Compare the current workflow structure against the last known-good version.`,
        // Restoring from a snapshot (Phase 3, once built) is a plausible mechanical fix for a
        // missing node -- but that infrastructure doesn't exist yet, so this stays
        // escalation-only until it does, not claimed early.
        repairClass: 'escalation_only',
        affectedNodes,
      }
    }
    case 'D4': {
      const affectedNodes = (finding.evidence['newNodes'] as string[]) ?? []
      return {
        confidence: 'medium',
        cause: 'either an intentional recent edit to the workflow, or an unexpected new code path executing',
        recommendedAction: `Confirm whether ${affectedNodes.join(', ')} is an intentional recent edit, or unexpected. If unintentional, cross-check with D9 (build-vs-live drift) for corroborating evidence.`,
        repairClass: 'escalation_only',
        affectedNodes,
      }
    }
    case 'D5':
      return {
        confidence: 'medium',
        cause: 'a common factor across many runs -- e.g. an external API/service degrading, a credential nearing expiry, or increased load',
        recommendedAction: 'Check for a common root cause across the newly-failing runs. A single node-level fix (see D1 on the same workflow) may not address a workflow-wide rate increase.',
        repairClass: 'escalation_only',
      }
    case 'D6':
      return {
        confidence: 'medium',
        cause: "the workflow's trigger (webhook registration, schedule, or a credential it depends on) becoming inactive or misconfigured",
        recommendedAction: "Check whether the workflow's trigger (webhook registration, schedule, credential) is still active and correctly configured -- a silently-stopped workflow produces no error to alert on by itself.",
        repairClass: 'escalation_only',
      }
    case 'D7': {
      const anomalous = (finding.evidence['anomalousNodes'] as Array<{ name: string }>) ?? []
      const affectedNodes = anomalous.map(n => n.name)
      return {
        confidence: 'medium',
        cause: 'a slow external dependency or growing data volume specific to this node',
        recommendedAction: `Check ${affectedNodes.join(', ')} for a slow external dependency or growing data volume passing through them.`,
        repairClass: 'escalation_only',
        affectedNodes,
      }
    }
    case 'D8':
      return {
        confidence: 'medium',
        cause: "the system sending data to this workflow's webhook changing its integration or payload format",
        recommendedAction: "Check whether the system sending data to this webhook changed its integration/payload format recently. This inference is heuristic (see pack/webhook-schema.ts's DISCLAIMER precedent), not a verified contract.",
        repairClass: 'mechanical',
      }
    case 'D9':
      return {
        confidence: 'high',
        cause: 'the deployed workflow being hand-edited in n8n directly, outside of Kairos, since it was last built or synced',
        recommendedAction: 'Compare the live workflow in n8n against what Kairos originally built (see evidence hashes) to see what changed. If intentional, re-sync Kairos\'s records; if not, consider restoring from the original build.',
        repairClass: 'mechanical',
      }
  }
}

/**
 * Produces a full diagnosis for a drifting finding. Returns null for any non-'drifting'
 * status (insufficient_data / not_applicable / healthy) -- there is nothing to diagnose about
 * those; a caller should surface the finding's own `summary` directly instead of manufacturing
 * a diagnosis for a check that found nothing wrong or couldn't run.
 */
export function diagnoseDrift(finding: DriftCheckFinding, context: DriftDiagnosisContext): DriftDiagnosis | null {
  if (finding.status !== 'drifting') return null

  const assignment = assignCause(finding)

  return {
    checkId: finding.id,
    workflowId: context.workflowId,
    ...(context.workflowName ? { workflowName: context.workflowName } : {}),
    ...(assignment.affectedNodes ? { affectedNodes: assignment.affectedNodes } : {}),
    severity: finding.severity,
    evidence: finding.evidence,
    confidence: assignment.confidence,
    causeStatement: renderCauseStatement(assignment.confidence, assignment.cause),
    recommendedAction: assignment.recommendedAction,
    repairClass: assignment.repairClass,
  }
}

/** Convenience: diagnose every drifting finding in a batch, skipping non-drifting ones. */
export function diagnoseAll(findings: DriftCheckFinding[], context: DriftDiagnosisContext): DriftDiagnosis[] {
  return findings
    .map(f => diagnoseDrift(f, context))
    .filter((d): d is DriftDiagnosis => d !== null)
}
