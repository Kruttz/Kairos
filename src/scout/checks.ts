import type { ColumnHints, OpportunityCheckId, OpportunityCheckSkip, OpportunityFinding, ResolvedColumnRole } from './types.js'

/**
 * Operations Scout v0 (roadmap item 14, docs/plans/contract-evolution-ops-roadmap-plan.md §3,
 * item 14). The 10 detection heuristics, each a small, pure, no-I/O function over already-parsed
 * CSV rows. Every function either returns a real `OpportunityFinding` (never with an empty
 * `evidenceRowRefs` for a row-level check -- an invariant, matching evolution.ts's own "never an
 * empty evidence array" discipline) or nothing at all -- there is no "maybe" state; a check
 * either found something real or it didn't run.
 *
 * **The single guardrail every check here shares, without exception**: no raw cell value is ever
 * interpolated into a finding's own text. Only row indices, counts, and column NAMES (schema,
 * not records) ever appear. This is deliberately uniform across all 10 checks, including
 * REPEATED_MANUAL_STATUS_VALUES (which is fundamentally "about" a repeated value) -- that check
 * reports the count and which rows share *a* value, never the value's own literal text. The one
 * intentional exception is CANDIDATE_PROCESS_NAME, which references column HEADERS (schema) --
 * never a cell value -- since naming the shared header word is the entire point of that check.
 *
 * These are heuristics over one snapshot of one file, not a confirmed diagnosis. `confidence` is
 * graded by sample size and how far a threshold was crossed, never "AI judgment" -- the same
 * discipline `evolution.ts`'s own confidence scoring already established for the same reason.
 */

const STALE_DAYS_THRESHOLD = 30
const HANDOFF_GAP_DAYS_THRESHOLD = 3
const LONG_GAP_DAYS_THRESHOLD = 14
const MIN_ROWS_FOR_REPORT = 3 // below this, every check is skipped -- too little data to say anything responsible

const TERMINAL_STATUS_KEYWORDS = ['done', 'closed', 'complete', 'completed', 'cancelled', 'canceled', 'resolved', 'finished', 'rejected', 'declined', 'archived', 'shipped', 'delivered']

function isTerminalLooking(status: string): boolean {
  const s = status.trim().toLowerCase()
  if (s.length === 0) return false
  return TERMINAL_STATUS_KEYWORDS.some(kw => s.includes(kw))
}

