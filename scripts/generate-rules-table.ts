/**
 * Generates the full Validator Rules markdown table from src/validation/validator.ts
 * itself, so the README table can never silently fall behind the real rule count again.
 *
 * Not a build-time template substitution — this is a generate-then-review-then-paste
 * workflow, like a linter's --fix. Run it, review the output, paste it into README.md
 * replacing the current table. tests/unit/docs-drift.test.ts then keeps the pasted
 * table honest going forward (checks rule-ID completeness, not exact table contents).
 *
 * Usage: npx tsx scripts/generate-rules-table.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VALIDATOR_RULE_IDS } from '../src/validation/rule-metadata.js'

interface RuleRow {
  id: number
  severity: 'error' | 'warn'
  description: string
}

function extractRules(source: string): Map<number, RuleRow> {
  const lines = source.split('\n')
  const rules = new Map<number, RuleRow>()

  const commentPattern = /^\s*\/\/ Rule (\d+)(?:\s*\((\w+)\))?:\s*(.+)$/
  const methodPattern = /private checkRule(\d+)\(/

  for (let i = 0; i < lines.length; i++) {
    const commentMatch = lines[i]!.match(commentPattern)
    if (!commentMatch) continue

    const commentRuleId = parseInt(commentMatch[1]!, 10)
    const description = commentMatch[3]!.trim()

    // The comment must be immediately followed by that rule's method, skipping over
    // blank lines and any multi-line comment continuation lines first.
    let j = i + 1
    while (j < lines.length && (lines[j]!.trim() === '' || lines[j]!.trim().startsWith('//'))) j++
    const methodMatch = lines[j]?.match(methodPattern)
    if (!methodMatch || parseInt(methodMatch[1]!, 10) !== commentRuleId) continue

    // Find the method body's extent: from this line to the next `private checkRule`
    // declaration (or a reasonable window if none follows — end of class).
    let bodyEnd = lines.length
    for (let k = j + 1; k < lines.length; k++) {
      if (methodPattern.test(lines[k]!)) { bodyEnd = k; break }
    }
    const body = lines.slice(j, bodyEnd).join('\n')

    const errMatch = body.match(new RegExp(`this\\.err\\(\\s*issues\\s*,\\s*${commentRuleId}\\s*,`))
    const warnMatch = body.match(new RegExp(`this\\.warn\\(\\s*issues\\s*,\\s*${commentRuleId}\\s*,`))
    let severity: 'error' | 'warn' | undefined
    if (errMatch && warnMatch) {
      // Whichever appears first in the body wins — some rules warn in one branch
      // and error in another; take the dispatch order as the primary signal.
      severity = body.indexOf(errMatch[0]) < body.indexOf(warnMatch[0]) ? 'error' : 'warn'
    } else if (errMatch) {
      severity = 'error'
    } else if (warnMatch) {
      severity = 'warn'
    }

    if (!severity) {
      console.error(`Rule ${commentRuleId}: could not determine severity (no this.err/this.warn(issues, ${commentRuleId}, ...) found in its method body)`)
      continue
    }

    rules.set(commentRuleId, { id: commentRuleId, severity, description })
  }

  return rules
}

function main(): void {
  const validatorPath = join(import.meta.dirname, '..', 'src', 'validation', 'validator.ts')
  const source = readFileSync(validatorPath, 'utf-8')
  const rules = extractRules(source)

  const expectedIds = new Set(VALIDATOR_RULE_IDS)
  const foundIds = new Set(rules.keys())

  const missing = [...expectedIds].filter((id) => !foundIds.has(id)).sort((a, b) => a - b)
  const extra = [...foundIds].filter((id) => !expectedIds.has(id)).sort((a, b) => a - b)

  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) console.error(`Missing from extraction (in VALIDATOR_RULE_IDS but not parsed): ${missing.join(', ')}`)
    if (extra.length > 0) console.error(`Extra in extraction (parsed but not in VALIDATOR_RULE_IDS): ${extra.join(', ')}`)
    process.exit(1)
  }

  const sorted = [...rules.values()].sort((a, b) => a.id - b.id)
  console.log('| Rule | Severity | What it checks |')
  console.log('|------|----------|----------------|')
  for (const rule of sorted) {
    console.log(`| ${rule.id} | ${rule.severity} | ${rule.description} |`)
  }
  console.error(`\n${sorted.length} rules extracted, matching VALIDATOR_RULE_IDS exactly.`)
}

main()
