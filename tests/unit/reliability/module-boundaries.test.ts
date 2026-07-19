import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '../../..')
const COMMUNITY_DIR = join(REPO_ROOT, 'src/reliability/community')

/**
 * Enforces the G4 firewall (docs/plans/reliability-suite-plan.md 5.1b/5.2): the Phase 5
 * community pattern library must never be able to reach an opt-in payload capture, either by
 * importing capture.ts's exports or by reading its output directory path as a literal
 * string. This is deliberately a standing test, not a comment someone has to remember to
 * check -- it fails the moment a violating import lands, not whenever someone happens to
 * re-read the module's doc comment.
 *
 * As of this writing, src/reliability/community/ does not exist yet (Phase 5 is unbuilt) --
 * these tests are honestly vacuous until then (nothing to scan, so nothing can violate the
 * boundary). They start actually enforcing the instant the first file lands there. This is
 * intentional, not a gap: the boundary is asserted now, before there's anything to violate
 * it, exactly so Phase 5 can never accidentally ship without satisfying it.
 */
describe('module boundary: community/ must never reach replay/capture', () => {
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

  it('capture.ts itself does not import anything from reliability/community/', () => {
    const captureSrc = readFileSync(join(REPO_ROOT, 'src/reliability/replay/capture.ts'), 'utf-8')
    expect(/from\s+['"].*reliability\/community/.test(captureSrc)).toBe(false)
  })
})