function parseTimestamp(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

function confidenceForSample(rowCount: number, totalRowCount: number): 'low' | 'medium' | 'high' {
  if (rowCount < 2 || totalRowCount < MIN_ROWS_FOR_REPORT) return 'low'
  const rate = rowCount / totalRowCount
  if (totalRowCount >= 10 && rate >= 0.5) return 'high'
  if (totalRowCount >= 5 && rate >= 0.25) return 'medium'
  return 'low'
}

type Rows = Record<string, string>[]
type Roles = Partial<Record<keyof ColumnHints, ResolvedColumnRole>>

function roleCaveat(role: ResolvedColumnRole, label: string): string | null {
  return role.source === 'guessed' ? `The ${label} column ("${role.column}") was guessed from its header name, not confirmed -- pass --${label.replace(/ /g, '-')}-column if this is wrong.` : null
}

// --- STALE_ROWS -------------------------------------------------------------------------------

function checkStaleRows(rows: Rows, roles: Roles, sourceFile: string, now: Date): OpportunityFinding | OpportunityCheckSkip {
  const timestampRole = roles.timestampColumn
  if (!timestampRole) return { checkId: 'STALE_ROWS', reason: 'No timestamp column found or hinted -- cannot measure row age at all.' }

  const thresholdMs = STALE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000
  const staleIndexes: number[] = []
  let parsedCount = 0
  rows.forEach((row, idx) => {
    const ts = parseTimestamp(row[timestampRole.column] ?? '')
    if (ts === null) return
    parsedCount++
    if (now.getTime() - ts > thresholdMs) staleIndexes.push(idx)
  })

  if (staleIndexes.length === 0) {
    return { checkId: 'STALE_ROWS', reason: parsedCount === 0 ? `No parseable timestamps found in "${timestampRole.column}".` : `No rows older than ${STALE_DAYS_THRESHOLD} days.` }
  }

  const caveats = [`"Stale" is a fixed v0 threshold (${STALE_DAYS_THRESHOLD} days), not tuned to this process's own real cadence -- a process that normally takes 60 days will over-flag here.`]
  const c = roleCaveat(timestampRole, 'timestamp')
  if (c) caveats.push(c)

  return {
    id: `STALE_ROWS-${sourceFile}`,
    checkId: 'STALE_ROWS',
    suspectedFailureMode: `${staleIndexes.length} of ${rows.length} row(s) have a "${timestampRole.column}" value older than ${STALE_DAYS_THRESHOLD} days -- these may be dropped or forgotten work, not just slow-moving.`,
    sourceFile,
    evidenceRowRefs: staleIndexes,
    rowCount: staleIndexes.length,
    totalRowCount: rows.length,
    confidence: confidenceForSample(staleIndexes.length, rows.length),
    recommendedNextStep: `Review these rows directly in the source file (row indices above) to confirm whether they're genuinely stalled or just old-but-fine.`,
    possibleProcessContractSeed: `A process where rows can sit for ${STALE_DAYS_THRESHOLD}+ days without an update -- consider whether it needs an SLA/expiration rule for "no update within N days."`,
    caveats,
  }
}

// --- STUCK_STATUS -------------------------------------------------------------------------------

function checkStuckStatus(rows: Rows, roles: Roles, sourceFile: string, now: Date): OpportunityFinding | OpportunityCheckSkip {
  const statusRole = roles.statusColumn
  const timestampRole = roles.timestampColumn
  if (!statusRole || !timestampRole) return { checkId: 'STUCK_STATUS', reason: 'Needs both a status column and a timestamp column -- at least one was not found or hinted.' }

  const thresholdMs = STALE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000
  const stuckIndexes: number[] = []
  rows.forEach((row, idx) => {
    const status = row[statusRole.column] ?? ''
    if (isTerminalLooking(status) || status.trim().length === 0) return
    const ts = parseTimestamp(row[timestampRole.column] ?? '')
    if (ts === null) return
    if (now.getTime() - ts > thresholdMs) stuckIndexes.push(idx)
  })

  if (stuckIndexes.length === 0) return { checkId: 'STUCK_STATUS', reason: 'No rows with a non-terminal-looking status that are also older than the staleness threshold.' }

  const caveats = [`"Non-terminal-looking" is judged from a small fixed keyword list (done/closed/complete/cancelled/resolved/etc.) against the status text -- a real terminal status this file uses a different word for would be missed, or a genuinely active status containing one of these words would be wrongly excluded.`]
  const c1 = roleCaveat(statusRole, 'status')
  if (c1) caveats.push(c1)
  const c2 = roleCaveat(timestampRole, 'timestamp')
  if (c2) caveats.push(c2)

  return {
    id: `STUCK_STATUS-${sourceFile}`,
    checkId: 'STUCK_STATUS',
    suspectedFailureMode: `${stuckIndexes.length} of ${rows.length} row(s) have a status in "${statusRole.column}" that doesn't look terminal, and are also older than ${STALE_DAYS_THRESHOLD} days -- these look like work that's supposed to still be active but hasn't moved.`,
    sourceFile,
    evidenceRowRefs: stuckIndexes,
    rowCount: stuckIndexes.length,
    totalRowCount: rows.length,
    confidence: confidenceForSample(stuckIndexes.length, rows.length),
    recommendedNextStep: `Check whether these specific rows are genuinely stuck, or whether the status values just aren't being updated when work actually finishes.`,
    possibleProcessContractSeed: `A process with distinguishable "open" vs "terminal" states -- consider whether an owner/escalation rule is missing for items that stay open too long.`,
    caveats,
  }
}

// --- MISSING_OWNER / MISSING_NEXT_ACTION ---------------------------------------------------------

function checkMissingField(rows: Rows, role: ResolvedColumnRole | undefined, checkId: 'MISSING_OWNER' | 'MISSING_NEXT_ACTION', label: string, sourceFile: string): OpportunityFinding | OpportunityCheckSkip {
  if (!role) return { checkId, reason: `No ${label} column found or hinted.` }

  const missingIndexes: number[] = []
  rows.forEach((row, idx) => { if ((row[role.column] ?? '').trim().length === 0) missingIndexes.push(idx) })

  if (missingIndexes.length === 0) return { checkId, reason: `No rows with a blank "${role.column}" value.` }

  const caveats: string[] = [`A blank ${label} cell might be intentional (e.g. genuinely unassigned by design) rather than a real gap -- review before assuming it's a problem.`]
  const c = roleCaveat(role, label)
  if (c) caveats.push(c)

  return {
    id: `${checkId}-${sourceFile}`,
    checkId,
    suspectedFailureMode: `${missingIndexes.length} of ${rows.length} row(s) have a blank "${role.column}" value -- these may be work nobody is explicitly responsible for.`,
    sourceFile,
    evidenceRowRefs: missingIndexes,
    rowCount: missingIndexes.length,
    totalRowCount: rows.length,
    confidence: confidenceForSample(missingIndexes.length, rows.length),
    recommendedNextStep: `Confirm whether these rows genuinely have no ${label}, or whether the field just isn't being filled in consistently.`,
    ...(checkId === 'MISSING_OWNER' ? { possibleProcessContractSeed: `A process that needs an explicit owner assignment per state -- consider whether every stage has a defined responsible role.` } : {}),
    caveats,
  }
}

// --- DUPLICATE_RECORDS ----------------------------------------------------------------------------

function groupByKey(rows: Rows, keyColumn: string): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  rows.forEach((row, idx) => {
    const key = (row[keyColumn] ?? '').trim()
    if (!key) return
    const existing = groups.get(key)
    if (existing) existing.push(idx)
    else groups.set(key, [idx])
  })
  return groups
}

