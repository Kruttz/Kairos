import type { WorkflowMatch } from '../library/types.js'
import type { RuleFailureRate } from '../telemetry/reader.js'
import type { DesignRequest, BuiltPrompt, SystemPromptBlock } from './types.js'
import { SYSTEM_PROMPT_V1 } from './prompts/v1.js'
import { scoreToMode } from '../utils/thresholds.js'

const RULE_REMEDIES: Record<number, string> = {
  1: 'Provide a non-empty workflow name string',
  2: 'Include at least one node in the nodes array',
  3: 'Every node must have a unique UUID v4 string as its id field',
  4: 'Ensure all node ids are unique — no two nodes can share the same id',
  5: 'Every node must have a non-empty type string',
  6: 'Every node must have a positive integer typeVersion',
  7: 'Every node must have a position array of exactly [x, y] numbers',
  8: 'Every node must have a non-empty name string',
  9: 'connections must be a plain object (use {} if no connections)',
  10: 'Every node name in connections (source and target) must exactly match a name in the nodes array',
  12: 'Remove forbidden fields: id, active, createdAt, updatedAt, versionId, meta, tags — these are server-assigned',
  14: 'Include at least one trigger node (e.g. webhook, scheduleTrigger, manualTrigger)',
  15: 'Node type strings must be fully qualified: "n8n-nodes-base.httpRequest" not just "httpRequest"',
  16: 'All node names must be unique within the workflow',
  17: 'Credentials must be an object with non-empty string id and name fields: { id: "placeholder-id", name: "My Credential" }',
  18: 'AI sub-nodes (languageModel, memory, tool) must be the CONNECTION SOURCE pointing TO the agent — not the reverse',
  19: 'Use known safe typeVersion values for each node type',
  20: 'Remove connection cycles — ensure no node can reach itself through the connection graph',
  21: 'When using webhook with responseMode "responseNode", include a respondToWebhook node in the flow',
  22: 'Ensure all required parameters are set for each node type (e.g. webhook needs httpMethod and path)',
}

export class PromptBuilder {
  build(request: DesignRequest, matches: WorkflowMatch[], globalFailureRates: RuleFailureRate[] = [], dynamicCatalog?: string): BuiltPrompt {
    const mode = this.resolveMode(matches)
    const system = this.buildSystem(matches, mode, globalFailureRates, dynamicCatalog)
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

  private buildSystem(matches: WorkflowMatch[], mode: 'direct' | 'reference' | 'scratch', globalFailureRates: RuleFailureRate[] = [], dynamicCatalog?: string): SystemPromptBlock[] {
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
      const json = JSON.stringify(match.workflow.workflow, null, 2)
      if (json.length > 30_000) {
        const nodes = match.workflow.workflow.nodes
          .map((n) => `  - ${n.name} (${n.type} v${n.typeVersion})`)
          .join('\n')
        blocks.push({
          type: 'text',
          text: `## Closely Matched Workflow (score: ${match.score.toFixed(2)}) — too large for full JSON, using reference:\nNodes:\n${nodes}`,
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
        const remedy = RULE_REMEDIES[fp.rule]
        const remedyStr = remedy ? ` — Fix: ${remedy}` : ''
        lines.push(`- Rule ${fp.rule}: "${fp.message}"${remedyStr} (seen ${fp.occurrences}x in similar workflows)`)
      }
    }

    const highFreqRules = globalFailureRates.filter((r) => r.rate >= 0.15)
    for (const rule of highFreqRules) {
      const remedy = RULE_REMEDIES[rule.rule]
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
