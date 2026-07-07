import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { WorkflowMatch } from '../library/types.js'
import type { RuleFailureRate } from '../telemetry/reader.js'
import type { PatternAnalysis, Pattern } from '../telemetry/pattern-analyzer.js'
import type { DesignRequest, BuiltPrompt, SystemPromptBlock } from './types.js'
import { SYSTEM_PROMPT_V1 } from './prompts/v1.js'
import { scoreToMode } from '../utils/thresholds.js'
import { RULE_MITIGATIONS, RULE_EXAMPLES } from '../validation/rule-metadata.js'
import { selectSubPatterns, formatSubPatterns } from '../library/sub-pattern-selector.js'
import { classifyIntent, formatIntentRequirements } from '../library/intent-map.js'

const CRITICAL_SCORE_THRESHOLD = 0.15

type PromptProfile = 'minimal' | 'standard' | 'rich'

function resolveProfile(): PromptProfile {
  const env = process.env['KAIROS_PROMPT_PROFILE']
  if (env === 'minimal' || env === 'standard' || env === 'rich') return env
  return 'standard'
}

const PROACTIVE_EXPRESSION_GUIDANCE = `## Expression Syntax Quick Reference\n\nAlways use these patterns in expressions:\n- Access node data:  $('NodeName').item.json.field  (not $node["NodeName"].json)\n- Access JSON field: $json.field  (not $json.items[0].field)\n- Single item:       $('NodeName').first().json.field\n- All items:         $('NodeName').all()`

export class PromptBuilder {
  private readonly patternsPath: string
  private readonly profile: PromptProfile
  private _lastActivePatterns: Pattern[] | null = null

  constructor(patternsPath?: string, profile?: PromptProfile) {
    this.patternsPath = patternsPath ?? join(homedir(), '.kairos', 'patterns.json')
    this.profile = profile ?? resolveProfile()
  }

  private resolveMaxPatterns(): number {
    if (this.profile === 'minimal') return 3
    if (this.profile === 'rich') return 15
    return 10
  }

  build(request: DesignRequest, matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[] = [], dynamicCatalog?: string, clientContext?: string): BuiltPrompt {
    const mode = this.resolveMode(matches)
    const system = this.buildSystem(matches, mode, globalFailureRates, dynamicCatalog, request.description, clientContext)
    const userMessage = this.buildUserMessage(request, matches, mode)
    return { system, userMessage, mode, matches }
  }

  buildCorrectionMessage(
    request: DesignRequest,
    matches: WorkflowMatch[],
    allIssues: string[],
    attempt: number,
    failingRuleIds?: number[],
  ): string {
    const base = this.buildUserMessage(request, matches, this.resolveMode(matches))

    let examplesSection = ''
    if (failingRuleIds && failingRuleIds.length > 0) {
      const uniqueRules = [...new Set(failingRuleIds)]
      const exampleLines: string[] = []
      for (const rule of uniqueRules) {
        const ex = RULE_EXAMPLES[rule]
        if (ex) {
          exampleLines.push(`Rule ${rule}:\n  Bad:  ${ex.bad}\n  Good: ${ex.good}`)
        }
      }
      if (exampleLines.length > 0) {
        examplesSection = `\n\n## Concrete Fix Examples\n${exampleLines.join('\n\n')}`
      }
    }

    return `${base}

IMPORTANT: A previous generation attempt (attempt ${attempt}) failed validation with these issues:
${allIssues.join('\n')}

Fix ALL of the above issues in your new response. Do not repeat any of these mistakes.${examplesSection}`
  }

  private resolveMode(matches: WorkflowMatch[]): 'direct' | 'reference' | 'scratch' {
    if (matches.length === 0) return 'scratch'
    const top = matches[0]
    if (!top) return 'scratch'
    return scoreToMode(top.score)
  }