function checkDuplicateRecords(rows: Rows, roles: Roles, sourceFile: string): OpportunityFinding | OpportunityCheckSkip {
  const keyRole = roles.keyColumn
  if (!keyRole) return { checkId: 'DUPLICATE_RECORDS', reason: 'No key/id column found or hinted -- cannot tell which rows describe the same record.' }

  const groups = groupByKey(rows, keyRole.column)
  const duplicateIndexes: number[] = []
  for (const indexes of groups.values()) {
    if (indexes.length > 1) duplicateIndexes.push(...indexes)
  }

  if (duplicateIndexes.length === 0) return { checkId: 'DUPLICATE_RECORDS', reason: `No repeated values found in "${keyRole.column}".` }

  const caveats = [`A repeated key might be a legitimate re-occurrence (e.g. the same customer submitting a second, unrelated request) rather than accidental duplicate entry -- review before merging or deleting anything.`]
  const c = roleCaveat(keyRole, 'key')
  if (c) caveats.push(c)

  return {
    id: `DUPLICATE_RECORDS-${sourceFile}`,
    checkId: 'DUPLICATE_RECORDS',
    suspectedFailureMode: `${duplicateIndexes.length} row(s) share a "${keyRole.column}" value with at least one other row -- these may be duplicate entries, or the same record legitimately re-occurring.`,
    sourceFile,
    evidenceRowRefs: duplicateIndexes.sort((a, b) => a - b),
    rowCount: duplicateIndexes.length,
    totalRowCount: rows.length,
    confidence: confidenceForSample(duplicateIndexes.length, rows.length),
    recommendedNextStep: `Review these rows to confirm whether they're accidental duplicate entry or a legitimate repeat.`,
    possibleProcessContractSeed: `A process that may need explicit duplicate-detection logic on intake -- consider whether the correlation key needs disambiguation (e.g. "same phone number, new occurrence").`,
    caveats,
  }
}

