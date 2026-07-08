import { describe, it, expect } from 'vitest'
import { generateHandoff, generateImpactNotesTemplate } from '../../../src/pack/pack-exporter.js'
import type { WorkflowPackResult } from '../../../src/pack/pack-builder.js'

function makePack(overrides: Partial<WorkflowPackResult> = {}): WorkflowPackResult {
  return {
    businessContext: 'Empire Homecare',
    packName: 'empire-homecare',
    status: 'ready_for_test',
    workflows: [
      {
        name: 'Weekly Newsletter',
        purpose: 'Keep customers engaged.',
        workflowId: 'wf-abc',
        deployed: true,
        generationAttempts: 1,
        credentialsNeeded: [],
      },
    ],
    allCredentials: [{ service: 'Gmail', credentialType: 'gmailOAuth2' }],
    sheetsColumns: [{ sheet: 'Customers', columns: ['name', 'email', 'sent_at'] }],
    assumptions: [
      { type: 'safe', text: 'Schedule runs Monday 9 AM' },
      { type: 'needs_confirmation', text: 'Confirm brand voice before launch' },
    ],
    testChecklist: [
      { workflow: 'Weekly Newsletter', steps: ['Trigger manually and check inbox'] },
    ],
    builtAt: '2026-06-29T12:00:00.000Z',
    ...overrides,
  }
}

describe('generateHandoff()', () => {
  it('includes the business context in the title', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('# Empire Homecare — Workflow Pack')
  })

  it('includes pack status', () => {
    const md = generateHandoff(makePack({ status: 'blocked' }))
    expect(md).toContain('Blocked')
  })

  it('lists deployed workflows with checkmark', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('✓ Weekly Newsletter')
    expect(md).toContain('wf-abc')
  })

  it('marks failed workflows with ✗', () => {
    const pack = makePack({
      workflows: [{
        name: 'Failed Workflow',
        purpose: 'Test',
        workflowId: null,
        deployed: false,
        generationAttempts: 0,
        credentialsNeeded: [],
        error: 'n8n refused',
      }],
    })
    const md = generateHandoff(pack)
    expect(md).toContain('✗ Failed Workflow')
    expect(md).toContain('n8n refused')
  })

  it('includes required credentials section', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('## Required Credentials')
    expect(md).toContain('Gmail')
    expect(md).toContain('gmailOAuth2')
  })

  it('includes required Google Sheets section with columns', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('## Required Google Sheets')
    expect(md).toContain('Customers')
    expect(md).toContain('`name`')
    expect(md).toContain('`email`')
  })

  it('elevates blocking assumptions to top of document', () => {
    const pack = makePack({
      assumptions: [{ type: 'blocking', text: 'Google Sheet ID missing' }],
      status: 'blocked',
    })
    const md = generateHandoff(pack)
    const blockingPos = md.indexOf('## Blocking Issues')
    const workflowsPos = md.indexOf('## Workflows')
    expect(blockingPos).toBeGreaterThan(0)
    expect(blockingPos).toBeLessThan(workflowsPos)
    expect(md).toContain('Google Sheet ID missing')
  })

  it('separates needs_confirmation from safe assumptions', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('## Needs Confirmation')
    expect(md).toContain('Confirm brand voice before launch')
    expect(md).toContain('## Safe Assumptions')
    expect(md).toContain('Schedule runs Monday 9 AM')
  })

  it('includes setup checklist with credential and sheet items', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('## Setup Checklist')
    expect(md).toContain('Connect **Gmail**')
    expect(md).toContain('"Customers"')
  })

  it('includes testing checklist', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('## Testing Checklist')
    expect(md).toContain('Trigger manually and check inbox')
  })

  it('includes activation checklist for deployed workflows', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('## Activation Checklist')
    expect(md).toContain('Weekly Newsletter')
  })

  it('includes maintenance notes', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('## Maintenance Notes')
    expect(md).toContain('validate-pack')
  })

  it('describes exported workflow.json files as a restore candidate, not a rollback', () => {
    const md = generateHandoff(makePack())
    expect(md).toContain('restore candidate')
    expect(md).toContain('not a one-command rollback')
    expect(md).toContain('credentials being reconnected')
    expect(md).toContain('webhooks being')
  })

  it('does not include activation checklist when no workflows deployed', () => {
    const pack = makePack({
      workflows: [{
        name: 'Undeployed',
        purpose: 'Test',
        workflowId: null,
        deployed: false,
        generationAttempts: 0,
        credentialsNeeded: [],
      }],
    })
    const md = generateHandoff(pack)
    expect(md).not.toContain('## Activation Checklist')
  })

  it('omits empty sections when no credentials needed', () => {
    const pack = makePack({ allCredentials: [] })
    const md = generateHandoff(pack)
    expect(md).not.toContain('## Required Credentials')
  })

  it('omits empty sections when no sheets needed', () => {
    const pack = makePack({ sheetsColumns: [] })
    const md = generateHandoff(pack)
    expect(md).not.toContain('## Required Google Sheets')
  })
})

describe('generateImpactNotesTemplate', () => {
  it('renders all 7 fixed fields as headed sections', () => {
    const md = generateImpactNotesTemplate()
    for (const heading of [
      'Current manual process',
      'Time spent weekly',
      'Error/failure points',
      'Revenue leakage',
      'Before/after metric',
      'Human owner',
      'Follow-up date',
    ]) {
      expect(md).toContain(`## ${heading}`)
    }
  })

  it('includes the business context in the header when provided', () => {
    const md = generateImpactNotesTemplate('Empire Homecare')
    expect(md).toContain('# Empire Homecare — Impact Notes')
  })

  it('omits business context cleanly when not provided', () => {
    const md = generateImpactNotesTemplate()
    expect(md).toContain('# Impact Notes')
    expect(md).not.toContain('undefined')
  })

  it('never pre-fills or guesses any field value -- every section is blank guidance text only', () => {
    const md = generateImpactNotesTemplate('Empire Homecare')
    // No dollar amounts, no computed numbers, no pack-derived data anywhere in the output
    expect(md).not.toMatch(/\$[\d,]+/)
    expect(md).not.toContain('hours/week: ')
  })
})
