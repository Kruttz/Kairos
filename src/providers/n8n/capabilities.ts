import type { TargetCapabilities } from '../../promise/targets/types.js'

/**
 * Execution Substrate Boundary v0, Phases 3-4 (docs/plans/execution-substrate-boundary-plan.md
 * §6.1). n8n's own declared capability set. §6.1's own guardrail is explicit: "if a field here
 * says 'supported', a matching interface exists and is implemented by that target." All six
 * `implemented` capabilities are now genuinely backed: `compile`/`deploy`/`fetchDeployment`/
 * `compilerVerification` by Phase 3's N8nContractCompiler/N8nContractDeployer/
 * N8nDeploymentLookup/N8nCompilerVerifier; `executionHistory`/`evidenceExtraction` by Phase 4's
 * N8nExecutionHistorySource/N8nEvidenceNormalizer (src/providers/n8n/execution-history.ts,
 * evidence.ts) -- flipped from 'unsupported' to 'supported' in this same phase, now that both
 * genuinely exist, matching the guardrail's own requirement precisely (never claimed ahead of
 * the real implementation, per Phase 3's own closeout note on this exact point). `reliability` is
 * purely informational metadata about n8n's separate, untouched reliability modules, consumed by
 * no code path in this arc.
 */
export const N8N_CAPABILITIES: TargetCapabilities = {
  implemented: {
    compile: { state: 'supported' },
    deploy: { state: 'supported' },
    fetchDeployment: { state: 'supported' },
    executionHistory: { state: 'supported' },
    evidenceExtraction: { state: 'supported' },
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
