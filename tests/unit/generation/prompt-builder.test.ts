import { describe, it, expect } from 'vitest'
import { PromptBuilder } from '../../../src/generation/prompt-builder.js'
import { SYSTEM_PROMPT_V1 } from '../../../src/generation/prompts/v1.js'
import type { WorkflowMatch } from '../../../src/library/types.js'

function makeMatch(score: number, storedOverrides?: Record<string, unknown>): WorkflowMatch {
  return {
    workflow: {
      id: 'test-id',
      workflow: {
        name: 'Test',
        nodes: [{ parameters: {}, name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] }],
        connections: {},
      },
      description: 'test workflow',
      tags: [],
      platform: 'n8n',
      deployCount: 1,
      createdAt: new Date().toISOString(),
      ...storedOverrides,
    },
    score,
    mode: score >= 0.92 ? 'direct' : score >= 0.72 ? 'reference' : 'scratch',
  }
}

describe('PromptBuilder', () => {
  const builder = new PromptBuilder()

  it('returns scratch mode when no matches', () => {
    const prompt = builder.build({ description: 'send a Slack message' }, [])
    expect(prompt.mode).toBe('scratch')
  })

  it('system prompt block is first and has cache_control ephemeral', () => {
    const prompt = builder.build({ description: 'test' }, [])
    expect(prompt.system.length).toBeGreaterThanOrEqual(1)
    const first = prompt.system[0]!
    expect(first.type).toBe('text')
    expect(first.text).toBe(SYSTEM_PROMPT_V1)
    expect(first.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('user message includes the description', () => {
    const prompt = builder.build({ description: 'send daily Slack digest at 9am' }, [])
    expect(prompt.userMessage).toContain('send daily Slack digest at 9am')
  })

  it('user message includes custom name when provided', () => {
    const prompt = builder.build({ description: 'check API health', name: 'Health Monitor' }, [])
    expect(prompt.userMessage).toContain('Health Monitor')
  })

  it('correction message includes issue list and attempt number', () => {
    const issues = ['- [Rule 12] Forbidden field "id" present', '- [Rule 14] No trigger node']
    const msg = builder.buildCorrectionMessage({ description: 'test workflow' }, [], issues, 1)
    expect(msg).toContain('attempt 1')
    expect(msg).toContain('[Rule 12]')
    expect(msg).toContain('[Rule 14]')
    expect(msg).toContain('Fix ALL')
  })

  it('system prompt contains key sections', () => {
    expect(SYSTEM_PROMPT_V1).toContain('generate_workflow')
    expect(SYSTEM_PROMPT_V1).toContain('Forbidden fields')
    expect(SYSTEM_PROMPT_V1).toContain('ai_languageModel')
    expect(SYSTEM_PROMPT_V1).toContain('SUB-NODE is the SOURCE')
    expect(SYSTEM_PROMPT_V1).toContain('executionOrder')
  })

  it('includes failure warnings from matched workflow patterns', () => {
    const match = makeMatch(0.8, {
      failurePatterns: [
        { rule: 12, message: 'Forbidden field "id"', occurrences: 3 },
      ],
    })
    const prompt = builder.build({ description: 'test' }, [match])
    const warningBlock = prompt.system.find((b) => b.text.includes('Known Failure Patterns'))
    expect(warningBlock).toBeDefined()
    expect(warningBlock!.text).toContain('Rule 12')
    expect(warningBlock!.text).toContain('3x')
  })

  it('includes global high-frequency failure rates', () => {
    const rates = [
      { rule: 5, failureCount: 8, totalBuilds: 10, rate: 0.8, commonMessage: 'Missing executionOrder' },
      { rule: 1, failureCount: 1, totalBuilds: 10, rate: 0.1, commonMessage: 'Low freq' },
    ]
    const prompt = builder.build({ description: 'test' }, [], rates)
    const warningBlock = prompt.system.find((b) => b.text.includes('Known Failure Patterns'))
    expect(warningBlock).toBeDefined()
    expect(warningBlock!.text).toContain('Rule 5')
    expect(warningBlock!.text).toContain('80%')
    expect(warningBlock!.text).not.toContain('Rule 1')
  })

  it('omits failure warnings block when no patterns exist', () => {
    const prompt = builder.build({ description: 'test' }, [])
    const warningBlock = prompt.system.find((b) => b.text.includes('Known Failure Patterns'))
    expect(warningBlock).toBeUndefined()
  })
})
