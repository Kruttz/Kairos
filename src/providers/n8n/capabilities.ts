import type { TargetCapabilities } from '../../promise/targets/types.js'

/**
 * Execution Substrate Boundary v0, Phase 3 (docs/plans/execution-substrate-boundary-plan.md
 * §6.1). n8n's own declared capability set. Deliberately NOT all six marked 'supported' yet,
 * even though the plan's own §6.1 pseudocode shows them that way in one combined snapshot --
 * that pseudocode describes the capability declaration once the WHOLE arc (Phases 3-4) has
 * shipped, not this phase alone. §6.1's own guardrail is explicit: "if a field here says
 * 'supported', a matching interface exists and is implemented by that target." As of Phase 3,
 * `executionHistory` (N8nExecutionHistorySource) and `evidenceExtraction`
 * (normalizeN8nExecution()/EvidenceNormalizer) do not exist yet -- both are Phase 4 scope --
 * so both are honestly marked 'unsupported' here and will flip to 'supported' when Phase 4
 * actually ships them. `compile`/`deploy`/`fetchDeployment`/`compilerVerification` are real,
 * implemented by this phase's own N8nContractCompiler/N8nContractDeployer/N8nDeploymentLookup/
 * N8nCompilerVerifier, so all four are genuinely 'supported' already. `reliability` is purely
 * informational metadata about n8n's separate, untouched reliability modules, consumed by no
 * code path in this arc.
 */
export const N8N_CAPABILITIES: TargetCapabilities = {
  implemented: {
    compile: { state: 'supported' },
    deploy: { state: 'supported' },
    fetchDeployment: { state: 'supported' },
    executionHistory: { state: 'unsupported' },   // Phase 4
    evidenceExtraction: { state: 'unsupported' },  // Phase 4
    compilerVerification: { state: 'supported' },
  },
  reliability: {
    replay: { state: 'conditional', note: 'Requires a bootable local n8n sandbox (kairos sandbox up) -- see docs/plans/reliability-suite-plan.md S2.' },
    chaos: { state: 'conditional', note: 'Tier A (audit) is always supported; Tier B (run) requires the same sandbox as replay.' },
    sandbox: { state: 'conditional', note: 'Requires network access to fetch the pinned n8n package version via npx.' },
    drift: { state: 'supported' },
    repair: { state: 'supported' },
    rollback: { state: 'supported' },
  },
}