// --- LONG_GAPS_BETWEEN_TIMESTAMPS ---------------------------------------------------------------

function checkLongGaps(rows: Rows, roles: Roles, sourceFile: string): OpportunityFinding | OpportunityCheckSkip {
  const timestampRole = roles.timestampColumn
  if (!timestampRole) return { checkId: 'LONG_GAPS_BETWEEN_TIMESTAMPS', reason: 'No timestamp column found or hinted.' }

  const withTimestamps = rows.map((row, idx) => ({ idx, ts: parseTimestamp(row[timestampRole.column] ?? '') })).filter((r): r is { idx: number; ts: number } => r.ts !== null)
  if (withTimestamps.length < 2) return { checkId: 'LONG_GAPS_BETWEEN_TIMESTAMPS', reason: 'Fewer than 2 parseable timestamps -- cannot measure a gap.' }

  withTimestamps.sort((a, b) => a.ts - b.ts)
  const gapThresholdMs = LONG_GAP_DAYS_THRESHOLD * 24 * 60 * 60 * 1000
  const gapRowRefs: number[] = []
  for (let i = 1; i < withTimestamps.length; i++) {
    const gap = withTimestamps[i]!.ts - withTimestamps[i - 1]!.ts
    if (gap > gapThresholdMs) gapRowRefs.push(withTimestamps[i - 1]!.idx, withTimestamps[i]!.idx)
  }

  if (gapRowRefs.length === 0) return { checkId: 'LONG_GAPS_BETWEEN_TIMESTAMPS', reason: `No gap between consecutive (sorted) timestamps exceeds ${LONG_GAP_DAYS_THRESHOLD} days.` }

  const caveats = [`Treats the whole file as one chronological stream sorted by "${timestampRole.column}" -- a gap may simply mean this file only covers certain periods (e.g. a monthly export), not that activity actually stopped.`]
  const c = roleCaveat(timestampRole, 'timestamp')
  if (c) caveats.push(c)

  const uniqueRefs = [...new Set(gapRowRefs)].sort((a, b) => a - b)
  return {
    id: `LONG_GAPS_BETWEEN_TIMESTAMPS-${sourceFile}`,
    checkId: 'LONG_GAPS_BETWEEN_TIMESTAMPS',
    suspectedFailureMode: `At least one gap of more than ${LONG_GAP_DAYS_THRESHOLD} days between consecutive "${timestampRole.column}" values, sorted chronologically -- activity may have stalled during that window.`,
    sourceFile,
    evidenceRowRefs: uniqueRefs,
    rowCount: uniqueRefs.length,
    totalRowCount: rows.length,
    confidence: confidenceForSample(uniqueRefs.length, rows.length),
    recommendedNextStep: `Check the rows bordering each gap (indices above) to see whether something real stopped, or the file simply doesn't cover that period.`,
    caveats,
  }
}

// --- UNCLOSED_LOOPS -------------------------------------------------------------------------------

