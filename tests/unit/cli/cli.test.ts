import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'

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

  describe('patterns approve/reject (review gate)', () => {
    async function makeTelemetryWithFailures(rule: number, count: number): Promise<{ dir: string; telemetryDir: string }> {
      const dir = await mkdtemp(join(tmpdir(), 'kairos-cli-patterns-'))
      const telemetryDir = join(dir, 'telemetry')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(telemetryDir, { recursive: true })
      const today = new Date().toISOString().slice(0, 10)
      const events: string[] = []
      for (let i = 0; i < count; i++) {
        events.push(JSON.stringify({ timestamp: new Date().toISOString(), sessionId: `s${i}`, eventType: 'build_start', data: { description: 'test', dryRun: false, model: 'test' } }))
        events.push(JSON.stringify({
          timestamp: new Date().toISOString(), sessionId: `s${i}`, eventType: 'generation_attempt',
          data: { validationPassed: false, issues: [{ rule, message: `rule ${rule} failed` }], durationMs: 1000, tokensInput: 100, tokensOutput: 50 },
        }))
      }
      await writeFile(join(telemetryDir, `${today}.jsonl`), events.join('\n'))
      return { dir, telemetryDir }
    }

    it('approve round-trip: pending_review -> confirmed, audit actor human', async () => {
      const { dir, telemetryDir } = await makeTelemetryWithFailures(90, 4)
      try {
        const env = { ANTHROPIC_API_KEY: 'sk-test', KAIROS_TELEMETRY: telemetryDir, KAIROS_PATTERN_REVIEW: 'true' }
        const analyze = run(['patterns', '--json'], env)
        expect(analyze.status).toBe(0)
        expect(JSON.parse(analyze.stdout).topFailureRules.find((p: { rule: number }) => p.rule === 90)?.state).toBe('pending_review')

        const approve = run(['patterns', 'approve', '90'], env)
        expect(approve.status).toBe(0)
        expect(approve.stdout).toContain('approved')

        const patternsRaw = await readFile(join(dir, 'patterns.json'), 'utf-8')
        const patterns = JSON.parse(patternsRaw)
        expect(patterns.topFailureRules.find((p: { rule: number }) => p.rule === 90)?.state).toBe('confirmed')

        const auditRaw = await readFile(join(dir, 'pattern-audit.jsonl'), 'utf-8')
        const auditLines = auditRaw.trim().split('\n').map(l => JSON.parse(l))
        const humanEntry = auditLines.find(e => e.rule === 90 && e.actor === 'human')
        expect(humanEntry).toBeDefined()
        expect(humanEntry.to).toBe('confirmed')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('reject round-trip: pending_review -> resolved with reason, audit actor human', async () => {
      const { dir, telemetryDir } = await makeTelemetryWithFailures(91, 4)
      try {
        const env = { ANTHROPIC_API_KEY: 'sk-test', KAIROS_TELEMETRY: telemetryDir, KAIROS_PATTERN_REVIEW: 'true' }
        run(['patterns', '--json'], env)

        const reject = run(['patterns', 'reject', '91', 'known', 'false', 'positive'], env)
        expect(reject.status).toBe(0)
        expect(reject.stdout).toContain('rejected')

        const patternsRaw = await readFile(join(dir, 'patterns.json'), 'utf-8')
        const patterns = JSON.parse(patternsRaw)
        expect(patterns.topFailureRules.find((p: { rule: number }) => p.rule === 91)?.state).toBe('resolved')

        const auditRaw = await readFile(join(dir, 'pattern-audit.jsonl'), 'utf-8')
        const auditLines = auditRaw.trim().split('\n').map(l => JSON.parse(l))
        const humanEntry = auditLines.find(e => e.rule === 91 && e.actor === 'human')
        expect(humanEntry.reason).toBe('known false positive')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('approve exits with code 1 and a clear message when no pattern is pending review for that rule', async () => {
      const { dir, telemetryDir } = await makeTelemetryWithFailures(92, 1) // stays draft, never pending_review
      try {
        const env = { ANTHROPIC_API_KEY: 'sk-test', KAIROS_TELEMETRY: telemetryDir }
        run(['patterns', '--json'], env)
        const approve = run(['patterns', 'approve', '92'], env)
        expect(approve.status).toBe(1)
        expect(approve.stderr).toContain('No pattern awaiting review')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('--pending shows only patterns awaiting review', async () => {
      const { dir, telemetryDir } = await makeTelemetryWithFailures(93, 4)
      try {
        const env = { ANTHROPIC_API_KEY: 'sk-test', KAIROS_TELEMETRY: telemetryDir, KAIROS_PATTERN_REVIEW: 'true' }
        run(['patterns', '--json'], env)
        const pending = run(['patterns', '--pending'], env)
        expect(pending.status).toBe(0)
        expect(pending.stdout).toContain('Rule 93')
        expect(pending.stdout).toContain('Patterns Awaiting Review')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
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

  describe('sync-nodes', () => {
    it('exits with code 1 when N8N_BASE_URL/N8N_API_KEY are missing', () => {
      const r = run(['sync-nodes'], { N8N_BASE_URL: '', N8N_API_KEY: '' })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('N8N_BASE_URL')
    })

    describe('against a real (mocked) n8n instance', () => {
      let mockN8n: Server
      let mockN8nUrl: string

      afterAll(async () => {
        await new Promise<void>((resolve) => mockN8n.close(() => resolve()))
      })

      it('fetches node types, reports the count, and caches a registry containing the fixture node', async () => {
        mockN8n = createServer((req, res) => {
          if (req.method === 'GET' && req.url === '/api/v1/node-types') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              data: [
                { name: 'n8n-nodes-base.kairosTestFixtureNode', displayName: 'Kairos Test Fixture Node', version: 1 },
              ],
            }))
            return
          }
          res.writeHead(404)
          res.end()
        })
        await new Promise<void>((resolve) => mockN8n.listen(0, '127.0.0.1', resolve))
        const addr = mockN8n.address()
        if (addr === null || typeof addr === 'string') throw new Error('mock server failed to bind')
        mockN8nUrl = `http://127.0.0.1:${addr.port}`

        const telemetryDir = await mkdtemp(join(tmpdir(), 'kairos-cli-sync-nodes-'))
        try {
          // spawnSync (the run() helper) blocks this process's event loop while the
          // child runs — which would prevent the mock server above (living in this
          // same process) from ever answering the child's request. Needs a real async
          // spawn here so the server's event loop keeps running concurrently.
          const child = spawn(TSX, [CLI, 'sync-nodes'], {
            encoding: 'utf-8',
            env: { ...process.env, N8N_BASE_URL: mockN8nUrl, N8N_API_KEY: 'test-key', KAIROS_TELEMETRY: telemetryDir },
          })
          let stderr = ''
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
          const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

          expect(exitCode).toBe(0)
          expect(stderr).toContain('Synced')
          expect(stderr).toContain('1 new beyond the built-in registry')

          const cachePath = join(telemetryDir, '..', 'node-catalog-cache.json')
          const cached = JSON.parse(await readFile(cachePath, 'utf-8')) as { nodeDefinitions: Array<{ type: string }> }
          expect(cached.nodeDefinitions.some((d) => d.type === 'n8n-nodes-base.kairosTestFixtureNode')).toBe(true)
        } finally {
          await rm(telemetryDir, { recursive: true, force: true })
        }
      }, 15_000)
    })
  })

  describe('pack export --credentials', () => {
    it('prints a client-readable credentials.md, no n8n required', async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-credentials-'))
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Empire Homecare', packName: 'test-pack', status: 'ready_for_test',
          workflows: [
            { name: 'Missed-Call Text-Back', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Twilio', credentialType: 'twilioApi', description: 'Send SMS confirmation' }] },
          ],
          allCredentials: [{ service: 'Twilio', credentialType: 'twilioApi' }], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))

        const r = run(['pack', 'export', 'test-pack', '--credentials'], { HOME: fakeHome })
        expect(r.status).toBe(0)
        expect(r.stdout).toContain('# Empire Homecare — Required Credentials')
        expect(r.stdout).toContain('## Twilio')
        expect(r.stdout).toContain('Send SMS confirmation')
        expect(r.stdout).toContain('Missed-Call Text-Back')
      } finally {
        await rm(fakeHome, { recursive: true, force: true })
      }
    })
  })

  describe('pack export --risk-report', () => {
    it('prints a risk report combining pack-structural and per-workflow issues, no n8n required', async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-risk-'))
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Empire Homecare', packName: 'test-pack', status: 'needs_attention',
          workflows: [
            { name: 'Broken Workflow', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [], finalIssues: [{ rule: 17, severity: 'error', message: 'Bad credential shape' }] },
          ],
          allCredentials: [], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))

        const r = run(['pack', 'export', 'test-pack', '--risk-report'], { HOME: fakeHome })
        expect(r.status).toBe(0)
        expect(r.stdout).toContain('# Empire Homecare — Risk Report')
        expect(r.stdout).toContain('**Overall status:** NOT READY')
        expect(r.stdout).toContain('Rule 17')
        expect(r.stdout).toContain('Bad credential shape')
      } finally {
        await rm(fakeHome, { recursive: true, force: true })
      }
    })
  })

  describe('pack export --bundle', () => {
    it('writes the full deliverable set for a pack with one webhook and one non-webhook workflow, plus an accurate manifest', async () => {
      const mockN8n = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/api/v1/workflows/wf-webhook') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'wf-webhook', name: 'Referral Intake', active: true,
            nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'referrals', httpMethod: 'POST' } }],
            connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }))
          return
        }
        if (req.method === 'GET' && req.url === '/api/v1/workflows/wf-internal') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'wf-internal', name: 'Internal Routing', active: true,
            nodes: [{ id: 'n1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
            connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }))
          return
        }
        if (req.method === 'GET' && req.url?.startsWith('/api/v1/executions?')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [], nextCursor: null }))
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((resolve) => mockN8n.listen(0, '127.0.0.1', resolve))
      const addr = mockN8n.address()
      if (addr === null || typeof addr === 'string') throw new Error('mock server failed to bind')
      const mockN8nUrl = `http://127.0.0.1:${addr.port}`

      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-bundle-'))
      const outDir = join(fakeHome, 'out')
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Test Co', packName: 'test-pack', status: 'ready_for_test',
          workflows: [
            { name: 'Referral Intake', purpose: 'x', workflowId: 'wf-webhook', deployed: true, generationAttempts: 1, credentialsNeeded: [{ service: 'Gmail', credentialType: 'gmailOAuth2', description: 'x' }], finalIssues: [] },
            { name: 'Internal Routing', purpose: 'x', workflowId: 'wf-internal', deployed: true, generationAttempts: 1, credentialsNeeded: [], finalIssues: [] },
          ],
          allCredentials: [{ service: 'Gmail', credentialType: 'gmailOAuth2' }], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))

        const child = spawn(TSX, [CLI, 'pack', 'export', 'test-pack', '--bundle', outDir], {
          encoding: 'utf-8',
          env: { ...process.env, HOME: fakeHome, N8N_BASE_URL: mockN8nUrl, N8N_API_KEY: 'test-key' },
        })
        const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
        expect(exitCode).toBe(0)

        // Pack-level artifacts always present
        for (const name of ['handoff.md', 'credentials.md', 'risk-report.md', 'monitoring-plan.md', 'bundle-manifest.json']) {
          await expect(readFile(join(outDir, name), 'utf-8')).resolves.toBeTruthy()
        }
        // Per-workflow artifacts for the webhook workflow
        await expect(readFile(join(outDir, 'referral-intake.workflow.json'), 'utf-8')).resolves.toBeTruthy()
        await expect(readFile(join(outDir, 'referral-intake.test-payloads.json'), 'utf-8')).resolves.toBeTruthy()
        await expect(readFile(join(outDir, 'referral-intake.contract.openapi.json'), 'utf-8')).resolves.toBeTruthy()
        // workflow.json still applies to the non-webhook workflow
        await expect(readFile(join(outDir, 'internal-routing.workflow.json'), 'utf-8')).resolves.toBeTruthy()
        // webhook-only artifacts must be ABSENT (not empty-but-present) for the non-webhook workflow
        await expect(readFile(join(outDir, 'internal-routing.test-payloads.json'), 'utf-8')).rejects.toThrow()
        await expect(readFile(join(outDir, 'internal-routing.contract.openapi.json'), 'utf-8')).rejects.toThrow()

        const manifest = JSON.parse(await readFile(join(outDir, 'bundle-manifest.json'), 'utf-8'))
        expect(manifest.files.some((f: { path: string }) => f.path.endsWith('internal-routing.workflow.json'))).toBe(true)
        expect(manifest.skipped.some((s: { artifact: string; workflowName?: string }) => s.artifact === 'test-payloads.json' && s.workflowName === 'Internal Routing')).toBe(true)
        expect(manifest.skipped.some((s: { artifact: string; workflowName?: string }) => s.artifact === 'contract.openapi.json' && s.workflowName === 'Internal Routing')).toBe(true)
      } finally {
        await new Promise<void>((resolve) => mockN8n.close(() => resolve()))
        await rm(fakeHome, { recursive: true, force: true })
      }
    }, 15_000)
  })

  describe('pack export --test-payloads', () => {
    it('fetches each webhook-shaped workflow live and writes a heuristic sample payload, skipping non-webhook workflows', async () => {
      const mockN8n = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/api/v1/workflows/wf-webhook') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'wf-webhook', name: 'Referral Intake', active: true,
            nodes: [
              { id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'referrals', httpMethod: 'POST' } },
              { id: 'n2', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 1, position: [200, 0], parameters: { text: '={{$json.body.email}}' } },
            ],
            connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }))
          return
        }
        if (req.method === 'GET' && req.url === '/api/v1/workflows/wf-internal') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'wf-internal', name: 'Internal Routing', active: true,
            nodes: [{ id: 'n1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
            connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }))
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((resolve) => mockN8n.listen(0, '127.0.0.1', resolve))
      const addr = mockN8n.address()
      if (addr === null || typeof addr === 'string') throw new Error('mock server failed to bind')
      const mockN8nUrl = `http://127.0.0.1:${addr.port}`

      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-payloads-'))
      const outDir = join(fakeHome, 'out')
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Test Co', packName: 'test-pack', status: 'ready_for_test',
          workflows: [
            { name: 'Referral Intake', purpose: 'x', workflowId: 'wf-webhook', deployed: true, generationAttempts: 1, credentialsNeeded: [] },
            { name: 'Internal Routing', purpose: 'x', workflowId: 'wf-internal', deployed: true, generationAttempts: 1, credentialsNeeded: [] },
          ],
          allCredentials: [], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))

        const child = spawn(TSX, [CLI, 'pack', 'export', 'test-pack', '--test-payloads', outDir], {
          encoding: 'utf-8',
          env: { ...process.env, HOME: fakeHome, N8N_BASE_URL: mockN8nUrl, N8N_API_KEY: 'test-key' },
        })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

        expect(exitCode).toBe(0)
        expect(stderr).toContain('1 test-payloads.json file(s) written')
        expect(stderr).toContain('1 skipped')

        const written = JSON.parse(await readFile(join(outDir, 'referral-intake.test-payloads.json'), 'utf-8'))
        expect(written.url).toBe('referrals')
        expect(written.sampleBody).toEqual({ email: 'test@example.com' })
        expect(written.note).toContain('best-effort guess')
      } finally {
        await new Promise<void>((resolve) => mockN8n.close(() => resolve()))
        await rm(fakeHome, { recursive: true, force: true })
      }
    }, 15_000)
  })

  describe('pack export --monitoring-plan', () => {
    it('reports live status and latest execution, requires N8N_BASE_URL/N8N_API_KEY', async () => {
      const mockN8n = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/api/v1/workflows/wf-1') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'wf-1', name: 'Missed-Call Text-Back', active: true,
            nodes: [], connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }))
          return
        }
        if (req.method === 'GET' && req.url?.startsWith('/api/v1/executions?')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'exec-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-01-01T00:00:01.000Z', mode: 'trigger' }], nextCursor: null }))
          return
        }
        if (req.method === 'GET' && req.url === '/api/v1/executions/exec-1') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'exec-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-01-01T00:00:01.000Z', mode: 'trigger',
            data: { resultData: { runData: { 'Send SMS': [{ executionTime: 250 }] } } },
          }))
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((resolve) => mockN8n.listen(0, '127.0.0.1', resolve))
      const addr = mockN8n.address()
      if (addr === null || typeof addr === 'string') throw new Error('mock server failed to bind')
      const mockN8nUrl = `http://127.0.0.1:${addr.port}`

      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-monitoring-'))
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Empire Homecare', packName: 'test-pack', status: 'active',
          workflows: [{ name: 'Missed-Call Text-Back', purpose: 'x', workflowId: 'wf-1', deployed: true, generationAttempts: 1, credentialsNeeded: [] }],
          allCredentials: [], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))

        const child = spawn(TSX, [CLI, 'pack', 'export', 'test-pack', '--monitoring-plan'], {
          encoding: 'utf-8',
          env: { ...process.env, HOME: fakeHome, N8N_BASE_URL: mockN8nUrl, N8N_API_KEY: 'test-key' },
        })
        let stdout = ''
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
        const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

        expect(exitCode).toBe(0)
        expect(stdout).toContain('# Empire Homecare — Monitoring Plan')
        expect(stdout).toContain('**Status:** Active')
        expect(stdout).toContain('Send SMS (250ms)')
        expect(stdout).toContain('Insufficient history for drift comparison')
        expect(stdout).toContain('## Weekly Checklist')
      } finally {
        await new Promise<void>((resolve) => mockN8n.close(() => resolve()))
        await rm(fakeHome, { recursive: true, force: true })
      }
    }, 15_000)

    it('exits 1 when N8N_BASE_URL/N8N_API_KEY are missing', async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-monitoring-noenv-'))
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Test Co', packName: 'test-pack', status: 'ready_for_test',
          workflows: [], allCredentials: [], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))
        const r = run(['pack', 'export', 'test-pack', '--monitoring-plan'], { HOME: fakeHome, N8N_BASE_URL: '', N8N_API_KEY: '' })
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('N8N_BASE_URL and N8N_API_KEY are required')
      } finally {
        await rm(fakeHome, { recursive: true, force: true })
      }
    })
  })

  describe('pack export --workflow-json', () => {
    it('fetches each workflow live from n8n and writes stripped workflow.json files, skipping ones that fail', async () => {
      const mockN8n = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/api/v1/workflows/wf-good') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'wf-good', name: 'Referral Intake', active: true,
            nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
            connections: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }))
          return
        }
        if (req.method === 'GET' && req.url === '/api/v1/workflows/wf-bad') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'not found' }))
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((resolve) => mockN8n.listen(0, '127.0.0.1', resolve))
      const addr = mockN8n.address()
      if (addr === null || typeof addr === 'string') throw new Error('mock server failed to bind')
      const mockN8nUrl = `http://127.0.0.1:${addr.port}`

      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-export-'))
      const outDir = join(fakeHome, 'out')
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Test Co', packName: 'test-pack', status: 'ready_for_test',
          workflows: [
            { name: 'Referral Intake', purpose: 'x', workflowId: 'wf-good', deployed: true, generationAttempts: 1, credentialsNeeded: [] },
            { name: 'Broken One', purpose: 'x', workflowId: 'wf-bad', deployed: true, generationAttempts: 1, credentialsNeeded: [] },
          ],
          allCredentials: [], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))

        const child = spawn(TSX, [CLI, 'pack', 'export', 'test-pack', '--workflow-json', outDir], {
          encoding: 'utf-8',
          env: { ...process.env, HOME: fakeHome, N8N_BASE_URL: mockN8nUrl, N8N_API_KEY: 'test-key' },
        })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

        expect(exitCode).toBe(0)
        expect(stderr).toContain('1 workflow.json file(s) written')
        expect(stderr).toContain('1 skipped')
        expect(stderr).toContain('Broken One')

        const written = JSON.parse(await readFile(join(outDir, 'referral-intake.workflow.json'), 'utf-8'))
        expect(written).toEqual({
          name: 'Referral Intake',
          nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
          connections: {},
        })
      } finally {
        await new Promise<void>((resolve) => mockN8n.close(() => resolve()))
        await rm(fakeHome, { recursive: true, force: true })
      }
    }, 15_000)

    it('exits 1 with a clear message when N8N_BASE_URL/N8N_API_KEY are missing', async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-pack-export-noenv-'))
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const packsDir = join(fakeHome, '.kairos', 'packs')
        await mkdir(packsDir, { recursive: true })
        await writeFile(join(packsDir, 'test-pack.json'), JSON.stringify({
          businessContext: 'Test Co', packName: 'test-pack', status: 'ready_for_test',
          workflows: [], allCredentials: [], sheetsColumns: [], assumptions: [], testChecklist: [], builtAt: '2026-01-01T00:00:00.000Z',
        }))
        const r = run(['pack', 'export', 'test-pack', '--workflow-json', '/tmp/out'], { HOME: fakeHome, N8N_BASE_URL: '', N8N_API_KEY: '' })
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('N8N_BASE_URL and N8N_API_KEY are required')
      } finally {
        await rm(fakeHome, { recursive: true, force: true })
      }
    })
  })
})
