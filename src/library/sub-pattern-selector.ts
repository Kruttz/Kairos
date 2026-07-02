import { SUB_PATTERNS, type SubPattern } from './sub-patterns.js'
import { containsKeyword } from '../utils/keyword-match.js'

const MAX_PATTERNS = 4

export function selectSubPatterns(description: string, max = MAX_PATTERNS): SubPattern[] {
  const lower = description.toLowerCase()

  const scored = SUB_PATTERNS
    .map(pattern => {
      const score = pattern.intentTags.filter(tag => containsKeyword(lower, tag)).length
      return { pattern, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, max).map(({ pattern }) => pattern)
}

export function formatSubPatterns(patterns: SubPattern[]): string {
  if (patterns.length === 0) return ''

  const sections = patterns.map(p => {
    const lines: string[] = [`### ${p.name}`, p.description, '']

    if (p.wiringNotes.length > 0) {
      lines.push('**Wiring:**')
      for (const note of p.wiringNotes) lines.push(`- ${note}`)
      lines.push('')
    }

    if (p.requiredParameters.length > 0) {
      lines.push('**Required parameters:**')
      for (const rp of p.requiredParameters) {
        lines.push(`- \`${rp.node}\` → \`${rp.param}\`: ${rp.mustBe}`)
        lines.push(`  Why: ${rp.reason}`)
      }
      lines.push('')
    }

    if (p.commonMistakes.length > 0) {
      lines.push('**Do NOT:**')
      for (const m of p.commonMistakes) lines.push(`- ${m}`)
      lines.push('')
    }

    if (p.connectionSnippet) {
      lines.push('**Connection / code pattern:**')
      lines.push('```')
      lines.push(p.connectionSnippet)
      lines.push('```')
    }

    if (p.validatorRuleIds.length > 0) {
      lines.push(`Validator rules: ${p.validatorRuleIds.join(', ')}`)
    }

    return lines.join('\n').trimEnd()
  })

  return `## Sub-Patterns for This Build\n\nApply these exactly — they are the correct implementation for patterns detected in your build request.\n\n${sections.join('\n\n---\n\n')}`
}