function checkUnclosedLoops(rows: Rows, roles: Roles, sourceFile: string): OpportunityFinding | OpportunityCheckSkip {
  const statusRole = roles.statusColumn
  if (!statusRole) return { checkId: 'UNCLOSED_LOOPS', reason: 'No status column found or hinted.' }

  const openIndexes: number[] = []
  rows.forEach((row, idx) => {
    const status = row[statusRole.column] ?? ''
    if (status.trim().length > 0 && !isTerminalLooking(status)) openIndexes.push(idx)
  })

  if (openIndexes.length === 0) return { checkId: 'UNCLOSED_LOOPS', reason: `Every non-blank "${statusRole.column}" value looks terminal.` }

  const caveats = [`Unlike STUCK_STATUS, this counts every non-terminal-looking row regardless of age -- a large count may just mean a normally-busy, healthy pipeline, not a problem by itself.`]
  const c = roleCaveat(statusRole, 'status')
  if (c) caveats.push(c)

  return {
    id: `UNCLOSED_LOOPS-${sourceFile}`,
    checkId: 'UNCLOSED_LOOPS',
    suspectedFailureMode: `${openIndexes.length} of ${rows.length} row(s) have a non-terminal-looking status in "${statusRole.column}" -- this is the total count of open items, regardless of age (see STALE_ROWS/STUCK_STATUS for age-qualified subsets).`,
    sourceFile,
    evidenceRowRefs: openIndexes,
    rowCount: openIndexes.length,
    totalRowCount: rows.length,
    confidence: 'low', // a raw open-count alone says little on its own -- always low, deliberately, regardless of sample size
    recommendedNextStep: `Compare this count against what a healthy open-item volume normally looks like for this process before treating it as a finding.`,
    caveats,
  }
}

// --- POSSIBLE_HANDOFF_DELAY -----------------------------------------------------------------------

function checkHandoffDelay(rows: Rows, roles: Roles, sourceFile: string): OpportunityFinding | OpportunityCheckSkip {
  const keyRole = roles.keyColumn
  const ownerRole = roles.ownerColumn
  const timestampRole = roles.timestampColumn
  if (!keyRole || !ownerRole || !timestampRole) return { checkId: 'POSSIBLE_HANDOFF_DELAY', reason: 'Needs a key column (to group rows for the same record), an owner column, and a timestamp column -- at least one was not found or hinted.' }

  const groups = groupByKey(rows, keyRole.column)
  const gapThresholdMs = HANDOFF_GAP_DAYS_THRESHOLD * 24 * 60 * 60 * 1000
  const flaggedIndexes: number[] = []

  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue
    const withTs = indexes.map(idx => ({ idx, owner: (rows[idx]![ownerRole.column] ?? '').trim(), ts: parseTimestamp(rows[idx]![timestampRole.column] ?? '') }))
      .filter((r): r is { idx: number; owner: string; ts: number } => r.ts !== null)
    withTs.sort((a, b) => a.ts - b.ts)
    for (let i = 1; i < withTs.length; i++) {
      const ownerChanged = withTs[i]!.owner !== withTs[i - 1]!.owner && withTs[i]!.owner.length > 0 && withTs[i - 1]!.owner.length > 0
      const gap = withTs[i]!.ts - withTs[i - 1]!.ts
      if (ownerChanged && gap > gapThresholdMs) flaggedIndexes.push(withTs[i - 1]!.idx, withTs[i]!.idx)
    }
  }

  if (flaggedIndexes.length === 0) return { checkId: 'POSSIBLE_HANDOFF_DELAY', reason: 'No same-key row pairs found with both an owner change and a gap exceeding the handoff threshold.' }

  const caveats = [
    `Only detectable when this file has multiple rows for the same key ("${keyRole.column}") -- a file with exactly one row per record can't show a handoff at all, and this check would find nothing even if real handoff delays exist.`,
    `A gap after an owner change might reflect real work in between, not idle time -- review before assuming it's a delay.`,
  ]

  const uniqueRefs = [...new Set(flaggedIndexes)].sort((a, b) => a - b)
  return {
    id: `POSSIBLE_HANDOFF_DELAY-${sourceFile}`,
    checkId: 'POSSIBLE_HANDOFF_DELAY',
    suspectedFailureMode: `${uniqueRefs.length} row(s) are part of a same-"${keyRole.column}" pair where the "${ownerRole.column}" value changed and more than ${HANDOFF_GAP_DAYS_THRESHOLD} days passed between the two "${timestampRole.column}" values -- a possible handoff delay.`,
    sourceFile,
    evidenceRowRefs: uniqueRefs,
    rowCount: uniqueRefs.length,
    totalRowCount: rows.length,
    confidence: confidenceForSample(uniqueRefs.length, rows.length),
    recommendedNextStep: `Review these specific row pairs to see whether the gap reflects a real handoff delay or legitimate work in between.`,
    possibleProcessContractSeed: `A process with a handoff between owners -- consider whether an SLA is needed for "time from reassignment to next action."`,
    caveats,
  }
}

