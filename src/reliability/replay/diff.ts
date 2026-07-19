import type { N8nWorkflow } from '../../types/workflow.js'

/**
 * Compares two sandbox executions of the same payload -- one against the baseline workflow
 * version, one against the candidate -- and produces a verdict that is honest about exactly
 * how much of the workflow that verdict actually covers.
 *
 * **The core discipline this module exists to enforce (Codex, 2026-07-19): no fake
 * equivalence.** In the sandbox, every node with a credential binding has that binding
 * stripped (sandbox/manager.ts's stripCredentialBindings) -- which means, for almost any
 * real Kairos-generated workflow, most nodes past the trigger call an external, credentialed
 * service (CRM, Twilio, Sheets, Slack...) and cannot meaningfully execute here. If baseline
 * and candidate both fail identically at the same credential-stripped node, that is NOT
 * evidence they behave the same -- it is an absence of evidence, and reporting it as a match
 * would imply downstream business behavior was verified when it was not exercised at all.
 *
 * So every comparison here is graded on two independent axes, never collapsed into one:
 * - **verdict** (IDENTICAL / BENIGN_VARIANCE / BEHAVIORAL_CHANGE / BROKEN) -- what changed,
 *   among what could actually be compared.
 * - **verificationBoundary** -- what could and could not be compared, and specifically why
 *   not (credential_stripped vs. downstream_of_unverifiable vs. simply not reached by this
 *   payload's own branch). Whenever the boundary is non-empty, `partialVerification: true`
 *   is set on the result, and every renderer in this codebase must treat that as load-bearing
 *   -- not a footnote a reader can miss, per the CLI formatter below.
 *
 * Credential-dependency is determined structurally, from the real workflow JSON (which node
 * originally had a `.credentials` binding, and everything reachable only through it via the
 * connections graph) -- not by pattern-matching error messages, which would be guessable and
 * fragile. The one deliberate exception: if a node that's structurally credential-adjacent
 * nonetheless shows a genuine successful run on BOTH sides, that observed reality is trusted
 * over the structural assumption (not every credentialed node necessarily throws when
 * uncredentialed; some may no-op or pass through) -- see `bothSucceeded` below.
 */

export type ReplayVerdict = 'IDENTICAL' | 'BENIGN_VARIANCE' | 'BEHAVIORAL_CHANGE' | 'BROKEN'

export type UnverifiableReason = 'credential_stripped' | 'downstream_of_unverifiable'

export interface VerifiedNode {
  node: string
  comparisonBasis: 'output_match' | 'error_class_match' | 'coverage_match'
}

export interface UnverifiableNode {
  node: string
  reason: UnverifiableReason
  detail: string
}

export interface VerificationBoundary {
  verified: VerifiedNode[]
  unverifiable: UnverifiableNode[]
}

export interface NodeDiffEntry {
  node: string
  status: 'match' | 'changed' | 'unverifiable' | 'not_reached_by_this_payload'
  detail: string
  /** Present only when status === 'changed' due to an output-shape difference (not a
   * coverage or error-class change) -- the raw before/after shapes, so any formatter
   * (technical or operator-facing) can build its own field-level breakdown (added/removed/
   * type-changed) without parsing `detail`'s string. Structured first, rendered text second. */
  baselineOutputShape?: Record<string, string>
  candidateOutputShape?: Record<string, string>
}

export interface PayloadDiffResult {
  payloadId: string
  verdict: ReplayVerdict
  verificationBoundary: VerificationBoundary
  nodeDiffs: NodeDiffEntry[]
  /** True whenever verificationBoundary.unverifiable is non-empty. Every consumer of this
   * result (CLI renderer, --json reader, replace --replay's gate) must confront this rather
   * than trusting a clean-looking verdict at face value. */
  partialVerification: boolean
}

export interface ReplayNodeSnapshot {
  ran: boolean
  status: 'success' | 'error' | null
  /** Field name -> simple type tag, one level flattened (e.g. {"customerName": "string",
   * "items": "array"}) -- shape only, never real values, matching the plan's own
   * output-comparison design. */
  outputShape?: Record<string, string>
  errorType?: string
}

export interface ReplayExecutionSnapshot {
  executionId: string
  durationMs?: number
  /** Keyed by node name for direct lookup during diffing. */
  nodes: Record<string, ReplayNodeSnapshot>
}

function credentialStrippedNodeNames(workflow: N8nWorkflow): Set<string> {
  return new Set(workflow.nodes.filter(n => n.credentials && Object.keys(n.credentials).length > 0).map(n => n.name))
}

/** BFS over the workflow's `main` connections only -- AI-specific ports (ai_tool, ai_memory,
 * etc.) are a different execution model this replay engine doesn't target yet; a deliberate,
 * scoped simplification, not an oversight. */
