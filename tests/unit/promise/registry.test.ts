import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { saveContractWorkflowRegistration, loadContractWorkflowRegistration, computeDroppedWorkflows, type ContractWorkflowRegistration, type RegisteredWorkflow } from '../../../src/promise/registry.js'

function makeRegistration(overrides: Partial<ContractWorkflowRegistration> = {}): ContractWorkflowRegistration {
  return {
    contractId: 'empire-homecare-referral-intake',
    contractVersion: 1,
    clientId: 'empire-homecare',
    workflows: [
      { n8nWorkflowId: 'wf-intake', workflowName: 'Referral Intake', sourceElements: ['startCondition:sc-intake', 'state:received', 'correlationKey'] },
      { n8nWorkflowId: 'wf-processing', workflowName: 'Referral Processing & Outcome Logging', sourceElements: ['transition:t-attempted-to-contacted'] },
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

  it('re-saving overwrites (matches store.ts\'s own no-versioning precedent)', async () => {
    await saveContractWorkflowRegistration(makeRegistration())
    await saveContractWorkflowRegistration(makeRegistration({ workflows: [{ n8nWorkflowId: 'wf-new', workflowName: 'New One', sourceElements: [] }] }))
    const loaded = await loadContractWorkflowRegistration('empire-homecare', 'empire-homecare-referral-intake')
    expect(loaded!.workflows).toEqual([{ n8nWorkflowId: 'wf-new', workflowName: 'New One', sourceElements: [] }])
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

// Finding 2 fix (supplemental measurement-integrity audit, 2026-07-20): a rebuild whose
// registration would silently stop tracking a previously-registered workflow must be detectable
// before the overwrite happens, not discovered later as a mysteriously-quiet evidence gap.
describe('computeDroppedWorkflows', () => {
  const wfIntake: RegisteredWorkflow = { n8nWorkflowId: 'wf-intake', workflowName: 'Referral Intake', sourceElements: [] }
  const wfProcessing: RegisteredWorkflow = { n8nWorkflowId: 'wf-processing', workflowName: 'Referral Processing & Outcome Logging', sourceElements: [] }
  const wfEscalation: RegisteredWorkflow = { n8nWorkflowId: 'wf-escalation', workflowName: 'Referral SLA Escalation', sourceElements: [] }

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
})