  private buildSystem(matches: WorkflowMatch[], mode: 'direct' | 'reference' | 'scratch', globalFailureRates: RuleFailureRate[] = [], dynamicCatalog?: string, description?: string, clientContext?: string): SystemPromptBlock[] {
    let basePrompt = SYSTEM_PROMPT_V1
    if (dynamicCatalog) {
      basePrompt = basePrompt.replace(
        /## NODE CATALOG — exact type strings and safe typeVersions[\s\S]*?(?=## PRE-DELIVERY SELF-CHECK)/,
        dynamicCatalog + '\n\n',
      )
    }

    const blocks: SystemPromptBlock[] = [
      {
        type: 'text',
        text: basePrompt,
        cache_control: { type: 'ephemeral' },
      },
    ]

    if (this.profile !== 'minimal') {
      if (mode === 'reference' && matches.length > 0) {
        const refText = matches
          .slice(0, 3)
          .map((m) => {
            const nodes = m.workflow.workflow.nodes
              .map((n) => `  - ${n.name} (${n.type} v${n.typeVersion})`)
              .join('\n')
            return `Reference workflow: "${m.workflow.description}" (similarity: ${m.score.toFixed(2)})\nNodes:\n${nodes}`
          })
          .join('\n\n')

        blocks.push({
          type: 'text',
          text: `## Similar Workflows From Library (for reference only — adapt, do not copy verbatim)\n\n${refText}`,
        })
      }

      if (mode === 'direct' && matches[0]) {
        const match = matches[0]
        // Imported workflows demoted to "review" trust (e.g. local-dir bulk import — see
        // docs/plans/repo-integration-plan.md AMENDMENT B) may contain code-node or sticky-note
        // content written by an unvetted third party. Never inject their full JSON verbatim into
        // the generation prompt — fall back to the same node-list-only presentation used for
        // oversized workflows. Reference and scratch modes already only ever show node lists,
        // so this is the only injection surface that needs the guard.
        const isUntrustedImport = match.workflow.sourceKind === 'imported' && match.workflow.trustLevel === 'review'
        const json = JSON.stringify(match.workflow.workflow, null, 2)
        if (isUntrustedImport || json.length > 30_000) {
          const nodes = match.workflow.workflow.nodes
            .map((n) => `  - ${n.name} (${n.type} v${n.typeVersion})`)
            .join('\n')
          const reason = isUntrustedImport
            ? 'imported from an unreviewed source, using reference'
            : 'too large for full JSON, using reference'
          blocks.push({
            type: 'text',
            text: `## Closely Matched Workflow (score: ${match.score.toFixed(2)}) — ${reason}:\nNodes:\n${nodes}`,
          })
        } else {
          blocks.push({
            type: 'text',
            text: `## Closely Matched Workflow (score: ${match.score.toFixed(2)}) — adapt this structure:\n\n${json}`,
          })
        }
      }

      if (mode === 'scratch' && matches.length > 0 && matches[0]!.score >= 0.40) {
        const hint = matches[0]!
        const nodeTypes = hint.workflow.workflow.nodes.map((n) => n.type.split('.').pop()).join(', ')
        blocks.push({
          type: 'text',
          text: `## Weak Structural Hint\nA loosely similar workflow (score: ${hint.score.toFixed(2)}) used these node types: ${nodeTypes}`,
        })
      }
    }

    if (description && this.profile !== 'minimal') {
      const intentMatch = classifyIntent(description)
      if (intentMatch) {
        const intentText = formatIntentRequirements(intentMatch)
        if (intentText) blocks.push({ type: 'text', text: intentText })
      }
    }

    const refFailureContext = this.profile !== 'minimal' ? this.buildReferenceFailureContext(matches) : null
    if (refFailureContext) {
      blocks.push({ type: 'text', text: refFailureContext })
    }

    if (description && this.profile !== 'minimal') {
      const subPatterns = selectSubPatterns(description)
      const subPatternText = formatSubPatterns(subPatterns)
      if (subPatternText) {
        blocks.push({ type: 'text', text: subPatternText })
      }
    }

    const warnings = this.buildFailureWarnings(matches, globalFailureRates, description)
    if (warnings) {
      blocks.push({ type: 'text', text: warnings })
    }

    if (this.profile === 'rich') {
      const expressionRules = new Set([24, 25, 26])
      const expressionAlreadyCovered = (this._lastActivePatterns ?? []).some(p => expressionRules.has(p.rule))
      if (!expressionAlreadyCovered) {
        blocks.push({ type: 'text', text: PROACTIVE_EXPRESSION_GUIDANCE })
      }
    }

    if (clientContext) {
      blocks.push({ type: 'text', text: clientContext })
    }

    return blocks
  }

  private loadPatterns(): Pattern[] {
    try {
      const raw = readFileSync(this.patternsPath, 'utf-8')
      const analysis = JSON.parse(raw) as PatternAnalysis
      const patterns = analysis.topFailureRules ?? []
      return patterns.filter(p => typeof p.pipelineStage === 'string' && typeof p.state === 'string')
    } catch {
      return []
    }
  }

  getWarnedRules(): number[] {
    const patterns = this._lastActivePatterns ?? this.getActivePatterns(this.resolveMaxPatterns())
    return patterns.map(p => p.rule)
  }

