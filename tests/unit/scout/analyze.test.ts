import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeCsvFile, generateOpportunityReport } from '../../../src/scout/analyze.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kairos-scout-analyze-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const NOW = new Date('2026-07-22T00:00:00.000Z')

describe('analyzeCsvFile', () => {
  it('reads a real file end to end and produces a full OpportunityReport', async () => {
    const path = join(dir, 'referrals.csv')
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()
    const csv = [
      'Referral ID,Status,Updated,Owner',
      `A1,open,${daysAgo(45)},`,
      `A2,closed,${daysAgo(2)},alice`,
      `A3,open,${daysAgo(50)},bob`,
    ].join('\n')
    await writeFile(path, csv, 'utf-8')

    const report = await analyzeCsvFile(path, {}, NOW)
    expect(report.source).toEqual({ type: 'csv', path })
    expect(report.rowCount).toBe(3)
    expect(report.generatedAt).toBe(NOW.toISOString())
    expect(report.disclaimer.length).toBeGreaterThan(0)
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.columnRoles.statusColumn?.column).toBe('Status')
  })

  it('honors explicit column hints over the header-name guess', async () => {
    const path = join(dir, 'weird-headers.csv')
    await writeFile(path, 'Ticket,Current State,Handler\n1,open,alice\n2,open,bob\n3,open,carol\n', 'utf-8')
    const report = await analyzeCsvFile(path, { statusColumn: 'Current State', ownerColumn: 'Handler' }, NOW)
    expect(report.columnRoles.statusColumn).toEqual({ column: 'Current State', source: 'hint' })
    expect(report.columnRoles.ownerColumn).toEqual({ column: 'Handler', source: 'hint' })
  })

  it('a real file that resolves no roles at all still produces a report, with everything skipped except possibly CANDIDATE_PROCESS_NAME', async () => {
    const path = join(dir, 'no-roles.csv')
    await writeFile(path, 'Foo,Bar\nx,y\nx,y\nx,y\n', 'utf-8')
    const report = await analyzeCsvFile(path, {}, NOW)
    expect(report.rowCount).toBe(3)
    expect(report.findings.every(f => f.checkId === 'CANDIDATE_PROCESS_NAME')).toBe(true)
    expect(report.skipped.length).toBeGreaterThan(0)
  })
})

describe('generateOpportunityReport -- rendered text never contains raw cell content', () => {
  it('renders a real report with no source-file cell values, only structural info', async () => {
    const path = join(dir, 'sensitive.csv')
    const SENTINEL = 'CONFIDENTIAL-PERSON-NAME-9999'
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()
    await writeFile(path, `ID,Status,Updated\n1,${SENTINEL},${daysAgo(60)}\n2,${SENTINEL},${daysAgo(59)}\n3,${SENTINEL},${daysAgo(58)}\n`, 'utf-8')

    const report = await analyzeCsvFile(path, {}, NOW)
    const rendered = generateOpportunityReport(report)
    expect(rendered).not.toContain(SENTINEL)
    expect(rendered).toContain('Operations Scout')
    expect(rendered).toContain('Disclaimer')
  })
})
