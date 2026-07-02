import { describe, it, expect } from 'vitest'
import { classifyIntent, formatIntentRequirements } from '../../../src/library/intent-map.js'

describe('classifyIntent', () => {
  it('returns null for unrelated descriptions', () => {
    const result = classifyIntent('do a thing')
    expect(result).toBeNull()
  })

  it('classifies AI processing intent', () => {
    const result = classifyIntent('extract structured output using an LLM with zod schema')
    expect(result).not.toBeNull()
    expect(result!.requirements.intent).toBe('ai_processing')
    expect(result!.confidence).toBeGreaterThan(0)
  })

  it('classifies notification/alert intent', () => {
    const result = classifyIntent('notify the team via Slack when a new order is received')
    expect(result).not.toBeNull()
    expect(result!.requirements.intent).toBe('notification_alert')
  })

  it('classifies data extraction intent', () => {
    const result = classifyIntent('fetch data from REST API and transform the fields')
    expect(result).not.toBeNull()
    expect(result!.requirements.intent).toBe('data_extraction')
  })

  it('classifies data sync intent', () => {
    const result = classifyIntent('sync records from Airtable to Google Sheets when updated')
    expect(result).not.toBeNull()
    expect(result!.requirements.intent).toBe('data_sync')
  })

  it('classifies approval/human-in-the-loop intent', () => {
    const result = classifyIntent('pause and wait for manager approval before proceeding')
    expect(result).not.toBeNull()
    expect(result!.requirements.intent).toBe('approval_human')
  })

  it('classifies scheduled report intent', () => {
    const result = classifyIntent('send a weekly summary report every Monday morning')
    expect(result).not.toBeNull()
    expect(result!.requirements.intent).toBe('scheduled_report')
  })

  it('classifies webhook handler intent', () => {
    const result = classifyIntent('receive an incoming webhook and respond to the HTTP request')
    expect(result).not.toBeNull()
    expect(result!.requirements.intent).toBe('webhook_handler')
  })

  it('confidence increases with more matching keywords', () => {
    const weak = classifyIntent('send a notification')
    const strong = classifyIntent('notify the team via Slack message when a webhook fires — send alert')
    expect(strong!.confidence).toBeGreaterThanOrEqual(weak!.confidence)
  })

  it('confidence is capped at 1', () => {
    const result = classifyIntent(
      'llm agent gpt claude openai anthropic chatgpt langchain chain output parser zod schema extract classify summarize',
    )
    expect(result!.confidence).toBeLessThanOrEqual(1)
  })
})

describe('formatIntentRequirements', () => {
  it('returns empty string when confidence is below threshold', () => {
    const match = { requirements: { intent: 'ai_processing', label: 'AI', requiredCategories: [], antiPatterns: [] }, confidence: 0.1 }
    expect(formatIntentRequirements(match)).toBe('')
  })

  it('includes intent label in output', () => {
    const result = classifyIntent('extract structured output using llm with zod schema')
    expect(result).not.toBeNull()
    const text = formatIntentRequirements(result!)
    expect(text).toContain('AI Processing')
  })

  it('includes required categories', () => {
    const result = classifyIntent('send a weekly report every Monday')
    const text = formatIntentRequirements(result!)
    expect(text).toContain('Schedule Trigger')
    expect(text).toContain('scheduleTrigger')
  })

  it('includes anti-patterns', () => {
    const result = classifyIntent('pause and wait for approval from manager')
    const text = formatIntentRequirements(result!)
    expect(text).toContain('Anti-patterns')
    expect(text).toContain('Wait node')
  })

  it('includes required categories header', () => {
    const result = classifyIntent('notify team via slack')
    const text = formatIntentRequirements(result!)
    expect(text).toContain('MUST include')
  })
})

// Regression: keywords must match on word boundaries, not substrings.
// 'ai' is a substring of "email"/"daily"/"wait", which previously caused
// plain email workflows to classify as ai_processing.
describe('word-boundary keyword matching', () => {
  it('does NOT classify a plain email notification as ai_processing', () => {
    const result = classifyIntent('Send an email to bob when a form is submitted')
    expect(result?.requirements.intent).not.toBe('ai_processing')
  })

  it('does not let "daily" or "wait" trigger the ai keyword', () => {
    const result = classifyIntent('daily reminder to wait for the maintenance window')
    expect(result?.requirements.intent).not.toBe('ai_processing')
  })

  it('still classifies genuine AI requests as ai_processing', () => {
    const result = classifyIntent('use an AI agent with claude to classify support tickets')
    expect(result?.requirements.intent).toBe('ai_processing')
  })
})
