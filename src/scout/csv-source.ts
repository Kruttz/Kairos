import { readFile } from 'node:fs/promises'
import type { ColumnHints, ResolvedColumnRole } from './types.js'

/**
 * Operations Scout v0 (roadmap item 14). CSV parsing + column-role detection -- no npm
 * dependency, deliberately: a small, correct RFC4180-shaped parser (quoted fields, embedded
 * commas/newlines, doubled-quote escaping, CRLF/LF) is a bounded, well-understood problem, and
 * this codebase's own "don't let format support become the project" guardrail argues against
 * reaching for a library for something this narrow.
 */

export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
}

/** Character-by-character state machine -- the standard, correct approach for CSV with quoted
 * fields, rather than a naive `.split(',')` (which breaks the instant any real field contains a
 * comma, and real business exports do this constantly -- addresses, notes, names with suffixes). */
export function parseCsv(content: string): ParsedCsv {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0

  const pushField = () => { record.push(field); field = '' }
  const pushRecord = () => { pushField(); records.push(record); record = [] }

  while (i < content.length) {
    const ch = content[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { pushField(); i++; continue }
    if (ch === '\r') { i++; continue } // CRLF -- the \n right after does the real line break
    if (ch === '\n') { pushRecord(); i++; continue }
    field += ch; i++
  }
  // Final field/record, if the file doesn't end with a trailing newline.
  if (field.length > 0 || record.length > 0) pushRecord()

  const nonEmpty = records.filter(r => !(r.length === 1 && r[0] === ''))
  if (nonEmpty.length === 0) return { headers: [], rows: [] }

  const headers = nonEmpty[0]!.map(h => h.trim())
  const rows = nonEmpty.slice(1).map(r => {
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = r[idx] ?? '' })
    return row
  })
  return { headers, rows }
}

export async function readCsvFile(path: string): Promise<ParsedCsv> {
  const content = await readFile(path, 'utf-8')
  return parseCsv(content)
}

/** Header-name keywords for each role -- checked case-insensitively, substring match, in this
 * exact priority order (first match wins per header). A guess, never a certainty -- every
 * caller must treat a 'guessed' ResolvedColumnRole as less trustworthy than a 'hint' one, and
 * every OpportunityFinding derived from a guessed role must say so in its own caveats. */
const ROLE_KEYWORDS: Record<keyof ColumnHints, string[]> = {
  statusColumn: ['status', 'stage', 'state'],
  timestampColumn: ['updated', 'modified', 'date', 'time', 'created', 'timestamp'],
  ownerColumn: ['owner', 'assignee', 'assigned', 'responsible'],
  keyColumn: ['id', 'key', 'number', 'ref', 'reference'],
  nextActionColumn: ['next action', 'next step', 'nextaction', 'todo', 'action needed'],
}

/** Resolves each role to a real column in `headers`, hints always winning over a guess. A hint
 * naming a column that doesn't actually exist in this file is dropped (not silently substituted
 * with a guess instead) -- the caller sees it's simply unresolved and the relevant check(s) are
 * skipped, rather than this function guessing behind the human's back after they explicitly
 * told it something wrong. */
export function detectColumnRoles(headers: string[], hints: ColumnHints = {}): Partial<Record<keyof ColumnHints, ResolvedColumnRole>> {
  const result: Partial<Record<keyof ColumnHints, ResolvedColumnRole>> = {}
  const headerSet = new Set(headers)

  for (const role of Object.keys(ROLE_KEYWORDS) as (keyof ColumnHints)[]) {
    const hinted = hints[role]
    if (hinted && headerSet.has(hinted)) {
      result[role] = { column: hinted, source: 'hint' }
      continue
    }
    const keywords = ROLE_KEYWORDS[role]
    const guessed = headers.find(h => keywords.some(kw => h.toLowerCase().includes(kw)))
    if (guessed) result[role] = { column: guessed, source: 'guessed' }
  }

  return result
}
