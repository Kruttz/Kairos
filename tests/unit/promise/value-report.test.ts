import { describe, it, expect } from 'vitest'
import { buildAutomationValueReport, generateAutomationValueReport, validateImpactAssumptions } from '../../../src/promise/value-report.js'
import type { PromiseReportData } from '../../../src/promise/report.js'
import type { ImpactAssumptions } from '../../../src/promise/value-types.js'

function makeReportData(overrides: Partial<PromiseReportData> = {}): PromiseReportData {
  return {
    contractId: 'test-contract',
    contractName: 'Test Contract',
    contractVersion: 1,
    clientId: 'test-client',
    promiseText: 'Every referral is contacted within 4 hours.',
    contractStatus: 'active',
    provenance: { kairosVersion: '0.12.0', authoredBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    generatedAt: '2026-07-22T00:00:00.000Z',
    window: {},
    totalInstances: 10,
    instanceCounts: { kept: 6, missed: 1, at_risk: 1, unverifiable: 1, in_progress: 1 },
    instances: [],
    openExceptionCount: 1,
    acknowledgedExceptionCount: 0,
    resolvedExceptionCount: 4,
    openExceptions: [],
    evidenceQualityBreakdown: { specific: 8, generic: 2 },
    unattributedExecutionCount: 0,
    disclaimers: [],
    ...overrides,
  }
}

describe('validateImpactAssumptions', () => {
  it('is satisfied with no assumptions at all', () => {
    expect(validateImpactAssumptions({})).toEqual([])
  })

  it('is satisfied with only time-based assumptions (no currency needed)', () => {
    expect(validateImpactAssumptions({ minutesSavedPerKeptInstance: 15 })).toEqual([])
  })

  it('requires currency when dollarValuePerResolvedException is present', () => {
    const issues = validateImpactAssumptions({ dollarValuePerResolvedException: 50 })
    expect(issues.length).toBe(1)
    expect(issues[0]).toContain('currency is required')
  })

  it('requires currency when dollarValuePerAvoidedMiss is present', () => {
    const issues = validateImpactAssumptions({ dollarValuePerAvoidedMiss: 200 })
    expect(issues.length).toBe(1)
  })

  it('is satisfied when a dollar assumption is paired with a currency', () => {
    expect(validateImpactAssumptions({ dollarValuePerResolvedException: 50, currency: 'USD' })).toEqual([])
  })
})

describe('buildAutomationValueReport -- the single most important guarantee: no assumptions means no value figures anywhere', () => {
  it('returns only the observed section, unchanged, when no assumptions are supplied', () => {
    const data = makeReportData()
    const report = buildAutomationValueReport(data)
    expect(report.observed).toEqual(data)
    expect(report.estimatedValue).toBeUndefined()
  })

  it('returns only the observed section when assumptions is an empty object', () => {
    const data = makeReportData()
    const report = buildAutomationValueReport(data, {})
    expect(report.estimatedValue).toBeUndefined()
  })

  it('the rendered report contains zero currency/time-value figures with no assumptions -- a structural invariant test, not just happy path', () => {
    const data = makeReportData()
    const rendered = generateAutomationValueReport(buildAutomationValueReport(data))
    expect(rendered).not.toContain('Estimated Value')
    expect(rendered).not.toContain('Formula')
  })
})

describe('buildAutomationValueReport -- partial assumptions produce only the corresponding line items', () => {
  it('only minutesSavedPerResolvedException produces exactly one line item', () => {
    const data = makeReportData()
    const report = buildAutomationValueReport(data, { minutesSavedPerResolvedException: 15 })
    expect(report.estimatedValue).toBeDefined()
    expect(report.estimatedValue!.lineItems).toHaveLength(1)
    expect(report.estimatedValue!.lineItems[0]!.label).toBe('Time saved on resolved exceptions')
  })

  it('two of four possible assumptions produce exactly two line items, nothing invented for the other two', () => {
    const data = makeReportData()
    const report = buildAutomationValueReport(data, { minutesSavedPerKeptInstance: 10, minutesSavedPerResolvedException: 15 })
    expect(report.estimatedValue!.lineItems).toHaveLength(2)
    const labels = report.estimatedValue!.lineItems.map(l => l.label)
    expect(labels).toContain('Time saved on kept promise instances')
    expect(labels).toContain('Time saved on resolved exceptions')
  })

  it('a dollar assumption with no currency produces no line item for it (defensive, even though validateImpactAssumptions should have already refused)', () => {
    const data = makeReportData()
    const report = buildAutomationValueReport(data, { dollarValuePerResolvedException: 50 } as ImpactAssumptions)
    expect(report.estimatedValue).toBeUndefined()
  })

  it('a supplied assumption still produces a line item even when its count is zero -- consistency over count-gating', () => {
    const data = makeReportData({ instanceCounts: { kept: 0, missed: 0, at_risk: 0, unverifiable: 0, in_progress: 0 } })
    const report = buildAutomationValueReport(data, { minutesSavedPerKeptInstance: 15 })
    expect(report.estimatedValue!.lineItems).toHaveLength(1)
    expect(report.estimatedValue!.lineItems[0]!.total).toBe(0)
  })
})

describe('buildAutomationValueReport -- every total matches count x perUnitAssumption exactly, and formula renders it', () => {
  it('minutesSavedPerKeptInstance', () => {
    const data = makeReportData() // kept: 6
    const report = buildAutomationValueReport(data, { minutesSavedPerKeptInstance: 12 })
    const item = report.estimatedValue!.lineItems[0]!
    expect(item.count).toBe(6)
    expect(item.perUnitAssumption).toBe(12)
    expect(item.total).toBe(72)
    expect(item.unit).toBe('minutes')
    expect(item.formula).toContain('6')
    expect(item.formula).toContain('12')
    expect(item.formula).toContain('72')
  })

  it('minutesSavedPerResolvedException', () => {
    const data = makeReportData() // resolvedExceptionCount: 4
    const report = buildAutomationValueReport(data, { minutesSavedPerResolvedException: 20 })
    const item = report.estimatedValue!.lineItems[0]!
    expect(item.count).toBe(4)
    expect(item.total).toBe(80)
  })

  it('dollarValuePerResolvedException, with currency', () => {
    const data = makeReportData() // resolvedExceptionCount: 4
    const report = buildAutomationValueReport(data, { dollarValuePerResolvedException: 75, currency: 'USD' })
    const item = report.estimatedValue!.lineItems[0]!
    expect(item.count).toBe(4)
    expect(item.perUnitAssumption).toBe(75)
    expect(item.total).toBe(300)
    expect(item.unit).toBe('currency')
    expect(item.formula).toContain('USD')
  })

  it('dollarValuePerAvoidedMiss, with currency', () => {
    const data = makeReportData() // resolvedExceptionCount: 4
    const report = buildAutomationValueReport(data, { dollarValuePerAvoidedMiss: 500, currency: 'USD' })
    const item = report.estimatedValue!.lineItems[0]!
    expect(item.total).toBe(2000)
  })

  it('all four assumptions together produce four independently-correct line items', () => {
    const data = makeReportData() // kept: 6, resolvedExceptionCount: 4
    const report = buildAutomationValueReport(data, {
      minutesSavedPerKeptInstance: 10,
      minutesSavedPerResolvedException: 15,
      dollarValuePerResolvedException: 50,
      dollarValuePerAvoidedMiss: 200,
      currency: 'USD',
    })
    expect(report.estimatedValue!.lineItems).toHaveLength(4)
    const totals = report.estimatedValue!.lineItems.map(l => l.total)
    expect(totals.sort((a, b) => a - b)).toEqual([60, 200 * 4, 4 * 50, 6 * 10].sort((a, b) => a - b))
  })
})

describe('buildAutomationValueReport -- the disclaimer', () => {
  it('is always present whenever estimatedValue exists, and names who/when it was entered', () => {
    const data = makeReportData()
    const report = buildAutomationValueReport(data, { minutesSavedPerKeptInstance: 10, enteredBy: 'Jordan', enteredAt: '2026-07-22' })
    expect(report.estimatedValue!.disclaimer).toContain('Jordan')
    expect(report.estimatedValue!.disclaimer).toContain('2026-07-22')
    expect(report.estimatedValue!.disclaimer.toLowerCase()).toContain('not measured directly')
  })

  it('falls back to a generic phrase when enteredBy/enteredAt are not supplied', () => {
    const data = makeReportData()
    const report = buildAutomationValueReport(data, { minutesSavedPerKeptInstance: 10 })
    expect(report.estimatedValue!.disclaimer.length).toBeGreaterThan(0)
  })
})

describe('generateAutomationValueReport -- rendering', () => {
  it('the Observed section is byte-for-byte the same content as generatePromiseReport() alone', async () => {
    const { generatePromiseReport } = await import('../../../src/promise/report.js')
    const data = makeReportData()
    const rendered = generateAutomationValueReport(buildAutomationValueReport(data))
    expect(rendered.startsWith(generatePromiseReport(data))).toBe(true)
  })

  it('every value line in the rendered table shows its own formula, never a bare number', () => {
    const data = makeReportData()
    const rendered = generateAutomationValueReport(buildAutomationValueReport(data, { minutesSavedPerKeptInstance: 10, minutesSavedPerResolvedException: 15 }))
    expect(rendered).toContain('## Estimated Value')
    expect(rendered).toContain('x 10 min')
    expect(rendered).toContain('x 15 min')
  })

  it('shows the disclaimer as a blockquote', () => {
    const data = makeReportData()
    const rendered = generateAutomationValueReport(buildAutomationValueReport(data, { minutesSavedPerKeptInstance: 10 }))
    expect(rendered).toMatch(/^> Estimated from/m)
  })
})
