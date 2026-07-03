import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PackBuilder, derivePackStatus } from '../../../src/pack/pack-builder.js'
import type { Kairos } from '../../../src/client.js'
import type { WorkflowPackResult, TypedAssumption } from '../../../src/pack/pack-builder.js'

const SAFE_ASSUMPTION: TypedAssumption = { type: 'safe', text: 'Customer emails are stored in Google Sheets' }
const CONFIRM_ASSUMPTION: TypedAssumption = { type: 'needs_confirmation', text: 'What should the newsletter tone be?' }
const BLOCKING_ASSUMPTION: TypedAssumption = { type: 'blocking', text: 'Google Sheet ID not provided' }

const MOCK_PLAN_RESPONSE = {
  workflows: [
    {
      name: 'Weekly Newsletter',
      description: 'Send a weekly newsletter via Gmail using a Schedule trigger every Monday at 9am.',
      purpose: 'Keep customers engaged with regular updates.',
    },
    {
      name: 'New Customer Welcome',
      description: 'Webhook-triggered workflow that sends a welcome email when a new customer is added.',
      purpose: 'Onboard new customers automatically.',
    },
  ],
  assumptions: [SAFE_ASSUMPTION, CONFIRM_ASSUMPTION],
  sheetsColumns: [{ sheet: 'Customers', columns: ['name', 'email'] }],
  testChecklist: [
    { workflow: 'Weekly Newsletter', steps: ['Trigger manually and check inbox'] },
    { workflow: 'New Customer Welcome', steps: ['POST to webhook with test data'] },
  ],
}

function makeMockAnthropic(responseText: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  }
}

function makeMockKairos(overrides: Partial<{ workflowId: string; generationAttempts: number; workflow: unknown }> = {}): Kairos {
  return {
    build: vi.fn().mockResolvedValue({
      workflowId: overrides.workflowId ?? 'wf-123',
      name: 'Test Workflow',
      workflow: overrides.workflow ?? {},
      credentialsNeeded: [{ service: 'Gmail', credentialType: 'gmailOAuth2', description: 'Gmail OAuth2' }],
      activationRequired: false,
      generationAttempts: overrides.generationAttempts ?? 1,
      dryRun: false,
    }),
    drain: vi.fn().mockResolvedValue(undefined),
  } as unknown as Kairos
}

