import { describe, it, expect } from 'vitest'
import { selectSubPatterns, formatSubPatterns } from '../../../src/library/sub-pattern-selector.js'
import { SUB_PATTERNS } from '../../../src/library/sub-patterns.js'

describe('selectSubPatterns', () => {
  it('returns output-parser pattern for structured output prompt', () => {
    const results = selectSubPatterns('extract structured JSON from email using output parser and zod schema')
    const ids = results.map(p => p.id)
    expect(ids).toContain('output-parser')
  })

  it('returns split-in-batches pattern for batch processing prompt', () => {
    const results = selectSubPatterns('process 500 rows in batches of 50 and update each record')
    const ids = results.map(p => p.id)
    expect(ids).toContain('split-in-batches-loop')
  })

  it('returns http-post-body pattern for API create prompt', () => {
    const results = selectSubPatterns('create a new customer record via HTTP POST to the Stripe API')
    const ids = results.map(p => p.id)
    expect(ids).toContain('http-post-body')
  })

  it('returns code-node-output pattern for code transformation prompt', () => {
    const results = selectSubPatterns('use a code node to transform data and compute totals')
    const ids = results.map(p => p.id)
    expect(ids).toContain('code-node-output')
  })

  it('returns ai-agent-tool-wiring pattern for agent with tools prompt', () => {
    const results = selectSubPatterns('build an AI agent with calculator and HTTP tools to answer questions')
    const ids = results.map(p => p.id)
    expect(ids).toContain('ai-agent-tool-wiring')
  })

  it('returns luxon-datetime pattern for date formatting prompt', () => {
    const results = selectSubPatterns('format the current date as yyyy-MM-dd and compare timestamps')
    const ids = results.map(p => p.id)
    expect(ids).toContain('luxon-datetime')
  })

  it('returns empty array for unrelated prompt', () => {
    const results = selectSubPatterns('send a Slack message when a new row is added to a Google Sheet')
    expect(results).toHaveLength(0)
  })

  it('caps results at max parameter', () => {
    const longPrompt = 'extract structured json using output parser zod schema batch loop split in batches code node javascript transform ai agent tools calculator datetime date format http post create'
    const results = selectSubPatterns(longPrompt, 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('defaults cap to 4', () => {
    const longPrompt = 'extract structured json using output parser zod schema batch loop split in batches code node javascript transform ai agent tools calculator datetime date format http post create'
    const results = selectSubPatterns(longPrompt)
    expect(results.length).toBeLessThanOrEqual(4)
  })

  it('is case insensitive', () => {
    const lower = selectSubPatterns('output parser structured json schema').map(p => p.id)
    const upper = selectSubPatterns('OUTPUT PARSER STRUCTURED JSON SCHEMA').map(p => p.id)
    expect(lower).toEqual(upper)
  })

  it('ranks higher-scoring patterns first', () => {
    const results = selectSubPatterns('output parser structured json schema format instructions zod extract fields parse json')
    expect(results[0]?.id).toBe('output-parser')
  })
})

describe('formatSubPatterns', () => {
  it('returns empty string for empty array', () => {
    expect(formatSubPatterns([])).toBe('')
  })

  it('includes the section header', () => {
    const [first] = SUB_PATTERNS
    const output = formatSubPatterns([first!])
    expect(output).toContain('## Sub-Patterns for This Build')
  })

  it('includes pattern name', () => {
    const pattern = SUB_PATTERNS.find(p => p.id === 'output-parser')!
    const output = formatSubPatterns([pattern])
    expect(output).toContain(pattern.name)
  })

  it('includes connection snippet when present', () => {
    const pattern = SUB_PATTERNS.find(p => p.id === 'output-parser')!
    const output = formatSubPatterns([pattern])
    expect(output).toContain(pattern.connectionSnippet!)
  })

  it('includes validator rule IDs', () => {
    const pattern = SUB_PATTERNS.find(p => p.id === 'output-parser')!
    const output = formatSubPatterns([pattern])
    expect(output).toContain('99')
  })

  it('separates multiple patterns with dividers', () => {
    const patterns = SUB_PATTERNS.slice(0, 2)
    const output = formatSubPatterns(patterns)
    expect(output).toContain('---')
  })
})
