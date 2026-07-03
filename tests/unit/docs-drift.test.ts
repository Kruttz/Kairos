import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VALIDATOR_RULE_IDS } from '../../src/validation/rule-metadata.js'

const REPO_ROOT = join(__dirname, '../..')
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8')
const CLI_SOURCE = readFileSync(join(REPO_ROOT, 'src/cli.ts'), 'utf-8')

/**
 * These assertions are deliberately structural (set membership, substring
 * presence) rather than stylistic (exact wording, table formatting) — a
 * README rewrite that keeps the same facts shouldn't break this test.
 */
describe('docs drift — README vs source of truth', () => {
  it('every validator rule ID appears as a row in the README Validator Rules table', () => {
    const tableSection = README.slice(README.indexOf('## Validator Rules'), README.indexOf('## API Reference'))
    const rowIds = new Set(
      [...tableSection.matchAll(/^\| (\d+) \|/gm)].map((m) => parseInt(m[1]!, 10)),
    )

    const missing = VALIDATOR_RULE_IDS.filter((id) => !rowIds.has(id))
    const extra = [...rowIds].filter((id) => !VALIDATOR_RULE_IDS.includes(id))

    expect(missing, `README's Validator Rules table is missing rows for rule IDs: ${missing.join(', ')}`).toEqual([])
    expect(extra, `README's Validator Rules table has rows for rule IDs that don't exist: ${extra.join(', ')}`).toEqual([])
  })

  it('every KAIROS_* env var used in src/ is documented somewhere in the README', () => {
    // Collect every exact KAIROS_XXX literal referenced in source (excludes the
    // KAIROS_MCP_ALLOW_ prefix-only match, which isn't a real standalone var).
    const srcFiles = ['src/cli.ts', 'src/mcp-server.ts', 'src/client.ts', 'src/library/scorer.ts', 'src/validation/validator.ts']
    const found = new Set<string>()
    for (const relPath of srcFiles) {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf-8')
      for (const m of content.matchAll(/KAIROS_[A-Z_]+/g)) {
        if (m[0].endsWith('_')) continue // skip prefix-only false matches like KAIROS_MCP_ALLOW_
        found.add(m[0])
      }
    }

    const undocumented = [...found].filter((envVar) => !README.includes(envVar))
    expect(undocumented, `These env vars are used in src/ but never mentioned in README.md: ${undocumented.join(', ')}`).toEqual([])
  })

  it('every CLI command in HELP usage block appears in the README CLI section', () => {
    const usageBlock = CLI_SOURCE.slice(CLI_SOURCE.indexOf('Usage:'), CLI_SOURCE.indexOf('Build options:'))
    const commands = [...usageBlock.matchAll(/^\s*kairos ([a-z][a-z-]*)/gm)].map((m) => m[1]!)
    const uniqueCommands = [...new Set(commands)]

    const cliSection = README.slice(README.indexOf('## CLI'), README.indexOf('## Telemetry'))
    const missing = uniqueCommands.filter((cmd) => !cliSection.includes(`kairos ${cmd}`))

    expect(missing, `These CLI commands are in cli.ts's HELP but not documented in the README's CLI section: ${missing.join(', ')}`).toEqual([])
  })
})
