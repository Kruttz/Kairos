import { describe, it, expect } from 'vitest'
import { N8nValidator } from '../../../src/validation/validator.js'
import type { N8nWorkflow } from '../../../src/types/workflow.js'

const baseWorkflow = (): N8nWorkflow => ({
  name: 'Test Workflow',
  nodes: [
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [250, 300],
      parameters: {},
    },
  ],
  connections: {},
  settings: {
    saveExecutionProgress: true,
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    executionTimeout: 3600,
    timezone: 'America/New_York',
    executionOrder: 'v1',
  },
})

describe('N8nValidator', () => {
  const validator = new N8nValidator()

  it('passes a valid minimal workflow', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.valid).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  // Rule 1
  it('rule 1: fails when name is empty', () => {
    const w = { ...baseWorkflow(), name: '' }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 1)).toBe(true)
  })

  it('rule 1: fails when name is missing', () => {
    const w = { ...baseWorkflow(), name: '   ' }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
  })

  // Rule 2
  it('rule 2: fails when nodes is empty array', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 2)).toBe(true)
  })

  // Rule 3
  it('rule 3: fails when node id is empty', () => {
    const w = baseWorkflow()
    w.nodes[0]!.id = ''
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 3)).toBe(true)
  })

  // Rule 4
  it('rule 4: fails on duplicate node ids', () => {
    const w = baseWorkflow()
    w.nodes.push({ ...w.nodes[0]!, name: 'Duplicate' })
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 4)).toBe(true)
  })

  // Rule 5
  it('rule 5: fails when node type is empty', () => {
    const w = baseWorkflow()
    w.nodes[0]!.type = ''
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 5)).toBe(true)
  })

  // Rule 6
  it('rule 6: fails when typeVersion is zero', () => {
    const w = baseWorkflow()
    w.nodes[0]!.typeVersion = 0
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 6)).toBe(true)
  })

  // Rule 7
  it('rule 7: fails when position is not [x, y]', () => {
    const w = baseWorkflow()
    w.nodes[0]!.position = [250] as unknown as [number, number]
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 7)).toBe(true)
  })

  // Rule 8
  it('rule 8: fails when node name is empty', () => {
    const w = baseWorkflow()
    w.nodes[0]!.name = ''
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 8)).toBe(true)
  })

  // Rule 9
  it('rule 9: fails when connections is not an object', () => {
    const w = { ...baseWorkflow(), connections: null as unknown as N8nWorkflow['connections'] }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 9)).toBe(true)
  })

  // Rule 10
  it('rule 10: fails when connection target does not exist', () => {
    const w = baseWorkflow()
    w.connections['Manual Trigger'] = {
      main: [[{ node: 'NonExistentNode', type: 'main', index: 0 }]],
    }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 10)).toBe(true)
  })

  it('rule 10: passes when connection target exists', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
      name: 'Set Data',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [470, 300],
      parameters: {},
    })
    w.connections['Manual Trigger'] = {
      main: [[{ node: 'Set Data', type: 'main', index: 0 }]],
    }
    const result = validator.validate(w)
    expect(result.valid).toBe(true)
  })

  // Rule 11 (warn)
  it('rule 11: warns on orphaned non-trigger node', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'deadbeef-dead-4eef-dead-beefdeadbeef',
      name: 'Orphan Node',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [500, 300],
      parameters: {},
    })
    const result = validator.validate(w)
    expect(result.valid).toBe(true) // warns, doesn't fail
    expect(result.issues.some((i) => i.rule === 11 && i.severity === 'warn')).toBe(true)
  })

  // Rule 12
  it('rule 12: fails when forbidden field "id" is present', () => {
    const w = { ...baseWorkflow(), id: 'some-server-id' } as unknown as N8nWorkflow
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 12)).toBe(true)
  })

  it('rule 12: fails when forbidden field "createdAt" is present', () => {
    const w = { ...baseWorkflow(), createdAt: '2024-01-01' } as unknown as N8nWorkflow
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 12)).toBe(true)
  })

  // Rule 13
  it('rule 13: fails when settings is an array', () => {
    const w = { ...baseWorkflow(), settings: [] as unknown as N8nWorkflow['settings'] }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 13)).toBe(true)
  })

  // Rule 14
  it('rule 14: fails when no trigger node present', () => {
    const w = baseWorkflow()
    w.nodes[0]!.type = 'n8n-nodes-base.set'
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 14)).toBe(true)
  })

  // Rule 15
  it('rule 15: fails when node type has invalid format', () => {
    const w = baseWorkflow()
    w.nodes[0]!.type = 'invalidType'
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 15)).toBe(true)
  })

  it('rule 15: passes valid scoped package type', () => {
    const w = baseWorkflow()
    w.nodes[0]!.type = '@n8n/n8n-nodes-langchain.agent'
    const result = validator.validate(w)
    const rule15 = result.issues.filter((i) => i.rule === 15)
    expect(rule15).toHaveLength(0)
  })

  // Rule 16
  it('rule 16: fails on duplicate node names', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [500, 300],
      parameters: {},
    })
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 16)).toBe(true)
  })

  // Rule 17
  it('rule 17: fails when credential entry is missing id', () => {
    const w = baseWorkflow()
    w.nodes[0]!.credentials = {
      openAiApi: { id: '', name: 'OpenAI' },
    }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 17)).toBe(true)
  })

  it('rule 17: passes valid credential entry', () => {
    const w = baseWorkflow()
    w.nodes[0]!.credentials = {
      openAiApi: { id: 'abc123', name: 'OpenAI account' },
    }
    const result = validator.validate(w)
    const rule17 = result.issues.filter((i) => i.rule === 17)
    expect(rule17).toHaveLength(0)
  })

  // Rule 18 (warn) — agent node appearing as SOURCE of ai_ connection (backwards direction)
  it('rule 18: warns when agent node is source of ai_ connection', () => {
    const w = baseWorkflow()
    // Keep manualTrigger as node[0] so rule 14 passes
    // Add an agent node that (incorrectly) appears as source
    w.nodes.push({
      id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'AI Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 1.9,
      position: [470, 300],
      parameters: {},
    })
    w.nodes.push({
      id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      name: 'OpenAI Model',
      type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
      typeVersion: 1.7,
      position: [470, 500],
      parameters: {},
    })
    // Connect trigger to agent on main
    w.connections['Manual Trigger'] = {
      main: [[{ node: 'AI Agent', type: 'main', index: 0 }]],
    }
    // Incorrectly put agent as source of ai_languageModel (should be OpenAI Model → AI Agent)
    w.connections['AI Agent'] = {
      ai_languageModel: [[{ node: 'OpenAI Model', type: 'ai_languageModel', index: 0 }]],
    }
    const result = validator.validate(w)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.rule === 18 && i.severity === 'error')).toBe(true)
  })

  // Rule 19 (warn)
  it('rule 19: warns on unsafe typeVersion for known node', () => {
    const w = baseWorkflow()
    w.nodes[0]!.typeVersion = 99
    const result = validator.validate(w)
    expect(result.valid).toBe(true) // only a warning
    expect(result.issues.some((i) => i.rule === 19 && i.severity === 'warn')).toBe(true)
  })

  it('rule 19: passes for unknown node type (does not block)', () => {
    const w = baseWorkflow()
    w.nodes[0]!.type = 'n8n-nodes-base.unknownCustomNode'
    w.nodes[0]!.typeVersion = 5
    const result = validator.validate(w)
    const rule19 = result.issues.filter((i) => i.rule === 19)
    expect(rule19).toHaveLength(0)
  })

  // Rule 20 (warn): cycle detection
  it('rule 20: warns on connection cycle', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Step A', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [470, 300], parameters: {} },
      { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', name: 'Step B', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [690, 300], parameters: {} },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Step A', type: 'main', index: 0 }]] }
    w.connections['Step A'] = { main: [[{ node: 'Step B', type: 'main', index: 0 }]] }
    w.connections['Step B'] = { main: [[{ node: 'Step A', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 20 && i.severity === 'warn')).toBe(true)
  })

  it('rule 20: passes on acyclic workflow', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Step A', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [470, 300], parameters: {} },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Step A', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 20)).toHaveLength(0)
  })

  // Rule 21 (warn): webhook + respondToWebhook
  it('rule 21: warns when webhook uses responseNode but no respondToWebhook exists', () => {
    const w = baseWorkflow()
    w.nodes[0] = {
      id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: { httpMethod: 'POST', path: '/test', responseMode: 'responseNode' },
    }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 21)).toBe(true)
  })

  it('rule 21: passes when respondToWebhook exists', () => {
    const w = baseWorkflow()
    w.nodes[0] = {
      id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: { httpMethod: 'POST', path: '/test', responseMode: 'responseNode' },
    }
    w.nodes.push({
      id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
      name: 'Respond to Webhook',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [470, 300],
      parameters: {},
    })
    w.connections['Webhook'] = { main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 21)).toHaveLength(0)
  })

  // Rule 22 (warn): required params
  it('rule 22: warns when webhook missing required params', () => {
    const w = baseWorkflow()
    w.nodes[0] = {
      id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: {},
    }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 22).length).toBeGreaterThanOrEqual(1)
  })

  // Rule 23 (warn): unknown node types
  it('rule 23: warns on unknown node types not in registry', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
      name: 'Fake Node',
      type: 'n8n-nodes-base.totallyFakeNode',
      typeVersion: 1,
      position: [450, 300],
      parameters: {},
    })
    const result = validator.validate(w)
    const rule23 = result.issues.filter((i) => i.rule === 23)
    expect(rule23.length).toBe(1)
    expect(rule23[0]!.severity).toBe('warn')
    expect(rule23[0]!.message).toContain('totallyFakeNode')
  })

  it('rule 23: does not warn on known node types', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
      name: 'Slack',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2,
      position: [450, 300],
      parameters: {},
    })
    const result = validator.validate(w)
    const rule23 = result.issues.filter((i) => i.rule === 23)
    expect(rule23.length).toBe(0)
  })

  // Rule 24: deprecated accessor syntax
  it('rule 24: warns on deprecated $node["..."] accessor', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa1111-bbbb-4ccc-dddd-eeeeeeee0024',
      name: 'Set Data',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: {
        assignments: {
          assignments: [{
            id: 'a1',
            name: 'result',
            value: '={{ $node["Manual Trigger"].json.data }}',
            type: 'string',
          }],
        },
      },
    })
    w.connections = {
      'Manual Trigger': { main: [[{ node: 'Set Data', type: 'main', index: 0 }]] },
    }
    const result = validator.validate(w)
    const rule24 = result.issues.filter(i => i.rule === 24)
    expect(rule24.length).toBe(1)
    expect(rule24[0]!.message).toContain('deprecated accessor')
  })

  it('rule 24: does not warn on modern accessor syntax', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa1111-bbbb-4ccc-dddd-eeeeeeee0024',
      name: 'Set Data',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: {
        assignments: {
          assignments: [{
            id: 'a1',
            name: 'result',
            value: "={{ $('Manual Trigger').first().json.data }}",
            type: 'string',
          }],
        },
      },
    })
    w.connections = {
      'Manual Trigger': { main: [[{ node: 'Set Data', type: 'main', index: 0 }]] },
    }
    const result = validator.validate(w)
    const rule24 = result.issues.filter(i => i.rule === 24)
    expect(rule24.length).toBe(0)
  })

  // Rule 25: wrong item index assumptions
  it('rule 25: warns on $json.items[n] access', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa1111-bbbb-4ccc-dddd-eeeeeeee0025',
      name: 'Set Data',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: {
        assignments: {
          assignments: [{
            id: 'a1',
            name: 'result',
            value: '={{ $json.items[0].name }}',
            type: 'string',
          }],
        },
      },
    })
    w.connections = {
      'Manual Trigger': { main: [[{ node: 'Set Data', type: 'main', index: 0 }]] },
    }
    const result = validator.validate(w)
    const rule25 = result.issues.filter(i => i.rule === 25)
    expect(rule25.length).toBe(1)
  })

  it('rule 25: does not warn on direct $json.field access', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa1111-bbbb-4ccc-dddd-eeeeeeee0025',
      name: 'Set Data',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: {
        assignments: {
          assignments: [{
            id: 'a1',
            name: 'result',
            value: '={{ $json.name }}',
            type: 'string',
          }],
        },
      },
    })
    w.connections = {
      'Manual Trigger': { main: [[{ node: 'Set Data', type: 'main', index: 0 }]] },
    }
    const result = validator.validate(w)
    const rule25 = result.issues.filter(i => i.rule === 25)
    expect(rule25.length).toBe(0)
  })

  // Rule 26: missing .first() or .all()
  it('rule 26: warns on bare $("NodeName").json without .first()/.all()', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa1111-bbbb-4ccc-dddd-eeeeeeee0026',
      name: 'Set Data',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: {
        assignments: {
          assignments: [{
            id: 'a1',
            name: 'result',
            value: "={{ $('Manual Trigger').json.data }}",
            type: 'string',
          }],
        },
      },
    })
    w.connections = {
      'Manual Trigger': { main: [[{ node: 'Set Data', type: 'main', index: 0 }]] },
    }
    const result = validator.validate(w)
    const rule26 = result.issues.filter(i => i.rule === 26)
    expect(rule26.length).toBe(1)
    expect(rule26[0]!.message).toContain('.first()')
  })

  it('rule 26: does not warn when .first() is used', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa1111-bbbb-4ccc-dddd-eeeeeeee0026',
      name: 'Set Data',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: {
        assignments: {
          assignments: [{
            id: 'a1',
            name: 'result',
            value: "={{ $('Manual Trigger').first().json.data }}",
            type: 'string',
          }],
        },
      },
    })
    w.connections = {
      'Manual Trigger': { main: [[{ node: 'Set Data', type: 'main', index: 0 }]] },
    }
    const result = validator.validate(w)
    const rule26 = result.issues.filter(i => i.rule === 26)
    expect(rule26.length).toBe(0)
  })

  // A-2: nodeType enrichment
  it('enriches issues with nodeType from workflow nodes', () => {
    const w = baseWorkflow()
    const slackId = 'aaaa1111-bbbb-4ccc-dddd-eeeeeeee0001'
    w.nodes.push({
      id: slackId,
      name: 'Slack',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2,
      position: [450, 300],
      parameters: {},
      credentials: { slackApi: { id: '1', name: 'Slack' } },
    })
    // Remove connections so Slack is disconnected → triggers rule 7
    w.connections = {}
    const result = validator.validate(w)
    const slackIssue = result.issues.find(i => i.nodeId === slackId)
    expect(slackIssue).toBeDefined()
    expect(slackIssue!.nodeType).toBe('n8n-nodes-base.slack')
  })
})
