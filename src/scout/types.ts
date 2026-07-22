/**
 * Operations Scout v0 (roadmap item 14, docs/plans/contract-evolution-ops-roadmap-plan.md §3,
 * item 14). Types only -- see src/scout/csv-source.ts (parsing + column-role detection),
 * src/scout/checks.ts (the 10 detection heuristics), and src/scout/analyze.ts (the orchestrator).
 *
 * Deliberately its own top-level module, not under promise/ or reliability/ -- both of those
 * assume a ProcessContract already exists; Scout's whole job is the step BEFORE that, finding
 * which process is worth building a contract for in the first place. No dependency on
 * ProcessContract/ProofLedger/any reliability-suite module anywhere in this directory.
 */

export interface OpportunitySource {
  type: 'csv' // v0: exactly one variant, deliberately -- see the plan's own "don't let format support become the project" guardrail
  path: string
}

/** Explicit column-role hints, always human-supplied -- v0 also falls back to a header-name
 * heuristic guess when a role isn't hinted (see csv-source.ts's own detectColumnRoles()), but a
 * hint always wins over the guess. Every check that needs a role it can't resolve either way is
 * honestly skipped, never run against a guessed-wrong column. */
export interface ColumnHints {
  statusColumn?: string
  timestampColumn?: string
  ownerColumn?: string
  keyColumn?: string
  nextActionColumn?: string
}

/** The roles this report actually resolved -- one per possible role, and whether it came from an
 * explicit hint or a header-name guess, so a human reviewing the report can tell "Kairos guessed
 * this" from "I told it this." Never a raw cell value -- only ever a column NAME (schema, not a
 * record). */
export interface ResolvedColumnRole {
  column: string
  source: 'hint' | 'guessed'
}

export type OpportunityCheckId =
  | 'STALE_ROWS'
  | 'STUCK_STATUS'
  | 'MISSING_OWNER'
  | 'MISSING_NEXT_ACTION'
  | 'DUPLICATE_RECORDS'
  | 'LONG_GAPS_BETWEEN_TIMESTAMPS'
  | 'UNCLOSED_LOOPS'
  | 'POSSIBLE_HANDOFF_DELAY'
  | 'REPEATED_MANUAL_STATUS_VALUES'
  | 'CANDIDATE_PROCESS_NAME'

export interface OpportunityFinding {
  /** Deterministic, content-derived (checkId + source file), not a counter -- re-running analyze
   * against the same file produces the same finding ids, the same discipline
   * evolution.ts's own makeProposalId() already established for the same reason. */
  id: string
  checkId: OpportunityCheckId
  /** Plain-language, e.g. "Rows appear stuck in an open-looking status well past this file's
   * own typical timestamp age." Never references a raw cell value -- see this module's own
   * top-level guardrail. */
  suspectedFailureMode: string
  sourceFile: string
  /** Row INDEX references only (0-based, into the data rows, not counting the header) -- never
   * row content. The human can look up the real row themselves in their own file. Empty for the
   * one whole-file-level check (CANDIDATE_PROCESS_NAME), which isn't about specific rows. */
  evidenceRowRefs: number[]
  rowCount: number
  /** Always shown alongside rowCount, same "never a bare percentage/count" discipline
   * evolution.ts's own sampleSize field already established. */
  totalRowCount: number
  /** Evidence-graded, never "AI judgment" -- see each check's own doc comment in checks.ts for
   * exactly what drives it (usually sample size + how far a heuristic threshold was crossed). */
  confidence: 'low' | 'medium' | 'high'
  /** A human action -- review, confirm, ask -- never an auto-fix, never framed as something
   * Kairos itself would do. */
  recommendedNextStep: string
  /** A short, plain-text sentence suitable for hand-copying into `kairos contract intake start
   * --context <file>` or a `contract plan` description -- never auto-fed into either. Present
   * only for checks where a plausible contract-relevant observation exists to seed. */
  possibleProcessContractSeed?: string
  /** Always at least one entry -- this finding's own specific limitation (e.g. "the owner column
   * was guessed from its header name, not confirmed" or "a 30-day staleness threshold is a fixed
   * v0 default, not tuned to this process's own real cadence"). Findings are candidates for
   * review, never proven business failures -- these caveats are the concrete reason why. */
  caveats: string[]
}

export interface OpportunityCheckSkip {
  checkId: OpportunityCheckId
  reason: string
}

export interface OpportunityReport {
  source: OpportunitySource
  generatedAt: string
  rowCount: number
  /** Every role this report resolved, by hint or by guess -- absent roles simply aren't present
   * as keys (not an object with every field always populated). */
  columnRoles: Partial<Record<keyof ColumnHints, ResolvedColumnRole>>
  findings: OpportunityFinding[]
  /** Checks that could not run at all, and why (almost always: no column resolved for a role
   * that check needs) -- honest, always shown, never a silent omission. Mirrors the
   * ScenarioGenerationSkip / evolution.ts skipped-category pattern already established
   * elsewhere in this codebase for the same reason. */
  skipped: OpportunityCheckSkip[]
  /** Always present, always the same core warning regardless of what was found: this is
   * heuristic, column-name/threshold-based analysis of one file, not a confirmed finding. */
  disclaimer: string
}