// --- REPEATED_MANUAL_STATUS_VALUES ------------------------------------------------------------

function checkRepeatedManualStatusValues(rows: Rows, roles: Roles, sourceFile: string): OpportunityFinding | OpportunityCheckSkip {
  const statusRole = roles.statusColumn
  if (!statusRole) return { checkId: 'REPEATED_MANUAL_STATUS_VALUES', reason: 'No status column found or hinted.' }

  // "Free-text-shaped" -- contains a space or more than ~20 characters, as opposed to a short,
  // enum-like token (e.g. "Open", "Closed"). A heuristic, not a real NLP classification.
  const looksFreeText = (v: string): boolean => v.includes(' ') || v.length > 20

  const byValue = new Map<string, number[]>()
  rows.forEach((row, idx) => {
    const v = (row[statusRole.column] ?? '').trim()
    if (!v || !looksFreeText(v)) return
    const existing = byValue.get(v)
    if (existing) existing.push(idx)
    else byValue.set(v, [idx])
  })

  const repeatedIndexes: number[] = []
  let distinctRepeatedValues = 0
  for (const indexes of byValue.values()) {
    if (indexes.length >= 3) {
      repeatedIndexes.push(...indexes)
      distinctRepeatedValues++
    }
  }

  if (repeatedIndexes.length === 0) return { checkId: 'REPEATED_MANUAL_STATUS_VALUES', reason: 'No free-text-shaped status value repeats 3 or more times.' }

  const caveats = [
    `"Free-text-shaped" is judged only by length/spaces, not real language analysis -- a short enum value that happens to repeat is not flagged, and a long-but-genuinely-structured value could be.`,
    `The repeated value's own text is deliberately never shown here -- only the count and which rows share one -- see the source file directly for the actual wording.`,
  ]
  const c = roleCaveat(statusRole, 'status')
  if (c) caveats.push(c)

  const uniqueRefs = [...new Set(repeatedIndexes)].sort((a, b) => a - b)
  return {
    id: `REPEATED_MANUAL_STATUS_VALUES-${sourceFile}`,
    checkId: 'REPEATED_MANUAL_STATUS_VALUES',
    suspectedFailureMode: `${distinctRepeatedValues} distinct free-text-shaped value(s) in "${statusRole.column}" each repeat 3+ times, covering ${uniqueRefs.length} row(s) -- this often means staff are manually re-typing the same note instead of using a structured status.`,
    sourceFile,
    evidenceRowRefs: uniqueRefs,
    rowCount: uniqueRefs.length,
    totalRowCount: rows.length,
    confidence: confidenceForSample(uniqueRefs.length, rows.length),
    recommendedNextStep: `Look at "${statusRole.column}" directly in the source file for these rows -- if the same note keeps getting typed, consider turning it into a structured status/step instead.`,
    possibleProcessContractSeed: `A process where a recurring manual note could become a real state or exception rule instead of free text.`,
    caveats,
  }
}

// --- CANDIDATE_PROCESS_NAME ---------------------------------------------------------------------

const GENERIC_HEADER_WORDS = new Set(['id', 'date', 'status', 'name', 'notes', 'note', 'time', 'created', 'updated', 'type', 'number', 'the', 'a', 'of', 'and'])

