import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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

  describe('library prune', () => {
    it('exits with usage error when --source is missing', () => {
      const r = run(['library', 'prune'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos library prune')
    })

    it('exits with usage error for an invalid --source value', () => {
      const r = run(['library', 'prune', '--source', 'bogus'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Usage: kairos library prune')
    })

    it('exits with an error for an unknown library subcommand', () => {
      const r = run(['library', 'nonsense'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Unknown library subcommand')
    })

    it('dry-run reports without mutating anything', () => {
      const r = run(['library', 'prune', '--source', 'imported', '--dry-run'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('[DRY RUN]')
      expect(r.stdout).toContain('sourceKind="imported"')
    })

    it('really removes imported entries when pointed at an isolated KAIROS_LIBRARY_DIR', async () => {
      // Previously blocked: no way to isolate a real (non-dry-run) mutation from
      // Jordan's actual ~/.kairos/library. KAIROS_LIBRARY_DIR closes that gap.
      const libDir = await mkdtemp(join(tmpdir(), 'kairos-cli-prune-real-'))
      const sourceDir = await mkdtemp(join(tmpdir(), 'kairos-cli-prune-src-'))
      try {
        const workflow = {
          name: 'PruneMe',
          nodes: [{ id: '00000000-0000-4000-8000-000000000003', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
          connections: {},
          settings: { executionOrder: 'v1' },
        }
        await writeFile(join(sourceDir, 'wf.json'), JSON.stringify(workflow), 'utf-8')

        const importResult = run(['sync-templates', '--from-dir', sourceDir], { KAIROS_LIBRARY_DIR: libDir, KAIROS_TELEMETRY: '/tmp/kairos-nonexistent-test-dir-xyz' })
        expect(importResult.status).toBe(0)
        expect(importResult.stderr).toContain('Saved:          1')

        const beforeIndex = JSON.parse(await readFile(join(libDir, 'index.json'), 'utf-8')) as Array<{ sourceKind?: string }>
        expect(beforeIndex.filter((m) => m.sourceKind === 'imported')).toHaveLength(1)

        const pruneResult = run(['library', 'prune', '--source', 'imported'], { KAIROS_LIBRARY_DIR: libDir })
        expect(pruneResult.status).toBe(0)
        expect(pruneResult.stdout).toContain('Removed 1 entry')

        const afterIndex = JSON.parse(await readFile(join(libDir, 'index.json'), 'utf-8')) as Array<{ sourceKind?: string }>
        expect(afterIndex.filter((m) => m.sourceKind === 'imported')).toHaveLength(0)
      } finally {
        await rm(libDir, { recursive: true, force: true })
        await rm(sourceDir, { recursive: true, force: true })
      }
    })
  })

  describe('sync-templates --from-dir', () => {
    const NO_TELEMETRY = { KAIROS_TELEMETRY: '/tmp/kairos-nonexistent-test-dir-xyz' }
    let sourceDir: string

    async function makeWorkflowFixture(name: string): Promise<void> {
      const workflow = {
        name,
        nodes: [
          { id: '00000000-0000-4000-8000-000000000001', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
          { id: '00000000-0000-4000-8000-000000000002', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 2, position: [200, 0], parameters: { resource: 'message', operation: 'send', select: 'channel', channelId: { __rl: true, mode: 'id', value: 'C123' }, text: 'hi' }, credentials: { slackOAuth2Api: { id: 'placeholder-id', name: 'Slack' } } },
        ],
        connections: { Trigger: { main: [[{ node: 'Notify', type: 'main', index: 0 }]] } },
        settings: { executionOrder: 'v1' },
      }
      await writeFile(join(sourceDir, `${name}.json`), JSON.stringify(workflow), 'utf-8')
    }

    it('dry-run reports parsed/selected counts for a directory of fixtures without saving', async () => {
      sourceDir = await mkdtemp(join(tmpdir(), 'kairos-cli-import-'))
      try {
        await makeWorkflowFixture('Alpha')
        const r = run(['sync-templates', '--from-dir', sourceDir, '--dry-run'], NO_TELEMETRY)
        expect(r.status).toBe(0)
        expect(r.stderr).toContain('[DRY RUN]')
        expect(r.stderr).toContain('Files found:     1')
        expect(r.stderr).toContain('Would save:          1')
      } finally {
        await rm(sourceDir, { recursive: true, force: true })
      }
    })

    it('reports zero files found for an empty directory', async () => {
      sourceDir = await mkdtemp(join(tmpdir(), 'kairos-cli-import-empty-'))
      try {
        const r = run(['sync-templates', '--from-dir', sourceDir, '--dry-run'], NO_TELEMETRY)
        expect(r.status).toBe(0)
        expect(r.stderr).toContain('Files found:     0')
      } finally {
        await rm(sourceDir, { recursive: true, force: true })
      }
    })

    it('counts unparseable JSON as a parse error', async () => {
      sourceDir = await mkdtemp(join(tmpdir(), 'kairos-cli-import-broken-'))
      try {
        await writeFile(join(sourceDir, 'broken.json'), '{ not json', 'utf-8')
        const r = run(['sync-templates', '--from-dir', sourceDir, '--dry-run'], NO_TELEMETRY)
        expect(r.status).toBe(0)
        expect(r.stderr).toContain('1 parse errors')
      } finally {
        await rm(sourceDir, { recursive: true, force: true })
      }
    })

    it('really saves imported workflows when pointed at an isolated KAIROS_LIBRARY_DIR', async () => {
      // Previously blocked: no way to run the real (non-dry-run) save path from the
      // CLI without touching Jordan's actual ~/.kairos/library. KAIROS_LIBRARY_DIR
      // closes that gap — this exercises the full arg-parse -> handler -> FileLibrary
      // wiring end to end, not just the LocalImporter unit tests.
      sourceDir = await mkdtemp(join(tmpdir(), 'kairos-cli-import-real-'))
      const libDir = await mkdtemp(join(tmpdir(), 'kairos-cli-import-real-lib-'))
      try {
        await makeWorkflowFixture('RealSave')
        const r = run(['sync-templates', '--from-dir', sourceDir], { KAIROS_LIBRARY_DIR: libDir, ...NO_TELEMETRY })
        expect(r.status).toBe(0)
        expect(r.stderr).toContain('Saved:          1')

        const index = JSON.parse(await readFile(join(libDir, 'index.json'), 'utf-8')) as Array<{ sourceKind?: string; description?: string }>
        expect(index).toHaveLength(1)
        expect(index[0]!.sourceKind).toBe('imported')
        expect(index[0]!.description).toContain('RealSave')
      } finally {
        await rm(sourceDir, { recursive: true, force: true })
        await rm(libDir, { recursive: true, force: true })
      }
    })
  })
})
