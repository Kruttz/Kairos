import { describe, it, expect } from 'vitest'
import {
  wirePackSheets,
  formatWireReport,
  extractSheetDocumentId,
  patchSheetDocumentId,
  findSheetNodes,
  resolveSheetName,
} from '../../../src/pack/pack-wirer.js'
import type { WorkflowPackResult } from '../../../src/pack/pack-builder.js'
import type { N8nWorkflow } from '../../../src/types/workflow.js'

function makePack(overrides?: Partial<WorkflowPackResult>): WorkflowPackResult {
  return {
    businessContext: 'Test Business',
    packName: 'test-pack',
    status: 'active',
    workflows: [
      {
        name: 'Sheet Sync Workflow',
        purpose: 'Syncs data to Google Sheets',
        workflowId: 'wf-001',
        deployed: true,
        generationAttempts: 1,
        credentialsNeeded: [],
      },
    ],
    allCredentials: [],
    sheetsColumns: [{ sheet: 'Contacts', columns: ['name', 'email'] }],
    assumptions: [],
    testChecklist: [],
    builtAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('wirePackSheets', () => {
  it('skips workflows with no workflowId', async () => {
    const pack = makePack({
      workflows: [{
        name: 'Undeployed Workflow',
        purpose: 'test',
        workflowId: null,
        deployed: false,
        generationAttempts: 1,
        credentialsNeeded: [],
      }],
    })

    const report = await wirePackSheets(pack, { Contacts: '1abc' }, {
      dryRun: true,
    })

    expect(report.results[0]!.skipped).toBe(true)
    expect(report.results[0]!.skipReason).toContain('no ID')
  })

  it('skips workflows that had build errors', async () => {
    const pack = makePack({
      workflows: [{
        name: 'Failed Workflow',
        purpose: 'test',
        workflowId: 'wf-001',
        deployed: false,
        generationAttempts: 3,
        credentialsNeeded: [],
        error: 'Generation failed after 3 attempts',
      }],
    })

    const report = await wirePackSheets(pack, { Contacts: '1abc' }, { dryRun: true })
    expect(report.results[0]!.skipped).toBe(true)
    expect(report.results[0]!.skipReason).toContain('build error')
  })

  it('skips with a clear reason when no n8n connection is configured (dry run)', async () => {
    const pack = makePack()
    const report = await wirePackSheets(pack, { Contacts: '1sheet' }, {
      dryRun: true,
      // No n8nBaseUrl/n8nApiKey — wiring needs to read the deployed workflow even in dry-run
    })

    expect(report.dryRun).toBe(true)
    expect(report.totalPushed).toBe(0)
    expect(report.results[0]!.skipped).toBe(true)
    expect(report.results[0]!.skipReason).toContain('No n8n connection')
  })

  it('reports missing n8n connection correctly in non-dry-run', async () => {
    const pack = makePack()
    // No n8n URL/key provided — result should skip or error gracefully
    const report = await wirePackSheets(pack, { Contacts: '1sheet' }, {
      dryRun: false,
      // n8nBaseUrl and n8nApiKey intentionally omitted
    })
    // Should skip because no connection info, not crash
    const result = report.results[0]!
    expect(result.pushed).toBe(false)
  })

  it('produces correct summary counts', async () => {
    const pack = makePack({
      workflows: [
        { name: 'WF1', purpose: 'a', workflowId: null, deployed: false, generationAttempts: 1, credentialsNeeded: [] },
        { name: 'WF2', purpose: 'b', workflowId: null, deployed: false, generationAttempts: 1, credentialsNeeded: [] },
      ],
    })

    const report = await wirePackSheets(pack, {}, { dryRun: true })
    expect(report.totalPatched).toBe(0)
    expect(report.totalPushed).toBe(0)
    expect(report.results.length).toBe(2)
  })
})

// The real n8n ResourceLocator shape: __rl is a BOOLEAN flag, mode/value are siblings.
// These tests pin that shape — an earlier implementation treated __rl as a nested
// object holding value, which silently no-opped the patch.
describe('extractSheetDocumentId', () => {
  it('reads value from the real n8n ResourceLocator shape', () => {
    const params = {
      documentId: { __rl: true, mode: 'id', value: '1AbCdEfG' },
    }
    expect(extractSheetDocumentId(params)).toBe('1AbCdEfG')
  })

  it('reads a plain string documentId', () => {
    expect(extractSheetDocumentId({ documentId: '1AbCdEfG' })).toBe('1AbCdEfG')
  })

  it('returns null when documentId is missing', () => {
    expect(extractSheetDocumentId({})).toBeNull()
  })

  it('returns null when the ResourceLocator has no string value', () => {
    expect(extractSheetDocumentId({ documentId: { __rl: true, mode: 'id' } })).toBeNull()
  })
})

describe('patchSheetDocumentId', () => {
  it('produces the canonical ResourceLocator with __rl as boolean true', () => {
    const params = {
      documentId: { __rl: true, mode: 'list', value: 'REPLACE_ME', cachedResultName: 'Old Sheet' },
      sheetName: { __rl: true, mode: 'name', value: 'Contacts' },
    }
    const patched = patchSheetDocumentId(params, '1NewSheetId')
    const doc = patched['documentId'] as Record<string, unknown>

    expect(doc['__rl']).toBe(true)
    expect(doc['mode']).toBe('id')
    expect(doc['value']).toBe('1NewSheetId')
    // The effective value n8n reads (doc.value) must be the NEW id — nothing buried in a nested object
    expect(typeof doc['__rl']).toBe('boolean')
    // Other params untouched
    expect(patched['sheetName']).toEqual(params.sheetName)
  })

  it('round-trips: extract after patch returns the new id', () => {
    const params = { documentId: { __rl: true, mode: 'id', value: 'PLACEHOLDER' } }
    const patched = patchSheetDocumentId(params, '1RealId')
    expect(extractSheetDocumentId(patched)).toBe('1RealId')
  })

  it('converts a plain-string documentId into ResourceLocator format', () => {
    const patched = patchSheetDocumentId({ documentId: 'PLACEHOLDER' }, '1RealId')
    const doc = patched['documentId'] as Record<string, unknown>
    expect(doc['__rl']).toBe(true)
    expect(doc['value']).toBe('1RealId')
  })

  it('does not mutate the original params', () => {
    const params = { documentId: { __rl: true, mode: 'id', value: 'ORIGINAL' } }
    patchSheetDocumentId(params, '1NewId')
    expect(params.documentId.value).toBe('ORIGINAL')
  })
})

describe('findSheetNodes', () => {
  it('finds googleSheets and googleSheetsTrigger nodes with their current doc ids', () => {
    const workflow: N8nWorkflow = {
      name: 'Test',
      nodes: [
        { id: '1', name: 'Trigger', type: 'n8n-nodes-base.googleSheetsTrigger', typeVersion: 1, position: [0, 0], parameters: { documentId: { __rl: true, mode: 'id', value: 'DOC1' } } },
        { id: '2', name: 'Not Sheets', type: 'n8n-nodes-base.set', typeVersion: 3, position: [0, 0], parameters: {} },
        { id: '3', name: 'Write Row', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [0, 0], parameters: { documentId: { __rl: true, mode: 'id', value: 'DOC2' } } },
      ],
      connections: {},
    }
    const found = findSheetNodes(workflow)
    expect(found).toHaveLength(2)
    expect(found[0]).toMatchObject({ nodeName: 'Trigger', currentDocId: 'DOC1', nodeIndex: 0 })
    expect(found[1]).toMatchObject({ nodeName: 'Write Row', currentDocId: 'DOC2', nodeIndex: 2 })
  })
})

describe('resolveSheetName', () => {
  it('matches the sheetName ResourceLocator value against the mapping', () => {
    const params = { sheetName: { __rl: true, mode: 'name', value: 'Contacts' } }
    const match = resolveSheetName(params, { Contacts: '1abc', Orders: '2def' })
    expect(match).toEqual({ sheetName: 'Contacts', spreadsheetId: '1abc' })
  })

  it('matches case-insensitively', () => {
    const params = { sheetName: { __rl: true, mode: 'name', value: 'contacts' } }
    const match = resolveSheetName(params, { Contacts: '1abc', Orders: '2def' })
    expect(match).toEqual({ sheetName: 'Contacts', spreadsheetId: '1abc' })
  })

  it('falls back to the single mapping entry when the node names no sheet', () => {
    const match = resolveSheetName({}, { OnlySheet: '1xyz' })
    expect(match).toEqual({ sheetName: 'OnlySheet', spreadsheetId: '1xyz' })
  })

  it('returns null when multiple sheets exist and none match', () => {
    const params = { sheetName: { __rl: true, mode: 'name', value: 'Unknown' } }
    expect(resolveSheetName(params, { Contacts: '1abc', Orders: '2def' })).toBeNull()
  })
})

describe('formatWireReport', () => {
  it('includes pack name in output', () => {
    const report = {
      packName: 'my-pack',
      dryRun: false,
      results: [],
      totalPatched: 0,
      totalPushed: 0,
      totalErrors: 0,
    }
    const text = formatWireReport(report)
    expect(text).toContain('my-pack')
  })

  it('shows DRY RUN prefix when dryRun is true', () => {
    const report = {
      packName: 'test',
      dryRun: true,
      results: [],
      totalPatched: 0,
      totalPushed: 0,
      totalErrors: 0,
    }
    const text = formatWireReport(report)
    expect(text).toContain('[DRY RUN]')
  })

  it('shows SKIP for skipped workflows', () => {
    const report = {
      packName: 'test',
      dryRun: false,
      results: [{
        workflowName: 'My Workflow',
        n8nWorkflowId: null,
        sheetsPatched: [],
        validationPassed: false,
        validationIssues: [],
        pushed: false,
        skipped: true,
        skipReason: 'No ID',
      }],
      totalPatched: 0,
      totalPushed: 0,
      totalErrors: 0,
    }
    const text = formatWireReport(report)
    expect(text).toContain('SKIP')
    expect(text).toContain('My Workflow')
    expect(text).toContain('No ID')
  })

  it('shows summary line at the end', () => {
    const report = {
      packName: 'test',
      dryRun: false,
      results: [],
      totalPatched: 3,
      totalPushed: 2,
      totalErrors: 0,
    }
    const text = formatWireReport(report)
    expect(text).toContain('2 workflow(s) updated')
    expect(text).toContain('3 sheet(s) patched')
  })

  it('shows dry run summary when dryRun is true', () => {
    const report = {
      packName: 'test',
      dryRun: true,
      results: [],
      totalPatched: 4,
      totalPushed: 0,
      totalErrors: 0,
    }
    const text = formatWireReport(report)
    expect(text).toContain('4 patch(es) would be applied')
  })
})
