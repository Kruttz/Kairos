import { describe, it, expect } from 'vitest'
import { runOpportunityChecks } from '../../../src/scout/checks.js'
import { detectColumnRoles } from '../../../src/scout/csv-source.js'
import type { OpportunityFinding } from '../../../src/scout/types.js'

const NOW = new Date('2026-07-22T00:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()

function run(headers: string[], rows: Record<string, string>[]) {
  const roles = detectColumnRoles(headers)
  return runOpportunityChecks(headers, rows, roles, 'test.csv', NOW)
}

function find(findings: OpportunityFinding[], checkId: string): OpportunityFinding | undefined {
  return findings.find(f => f.checkId === checkId)
}

describe('STALE_ROWS', () => {
  const headers = ['Referral ID', 'Status', 'Updated', 'Owner']
  it('flags rows older than the threshold, not recent ones', () => {
    const rows = [
      { 'Referral ID': '1', Status: 'open', Updated: daysAgo(45), Owner: 'alice' },
      { 'Referral ID': '2', Status: 'open', Updated: daysAgo(2), Owner: 'bob' },
      { 'Referral ID': '3', Status: 'open', Updated: daysAgo(60), Owner: 'alice' },
    ]
    const { findings } = run(headers, rows)
    const f = find(findings, 'STALE_ROWS')!
    expect(f).toBeDefined()
    expect(f.evidenceRowRefs.sort()).toEqual([0, 2])
    expect(f.rowCount).toBe(2)
    expect(f.totalRowCount).toBe(3)
  })

  it('is skipped when there is no timestamp column', () => {
    const { skipped, findings } = run(['A', 'B'], [{ A: 'x', B: 'y' }, { A: 'x', B: 'y' }, { A: 'x', B: 'y' }])
    expect(find(findings, 'STALE_ROWS')).toBeUndefined()
    expect(skipped.find(s => s.checkId === 'STALE_ROWS')).toBeDefined()
  })
})

describe('STUCK_STATUS', () => {
  const headers = ['ID', 'Status', 'Updated']
  it('flags old + non-terminal, not old + terminal, not recent + non-terminal', () => {
    const rows = [
      { ID: '1', Status: 'in progress', Updated: daysAgo(45) }, // stuck
      { ID: '2', Status: 'closed', Updated: daysAgo(45) }, // old but terminal -- not stuck
      { ID: '3', Status: 'in progress', Updated: daysAgo(2) }, // recent -- not stuck
    ]
    const { findings } = run(headers, rows)
    const f = find(findings, 'STUCK_STATUS')!
    expect(f.evidenceRowRefs).toEqual([0])
  })
})

describe('MISSING_OWNER / MISSING_NEXT_ACTION', () => {
  const headers = ['ID', 'Owner', 'Next Action']
  it('flags blank cells, not filled ones', () => {
    const rows = [
      { ID: '1', Owner: '', 'Next Action': 'call back' },
      { ID: '2', Owner: 'alice', 'Next Action': '' },
      { ID: '3', Owner: 'bob', 'Next Action': 'follow up' },
    ]
    const { findings } = run(headers, rows)
    expect(find(findings, 'MISSING_OWNER')!.evidenceRowRefs).toEqual([0])
    expect(find(findings, 'MISSING_NEXT_ACTION')!.evidenceRowRefs).toEqual([1])
  })

  it('possibleProcessContractSeed is present for MISSING_OWNER, absent for MISSING_NEXT_ACTION', () => {
    const rows = [{ ID: '1', Owner: '', 'Next Action': '' }, { ID: '2', Owner: 'a', 'Next Action': 'x' }, { ID: '3', Owner: 'b', 'Next Action': 'y' }]
    const { findings } = run(headers, rows)
    expect(find(findings, 'MISSING_OWNER')!.possibleProcessContractSeed).toBeDefined()
    expect(find(findings, 'MISSING_NEXT_ACTION')!.possibleProcessContractSeed).toBeUndefined()
  })
})

describe('DUPLICATE_RECORDS', () => {
  const headers = ['ID', 'Status']
  it('flags rows sharing a key value, not unique ones', () => {
    const rows = [
      { ID: 'A100', Status: 'open' },
      { ID: 'A101', Status: 'open' },
      { ID: 'A100', Status: 'open' }, // duplicate of row 0
    ]
    const { findings } = run(headers, rows)
    const f = find(findings, 'DUPLICATE_RECORDS')!
    expect(f.evidenceRowRefs).toEqual([0, 2])
    expect(f.rowCount).toBe(2)
  })

  it('is skipped when there is no key column', () => {
    const { skipped } = run(['Status', 'Notes'], [{ Status: 'open', Notes: 'x' }, { Status: 'open', Notes: 'y' }, { Status: 'open', Notes: 'z' }])
    expect(skipped.find(s => s.checkId === 'DUPLICATE_RECORDS')).toBeDefined()
  })
})

describe('LONG_GAPS_BETWEEN_TIMESTAMPS', () => {
  const headers = ['ID', 'Updated']
  it('flags a gap exceeding the threshold between consecutive sorted timestamps', () => {
    const rows = [
      { ID: '1', Updated: daysAgo(60) },
      { ID: '2', Updated: daysAgo(58) },
      { ID: '3', Updated: daysAgo(10) }, // a ~48-day gap from the row before it, once sorted
    ]
    const { findings } = run(headers, rows)
    const f = find(findings, 'LONG_GAPS_BETWEEN_TIMESTAMPS')!
    expect(f).toBeDefined()
    expect(f.evidenceRowRefs.length).toBeGreaterThan(0)
  })

  it('does not flag evenly-spaced, close-together timestamps', () => {
    const rows = [{ ID: '1', Updated: daysAgo(3) }, { ID: '2', Updated: daysAgo(2) }, { ID: '3', Updated: daysAgo(1) }]
    const { findings } = run(headers, rows)
    expect(find(findings, 'LONG_GAPS_BETWEEN_TIMESTAMPS')).toBeUndefined()
  })
})

describe('UNCLOSED_LOOPS', () => {
  const headers = ['ID', 'Status']
  it('counts every non-terminal-looking row regardless of age, always confidence low', () => {
    const rows = [{ ID: '1', Status: 'open' }, { ID: '2', Status: 'closed' }, { ID: '3', Status: 'pending' }]
    const { findings } = run(headers, rows)
    const f = find(findings, 'UNCLOSED_LOOPS')!
    expect(f.evidenceRowRefs.sort()).toEqual([0, 2])
    expect(f.confidence).toBe('low')
  })
})

describe('POSSIBLE_HANDOFF_DELAY', () => {
  const headers = ['ID', 'Owner', 'Updated']
  it('flags a same-key pair with an owner change and a gap exceeding the threshold', () => {
    const rows = [
      { ID: 'A1', Owner: 'alice', Updated: daysAgo(10) },
      { ID: 'A1', Owner: 'bob', Updated: daysAgo(3) }, // 7 days after alice's row, owner changed
      { ID: 'A2', Owner: 'carol', Updated: daysAgo(5) },
    ]
    const { findings } = run(headers, rows)
    const f = find(findings, 'POSSIBLE_HANDOFF_DELAY')!
    expect(f).toBeDefined()
    expect(f.evidenceRowRefs.sort()).toEqual([0, 1])
  })

  it('is skipped when there is no key column to group rows for the same record', () => {
    const { skipped } = run(['Owner', 'Updated'], [{ Owner: 'a', Updated: daysAgo(10) }, { Owner: 'b', Updated: daysAgo(1) }, { Owner: 'c', Updated: daysAgo(5) }])
    expect(skipped.find(s => s.checkId === 'POSSIBLE_HANDOFF_DELAY')).toBeDefined()
  })

  it('does not flag when the same owner stays constant (no real handoff)', () => {
    const rows = [{ ID: 'A1', Owner: 'alice', Updated: daysAgo(10) }, { ID: 'A1', Owner: 'alice', Updated: daysAgo(1) }, { ID: 'A2', Owner: 'bob', Updated: daysAgo(5) }]
    const { findings } = run(headers, rows)
    expect(find(findings, 'POSSIBLE_HANDOFF_DELAY')).toBeUndefined()
  })
})

describe('REPEATED_MANUAL_STATUS_VALUES', () => {
  const headers = ['ID', 'Status']
  it('flags a free-text-shaped value repeated 3+ times, never showing the value itself', () => {
    const rows = [
      { ID: '1', Status: 'called, no answer, will retry' },
      { ID: '2', Status: 'called, no answer, will retry' },
      { ID: '3', Status: 'called, no answer, will retry' },
      { ID: '4', Status: 'closed' },
    ]
    const { findings } = run(headers, rows)
    const f = find(findings, 'REPEATED_MANUAL_STATUS_VALUES')!
    expect(f).toBeDefined()
    expect(f.evidenceRowRefs.sort()).toEqual([0, 1, 2])
    expect(f.suspectedFailureMode).not.toContain('called, no answer, will retry')
    expect(JSON.stringify(f)).not.toContain('called, no answer, will retry')
  })

  it('does not flag short, enum-like repeated values', () => {
    const rows = [{ ID: '1', Status: 'Open' }, { ID: '2', Status: 'Open' }, { ID: '3', Status: 'Open' }, { ID: '4', Status: 'Closed' }]
    const { findings } = run(headers, rows)
    expect(find(findings, 'REPEATED_MANUAL_STATUS_VALUES')).toBeUndefined()
  })
})

describe('CANDIDATE_PROCESS_NAME', () => {
  it('guesses the most common significant word across headers', () => {
    const { findings } = run(['Referral ID', 'Referral Status', 'Referral Date', 'Owner'], [{ 'Referral ID': '1', 'Referral Status': 'open', 'Referral Date': daysAgo(1), Owner: 'a' }, { 'Referral ID': '2', 'Referral Status': 'open', 'Referral Date': daysAgo(1), Owner: 'b' }, { 'Referral ID': '3', 'Referral Status': 'open', 'Referral Date': daysAgo(1), Owner: 'c' }])
    const f = find(findings, 'CANDIDATE_PROCESS_NAME')!
    expect(f).toBeDefined()
    expect(f.suspectedFailureMode.toLowerCase()).toContain('referral')
    expect(f.confidence).toBe('low')
    expect(f.evidenceRowRefs).toEqual([])
  })

  it('runs even with fewer than the minimum row count -- a header-level, not row-level, signal', () => {
    const { findings } = run(['Order ID', 'Order Status'], [{ 'Order ID': '1', 'Order Status': 'open' }])
    expect(find(findings, 'CANDIDATE_PROCESS_NAME')).toBeDefined()
  })

  it('is skipped when no word repeats across headers', () => {
    const { skipped } = run(['Foo', 'Bar', 'Baz'], [{ Foo: '1', Bar: '2', Baz: '3' }, { Foo: '1', Bar: '2', Baz: '3' }, { Foo: '1', Bar: '2', Baz: '3' }])
    expect(skipped.find(s => s.checkId === 'CANDIDATE_PROCESS_NAME')).toBeDefined()
  })
})

describe('MIN_ROWS_FOR_REPORT -- too little data', () => {
  it('skips every row-level check (but not CANDIDATE_PROCESS_NAME) below the minimum row count', () => {
    const { findings, skipped } = run(['ID', 'Status', 'Owner'], [{ ID: '1', Status: 'open', Owner: '' }, { ID: '2', Status: 'open', Owner: '' }])
    expect(findings.filter(f => f.checkId !== 'CANDIDATE_PROCESS_NAME')).toEqual([])
    const rowLevelSkips = skipped.filter(s => s.checkId !== 'CANDIDATE_PROCESS_NAME')
    expect(rowLevelSkips.length).toBeGreaterThan(0)
    expect(rowLevelSkips.every(s => s.reason.includes('data rows'))).toBe(true)
  })
})

describe('invariant: no raw cell value ever appears in any finding, across all checks', () => {
  it('a realistic multi-check fixture never leaks a cell value into the serialized findings', () => {
    const headers = ['Referral ID', 'Status', 'Updated', 'Owner', 'Next Action']
    const SENTINEL = 'CONFIDENTIAL-CUSTOMER-NAME-Smith-555-1234'
    const rows = [
      { 'Referral ID': 'A1', Status: SENTINEL, Updated: daysAgo(45), Owner: '', 'Next Action': '' },
      { 'Referral ID': 'A1', Status: SENTINEL, Updated: daysAgo(44), Owner: '', 'Next Action': '' },
      { 'Referral ID': 'A1', Status: SENTINEL, Updated: daysAgo(43), Owner: '', 'Next Action': '' },
      { 'Referral ID': 'A2', Status: 'closed', Updated: daysAgo(2), Owner: 'alice', 'Next Action': 'none' },
    ]
    const { findings } = run(headers, rows)
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(JSON.stringify(f)).not.toContain(SENTINEL)
    }
  })
})
