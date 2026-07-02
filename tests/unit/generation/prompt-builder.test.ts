import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PromptBuilder } from '../../../src/generation/prompt-builder.js'
import { SYSTEM_PROMPT_V1 } from '../../../src/generation/prompts/v1.js'
import type { WorkflowMatch } from '../../../src/library/types.js'

function makeMatch(score: number, storedOverrides?: Record<string, unknown>): WorkflowMatch {
  return {
    workflow: {
      id: 'test-id',
      workflow: {
        name: 'Test',
        nodes: [{ id: '00000000-0000-4000-8000-000000000001', parameters: {}, name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] }],
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
  const builder = new PromptBuilder('/nonexistent/patterns.json')

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
    expect(SYSTEM_PROMPT_V1).toContain('EXPRESSION SYNTAX')
    expect(SYSTEM_PROMPT_V1).toContain("$('NodeName').item.json.field")
    expect(SYSTEM_PROMPT_V1).toContain('.first().json.field')
    expect(SYSTEM_PROMPT_V1).toContain('$json.field')
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

  describe('prompt profiles', () => {
    let tmpDir: string
    let patternsPath: string

    beforeEach(() => {
      tmpDir = join(tmpdir(), `kairos-profile-test-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      patternsPath = join(tmpDir, 'patterns.json')
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('minimal profile: omits library blocks even when a direct match exists', () => {
      const match = makeMatch(0.95) // score >= 0.92 = direct mode
      const pb = new PromptBuilder('/nonexistent/patterns.json', 'minimal')
      const prompt = pb.build({ description: 'test' }, [match])
      const hasLibraryBlock = prompt.system.some(b => b.text.includes('Closely Matched Workflow'))
      expect(hasLibraryBlock).toBe(false)
    })

    it('minimal profile: promotes relevant patterns by description keywords', () => {
      // credential_injection pattern has lower composite score but should rank first
      // when description mentions "auth"
      const credPattern = {
        rule: 99, failureCount: 2, confidence: 0.3,
        pipelineStage: 'credential_injection', state: 'confirmed', trend: 'stable',
        compositeScore: 0.05, // low score
        exampleMessages: ['Credential missing'],
        mitigation: 'Fix cred',
        scoringFactors: { rawConfidence: 0.3, impact: 0.05, recency: 1, stickinessBoost: 0 },
      }
      const nodePatterns = Array.from({ length: 5 }, (_, i) => ({
        rule: i + 1, failureCount: 10, confidence: 0.9,
        pipelineStage: 'node_generation', state: 'confirmed', trend: 'stable',
        compositeScore: 0.9 - i * 0.01, // higher scores
        exampleMessages: [`Node rule ${i + 1} failed`],
        mitigation: `Fix node ${i + 1}`,
        scoringFactors: { rawConfidence: 0.9, impact: 0.5, recency: 1, stickinessBoost: 0 },
      }))
      const analysis = {
        schemaVersion: 2, generatedAt: new Date().toISOString(), summary: {},
        topFailureRules: [...nodePatterns, credPattern], failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath, 'minimal')
      // description only matches credential_injection keywords, not node_generation
      const prompt = pb.build({ description: 'authenticate using OAuth credentials' }, [])
      const warningBlock = prompt.system.find(b => b.text.includes('Known Failure Patterns'))
      // credential pattern should appear despite low composite score because description matches its stage
      expect(warningBlock?.text).toContain('Rule 99')
    })

    it('minimal profile: caps active patterns at 3', () => {
      const patterns = []
      for (let i = 1; i <= 12; i++) {
        patterns.push({
          rule: i, failureCount: 5, confidence: 0.5,
          pipelineStage: 'node_generation', state: 'confirmed', trend: 'stable',
          compositeScore: 0.2 - i * 0.01,
          exampleMessages: [`Rule ${i} failed`],
          mitigation: `Fix rule ${i}`,
          scoringFactors: { rawConfidence: 0.5, impact: 0.1, recency: 1, stickinessBoost: 0 },
        })
      }
      const analysis = {
        schemaVersion: 2, generatedAt: new Date().toISOString(), summary: {},
        topFailureRules: patterns, failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath, 'minimal')
      const warned = pb.getWarnedRules()
      expect(warned.length).toBe(3)
    })

    it('standard profile: includes library blocks and up to 10 patterns (default behavior)', () => {
      const match = makeMatch(0.95)
      const pb = new PromptBuilder('/nonexistent/patterns.json', 'standard')
      const prompt = pb.build({ description: 'test' }, [match])
      const hasLibraryBlock = prompt.system.some(b => b.text.includes('Closely Matched Workflow'))
      expect(hasLibraryBlock).toBe(true)
    })

    it('rich profile: adds proactive expression guidance when no expression patterns exist', () => {
      const analysis = {
        schemaVersion: 2, generatedAt: new Date().toISOString(), summary: {},
        topFailureRules: [], failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath, 'rich')
      const prompt = pb.build({ description: 'test' }, [])
      const hasExpressionGuidance = prompt.system.some(b => b.text.includes('Expression Syntax Quick Reference'))
      expect(hasExpressionGuidance).toBe(true)
    })

    it('rich profile: skips proactive expression guidance when expression patterns already present', () => {
      const analysis = {
        schemaVersion: 2, generatedAt: new Date().toISOString(), summary: {},
        topFailureRules: [{
          rule: 24, failureCount: 3, confidence: 0.5,
          pipelineStage: 'expression_syntax', state: 'confirmed', trend: 'stable',
          compositeScore: 0.1, exampleMessages: ['bad expr'], mitigation: 'fix it',
          scoringFactors: { rawConfidence: 0.5, impact: 0.1, recency: 1, stickinessBoost: 0 },
        }],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath, 'rich')
      const prompt = pb.build({ description: 'test' }, [])
      // Expression guidance block should NOT appear (already covered by warning)
      const expressionBlocks = prompt.system.filter(b => b.text.includes('Expression Syntax Quick Reference'))
      expect(expressionBlocks.length).toBe(0)
    })
  })

  describe('failure-aware retrieval', () => {
    it('injects reference failure history when matched workflow has outcomeStats failedRules', () => {
      const match = makeMatch(0.85, {
        description: 'send email on webhook trigger',
        outcomeStats: {
          totalUses: 5,
          totalAttempts: 8,
          firstTryPasses: 2,
          failedRules: { '99': 3, '55': 2 },
        },
      })
      const prompt = builder.build({ description: 'email webhook notification' }, [match])
      const refBlock = prompt.system.find(b => b.text.includes('Reference Workflow Failure History'))
      expect(refBlock).toBeDefined()
      expect(refBlock!.text).toContain('Rule 99')
      expect(refBlock!.text).toContain('Rule 55')
      expect(refBlock!.text).toContain('3x')
      expect(refBlock!.text).toContain('2x')
    })

    it('skips reference failure history when matched workflow has no outcomeStats', () => {
      const match = makeMatch(0.85)
      const prompt = builder.build({ description: 'email notification' }, [match])
      const refBlock = prompt.system.find(b => b.text.includes('Reference Workflow Failure History'))
      expect(refBlock).toBeUndefined()
    })

    it('skips reference failure history when outcomeStats has empty failedRules', () => {
      const match = makeMatch(0.85, {
        outcomeStats: { totalUses: 5, totalAttempts: 5, firstTryPasses: 5, failedRules: {} },
      })
      const prompt = builder.build({ description: 'email notification' }, [match])
      const refBlock = prompt.system.find(b => b.text.includes('Reference Workflow Failure History'))
      expect(refBlock).toBeUndefined()
    })

    it('reference failure history appears before sub-patterns and failure warnings', () => {
      const match = makeMatch(0.85, {
        outcomeStats: { totalUses: 3, totalAttempts: 5, firstTryPasses: 1, failedRules: { '99': 2 } },
      })
      // Use a description that triggers a sub-pattern (output parser)
      const prompt = builder.build({ description: 'extract structured output with output parser and zod schema' }, [match])
      const refIdx = prompt.system.findIndex(b => b.text.includes('Reference Workflow Failure History'))
      const subPatternIdx = prompt.system.findIndex(b => b.text.includes('SUB-PATTERN'))
      expect(refIdx).toBeGreaterThan(-1)
      if (subPatternIdx !== -1) expect(refIdx).toBeLessThan(subPatternIdx)
    })

    it('reference failure history is suppressed in minimal profile', () => {
      const match = makeMatch(0.85, {
        outcomeStats: { totalUses: 5, totalAttempts: 8, firstTryPasses: 1, failedRules: { '99': 4 } },
      })
      const pb = new PromptBuilder('/nonexistent/patterns.json', 'minimal')
      const prompt = pb.build({ description: 'test' }, [match])
      const refBlock = prompt.system.find(b => b.text.includes('Reference Workflow Failure History'))
      expect(refBlock).toBeUndefined()
    })
  })

  describe('rich pattern rendering', () => {
    let tmpDir: string
    let patternsPath: string

    beforeEach(() => {
      tmpDir = join(tmpdir(), `kairos-pb-test-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      patternsPath = join(tmpDir, 'patterns.json')
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    function makePattern(rule: number, overrides?: Record<string, unknown>) {
      return {
        rule,
        failureCount: 5,
        confidence: 0.5,
        pipelineStage: 'node_generation',
        state: 'draft',
        trend: 'stable',
        compositeScore: 0.05,
        exampleMessages: [`Rule ${rule} failed`],
        mitigation: `Fix rule ${rule}`,
        scoringFactors: { rawConfidence: 0.5, impact: 0.1, recency: 1, stickinessBoost: 0 },
        ...overrides,
      }
    }

    it('caps warnings at 10 patterns, prioritizing confirmed', () => {
      const patterns = []
      for (let i = 1; i <= 15; i++) {
        patterns.push(makePattern(i, {
          state: i <= 5 ? 'confirmed' : 'draft',
          compositeScore: 0.2 - i * 0.01,
        }))
      }
      const analysis = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: {},
        topFailureRules: patterns,
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 23, totalRules: 23, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath)
      const prompt = pb.build({ description: 'test' }, [])
      const warningBlock = prompt.system.find(b => b.text.includes('Known Failure Patterns'))

      expect(warningBlock).toBeDefined()
      // All 5 confirmed should be present
      for (let i = 1; i <= 5; i++) {
        expect(warningBlock!.text).toContain(`Rule ${i}`)
      }
      // Only 5 drafts should fit (10 total - 5 confirmed = 5 drafts)
      // Rules 11-15 should be cut
      expect(warningBlock!.text).not.toContain('Rule 11')
    })

    it('renders CRITICAL REGRESSION prefix for regressed patterns', () => {
      const analysis = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: {},
        topFailureRules: [
          makePattern(17, {
            state: 'confirmed',
            pipelineStage: 'credential_injection',
            regressed: true,
            compositeScore: 0.2,
          }),
        ],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 23, totalRules: 23, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath)
      const prompt = pb.build({ description: 'test' }, [])
      const warningBlock = prompt.system.find(b => b.text.includes('Known Failure Patterns'))

      expect(warningBlock).toBeDefined()
      expect(warningBlock!.text).toContain('CRITICAL REGRESSION:')
    })

    it('prioritizes regressed patterns over confirmed and drafts', () => {
      const patterns = [
        makePattern(1, { state: 'confirmed', compositeScore: 0.19 }),
        makePattern(2, { state: 'confirmed', compositeScore: 0.18 }),
        makePattern(3, { state: 'confirmed', compositeScore: 0.17 }),
        makePattern(4, { state: 'confirmed', compositeScore: 0.16 }),
        makePattern(5, { state: 'confirmed', compositeScore: 0.15 }),
        makePattern(6, { state: 'draft', compositeScore: 0.14 }),
        makePattern(7, { state: 'draft', compositeScore: 0.13 }),
        makePattern(8, { state: 'draft', compositeScore: 0.12 }),
        makePattern(9, { state: 'draft', compositeScore: 0.11 }),
        makePattern(10, { state: 'draft', compositeScore: 0.10 }),
        makePattern(11, { state: 'draft', compositeScore: 0.09 }),
        // Regressed draft with LOW score — should still be included first
        makePattern(20, { state: 'draft', compositeScore: 0.01, regressed: true }),
      ]
      const analysis = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: {},
        topFailureRules: patterns,
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 23, totalRules: 23, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath)
      const warned = pb.getWarnedRules()

      // Regressed rule 20 should be included despite low score
      expect(warned).toContain(20)
      // Cap at 10: regressed(1) + confirmed(5) + drafts(4) = 10
      expect(warned.length).toBe(10)
      // Rule 11 should be cut (lowest draft, pushed out by regressed)
      expect(warned).not.toContain(11)
    })

    it('getWarnedRules caps at same set as buildFailureWarnings', () => {
      const patterns = []
      for (let i = 1; i <= 15; i++) {
        patterns.push(makePattern(i, {
          state: i <= 5 ? 'confirmed' : 'draft',
          compositeScore: 0.2 - i * 0.01,
        }))
      }
      const analysis = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: {},
        topFailureRules: patterns,
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 23, totalRules: 23, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath)
      const warned = pb.getWarnedRules()

      // Should be capped at 10
      expect(warned.length).toBe(10)
      // Rules 11-15 should NOT be in warned
      expect(warned).not.toContain(11)
      expect(warned).not.toContain(15)
    })

    it('injects bad/good examples for rules that have them (e.g. Rule 24)', () => {
      const analysis = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        summary: {},
        topFailureRules: [
          makePattern(24, {
            state: 'confirmed',
            pipelineStage: 'expression_syntax',
            confidence: 0.6,
            compositeScore: 0.1,
            exampleMessages: ['Deprecated $node accessor used'],
          }),
        ],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath)
      const prompt = pb.build({ description: 'test' }, [])
      const warningBlock = prompt.system.find(b => b.text.includes('Known Failure Patterns'))

      expect(warningBlock).toBeDefined()
      expect(warningBlock!.text).toContain("$node[\"Fetch Data\"].json.email")
      expect(warningBlock!.text).toContain("$('Fetch Data').item.json.email")
      expect(warningBlock!.text).toContain('Bad:')
      expect(warningBlock!.text).toContain('Good:')
    })

    it('does not inject examples for rules without them (e.g. Rule 2)', () => {
      const analysis = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        summary: {},
        topFailureRules: [
          makePattern(2, {
            state: 'confirmed',
            pipelineStage: 'node_generation',
            compositeScore: 0.1,
          }),
        ],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 26, totalRules: 26, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath)
      const prompt = pb.build({ description: 'test' }, [])
      const warningBlock = prompt.system.find(b => b.text.includes('Known Failure Patterns'))

      expect(warningBlock).toBeDefined()
      expect(warningBlock!.text).toContain('Rule 2')
      expect(warningBlock!.text).not.toContain('Bad:')
    })

    it('getWarnedRules returns active pattern rule numbers', () => {
      const analysis = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: {},
        topFailureRules: [
          makePattern(17, { state: 'confirmed', confidence: 0.8 }),
          makePattern(12, { state: 'draft', confidence: 0.3 }),
          makePattern(5, { state: 'resolved', confidence: 0 }),
        ],
        failingCredentialTypes: [],
        drift: { healthy: true, coveredRules: 23, totalRules: 23, alerts: [] },
      }
      writeFileSync(patternsPath, JSON.stringify(analysis))

      const pb = new PromptBuilder(patternsPath)
      const warned = pb.getWarnedRules()

      expect(warned).toContain(17)
      expect(warned).toContain(12)
      expect(warned).not.toContain(5)
    })
  })
})
