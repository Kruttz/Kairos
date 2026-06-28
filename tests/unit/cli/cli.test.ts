import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../../src/cli.ts')

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 10_000,
  })
}

describe('CLI — parseArgs / routing', () => {
  describe('--help / help command', () => {
    it('prints help text when no command is given', () => {
      const r = run([])
      expect(r.stdout).toContain('Kairos SDK')
      expect(r.stdout).toContain('kairos build')
      expect(r.status).toBe(0)
    })

    it('prints help text for "help" command', () => {
      const r = run(['help'])
      expect(r.stdout).toContain('Kairos SDK')
      expect(r.status).toBe(0)
    })

    it('prints help text for --help flag', () => {
      const r = run(['--help'])
      expect(r.stdout).toContain('Kairos SDK')
      expect(r.status).toBe(0)
    })

    it('help text mentions all major commands', () => {
      const r = run(['help'])
      expect(r.stdout).toContain('build')
      expect(r.stdout).toContain('replace')
      expect(r.stdout).toContain('patterns')
      expect(r.stdout).toContain('sessions')
      expect(r.stdout).toContain('list')
      expect(r.stdout).toContain('init')
      expect(r.stdout).toContain('sync-templates')
    })

    it('help text documents environment variables', () => {
      const r = run(['help'])
      expect(r.stdout).toContain('ANTHROPIC_API_KEY')
      expect(r.stdout).toContain('N8N_BASE_URL')
      expect(r.stdout).toContain('KAIROS_MODEL')
    })
  })

  describe('unknown command', () => {
    it('exits with code 1 and prints help for unknown commands', () => {
      const r = run(['foobar'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Unknown command: foobar')
      expect(r.stdout).toContain('Kairos SDK')
    })
  })

  describe('flag parsing', () => {
    it('--dry-run with missing description exits with usage error', () => {
      // build with no description → exits 1
      const r = run(['build', '--dry-run'], {
        ANTHROPIC_API_KEY: 'sk-test',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos build')
    })

    it('replace without id exits with usage error', () => {
      const r = run(['replace'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos replace')
    })

    it('replace without description exits with usage error', () => {
      const r = run(['replace', 'some-workflow-id'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos replace')
    })

    it('delete without --confirm exits with error', () => {
      const r = run(['delete', 'some-id'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('--confirm')
    })

    it('get without id exits with usage error', () => {
      const r = run(['get'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos get')
    })

    it('activate without id exits with usage error', () => {
      const r = run(['activate'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos activate')
    })

    it('deactivate without id exits with usage error', () => {
      const r = run(['deactivate'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos deactivate')
    })
  })

  describe('missing env vars', () => {
    it('exits with code 1 when ANTHROPIC_API_KEY is missing for build', () => {
      const r = run(['build', 'do something'], {
        ANTHROPIC_API_KEY: '',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('ANTHROPIC_API_KEY')
    })

    it('exits with code 1 when N8N_BASE_URL is missing for build (non-dry-run)', () => {
      const r = run(['build', 'do something'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: '',
        N8N_API_KEY: 'test-key',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('N8N_BASE_URL')
    })

    it('exits with code 1 when N8N_API_KEY is missing for list', () => {
      const r = run(['list'], {
        ANTHROPIC_API_KEY: 'sk-test',
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_API_KEY: '',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('N8N_API_KEY')
    })
  })

  describe('patterns --json flag', () => {
    it('outputs JSON when --json flag is passed with no telemetry dir', () => {
      // KAIROS_TELEMETRY set to a non-existent path → PatternAnalyzer reads 0 events
      const r = run(['patterns', '--json'], {
        ANTHROPIC_API_KEY: 'sk-test',
        KAIROS_TELEMETRY: '/tmp/kairos-nonexistent-test-dir-xyz',
      })
      expect(r.status).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed).toHaveProperty('summary')
      expect(parsed).toHaveProperty('topFailureRules')
      expect(Array.isArray(parsed.topFailureRules)).toBe(true)
    })

    it('outputs human-readable text by default for patterns', () => {
      const r = run(['patterns'], {
        ANTHROPIC_API_KEY: 'sk-test',
        KAIROS_TELEMETRY: '/tmp/kairos-nonexistent-test-dir-xyz',
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Kairos Pattern Analysis')
      expect(r.stdout).toContain('Builds:')
    })
  })

  describe('sessions --json flag', () => {
    it('outputs JSON when --json flag is passed with no telemetry dir', () => {
      const r = run(['sessions', '--json'], {
        ANTHROPIC_API_KEY: 'sk-test',
        KAIROS_TELEMETRY: '/tmp/kairos-nonexistent-test-dir-xyz',
      })
      expect(r.status).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(Array.isArray(parsed)).toBe(true)
    })

    it('outputs "No session history found" when no telemetry data', () => {
      const r = run(['sessions'], {
        ANTHROPIC_API_KEY: 'sk-test',
        KAIROS_TELEMETRY: '/tmp/kairos-nonexistent-test-dir-xyz',
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('No session history found')
    })
  })
})
