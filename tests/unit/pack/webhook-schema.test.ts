import { describe, it, expect } from 'vitest'
import { extractWebhookFieldRefs, generateTestPayload, generateOpenApiContract } from '../../../src/pack/webhook-schema.js'
import type { N8nWorkflow, N8nNode } from '../../../src/types/workflow.js'

function makeNode(overrides: Partial<N8nNode> = {}): N8nNode {
  return {
    id: 'n1', name: 'Node', type: 'n8n-nodes-base.set', typeVersion: 1, position: [0, 0], parameters: {},
    ...overrides,
  }
}

function makeWorkflow(nodes: N8nNode[]): N8nWorkflow {
  return { name: 'Test Workflow', nodes, connections: {} }
}

describe('extractWebhookFieldRefs', () => {
  it('captures a nested body path (regression: single-level extractors miss this)', () => {
    const workflow = makeWorkflow([
      makeNode({ parameters: { value: '={{$json.body.customer.email}}' } }),
    ])
    const refs = extractWebhookFieldRefs(workflow)
    expect(refs.body).toEqual(['customer.email'])
  })

  it('captures a single-level body path (no regression on the simple case)', () => {
    const workflow = makeWorkflow([
      makeNode({ parameters: { value: '={{$json.body.email}}' } }),
    ])
    const refs = extractWebhookFieldRefs(workflow)
    expect(refs.body).toEqual(['email'])
  })

  it('captures query and header roots separately', () => {
    const workflow = makeWorkflow([
      makeNode({ parameters: { a: '={{$json.query.utm_source}}', b: '={{$json.headers.x-signature}}' } }),
    ])
    const refs = extractWebhookFieldRefs(workflow)
    expect(refs.query).toEqual(['utm_source'])
    expect(refs.headers).toEqual(['x-signature'])
  })

  it('deduplicates and sorts, and scans every node not just the trigger', () => {
    const workflow = makeWorkflow([
      makeNode({ id: 'n1', parameters: { a: '={{$json.body.zebra}}' } }),
      makeNode({ id: 'n2', parameters: { b: '={{$json.body.apple}}, {{$json.body.zebra}}' } }),
    ])
    const refs = extractWebhookFieldRefs(workflow)
    expect(refs.body).toEqual(['apple', 'zebra'])
  })

  it('returns empty arrays when there are no $json.body/query/headers references', () => {
    const workflow = makeWorkflow([makeNode({ parameters: { value: 'no expressions here' } })])
    const refs = extractWebhookFieldRefs(workflow)
    expect(refs).toEqual({ body: [], query: [], headers: [] })
  })
})

describe('generateTestPayload', () => {
  it('returns null for a workflow with no webhook trigger', () => {
    const workflow = makeWorkflow([makeNode({ type: 'n8n-nodes-base.manualTrigger' })])
    expect(generateTestPayload(workflow)).toBeNull()
  })

  it('returns url/method and the mandatory disclaimer even with zero downstream references', () => {
    const workflow = makeWorkflow([
      makeNode({ type: 'n8n-nodes-base.webhook', parameters: { path: 'intake', httpMethod: 'POST' } }),
    ])
    const payload = generateTestPayload(workflow)
    expect(payload).not.toBeNull()
    expect(payload!.url).toBe('intake')
    expect(payload!.method).toBe('POST')
    expect(payload!.note).toContain('best-effort guess')
    expect(payload!.sampleBody).toBeUndefined()
  })

  it('builds a nested sampleBody with name-based placeholder guesses', () => {
    const workflow = makeWorkflow([
      makeNode({ type: 'n8n-nodes-base.webhook', parameters: { path: 'referrals', httpMethod: 'POST' } }),
      makeNode({ parameters: { a: '={{$json.body.customer.email}}, {{$json.body.customer.phone}}, {{$json.body.referralId}}' } }),
    ])
    const payload = generateTestPayload(workflow)
    expect(payload!.sampleBody).toEqual({
      customer: { email: 'test@example.com', phone: '555-0100' },
      referralId: 'example-id-123',
    })
  })

  it('builds flat (non-nested) sampleQuery and sampleHeaders', () => {
    const workflow = makeWorkflow([
      makeNode({ type: 'n8n-nodes-base.webhook', parameters: { path: 'x', httpMethod: 'GET' } }),
      makeNode({ parameters: { a: '={{$json.query.name}}', b: '={{$json.headers.x-api-key}}' } }),
    ])
    const payload = generateTestPayload(workflow)
    expect(payload!.sampleQuery).toEqual({ name: 'Jane Doe' })
    expect(payload!.sampleHeaders).toEqual({ 'x-api-key': 'example value' })
  })
})

describe('generateOpenApiContract', () => {
  it('returns null for a workflow with no webhook trigger', () => {
    const workflow = makeWorkflow([makeNode({ type: 'n8n-nodes-base.manualTrigger' })])
    expect(generateOpenApiContract(workflow)).toBeNull()
  })

  it('builds a minimal valid document with the correct path/method, marked as heuristic', () => {
    const workflow = makeWorkflow([
      makeNode({ type: 'n8n-nodes-base.webhook', parameters: { path: 'referrals', httpMethod: 'POST' } }),
    ])
    const spec = generateOpenApiContract(workflow)
    expect(spec).not.toBeNull()
    expect(spec!.openapi).toBe('3.0.3')
    expect(spec!.info['x-kairos-generated']).toBe('heuristic')
    expect(spec!.info.description).toContain('best-effort guess')
    expect(spec!.paths['/referrals']!.post).toBeDefined()
    expect(spec!.paths['/referrals']!.post!.responses['200'].description).toContain('not inferred')
  })

  it('places body fields as a nested requestBody schema, all typed string', () => {
    const workflow = makeWorkflow([
      makeNode({ type: 'n8n-nodes-base.webhook', parameters: { path: 'x', httpMethod: 'POST' } }),
      makeNode({ parameters: { a: '={{$json.body.customer.email}}, {{$json.body.referralId}}' } }),
    ])
    const spec = generateOpenApiContract(workflow)
    const schema = spec!.paths['/x']!.post!.requestBody!.content['application/json'].schema
    expect(schema.type).toBe('object')
    expect(schema.properties).toEqual({
      customer: { type: 'object', properties: { email: { type: 'string' } } },
      referralId: { type: 'string' },
    })
  })

  it('places query fields as `in: query` parameters and header fields as `in: header`, both required: false', () => {
    const workflow = makeWorkflow([
      makeNode({ type: 'n8n-nodes-base.webhook', parameters: { path: 'x', httpMethod: 'GET' } }),
      makeNode({ parameters: { a: '={{$json.query.utm_source}}', b: '={{$json.headers.x-signature}}' } }),
    ])
    const spec = generateOpenApiContract(workflow)
    const params = spec!.paths['/x']!.get!.parameters!
    expect(params).toContainEqual({ name: 'utm_source', in: 'query', required: false, schema: { type: 'string' } })
    expect(params).toContainEqual({ name: 'x-signature', in: 'header', required: false, schema: { type: 'string' } })
  })

  it('produces a valid minimal document with no fields at all (no requestBody, no parameters)', () => {
    const workflow = makeWorkflow([makeNode({ type: 'n8n-nodes-base.webhook', parameters: { path: 'x', httpMethod: 'POST' } })])
    const spec = generateOpenApiContract(workflow)
    const operation = spec!.paths['/x']!.post!
    expect(operation.requestBody).toBeUndefined()
    expect(operation.parameters).toBeUndefined()
    expect(operation.responses['200']).toBeDefined()
  })
})
