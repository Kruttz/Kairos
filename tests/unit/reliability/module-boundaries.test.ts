import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '../../..')
const COMMUNITY_DIR = join(REPO_ROOT, 'src/reliability/community')
const PROMISE_DIR = join(REPO_ROOT, 'src/promise')

/**
 * Enforces the G4 firewall (docs/plans/reliability-suite-plan.md §12, §10.6): the Phase 5
 * community pattern library must never be able to reach an opt-in payload capture or a
 * client's per-client memory, either by importing their modules or by reading their storage
 * paths as literal strings. This is deliberately a standing test, not a comment someone has
 * to remember to check -- it fails the moment a violating import lands, not whenever someone
 * happens to re-read the module's doc comment.
 *
 * The memory/ half of this firewall was added 2026-07-19 (Phase 5a's own design-verification
 * pass, real finding #5 in the plan doc): the original test only ever checked the captures/
 * half, despite G4 always having named both in its own guardrail text -- a real gap, not a new
 * requirement, closed here as part of Phase 5a's own build sequence rather than deferred.
 *
 * community/ now has real files as of Phase 5a (whitelist.ts, share.ts) -- this test is no
 * longer vacuous; it actually scans and asserts against them.
 */
describe('module boundary: community/ must never reach replay/capture or per-client memory', () => {
  function communityFiles(): string[] {
    if (!existsSync(COMMUNITY_DIR)) return []
    return readdirSync(COMMUNITY_DIR, { recursive: true })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map(f => join(COMMUNITY_DIR, f))
  }

  it('no file under reliability/community/ imports reliability/replay/capture', () => {
    const violations: string[] = []
    for (const file of communityFiles()) {
      const content = readFileSync(file, 'utf-8')
      if (/from\s+['"].*replay\/capture(\.js)?['"]/.test(content)) violations.push(file)
    }
    expect(violations, `These files illegally import replay/capture.ts: ${violations.join(', ')}`).toEqual([])
  })

  it('no file under reliability/community/ references the captures directory path literally', () => {
    const violations: string[] = []
    for (const file of communityFiles()) {
      const content = readFileSync(file, 'utf-8')
      if (/['"`].*\.kairos[/\\]captures['"`]/.test(content)) violations.push(file)
    }
    expect(violations, `These files reference the captures/ path directly: ${violations.join(', ')}`).toEqual([])
  })

  it('no file under reliability/community/ imports the memory/ module', () => {
    const violations: string[] = []
    for (const file of communityFiles()) {
      const content = readFileSync(file, 'utf-8')
      if (/from\s+['"].*(^|\/)memory\/(store|retrieval)(\.js)?['"]/.test(content)) violations.push(file)
    }
    expect(violations, `These files illegally import from memory/: ${violations.join(', ')}`).toEqual([])
  })

  it('no file under reliability/community/ references the per-client memory directory path literally', () => {
    const violations: string[] = []
    for (const file of communityFiles()) {
      const content = readFileSync(file, 'utf-8')
      if (/['"`].*\.kairos[/\\]clients['"`]/.test(content)) violations.push(file)
    }
    expect(violations, `These files reference the clients/ (per-client memory) path directly: ${violations.join(', ')}`).toEqual([])
  })

  it('capture.ts itself does not import anything from reliability/community/', () => {
    const captureSrc = readFileSync(join(REPO_ROOT, 'src/reliability/replay/capture.ts'), 'utf-8')
    expect(/from\s+['"].*reliability\/community/.test(captureSrc)).toBe(false)
  })

  it('memory/store.ts itself does not import anything from reliability/community/', () => {
    const storeSrc = readFileSync(join(REPO_ROOT, 'src/memory/store.ts'), 'utf-8')
    expect(/from\s+['"].*reliability\/community/.test(storeSrc)).toBe(false)
  })
})

/**
 * The reverse-direction firewall, added 2026-07-19 for Phase 5b (ingestion): the mechanical
 * proof underneath Jordan's "community patterns cannot outrank local confirmed patterns"
 * requirement. It is not enough that community/ingest.ts never writes into local pattern
 * scoring -- pattern-analyzer.ts itself must have no way to *read* community data even if a
 * future change tried to wire it in, since an import is the only channel through which
 * community-sourced numbers could ever reach computeCompositeScore(). Asserted as a fact about
 * the import graph, not a promise about current behavior. The literal-path check catches the
 * narrower bypass an import check alone would miss: a future change reading
 * ~/.kairos/community-patterns.json via a raw string path without ever importing community/.
 */
describe('module boundary: pattern-analyzer.ts must never import reliability/community/', () => {
  it('src/telemetry/pattern-analyzer.ts has no import from reliability/community/', () => {
    const analyzerSrc = readFileSync(join(REPO_ROOT, 'src/telemetry/pattern-analyzer.ts'), 'utf-8')
    expect(/from\s+['"].*reliability\/community/.test(analyzerSrc)).toBe(false)
  })

  it('src/telemetry/pattern-analyzer.ts never references the community-patterns.json path literally', () => {
    const analyzerSrc = readFileSync(join(REPO_ROOT, 'src/telemetry/pattern-analyzer.ts'), 'utf-8')
    expect(/community-patterns\.json/.test(analyzerSrc)).toBe(false)
  })
})

/**
 * A new bidirectional firewall for src/promise/ (ProcessContract/ProofLedger/ExceptionDesk,
 * docs/plans/process-contract-promise-engine-plan.md), shipped in Phase 0 itself rather than
 * bolted on once real business data flows through it -- the identical discipline this repo's
 * own community/ firewall (§ above) and module-boundaries.test.ts's own docstring precedent
 * were built with: assert the boundary before there's anything real to violate it, not after.
 *
 * Community pattern sharing (Phase 5) exports validator-rule patterns -- rule numbers, pipeline
 * stages, occurrence counts. Nothing about a real business's real promise instances (a real
 * phone number's correlation-key hash, a real evidence detail string) should ever be reachable
 * from that export path, structurally, from the moment src/promise/ has its first real file.
 * Checked in both directions: promise/ must never import community/, and community/ must never
 * import promise/ -- either direction would create a channel the other doesn't currently have.
 */
describe('module boundary: src/promise/ and reliability/community/ must never reach each other', () => {
  function promiseFiles(): string[] {
    if (!existsSync(PROMISE_DIR)) return []
    return readdirSync(PROMISE_DIR, { recursive: true })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map(f => join(PROMISE_DIR, f))
  }

  function communityFiles(): string[] {
    if (!existsSync(COMMUNITY_DIR)) return []
    return readdirSync(COMMUNITY_DIR, { recursive: true })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map(f => join(COMMUNITY_DIR, f))
  }

  it('no file under src/promise/ imports reliability/community/', () => {
    const violations: string[] = []
    for (const file of promiseFiles()) {
      const content = readFileSync(file, 'utf-8')
      if (/from\s+['"].*reliability\/community/.test(content)) violations.push(file)
    }
    expect(violations, `These files illegally import reliability/community/: ${violations.join(', ')}`).toEqual([])
  })

  it('no file under reliability/community/ imports src/promise/', () => {
    const violations: string[] = []
    for (const file of communityFiles()) {
      const content = readFileSync(file, 'utf-8')
      if (/from\s+['"].*(^|\/)promise\//.test(content)) violations.push(file)
    }
    expect(violations, `These files illegally import src/promise/: ${violations.join(', ')}`).toEqual([])
  })

  it('no file under reliability/community/ references the contracts directory path literally', () => {
    const violations: string[] = []
    for (const file of communityFiles()) {
      const content = readFileSync(file, 'utf-8')
      if (/['"`].*\.kairos[/\\]contracts['"`]/.test(content)) violations.push(file)
    }
    expect(violations, `These files reference the contracts/ path directly: ${violations.join(', ')}`).toEqual([])
  })
})
