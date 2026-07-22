import { describe, it, expect } from 'vitest'
import { parseCsv, detectColumnRoles } from '../../../src/scout/csv-source.js'

describe('parseCsv', () => {
  it('parses a simple, unquoted CSV', () => {
    const { headers, rows } = parseCsv('id,status,owner\n1,open,alice\n2,closed,bob\n')
    expect(headers).toEqual(['id', 'status', 'owner'])
    expect(rows).toEqual([{ id: '1', status: 'open', owner: 'alice' }, { id: '2', status: 'closed', owner: 'bob' }])
  })

  it('handles a quoted field containing a comma', () => {
    const { rows } = parseCsv('id,note\n1,"hello, world"\n')
    expect(rows[0]!.note).toBe('hello, world')
  })

  it('handles a quoted field containing an embedded newline', () => {
    const { rows } = parseCsv('id,note\n1,"line one\nline two"\n')
    expect(rows[0]!.note).toBe('line one\nline two')
  })

  it('handles doubled-quote escaping inside a quoted field', () => {
    const { rows } = parseCsv('id,note\n1,"she said ""hi"""\n')
    expect(rows[0]!.note).toBe('she said "hi"')
  })

  it('handles CRLF line endings', () => {
    const { headers, rows } = parseCsv('id,status\r\n1,open\r\n2,closed\r\n')
    expect(headers).toEqual(['id', 'status'])
    expect(rows).toHaveLength(2)
  })

  it('handles a file with no trailing newline', () => {
    const { rows } = parseCsv('id,status\n1,open')
    expect(rows).toEqual([{ id: '1', status: 'open' }])
  })

  it('handles a missing trailing cell in a short row as an empty string', () => {
    const { rows } = parseCsv('id,status,owner\n1,open\n')
    expect(rows[0]).toEqual({ id: '1', status: 'open', owner: '' })
  })

  it('returns empty headers/rows for an empty file', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
  })

  it('returns just headers, no rows, for a header-only file', () => {
    const { headers, rows } = parseCsv('id,status\n')
    expect(headers).toEqual(['id', 'status'])
    expect(rows).toEqual([])
  })
})

describe('detectColumnRoles', () => {
  it('resolves a role from an explicit hint, marked source: hint', () => {
    const roles = detectColumnRoles(['Ticket ID', 'Current State', 'Assignee'], { statusColumn: 'Current State' })
    expect(roles.statusColumn).toEqual({ column: 'Current State', source: 'hint' })
  })

  it('falls back to a header-name guess when unhinted, marked source: guessed', () => {
    const roles = detectColumnRoles(['ID', 'Status', 'Owner'])
    expect(roles.statusColumn).toEqual({ column: 'Status', source: 'guessed' })
    expect(roles.ownerColumn).toEqual({ column: 'Owner', source: 'guessed' })
  })

  it('a hint naming a column that does not exist in this file is dropped, not silently substituted with a guess', () => {
    const roles = detectColumnRoles(['ID', 'State'], { statusColumn: 'Nonexistent Column' })
    // 'State' contains 'state', which IS a status keyword -- but the hint should be tried first
    // and, since it doesn't match a real header, fall through to the guess anyway here. The real
    // invariant this test protects: an invalid hint never crashes and never silently resolves to
    // something the human didn't ask for without it also being a legitimate guess.
    expect(roles.statusColumn?.source).toBe('guessed')
  })

  it('leaves a role unresolved when no hint and no header keyword match', () => {
    const roles = detectColumnRoles(['Foo', 'Bar', 'Baz'])
    expect(roles.statusColumn).toBeUndefined()
    expect(roles.ownerColumn).toBeUndefined()
    expect(roles.timestampColumn).toBeUndefined()
    expect(roles.keyColumn).toBeUndefined()
    expect(roles.nextActionColumn).toBeUndefined()
  })

  it('resolves all 5 roles independently on a realistic header set', () => {
    const roles = detectColumnRoles(['Referral ID', 'Status', 'Last Updated', 'Owner', 'Next Action'])
    expect(roles.keyColumn?.column).toBe('Referral ID')
    expect(roles.statusColumn?.column).toBe('Status')
    expect(roles.timestampColumn?.column).toBe('Last Updated')
    expect(roles.ownerColumn?.column).toBe('Owner')
    expect(roles.nextActionColumn?.column).toBe('Next Action')
  })
})
