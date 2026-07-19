import { describe, it, expect } from 'vitest'
import { N8nFieldStripper } from '../../../../src/providers/n8n/stripper.js'
import { FORBIDDEN_ON_CREATE, FORBIDDEN_ON_UPDATE } from '../../../../src/providers/n8n/types.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'

const baseWorkflow = (): N8nWorkflow => ({
  name: 'Test Workflow',
  nodes: [
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [250, 300],
      parameters: {},
    },
  ],
  connections: {},
})

describe('N8nFieldStripper', () => {
  const stripper = new N8nFieldStripper()

  it('stripForCreate removes all forbidden create fields', () => {
    const dirty = {
      ...baseWorkflow(),
      id: 'server-generated-id',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
      versionId: 'abc',
      meta: { someField: true },
      isArchived: false,
      activeVersionId: 'xyz',
      activeVersion: 1,
      active: true,
      pinData: {},
      triggerCount: 5,
      shared: false,
    } as unknown as N8nWorkflow

    const stripped = stripper.stripForCreate(dirty)

    for (const field of FORBIDDEN_ON_CREATE) {
      expect(stripped).not.toHaveProperty(field)
    }
  })

  it('stripForCreate preserves required fields', () => {
    const w = baseWorkflow()
    const stripped = stripper.stripForCreate(w)
    expect(stripped.name).toBe(w.name)
    expect(stripped.nodes).toEqual(w.nodes)
    expect(stripped.connections).toEqual(w.connections)
  })

  it('stripForCreate does not mutate original', () => {
    const dirty = { ...baseWorkflow(), id: 'original-id' } as unknown as N8nWorkflow
    stripper.stripForCreate(dirty)
    expect((dirty as unknown as Record<string, unknown>)['id']).toBe('original-id')
  })

  it('stripForUpdate removes all forbidden update fields but keeps id-free workflow', () => {
    const dirty = {
      ...baseWorkflow(),
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
      versionId: 'abc',
    } as unknown as N8nWorkflow

    const stripped = stripper.stripForUpdate(dirty)

    for (const field of FORBIDDEN_ON_UPDATE) {
      expect(stripped).not.toHaveProperty(field)
    }
  })

  it('stripForCreate and stripForUpdate both preserve optional settings', () => {
    const w: N8nWorkflow = {
      ...baseWorkflow(),
      settings: { executionOrder: 'v1', timezone: 'America/New_York' },
    }
    expect(stripper.stripForCreate(w).settings).toEqual(w.settings)
    expect(stripper.stripForUpdate(w).settings).toEqual(w.settings)
  })

  it('stripForUpdate removes tags -- real bug found live (2026-07-19): N8nProvider.get() legitimately returns a tags field (n8n\'s own GET response always carries one, even []), and n8n\'s PUT endpoint rejects an explicit tags field outright ("request/body/tags is read-only"). Any code path that reads a workflow live and later writes it back (e.g. repair-apply\'s snapshot/restore) must never resubmit it.', () => {
    const roundTrippedFromLiveFetch: N8nWorkflow = { ...baseWorkflow(), tags: [{ id: 't1', name: 'prod' }] }
    const strippedEmpty = stripper.stripForUpdate({ ...baseWorkflow(), tags: [] })
    const strippedNonEmpty = stripper.stripForUpdate(roundTrippedFromLiveFetch)
    expect(strippedEmpty).not.toHaveProperty('tags')
    expect(strippedNonEmpty).not.toHaveProperty('tags')
  })
})
