import type { N8nNode, N8nWorkflow } from '../../types/workflow.js'

/**
 * Static (no sandbox) chaos analysis: what an adversarial payload would hit, worked out from
 * the workflow's own structure and expressions rather than by actually running it. Tier B
 * (`chaos/sandbox-run.ts`) confirms these predictions live; this module only predicts.
 *
 * Design-step obligation honored (per plan 9.1.2): before writing this, the existing
 * structure-driven validator rules were checked for overlap. Rules 56/128 only fire once
 * onError is *already set* to a continue-on-fail mode (56: no downstream $json.error check;
 * 128: continueErrorOutput's second port unwired) -- neither one fires for the more basic case
 * this module fills: an external-call node with no onError/retryOnFail posture *at all*, which
 * defaults to stopWorkflow and aborts the whole run silently on the first transient failure.
 * Rule 78 (workflow has no errorWorkflow configured) turned out to already cover "flag absent
 * error-workflow" verbatim -- so this module does not recompute that check; it cross-references
 * Rule 78 instead of duplicating its one-line settings read (see `crossReferencedRules`).
 * Rules 57/59/127/129/130 don't overlap this module's input-driven scope at all (they check
 * parameter shape, not what happens when a referenced field is missing/malformed).
 */

const DISCLAIMER =
  'Static analysis of expressions is heuristic: it looks for a fallback operator (|| or ??) ' +
  'anywhere in the same {{ }} expression block as a field reference, not full control-flow ' +
  'tracing. A field guarded by an upstream IF/Switch node rather than an inline fallback will ' +
  'still be reported here as unguarded -- confirm with `kairos chaos run` (Tier B, needs a ' +
  'sandbox) before treating a finding as certain.'

const CONDITIONAL_NODE_TYPES = new Set(['n8n-nodes-base.if', 'n8n-nodes-base.switch', 'n8n-nodes-base.filter'])

export interface UnguardedFieldRefFinding {
  field: string
  fieldSource: 'body' | 'query' | 'headers'
  nodeName: string
  nodeType: string
  summary: string
}

export interface ExternalCallPostureFinding {
  nodeName: string
  nodeType: string
  summary: string
}

export interface CrossReferencedRuleNote {
  rule: number
  note: string
}

export interface StaticChaosAuditResult {
  disclaimer: string
  unguardedFieldRefs: UnguardedFieldRefFinding[]
  externalCallPostureFindings: ExternalCallPostureFinding[]
  crossReferencedRules: CrossReferencedRuleNote[]
}

// A fresh, separate implementation from webhook-schema.ts's extractWebhookFieldRefs -- that
// function aggregates+dedupes field paths across the whole workflow, discarding which node and
// which expression block each reference came from. This one needs both, so it re-walks
// {{ }} blocks itself rather than reusing that aggregate. Deliberately non-nested (does not
// handle a literal "}}" inside a string literal within an expression) -- consistent with the
// regex-based, not-a-full-parser approach the rest of this codebase already takes.
const EXPRESSION_BLOCK_PATTERN = /\{\{([^}]*)\}\}/g
const FIELD_REF_PATTERN = /\$json\.(body|query|headers)\.([a-zA-Z_$][\w$-]*(?:\.[a-zA-Z_$][\w$-]*)*)/g

interface FieldRefOccurrence {
  source: 'body' | 'query' | 'headers'
  field: string
  guarded: boolean
}

function findFieldRefOccurrences(node: N8nNode): FieldRefOccurrence[] {
  const text = JSON.stringify(node.parameters ?? {})
  const occurrences: FieldRefOccurrence[] = []

  for (const blockMatch of text.matchAll(EXPRESSION_BLOCK_PATTERN)) {
    const block = blockMatch[1] ?? ''
    const guarded = block.includes('||') || block.includes('??')
    for (const fieldMatch of block.matchAll(FIELD_REF_PATTERN)) {
      occurrences.push({ source: fieldMatch[1] as 'body' | 'query' | 'headers', field: fieldMatch[2]!, guarded })
    }
  }
  return occurrences
}

function findUnguardedFieldRefs(workflow: N8nWorkflow): UnguardedFieldRefFinding[] {
  const findings: UnguardedFieldRefFinding[] = []
  for (const node of workflow.nodes) {
    // A conditional node's reference to a field IS the guard -- it branches on
    // presence/absence rather than assuming the field is there, so it cannot "break" the way
    // a Set/Code/HTTP node consuming the same field unguarded can.
    if (CONDITIONAL_NODE_TYPES.has(node.type)) continue

    for (const occ of findFieldRefOccurrences(node)) {
      if (occ.guarded) continue
      findings.push({
        field: occ.field,
        fieldSource: occ.source,
        nodeName: node.name,
        nodeType: node.type,
        summary: `Removing $json.${occ.source}.${occ.field} would break "${node.name}" -- no fallback operator (|| or ??) found in the expression that references it.`,
      })
    }
  }
  return findings
}

function isExternalCallNode(node: N8nNode): boolean {
  if (node.type === 'n8n-nodes-base.httpRequest') return true
  return Boolean(node.credentials && Object.keys(node.credentials).length > 0)
}

function findExternalCallPostureFindings(workflow: N8nWorkflow): ExternalCallPostureFinding[] {
  const findings: ExternalCallPostureFinding[] = []
  for (const node of workflow.nodes) {
    if (!isExternalCallNode(node)) continue
    const hasErrorPosture = node.onError === 'continueRegularOutput' || node.onError === 'continueErrorOutput'
    const hasRetry = node.retryOnFail === true
    if (hasErrorPosture || hasRetry) continue

    findings.push({
      nodeName: node.name,
      nodeType: node.type,
      summary: `"${node.name}" (${node.type}) calls an external service with no onError or retryOnFail set -- a transient failure (timeout, 500) aborts the entire workflow on the spot (n8n's default is stopWorkflow) with no retry attempt.`,
    })
  }
  return findings
}

export function runStaticChaosAudit(workflow: N8nWorkflow): StaticChaosAuditResult {
  return {
    disclaimer: DISCLAIMER,
    unguardedFieldRefs: findUnguardedFieldRefs(workflow),
    externalCallPostureFindings: findExternalCallPostureFindings(workflow),
    crossReferencedRules: [
      { rule: 78, note: 'Missing errorWorkflow configuration is already covered by Rule 78 -- run `kairos lint` for that check; not recomputed here.' },
      { rule: 56, note: 'A node with onError set to a continue-on-fail mode but no downstream $json.error check is covered by Rule 56.' },
      { rule: 128, note: 'A node with onError: "continueErrorOutput" but an unwired error port (index 1) is covered by Rule 128.' },
    ],
  }
}
