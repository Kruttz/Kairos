import { describe, it, expect } from 'vitest'
import { targetRefKey, type CapabilityDescriptor } from '../../../../src/promise/targets/types.js'

/**
 * Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
 * §6.1). Direct unit coverage for the one shared primitive both registry.ts and ledger-store.ts
 * depend on for their own collision-safety guarantees -- a bug here would silently undermine
 * both.
 */
describe('targetRefKey', () => {
  it('produces distinct keys for two refs whose bare-string-concatenation would collide', () => {
    // "foo" + "bar:baz" and "foo:bar" + "baz" both naively concatenate to "foo:bar:baz".
    const a = targetRefKey({ targetId: 'foo', targetDeploymentId: 'bar:baz' })
    const b = targetRefKey({ targetId: 'foo:bar', targetDeploymentId: 'baz' })
    expect(a).not.toBe(b)
  })

  it('produces the same key for the same ref, deterministically', () => {
    const ref = { targetId: 'n8n', targetDeploymentId: '42' }
    expect(targetRefKey(ref)).toBe(targetRefKey({ ...ref }))
  })

  it('escapes a literal ":" inside either component so it can never be mistaken for the delimiter', () => {
    const key = targetRefKey({ targetId: 'n8n', targetDeploymentId: 'has:colon' })
    // The delimiter itself is the one UNENCODED ':' -- everything else must be percent-escaped.
    expect(key).toBe('n8n:has%3Acolon')
  })
})

describe('CapabilityDescriptor (discriminated union)', () => {
  // These are runtime-level tests -- they can only ever prove that a VALID construction produces
  // the right runtime shape. They cannot prove an INVALID one (e.g. {state: 'conditional'} with
  // no note, or {state: 'supported', note: '...'}) is rejected -- that is a compile-time
  // property, and this repository's own tsconfig.json excludes `tests/` from type-checking
  // entirely (`"exclude": ["node_modules", "dist", "tests"]`), so a `@ts-expect-error` placed in
  // this file would never actually be checked by any command in the pipeline -- it would be
  // decorative, not enforced.
  //
  // The real, enforced compile-time negative assertions -- proving {state: 'conditional'}
  // without `note` fails to typecheck, and {state: 'supported'|'unsupported'} with a `note`
  // fails to typecheck -- live in src/promise/targets/types.compile-check.ts instead, a small
  // file deliberately never imported by any of tsup's five bundle entry points (so it adds zero
  // bytes to any published artifact) but still covered by `npm run typecheck` (which type-checks
  // everything under src/, not just files reachable from an entry point). Verified directly,
  // not just asserted: temporarily stripping that file's own @ts-expect-error comments and
  // re-running `npm run typecheck` produces exactly the three expected TS2322/TS2353 errors,
  // confirming the file is genuinely part of the checked program, not silently skipped.
  it('a "conditional" descriptor requires a note -- the type itself enforces this, not just convention (compile-time proof: src/promise/targets/types.compile-check.ts)', () => {
    const conditional: CapabilityDescriptor = { state: 'conditional', note: 'requires a local sandbox' }
    expect(conditional.state).toBe('conditional')
    if (conditional.state === 'conditional') {
      expect(conditional.note).toBeTruthy()
    }
  })

  it('"supported" and "unsupported" descriptors carry no note field at all (compile-time proof: src/promise/targets/types.compile-check.ts)', () => {
    const supported: CapabilityDescriptor = { state: 'supported' }
    const unsupported: CapabilityDescriptor = { state: 'unsupported' }
    expect('note' in supported).toBe(false)
    expect('note' in unsupported).toBe(false)
  })
})
