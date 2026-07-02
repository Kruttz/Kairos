import { describe, it, expect } from 'vitest'
import { wirePackSheets, formatWireReport } from '../../../src/pack/pack-wirer.js'
import type { WorkflowPackResult } from '../../../src/pack/pack-builder.js'

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

  it('returns dry run report without pushing to n8n', async () => {
    const pack = makePack()
    const report = await wirePackSheets(pack, { Contacts: '1sheet' }, {
      dryRun: true,
      n8nBaseUrl: 'http://localhost:5678',
      n8nApiKey: 'test-key',
    })

    // In dry run, we can't fetch from n8n, so the workflow is skipped
    expect(report.dryRun).toBe(true)
    expect(report.totalPushed).toBe(0)
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
