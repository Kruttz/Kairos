import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  saveContractWorkflowRegistration,
  loadContractWorkflowRegistration,
  computeDroppedWorkflows,
  normalizeRegisteredWorkflow,
  type ContractWorkflowRegistration,
  type RegisteredWorkflow,
} from '../../../src/promise/registry.js'

function makeWorkflow(overrides: Partial<RegisteredWorkflow> = {}): RegisteredWorkflow {
  const targetDeploymentId = overrides.targetDeploymentId ?? overrides.n8nWorkflowId ?? 'wf-intake'
  return {
    targetId: 'n8n',
    targetDeploymentId,
    n8nWorkflowId: targetDeploymentId,
    workflowName: 'Referral Intake',
    sourceElements: ['startCondition:sc-intake', 'state:received', 'correlationKey'],
    contractVersion: 1,
    status: 'active',
    registeredAt: '2026-07-20T09:00:00.000Z',
    ...overrides,
  }
}

function makeRegistration(overrides: Partial<ContractWorkflowRegistration> = {}): ContractWorkflowRegistration {
  return {
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    clientId: 'empire-homecare',
    workflows: [
      makeWorkflow(),
      makeWorkflow({ n8nWorkflowId: 'wf-processing', targetDeploymentId: 'wf-processing', workflowName: 'Referral Processing & Outcome Logging', sourceElements: ['transition:t-attempted-to-contacted'] }),
    ],
    registeredAt: '2026-07-20T09:00:00.000Z',
    ...overrides,
  }
}

let scratchHome: string
const ORIGINAL_HOME = homedir()

beforeEach(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), 'kairos-registry-test-'))
  process.env['HOME'] = scratchHome
})

afterEach(async () => {
  process.env['HOME'] = ORIGINAL_HOME
  await rm(scratchHome, { recursive: true, force: true })
})

