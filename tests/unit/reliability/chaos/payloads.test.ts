import { describe, it, expect } from 'vitest'
import { generateChaosPayloads } from '../../../../src/reliability/chaos/payloads.js'
import type { N8nWorkflow, N8nNode } from '../../../../src/types/workflow.js'

function makeNode(overrides: Partial<N8nNode> = {}): N8nNode {
  return {
    id: 'n1', name: 'Node', type: 'n8n-nodes-base.set', typeVersion: 1, position: [0, 0], parameters: {},
    ...overrides,
  }
}

function makeWorkflow(nodes: N8nNode[]): N8nWorkflow {
  return { name: 'Test Workflow', nodes, connections: {} }
}

describe('generateChaosPayloads', () => {
  it('always includes exactly one valid-baseline variant first', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    expect(variants[0]!.name).toBe('valid-baseline')
    expect(variants.filter((v) => v.name === 'valid-baseline')).toHaveLength(1)
  })

  it('synthesizes a valid baseline body from referenced fields when none is supplied', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.customer.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const baseline = variants[0]!.body as Record<string, unknown>
    expect(baseline).toEqual({ customer: { email: 'test-email' } })
  })

  it('uses a supplied real captured payload as the baseline instead of synthesizing one', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const real = { email: 'real@example.com', extra: 'untouched' }
    const variants = generateChaosPayloads(workflow, real)
    expect(variants[0]!.body).toEqual(real)
  })

  it('generates one missing-field variant per referenced field, with the field actually absent', () => {
    const workflow = makeWorkflow([
      makeNode({ parameters: { a: '={{$json.body.email}}, {{$json.body.customer.phone}}' } }),
    ])
    const variants = generateChaosPayloads(workflow)
    const missingEmail = variants.find((v) => v.name === 'missing-field:email')!
    expect(missingEmail.body).not.toHaveProperty('email')

    const missingPhone = variants.find((v) => v.name === 'missing-field:customer.phone')!
    const body = missingPhone.body as Record<string, unknown>
    expect(body.customer).toEqual({})
  })

  it('does not mutate the baseline object across variants (each variant is an independent clone)', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const baseline = variants[0]!.body as Record<string, unknown>
    const missing = variants.find((v) => v.name === 'missing-field:email')!.body as Record<string, unknown>
    expect(baseline.email).toBe('test-email')
    expect(missing).not.toHaveProperty('email')
  })

  it('generates a null-field variant with the field set to null, not removed', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const nullVariant = variants.find((v) => v.name === 'null-field:email')!
    expect((nullVariant.body as Record<string, unknown>).email).toBeNull()
  })

  it('generates a wrong-type-field variant that flips a string field to a number', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const wrongType = variants.find((v) => v.name === 'wrong-type-field:email')!
    expect(typeof (wrongType.body as Record<string, unknown>).email).toBe('number')
  })

  it('generates an empty-string-field variant', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const emptyString = variants.find((v) => v.name === 'empty-string-field:email')!
    expect((emptyString.body as Record<string, unknown>).email).toBe('')
  })

  it('generates an oversized-field variant with a very large string', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const oversized = variants.find((v) => v.name === 'oversized-field:email')!
    const value = (oversized.body as Record<string, unknown>).email as string
    expect(value.length).toBe(100_000)
  })

  it('generates a unicode-field variant', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const unicode = variants.find((v) => v.name === 'unicode-field:email')!
    expect((unicode.body as Record<string, unknown>).email).toContain('🎉')
  })

  it('generates an injection-shaped-field variant carrying SQL/expression/script-shaped strings', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const injection = variants.find((v) => v.name === 'injection-shaped-field:email')!
    const value = (injection.body as Record<string, unknown>).email as string
    expect(value).toContain('DROP TABLE')
    expect(value).toContain('{{ 1+1 }}')
    expect(value).toContain('<script>')
  })

  it('includes structural variants: empty-body, array-where-object-expected, proto-pollution-shaped-keys', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    const names = variants.map((v) => v.name)
    expect(names).toContain('empty-body')
    expect(names).toContain('array-where-object-expected')
    expect(names).toContain('proto-pollution-shaped-keys')

    const emptyBody = variants.find((v) => v.name === 'empty-body')!
    expect(emptyBody.body).toEqual({})

    const arrayVariant = variants.find((v) => v.name === 'array-where-object-expected')!
    expect(Array.isArray(arrayVariant.body)).toBe(true)
  })

  it('every variant carries a non-empty rationale', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: '={{$json.body.email}}' } })])
    const variants = generateChaosPayloads(workflow)
    for (const v of variants) {
      expect(v.rationale.length).toBeGreaterThan(0)
    }
  })

  it('produces only the baseline plus structural variants when the workflow references no body fields', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { a: 'no expressions here' } })])
    const variants = generateChaosPayloads(workflow)
    const names = variants.map((v) => v.name)
    expect(names).toEqual(['valid-baseline', 'empty-body', 'array-where-object-expected', 'proto-pollution-shaped-keys'])
  })

  it('handles multiple referenced fields independently, generating a full family per field', () => {
    const workflow = makeWorkflow([
      makeNode({ parameters: { a: '={{$json.body.email}}, {{$json.body.name}}' } }),
    ])
    const variants = generateChaosPayloads(workflow)
    const perFieldFamilies = ['missing-field', 'null-field', 'wrong-type-field', 'empty-string-field', 'oversized-field', 'unicode-field', 'injection-shaped-field']
    for (const family of perFieldFamilies) {
      expect(variants.map((v) => v.name)).toContain(`${family}:email`)
      expect(variants.map((v) => v.name)).toContain(`${family}:name`)
    }
  })
})