function checkCandidateProcessName(headers: string[], rowCount: number, sourceFile: string): OpportunityFinding | OpportunityCheckSkip {
  const wordCounts = new Map<string, number>()
  for (const header of headers) {
    const words = header.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !GENERIC_HEADER_WORDS.has(w))
    for (const w of new Set(words)) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1)
  }

  let bestWord: string | undefined
  let bestCount = 1
  for (const [word, count] of wordCounts) {
    if (count > bestCount) { bestWord = word; bestCount = count }
  }

  if (!bestWord) return { checkId: 'CANDIDATE_PROCESS_NAME', reason: 'No single significant word appears in more than one column header.' }

  const label = bestWord.charAt(0).toUpperCase() + bestWord.slice(1)
  return {
    id: `CANDIDATE_PROCESS_NAME-${sourceFile}`,
    checkId: 'CANDIDATE_PROCESS_NAME',
    suspectedFailureMode: `The word "${bestWord}" appears in ${bestCount} of this file's ${headers.length} column headers -- this file plausibly tracks a "${label}" process.`,
    sourceFile,
    evidenceRowRefs: [], // whole-file, header-level signal -- not about specific rows
    rowCount: 0,
    totalRowCount: rowCount,
    confidence: 'low', // always low -- a name guessed from header words alone, never more
    recommendedNextStep: `Confirm whether "${label}" is actually what this process should be called before using it anywhere.`,
    possibleProcessContractSeed: `"${label}" -- a starting name/entity for a ProcessContract, if this process turns out to be worth building one for.`,
    caveats: [`Guessed purely from a repeated word across column HEADERS (schema), never from any row's own content -- a coincidental header word (e.g. a shared unit like "hours") could produce a misleading guess.`],
  }
}

export function runOpportunityChecks(headers: string[], rows: Rows, roles: Roles, sourceFile: string, now: Date): { findings: OpportunityFinding[]; skipped: OpportunityCheckSkip[] } {
  const findings: OpportunityFinding[] = []
  const skipped: OpportunityCheckSkip[] = []

  const record = (result: OpportunityFinding | OpportunityCheckSkip) => {
    if ('id' in result) findings.push(result)
    else skipped.push(result)
  }

  if (rows.length < MIN_ROWS_FOR_REPORT) {
    const allChecks: OpportunityCheckId[] = ['STALE_ROWS', 'STUCK_STATUS', 'MISSING_OWNER', 'MISSING_NEXT_ACTION', 'DUPLICATE_RECORDS', 'LONG_GAPS_BETWEEN_TIMESTAMPS', 'UNCLOSED_LOOPS', 'POSSIBLE_HANDOFF_DELAY', 'REPEATED_MANUAL_STATUS_VALUES']
    for (const checkId of allChecks) skipped.push({ checkId, reason: `Fewer than ${MIN_ROWS_FOR_REPORT} data rows -- too little data to say anything responsible.` })
  } else {
    record(checkStaleRows(rows, roles, sourceFile, now))
    record(checkStuckStatus(rows, roles, sourceFile, now))
    record(checkMissingField(rows, roles.ownerColumn, 'MISSING_OWNER', 'owner', sourceFile))
    record(checkMissingField(rows, roles.nextActionColumn, 'MISSING_NEXT_ACTION', 'next action', sourceFile))
    record(checkDuplicateRecords(rows, roles, sourceFile))
    record(checkLongGaps(rows, roles, sourceFile))
    record(checkUnclosedLoops(rows, roles, sourceFile))
    record(checkHandoffDelay(rows, roles, sourceFile))
    record(checkRepeatedManualStatusValues(rows, roles, sourceFile))
  }

  // CANDIDATE_PROCESS_NAME only needs headers -- runs even below MIN_ROWS_FOR_REPORT, since it
  // isn't a row-count-sensitive check at all.
  record(checkCandidateProcessName(headers, rows.length, sourceFile))

  return { findings, skipped }
}