function downstreamClosure(workflow: N8nWorkflow, seeds: Set<string>): Set<string> {
  const closure = new Set(seeds)
  let changed = true
  while (changed) {
    changed = false
    for (const [fromNode, ports] of Object.entries(workflow.connections)) {
      if (!closure.has(fromNode)) continue
      for (const branch of ports.main ?? []) {
        for (const conn of branch) {
          if (!closure.has(conn.node)) {
            closure.add(conn.node)
            changed = true
          }
        }
      }
    }
  }
  return closure
}

function shallowShapeEqual(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const aKeys = Object.keys(a ?? {})
  const bKeys = Object.keys(b ?? {})
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(k => a![k] === b?.[k])
}

const BENIGN_DURATION_RATIO_THRESHOLD = 2.0

/**
 * Compares one payload's baseline-run vs candidate-run snapshot. Both workflows' JSON are
 * required (not just their traces) specifically so credential-dependency can be determined
 * structurally, per the module doc above -- the union of both versions' credentialed nodes
 * is used, since either version could introduce a new one.
 */
export function diffPayloadExecution(
  payloadId: string,
  baselineWorkflow: N8nWorkflow,
  candidateWorkflow: N8nWorkflow,
  baselineSnapshot: ReplayExecutionSnapshot,
  candidateSnapshot: ReplayExecutionSnapshot,
): PayloadDiffResult {
  const baselineCredentialed = credentialStrippedNodeNames(baselineWorkflow)
  const candidateCredentialed = credentialStrippedNodeNames(candidateWorkflow)
  const unverifiableNodeNames = new Set([
    ...downstreamClosure(baselineWorkflow, baselineCredentialed),
    ...downstreamClosure(candidateWorkflow, candidateCredentialed),
  ])

  const allNodeNames = new Set([
    ...Object.keys(baselineSnapshot.nodes),
    ...Object.keys(candidateSnapshot.nodes),
    ...baselineWorkflow.nodes.map(n => n.name),
    ...candidateWorkflow.nodes.map(n => n.name),
  ])

  const verified: VerifiedNode[] = []
  const unverifiable: UnverifiableNode[] = []
  const nodeDiffs: NodeDiffEntry[] = []
  let hasChanged = false
  let hasBroken = false

  for (const name of allNodeNames) {
    const b = baselineSnapshot.nodes[name]
    const c = candidateSnapshot.nodes[name]
    const bothSucceeded = b?.ran === true && c?.ran === true && b.status === 'success' && c.status === 'success'

    if (unverifiableNodeNames.has(name) && !bothSucceeded) {
      const reason: UnverifiableReason = (baselineCredentialed.has(name) || candidateCredentialed.has(name))
        ? 'credential_stripped'
        : 'downstream_of_unverifiable'
      const detail = reason === 'credential_stripped'
        ? 'This node has a credential binding stripped for sandbox execution. It cannot meaningfully run here -- downstream business behavior at and after this node is not verified by this replay, regardless of whether baseline and candidate failed the same way.'
        : 'This node is only reachable through a credential-stripped node. Not independently verifiable.'
      unverifiable.push({ node: name, reason, detail })
      nodeDiffs.push({ node: name, status: 'unverifiable', detail })
      continue
    }

    if (!b?.ran && !c?.ran) {
      nodeDiffs.push({
        node: name,
        status: 'not_reached_by_this_payload',
        detail: 'Neither run executed this node for this payload -- most likely an untaken conditional branch, not a finding.',
      })
      continue
    }

    if ((b?.ran ?? false) !== (c?.ran ?? false)) {
      hasChanged = true
      const detail = `Node coverage differs: ${b?.ran ? 'ran' : 'did not run'} in baseline, ${c?.ran ? 'ran' : 'did not run'} in candidate.`
      verified.push({ node: name, comparisonBasis: 'coverage_match' })
      nodeDiffs.push({ node: name, status: 'changed', detail })
      continue
    }

    // Both ran (or both attempted and errored) -- real, verifiable comparison.
    if (b!.status === 'success' && c!.status === 'success') {
      verified.push({ node: name, comparisonBasis: 'output_match' })
      if (shallowShapeEqual(b!.outputShape, c!.outputShape)) {
        nodeDiffs.push({ node: name, status: 'match', detail: 'Output shape matches.' })
      } else {
        hasChanged = true
        nodeDiffs.push({
          node: name,
          status: 'changed',
          detail: `Output shape differs: baseline ${JSON.stringify(b!.outputShape ?? {})} vs candidate ${JSON.stringify(c!.outputShape ?? {})}.`,
          baselineOutputShape: b!.outputShape ?? {},
          candidateOutputShape: c!.outputShape ?? {},
        })
      }
    } else if (b!.status === 'error' && c!.status === 'error') {
      verified.push({ node: name, comparisonBasis: 'error_class_match' })
      if (b!.errorType === c!.errorType) {
        nodeDiffs.push({ node: name, status: 'match', detail: `Both error identically (${b!.errorType ?? 'unknown'}).` })
      } else {
        hasChanged = true
        nodeDiffs.push({
          node: name,
          status: 'changed',
          detail: `Both error, but with different classes: baseline ${b!.errorType ?? 'unknown'} vs candidate ${c!.errorType ?? 'unknown'}.`,
        })
      }
    } else if (b!.status === 'success' && c!.status === 'error') {
      hasBroken = true
      verified.push({ node: name, comparisonBasis: 'output_match' })
      nodeDiffs.push({ node: name, status: 'changed', detail: `Candidate errors (${c!.errorType ?? 'unknown'}) where baseline succeeded -- this is what BROKEN means.` })
    } else {
      // baseline errored, candidate succeeded -- an improvement, still surfaced (not
      // silently accepted) so a human sees it, but not BROKEN.
      hasChanged = true
      verified.push({ node: name, comparisonBasis: 'output_match' })
      nodeDiffs.push({ node: name, status: 'changed', detail: `Candidate succeeds where baseline errored (${b!.errorType ?? 'unknown'}).` })
    }
  }

  let verdict: ReplayVerdict
  if (hasBroken) {
    verdict = 'BROKEN'
  } else if (hasChanged) {
    verdict = 'BEHAVIORAL_CHANGE'
  } else if (durationDiverges(baselineSnapshot.durationMs, candidateSnapshot.durationMs)) {
    verdict = 'BENIGN_VARIANCE'
  } else {
    verdict = 'IDENTICAL'
  }

  return {
    payloadId,
    verdict,
    verificationBoundary: { verified, unverifiable },
    nodeDiffs,
    partialVerification: unverifiable.length > 0,
  }
}

