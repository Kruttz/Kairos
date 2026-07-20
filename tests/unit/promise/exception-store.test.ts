import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadExceptionDeskItems, upsertExceptionDeskItems, saveExceptionDeskItem } from '../../../src/promise/exception-store.js'
import type { ExceptionDeskItem } from '../../../src/promise/exception-types.js'

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
    await upsertExceptionDeskItems('c1', [makeItem()])
    const items = await loadExceptionDeskItems('c1')
    expect(items).toEqual([makeItem()])
  })

  it('a no-op upsert (empty array) never creates the file', async () => {
    await upsertExceptionDeskItems('c1', [])
    expect(await loadExceptionDeskItems('c1')).toEqual([])
  })

  it('appends genuinely new items without touching existing ones', async () => {
    await upsertExceptionDeskItems('c1', [makeItem({ id: 'item-1' })])
    await upsertExceptionDeskItems('c1', [makeItem({ id: 'item-2', promiseInstanceId: 'instance-2' })])
    const items = await loadExceptionDeskItems('c1')
    expect(items.map(i => i.id).sort()).toEqual(['item-1', 'item-2'])
  })

  it('replaces an existing item with the same id rather than duplicating it', async () => {
    await upsertExceptionDeskItems('c1', [makeItem({ id: 'item-1', status: 'open' })])
    await upsertExceptionDeskItems('c1', [makeItem({ id: 'item-1', status: 'resolved' })])
    const items = await loadExceptionDeskItems('c1')
    expect(items).toHaveLength(1)
    expect(items[0]!.status).toBe('resolved')
  })

  it('loadExceptionDeskItems returns an empty array, not a throw, when nothing was ever saved', async () => {
    expect(await loadExceptionDeskItems('nobody-ever-saved-here')).toEqual([])
  })

  it('items are scoped per contractId', async () => {
    await upsertExceptionDeskItems('contract-a', [makeItem({ contractId: 'contract-a' })])
    await upsertExceptionDeskItems('contract-b', [makeItem({ contractId: 'contract-b' })])
    expect(await loadExceptionDeskItems('contract-a')).toHaveLength(1)
    expect(await loadExceptionDeskItems('contract-b')).toHaveLength(1)
  })

  it('the saved file is chmod 600', async () => {
    await upsertExceptionDeskItems('c1', [makeItem()])
    const path = join(scratchHome, '.kairos', 'promise-ledger', 'c1', 'exceptions.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })
})

describe('saveExceptionDeskItem', () => {
  it('saves a single item via the same upsert path', async () => {
    await saveExceptionDeskItem('c1', makeItem({ id: 'solo-item' }))
    const items = await loadExceptionDeskItems('c1')
    expect(items.map(i => i.id)).toEqual(['solo-item'])
  })
})