describe('saveContractWorkflowRegistration / loadContractWorkflowRegistration', () => {
  it('round-trips a registration', async () => {
    const saved = await saveContractWorkflowRegistration(makeRegistration())
    expect(saved.path).toContain('empire-homecare')
    expect(saved.path).toContain('empire-homecare-referral-intake-workflows.json')

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    expect(loaded).toEqual(makeRegistration())
  })

  it('returns null, not a throw, when nothing was ever registered', async () => {
    expect(await loadContractWorkflowRegistration('nobody', 'nothing')).toBeNull()
  })

  it('is scoped per clientId', async () => {
    await saveContractWorkflowRegistration(makeRegistration({ clientId: 'client-a' }))
    const loadedForOther = await loadContractWorkflowRegistration('client-b', 'empire-homecare-referral-intake')
    expect(loadedForOther).toBeNull()
  })

  it('the saved file is chmod 600', async () => {
    await saveContractWorkflowRegistration(makeRegistration())
    const path = join(scratchHome, '.kairos', 'contracts', 'empire-homecare', 'empire-homecare-referral-intake-workflows.json')
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  // Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
  // §6.6, correction 12 from the fourth review round): a crash mid-write must never leave a
  // truncated final file -- the write goes through a temp-file-then-rename, and the temp file
  // never lingers after a normal save completes.
  it('writes via temp-file-then-rename -- no .tmp file is left behind after a normal save', async () => {
    await saveContractWorkflowRegistration(makeRegistration())
    const dir = join(scratchHome, '.kairos', 'contracts', 'empire-homecare')
    const entries = await readdir(dir)
    expect(entries).toEqual(['empire-homecare-referral-intake-workflows.json'])
    expect(entries.some(f => f.endsWith('.tmp'))).toBe(false)
  })
})

// Registration staleness after amendment/recompile (roadmap item 12, docs/plans/
// contract-evolution-ops-roadmap-plan.md §3, item 12 -- resolved in registry.ts's own doc
// comment): registration is now append-only, keyed by the collision-safe (targetId,
// targetDeploymentId) pair (Execution Substrate Boundary v0, Phase 1, plan §6.6 -- corrected
// from the pre-boundary behavior of keying by n8nWorkflowId alone), never a full overwrite -- a
// recompile after an amendment must not silently stop polling a still-live prior workflow.
describe('saveContractWorkflowRegistration -- append-only merge (roadmap item 12)', () => {
  it('a second save with entirely new deployment ids APPENDS to, rather than replaces, the first', async () => {
    await saveContractWorkflowRegistration(makeRegistration({ contractVersion: 1 }))
    await saveContractWorkflowRegistration({
      contractId: 'empire-homecare-referral-intake',
      contractVersion: 2,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ n8nWorkflowId: 'wf-intake-v2', targetDeploymentId: 'wf-intake-v2', workflowName: 'Referral Intake', contractVersion: 2, registeredAt: '2026-07-21T09:00:00.000Z' })],
      registeredAt: '2026-07-21T09:00:00.000Z',
    })

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    const ids = loaded!.workflows.map(w => w.targetDeploymentId).sort()
    // Both the v1 intake AND v1 processing workflows are still present, plus the new v2 intake --
    // nothing from the first save was silently dropped just because a second save happened.
    expect(ids).toEqual(['wf-intake', 'wf-intake-v2', 'wf-processing'].sort())
  })

  it('a second save re-using an EXISTING deployment id replaces just that one entry, not the whole list', async () => {
    await saveContractWorkflowRegistration(makeRegistration())
    await saveContractWorkflowRegistration({
      contractId: 'empire-homecare-referral-intake',
      contractVersion: 1,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ status: 'retired' })], // same deployment id as the original intake entry
      registeredAt: '2026-07-20T10:00:00.000Z',
    })

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    expect(loaded!.workflows).toHaveLength(2) // intake (now retired) + processing (untouched)
    const intake = loaded!.workflows.find(w => w.targetDeploymentId === 'wf-intake')!
    expect(intake.status).toBe('retired')
    const processing = loaded!.workflows.find(w => w.targetDeploymentId === 'wf-processing')!
    expect(processing.status).toBe('active') // untouched by the second save
  })

  it('an amendment-triggered recompile keeps the OLD workflow polled (status stays active) unless explicitly retired', async () => {
    await saveContractWorkflowRegistration(makeRegistration({ contractVersion: 1 }))
    await saveContractWorkflowRegistration({
      contractId: 'empire-homecare-referral-intake',
      contractVersion: 2,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ n8nWorkflowId: 'wf-intake-v2', targetDeploymentId: 'wf-intake-v2', contractVersion: 2 })],
      registeredAt: '2026-07-21T09:00:00.000Z',
    })
    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    const oldIntake = loaded!.workflows.find(w => w.targetDeploymentId === 'wf-intake')!
    expect(oldIntake.status).toBe('active') // still polled -- never silently retired just because a new version was registered
  })

  // Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
  // §6.6, correction 6 from the third review round): two different targets whose deployment ids
  // happen to collide as bare strings must never overwrite each other -- the whole point of
  // keying by the (targetId, targetDeploymentId) PAIR rather than targetDeploymentId alone.
  it('two different targets sharing the identical targetDeploymentId string both survive a merge -- neither overwrites the other', async () => {
    await saveContractWorkflowRegistration({
      contractId: 'cross-target-contract',
      contractVersion: 1,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ targetId: 'n8n', targetDeploymentId: '42', n8nWorkflowId: '42', workflowName: 'n8n Intake' })],
      registeredAt: '2026-07-20T09:00:00.000Z',
    })
    await saveContractWorkflowRegistration({
      contractId: 'cross-target-contract',
      contractVersion: 1,
      clientId: 'empire-homecare',
      workflows: [{ targetId: 'some-future-target', targetDeploymentId: '42', workflowName: 'Future-Target Intake', sourceElements: [], contractVersion: 1, status: 'active', registeredAt: '2026-07-20T09:00:00.000Z' }],
      registeredAt: '2026-07-20T09:00:00.000Z',
    })

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'cross-target-contract')
    expect(loaded!.workflows).toHaveLength(2)
    const n8nEntry = loaded!.workflows.find(w => w.targetId === 'n8n')!
    const futureEntry = loaded!.workflows.find(w => w.targetId === 'some-future-target')!
    expect(n8nEntry.workflowName).toBe('n8n Intake')
    expect(futureEntry.workflowName).toBe('Future-Target Intake')
    // The future target's entry never has a fabricated n8nWorkflowId alias -- it was never n8n.
    expect(futureEntry.n8nWorkflowId).toBeUndefined()
  })
})

// Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
// §6.6): normalizeRegisteredWorkflow() is the single, required normalization point for both
// legacy (pre-boundary) and already target-aware (post-boundary) persisted records.
describe('normalizeRegisteredWorkflow', () => {
  it('normalizes a legacy record (n8nWorkflowId only) to targetId: "n8n"', () => {
    const normalized = normalizeRegisteredWorkflow({
      n8nWorkflowId: 'wf-legacy',
      workflowName: 'Legacy Intake',
      sourceElements: [],
      contractVersion: 1,
      status: 'active',
      registeredAt: '2026-06-01T00:00:00.000Z',
    })
    expect(normalized.targetId).toBe('n8n')
    expect(normalized.targetDeploymentId).toBe('wf-legacy')
    expect(normalized.n8nWorkflowId).toBe('wf-legacy')
  })

  it('passes an already target-aware record through unchanged', () => {
    const normalized = normalizeRegisteredWorkflow({
      targetId: 'some-future-target',
      targetDeploymentId: 'ft-1',
      workflowName: 'Future Intake',
      sourceElements: [],
      contractVersion: 1,
      status: 'active',
      registeredAt: '2026-07-22T00:00:00.000Z',
    })
    expect(normalized.targetId).toBe('some-future-target')
    expect(normalized.targetDeploymentId).toBe('ft-1')
    expect(normalized.n8nWorkflowId).toBeUndefined()
  })

  it('throws GuardError on a corrupt record with neither identifier scheme', () => {
    expect(() =>
      normalizeRegisteredWorkflow({
        workflowName: 'Corrupt',
        sourceElements: [],
        contractVersion: 1,
        status: 'active',
        registeredAt: '2026-07-22T00:00:00.000Z',
      })
    ).toThrow(/neither targetId\/targetDeploymentId nor a legacy n8nWorkflowId/)
  })

  // A real, pre-boundary-shaped file on disk -- written directly, bypassing
  // saveContractWorkflowRegistration() entirely -- must still load and normalize correctly.
  it('loadContractWorkflowRegistration() reads a genuinely legacy on-disk file correctly', async () => {
    const dir = join(scratchHome, '.kairos', 'contracts', 'empire-homecare')
    await mkdir(dir, { recursive: true })
    const legacyRaw = {
      contractId: 'legacy-contract',
      contractVersion: 1,
      clientId: 'empire-homecare',
      workflows: [
        { n8nWorkflowId: 'wf-legacy-intake', workflowName: 'Legacy Intake', sourceElements: ['startCondition:sc-1'], contractVersion: 1, status: 'active', registeredAt: '2026-06-01T00:00:00.000Z' },
      ],
      registeredAt: '2026-06-01T00:00:00.000Z',
    }
    await writeFile(join(dir, 'legacy-contract-workflows.json'), JSON.stringify(legacyRaw, null, 2) + '\n', 'utf-8')

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'legacy-contract')
    expect(loaded!.workflows).toHaveLength(1)
    expect(loaded!.workflows[0]!.targetId).toBe('n8n')
    expect(loaded!.workflows[0]!.targetDeploymentId).toBe('wf-legacy-intake')
    expect(loaded!.workflows[0]!.n8nWorkflowId).toBe('wf-legacy-intake')
  })

  // A legacy file, once merged with a fresh save, must key correctly rather than silently
  // producing a corrupted "undefined:undefined" key -- the real, silent (not crashing, and
  // therefore worse) bug the normalize-before-key ordering fixes (Execution Substrate Boundary
  // v0 plan §6.6, correction 11 from the fourth review round).
  it('a legacy on-disk file merges correctly with a fresh save -- no "undefined:undefined" key ever appears', async () => {
    const dir = join(scratchHome, '.kairos', 'contracts', 'empire-homecare')
    await mkdir(dir, { recursive: true })
    const legacyRaw = {
      contractId: 'legacy-merge-contract',
      contractVersion: 1,
      clientId: 'empire-homecare',
      workflows: [
        { n8nWorkflowId: 'wf-legacy-only', workflowName: 'Legacy Only', sourceElements: [], contractVersion: 1, status: 'active', registeredAt: '2026-06-01T00:00:00.000Z' },
      ],
      registeredAt: '2026-06-01T00:00:00.000Z',
    }
    const path = join(dir, 'legacy-merge-contract-workflows.json')
    await writeFile(path, JSON.stringify(legacyRaw, null, 2) + '\n', 'utf-8')

    await saveContractWorkflowRegistration({
      contractId: 'legacy-merge-contract',
      contractVersion: 1,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ n8nWorkflowId: 'wf-new', targetDeploymentId: 'wf-new', workflowName: 'New Intake' })],
      registeredAt: '2026-07-22T00:00:00.000Z',
    })

    const rawOnDisk = JSON.parse(await readFile(path, 'utf-8')) as { workflows: Array<Record<string, unknown>> }
    expect(rawOnDisk.workflows).toHaveLength(2)
    expect(rawOnDisk.workflows.every(w => w['targetId'] !== undefined || w['n8nWorkflowId'] !== undefined)).toBe(true)

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'legacy-merge-contract')
    expect(loaded!.workflows).toHaveLength(2)
    expect(loaded!.workflows.every(w => w.targetId === 'n8n')).toBe(true)
    const deploymentIds = loaded!.workflows.map(w => w.targetDeploymentId).sort()
    expect(deploymentIds).toEqual(['wf-legacy-only', 'wf-new'])
  })
})