function durationDiverges(baselineMs: number | undefined, candidateMs: number | undefined): boolean {
  if (baselineMs === undefined || candidateMs === undefined || baselineMs === 0) return false
  return candidateMs / baselineMs > BENIGN_DURATION_RATIO_THRESHOLD || baselineMs / candidateMs > BENIGN_DURATION_RATIO_THRESHOLD
}

export interface ReplaySuiteResult {
  verdict: ReplayVerdict
  partialVerification: boolean
  payloadResults: PayloadDiffResult[]
}

const VERDICT_SEVERITY: Record<ReplayVerdict, number> = { IDENTICAL: 0, BENIGN_VARIANCE: 1, BEHAVIORAL_CHANGE: 2, BROKEN: 3 }

/** A suite's verdict is the single worst verdict among all its payloads -- one BROKEN payload
 * makes the whole suite BROKEN, regardless of how many others were IDENTICAL. */
export function aggregateReplayResults(payloadResults: PayloadDiffResult[]): ReplaySuiteResult {
  const verdict = payloadResults.reduce<ReplayVerdict>(
    (worst, r) => (VERDICT_SEVERITY[r.verdict] > VERDICT_SEVERITY[worst] ? r.verdict : worst),
    'IDENTICAL',
  )
  return {
    verdict,
    partialVerification: payloadResults.some(r => r.partialVerification),
    payloadResults,
  }
}

/**
 * Renders a single payload's result with the verification boundary made loud, not a footnote
 * -- the exact behavior Codex's "no fake equivalence" requirement demands of every consumer,
 * enforced here once so no CLI/report caller has to remember to do it themselves.
 */
export function formatPayloadDiffResult(result: PayloadDiffResult): string {
  const lines: string[] = []
  const marker = result.partialVerification ? ' (PARTIAL VERIFICATION -- see boundary below)' : ''
  lines.push(`Payload ${result.payloadId}: ${result.verdict}${marker}`)

  for (const d of result.nodeDiffs) {
    const symbol = d.status === 'match' ? '✓' : d.status === 'changed' ? '⚠' : d.status === 'unverifiable' ? '?' : '·'
    lines.push(`  ${symbol} ${d.node} [${d.status}] -- ${d.detail}`)
  }

  if (result.partialVerification) {
    lines.push('')
    lines.push('⚠ VERIFICATION BOUNDARY -- this verdict does NOT cover the following, and downstream business behavior at these nodes was not exercised:')
    for (const u of result.verificationBoundary.unverifiable) {
      lines.push(`  ✗ ${u.node} [${u.reason}] -- ${u.detail}`)
    }
  }

  return lines.join('\n')
}

export function formatReplaySuiteResult(suite: ReplaySuiteResult): string {
  const lines: string[] = []
  const marker = suite.partialVerification ? ' (some payloads had partial verification -- see below)' : ''
  lines.push(`Replay suite verdict: ${suite.verdict}${marker}`)
  lines.push(`${suite.payloadResults.length} payload(s) replayed.`)
  lines.push('')
  for (const r of suite.payloadResults) {
    lines.push(formatPayloadDiffResult(r))
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
