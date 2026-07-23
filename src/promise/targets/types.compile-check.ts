import type { CapabilityDescriptor } from './types.js'

/**
 * Compile-time-only assertions that `CapabilityDescriptor`'s documented invariant -- `note` can
 * only exist, and MUST exist, when `state === 'conditional'` -- is enforced by the type system
 * itself, not merely by convention.
 *
 * Why this file exists, and why it is not simply a test in `types.test.ts`: this repository's
 * own `tsconfig.json` explicitly excludes `tests/` (`"exclude": ["node_modules", "dist",
 * "tests"]`), and vitest's own transform strips types without validating them at all -- meaning
 * a `// @ts-expect-error` comment placed inside a `.test.ts` file is never actually checked by
 * any command in this pipeline. It would be purely decorative: if `CapabilityDescriptor`'s own
 * invariant were ever accidentally loosened (e.g. `note` made available on every variant), a
 * `@ts-expect-error` sitting in a test file would silently stop suppressing anything, and
 * nothing would notice.
 *
 * This file lives under `src/` specifically so `npm run typecheck` (`tsc --noEmit`, which DOES
 * include everything under `src/`, per tsconfig.json's own `"include": ["src"]`) genuinely
 * checks these assertions on every run. It is deliberately never imported by anything -- not
 * `index.ts`, `standalone.ts`, `cli.ts`, `mcp-server.ts`, or `lint-cli.ts` (tsup's own five
 * bundle entry points, confirmed against `tsup.config.ts`) -- so it is included in the
 * TypeScript *program* `tsc` type-checks (which covers every file under `src/`, not just files
 * reachable from an entry point) but excluded from the *bundle* `tsup` produces (which only
 * follows the import graph from those five entry points). Net effect: real, enforced
 * type-checking, zero runtime cost, zero bytes added to any published artifact.
 */

// @ts-expect-error -- 'conditional' without a `note` must fail to typecheck.
const _capabilityConditionalRequiresNote: CapabilityDescriptor = { state: 'conditional' }

// @ts-expect-error -- 'supported' must never carry a `note`.
const _capabilitySupportedRejectsNote: CapabilityDescriptor = { state: 'supported', note: 'unexpected' }

// @ts-expect-error -- 'unsupported' must never carry a `note`.
const _capabilityUnsupportedRejectsNote: CapabilityDescriptor = { state: 'unsupported', note: 'unexpected' }

// A positive control, alongside the three negative ones above -- if @ts-expect-error's own
// mechanism were ever broken (e.g. this whole file silently stopped being type-checked), this
// line makes that failure mode loud: a valid, fully-populated conditional descriptor must
// typecheck with NO error at all.
const _capabilityConditionalWithNoteIsValid: CapabilityDescriptor = { state: 'conditional', note: 'valid' }
void _capabilityConditionalWithNoteIsValid
