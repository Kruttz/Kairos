import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Contract -> deployed-workflow registration (Phase 3). Closes a gap the design-verification
 * spike named explicitly (plan doc §6.0, "Decision" paragraph): compileToPackPlan()'s
 * ContractWorkflowTrace (Phase 2) records which contract elements a compiled workflow implements,
 * but nothing durable ever recorded which REAL n8n workflow id a contract's compiled workflows
 * became once actually built and deployed -- without that, a poller has no way to know which
 * n8n workflow ids to poll for a given contract at all. This is a required piece of "how it
 * preserves contract traceability" (one of Codex's own Phase 3 spike evaluation criteria), not a
 * new, separate feature.
 */

export interface RegisteredWorkflow {
  n8nWorkflowId: string
  workflowName: string
  sourceElements: string[]
}

export interface ContractWorkflowRegistration {
  contractId: string
  contractVersion: number
  clientId: string
  workflows: RegisteredWorkflow[]
  registeredAt: string
}

function registrationPath(clientId: string, contractId: string): string {
  return join(homedir(), '.kairos', 'contracts', clientId, `${contractId}-workflows.json`)
}

export async function saveContractWorkflowRegistration(reg: ContractWorkflowRegistration): Promise<{ path: string }> {
  const path = registrationPath(reg.clientId, reg.contractId)
  await mkdir(join(homedir(), '.kairos', 'contracts', reg.clientId), { recursive: true })
  await writeFile(path, JSON.stringify(reg, null, 2) + '\n', 'utf-8')
  await chmod(path, 0o600)
  return { path }
}

/** Returns null, not a throw, when nothing has been registered yet for this contract -- a real,
 * expected state (e.g. a contract only ever compiled with --dry-run, never really deployed). */
export async function loadContractWorkflowRegistration(clientId: string, contractId: string): Promise<ContractWorkflowRegistration | null> {
  try {
    const raw = await readFile(registrationPath(clientId, contractId), 'utf-8')
    return JSON.parse(raw) as ContractWorkflowRegistration
  } catch {
    return null
  }
}

/**
 * Finding 2 fix (supplemental measurement-integrity audit, 2026-07-20). `saveContractWorkflowRegistration()`
 * above is a full overwrite, no merge -- a rebuild whose registration would silently stop
 * tracking a previously-registered workflow (a transient generation failure, or the contract's
 * own structure no longer producing it) used to just lose that workflow's tracking with zero
 * signal. Pure, no I/O -- cli.ts's `handleContractCompile` uses this to decide whether to refuse
 * the save (matches by `workflowName`, the stable, deterministic identity `compile.ts` produces,
 * not `n8nWorkflowId`, which can legitimately change across a real rebuild).
 */
export function computeDroppedWorkflows(existingWorkflows: RegisteredWorkflow[], newWorkflowNames: Set<string>): RegisteredWorkflow[] {
  return existingWorkflows.filter(w => !newWorkflowNames.has(w.workflowName))
}
