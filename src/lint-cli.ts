#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { N8nValidator } from './validation/validator.js'
import type { N8nWorkflow } from './types/workflow.js'

function printUsageAndExit(): never {
  console.error('Usage: kairos-lint <workflow.json> [--json]')
  console.error('')
  console.error("Validates an n8n workflow JSON file against Kairos's structural validator")
  console.error('(131 rules) — works standalone on ANY n8n workflow, not just Kairos-generated')
  console.error('ones. Fully offline: no Anthropic/n8n API calls, no credentials required.')
  process.exit(1)
}

function main(): void {
  const filePath = process.argv[2]
  const jsonOutput = process.argv.includes('--json')

  if (!filePath || filePath.startsWith('--')) {
    printUsageAndExit()
  }

  let workflow: N8nWorkflow
  try {
    const content = readFileSync(filePath, 'utf-8')
    workflow = JSON.parse(content) as N8nWorkflow
  } catch (err) {
    console.error(`Could not read or parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const validator = new N8nValidator()
  const result = validator.validate(workflow)

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2))
    if (!result.valid) process.exit(1)
    return
  }

  if (result.issues.length === 0) {
    console.log(`✓ ${filePath} passed all validator checks`)
    return
  }

  const errors = result.issues.filter((i) => i.severity === 'error')
  const warnings = result.issues.filter((i) => i.severity === 'warn')

  console.log(`\n${filePath} — Validation`)
  console.log('─'.repeat(50))
  console.log(`Issues: ${errors.length} error(s), ${warnings.length} warning(s)`)
  console.log('')

  for (const issue of errors) {
    console.log(`  ✗ [error] [Rule ${issue.rule}] ${issue.message}`)
  }
  for (const issue of warnings) {
    console.log(`  ⚠ [warn]  [Rule ${issue.rule}] ${issue.message}`)
  }

  if (errors.length > 0) process.exit(1)
}

main()
