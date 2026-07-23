/**
 * Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md §6.1).
 * Shared identity/capability primitives only -- no operational interfaces yet (those land in
 * Phase 3/4, see the plan's §6.2-§6.5). This file exists so registry.ts and ledger-types.ts/
 * ledger-store.ts (both revised in this same phase) share one collision-safe key implementation
 * rather than each inventing their own.
 */

/** Which execution target a deployment/evidence-source belongs to. Reuses the exact
 * string-discriminator convention IProvider.platform (src/providers/types.ts) already
 * established -- 'n8n' is the only real value produced by any code today. */
export type TargetId = string

export interface TargetDeploymentRef {
  targetId: TargetId
  targetDeploymentId: string
}

/**
 * Collision-safe composite key, shared by registry.ts's registration merge (plan §6.6) and
 * ledger-store.ts's watermark keying (plan §6.7) -- one implementation, not two independent
 * copies of the same escaping logic.
 *
 * Plain string concatenation (`${targetId}:${targetDeploymentId}`) would collide whenever either
 * value itself contains ':' -- e.g. targetId: 'foo' + targetDeploymentId: 'bar:baz' produces the
 * identical string as targetId: 'foo:bar' + targetDeploymentId: 'baz'. encodeURIComponent
 * escapes ':' into '%3A' in both components first, so the delimiter can only ever be the
 * intentional separator between them, never part of either component's own content.
 */
export function targetRefKey(ref: TargetDeploymentRef): string {
  return `${encodeURIComponent(ref.targetId)}:${encodeURIComponent(ref.targetDeploymentId)}`
}

/**
 * A real discriminated union, not an interface that would allow every field combination
 * ({state: 'conditional'} with no note, or {state: 'supported', note: '...'}) to typecheck.
 * TypeScript itself enforces the documented invariant directly: `note` can only exist, and MUST
 * exist, when state === 'conditional'.
 */
export type CapabilityDescriptor =
  | { state: 'supported' }
  | { state: 'unsupported' }
  | { state: 'conditional'; note: string }

/**
 * Only the six capabilities the Execution Substrate Boundary arc actually defines interfaces
 * for (plan §6.2-§6.5, built across Phases 3-4). Any consumer can rely on: if a field here says
 * 'supported', a matching interface exists and is implemented by that target.
 */
export interface ImplementedCapabilities {
  compile: CapabilityDescriptor
  deploy: CapabilityDescriptor
  fetchDeployment: CapabilityDescriptor
  executionHistory: CapabilityDescriptor
  evidenceExtraction: CapabilityDescriptor
  compilerVerification: CapabilityDescriptor
}

/**
 * Purely informational (plan §4's own risk-table entry on this point). Describes what n8n's
 * own, separate, untouched reliability modules (src/reliability/{replay,chaos,drift,repair,
 * sandbox}) support -- for a future console/report to display. NO interface exists anywhere in
 * the Execution Substrate Boundary arc for any of these six; nothing in that arc's own code
 * type-checks against, calls, or consumes this data. A future arc that actually builds a real
 * interface for one of these would move that field into ImplementedCapabilities; until then this
 * is metadata only.
 */
export interface InformationalReliabilityCapabilities {
  replay: CapabilityDescriptor
  chaos: CapabilityDescriptor
  sandbox: CapabilityDescriptor
  drift: CapabilityDescriptor
  repair: CapabilityDescriptor
  rollback: CapabilityDescriptor
}

export interface TargetCapabilities {
  implemented: ImplementedCapabilities
  reliability: InformationalReliabilityCapabilities
}
