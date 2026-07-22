import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { saveContractWorkflowRegistration, loadContractWorkflowRegistration, computeDroppedWorkflows, type ContractWorkflowRegistration, type RegisteredWorkflow } from '../../../src/promise/registry.js'

function makeWorkflow(overrides: Partial<RegisteredWorkflow> = {}): RegisteredWorkflow {
  return {
    n8nWorkflowId: 'wf-intake',
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
      makeWorkflow({ n8nWorkflowId: 'wf-processing', workflowName: 'Referral Processing & Outcome Logging', sourceElements: ['transition:t-attempted-to-contacted'] }),
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
})

// Registration staleness after amendment/recompile (roadmap item 12, docs/plans/
// contract-evolution-ops-roadmap-plan.md §3, item 12 -- resolved in registry.ts's own doc
// comment): registration is now append-only, keyed by n8nWorkflowId, never a full overwrite --
// a recompile after an amendment must not silently stop polling a still-live prior workflow.
describe('saveContractWorkflowRegistration -- append-only merge (roadmap item 12)', () => {
  it('a second save with entirely new n8nWorkflowIds APPENDS to, rather than replaces, the first', async () => {
    await saveContractWorkflowRegistration(makeRegistration({ contractVersion: 1 }))
    await saveContractWorkflowRegistration({
      contractId: 'empire-homecare-referral-intake',
      contractVersion: 2,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ n8nWorkflowId: 'wf-intake-v2', workflowName: 'Referral Intake', contractVersion: 2, registeredAt: '2026-07-21T09:00:00.000Z' })],
      registeredAt: '2026-07-21T09:00:00.000Z',
    })

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    const ids = loaded!.workflows.map(w => w.n8nWorkflowId).sort()
    // Both the v1 intake AND v1 processing workflows are still present, plus the new v2 intake --
    // nothing from the first save was silently dropped just because a second save happened.
    expect(ids).toEqual(['wf-intake', 'wf-intake-v2', 'wf-processing'].sort())
  })

  it('a second save re-using an EXISTING n8nWorkflowId replaces just that one entry, not the whole list', async () => {
    await saveContractWorkflowRegistration(makeRegistration())
    await saveContractWorkflowRegistration({
      contractId: 'empire-homecare-referral-intake',
      contractVersion: 1,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ status: 'retired' })], // same n8nWorkflowId as the original intake entry
      registeredAt: '2026-07-20T10:00:00.000Z',
    })

    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    expect(loaded!.workflows).toHaveLength(2) // intake (now retired) + processing (untouched)
    const intake = loaded!.workflows.find(w => w.n8nWorkflowId === 'wf-intake')!
    expect(intake.status).toBe('retired')
    const processing = loaded!.workflows.find(w => w.n8nWorkflowId === 'wf-processing')!
    expect(processing.status).toBe('active') // untouched by the second save
  })

  it('an amendment-triggered recompile keeps the OLD workflow polled (status stays active) unless explicitly retired', async () => {
    await saveContractWorkflowRegistration(makeRegistration({ contractVersion: 1 }))
    await saveContractWorkflowRegistration({
      contractId: 'empire-homecare-referral-intake',
      contractVersion: 2,
      clientId: 'empire-homecare',
      workflows: [makeWorkflow({ n8nWorkflowId: 'wf-intake-v2', contractVersion: 2 })],
      registeredAt: '2026-07-21T09:00:00.000Z',
    })
    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    const oldIntake = loaded!.workflows.find(w => w.n8nWorkflowId === 'wf-intake')!
    expect(oldIntake.status).toBe('active') // still polled -- never silently retired just because a new version was registered
  })
})

// Finding 2 fix (supplemental measurement-integrity audit, 2026-07-20), narrowed by roadmap item
// 12: a rebuild whose registration would silently stop tracking a previously-registered workflow
// must be detectable before the overwrite happens -- now scoped to currently-ACTIVE entries only
// (an already-retired entry is expected to stay missing from a fresh compile forever).
describe('computeDroppedWorkflows', () => {
  const wfIntake = makeWorkflow()
  const wfProcessing = makeWorkflow({ n8nWorkflowId: 'wf-processing', workflowName: 'Referral Processing & Outcome Logging' })
  const wfEscalation = makeWorkflow({ n8nWorkflowId: 'wf-escalation', workflowName: 'Referral SLA Escalation' })

  it('reports nothing dropped on a clean rebuild with the same workflow names', () => {
    const existing = [wfIntake, wfProcessing, wfEscalation]
    const newNames = new Set(['Referral Intake', 'Referral Processing & Outcome Logging', 'Referral SLA Escalation'])
    expect(computeDroppedWorkflows(existing, newNames)).toEqual([])
  })

  it('reports the exact previously-registered workflow missing from a partial rebuild', () => {
    const existing = [wfIntake, wfProcessing, wfEscalation]
    const newNames = new Set(['Referral Intake', 'Referral SLA Escalation']) // Processing failed this build
    const dropped = computeDroppedWorkflows(existing, newNames)
    expect(dropped).toEqual([wfProcessing])
  })

  it('reports nothing dropped when there was no prior registration at all (first build)', () => {
    expect(computeDroppedWorkflows([], new Set(['Referral Intake']))).toEqual([])
  })

  it('does not care about a changed n8nWorkflowId for a workflow that is still present by name', () => {
    const existing = [wfIntake]
    const redeployedIntake = new Set(['Referral Intake']) // same name, would-be different n8nWorkflowId this build
    expect(computeDroppedWorkflows(existing, redeployedIntake)).toEqual([])
  })

  it('reports every previously-registered workflow dropped when none survive', () => {
    const existing = [wfIntake, wfProcessing]
    expect(computeDroppedWorkflows(existing, new Set())).toEqual([wfIntake, wfProcessing])
  })

  it('a retired workflow, if mistakenly still passed in, would show as dropped -- callers must filter to active first (documented, not enforced by this pure function)', () => {
    const retired = makeWorkflow({ status: 'retired' })
    expect(computeDroppedWorkflows([retired], new Set())).toEqual([retired])
  })
})
