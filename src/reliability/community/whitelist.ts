import type { Pattern, PipelineStage } from '../../telemetry/pattern-analyzer.js'
import { getKairosVersion } from '../../validation/provenance-versions.js'

/**
 * Whitelist-only, by construction (docs/plans/reliability-suite-plan.md §10.2): this is the
 * complete set of fields a pattern can carry once it leaves the machine. Free text
 * (Pattern.exampleMessages embeds the user's own node names inline in undelimited prose --
 * confirmed directly against validator.ts's message call sites), workflow-type breakdowns,
 * and canned mitigation text (redundant -- every install already has the same static lookup
 * table locally) are not fields on this type at all. Nothing to scrub, because nothing else
 * can exist here. `kind` is reserved now so a future drift-check-ID / chaos-verdict-enum
 * variant can be added additively later without breaking this type -- there is no real data
 * to populate such a variant with yet (drift/chaos findings aren't persisted into any
 * aggregated, cross-session corpus today, only the validator-rule corpus is), so only the
 * 'validator-rule' kind actually exists in v1.
 */
export interface WhitelistedPattern {
  kind: 'validator-rule'
  rule: number
  pipelineStage: PipelineStage
  failureCount: number
  confidence: number
}

export interface PatternShareReport {
  kairosVersion: string
  generatedAt: string
  patterns: WhitelistedPattern[]
}

function toWhitelistedPattern(p: Pattern): WhitelistedPattern {
  return {
    kind: 'validator-rule',
    rule: p.rule,
    pipelineStage: p.pipelineStage,
    failureCount: p.failureCount,
    confidence: p.confidence,
  }
}

/**
 * Only `state === 'confirmed'` patterns are eligible -- stricter than strictly required, but
 * a pattern a human hasn't already locally confirmed (via `kairos patterns approve`)
 * shouldn't be the thing that leaves the machine first.
 */
export function buildPatternShareReport(patterns: Pattern[]): PatternShareReport {
  return {
    kairosVersion: getKairosVersion(),
    generatedAt: new Date().toISOString(),
    patterns: patterns.filter(p => p.state === 'confirmed').map(toWhitelistedPattern),
  }
}
