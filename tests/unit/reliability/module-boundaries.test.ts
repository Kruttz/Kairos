import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '../../..')
const COMMUNITY_DIR = join(REPO_ROOT, 'src/reliability/community')

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