describe('PackBuilder', () => {
  let builder: PackBuilder

  beforeEach(() => {
    builder = new PackBuilder({
      anthropicApiKey: 'sk-ant-test',
      kairos: makeMockKairos(),
    })
    ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(
      JSON.stringify(MOCK_PLAN_RESPONSE)
    )
  })

  describe('plan()', () => {
    it('returns a structured plan with typed assumptions', async () => {
      const plan = await builder.plan('Test DME business')
      expect(plan.businessContext).toBe('Test DME business')
      expect(plan.workflows).toHaveLength(2)
      expect(plan.workflows[0]!.name).toBe('Weekly Newsletter')
      expect(plan.assumptions).toHaveLength(2)
      expect(plan.assumptions[0]!.type).toBe('safe')
      expect(plan.assumptions[1]!.type).toBe('needs_confirmation')
      expect(plan.sheetsColumns).toHaveLength(1)
      expect(plan.testChecklist).toHaveLength(2)
    })

    it('strips markdown code fences from LLM response', async () => {
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(
        '```json\n' + JSON.stringify(MOCK_PLAN_RESPONSE) + '\n```'
      )
      const plan = await builder.plan('Test business')
      expect(plan.workflows).toHaveLength(2)
    })

    it('handles missing optional fields gracefully', async () => {
      const minimal = { workflows: [{ name: 'A', description: 'B', purpose: 'C' }] }
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(JSON.stringify(minimal))
      const plan = await builder.plan('Minimal business')
      expect(plan.assumptions).toEqual([])
      expect(plan.sheetsColumns).toEqual([])
      expect(plan.testChecklist).toEqual([])
    })

    it('normalizes legacy string assumptions to needs_confirmation', async () => {
      const legacy = { ...MOCK_PLAN_RESPONSE, assumptions: ['Old string assumption'] }
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(JSON.stringify(legacy))
      const plan = await builder.plan('Legacy format')
      expect(plan.assumptions[0]!.type).toBe('needs_confirmation')
      expect(plan.assumptions[0]!.text).toBe('Old string assumption')
    })

    it('folds legacy openQuestions into needs_confirmation assumptions', async () => {
      const withOpenQ = {
        workflows: MOCK_PLAN_RESPONSE.workflows,
        assumptions: [],
        openQuestions: ['Who approves content?'],
        sheetsColumns: [],
        testChecklist: [],
      }
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(JSON.stringify(withOpenQ))
      const plan = await builder.plan('Legacy with openQuestions')
      expect(plan.assumptions).toHaveLength(1)
      expect(plan.assumptions[0]!.type).toBe('needs_confirmation')
      expect(plan.assumptions[0]!.text).toBe('Who approves content?')
    })
  })

  describe('build()', () => {
    it('builds all workflows and returns aggregated result', async () => {
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME' }
      const result = await builder.build(plan)

      expect(result.workflows).toHaveLength(2)
      expect(result.workflows[0]!.deployed).toBe(true)
      expect(result.workflows[0]!.workflowId).toBe('wf-123')
      expect(result.businessContext).toBe('Test DME')
    })

    it('derives status as ready_for_test when needs_confirmation assumptions exist', async () => {
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME' }
      const result = await builder.build(plan)
      expect(result.status).toBe('ready_for_test')
    })

    it('derives status as ready_for_activation when only safe assumptions exist', async () => {
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME', assumptions: [SAFE_ASSUMPTION] }
      const result = await builder.build(plan)
      expect(result.status).toBe('ready_for_activation')
    })

    it('derives status as blocked when blocking assumptions exist', async () => {
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test', assumptions: [BLOCKING_ASSUMPTION] }
      const result = await builder.build(plan)
      expect(result.status).toBe('blocked')
    })

    it('blocks activation when blocking assumptions exist even if --activate passed', async () => {
      const mockKairos = makeMockKairos()
      builder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos: mockKairos })
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(JSON.stringify(MOCK_PLAN_RESPONSE))

      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test', assumptions: [BLOCKING_ASSUMPTION] }
      await builder.build(plan, { activate: true })

      expect(mockKairos.build).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ activate: false })
      )
    })

    it('passes activate:true when no blocking assumptions and --activate set', async () => {
      const mockKairos = makeMockKairos()
      builder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos: mockKairos })
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(JSON.stringify(MOCK_PLAN_RESPONSE))

      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test', assumptions: [SAFE_ASSUMPTION] }
      await builder.build(plan, { activate: true })

      expect(mockKairos.build).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ activate: true })
      )
    })

    it('deduplicates credentials across workflows', async () => {
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME' }
      const result = await builder.build(plan)
      // Both workflows return Gmail — should appear once
      expect(result.allCredentials).toHaveLength(1)
      expect(result.allCredentials[0]!.service).toBe('Gmail')
    })

    it('records error without crashing when a workflow fails', async () => {
      const failingKairos = {
        build: vi.fn()
          .mockResolvedValueOnce({
            workflowId: 'wf-ok',
            name: 'OK',
            workflow: {},
            credentialsNeeded: [],
            activationRequired: false,
            generationAttempts: 1,
            dryRun: false,
          })
          .mockRejectedValueOnce(new Error('n8n connection refused')),
        drain: vi.fn().mockResolvedValue(undefined),
      } as unknown as Kairos

      builder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos: failingKairos })
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(
        JSON.stringify(MOCK_PLAN_RESPONSE)
      )

      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME' }
      const result = await builder.build(plan)

      expect(result.workflows[0]!.deployed).toBe(true)
      expect(result.workflows[1]!.deployed).toBe(false)
      expect(result.workflows[1]!.error).toBe('n8n connection refused')
      expect(result.status).toBe('needs_attention')
    })

    it('populates scheduleIntervals from the built workflow\'s scheduleTrigger nodes', async () => {
      const scheduledWorkflow = {
        name: 'Weekly Newsletter',
        nodes: [
          {
            id: 'sched-1', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2,
            position: [0, 0], parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9 }] } },
          },
        ],
        connections: {},
      }
      builder = new PackBuilder({
        anthropicApiKey: 'sk-ant-test',
        kairos: makeMockKairos({ workflow: scheduledWorkflow }),
      })
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(
        JSON.stringify(MOCK_PLAN_RESPONSE)
      )

      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME' }
      const result = await builder.build(plan)

      expect(result.workflows[0]!.scheduleIntervals).toEqual([[{ daysInterval: 1, field: 'days', triggerAtHour: 9 }]])
    })

    it('omits scheduleIntervals when the built workflow has no schedule trigger', async () => {
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME' }
      const result = await builder.build(plan)
      expect(result.workflows[0]!.scheduleIntervals).toBeUndefined()
    })

    it('omits scheduleIntervals on a workflow that failed to build', async () => {
      const failingKairos = {
        build: vi.fn()
          .mockResolvedValueOnce({
            workflowId: 'wf-ok',
            name: 'OK',
            workflow: {},
            credentialsNeeded: [],
            activationRequired: false,
            generationAttempts: 1,
            dryRun: false,
          })
          .mockRejectedValueOnce(new Error('n8n connection refused')),
        drain: vi.fn().mockResolvedValue(undefined),
      } as unknown as Kairos

      builder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos: failingKairos })
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(
        JSON.stringify(MOCK_PLAN_RESPONSE)
      )

      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test DME' }
      const result = await builder.build(plan)

      expect(result.workflows[1]!.scheduleIntervals).toBeUndefined()
    })

    it('generates a slug pack name from business context', async () => {
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Empire Homecare DME Operations' }
      const result = await builder.build(plan)
      expect(result.packName).toBe('empire-homecare-dme-operations')
    })

    it('calls onProgress for each workflow', async () => {
      const progress = vi.fn()
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test' }
      await builder.build(plan, { onProgress: progress })
      expect(progress).toHaveBeenCalledTimes(2)
      expect(progress).toHaveBeenCalledWith(plan.workflows[0], 0, 2)
      expect(progress).toHaveBeenCalledWith(plan.workflows[1], 1, 2)
    })

    it('passes dryRun and activate options to each kairos.build call', async () => {
      const mockKairos = makeMockKairos()
      builder = new PackBuilder({ anthropicApiKey: 'sk-ant-test', kairos: mockKairos })
      ;(builder as unknown as Record<string, unknown>)['client'] = makeMockAnthropic(
        JSON.stringify(MOCK_PLAN_RESPONSE)
      )

      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test', assumptions: [] }
      await builder.build(plan, { dryRun: true, activate: false })

      expect(mockKairos.build).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dryRun: true, activate: false })
      )
    })

    it('includes builtAt timestamp in result', async () => {
      const before = Date.now()
      const plan = { ...MOCK_PLAN_RESPONSE, businessContext: 'Test' }
      const result = await builder.build(plan)
      const after = Date.now()
      const builtAt = new Date(result.builtAt).getTime()
      expect(builtAt).toBeGreaterThanOrEqual(before)
      expect(builtAt).toBeLessThanOrEqual(after)
    })
  })

  describe('derivePackStatus()', () => {
    function makePack(overrides: Partial<WorkflowPackResult>): WorkflowPackResult {
      return {
        businessContext: 'Test',
        packName: 'test',
        status: 'draft',
        workflows: [{ name: 'W', purpose: 'P', workflowId: 'id', deployed: true, generationAttempts: 1, credentialsNeeded: [] }],
        allCredentials: [],
        sheetsColumns: [],
        assumptions: [],
        testChecklist: [],
        builtAt: new Date().toISOString(),
        ...overrides,
      }
    }

    it('returns draft when no workflows deployed', () => {
      expect(derivePackStatus(makePack({ workflows: [] }))).toBe('draft')
    })

    it('returns blocked when blocking assumptions exist', () => {
      expect(derivePackStatus(makePack({ assumptions: [BLOCKING_ASSUMPTION] }))).toBe('blocked')
    })

    it('returns needs_attention when a workflow has an error', () => {
      const pack = makePack({
        workflows: [{ name: 'W', purpose: 'P', workflowId: null, deployed: false, generationAttempts: 0, credentialsNeeded: [], error: 'failed' }],
      })
      expect(derivePackStatus(pack)).toBe('needs_attention')
    })

    it('returns ready_for_test when needs_confirmation assumptions exist', () => {
      expect(derivePackStatus(makePack({ assumptions: [CONFIRM_ASSUMPTION] }))).toBe('ready_for_test')
    })

    it('returns ready_for_activation when only safe assumptions and all deployed', () => {
      expect(derivePackStatus(makePack({ assumptions: [SAFE_ASSUMPTION] }))).toBe('ready_for_activation')
    })

    it('preserves active status when conditions still hold', () => {
      const pack = makePack({ status: 'active', assumptions: [SAFE_ASSUMPTION] })
      expect(derivePackStatus(pack)).toBe('active')
    })

    it('downgrades active to blocked when a blocking assumption is added', () => {
      const pack = makePack({ status: 'active', assumptions: [BLOCKING_ASSUMPTION] })
      expect(derivePackStatus(pack)).toBe('blocked')
    })
  })
})
