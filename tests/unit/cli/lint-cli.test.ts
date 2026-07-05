import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const LINT_CLI = join(__dirname, '../../../src/lint-cli.ts')
const VALID_FIXTURE = join(__dirname, '../../fixtures/workflows/simple-two-node.json')

function run(args: string[]) {
  return spawnSync(TSX, [LINT_CLI, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
  })
}

describe('kairos-lint — standalone validator CLI', () => {
  it('prints usage and exits 1 when no file path is given', () => {
    const r = run([])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Usage: kairos-lint')
  })

  it('exits 0 and reports only warnings for a structurally valid workflow', () => {
    const r = run([VALID_FIXTURE])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Validation')
    expect(r.stdout).not.toContain('[error]')
  })

  it('supports --json for the valid fixture', () => {
    const r = run([VALID_FIXTURE, '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as { valid: boolean; issues: unknown[] }
    expect(parsed.valid).toBe(true)
  })

  it('exits 1 and reports specific rule failures for an invalid workflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kairos-lint-test-'))
    try {
      const badPath = join(dir, 'bad.json')
      await writeFile(badPath, JSON.stringify({ name: '', nodes: [], connections: {} }))

      const r = run([badPath])
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('[error]')
      expect(r.stdout).toContain('[Rule 1]') // empty name
      expect(r.stdout).toContain('[Rule 2]') // no nodes
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exits 1 with a clear error for a missing or unparseable file', () => {
    const r = run(['/nonexistent/path/does-not-exist.json'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Could not read or parse')
  })
})
