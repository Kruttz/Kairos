import type { WorkflowMatch } from '../library/types.js'
import type { RuleFailureRate } from '../telemetry/reader.js'
import type { DesignRequest, BuiltPrompt, SystemPromptBlock } from './types.js'
import { SYSTEM_PROMPT_V1 } from './prompts/v1.js'
import { scoreToMode } from '../utils/thresholds.js'

export class PromptBuilder {
  build(request: DesignRequest, matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[] = []): BuiltPrompt {
    const mode = this.resolveMode(matches)
    const system = this.buildSystem(matches, mode, globalFailureRates)
    const userMessage = this.buildUserMessage(request, matches, mode)
    return { system, userMessage, mode, matches }
  }

  buildCorrectionMessage(
    request: DesignRequest,
    matches: WorkflowMatch[],
    allIssues: string[],
    attempt: number,
  ): string {
    const base = this.buildUserMessage(request, matches, this.resolveMode(matches))
    return `${base}

IMPORTANT: A previous generation attempt (attempt ${attempt}) failed validation with these issues:
${allIssues.join('\n')}

Fix ALL of the above issues in your new response. Do not repeat any of these mistakes.`
  }

  private resolveMode(matches: WorkflowMatch[]): 'direct' | 'reference' | 'scratch' {
    if (matches.length === 0) return 'scratch'
    const top = matches[0]
    if (!top) return 'scratch'
    return scoreToMode(top.score)
  }

  private buildSystem(matches: WorkflowMatch[], mode: 'direct' | 'reference' | 'scratch', globalFailureRates: RuleFailureRate[] = []): SystemPromptBlock[] {
    const blocks: SystemPromptBlock[] = [
      {
        type: 'text',
        text: SYSTEM_PROMPT_V1,
        cache_control: { type: 'ephemeral' },
      },
    ]

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
      blocks.push({
        type: 'text',
        text: `## Closely Matched Workflow (score: ${match.score.toFixed(2)}) — adapt this structure:\n\n${JSON.stringify(match.workflow.workflow, null, 2)}`,
      })
    }

    const warnings = this.buildFailureWarnings(matches, globalFailureRates)
    if (warnings) {
      blocks.push({ type: 'text', text: warnings })
    }

    return blocks
  }

  private buildFailureWarnings(matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[]): string | null {
    const lines: string[] = []

    for (const match of matches) {
      const patterns = match.workflow.failurePatterns
      if (!patterns?.length) continue
      for (const fp of patterns) {
        lines.push(`- Rule ${fp.rule}: "${fp.message}" (seen ${fp.occurrences}x in similar workflows)`)
      }
    }

    const highFreqRules = globalFailureRates.filter((r) => r.rate >= 0.15)
    for (const rule of highFreqRules) {
      lines.push(`- Rule ${rule.rule}: "${rule.commonMessage}" (fails in ${Math.round(rule.rate * 100)}% of all builds)`)
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
