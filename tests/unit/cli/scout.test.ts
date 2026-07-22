import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/**
 * End-to-end CLI coverage for roadmap item 14 (Operations Scout v0, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 14) -- `kairos scout analyze`. Real subprocess
 * runs (matching every other CLI test file's own established idiom) -- everything this command
 * touches is local file I/O, no network/LLM/n8n, no --client-id needed at all (Scout is not
 * scoped to any saved contract or client).
 */

vi.setConfig({ testTimeout: 30_000 })

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../../src/cli.ts')

let scratchHome: string
let workDir: string

function run(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: scratchHome },
    timeout: 20_000,
  })
}

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-scout-cli-test-home-'))
  workDir = await mkdtemp(join(tmpdir(), 'kairos-scout-cli-test-work-'))
})

afterEach(async () => {
  await rm(scratchHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

function daysAgo(d: number): string {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
}

async function writeSampleCsv(): Promise<string> {
  const path = join(workDir, 'referrals.csv')
  const csv = [
    'Referral ID,Status,Updated,Owner',
    `A1,open,${daysAgo(45)},`, // stale + missing owner
    `A2,closed,${daysAgo(2)},alice`,
    `A3,open,${daysAgo(50)},bob`, // stale
    `A1,open,${daysAgo(45)},`, // duplicate of A1
  ].join('\n')
  await writeFile(path, csv, 'utf-8')
  return path
}

describe('kairos scout analyze', () => {
  it('produces findings from a real CSV file, in --json', async () => {
    const path = await writeSampleCsv()
    const r = run(['scout', 'analyze', path, '--json'])
    expect(r.status).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.source.path).toBe(path)
    expect(report.rowCount).toBe(4)
    expect(report.findings.length).toBeGreaterThan(0)
    const stale = report.findings.find((f: { checkId: string }) => f.checkId === 'STALE_ROWS')
    expect(stale).toBeDefined()
  })

  it('the rendered text output never contains a raw cell value', async () => {
    const path = join(workDir, 'sensitive.csv')
    const SENTINEL = 'CONFIDENTIAL-CUSTOMER-9999'
    await writeFile(path, `ID,Status,Updated\n1,${SENTINEL},${daysAgo(60)}\n2,${SENTINEL},${daysAgo(59)}\n3,${SENTINEL},${daysAgo(58)}\n`, 'utf-8')
    const r = run(['scout', 'analyze', path])
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain(SENTINEL)
  })

  it('honors explicit column hints', async () => {
    const path = join(workDir, 'weird.csv')
    await writeFile(path, 'Ticket,Current State,Handler\n1,open,alice\n2,open,bob\n3,open,carol\n', 'utf-8')
    const r = run(['scout', 'analyze', path, '--status-column', 'Current State', '--owner-column', 'Handler', '--json'])
    expect(r.status).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.columnRoles.statusColumn).toEqual({ column: 'Current State', source: 'hint' })
    expect(report.columnRoles.ownerColumn).toEqual({ column: 'Handler', source: 'hint' })
  })

  it('--out writes opportunity-report.md, opportunity-report.json, and a manifest', async () => {
    const path = await writeSampleCsv()
    const outDir = join(workDir, 'scout-output')
    const r = run(['scout', 'analyze', path, '--out', outDir])
    expect(r.status).toBe(0)

    const md = await readFile(join(outDir, 'opportunity-report.md'), 'utf-8')
    expect(md).toContain('Operations Scout')
    const json = JSON.parse(await readFile(join(outDir, 'opportunity-report.json'), 'utf-8'))
    expect(json.source.path).toBe(path)
    const manifest = JSON.parse(await readFile(join(outDir, 'opportunity-report-manifest.json'), 'utf-8'))
    expect(manifest.sourceFile).toBe(path)
    expect(manifest.files).toHaveLength(2)
  })

  it('refuses cleanly for a nonexistent file', async () => {
    const r = run(['scout', 'analyze', join(workDir, 'does-not-exist.csv')])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Could not read or parse')
  })

  it('prints usage and exits 1 with no arguments', async () => {
    const r = run(['scout'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Usage: kairos scout analyze')
  })
})
