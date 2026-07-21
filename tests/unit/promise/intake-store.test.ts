import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { saveIntakeSession, loadIntakeSession } from '../../../src/promise/intake-store.js'
import { saveProcessContract, listProcessContracts } from '../../../src/promise/store.js'
import { createIntakeSession, recordAnswer, INTAKE_QUESTIONS } from '../../../src/promise/intake.js'
import type { ProcessContract } from '../../../src/promise/types.js'

// Same scratch-HOME isolation discipline as store.test.ts -- never touch the real
// ~/.kairos/contracts directory.
let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-intake-store-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

function makeContract(overrides: Partial<ProcessContract> = {}): ProcessContract {
  return {
    id: 'test-contract',
    version: 1,
    clientId: 'test-client',
    name: 'Test Contract',
    description: 'A minimal contract for intake-store.ts tests.',
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
    provenance: { kairosVersion: '0.12.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    status: 'draft',
    ...overrides,
  }
}

describe('saveIntakeSession / loadIntakeSession', () => {
  it('round-trips a session', async () => {
    const session = createIntakeSession('test-client')
    const { path } = await saveIntakeSession(session)
    expect(path).toContain('test-client')
    expect(path).toContain('_intake-sessions')
    expect(path).toContain(`${session.id}.json`)

    const loaded = await loadIntakeSession('test-client', session.id)
    expect(loaded).toEqual(session)
  })

  it('the saved file is chmod 600, same local-only posture as store.ts', async () => {
    const session = createIntakeSession('test-client')
    await saveIntakeSession(session)
    const path = join(scratchHome, '.kairos', 'contracts', 'test-client', '_intake-sessions', `${session.id}.json`)
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('loadIntakeSession returns null, not a throw, for an unknown id', async () => {
    expect(await loadIntakeSession('test-client', 'nonexistent-session')).toBeNull()
  })

  it('re-saving the same session id overwrites, preserving new turns', async () => {
    let session = createIntakeSession('test-client')
    await saveIntakeSession(session)
    session = recordAnswer(session, INTAKE_QUESTIONS[0]!, 'A webhook.')
    await saveIntakeSession(session)

    const loaded = await loadIntakeSession('test-client', session.id)
    expect(loaded!.turns).toHaveLength(1)
  })

  it('sessions are scoped per clientId', async () => {
    const sessionA = createIntakeSession('client-a')
    const sessionB = createIntakeSession('client-b')
    await saveIntakeSession(sessionA)
    await saveIntakeSession(sessionB)

    expect(await loadIntakeSession('client-a', sessionB.id)).toBeNull()
    expect(await loadIntakeSession('client-b', sessionA.id)).toBeNull()
    expect((await loadIntakeSession('client-a', sessionA.id))?.id).toBe(sessionA.id)
  })

  it('an intake session file never appears in listProcessContracts -- the _intake-sessions subdirectory is invisible to the non-recursive contract scan', async () => {
    await saveProcessContract(makeContract())
    const session = createIntakeSession('test-client')
    await saveIntakeSession(session)

    const contracts = await listProcessContracts('test-client')
    expect(contracts.map(c => c.id)).toEqual(['test-contract'])
  })
})