// Finding 2 fix (supplemental measurement-integrity audit, 2026-07-20), narrowed by roadmap item
// 12: a rebuild whose registration would silently stop tracking a previously-registered workflow
// must be detectable before the overwrite happens -- now scoped to currently-ACTIVE entries only
// (an already-retired entry is expected to stay missing from a fresh compile forever).
describe('computeDroppedWorkflows', () => {
  const wfIntake = makeWorkflow()
  const wfProcessing = makeWorkflow({ n8nWorkflowId: 'wf-processing', targetDeploymentId: 'wf-processing', workflowName: 'Referral Processing & Outcome Logging' })
  const wfEscalation = makeWorkflow({ n8nWorkflowId: 'wf-escalation', targetDeploymentId: 'wf-escalation', workflowName: 'Referral SLA Escalation' })

  it('reports nothing dropped on a clean rebuild with the same workflow names', () => {
    const existing = [wfIntake, wfProcessing, wfEscalation]
    const newNames = new Set(['Referral Intake', 'Referral Processing & Outcome Logging', 'Referral SLA Escalation'])
    expect(computeDroppedWorkflows(existing, newNames, 'n8n')).toEqual([])
  })

  it('reports the exact previously-registered workflow missing from a partial rebuild', () => {
    const existing = [wfIntake, wfProcessing, wfEscalation]
    const newNames = new Set(['Referral Intake', 'Referral SLA Escalation']) // Processing failed this build
    const dropped = computeDroppedWorkflows(existing, newNames, 'n8n')
    expect(dropped).toEqual([wfProcessing])
  })

  it('reports nothing dropped when there was no prior registration at all (first build)', () => {
    expect(computeDroppedWorkflows([], new Set(['Referral Intake']), 'n8n')).toEqual([])
  })

  it('does not care about a changed targetDeploymentId for a workflow that is still present by name', () => {
    const existing = [wfIntake]
    const redeployedIntake = new Set(['Referral Intake']) // same name, would-be different deployment id this build
    expect(computeDroppedWorkflows(existing, redeployedIntake, 'n8n')).toEqual([])
  })

  it('reports every previously-registered workflow dropped when none survive', () => {
    const existing = [wfIntake, wfProcessing]
    expect(computeDroppedWorkflows(existing, new Set(), 'n8n')).toEqual([wfIntake, wfProcessing])
  })

  it('a retired workflow, if mistakenly still passed in, would show as dropped -- callers must filter to active first (documented, not enforced by this pure function)', () => {
    const retired = makeWorkflow({ status: 'retired' })
    expect(computeDroppedWorkflows([retired], new Set(), 'n8n')).toEqual([retired])
  })

  // Execution Substrate Boundary v0, Phase 1 (docs/plans/execution-substrate-boundary-plan.md
  // §6.6): scoped by targetId -- an n8n-only rebuild must never report a DIFFERENT target's own
  // workflows as "dropped," since that target's workflows were never part of this rebuild at all.
  it('never reports a different target\'s own workflows as dropped, scoped by targetId', () => {
    const futureTargetWorkflow: RegisteredWorkflow = {
      targetId: 'some-future-target',
      targetDeploymentId: 'ft-1',
      workflowName: 'Future Intake',
      sourceElements: [],
      contractVersion: 1,
      status: 'active',
      registeredAt: '2026-07-22T00:00:00.000Z',
    }
    const existing = [wfIntake, futureTargetWorkflow]
    // This n8n rebuild's own newWorkflowNames set has no idea "Future Intake" even exists --
    // it must never be flagged as dropped, since it isn't this rebuild's concern at all.
    const dropped = computeDroppedWorkflows(existing, new Set(['Referral Intake']), 'n8n')
    expect(dropped).toEqual([])
  })
})