  private getActivePatterns(maxCount = 10, description?: string): Pattern[] {
    // pending_review is held out of generation entirely under KAIROS_PATTERN_REVIEW=true --
    // it's evidence-equivalent to confirmed but awaiting human sign-off before it can steer
    // output. draft patterns stay included (unreviewed observation was never gated, only promotion).
    const all = this.loadPatterns()
      .filter(p => p.state !== 'resolved' && p.state !== 'pending_review' && p.confidence > 0)

    const regressed = all.filter(p => p.regressed).sort((a, b) => b.compositeScore - a.compositeScore)
    const confirmed = all.filter(p => !p.regressed && p.state === 'confirmed').sort((a, b) => b.compositeScore - a.compositeScore)
    const drafts = all.filter(p => !p.regressed && p.state !== 'confirmed').sort((a, b) => b.compositeScore - a.compositeScore)

    const ordered = [...regressed, ...confirmed, ...drafts]

    if (this.profile === 'minimal' && description) {
      return this.rankByRelevance(ordered, description).slice(0, maxCount)
    }

    return ordered.slice(0, maxCount)
  }

  private rankByRelevance(patterns: Pattern[], description: string): Pattern[] {
    const lower = description.toLowerCase()
    const STAGE_KEYWORDS: Record<string, string[]> = {
      credential_injection: ['credential', 'auth', 'api key', 'token', 'oauth', 'smtp', 'imap', 'password', 'secret'],
      connection_wiring: ['connect', 'link', 'wire', 'chain', 'merge', 'branch', 'join'],
      expression_syntax: ['expression', 'variable', 'json', 'field', 'data', '$json', 'item'],
      workflow_structure: ['trigger', 'webhook', 'schedule', 'structure', 'workflow'],
      node_generation: ['node', 'generate', 'create', 'build', 'send', 'fetch', 'email', 'slack', 'http'],
    }

    return patterns
      .map(p => {
        const keywords = STAGE_KEYWORDS[p.pipelineStage] ?? []
        const relevanceBoost = keywords.some(kw => lower.includes(kw)) ? 1 : 0
        return { pattern: p, sort: relevanceBoost * 10 + p.compositeScore }
      })
      .sort((a, b) => b.sort - a.sort)
      .map(x => x.pattern)
  }

  private buildFailureWarnings(matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[], description?: string): string | null {
    const richPatterns = this.getActivePatterns(this.resolveMaxPatterns(), description)
    this._lastActivePatterns = richPatterns

    if (richPatterns.length > 0) {
      return this.buildStageGroupedWarnings(richPatterns, matches)
    }

    return this.buildLegacyWarnings(matches, globalFailureRates)
  }

  private buildStageGroupedWarnings(patterns: Pattern[], matches: WorkflowMatch[]): string | null {
    const stageLabels: Record<string, string> = {
      credential_injection: 'CREDENTIAL FORMATTING',
      connection_wiring: 'CONNECTION WIRING',
      node_generation: 'NODE GENERATION',
      workflow_structure: 'WORKFLOW STRUCTURE',
      expression_syntax: 'EXPRESSION SYNTAX',
    }

    const byStage = new Map<string, Pattern[]>()
    for (const p of patterns) {
      const list = byStage.get(p.pipelineStage) ?? []
      list.push(p)
      byStage.set(p.pipelineStage, list)
    }

    const sections: string[] = []
    for (const [stage, stagePatterns] of byStage) {
      const label = stageLabels[stage] ?? stage

      const byMitigation = new Map<string, Pattern[]>()
      for (const p of stagePatterns) {
        const key = p.mitigation ?? `rule_${p.rule}`
        const list = byMitigation.get(key) ?? []
        list.push(p)
        byMitigation.set(key, list)
      }

      const lines: string[] = []
      for (const group of byMitigation.values()) {
        if (group.length === 1) {
          const p = group[0]!
          const urgency = p.regressed ? 'CRITICAL REGRESSION: ' : (p.compositeScore ?? 0) >= CRITICAL_SCORE_THRESHOLD ? 'CRITICAL: ' : ''
          const statePrefix = p.state === 'confirmed' ? '[CONFIRMED] ' : ''
          const trendSuffix = p.trend === 'worsening' ? ' (GETTING WORSE)' : p.trend === 'improving' ? ' (improving)' : ''
          const remedy = p.mitigation ?? RULE_MITIGATIONS[p.rule]
          const remedyStr = remedy ? `\n  Fix: ${remedy}` : ''
          const ex = RULE_EXAMPLES[p.rule]
          const exampleStr = ex ? `\n  Bad:  ${ex.bad}\n  Good: ${ex.good}` : ''
          lines.push(`- ${urgency}${statePrefix}Rule ${p.rule}${trendSuffix}: ${p.exampleMessages[0] ?? 'No example'}${remedyStr}${exampleStr}`)
        } else {
          const ruleNums = group.map(p => p.rule).join(', ')
          const totalFailures = group.reduce((s, p) => s + p.failureCount, 0)
          const hasConfirmed = group.some(p => p.state === 'confirmed')
          const statePrefix = hasConfirmed ? '[CONFIRMED] ' : ''
          const remedy = group[0]!.mitigation
          const remedyStr = remedy ? `\n  Fix: ${remedy}` : ''
          lines.push(`- ${statePrefix}Rules ${ruleNums} (${totalFailures} failures combined): same root cause${remedyStr}`)
        }
      }
      sections.push(`### ${label}\n${lines.join('\n')}`)
    }

    const coveredRules = new Set(patterns.map(p => p.rule))
    const extraRulesSeen = new Set<number>()

    for (const match of matches) {
      // Surface failurePatterns (from this workflow's own build history)
      const fps = match.workflow.failurePatterns
      if (fps?.length) {
        for (const fp of fps.filter(fp => !coveredRules.has(fp.rule) && !extraRulesSeen.has(fp.rule))) {
          const remedy = RULE_MITIGATIONS[fp.rule]
          const remedyStr = remedy ? ` — Fix: ${remedy}` : ''
          sections.push(`- Rule ${fp.rule}: "${fp.message}"${remedyStr} (seen in similar workflows)`)
          extraRulesSeen.add(fp.rule)
        }
      }

      // Also surface rules from outcomeStats.failedRules (rules that failed when OTHER builds used this as a reference)
      const stats = match.workflow.outcomeStats
      if (stats && stats.totalUses > 0) {
        for (const [ruleStr] of Object.entries(stats.failedRules)) {
          const rule = parseInt(ruleStr, 10)
          if (coveredRules.has(rule) || extraRulesSeen.has(rule)) continue
          const remedy = RULE_MITIGATIONS[rule]
          const remedyStr = remedy ? ` — Fix: ${remedy}` : ''
          sections.push(`- Rule ${rule}${remedyStr} (historically problematic when this reference is used)`)
          extraRulesSeen.add(rule)
        }
      }
    }

    if (sections.length === 0) return null

    return `## Known Failure Patterns — AVOID THESE\n\nGrouped by generation stage. Fix these BEFORE outputting your response:\n\n${sections.join('\n\n')}`
  }

