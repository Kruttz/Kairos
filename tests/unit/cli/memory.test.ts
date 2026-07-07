import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')
const CLI = join(__dirname, '../../../src/cli.ts')

let fakeHome: string

function run(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf-8',
    // Embeddings off: this file tests CLI mechanics, not the optional embedding path, and
    // fastembed is a devDependency here so it would otherwise try to load a real model.
    env: { ...process.env, HOME: fakeHome, KAIROS_MEMORY_EMBEDDINGS: 'off' },
    timeout: 10_000,
  })
}

describe('kairos memory — CLI', () => {
  afterEach(async () => {
    if (fakeHome) await rm(fakeHome, { recursive: true, force: true })
  })

  it('add writes a memory node and prints it as JSON', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    const r = run(['memory', 'add', 'cli-test-client', 'preference', 'Likes weekly digest emails', '--tags', 'email,frequency'])
    expect(r.status).toBe(0)
    const node = JSON.parse(r.stdout)
    expect(node.type).toBe('preference')
    expect(node.description).toBe('Likes weekly digest emails')
    expect(node.tags).toEqual(['email', 'frequency'])
  })

  it('rejects an unknown memory type', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    const r = run(['memory', 'add', 'cli-test-client', 'not-a-real-type', 'some description'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Usage: kairos memory add')
  })

  it('list shows nodes added for that client', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    run(['memory', 'add', 'cli-test-client', 'reference', 'Sheet ID is abc123'])
    const r = run(['memory', 'list', 'cli-test-client'])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('1 memory node(s)')
    expect(r.stderr).toContain('Sheet ID is abc123')
  })

  it('list --json returns parseable JSON', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    run(['memory', 'add', 'cli-test-client', 'reference', 'Some fact'])
    const r = run(['memory', 'list', 'cli-test-client', '--json'])
    expect(r.status).toBe(0)
    const nodes = JSON.parse(r.stdout)
    expect(Array.isArray(nodes)).toBe(true)
    expect(nodes).toHaveLength(1)
  })

  it('list --type filters by memory type', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    run(['memory', 'add', 'cli-test-client', 'preference', 'A preference'])
    run(['memory', 'add', 'cli-test-client', 'history', 'A history event'])
    const r = run(['memory', 'list', 'cli-test-client', '--type', 'preference', '--json'])
    const nodes = JSON.parse(r.stdout)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].type).toBe('preference')
  })

  it('search finds a relevant memory by query', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    run(['memory', 'add', 'cli-test-client', 'preference', 'Prefers concise Slack notifications'])
    const r = run(['memory', 'search', 'cli-test-client', 'concise slack'])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('Prefers concise Slack notifications')
  })

  it('forget removes a memory node by id', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    const addResult = run(['memory', 'add', 'cli-test-client', 'reference', 'To be forgotten'])
    const node = JSON.parse(addResult.stdout)
    const r = run(['memory', 'forget', 'cli-test-client', node.id])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('Forgot memory')

    const listResult = run(['memory', 'list', 'cli-test-client', '--json'])
    expect(JSON.parse(listResult.stdout)).toEqual([])
  })

  it('forget exits 1 for an unknown id', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    const r = run(['memory', 'forget', 'cli-test-client', 'nonexistent-id'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('No memory found')
  })

  it('rebuild-index reports the correct count', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    run(['memory', 'add', 'cli-test-client', 'preference', 'a'])
    run(['memory', 'add', 'cli-test-client', 'history', 'b'])
    const r = run(['memory', 'rebuild-index', 'cli-test-client'])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('Rebuilt index: 2 memory node(s)')
  })

  it('rejects an invalid client id (fail-closed)', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    const r = run(['memory', 'add', '../../etc', 'reference', 'x'])
    expect(r.status).not.toBe(0)
  })

  it('an unknown memory subcommand prints usage and exits 1', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    const r = run(['memory', 'not-a-command'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Unknown memory subcommand')
  })

  it('two different clients never see each other\'s memories via the CLI', async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'kairos-cli-memory-'))
    run(['memory', 'add', 'client-a', 'preference', 'Client A only'])
    run(['memory', 'add', 'client-b', 'preference', 'Client B only'])
    const listA = JSON.parse(run(['memory', 'list', 'client-a', '--json']).stdout)
    const listB = JSON.parse(run(['memory', 'list', 'client-b', '--json']).stdout)
    expect(listA).toHaveLength(1)
    expect(listB).toHaveLength(1)
    expect(listA[0].description).toBe('Client A only')
    expect(listB[0].description).toBe('Client B only')
  })
})
