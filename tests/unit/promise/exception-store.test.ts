import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadExceptionDeskItems, upsertExceptionDeskItems, saveExceptionDeskItem } from '../../../src/promise/exception-store.js'
import type { ExceptionDeskItem } from '../../../src/promise/exception-types.js'

const CLIENT_A = 'empire-homecare'
const CLIENT_B = 'a-different-client'

function makeItem(overrides: Partial<ExceptionDeskItem> = {}): ExceptionDeskItem {
  return {
    id: 'c1:instance-1:sla:sla-first-contact',
    contractId: 'c1',
    promiseInstanceId: 'instance-1',
    kind: 'missed_sla',
    status: 'open',
    owner: 'on-call rep',
    nextAction: 'Call.',
    reason: 'SLA missed.',
    evidence: [],
    slaId: 'sla-first-contact',
    detectedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    history: [{ ts: '2026-01-01T00:00:00.000Z', from: null, to: 'open', actor: 'auto' }],
    ...overrides,
  }
}

let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-exception-store-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('upsertExceptionDeskItems / loadExceptionDeskItems', () => {
  it('round-trips a single item', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem()])
    const items = await loadExceptionDeskItems(CLIENT_A, 'c1')
    expect(items).toEqual([makeItem()])
  })

  it('a no-op upsert (empty array) never creates the file', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [])
    expect(await loadExceptionDeskItems(CLIENT_A, 'c1')).toEqual([])
  })

  it('appends genuinely new items without touching existing ones', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem({ id: 'item-1' })])
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem({ id: 'item-2', promiseInstanceId: 'instance-2' })])
    const items = await loadExceptionDeskItems(CLIENT_A, 'c1')
    expect(items.map(i => i.id).sort()).toEqual(['item-1', 'item-2'])
  })

  it('replaces an existing item with the same id rather than duplicating it', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem({ id: 'item-1', status: 'open' })])
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem({ id: 'item-1', status: 'resolved' })])
    const items = await loadExceptionDeskItems(CLIENT_A, 'c1')
    expect(items).toHaveLength(1)
    expect(items[0]!.status).toBe('resolved')
  })

  it('loadExceptionDeskItems returns an empty array, not a throw, when nothing was ever saved', async () => {
    expect(await loadExceptionDeskItems(CLIENT_A, 'nobody-ever-saved-here')).toEqual([])
  })

  it('items are scoped per contractId', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'contract-a', [makeItem({ contractId: 'contract-a' })])
    await upsertExceptionDeskItems(CLIENT_A, 'contract-b', [makeItem({ contractId: 'contract-b' })])
    expect(await loadExceptionDeskItems(CLIENT_A, 'contract-a')).toHaveLength(1)
    expect(await loadExceptionDeskItems(CLIENT_A, 'contract-b')).toHaveLength(1)
  })

  it('the saved file is chmod 600', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem()])
    const path = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1', 'exceptions.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('writes files under <clientId>/<contractId>/, not <contractId>/ alone', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem()])
    const scopedPath = join(scratchHome, '.kairos', 'promise-ledger', CLIENT_A, 'c1', 'exceptions.json')
    const unscopedPath = join(scratchHome, '.kairos', 'promise-ledger', 'c1', 'exceptions.json')
    await expect(stat(scopedPath)).resolves.toBeDefined()
    await expect(stat(unscopedPath)).rejects.toThrow()
  })

  // Finding 1 fix (supplemental measurement-integrity audit, 2026-07-20) -- the whole point of
  // this fix. contractId alone has no cross-client uniqueness guarantee (deriveContractId() is
  // just a slug of the contract's own name) -- two different clients whose contracts happen to
  // share a contractId must NOT share an exceptions.json. Before this fix, a human resolving an
  // exception for client A's contract could have silently mutated client B's exception item (or
  // vice versa) if their ids collided.
  it('SECURITY: two different clientIds with the SAME contractId have fully isolated exceptions', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'shared-contract-id', [makeItem({ contractId: 'shared-contract-id', id: 'client-a-item', owner: 'Client A owner' })])
    await upsertExceptionDeskItems(CLIENT_B, 'shared-contract-id', [makeItem({ contractId: 'shared-contract-id', id: 'client-b-item', owner: 'Client B owner' })])

    const aItems = await loadExceptionDeskItems(CLIENT_A, 'shared-contract-id')
    const bItems = await loadExceptionDeskItems(CLIENT_B, 'shared-contract-id')

    expect(aItems.map(i => i.id)).toEqual(['client-a-item'])
    expect(bItems.map(i => i.id)).toEqual(['client-b-item'])
    // Neither client's read ever contains the other's item, by construction (different files).
    expect(aItems.map(i => i.id)).not.toContain('client-b-item')
    expect(bItems.map(i => i.id)).not.toContain('client-a-item')
  })

  it('SECURITY: resolving an item under one clientId never touches the other client\'s item with the same contractId', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'shared-contract-id', [makeItem({ contractId: 'shared-contract-id', id: 'same-item-id', status: 'open' })])
    await upsertExceptionDeskItems(CLIENT_B, 'shared-contract-id', [makeItem({ contractId: 'shared-contract-id', id: 'same-item-id', status: 'open' })])

    // A human resolves client A's item.
    await upsertExceptionDeskItems(CLIENT_A, 'shared-contract-id', [makeItem({ contractId: 'shared-contract-id', id: 'same-item-id', status: 'resolved' })])

    const aItems = await loadExceptionDeskItems(CLIENT_A, 'shared-contract-id')
    const bItems = await loadExceptionDeskItems(CLIENT_B, 'shared-contract-id')
    expect(aItems[0]!.status).toBe('resolved')
    expect(bItems[0]!.status).toBe('open') // client B's own item untouched
  })

  // P0 measurement-integrity fix (2026-07-20): the exact scenario this fix targets -- a human
  // resolving one item (`kairos exceptions resolve`) at the same moment a watch tick
  // (`kairos watch --contracts`) refreshes/opens a different item for the same contract. Before
  // the lock, whichever write landed second would silently win in full, discarding the other's
  // update -- a human's resolution could be reverted with no error and no trace.
  it('a concurrent human resolve and watch-tick refresh for different items both survive', async () => {
    await upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem({ id: 'item-1', status: 'open' })])

    const humanResolve = upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem({ id: 'item-1', status: 'resolved' })])
    const watchTickOpensNew = upsertExceptionDeskItems(CLIENT_A, 'c1', [makeItem({ id: 'item-2', promiseInstanceId: 'instance-2', status: 'open' })])
    await Promise.all([humanResolve, watchTickOpensNew])

    const items = await loadExceptionDeskItems(CLIENT_A, 'c1')
    const byId = new Map(items.map(i => [i.id, i]))
    expect(byId.get('item-1')?.status).toBe('resolved')
    expect(byId.get('item-2')?.status).toBe('open')
  })
})

describe('saveExceptionDeskItem', () => {
  it('saves a single item via the same upsert path', async () => {
    await saveExceptionDeskItem(CLIENT_A, 'c1', makeItem({ id: 'solo-item' }))
    const items = await loadExceptionDeskItems(CLIENT_A, 'c1')
    expect(items.map(i => i.id)).toEqual(['solo-item'])
  })
})