  private buildReferenceFailureContext(matches: WorkflowMatch[]): string | null {
    const sections: string[] = []

    for (const match of matches.slice(0, 2)) {
      const stats = match.workflow.outcomeStats
      if (!stats || stats.totalUses === 0) continue

      const topFailed = Object.entries(stats.failedRules)
        .map(([rule, count]) => ({ rule: parseInt(rule, 10), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)

      if (topFailed.length === 0) continue

      const shortDesc = match.workflow.description.length > 60
        ? match.workflow.description.slice(0, 57) + '...'
        : match.workflow.description
      const header = `Matched workflow "${shortDesc}" (similarity: ${match.score.toFixed(2)}, used ${stats.totalUses}x as reference):`
      const ruleLines = topFailed.map(({ rule, count }) => {
        const remedy = RULE_MITIGATIONS[rule]
        const remedyStr = remedy ? ` — ${remedy}` : ''
        return `  - Rule ${rule} failed ${count}x in past builds using this reference${remedyStr}`
      })
      sections.push(header + '\n' + ruleLines.join('\n'))
    }

    if (sections.length === 0) return null

    return `## Reference Workflow Failure History\n\nWhen these matched workflows were used as references, these rules failed most in resulting builds. You MUST avoid repeating them:\n\n${sections.join('\n\n')}`
  }

  private buildLegacyWarnings(matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[]): string | null {
    const lines: string[] = []

    for (const match of matches) {
      const patterns = match.workflow.failurePatterns
      if (!patterns?.length) continue
      for (const fp of patterns) {
        const remedy = RULE_MITIGATIONS[fp.rule]
        const remedyStr = remedy ? ` — Fix: ${remedy}` : ''
        lines.push(`- Rule ${fp.rule}: "${fp.message}"${remedyStr} (seen ${fp.occurrences}x in similar workflows)`)
      }
    }

    const highFreqRules = globalFailureRates.filter((r) => r.rate >= 0.15)
    for (const rule of highFreqRules) {
      const remedy = RULE_MITIGATIONS[rule.rule]
      const remedyStr = remedy ? ` — Fix: ${remedy}` : ''
      lines.push(`- Rule ${rule.rule}: "${rule.commonMessage}"${remedyStr} (fails in ${Math.round(rule.rate * 100)}% of all builds)`)
    }

    if (lines.length === 0) return null

    const unique = [...new Set(lines)]
    return `## Known Failure Patterns — AVOID THESE\n\nPrevious builds frequently failed the following validation rules. Ensure your output does NOT repeat these mistakes:\n${unique.join('\n')}`
  }

  private buildUserMessage(request: DesignRequest, _matches: WorkflowMatch[], _mode: string): string {
    const namePart = request.name ? `\nWorkflow name: "${request.name}"` : ''
    return `Build a workflow that: ${request.description}${namePart}`
  }
}
