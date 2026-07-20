import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { saveProcessContract, loadProcessContract, listProcessContracts } from '../../../src/promise/store.js'
import type { ProcessContract } from '../../../src/promise/types.js'

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'test-contract',
    version: 1,
    clientId: 'test-client',
    name: 'Test Contract',
    description: 'A minimal contract for store.ts tests.',
    entity: { name: 'Thing', description: 'A thing.' },
    correlationKey: { fieldPath: 'body.id', description: 'The thing id.' },
    promise: { text: 'The thing is handled.' },
    startConditions: [{ id: 'sc1', description: 'A thing arrives.', trigger: 'webhook', initialState: 's1' }],
    states: [{ id: 's1', name: 'Received', description: 'Just arrived.', terminal: false }, { id: 's2', name: 'Done', description: 'Handled.', terminal: true }],
    events: [{ id: 'e1', name: 'Handled', description: 'The thing was handled.' }],
    transitions: [{ id: 't1', fromState: 's1', event: 'e1', toState: 's2' }],
    terminalOutcomes: [{ state: 's2', outcome: 'success', description: 'Handled successfully.' }],
    owners: [],
    sla: [],
    exceptions: [],
    evidenceRequirements: [],
    assumptions: [],
    provenance: { kairosVersion: '0.11.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'draft',
    ...overrides,
  }
}

// Redirect HOME so these tests never touch the real ~/.kairos/contracts directory -- same
// discipline as snapshot.test.ts/capture.test.ts, since this is the same class of test-isolation
// risk (a prior bug in this codebase let test data leak into the real ~/.kairos/ directory).
let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-promise-store-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('saveProcessContract / loadProcessContract / listProcessContracts', () => {
  it('round-trips a single contract', async () => {
    const contract = makeContract()
    const saved = await saveProcessContract(contract)
    expect(saved.path).toContain('test-client')
    expect(saved.path).toContain('test-contract.json')

    const loaded = await loadProcessContract('test-client', 'test-contract')
    expect(loaded).toEqual(contract)
  })

  it('the saved file is chmod 600 -- same local-only posture as capture.ts/snapshot.ts', async () => {
    await saveProcessContract(makeContract())
    const path = join(scratchHome, '.kairos', 'contracts', 'test-client', 'test-contract.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('loadProcessContract returns null, not a throw, when nothing was ever saved', async () => {
    const loaded = await loadProcessContract('nobody', 'nothing')
    expect(loaded).toBeNull()
  })

  it('re-saving the same id overwrites (no versioning in Phase 0, by design)', async () => {
    await saveProcessContract(makeContract({ name: 'Original Name' }))
    await saveProcessContract(makeContract({ name: 'Updated Name' }))
    const loaded = await loadProcessContract('test-client', 'test-contract')
    expect(loaded!.name).toBe('Updated Name')
  })

  it('listProcessContracts returns every contract saved for a client', async () => {
    await saveProcessContract(makeContract({ id: 'contract-a' }))
    await saveProcessContract(makeContract({ id: 'contract-b' }))
    const list = await listProcessContracts('test-client')
    expect(list.map(c => c.id).sort()).toEqual(['contract-a', 'contract-b'])
  })

  it('listProcessContracts returns an empty array, not a throw, for a client with no contracts', async () => {
    const list = await listProcessContracts('nobody-ever-saved-here')
    expect(list).toEqual([])
  })

  it('contracts are scoped per clientId -- one client never sees another client\'s contracts', async () => {
    await saveProcessContract(makeContract({ clientId: 'client-a', id: 'shared-id' }))
    await saveProcessContract(makeContract({ clientId: 'client-b', id: 'shared-id' }))
    const listA = await listProcessContracts('client-a')
    const listB = await listProcessContracts('client-b')
    expect(listA).toHaveLength(1)
    expect(listB).toHaveLength(1)
    expect(listA[0]!.clientId).toBe('client-a')
    expect(listB[0]!.clientId).toBe('client-b')
  })

  it('a corrupted contract file is skipped by listProcessContracts, not fatal to the rest', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await saveProcessContract(makeContract({ id: 'good-contract' }))
    const dir = join(scratchHome, '.kairos', 'contracts', 'test-client')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'corrupted.json'), '{not valid json', 'utf-8')

    const list = await listProcessContracts('test-client')
    expect(list.map(c => c.id)).toEqual(['good-contract'])
  })
})
