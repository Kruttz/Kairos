import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '../utils/file-lock.js'

/**
 * Contract -> deployed-workflow registration (Phase 3). Closes a gap the design-verification
 * spike named explicitly (plan doc §6.0, "Decision" paragraph): compileToPackPlan()'s
 * ContractWorkflowTrace (Phase 2) records which contract elements a compiled workflow implements,
 * but nothing durable ever recorded which REAL n8n workflow id a contract's compiled workflows
 * became once actually built and deployed -- without that, a poller has no way to know which
 * n8n workflow ids to poll for a given contract at all. This is a required piece of "how it
 * preserves contract traceability" (one of Codex's own Phase 3 spike evaluation criteria), not a
 * new, separate feature.
 *
 * **Registration staleness after amendment/recompile (roadmap item 12, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 12 -- resolved and documented here, not left
 * as a silent gap)**: `PackBuilder.build()` always creates BRAND-NEW n8n workflows on every
 * `--build`, confirmed directly against `cli.ts`'s own `handleContractCompile` -- it never
 * patches an existing one in place (that's `kairos replace`'s separate job). That means every
 * recompile, amendment-triggered or not, deploys new n8n workflow ids and leaves whatever was
 * previously deployed still live in n8n -- not deactivated, not deleted, its webhook URL
 * unchanged and still capable of receiving real traffic. The OLD registration behavior here
 * (`saveContractWorkflowRegistration` doing a full overwrite, keyed by contractId only) would
 * silently stop polling that still-live old workflow the moment a new one was registered --
 * exactly the risk that makes amendment routine rather than rare.
 *
 * The fix: registration is now APPEND-ONLY, keyed by `n8nWorkflowId` (never by workflowName,
 * since names can legitimately repeat across versions while real n8n ids differ). A fresh
 * compile's workflows are merged into whatever's already registered; nothing already registered
 * is ever silently dropped. `contractVersion`/`status` are carried per-workflow (not just once
 * per registration batch) so a human can see which version produced which id, and so a FUTURE
 * `kairos contract workflows retire <id>` command (not built in this pass -- no such command
 * exists yet) has a field to flip without a schema migration. `kairos ledger poll`/
 * `kairos watch --contracts`/`kairos contract report` (cli.ts) all already iterate
 * `registration.workflows` generically with no per-name assumption -- confirmed directly before
 * this change, not assumed -- so they need no changes beyond filtering to `status === 'active'`,
 * which is a no-op today since nothing is ever retired in this v0.
 */

export type RegisteredWorkflowStatus = 'active' | 'retired'

export interface RegisteredWorkflow {
  n8nWorkflowId: string
  workflowName: string
  sourceElements: string[]
  /** Which contract version's compile produced this specific workflow id -- informational/audit
   * only; polling never branches on this, since evidence extraction always uses the CURRENTLY
   * loaded contract regardless of which version originally registered a given workflow id. */
  contractVersion: number
  /** Always 'active' in this v0 -- no retire command exists yet. The field exists so polling
   * call sites can filter on it now (a no-op today) without needing another change once a retire
   * command is added later. */
  status: RegisteredWorkflowStatus
  registeredAt: string
}

export interface ContractWorkflowRegistration {
  contractId: string
  /** The MOST RECENT contract version this registration has ever been updated for -- NOT a
   * claim that every entry in `workflows` was produced by this version (see each entry's own
   * `contractVersion` for that). Kept for quick "when was this last touched" visibility. */
  contractVersion: number
  clientId: string
  workflows: RegisteredWorkflow[]
  registeredAt: string
}

function registrationPath(clientId: string, contractId: string): string {
  return join(homedir(), '.kairos', 'contracts', clientId, `${contractId}-workflows.json`)
}

async function loadRawRegistration(clientId: string, contractId: string): Promise<ContractWorkflowRegistration | null> {
  try {
    const raw = await readFile(registrationPath(clientId, contractId), 'utf-8')
    return JSON.parse(raw) as ContractWorkflowRegistration
  } catch {
    return null
  }
}

/** Merges `incoming` workflows into whatever's already registered, keyed by `n8nWorkflowId` --
 * an incoming entry with an id that's already registered replaces that entry (e.g. re-running
 * `--build` against the exact same already-deployed id, an edge case today's tests cover);
 * every other existing entry is kept untouched. Locked (same "two writers, same file, expected
 * concurrent usage" reasoning `exception-store.ts`'s own `upsertExceptionDeskItems()` doc
 * comment already established for this exact class of read-modify-write) -- `kairos contract
 * compile --build` and a hypothetical concurrent second compile both write here, and a lost
 * update here would silently un-register a still-live workflow, the exact failure mode this
 * whole change exists to prevent. */
export async function saveContractWorkflowRegistration(reg: ContractWorkflowRegistration): Promise<{ path: string }> {
  const path = registrationPath(reg.clientId, reg.contractId)
  await mkdir(join(homedir(), '.kairos', 'contracts', reg.clientId), { recursive: true })
  const releaseLock = await acquireFileLock(`${path}.lock`)
  try {
    const existing = await loadRawRegistration(reg.clientId, reg.contractId)
    const byId = new Map((existing?.workflows ?? []).map(w => [w.n8nWorkflowId, w]))
    for (const w of reg.workflows) byId.set(w.n8nWorkflowId, w)
    const merged: ContractWorkflowRegistration = { ...reg, workflows: [...byId.values()] }
    await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
    await chmod(path, 0o600)
    return { path }
  } finally {
    await releaseLock()
  }
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
 * Finding 2 fix (supplemental measurement-integrity audit, 2026-07-20). Originally written
 * against a full-overwrite registration -- `saveContractWorkflowRegistration()` is now
 * append-only (roadmap item 12, above), so this function's own job narrowed slightly: it no
 * longer protects against registration ever losing a workflow's tracking (append-only already
 * guarantees that structurally), it protects against a human being surprised that a workflow
 * name they expect a FRESH compile to still produce silently didn't. Pure, no I/O --
 * `handleContractCompile` (cli.ts) calls this with only the currently-`active` existing
 * workflows (never retired ones, since a retired workflow is expected to not reappear) against
 * the fresh compile's own workflow names (matches by `workflowName`, the stable, deterministic
 * identity `compile.ts` produces, not `n8nWorkflowId`, which is always new on every rebuild).
 */
export function computeDroppedWorkflows(existingWorkflows: RegisteredWorkflow[], newWorkflowNames: Set<string>): RegisteredWorkflow[] {
  return existingWorkflows.filter(w => !newWorkflowNames.has(w.workflowName))
}
