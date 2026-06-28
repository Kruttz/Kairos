import { describe, it, expect } from 'vitest'
import { assessTemplateSafety } from '../../../src/templates/safety.js'
import type { N8nWorkflow } from '../../../src/types/workflow.js'

const makeWorkflow = (nodes: N8nWorkflow['nodes']): N8nWorkflow => ({
  name: 'Test',
  nodes,
  connections: {},
  settings: {},
})

const node = (type: string, params: Record<string, unknown> = {}): N8nWorkflow['nodes'][0] => ({
  id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  name: type.split('.').pop() ?? type,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters: params,
})

describe('assessTemplateSafety', () => {
  it('returns safe for a workflow with no special nodes', () => {
    const result = assessTemplateSafety(makeWorkflow([node('n8n-nodes-base.scheduleTrigger')]))
    expect(result.trustLevel).toBe('safe')
    expect(result.reasons).toHaveLength(0)
  })

  it('returns safe for an empty workflow', () => {
    const result = assessTemplateSafety(makeWorkflow([]))
    expect(result.trustLevel).toBe('safe')
    expect(result.reasons).toHaveLength(0)
  })

  // BLOCKED_NODE_TYPES
  it('blocks code nodes', () => {
    const result = assessTemplateSafety(makeWorkflow([node('n8n-nodes-base.code')]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain('n8n-nodes-base.code')
  })

  it('blocks executeCommand nodes', () => {
    const result = assessTemplateSafety(makeWorkflow([node('n8n-nodes-base.executeCommand')]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons[0]).toContain('n8n-nodes-base.executeCommand')
  })

  it('blocks ssh nodes', () => {
    const result = assessTemplateSafety(makeWorkflow([node('n8n-nodes-base.ssh')]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons[0]).toContain('n8n-nodes-base.ssh')
  })

  it('collects a reason per blocked node', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.code'),
      node('n8n-nodes-base.ssh'),
    ]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons).toHaveLength(2)
  })

  // REVIEW_NODE_TYPES
  it('flags httpRequest as review', () => {
    const result = assessTemplateSafety(makeWorkflow([node('n8n-nodes-base.httpRequest')]))
    expect(result.trustLevel).toBe('review')
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain('n8n-nodes-base.httpRequest')
  })

  // Priority: blocked wins over review
  it('blocked beats review when both are present', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.httpRequest'),
      node('n8n-nodes-base.code'),
    ]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons).toHaveLength(2)
  })

  // SECRET_PATTERNS — hardcoded secrets in parameters → blocked
  it('blocks workflow with OpenAI API key in parameters', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.httpRequest', { apiKey: 'sk-abcdefghijklmnopqrstuvwx' }),
    ]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons.some((r) => r.includes('hardcoded secret'))).toBe(true)
  })

  it('blocks workflow with GitHub personal access token in parameters', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.httpRequest', { token: 'ghp_' + 'a'.repeat(36) }),
    ]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons.some((r) => r.includes('hardcoded secret'))).toBe(true)
  })

  it('blocks workflow with Slack bot token in parameters', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.slack', { token: 'xoxb-' + '123456789-123456789-abcdefghijklmno' }),
    ]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons.some((r) => r.includes('hardcoded secret'))).toBe(true)
  })

  it('blocks workflow with Google API key in parameters', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.httpRequest', { key: 'AIza' + 'B'.repeat(35) }),
    ]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons.some((r) => r.includes('hardcoded secret'))).toBe(true)
  })

  it('blocks workflow with AWS access key in parameters', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.awsS3', { accessKey: 'AKIAIOSFODNN7EXAMPLE' }),
    ]))
    expect(result.trustLevel).toBe('blocked')
    expect(result.reasons.some((r) => r.includes('hardcoded secret'))).toBe(true)
  })

  it('does not block a workflow whose parameters contain similar but non-secret strings', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.set', { note: 'sk-short', label: 'ghp-not-a-token' }),
    ]))
    expect(result.trustLevel).toBe('safe')
  })

  it('includes the node name in the secret detection reason', () => {
    const n = node('n8n-nodes-base.httpRequest', { key: 'sk-abcdefghijklmnopqrstuvwx' })
    n.name = 'Call API'
    const result = assessTemplateSafety(makeWorkflow([n]))
    expect(result.reasons.some((r) => r.includes('Call API'))).toBe(true)
  })

  // ── Expression-level secret scanning (H9) ───────────────────────────────

  it('flags expression containing split GitHub token prefix for review', () => {
    // "ghp_" alone won't match the full regex, but collectExpressionStrings picks it up
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.httpRequest', { auth: '={{ "ghp_" + $vars.token }}' }),
    ]))
    expect(result.trustLevel).toBe('review')
    expect(result.reasons.some((r) => r.includes('ghp_'))).toBe(true)
  })

  it('flags expression containing OpenAI key prefix for review', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.openAi', { apiKey: '={{ "sk-" + $env.KEY }}' }),
    ]))
    expect(result.trustLevel).toBe('review')
    expect(result.reasons.some((r) => r.includes('sk-'))).toBe(true)
  })

  it('flags expression containing AWS key prefix for review', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.awsS3', { accessKey: '={{ "AKIA" + $vars.suffix }}' }),
    ]))
    expect(result.trustLevel).toBe('review')
    expect(result.reasons.some((r) => r.includes('AKIA'))).toBe(true)
  })

  it('does not flag plain variable expressions with no secret prefix', () => {
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.set', { value: '={{ $json.name + " " + $json.email }}' }),
    ]))
    expect(result.trustLevel).toBe('safe')
  })

  it('expression scanning does not change trustLevel if node is already blocked for other reason', () => {
    // Code node already blocks; expression with prefix should not add a second reason level
    const result = assessTemplateSafety(makeWorkflow([
      node('n8n-nodes-base.code', { code: '={{ "ghp_" + x }}' }),
    ]))
    expect(result.trustLevel).toBe('blocked')
  })
})
