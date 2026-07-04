import { describe, it, expect } from 'vitest'
import { N8nValidator } from '../../../src/validation/validator.js'
import { RULE_EXAMPLES } from '../../../src/validation/rule-metadata.js'
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
  it('rule 19: lenient mode (default) does NOT warn on typeVersions higher than known max', () => {
    // typeVersion 99 for a known node is treated as "newer release" in lenient mode
    delete process.env['KAIROS_REGISTRY_STRICT']
    const w = baseWorkflow()
    w.nodes[0]!.typeVersion = 99
    const result = validator.validate(w)
    expect(result.valid).toBe(true)
    expect(result.issues.some((i) => i.rule === 19)).toBe(false)
  })

  it('rule 19: strict mode warns on typeVersion not in known safe list', () => {
    process.env['KAIROS_REGISTRY_STRICT'] = 'true'
    try {
      const w = baseWorkflow()
      w.nodes[0]!.typeVersion = 99
      const result = validator.validate(w)
      expect(result.valid).toBe(true) // only a warning
      expect(result.issues.some((i) => i.rule === 19 && i.severity === 'warn')).toBe(true)
    } finally {
      delete process.env['KAIROS_REGISTRY_STRICT']
    }
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

  // Rule 11 — AI sub-nodes should not be flagged as unreachable
  it('rule 11: does not warn on AI sub-nodes that are sources of ai_* connections', () => {
    const w = baseWorkflow()
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
    w.connections['Manual Trigger'] = {
      main: [[{ node: 'AI Agent', type: 'main', index: 0 }]],
    }
    // Correct direction: model sub-node sources the ai_languageModel connection
    w.connections['OpenAI Model'] = {
      ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]],
    }
    const result = validator.validate(w)
    const rule11Issues = result.issues.filter(i => i.rule === 11)
    // OpenAI Model is an ai_* source — should NOT get Rule 11 warning
    expect(rule11Issues.some(i => i.message.includes('OpenAI Model'))).toBe(false)
  })

  // Regression guards: RULE_EXAMPLES "bad" snippets must trigger their rule (reverse guards)
  it('RULE_EXAMPLES[17] bad snippet triggers rule 17 (credential shape reverse guard)', () => {
    const badSnippet = RULE_EXAMPLES[17]!.bad
    // badSnippet: '"credentials": { "slackOAuth2Api": "my-token" }'
    const credJsonStr = badSnippet.replace(/^"credentials":\s*/, '')
    const credentials = JSON.parse(credJsonStr) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes[0]!.credentials = credentials
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 17)).toHaveLength(1)
  })

  it('RULE_EXAMPLES[24] bad snippet triggers rule 24 (expression accessor reverse guard)', () => {
    // Wrap in ={{ }} — how expressions appear in real n8n parameters
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0024-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Set R24',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: { value: `={{ ${RULE_EXAMPLES[24]!.bad} }}` },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set R24', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 24)).toBe(true)
  })

  it('RULE_EXAMPLES[25] bad snippet triggers rule 25 (items index reverse guard)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0025-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Set R25',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: { value: `={{ ${RULE_EXAMPLES[25]!.bad} }}` },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set R25', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 25)).toBe(true)
  })

  it('RULE_EXAMPLES[26] bad snippet triggers rule 26 (bare accessor reverse guard)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0026-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Set R26',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: { value: `={{ ${RULE_EXAMPLES[26]!.bad} }}` },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set R26', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 26)).toBe(true)
  })

  it('RULE_EXAMPLES[27] bad snippet triggers rule 27 (httpRequest URL reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[27]!.bad}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0027-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'HTTP Bad',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 27)).toBe(true)
  })

  it('RULE_EXAMPLES[28] bad snippet triggers rule 28 (code node reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[28]!.bad}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0028-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Code Bad',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 28)).toBe(true)
  })

  it('RULE_EXAMPLES[29] bad snippet triggers rule 29 (slack channel reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[29]!.bad}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0029-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Slack Bad',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: { resource: 'message', operation: 'post', ...params },
      credentials: { slackOAuth2Api: { id: 'c1', name: 'Slack' } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 29)).toBe(true)
  })

  it('RULE_EXAMPLES[30] bad snippet triggers rule 30 (gmail recipient reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[30]!.bad}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0030-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Gmail Bad',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [450, 300],
      parameters: params,
      credentials: { gmailOAuth2: { id: 'c1', name: 'Gmail' } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 30)).toBe(true)
  })

  it('RULE_EXAMPLES[31] bad snippet triggers rule 31 (if conditions reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[31]!.bad}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0031-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Check Bad',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 31)).toBe(true)
  })

  it('RULE_EXAMPLES[32] bad snippet triggers rule 32 (set assignments reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[32]!.bad}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0032-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Set Bad',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 32)).toBe(true)
  })

  it('RULE_EXAMPLES[33] bad snippet triggers rule 33 (scheduleTrigger reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[33]!.bad}}`) as Record<string, unknown>
    const w = { ...baseWorkflow(), nodes: [] as N8nWorkflow['nodes'], connections: {} }
    w.nodes.push({
      id: 'aaaa0033-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Schedule Bad',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [250, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 33)).toBe(true)
  })

  it('RULE_EXAMPLES[34] bad snippet triggers rule 34 (webhook path reverse guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[34]!.bad}}`) as Record<string, unknown>
    const w = { ...baseWorkflow(), nodes: [] as N8nWorkflow['nodes'], connections: {} }
    w.nodes.push({
      id: 'aaaa0034-aaaa-4aaa-aaaa-aaaaaaaaabbb',
      name: 'Webhook Bad',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 34)).toBe(true)
  })

  it('RULE_EXAMPLES[126] bad snippet triggers rule 126 (node ID reverse guard)', () => {
    const parsed = JSON.parse(`{${RULE_EXAMPLES[126]!.bad}}`) as { id: string }
    const w = baseWorkflow()
    w.nodes[0]!.id = parsed.id
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 126)).toBe(true)
  })

  // Regression guard: RULE_EXAMPLES "good" snippets must themselves pass validation
  it('RULE_EXAMPLES[17] good snippet passes rule 17 (credential shape regression guard)', () => {
    const goodSnippet = RULE_EXAMPLES[17]!.good
    // goodSnippet: '"credentials": { "slackOAuth2Api": { "id": "placeholder-id", "name": "..." } }'
    const credJsonStr = goodSnippet.replace(/^"credentials":\s*/, '')
    const credentials = JSON.parse(credJsonStr) as Record<string, { id: string; name: string }>
    const w = baseWorkflow()
    w.nodes[0]!.credentials = credentials
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 17)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[27] good snippet passes rule 27 (httpRequest URL regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[27]!.good}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0027-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'HTTP Guard',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: params,
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP Guard', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 27)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[28] good snippet passes rule 28 (code node regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[28]!.good}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0028-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Code Guard',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: params,
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code Guard', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 28)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[29] good snippet passes rule 29 (slack channel regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[29]!.good}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0029-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Slack Guard',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: { resource: 'message', operation: 'post', ...params },
      credentials: { slackOAuth2Api: { id: 'cred-1', name: 'Slack' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Slack Guard', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 29)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[30] good snippet passes rule 30 (gmail recipient regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[30]!.good}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0030-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Gmail Guard',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [450, 300],
      parameters: params,
      credentials: { gmailOAuth2: { id: 'cred-1', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Gmail Guard', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 30)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[31] good snippet passes rule 31 (if conditions regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[31]!.good}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0031-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Check Guard',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: params,
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Check Guard', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 31)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[32] good snippet passes rule 32 (set assignments regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[32]!.good}}`) as Record<string, unknown>
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0032-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Set Guard',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: params,
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set Guard', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 32)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[33] good snippet passes rule 33 (scheduleTrigger regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[33]!.good}}`) as Record<string, unknown>
    const w = { ...baseWorkflow(), nodes: [] as N8nWorkflow['nodes'], connections: {} }
    w.nodes.push({
      id: 'aaaa0033-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Schedule Guard',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [250, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 33)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[34] good snippet passes rule 34 (webhook path regression guard)', () => {
    const params = JSON.parse(`{${RULE_EXAMPLES[34]!.good}}`) as Record<string, unknown>
    const w = { ...baseWorkflow(), nodes: [] as N8nWorkflow['nodes'], connections: {} }
    w.nodes.push({
      id: 'aaaa0034-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Webhook Guard',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: params,
    })
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 34)).toHaveLength(0)
  })

  it('RULE_EXAMPLES[126] good snippet passes rule 126 (node ID regression guard)', () => {
    const parsed = JSON.parse(`{${RULE_EXAMPLES[126]!.good}}`) as { id: string }
    const w = baseWorkflow()
    w.nodes[0]!.id = parsed.id
    const result = validator.validate(w)
    expect(result.issues.filter((i) => i.rule === 126)).toHaveLength(0)
  })

  // Rule 27: httpRequest URL placeholders
  it('rule 27: warns when httpRequest URL is example.com', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0027-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'HTTP',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://example.com/api/data' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 27)).toBe(true)
  })

  it('rule 27: warns when httpRequest URL contains YOUR_URL', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0027-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'HTTP',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'YOUR_URL_HERE' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 27)).toBe(true)
  })

  it('rule 27: does not warn on a real URL', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0027-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'HTTP',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.openai.com/v1/chat/completions' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 27)).toBe(false)
  })

  // Rule 28: code node empty or comment-only
  it('rule 28: warns on code node with empty jsCode', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0028-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Run Code',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: '' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 28)).toBe(true)
  })

  it('rule 28: warns on code node with only comments', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0028-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Run Code',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: '// TODO: add logic here\n// placeholder' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 28)).toBe(true)
  })

  it('rule 28: does not warn when code has actual logic', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0028-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Run Code',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: 'return items.map(i => ({ json: { result: i.json.value * 2 } }))' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Run Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 28)).toBe(false)
  })

  // Rule 29: slack missing channel
  it('rule 29: warns when Slack message has no channel', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0029-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Slack',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: { resource: 'message', operation: 'post' },
      credentials: { slackOAuth2Api: { id: 'cred-1', name: 'Slack' } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 29)).toBe(true)
  })

  it('rule 29: does not warn when Slack message has channelId', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0029-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Slack',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: {
        resource: 'message',
        operation: 'post',
        channelId: { __rl: true, mode: 'name', value: '#general' },
      },
      credentials: { slackOAuth2Api: { id: 'cred-1', name: 'Slack' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Slack', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 29)).toBe(false)
  })

  // Rule 30: gmail missing recipient
  it('rule 30: warns when gmail send has no recipient', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0030-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Gmail',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [450, 300],
      parameters: { resource: 'message', operation: 'send' },
      credentials: { gmailOAuth2: { id: 'cred-1', name: 'Gmail' } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 30)).toBe(true)
  })

  it('rule 30: does not warn when gmail send has a recipient', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0030-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Gmail',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [450, 300],
      parameters: { resource: 'message', operation: 'send', to: 'user@example.com' },
      credentials: { gmailOAuth2: { id: 'cred-1', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Gmail', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 30)).toBe(false)
  })

  it('rule 30: does not warn for non-send gmail operations', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0030-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Gmail',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [450, 300],
      parameters: { resource: 'message', operation: 'get' },
      credentials: { gmailOAuth2: { id: 'cred-1', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Gmail', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 30)).toBe(false)
  })

  // Rule 31: if node empty conditions
  it('rule 31: warns when if node has no conditions object', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0031-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Check',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: {},
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 31)).toBe(true)
  })

  it('rule 31: warns when if node conditions.conditions is empty', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0031-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Check',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: { conditions: { combinator: 'and', conditions: [] } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 31)).toBe(true)
  })

  it('rule 31: does not warn when if node has conditions', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0031-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Check',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ id: 'c1', leftValue: '={{ $json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }],
        },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Check', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 31)).toBe(false)
  })

  // Rule 32: set node no assignments
  it('rule 32: warns when set node has no assignments', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0032-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Set Fields',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: { assignments: { assignments: [] } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 32)).toBe(true)
  })

  it('rule 32: does not warn when set node has assignments', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0032-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Set Fields',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [450, 300],
      parameters: {
        assignments: {
          assignments: [{ id: 'a1', name: 'status', value: 'active', type: 'string' }],
        },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set Fields', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 32)).toBe(false)
  })

  // Rule 33: scheduleTrigger no rules
  it('rule 33: warns when scheduleTrigger has no rule.interval', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    w.nodes.push({
      id: 'aaaa0033-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Schedule',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [250, 300],
      parameters: {},
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 33)).toBe(true)
  })

  it('rule 33: warns when scheduleTrigger rule.interval is empty', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    w.nodes.push({
      id: 'aaaa0033-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Schedule',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [250, 300],
      parameters: { rule: { interval: [] } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 33)).toBe(true)
  })

  it('rule 33: does not warn when scheduleTrigger has a schedule rule', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    w.nodes.push({
      id: 'aaaa0033-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Schedule',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [250, 300],
      parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 33)).toBe(false)
  })

  // Rule 34: webhook path issues
  it('rule 34: warns when webhook path contains spaces', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    w.nodes.push({
      id: 'aaaa0034-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: { httpMethod: 'POST', path: 'my webhook path' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 34)).toBe(true)
  })

  it('rule 34: warns when webhook path starts with slash', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    w.nodes.push({
      id: 'aaaa0034-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: { httpMethod: 'POST', path: '/my-hook' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 34)).toBe(true)
  })

  it('rule 34: warns when webhook path looks like a full URL', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    w.nodes.push({
      id: 'aaaa0034-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: { httpMethod: 'POST', path: 'https://example.com/my-hook' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 34)).toBe(true)
  })

  it('rule 34: does not warn on a valid relative webhook path', () => {
    const w = { ...baseWorkflow(), nodes: [] }
    w.nodes.push({
      id: 'aaaa0034-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [250, 300],
      parameters: { httpMethod: 'POST', path: 'my-webhook-handler' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 34)).toBe(false)
  })

  // Rule 35 — email-sending node with no duplicate-prevention signal
  it('rule 35: warns when Gmail send node has no idempotency signal', () => {
    const w = { ...baseWorkflow(), nodes: [...baseWorkflow().nodes] }
    w.nodes.push({
      id: 'aaaa0035-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2,
      position: [500, 300],
      parameters: { operation: 'send', to: 'customer@example.com', subject: 'Hello' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 35)).toBe(true)
    const issue = result.issues.find((i) => i.rule === 35)!
    expect(issue.severity).toBe('warn')
  })

  it('rule 35: warns for emailSend node with no idempotency signal', () => {
    const w = { ...baseWorkflow(), nodes: [...baseWorkflow().nodes] }
    w.nodes.push({
      id: 'aaaa0035-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Email Send',
      type: 'n8n-nodes-base.emailSend',
      typeVersion: 2,
      position: [500, 300],
      parameters: { toEmail: 'test@example.com' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 35)).toBe(true)
  })

  it('rule 35: no warning when sent_at field is present in parameters', () => {
    const w = { ...baseWorkflow(), nodes: [...baseWorkflow().nodes] }
    w.nodes.push({
      id: 'aaaa0035-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2,
      position: [500, 300],
      parameters: { operation: 'send', to: 'customer@example.com', subject: 'Hello' },
    })
    // Simulate a Set node that writes sent_at
    w.nodes.push({
      id: 'aaaa0035-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Mark Sent',
      type: 'n8n-nodes-base.set',
      typeVersion: 3,
      position: [700, 300],
      parameters: {
        assignments: { assignments: [{ id: '1', name: 'sent_at', value: '={{ $now }}', type: 'string' }] },
      },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 35)).toBe(false)
  })

  it('rule 35: no warning for Gmail node with non-send operation (getEmail)', () => {
    const w = { ...baseWorkflow(), nodes: [...baseWorkflow().nodes] }
    w.nodes.push({
      id: 'aaaa0035-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Get Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2,
      position: [500, 300],
      parameters: { operation: 'getEmail', messageId: '{{ $json.id }}' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 35)).toBe(false)
  })

  it('rule 35: no warning when dedupe keyword present in workflow', () => {
    const w = { ...baseWorkflow(), nodes: [...baseWorkflow().nodes] }
    w.nodes.push({
      id: 'aaaa0035-aaaa-4aaa-aaaa-aaaaaaaaaaaf',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2,
      position: [500, 300],
      parameters: { operation: 'send', subject: 'dedupe check newsletter' },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 35)).toBe(false)
  })

  it('rule 35: no warning for non-email workflows', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 35)).toBe(false)
  })

  // Rule 36: Code node output / downstream $json field name mismatch
  it('rule 36: warns when downstream node uses snake_case but code outputs camelCase', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0036-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Filter',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: 'return items.map(i => ({ json: { contactEmail: i.json.email, facilityName: i.json.name } }))' },
    })
    w.nodes.push({
      id: 'aaaa0036-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2,
      position: [650, 300],
      parameters: { operation: 'send', to: '={{ $json.contact_email }}', subject: 'Hello', sent_at: '={{ $now }}' },
      credentials: { gmailOAuth2: { id: 'cred-1', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter', type: 'main', index: 0 }]] }
    w.connections['Filter'] = { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 36)).toBe(true)
    const issue = result.issues.find((i) => i.rule === 36)!
    expect(issue.message).toContain('contact_email')
    expect(issue.message).toContain('contactEmail')
  })

  it('rule 36: no warning when field names match exactly (camelCase both sides)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0036-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Filter',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: 'return items.map(i => ({ json: { contactEmail: i.json.email } }))' },
    })
    w.nodes.push({
      id: 'aaaa0036-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2,
      position: [650, 300],
      parameters: { operation: 'send', to: '={{ $json.contactEmail }}', subject: 'Hello', sent_at: '={{ $now }}' },
      credentials: { gmailOAuth2: { id: 'cred-1', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter', type: 'main', index: 0 }]] }
    w.connections['Filter'] = { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 36)).toBe(false)
  })

  it('rule 36: no warning when code node is not upstream of the referencing node', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0036-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Unrelated Code',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 500],
      parameters: { jsCode: 'return items.map(i => ({ json: { contactEmail: i.json.email } }))' },
    })
    // Gmail node is NOT downstream of the code node
    w.nodes.push({
      id: 'aaaa0036-aaaa-4aaa-aaaa-aaaaaaaaaaaf',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2,
      position: [650, 300],
      parameters: { operation: 'send', to: '={{ $json.contact_email }}', subject: 'Hello', sent_at: '={{ $now }}' },
      credentials: { gmailOAuth2: { id: 'cred-1', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 36)).toBe(false)
  })

  // Rule 37: new Date() on external data without parseDate helper
  it('rule 37: warns when code calls new Date() on row data without a parseDate helper', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0037-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Filter Dates',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: {
        jsCode: [
          'const results = [];',
          'for (const item of items) {',
          '  const d = new Date(row.last_service_date);',
          '  results.push({ json: { days: Math.floor((Date.now() - d) / 86400000) } });',
          '}',
          'return results;',
        ].join('\n'),
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter Dates', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 37)).toBe(true)
  })

  it('rule 37: no warning when parseDate helper is present', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0037-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Filter Dates',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: {
        jsCode: [
          'function parseDate(s) { const [m,d,y] = s.split("-"); return new Date(2000+parseInt(y), parseInt(m)-1, parseInt(d)); }',
          'for (const item of items) {',
          '  const d = new Date(row.last_service_date);',
          '}',
          'return [];',
        ].join('\n'),
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter Dates', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 37)).toBe(false)
  })

  it('rule 37: no warning when code does not read dates from external data', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0037-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Run Code',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: 'const d = new Date(); return [{ json: { ts: d.toISOString() } }];' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Run Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 37)).toBe(false)
  })

  // Rule 38: parallel AI HTTP calls merging into same node
  it('rule 38: warns when 2 AI HTTP nodes connect to same downstream node', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0038-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Generate Post 1',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 200],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
    })
    w.nodes.push({
      id: 'aaaa0038-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Generate Post 2',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 400],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
    })
    w.nodes.push({
      id: 'aaaa0038-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Combine Posts',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [700, 300],
      parameters: { jsCode: 'return items;' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Generate Post 1', type: 'main', index: 0 }, { node: 'Generate Post 2', type: 'main', index: 0 }]] }
    w.connections['Generate Post 1'] = { main: [[{ node: 'Combine Posts', type: 'main', index: 0 }]] }
    w.connections['Generate Post 2'] = { main: [[{ node: 'Combine Posts', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 38)).toBe(true)
    expect(result.issues.find((i) => i.rule === 38)!.message).toContain('Combine Posts')
  })

  it('rule 38: no warning when AI HTTP nodes are chained sequentially', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0038-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Generate Post 1',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
    })
    w.nodes.push({
      id: 'aaaa0038-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Generate Post 2',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [650, 300],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Generate Post 1', type: 'main', index: 0 }]] }
    w.connections['Generate Post 1'] = { main: [[{ node: 'Generate Post 2', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 38)).toBe(false)
  })

  it('rule 38: no warning when only one AI HTTP node exists', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0038-aaaa-4aaa-aaaa-aaaaaaaaaaaf',
      name: 'Call AI',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call AI', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 38)).toBe(false)
  })

  // Rule 39: deprecated Claude model names
  it('rule 39: warns on deprecated Claude model claude-3-5-sonnet-20241022', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0039-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Call Claude',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST', body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022' }) },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call Claude', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 39)).toBe(true)
    expect(result.issues.find((i) => i.rule === 39)!.message).toContain('claude-3-5-sonnet-20241022')
  })

  it('rule 39: warns on deprecated model claude-3-opus-20240229', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0039-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Call Claude',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST', body: { model: 'claude-3-opus-20240229' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call Claude', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 39)).toBe(true)
  })

  it('rule 39: no warning when current model name is used', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0039-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Call Claude',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.anthropic.com/v1/messages', method: 'POST', body: { model: 'claude-sonnet-4-6' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call Claude', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 39)).toBe(false)
  })

  it('rule 39: no warning when no Claude model referenced', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 39)).toBe(false)
  })

  // ── Rule 40: __rl resource locator wrong shape ──────────────────────────────

  it('rule 40: warns when googleSheets documentId is a plain string', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0040-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Read Sheet',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: { documentId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms', operation: 'read' },
      credentials: { googleSheetsOAuth2Api: { id: 'cred-1', name: 'Google Sheets' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Read Sheet', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 40)).toBe(true)
  })

  it('rule 40: warns when googleSheets documentId __rl has empty value', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0040-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Read Sheet',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: { documentId: { __rl: true, mode: 'id', value: '' }, operation: 'read' },
      credentials: { googleSheetsOAuth2Api: { id: 'cred-1', name: 'Google Sheets' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Read Sheet', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 40)).toBe(true)
  })

  it('rule 40: no warning when googleSheets documentId uses correct __rl format', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0040-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Read Sheet',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: {
        documentId: { __rl: true, mode: 'id', value: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms' },
        sheetName: { __rl: true, mode: 'name', value: 'Sheet1' },
        operation: 'read',
      },
      credentials: { googleSheetsOAuth2Api: { id: 'cred-1', name: 'Google Sheets' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Read Sheet', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 40)).toBe(false)
  })

  // ── Rule 41: HTTP Request body ignored when sendBody not true ──────────────

  it('rule 41: warns when httpRequest has bodyParameters but sendBody is false', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0041-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'POST Data',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: {
        url: 'https://api.myservice.com/data',
        method: 'POST',
        sendBody: false,
        bodyParameters: { parameters: [{ name: 'key', value: 'val' }] },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'POST Data', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 41)).toBe(true)
  })

  it('rule 41: no warning when sendBody is true', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0041-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'POST Data',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: {
        url: 'https://api.myservice.com/data',
        method: 'POST',
        sendBody: true,
        bodyParameters: { parameters: [{ name: 'key', value: 'val' }] },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'POST Data', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 41)).toBe(false)
  })

  it('rule 41: no warning when no body content is defined', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0041-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'GET Data',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.myservice.com/data', method: 'GET' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'GET Data', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 41)).toBe(false)
  })

  // ── Rule 42: SplitInBatches done branch loops back ─────────────────────────

  it('rule 42: warns when splitInBatches output 0 loops back to itself', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0042-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Split', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } },
      { id: 'aaaa0042-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Process', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [670, 300], parameters: {} },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    // output 0 (done) → Process → Split (loop) — this is the REVERSED / wrong wiring
    w.connections['Split'] = { main: [[{ node: 'Process', type: 'main', index: 0 }], []] }
    w.connections['Process'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 42)).toBe(true)
  })

  it('rule 42: no warning when splitInBatches output 1 loops back (correct wiring)', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0042-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Split', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } },
      { id: 'aaaa0042-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Process', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [670, 300], parameters: {} },
      { id: 'aaaa0042-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'Done', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [670, 150], parameters: {} },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    // output 0 (done) → Done node; output 1 (loop) → Process → Split (correct)
    w.connections['Split'] = { main: [[{ node: 'Done', type: 'main', index: 0 }], [{ node: 'Process', type: 'main', index: 0 }]] }
    w.connections['Process'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 42)).toBe(false)
  })

  // ── Rule 43: IF node string operator instead of object ─────────────────────

  it('rule 43: warns when IF node condition has string operator in typeVersion 2+', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0043-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Check Status',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ id: 'c1', leftValue: '={{ $json.status }}', rightValue: 'active', operator: 'equals' }],
        },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Check Status', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 43)).toBe(true)
  })

  it('rule 43: no warning when IF node condition uses correct operator object', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0043-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Check Status',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [450, 300],
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ id: 'c1', leftValue: '={{ $json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }],
        },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Check Status', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 43)).toBe(false)
  })

  it('rule 43: no warning for IF node typeVersion 1 (string operator OK in v1)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0043-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Check',
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [450, 300],
      parameters: {
        conditions: {
          conditions: [{ leftValue: '={{ $json.status }}', rightValue: 'active', operator: 'equals' }],
        },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Check', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 43)).toBe(false)
  })

  // ── Rule 44: Google Sheets defineBelow with empty fieldsUi ─────────────────

  it('rule 44: warns when googleSheets append has defineBelow with empty fieldsUi', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0044-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Append Row',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: {
        operation: 'append',
        columnMappingMode: 'defineBelow',
        fieldsUi: { values: [] },
        documentId: { __rl: true, mode: 'id', value: 'spreadsheet-id' },
        sheetName: { __rl: true, mode: 'name', value: 'Sheet1' },
      },
      credentials: { googleSheetsOAuth2Api: { id: 'cred-1', name: 'Google Sheets' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Append Row', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 44)).toBe(true)
  })

  it('rule 44: no warning when googleSheets append uses autoMapInputData', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0044-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Append Row',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: {
        operation: 'append',
        columnMappingMode: 'autoMapInputData',
        documentId: { __rl: true, mode: 'id', value: 'spreadsheet-id' },
        sheetName: { __rl: true, mode: 'name', value: 'Sheet1' },
      },
      credentials: { googleSheetsOAuth2Api: { id: 'cred-1', name: 'Google Sheets' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Append Row', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 44)).toBe(false)
  })

  it('rule 44: no warning for read operations regardless of columnMappingMode', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0044-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Read Sheet',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: {
        operation: 'read',
        columnMappingMode: 'defineBelow',
        fieldsUi: { values: [] },
        documentId: { __rl: true, mode: 'id', value: 'spreadsheet-id' },
        sheetName: { __rl: true, mode: 'name', value: 'Sheet1' },
      },
      credentials: { googleSheetsOAuth2Api: { id: 'cred-1', name: 'Google Sheets' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Read Sheet', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 44)).toBe(false)
  })

  // ── Rule 45: AI Agent missing language model sub-node ──────────────────────

  it('rule 45: errors when AI Agent has no ai_languageModel connection', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0045-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'AI Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 1.9,
      position: [450, 300],
      parameters: { promptType: 'define', text: 'Summarize this' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 45 && i.severity === 'error')).toBe(true)
  })

  it('rule 45: no error when AI Agent has ai_languageModel sub-node connected', () => {
    const w = baseWorkflow()
    w.nodes.push(
      {
        id: 'aaaa0045-aaaa-4aaa-aaaa-aaaaaaaaaaab',
        name: 'AI Agent',
        type: '@n8n/n8n-nodes-langchain.agent',
        typeVersion: 1.9,
        position: [450, 300],
        parameters: { promptType: 'define', text: 'Summarize' },
      },
      {
        id: 'aaaa0045-aaaa-4aaa-aaaa-aaaaaaaaaaac',
        name: 'Claude Model',
        type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
        typeVersion: 1.3,
        position: [450, 500],
        parameters: { model: 'claude-sonnet-4-6' },
        credentials: { anthropicApi: { id: 'cred-1', name: 'Anthropic' } },
      },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] }
    w.connections['Claude Model'] = { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 45)).toBe(false)
  })

  it('rule 45: no error for non-agent langchain nodes', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 45)).toBe(false)
  })

  // ── Rule 46: hardcoded API key in HTTP Request header ─────────────────────

  it('rule 46: warns when Authorization header has hardcoded Bearer token', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0046-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Call API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: {
        url: 'https://api.example.com/data',
        method: 'GET',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: 'Bearer sk-abc123def456ghi789jkl012mno345pqr678' }] },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call API', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 46)).toBe(true)
  })

  it('rule 46: no warning when Authorization header uses an expression', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0046-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Call API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: {
        url: 'https://api.example.com/data',
        method: 'GET',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: '={{ "Bearer " + $credential.apiKey }}' }] },
      },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call API', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 46)).toBe(false)
  })

  it('rule 46: no warning when sendHeaders is false', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0046-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Call API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.example.com/data', method: 'GET', sendHeaders: false },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call API', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 46)).toBe(false)
  })

  // ── Rule 47: Switch node with unconnected output routes ────────────────────

  it('rule 47: warns when switch route has no downstream connection', () => {
    const w = baseWorkflow()
    w.nodes.push(
      {
        id: 'aaaa0047-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        name: 'Route',
        type: 'n8n-nodes-base.switch',
        typeVersion: 3.2,
        position: [450, 300],
        parameters: { rules: { values: [{ value: 'high' }, { value: 'low' }] } },
      },
      {
        id: 'aaaa0047-aaaa-4aaa-aaaa-aaaaaaaaaaab',
        name: 'High Path',
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position: [670, 200],
        parameters: {},
      },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Route', type: 'main', index: 0 }]] }
    // Only connect route 0 — route 1 is unconnected
    w.connections['Route'] = { main: [[{ node: 'High Path', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 47)).toBe(true)
  })

  it('rule 47: no warning when all switch routes are connected', () => {
    const w = baseWorkflow()
    w.nodes.push(
      {
        id: 'aaaa0047-aaaa-4aaa-aaaa-aaaaaaaaaaac',
        name: 'Route',
        type: 'n8n-nodes-base.switch',
        typeVersion: 3.2,
        position: [450, 300],
        parameters: { rules: { values: [{ value: 'high' }, { value: 'low' }] } },
      },
      { id: 'aaaa0047-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'High', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [670, 200], parameters: {} },
      { id: 'aaaa0047-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'Low', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [670, 400], parameters: {} },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Route', type: 'main', index: 0 }]] }
    w.connections['Route'] = { main: [[{ node: 'High', type: 'main', index: 0 }], [{ node: 'Low', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 47)).toBe(false)
  })

  it('rule 47: no warning for non-switch nodes', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 47)).toBe(false)
  })

  // ── Rule 48: deprecated OpenAI model names ─────────────────────────────────

  it('rule 48: warns on deprecated gpt-3.5-turbo model', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0048-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'OpenAI Chat',
      type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
      typeVersion: 1.7,
      position: [450, 300],
      parameters: { model: 'gpt-3.5-turbo' },
      credentials: { openAiApi: { id: 'cred-1', name: 'OpenAI' } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 48)).toBe(true)
  })

  it('rule 48: no warning when current gpt-4o model is used', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0048-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'OpenAI Chat',
      type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
      typeVersion: 1.7,
      position: [450, 300],
      parameters: { model: 'gpt-4o-mini' },
      credentials: { openAiApi: { id: 'cred-1', name: 'OpenAI' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'OpenAI Chat', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 48)).toBe(false)
  })

  it('rule 48: no warning when no OpenAI model referenced', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 48)).toBe(false)
  })

  // ── Rule 49: executeWorkflow missing workflowId ────────────────────────────

  it('rule 49: warns when executeWorkflow has no workflowId', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0049-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Run Sub',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.2,
      position: [450, 300],
      parameters: {},
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Run Sub', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 49)).toBe(true)
  })

  it('rule 49: no warning when executeWorkflow has a workflowId', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0049-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Run Sub',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.2,
      position: [450, 300],
      parameters: { workflowId: '12345' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Run Sub', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 49)).toBe(false)
  })

  it('rule 49: no warning for other node types', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 49)).toBe(false)
  })

  // ── Rule 50: AI Agent promptType auto with no chatTrigger ──────────────────

  it('rule 50: warns when AI Agent has promptType auto but trigger is scheduleTrigger', () => {
    const w: N8nWorkflow = {
      name: 'Daily Summarize',
      nodes: [
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'days', daysInterval: 1 }] } } },
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [470, 300], parameters: { promptType: 'auto' } },
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Claude', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [470, 500], parameters: { model: 'claude-sonnet-4-6' }, credentials: { anthropicApi: { id: 'c', name: 'C' } } },
      ],
      connections: {
        Schedule: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
        Claude: { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] },
      },
      settings: {},
    }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 50)).toBe(true)
  })

  it('rule 50: no warning when AI Agent uses promptType define', () => {
    const w: N8nWorkflow = {
      name: 'Scheduled Agent',
      nodes: [
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'days' }] } } },
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [470, 300], parameters: { promptType: 'define', text: 'Summarize emails' } },
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaaf', name: 'Claude', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [470, 500], parameters: { model: 'claude-sonnet-4-6' }, credentials: { anthropicApi: { id: 'c', name: 'C' } } },
      ],
      connections: {
        Schedule: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
        Claude: { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] },
      },
      settings: {},
    }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 50)).toBe(false)
  })

  it('rule 50: no warning when chatTrigger is present', () => {
    const w: N8nWorkflow = {
      name: 'Chat Agent',
      nodes: [
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaag', name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, position: [250, 300], parameters: {} },
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaah', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [470, 300], parameters: { promptType: 'auto' } },
        { id: 'aaaa0050-aaaa-4aaa-aaaa-aaaaaaaaaaai', name: 'Claude', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [470, 500], parameters: { model: 'claude-sonnet-4-6' }, credentials: { anthropicApi: { id: 'c', name: 'C' } } },
      ],
      connections: {
        Chat: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
        Claude: { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] },
      },
      settings: {},
    }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 50)).toBe(false)
  })

  // ── Rule 51: Wait webhook mode with no resumeUrl ───────────────────────────

  it('rule 51: warns when Wait node is in webhook mode with nothing sending resumeUrl', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0051-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [450, 300], parameters: { resume: 'webhook' } },
      { id: 'aaaa0051-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Continue', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [670, 300], parameters: {} },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Wait', type: 'main', index: 0 }]] }
    w.connections['Wait'] = { main: [[{ node: 'Continue', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 51)).toBe(true)
  })

  it('rule 51: no warning when workflow contains resumeUrl reference', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0051-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [450, 300], parameters: { resume: 'webhook' } },
      { id: 'aaaa0051-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Send Link', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [250, 450], parameters: { operation: 'send', to: 'boss@example.com', message: 'Approve: ={{ $execution.resumeUrl }}' }, credentials: { gmailOAuth2: { id: 'c', name: 'G' } } },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Send Link', type: 'main', index: 0 }], [{ node: 'Wait', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 51)).toBe(false)
  })

  it('rule 51: no warning for Wait node in timeInterval mode', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0051-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Wait 3 Days',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [450, 300],
      parameters: { resume: 'timeInterval', waitAmount: 3, waitUnit: 'days' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Wait 3 Days', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 51)).toBe(false)
  })

  // ── Rule 52: SQL injection risk in Code node ───────────────────────────────

  it('rule 52: warns on template literal SQL with $json field', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0052-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Query DB',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: "const q = `SELECT * FROM users WHERE email = '${$json.email}'`; return [{ json: { q } }]" },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Query DB', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 52)).toBe(true)
  })

  it('rule 52: no warning when parameterized query is used', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0052-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Query DB',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: "const q = { sql: 'SELECT * FROM users WHERE email = $1', values: [$json.email] }; return [{ json: q }]" },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Query DB', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 52)).toBe(false)
  })

  it('rule 52: no warning when code node has no SQL', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0052-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Transform',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: 'return items.map(i => ({ json: { name: i.json.name.toUpperCase() } }))' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Transform', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 52)).toBe(false)
  })

  // ── Rule 53: Merge mode vs input count ────────────────────────────────────

  it('rule 53: warns when Merge chooseBranch has only 1 incoming connection', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0053-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [670, 300], parameters: { mode: 'chooseBranch' } },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Merge', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 53)).toBe(true)
  })

  it('rule 53: no warning when Merge chooseBranch has 2 incoming connections', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0053-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Branch A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [450, 200], parameters: {} },
      { id: 'aaaa0053-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Branch B', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [450, 400], parameters: {} },
      { id: 'aaaa0053-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [670, 300], parameters: { mode: 'chooseBranch' } },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Branch A', type: 'main', index: 0 }], [{ node: 'Branch B', type: 'main', index: 0 }]] }
    w.connections['Branch A'] = { main: [[{ node: 'Merge', type: 'main', index: 0 }]] }
    w.connections['Branch B'] = { main: [[{ node: 'Merge', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 53)).toBe(false)
  })

  it('rule 53: no warning for Merge in append mode with 1 input', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0053-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [670, 300], parameters: { mode: 'append' } },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Merge', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 53)).toBe(false)
  })

  // ── Rule 54: HTTP Request to protected API without auth ────────────────────

  it('rule 54: warns when calling Stripe API with no credentials', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0054-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Stripe Call',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.stripe.com/v1/charges', method: 'GET' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Stripe Call', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 54)).toBe(true)
  })

  it('rule 54: no warning when Stripe call has credentials', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0054-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Stripe Call',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.stripe.com/v1/charges', method: 'GET' },
      credentials: { stripeApi: { id: 'cred-1', name: 'Stripe' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Stripe Call', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 54)).toBe(false)
  })

  it('rule 54: no warning for unknown/unlisted API domains', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0054-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'Custom API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.myownservice.com/data', method: 'GET' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Custom API', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 54)).toBe(false)
  })

  // ── Rule 55: Google Sheets sheetName placeholder ───────────────────────────

  it('rule 55: warns when sheetName is "Sheet1" placeholder with real documentId', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0055-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Read Data',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: {
        operation: 'read',
        documentId: { __rl: true, mode: 'id', value: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms' },
        sheetName: { __rl: true, mode: 'name', value: 'Sheet1' },
      },
      credentials: { googleSheetsOAuth2Api: { id: 'c', name: 'GS' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Read Data', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 55)).toBe(true)
  })

  it('rule 55: no warning when sheetName is a real tab name', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0055-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Read Data',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [450, 300],
      parameters: {
        operation: 'read',
        documentId: { __rl: true, mode: 'id', value: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms' },
        sheetName: { __rl: true, mode: 'name', value: 'Customers' },
      },
      credentials: { googleSheetsOAuth2Api: { id: 'c', name: 'GS' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Read Data', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 55)).toBe(false)
  })

  // ── Rule 56: continueOnFail with no error check downstream ────────────────

  it('rule 56: warns when continueOnFail node has no downstream error check', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0056-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], onError: 'continueRegularOutput', parameters: { url: 'https://api.example.com/data' } },
      { id: 'aaaa0056-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Process', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [670, 300], parameters: { assignments: { assignments: [{ id: 'a1', name: 'status', value: 'ok', type: 'string' }] } } },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call API', type: 'main', index: 0 }]] }
    w.connections['Call API'] = { main: [[{ node: 'Process', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 56)).toBe(true)
  })

  it('rule 56: no warning when downstream node checks $json.error', () => {
    const w = baseWorkflow()
    w.nodes.push(
      { id: 'aaaa0056-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], onError: 'continueRegularOutput', parameters: { url: 'https://api.example.com/data' } },
      { id: 'aaaa0056-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Check Error', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [670, 300], parameters: { conditions: { combinator: 'and', conditions: [{ id: 'c1', leftValue: '={{ $json.error }}', rightValue: '', operator: { type: 'string', operation: 'exists' } }] } } },
    )
    w.connections['Manual Trigger'] = { main: [[{ node: 'Call API', type: 'main', index: 0 }]] }
    w.connections['Call API'] = { main: [[{ node: 'Check Error', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 56)).toBe(false)
  })

  // ── Rule 57: HTTP Request binary upload missing binaryPropertyName ─────────

  it('rule 57: warns when binary upload has empty inputDataFieldName (typeVersion 3+ field name)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0057-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Upload File',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.example.com/upload', method: 'POST', sendBody: true, contentType: 'binaryData', inputDataFieldName: '' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Upload File', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 57)).toBe(true)
  })

  it('rule 57: no warning when inputDataFieldName is set (typeVersion 3+ field name)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0057-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Upload File',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.example.com/upload', method: 'POST', sendBody: true, contentType: 'binaryData', inputDataFieldName: 'data' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Upload File', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 57)).toBe(false)
  })

  it('rule 57: warns when binary upload has neither inputDataFieldName nor binaryPropertyName set (regression — the field name differs by typeVersion, checked wrong field name entirely before this fix)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0057-aaaa-4aaa-aaaa-aaaaaaaaaaad',
      name: 'Upload File',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.example.com/upload', method: 'POST', sendBody: true, contentType: 'binaryData' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Upload File', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 57)).toBe(true)
  })

  it('rule 57: no warning when legacy binaryPropertyName is set (typeVersion 1-2 field name fallback)', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0057-aaaa-4aaa-aaaa-aaaaaaaaaaae',
      name: 'Upload File',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 2,
      position: [450, 300],
      parameters: { url: 'https://api.example.com/upload', method: 'POST', sendBody: true, contentType: 'binaryData', binaryPropertyName: 'data' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Upload File', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 57)).toBe(false)
  })

  it('rule 57: no warning when contentType is not binaryData', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0057-aaaa-4aaa-aaaa-aaaaaaaaaaac',
      name: 'POST JSON',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [450, 300],
      parameters: { url: 'https://api.example.com/data', method: 'POST', sendBody: true, contentType: 'json' },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'POST JSON', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 57)).toBe(false)
  })

  // ── Rule 58: wrong credential type key ────────────────────────────────────

  it('rule 58: warns when Gmail node uses wrong credential key', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0058-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [450, 300],
      parameters: { operation: 'send', to: 'user@example.com' },
      credentials: { gmailOAuth: { id: 'c', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 58)).toBe(true)
  })

  it('rule 58: no warning when Gmail node uses correct credential key', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0058-aaaa-4aaa-aaaa-aaaaaaaaaaab',
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [450, 300],
      parameters: { operation: 'send', to: 'user@example.com' },
      credentials: { gmailOAuth2: { id: 'c', name: 'Gmail' } },
    })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 58)).toBe(false)
  })

  it('rule 58: no warning for node types not in the expected credential map', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 58)).toBe(false)
  })

  // Rule 59: webhook with no authentication
  it('rule 59: warns when webhook has no authentication', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0059-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { httpMethod: 'POST', path: 'my-hook', authentication: 'none' } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 59)).toBe(true)
  })

  it('rule 59: warns when webhook authentication is missing', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0059-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { httpMethod: 'POST', path: 'my-hook' } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 59)).toBe(true)
  })

  it('rule 59: no warning when webhook uses headerAuth', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0059-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { httpMethod: 'POST', path: 'my-hook', authentication: 'headerAuth' } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 59)).toBe(false)
  })

  // Rule 60: schedule fires every minute
  it('rule 60: warns when cronExpression minute field is *', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0060-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '* * * * *' }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 60)).toBe(true)
  })

  it('rule 60: warns when minutesInterval is 1', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0060-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 60)).toBe(true)
  })

  it('rule 60: no warning for cron that fires hourly', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0060-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 60)).toBe(false)
  })

  // Rule 61: toolWorkflow missing description
  it('rule 61: warns when toolWorkflow has no description', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0061-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300], parameters: { workflowId: '123' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 61)).toBe(true)
  })

  it('rule 61: no warning when toolWorkflow has description', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0061-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300], parameters: { workflowId: '123', description: 'Looks up stock prices' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 61)).toBe(false)
  })

  // Rule 62: memoryBufferWindow without chatTrigger and no sessionKey
  it('rule 62: warns when memoryBufferWindow has no chatTrigger and no sessionKey', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0062-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Memory', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [450, 300], parameters: {} })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 62)).toBe(true)
  })

  it('rule 62: no warning when memoryBufferWindow has a sessionKey', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0062-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Memory', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [450, 300], parameters: { sessionKey: '={{ $json.sessionId }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 62)).toBe(false)
  })

  it('rule 62: no warning when chatTrigger is present', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0062-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, position: [250, 300], parameters: {} }
    w.nodes.push({ id: 'aaaa0062-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Memory', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [450, 300], parameters: {} })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 62)).toBe(false)
  })

  // Rule 63: duplicate webhook path+method
  it('rule 63: errors on duplicate webhook path+method', () => {
    const w = baseWorkflow()
    w.nodes = [
      { id: 'aaaa0063-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Hook A', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { httpMethod: 'POST', path: 'intake' } },
      { id: 'aaaa0063-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Hook B', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [450, 300], parameters: { httpMethod: 'POST', path: 'intake' } },
    ]
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 63 && i.severity === 'error')).toBe(true)
  })

  it('rule 63: no error when webhooks have different paths', () => {
    const w = baseWorkflow()
    w.nodes = [
      { id: 'aaaa0063-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Hook A', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { httpMethod: 'POST', path: 'intake' } },
      { id: 'aaaa0063-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Hook B', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [450, 300], parameters: { httpMethod: 'POST', path: 'update' } },
    ]
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 63)).toBe(false)
  })

  // Rule 65: SplitInBatches batchSize <= 0
  it('rule 65: errors when batchSize is 0', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0065-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Batch', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 0 } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Batch', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 65 && i.severity === 'error')).toBe(true)
  })

  it('rule 65: errors when batchSize is negative', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0065-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Batch', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: -5 } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Batch', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 65 && i.severity === 'error')).toBe(true)
  })

  it('rule 65: no error when batchSize is positive', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0065-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Batch', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Batch', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 65)).toBe(false)
  })

  // Rule 66: HTTP Request URL missing protocol
  it('rule 66: errors when HTTP Request URL has no protocol', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0066-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'api.example.com/data' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 66 && i.severity === 'error')).toBe(true)
  })

  it('rule 66: no error when URL starts with https://', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0066-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com/data' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 66)).toBe(false)
  })

  it('rule 66: no error when URL is an expression', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0066-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: '={{ $json.endpoint }}' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 66)).toBe(false)
  })

  it('rule 66: no error when URL is a mixed literal+expression prefixed with "="', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0066-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: "=https://{{ $json.shop_domain }}.myshopify.com/admin/api/2024-01/checkouts.json" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 66)).toBe(false)
  })

  it('rule 66: still errors when "=" prefixed URL has a literal prefix but no protocol', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0066-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: "=api.example.com/{{ $json.path }}" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 66 && i.severity === 'error')).toBe(true)
  })

  // Rule 67: Code node references non-existent node
  it('rule 67: warns when code references a node that does not exist', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0067-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: "return $('Nonexistent Node').all()" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 67)).toBe(true)
  })

  it('rule 67: no warning when code references an existing node', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0067-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: "return $('Manual Trigger').all()" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 67)).toBe(false)
  })

  // Rule 68: Google Calendar create event missing timezone
  it('rule 68: warns when Google Calendar create event has no timezone', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0068-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Calendar', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [450, 300], parameters: { resource: 'event', operation: 'create', calendarId: { __rl: true, mode: 'id', value: 'primary' } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Calendar', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 68)).toBe(true)
  })

  it('rule 68: no warning when timezone is set', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0068-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Calendar', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [450, 300], parameters: { resource: 'event', operation: 'create', timezone: 'America/New_York' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Calendar', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 68)).toBe(false)
  })

  it('rule 68: no warning for non-create operations', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0068-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Calendar', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [450, 300], parameters: { resource: 'event', operation: 'getAll' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Calendar', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 68)).toBe(false)
  })

  // Rule 69: Gmail send missing subject
  it('rule 69: warns when Gmail send has no subject', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0069-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [450, 300], parameters: { resource: 'message', operation: 'send', to: 'user@example.com', subject: '' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Gmail', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 69)).toBe(true)
  })

  it('rule 69: no warning when Gmail send has subject', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0069-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [450, 300], parameters: { resource: 'message', operation: 'send', to: 'user@example.com', subject: 'Hello' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Gmail', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 69)).toBe(false)
  })

  // Rule 70: Set v1 with keepOnlySet=true
  it('rule 70: warns when Set v1 has keepOnlySet=true', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0070-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, position: [450, 300], parameters: { keepOnlySet: true, values: { string: [] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 70)).toBe(true)
  })

  it('rule 70: no warning when Set v1 has keepOnlySet=false', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0070-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, position: [450, 300], parameters: { keepOnlySet: false } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 70)).toBe(false)
  })

  it('rule 70: no warning for Set v3 (keepOnlySet removed)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0070-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 70)).toBe(false)
  })

  // Rule 71: toolWorkflow source=database missing workflowId
  it('rule 71: warns when toolWorkflow has no workflowId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0071-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300], parameters: { description: 'Does something', source: 'database' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 71)).toBe(true)
  })

  it('rule 71: no warning when toolWorkflow has workflowId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0071-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300], parameters: { description: 'Does something', source: 'database', workflowId: '42' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 71)).toBe(false)
  })

  // Rule 72: Code node JSON.parse without try/catch
  it('rule 72: warns when JSON.parse is used without try/catch', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0072-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: "const data = JSON.parse($json.payload); return [{ json: data }]" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 72)).toBe(true)
  })

  it('rule 72: no warning when JSON.parse is in a try/catch', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0072-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: "try { const d = JSON.parse($json.p); return [{ json: d }] } catch(e) { return [{ json: { error: e.message } }] }" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 72)).toBe(false)
  })

  it('rule 72: no warning when code has no JSON.parse', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0072-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: "return items.map(i => ({ json: { val: i.json.value * 2 } }))" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 72)).toBe(false)
  })

  // Rule 73: AI tool sub-node missing description
  it('rule 73: warns when toolCode has no description', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0073-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Tool', type: '@n8n/n8n-nodes-langchain.toolCode', typeVersion: 1.1, position: [450, 300], parameters: { jsCode: "return 'result'" } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 73)).toBe(true)
  })

  it('rule 73: no warning when toolCode has description', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0073-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Tool', type: '@n8n/n8n-nodes-langchain.toolCode', typeVersion: 1.1, position: [450, 300], parameters: { jsCode: "return 'result'", description: 'Calculates something useful' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 73)).toBe(false)
  })

  // Rule 74: multiple memoryBufferWindow nodes with same static sessionKey
  it('rule 74: warns when two memory nodes share the same static sessionKey', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0074-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Mem A', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [450, 300], parameters: { sessionKey: 'shared-session' } })
    w.nodes.push({ id: 'aaaa0074-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Mem B', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [650, 300], parameters: { sessionKey: 'shared-session' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 74)).toBe(true)
  })

  it('rule 74: no warning when memory nodes have different sessionKeys', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0074-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Mem A', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [450, 300], parameters: { sessionKey: 'session-a' } })
    w.nodes.push({ id: 'aaaa0074-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Mem B', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [650, 300], parameters: { sessionKey: 'session-b' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 74)).toBe(false)
  })

  // Rule 75: emailSend missing required fields
  it('rule 75: warns when emailSend has no to address', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0075-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [450, 300], parameters: { toAddresses: '', subject: 'Hello', message: 'Body' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 75)).toBe(true)
  })

  it('rule 75: warns when emailSend has no subject', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0075-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [450, 300], parameters: { toAddresses: 'user@example.com', subject: '', message: 'Body' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 75)).toBe(true)
  })

  it('rule 75: no warning when emailSend has all required fields', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0075-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [450, 300], parameters: { toAddresses: 'user@example.com', subject: 'Hello', message: 'Body text' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Email', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 75)).toBe(false)
  })

  // Rule 76: Telegram sendMessage missing chatId
  it('rule 76: warns when Telegram sendMessage has no chatId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0076-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [450, 300], parameters: { resource: 'message', operation: 'sendMessage', chatId: '', text: 'Hello' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Telegram', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 76)).toBe(true)
  })

  it('rule 76: no warning when Telegram sendMessage has chatId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0076-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [450, 300], parameters: { resource: 'message', operation: 'sendMessage', chatId: '123456789', text: 'Hello' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Telegram', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 76)).toBe(false)
  })

  // Rule 77: Code runOnceForAllItems uses $json
  it('rule 77: warns when runOnceForAllItems mode uses $json', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0077-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { mode: 'runOnceForAllItems', jsCode: "const name = $json.name; return [{ json: { name } }]" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 77)).toBe(true)
  })

  it('rule 77: no warning when runOnceForAllItems uses $input.all()', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0077-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { mode: 'runOnceForAllItems', jsCode: "return $input.all().map(i => ({ json: { name: i.json.name } }))" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 77)).toBe(false)
  })

  it('rule 77: no warning for runOnceForEachItem mode', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0077-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { mode: 'runOnceForEachItem', jsCode: "return [{ json: { val: $json.value } }]" } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 77)).toBe(false)
  })

  // Rule 78: workflow has no errorWorkflow
  it('rule 78: warns when workflow has no errorWorkflow in settings', () => {
    const w = baseWorkflow()
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 78)).toBe(true)
  })

  it('rule 78: no warning when errorWorkflow is set', () => {
    const w = { ...baseWorkflow(), settings: { ...baseWorkflow().settings, errorWorkflow: '99' } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 78)).toBe(false)
  })

  // Rule 79: HTTP Request URL contains "webhook-test"
  it('rule 79: warns when HTTP Request URL contains webhook-test', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0079-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'POST', url: 'https://myinstance.n8n.cloud/webhook-test/abc123' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 79)).toBe(true)
  })

  it('rule 79: no warning when URL does not contain webhook-test', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0079-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'POST', url: 'https://myinstance.n8n.cloud/webhook/abc123' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 79)).toBe(false)
  })

  // Rule 80: Set v3+ has assignments but no includeOtherInputFields
  it('rule 80: warns when Set v3+ has assignments without includeOtherInputFields', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0080-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'foo', value: 'bar', type: 'string' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 80)).toBe(true)
  })

  it('rule 80: no warning when includeOtherInputFields is true', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0080-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'foo', value: 'bar', type: 'string' }] }, includeOtherInputFields: true } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 80)).toBe(false)
  })

  it('rule 80: no warning when Set v3+ has empty assignments array', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0080-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 80)).toBe(false)
  })

  // Rule 81: executeWorkflow calls current workflow
  it('rule 81: errors when executeWorkflow references the current workflow id', () => {
    const w = { ...baseWorkflow(), id: 'self-wf-id-1234' } as N8nWorkflow & { id: string }
    w.nodes.push({ id: 'aaaa0081-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Run Sub', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [450, 300], parameters: { workflowId: 'self-wf-id-1234' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Run Sub', type: 'main', index: 0 }]] }
    const result = validator.validate(w as N8nWorkflow)
    expect(result.issues.some((i) => i.rule === 81 && i.severity === 'error')).toBe(true)
  })

  it('rule 81: no error when executeWorkflow references a different workflow', () => {
    const w = { ...baseWorkflow(), id: 'self-wf-id-1234' } as N8nWorkflow & { id: string }
    w.nodes.push({ id: 'aaaa0081-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Run Sub', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [450, 300], parameters: { workflowId: 'other-wf-id-9999' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Run Sub', type: 'main', index: 0 }]] }
    const result = validator.validate(w as N8nWorkflow)
    expect(result.issues.some((i) => i.rule === 81)).toBe(false)
  })

  it('rule 81: no error when workflow has no id (Kairos-generated)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0081-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Run Sub', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [450, 300], parameters: { workflowId: 'some-id' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Run Sub', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 81)).toBe(false)
  })

  // Rule 82: nested SplitInBatches
  it('rule 82: warns when workflow has 2 or more SplitInBatches nodes', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0082-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Outer Batch', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } })
    w.nodes.push({ id: 'aaaa0082-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Inner Batch', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [650, 300], parameters: { batchSize: 5 } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 82)).toBe(true)
  })

  it('rule 82: no warning with only one SplitInBatches node', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0082-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Batch', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 82)).toBe(false)
  })

  // Rule 83: toolWorkflow source=parameter with no inline nodes
  it('rule 83: errors when toolWorkflow source=parameter has no workflow nodes', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0083-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300], parameters: { source: 'parameter', workflow: { nodes: [] }, description: 'Does something' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 83 && i.severity === 'error')).toBe(true)
  })

  it('rule 83: no error when source=parameter has inline nodes', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0083-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300], parameters: { source: 'parameter', workflow: { nodes: [{ id: 'x', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [250, 300], parameters: {} }] }, description: 'Does something' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 83)).toBe(false)
  })

  // Rule 85: HTTP Request has both credential and manual Authorization header
  it('rule 85: warns when HTTP Request has credential and Authorization header', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0085-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com', sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: 'Bearer token123' }] } }, credentials: { httpBearerAuth: { id: 'c1', name: 'My API' } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 85)).toBe(true)
  })

  it('rule 85: no warning when only credential is used', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0085-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com' }, credentials: { httpBearerAuth: { id: 'c1', name: 'My API' } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 85)).toBe(false)
  })

  // Rule 86: scheduleTrigger cronExpression invalid field count
  it('rule 86: errors when cronExpression has only 4 fields', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0086-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * *' }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 86 && i.severity === 'error')).toBe(true)
  })

  it('rule 86: errors when cronExpression is empty', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0086-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '' }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 86 && i.severity === 'error')).toBe(true)
  })

  it('rule 86: no error for valid 5-field cronExpression', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0086-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 86)).toBe(false)
  })

  // Rule 87: Merge combineByPosition with upstream Filter
  it('rule 87: warns when Merge combineByPosition has upstream Filter node', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0087-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Filter Items', type: 'n8n-nodes-base.filter', typeVersion: 2.2, position: [450, 300], parameters: { conditions: { conditions: [] } } })
    w.nodes.push({ id: 'aaaa0087-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [650, 300], parameters: { mode: 'combineByPosition' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter Items', type: 'main', index: 0 }]] }
    w.connections['Filter Items'] = { main: [[{ node: 'Merge', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 87)).toBe(true)
  })

  it('rule 87: no warning when Merge uses combineByFields', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0087-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Filter Items', type: 'n8n-nodes-base.filter', typeVersion: 2.2, position: [450, 300], parameters: { conditions: { conditions: [] } } })
    w.nodes.push({ id: 'aaaa0087-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [650, 300], parameters: { mode: 'combineByFields' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter Items', type: 'main', index: 0 }]] }
    w.connections['Filter Items'] = { main: [[{ node: 'Merge', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 87)).toBe(false)
  })

  // Rule 88: Telegram sendMessage missing text
  it('rule 88: warns when Telegram sendMessage has no text', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0088-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [450, 300], parameters: { resource: 'message', operation: 'sendMessage', chatId: '123456789', text: '' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Telegram', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 88)).toBe(true)
  })

  it('rule 88: no warning when Telegram sendMessage has text', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0088-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [450, 300], parameters: { resource: 'message', operation: 'sendMessage', chatId: '123456789', text: 'Hello from n8n' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Telegram', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 88)).toBe(false)
  })

  // Rule 84: toolWorkflow source=parameter inline workflow missing executeWorkflowTrigger
  it('rule 84: errors when toolWorkflow source=parameter inline workflow has no executeWorkflowTrigger', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0084-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300],
      parameters: { source: 'parameter', description: 'Does something', workflow: { nodes: [{ id: 'sub-001', name: 'Set Data', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [250, 300], parameters: {} }] } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 84 && i.severity === 'error')).toBe(true)
  })

  it('rule 84: no error when inline workflow has executeWorkflowTrigger', () => {
    const w = baseWorkflow()
    w.nodes.push({
      id: 'aaaa0084-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300],
      parameters: { source: 'parameter', description: 'Does something', workflow: { nodes: [{ id: 'sub-002', name: 'Entry', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [250, 300], parameters: {} }] } },
    })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 84)).toBe(false)
  })

  it('rule 84: does not fire when source=database (Rule 83 domain)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0084-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Tool WF', type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2, position: [450, 300], parameters: { source: 'database', description: 'Does something', workflowId: '42' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 84)).toBe(false)
  })

  // Rule 89: chainRetrievalQa missing ai_retriever
  it('rule 89: errors when chainRetrievalQa has no ai_retriever connection', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0089-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'QA Chain', type: '@n8n/n8n-nodes-langchain.chainRetrievalQa', typeVersion: 1.4, position: [450, 300], parameters: {} })
    w.connections['Manual Trigger'] = { main: [[{ node: 'QA Chain', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 89 && i.severity === 'error')).toBe(true)
  })

  it('rule 89: no error when ai_retriever is connected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0089-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'QA Chain', type: '@n8n/n8n-nodes-langchain.chainRetrievalQa', typeVersion: 1.4, position: [450, 300], parameters: {} })
    w.nodes.push({ id: 'aaaa0089-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Retriever', type: '@n8n/n8n-nodes-langchain.vectorStoreRetriever', typeVersion: 1, position: [450, 500], parameters: {} })
    w.connections['Manual Trigger'] = { main: [[{ node: 'QA Chain', type: 'main', index: 0 }]] }
    w.connections['Retriever'] = { ai_retriever: [[{ node: 'QA Chain', type: 'ai_retriever', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 89)).toBe(false)
  })

  // Rule 90: respondToWebhook without matching webhook responseMode
  it('rule 90: errors when respondToWebhook exists but webhook responseMode is not responseNode', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0090-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { httpMethod: 'POST', path: 'hook', responseMode: 'lastNode' } }
    w.nodes.push({ id: 'aaaa0090-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [450, 300], parameters: {} })
    w.connections['Webhook'] = { main: [[{ node: 'Respond', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 90 && i.severity === 'error')).toBe(true)
  })

  it('rule 90: no error when webhook has responseMode=responseNode', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0090-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { httpMethod: 'POST', path: 'hook', responseMode: 'responseNode' } }
    w.nodes.push({ id: 'aaaa0090-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [450, 300], parameters: {} })
    w.connections['Webhook'] = { main: [[{ node: 'Respond', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 90)).toBe(false)
  })

  it('rule 90: no error when no respondToWebhook node exists', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 90)).toBe(false)
  })

  // Rule 91: filter node empty conditions
  it('rule 91: warns when filter has empty conditions array', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0091-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Filter', type: 'n8n-nodes-base.filter', typeVersion: 2.2, position: [450, 300], parameters: { conditions: { conditions: [] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 91)).toBe(true)
  })

  it('rule 91: warns when filter has no conditions key', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0091-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Filter', type: 'n8n-nodes-base.filter', typeVersion: 2.2, position: [450, 300], parameters: {} })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 91)).toBe(true)
  })

  it('rule 91: no warning when filter has conditions', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0091-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Filter', type: 'n8n-nodes-base.filter', typeVersion: 2.2, position: [450, 300], parameters: { conditions: { conditions: [{ leftValue: '={{ $json.active }}', rightValue: true, operator: { type: 'boolean', operation: 'equals' } }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Filter', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 91)).toBe(false)
  })

  // Rule 92: .toISOString() on Luxon DateTime
  it('rule 92: warns when expression calls $now.toISOString()', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0092-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'ts', value: '={{ $now.toISOString() }}', type: 'string' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 92 && i.severity === 'warn')).toBe(true)
  })

  it('rule 92: errors when expression calls $today.toISOString()', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0092-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'ts', value: '={{ $today.toISOString() }}', type: 'string' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 92)).toBe(true)
  })

  it('rule 92: no error when using correct .toISO()', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0092-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'ts', value: '={{ $now.toISO() }}', type: 'string' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 92)).toBe(false)
  })

  // Rule 93: .format() instead of .toFormat() on Luxon
  it('rule 93: warns when expression calls $now.format()', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0093-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $now.format('YYYY-MM-DD') }}", type: 'string' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 93)).toBe(true)
  })

  it('rule 93: warns when expression calls $today.format()', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0093-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $today.format('DD/MM/YYYY') }}", type: 'string' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 93)).toBe(true)
  })

  it('rule 93: no warning when using correct .toFormat()', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0093-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $now.toFormat('yyyy-MM-dd') }}", type: 'string' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Set', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 93)).toBe(false)
  })

  // Rule 94: toolCode with no executable code
  it('rule 94: warns when toolCode has no jsCode', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0094-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'My Tool', type: '@n8n/n8n-nodes-langchain.toolCode', typeVersion: 1.1, position: [450, 300], parameters: { description: 'Does something' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 94)).toBe(true)
  })

  it('rule 94: warns when toolCode has only comments', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0094-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'My Tool', type: '@n8n/n8n-nodes-langchain.toolCode', typeVersion: 1.1, position: [450, 300], parameters: { description: 'Does something', jsCode: '// TODO: implement' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 94)).toBe(true)
  })

  it('rule 94: no warning when toolCode has executable code', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0094-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'My Tool', type: '@n8n/n8n-nodes-langchain.toolCode', typeVersion: 1.1, position: [450, 300], parameters: { description: 'Does something', jsCode: "return [{ json: { result: $input.first().json.value * 2 } }]" } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 94)).toBe(false)
  })

  // Rule 95: toolHttpRequest no URL
  it('rule 95: errors when toolHttpRequest has no url parameter', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0095-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'HTTP Tool', type: '@n8n/n8n-nodes-langchain.toolHttpRequest', typeVersion: 1.1, position: [450, 300], parameters: { description: 'Fetches data' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 95 && i.severity === 'error')).toBe(true)
  })

  it('rule 95: errors when toolHttpRequest url is empty string', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0095-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'HTTP Tool', type: '@n8n/n8n-nodes-langchain.toolHttpRequest', typeVersion: 1.1, position: [450, 300], parameters: { description: 'Fetches data', url: '' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 95 && i.severity === 'error')).toBe(true)
  })

  it('rule 95: no error when toolHttpRequest has a url', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0095-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'HTTP Tool', type: '@n8n/n8n-nodes-langchain.toolHttpRequest', typeVersion: 1.1, position: [450, 300], parameters: { description: 'Fetches data', url: 'https://api.example.com/search' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 95)).toBe(false)
  })

  // Rule 96: agent has multiple ai_languageModel sub-nodes
  it('rule 96: warns when agent has 2 language model sub-nodes connected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0096-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: { promptType: 'define', text: 'Do the task' } })
    w.nodes.push({ id: 'aaaa0096-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Model A', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [450, 500], parameters: { model: 'claude-sonnet-4-6' } })
    w.nodes.push({ id: 'aaaa0096-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Model B', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.7, position: [650, 500], parameters: { model: 'gpt-4o' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Agent', type: 'main', index: 0 }]] }
    w.connections['Model A'] = { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] }
    w.connections['Model B'] = { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 96)).toBe(true)
  })

  it('rule 96: no warning when agent has exactly one language model', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0096-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: { promptType: 'define', text: 'Do the task' } })
    w.nodes.push({ id: 'aaaa0096-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'Model A', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [450, 500], parameters: { model: 'claude-sonnet-4-6' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Agent', type: 'main', index: 0 }]] }
    w.connections['Model A'] = { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 96)).toBe(false)
  })

  // Rule 97: vectorStore missing ai_embedding sub-node
  it('rule 97: errors when vectorStore has no ai_embedding connection', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0097-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Pinecone Store', type: '@n8n/n8n-nodes-langchain.vectorStorePinecone', typeVersion: 1, position: [450, 300], parameters: {} })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 97 && i.severity === 'error')).toBe(true)
  })

  it('rule 97: no error when vectorStore has ai_embedding connected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0097-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Pinecone Store', type: '@n8n/n8n-nodes-langchain.vectorStorePinecone', typeVersion: 1, position: [450, 300], parameters: {} })
    w.nodes.push({ id: 'aaaa0097-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Embeddings', type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi', typeVersion: 1, position: [450, 500], parameters: {} })
    w.connections['Embeddings'] = { ai_embedding: [[{ node: 'Pinecone Store', type: 'ai_embedding', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 97)).toBe(false)
  })

  it('rule 97: no error for non-vectorStore node types', () => {
    const result = validator.validate(baseWorkflow())
    expect(result.issues.some((i) => i.rule === 97)).toBe(false)
  })

  // Rule 98: outputParserStructured missing JSON schema
  it('rule 98: errors when outputParserStructured has no jsonSchema', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0098-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1, position: [450, 300], parameters: {} })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 98 && i.severity === 'error')).toBe(true)
  })

  it('rule 98: errors when outputParserStructured has empty schema object', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0098-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1, position: [450, 300], parameters: { jsonSchema: {} } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 98)).toBe(true)
  })

  it('rule 98: no error when outputParserStructured has a schema', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0098-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1, position: [450, 300], parameters: { jsonSchema: { type: 'object', properties: { name: { type: 'string' } } } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 98)).toBe(false)
  })

  // Rule 99: chainLlm with output parser but missing {format_instructions}
  it('rule 99: warns when chainLlm has output parser connected but prompt lacks {format_instructions}', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0099-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'My Chain', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.5, position: [450, 300], parameters: { prompt: 'Answer the question: {question}' } })
    w.nodes.push({ id: 'aaaa0099-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'My Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1, position: [450, 500], parameters: { jsonSchema: { type: 'object' } } })
    ;(w.connections as Record<string, unknown>)['My Parser'] = { ai_outputParser: [[{ node: 'My Chain', type: 'ai_outputParser', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 99 && i.severity === 'warn')).toBe(true)
  })

  it('rule 99: no warning when prompt contains {format_instructions}', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0099-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'My Chain', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.5, position: [450, 300], parameters: { prompt: 'Answer the question: {question}\n\n{format_instructions}' } })
    w.nodes.push({ id: 'aaaa0099-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'My Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1, position: [450, 500], parameters: { jsonSchema: { type: 'object' } } })
    ;(w.connections as Record<string, unknown>)['My Parser'] = { ai_outputParser: [[{ node: 'My Chain', type: 'ai_outputParser', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 99)).toBe(false)
  })

  it('rule 99: no warning when prompt is an expression (cannot inspect)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0099-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'My Chain', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.5, position: [450, 300], parameters: { prompt: '={{ $json.promptTemplate }}' } })
    w.nodes.push({ id: 'aaaa0099-aaaa-4aaa-aaaa-aaaaaaaaaaaf', name: 'My Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1, position: [450, 500], parameters: { jsonSchema: { type: 'object' } } })
    ;(w.connections as Record<string, unknown>)['My Parser'] = { ai_outputParser: [[{ node: 'My Chain', type: 'ai_outputParser', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 99)).toBe(false)
  })

  it('rule 99: no warning when chainLlm has no output parser connected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0099-aaaa-4aaa-aaaa-aaaaaaaaaaag', name: 'My Chain', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.5, position: [450, 300], parameters: { prompt: 'Just answer: {question}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 99)).toBe(false)
  })

  // Rule 100: Postgres/MySQL empty query
  it('rule 100: errors when postgres executeQuery has empty query', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0100-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'DB', type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [450, 300], parameters: { operation: 'executeQuery', query: '' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'DB', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 100 && i.severity === 'error')).toBe(true)
  })

  it('rule 100: errors when mySql executeQuery has no query', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0100-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'DB', type: 'n8n-nodes-base.mySql', typeVersion: 2.4, position: [450, 300], parameters: { operation: 'executeQuery' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'DB', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 100 && i.severity === 'error')).toBe(true)
  })

  it('rule 100: no error when postgres has a valid query', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0100-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'DB', type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [450, 300], parameters: { operation: 'executeQuery', query: 'SELECT * FROM customers' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'DB', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 100)).toBe(false)
  })

  it('rule 100: no error when query is an expression', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0100-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'DB', type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [450, 300], parameters: { operation: 'executeQuery', query: '={{ $json.query }}' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'DB', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 100)).toBe(false)
  })

  // Rule 101: formTrigger with no form fields
  it('rule 101: warns when formTrigger has no form fields', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0101-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Form', type: 'n8n-nodes-base.formTrigger', typeVersion: 2.2, position: [250, 300], parameters: { formTitle: 'My Form', formFields: { values: [] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 101)).toBe(true)
  })

  it('rule 101: warns when formTrigger has no formFields key at all', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0101-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Form', type: 'n8n-nodes-base.formTrigger', typeVersion: 2.2, position: [250, 300], parameters: { formTitle: 'My Form' } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 101)).toBe(true)
  })

  it('rule 101: no warning when formTrigger has form fields', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0101-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Form', type: 'n8n-nodes-base.formTrigger', typeVersion: 2.2, position: [250, 300], parameters: { formTitle: 'My Form', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text', requiredField: false }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 101)).toBe(false)
  })

  // Rule 102: splitOut missing fieldToSplitOut
  it('rule 102: errors when splitOut has no fieldToSplitOut', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0102-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [450, 300], parameters: {} })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 102 && i.severity === 'error')).toBe(true)
  })

  it('rule 102: errors when fieldToSplitOut is empty string', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0102-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [450, 300], parameters: { fieldToSplitOut: '' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 102 && i.severity === 'error')).toBe(true)
  })

  it('rule 102: no error when fieldToSplitOut is set', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0102-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [450, 300], parameters: { fieldToSplitOut: 'items' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 102)).toBe(false)
  })

  it('rule 102: no error when fieldToSplitOut is an expression', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0102-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [450, 300], parameters: { fieldToSplitOut: '={{ $json.arrayField }}' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 102)).toBe(false)
  })

  // Rule 103: Code node returns items without json wrapper
  it('rule 103: warns when code node returns array without json wrapper', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0103-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: 'return [{ name: "Alice", email: "alice@example.com" }]' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Transform', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 103 && i.severity === 'warn')).toBe(true)
  })

  it('rule 103: no warning when code node uses json wrapper', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0103-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: 'return [{ json: { name: "Alice", email: "alice@example.com" } }]' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Transform', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 103)).toBe(false)
  })

  it('rule 103: no warning when code node uses return items passthrough', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0103-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: 'for (const item of $input.all()) { item.json.processed = true }\nreturn items' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Transform', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 103)).toBe(false)
  })

  it('rule 103: no warning when code node has no return statement', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0103-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: '// no return' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Transform', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 103)).toBe(false)
  })

  // Rule 105: LM model set to invalid alias
  it('rule 105: errors when lmChatAnthropic model is "latest"', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0105-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Model', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [450, 300], parameters: { model: 'latest' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 105 && i.severity === 'error')).toBe(true)
  })

  it('rule 105: errors when lmChatOpenAi model is "default"', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0105-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.7, position: [450, 300], parameters: { model: 'default' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 105 && i.severity === 'error')).toBe(true)
  })

  it('rule 105: no error when model is a real identifier', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0105-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Model', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [450, 300], parameters: { model: 'claude-sonnet-4-6' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 105)).toBe(false)
  })

  // Rule 106: Switch fallbackOutput enabled but fallback port unwired
  it('rule 106: warns when Switch fallback is enabled but fallback port has no connection', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0106-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [450, 300], parameters: { mode: 'rules', rules: { rules: [{ conditions: { conditions: [{ leftValue: '={{ $json.type }}', rightValue: 'A', operator: { type: 'string', operation: 'equals' } }] } }] }, fallbackOutput: 'extra' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Switch', type: 'main', index: 0 }]] }
    // Only wire route 0, not the fallback (port 1)
    w.connections['Switch'] = { main: [[{ node: 'Manual Trigger', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 106)).toBe(true)
  })

  it('rule 106: no warning when fallbackOutput is "none"', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0106-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [450, 300], parameters: { mode: 'rules', rules: { rules: [] }, fallbackOutput: 'none' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Switch', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 106)).toBe(false)
  })

  it('rule 106: no warning when fallback port is connected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0106-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [450, 300], parameters: { mode: 'rules', rules: { rules: [{ conditions: { conditions: [] } }] }, fallbackOutput: 'extra' } })
    w.nodes.push({ id: 'aaaa0106-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'No Op', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [650, 300], parameters: {} })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Switch', type: 'main', index: 0 }]] }
    // Wire route 0 and fallback (port 1)
    w.connections['Switch'] = { main: [[{ node: 'Manual Trigger', type: 'main', index: 0 }], [{ node: 'No Op', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 106)).toBe(false)
  })

  // Rule 107: trigger node expression references $json
  it('rule 107: warns when scheduleTrigger expression references $json', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0107-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '={{ $json.schedule }}' }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 107)).toBe(true)
  })

  it('rule 107: no warning when trigger expression does not reference $json', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0107-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }] } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 107)).toBe(false)
  })

  it('rule 107: no warning for chatTrigger (skipped)', () => {
    const w = baseWorkflow()
    w.nodes[0] = { id: 'aaaa0107-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, position: [250, 300], parameters: { options: { systemMessage: '={{ $json.prompt }}' } } }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 107)).toBe(false)
  })

  // Rule 108: aggregate node in field-specific mode with no fields
  it('rule 108: warns when aggregate is field-specific with no fields', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0108-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Aggregate', type: 'n8n-nodes-base.aggregate', typeVersion: 1, position: [450, 300], parameters: { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 108)).toBe(true)
  })

  it('rule 108: no warning when aggregate mode is aggregateAllItemData', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0108-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Aggregate', type: 'n8n-nodes-base.aggregate', typeVersion: 1, position: [450, 300], parameters: { aggregate: 'aggregateAllItemData' } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 108)).toBe(false)
  })

  it('rule 108: no warning when aggregate has fields defined', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0108-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Aggregate', type: 'n8n-nodes-base.aggregate', typeVersion: 1, position: [450, 300], parameters: { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'email', renameField: false }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 108)).toBe(false)
  })

  // Rule 109: Airtable create/update/upsert with no field mappings
  it('rule 109: warns when Airtable create has no field mappings', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0109-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Airtable', type: 'n8n-nodes-base.airtable', typeVersion: 2.1, position: [450, 300], parameters: { operation: 'create', base: { __rl: true, mode: 'id', value: 'app123' }, table: { __rl: true, mode: 'id', value: 'tbl123' }, fieldsUi: { fieldValues: [] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Airtable', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 109)).toBe(true)
  })

  it('rule 109: no warning for Airtable get operation', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0109-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Airtable', type: 'n8n-nodes-base.airtable', typeVersion: 2.1, position: [450, 300], parameters: { operation: 'get', base: { __rl: true, mode: 'id', value: 'app123' }, table: { __rl: true, mode: 'id', value: 'tbl123' } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Airtable', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 109)).toBe(false)
  })

  it('rule 109: no warning when Airtable create has field mappings', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0109-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Airtable', type: 'n8n-nodes-base.airtable', typeVersion: 2.1, position: [450, 300], parameters: { operation: 'create', fieldsUi: { fieldValues: [{ fieldId: 'Name', fieldValue: '={{ $json.name }}' }] } } })
    w.connections['Manual Trigger'] = { main: [[{ node: 'Airtable', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 109)).toBe(false)
  })

  // Rule 110: agent promptType=define with empty text
  it('rule 110: warns when agent has promptType define but empty text', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0110-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: { promptType: 'define', text: '' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 110 && i.severity === 'warn')).toBe(true)
  })

  it('rule 110: warns when agent has promptType define but no text field', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0110-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: { promptType: 'define' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 110)).toBe(true)
  })

  it('rule 110: no warning when agent has promptType define with populated text', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0110-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: { promptType: 'define', text: 'Summarize the following: {{ $json.content }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 110)).toBe(false)
  })

  it('rule 110: no warning when text is an expression', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0110-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: { promptType: 'define', text: '={{ $json.userMessage }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 110)).toBe(false)
  })

  it('rule 110: no warning when promptType is auto', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0110-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: { promptType: 'auto' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 110)).toBe(false)
  })

  // Rule 111: ai_languageModel targets a non-agent/chain node
  it('rule 111: warns when ai_languageModel is wired to a Set node', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0111-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'OpenAI Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.7, position: [450, 500], parameters: { model: 'gpt-4o' } })
    w.nodes.push({ id: 'aaaa0111-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set Data', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: {} })
    ;(w.connections as Record<string, unknown>)['OpenAI Model'] = { ai_languageModel: [[{ node: 'Set Data', type: 'ai_languageModel', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 111 && i.severity === 'warn')).toBe(true)
  })

  it('rule 111: no warning when ai_languageModel targets an agent node', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0111-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'OpenAI Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.7, position: [450, 500], parameters: { model: 'gpt-4o' } })
    w.nodes.push({ id: 'aaaa0111-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.9, position: [450, 300], parameters: {} })
    ;(w.connections as Record<string, unknown>)['OpenAI Model'] = { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 111)).toBe(false)
  })

  // Rule 112: Luxon .add()/.subtract() in expressions
  it('rule 112: errors when $now.add() is used', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0112-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set Date', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $now.add(1, 'day') }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 112 && i.severity === 'error')).toBe(true)
  })

  it('rule 112: errors when $today.subtract() is used', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0112-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set Date', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $today.subtract(7, 'days') }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 112 && i.severity === 'error')).toBe(true)
  })

  it('rule 112: no error when using correct .plus() form', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0112-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Set Date', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: '={{ $now.plus({ days: 1 }).toISO() }}', type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 112)).toBe(false)
  })

  // Rule 113: IF node with unconnected output branch
  it('rule 113: warns when IF true branch is unconnected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0113-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [450, 300], parameters: { conditions: { conditions: [{ id: '1', leftValue: '={{ $json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }] }, combinator: 'and' } })
    ;(w.connections as Record<string, unknown>)['Manual Trigger'] = { main: [[{ node: 'Check', type: 'main', index: 0 }]] }
    // Only false branch connected
    ;(w.connections as Record<string, unknown>)['Check'] = { main: [[], [{ node: 'Manual Trigger', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    const r113 = result.issues.filter((i) => i.rule === 113)
    expect(r113.some((i) => i.message.includes('true'))).toBe(true)
  })

  it('rule 113: warns when IF false branch is unconnected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0113-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [450, 300], parameters: { conditions: { conditions: [{ id: '1', leftValue: '={{ $json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }] }, combinator: 'and' } })
    w.nodes.push({ id: 'aaaa0113-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Handler', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [670, 300], parameters: {} })
    ;(w.connections as Record<string, unknown>)['Check'] = { main: [[{ node: 'Handler', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 113 && i.message.includes('false'))).toBe(true)
  })

  it('rule 113: no warning when both IF branches are connected', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0113-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [450, 300], parameters: {} })
    w.nodes.push({ id: 'aaaa0113-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'TrueHandler', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [670, 200], parameters: {} })
    w.nodes.push({ id: 'aaaa0113-aaaa-4aaa-aaaa-aaaaaaaaaaaf', name: 'FalseHandler', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [670, 400], parameters: {} })
    ;(w.connections as Record<string, unknown>)['Check'] = { main: [[{ node: 'TrueHandler', type: 'main', index: 0 }], [{ node: 'FalseHandler', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 113)).toBe(false)
  })

  // Rule 114: $('NodeName') references non-existent node in expressions
  it('rule 114: warns when expression references a missing node', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0114-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set Data', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'email', value: "={{ $('Deleted Node').first().json.email }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 114 && i.severity === 'warn')).toBe(true)
  })

  it('rule 114: no warning when referenced node exists', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0114-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set Data', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'email', value: "={{ $('Manual Trigger').first().json.email }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 114)).toBe(false)
  })

  it('rule 114: no warning for code nodes (covered by Rule 67)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0114-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: "return [{ json: { v: $('Ghost Node').first().json.x } }]" } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 114)).toBe(false)
  })

  // Rule 115: SplitInBatches output 1 has no loop-back
  it('rule 115: warns when SplitInBatches loop body has no loop-back', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0115-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Split', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } })
    w.nodes.push({ id: 'aaaa0115-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Process', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [670, 400], parameters: {} })
    ;(w.connections as Record<string, unknown>)['Split'] = { main: [[], [{ node: 'Process', type: 'main', index: 0 }]] }
    // Process does NOT loop back to Split
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 115 && i.severity === 'warn')).toBe(true)
  })

  it('rule 115: no warning when loop-back is present', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0115-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Split', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } })
    w.nodes.push({ id: 'aaaa0115-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Process', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [670, 400], parameters: {} })
    ;(w.connections as Record<string, unknown>)['Split'] = { main: [[], [{ node: 'Process', type: 'main', index: 0 }]] }
    ;(w.connections as Record<string, unknown>)['Process'] = { main: [[{ node: 'Split', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 115)).toBe(false)
  })

  // Rule 116: LM sub-node using wrong-provider model name
  it('rule 116: errors when lmChatOpenAi uses a Claude model', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0116-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'LM', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.7, position: [450, 300], parameters: { model: 'claude-sonnet-4-6' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 116 && i.severity === 'error')).toBe(true)
  })

  it('rule 116: errors when lmChatAnthropic uses a GPT model', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0116-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'LM', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [450, 300], parameters: { model: 'gpt-4o' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 116 && i.severity === 'error')).toBe(true)
  })

  it('rule 116: no error when model matches the provider', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0116-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'LM', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [450, 300], parameters: { model: 'claude-sonnet-4-6' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 116)).toBe(false)
  })

  it('rule 116: no error when model is an expression', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0116-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'LM', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.7, position: [450, 300], parameters: { model: '={{ $json.model }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 116)).toBe(false)
  })

  // Rule 117: Google Calendar create event missing start or end time
  it('rule 117: warns when googleCalendar create event has no start time', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0117-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Cal', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [450, 300], parameters: { resource: 'event', operation: 'create', end: '2026-07-01T10:00:00Z' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 117 && i.message.includes('start'))).toBe(true)
  })

  it('rule 117: warns when googleCalendar create event has no end time', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0117-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Cal', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [450, 300], parameters: { resource: 'event', operation: 'create', start: '2026-07-01T09:00:00Z' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 117 && i.message.includes('end'))).toBe(true)
  })

  it('rule 117: no warning when both start and end are set', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0117-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Cal', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [450, 300], parameters: { resource: 'event', operation: 'create', start: '2026-07-01T09:00:00Z', end: '2026-07-01T10:00:00Z' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 117)).toBe(false)
  })

  it('rule 117: no warning for googleCalendar get operation', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0117-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Cal', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [450, 300], parameters: { resource: 'event', operation: 'get' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 117)).toBe(false)
  })

  // Rule 118: Redis missing key parameter
  it('rule 118: warns when Redis get has no propertyName', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0118-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Redis', type: 'n8n-nodes-base.redis', typeVersion: 1, position: [450, 300], parameters: { operation: 'get' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 118 && i.severity === 'warn')).toBe(true)
  })

  it('rule 118: warns when Redis set has empty propertyName', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0118-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Redis', type: 'n8n-nodes-base.redis', typeVersion: 1, position: [450, 300], parameters: { operation: 'set', propertyName: '' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 118)).toBe(true)
  })

  it('rule 118: no warning when Redis get has a key', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0118-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Redis', type: 'n8n-nodes-base.redis', typeVersion: 1, position: [450, 300], parameters: { operation: 'get', propertyName: 'session:{{ $json.userId }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 118)).toBe(false)
  })

  // Rule 119: Supabase missing tableId
  it('rule 119: errors when supabase node has no tableId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0119-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'DB', type: 'n8n-nodes-base.supabase', typeVersion: 1, position: [450, 300], parameters: { operation: 'insert' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 119 && i.severity === 'error')).toBe(true)
  })

  it('rule 119: no error when supabase node has tableId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0119-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'DB', type: 'n8n-nodes-base.supabase', typeVersion: 1, position: [450, 300], parameters: { operation: 'insert', tableId: 'leads' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 119)).toBe(false)
  })

  // Rule 120: Gmail reply missing messageId
  it('rule 120: warns when Gmail reply has no messageId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0120-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [450, 300], parameters: { operation: 'reply', sendTo: 'user@example.com' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 120 && i.severity === 'warn')).toBe(true)
  })

  it('rule 120: no warning when Gmail reply has messageId', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0120-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [450, 300], parameters: { operation: 'reply', messageId: '={{ $json.id }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 120)).toBe(false)
  })

  it('rule 120: no warning for Gmail send operation', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0120-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [450, 300], parameters: { operation: 'send', sendTo: 'user@example.com', subject: 'Hello', message: 'World' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 120)).toBe(false)
  })

  // Rule 121: splitOut fieldToSplitOut contains a dot
  it('rule 121: warns when fieldToSplitOut contains a dot', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0121-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [450, 300], parameters: { fieldToSplitOut: 'data.items' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 121 && i.severity === 'warn')).toBe(true)
  })

  it('rule 121: no warning when fieldToSplitOut has no dot', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0121-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [450, 300], parameters: { fieldToSplitOut: 'items' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 121)).toBe(false)
  })

  it('rule 121: no warning when fieldToSplitOut is an expression', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0121-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [450, 300], parameters: { fieldToSplitOut: '={{ $json.fieldName }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 121)).toBe(false)
  })

  // Rule 122: Luxon .plus()/.minus() with positional args
  it('rule 122: warns when .plus() is called with positional (n, unit) args', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0122-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $now.plus(7, 'days') }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 122 && i.severity === 'warn')).toBe(true)
  })

  it('rule 122: no warning when .plus() uses object form', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0122-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: '={{ $now.plus({ days: 7 }).toISO() }}', type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 122)).toBe(false)
  })

  it('rule 122: no warning when .plus() has single arg (valid ms form)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0122-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: '={{ $now.plus(1000).toISO() }}', type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 122)).toBe(false)
  })

  // Rule 123: HTTP Request sendQuery=true but no query parameters
  it('rule 123: warns when sendQuery is true but queryParameters is empty', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0123-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com/data', sendQuery: true } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 123 && i.severity === 'warn')).toBe(true)
  })

  it('rule 123: no warning when query parameters are populated', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0123-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com/data', sendQuery: true, queryParameters: { parameters: [{ name: 'page', value: '1' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 123)).toBe(false)
  })

  it('rule 123: no warning when queryParametersJson provides dynamic params', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0123-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com/data', sendQuery: true, queryParametersJson: '={{ $json.queryParams }}' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 123)).toBe(false)
  })

  it('rule 123: no warning when sendQuery is false', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0123-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com/data', sendQuery: false } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 123)).toBe(false)
  })

  // Rule 124: Code node in runOnceForAllItems mode with no return statement
  it('rule 124: warns when runOnceForAllItems code has no return', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0124-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { mode: 'runOnceForAllItems', jsCode: 'const x = $input.all().length\nconsole.log(x)' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 124 && i.severity === 'warn')).toBe(true)
  })

  it('rule 124: no warning when runOnceForAllItems code has a return', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0124-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { mode: 'runOnceForAllItems', jsCode: 'return $input.all().map(i => ({ json: i.json }))' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 124)).toBe(false)
  })

  it('rule 124: no warning in default (runOnceForEachItem) mode with no return', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0124-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: 'const x = $json.value * 2' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 124)).toBe(false)
  })

  // Rule 125: Luxon uppercase YYYY/DD tokens in .toFormat()
  it('rule 125: warns when .toFormat() uses YYYY token', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0125-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $now.toFormat('YYYY-MM-dd') }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 125 && i.severity === 'warn')).toBe(true)
  })

  it('rule 125: warns when .toFormat() uses DD token', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0125-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $now.toFormat('DD/MM/yyyy') }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 125)).toBe(true)
  })

  it('rule 125: no warning when .toFormat() uses correct lowercase tokens', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0125-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { assignments: { assignments: [{ id: '1', name: 'date', value: "={{ $now.toFormat('yyyy-MM-dd') }}", type: 'string' }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 125)).toBe(false)
  })

  // Rule 126: Node ID not a valid UUID v4
  it('rule 126: warns when node has a non-UUID ID', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'node-1', name: 'Set Data', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: {} })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 126 && i.severity === 'warn')).toBe(true)
  })

  it('rule 126: no warning when node has a valid UUID v4', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'a1b2c3d4-e5f6-4789-8abc-def012345678', name: 'Set Data', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: {} })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 126)).toBe(false)
  })

  it('rule 126: no warning for the base workflow nodes (they have valid UUIDs)', () => {
    const w = baseWorkflow()
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 126)).toBe(false)
  })

  // Rule 127: Code node language/param mismatch (Phase 4 — n8n-skills gap analysis)
  it('rule 127: warns when language is python but code is set in jsCode', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0127-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { language: 'python', jsCode: 'return [{"json": {}}]' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 127 && i.severity === 'warn')).toBe(true)
  })

  it('rule 127: warns when pythonCode is set but language is not python', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0127-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { pythonCode: 'return [{"json": {}}]' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 127 && i.severity === 'warn')).toBe(true)
  })

  it('rule 127: no warning when language is python and pythonCode is populated', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0127-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { language: 'python', pythonCode: 'return [{"json": {}}]' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 127)).toBe(false)
  })

  it('rule 127: no warning for the default JavaScript case (jsCode set, no language)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0127-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: 'return [{ json: {} }]' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 127)).toBe(false)
  })

  it('rule 127: does not fire on non-code nodes', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0127-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { language: 'python' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 127)).toBe(false)
  })

  // Rule 128: unwired error-output port (Phase 4 — n8n-skills gap analysis)
  it('rule 128: warns when continueErrorOutput is set but output index 1 is unwired', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Risky Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], onError: 'continueErrorOutput', parameters: { method: 'GET', url: 'https://api.example.com' } })
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'On Success', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [650, 300], parameters: {} })
    w.connections['Risky Call'] = { main: [[{ node: 'On Success', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 128 && i.severity === 'warn')).toBe(true)
  })

  it('rule 128: no warning when both output ports are wired', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Risky Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], onError: 'continueErrorOutput', parameters: { method: 'GET', url: 'https://api.example.com' } })
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'On Success', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [650, 250], parameters: {} })
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'On Error', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [650, 400], parameters: {} })
    w.connections['Risky Call'] = { main: [[{ node: 'On Success', type: 'main', index: 0 }], [{ node: 'On Error', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 128)).toBe(false)
  })

  it('rule 128: no warning when onError is continueRegularOutput', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaaaf', name: 'Risky Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], onError: 'continueRegularOutput', parameters: { method: 'GET', url: 'https://api.example.com' } })
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaaba', name: 'Next', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [650, 300], parameters: {} })
    w.connections['Risky Call'] = { main: [[{ node: 'Next', type: 'main', index: 0 }]] }
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 128)).toBe(false)
  })

  it('rule 128: no warning when onError is unset entirely', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaabb', name: 'Plain Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 128)).toBe(false)
  })

  it('rule 128: reads onError from the top-level node field, not from parameters (regression — onError is a real n8n INode field, not a node parameter)', () => {
    const w = baseWorkflow()
    // Wrong shape: onError nested inside parameters. Real n8n never puts it there
    // (confirmed against n8n-workflow's INode interface), so this must not trigger.
    w.nodes.push({ id: 'aaaa0128-aaaa-4aaa-aaaa-aaaaaaaaaabc', name: 'Misplaced', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: { method: 'GET', url: 'https://api.example.com', onError: 'continueErrorOutput' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 128)).toBe(false)
  })

  // Rule 129: resource/operation value doesn't exist for the node type (Phase 5 — generated node catalog)
  it('rule 129: warns when resource is not valid for the node type', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0129-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [450, 300], parameters: { resource: 'channels', operation: 'create' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 129 && i.severity === 'warn' && i.message.includes('"channels"'))).toBe(true)
  })

  it('rule 129: warns when operation is not valid for the node type', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0129-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [450, 300], parameters: { resource: 'channel', operation: 'destroy' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 129 && i.severity === 'warn' && i.message.includes('"destroy"'))).toBe(true)
  })

  it('rule 129: no warning when resource and operation are both valid', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0129-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [450, 300], parameters: { resource: 'channel', operation: 'create' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 129)).toBe(false)
  })

  it('rule 129: no warning for a node type with no generated catalog entry', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0129-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { resource: 'anything', operation: 'anything' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 129)).toBe(false)
  })

  it('rule 129: no warning when resource/operation params are not set', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0129-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [450, 300], parameters: {} })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 129)).toBe(false)
  })

  // Rule 130: AWS S3 / Slack file upload missing binaryPropertyName (Phase 4 judgment call #2 — Rule 57's pattern, extended)
  it('rule 130: warns when AWS S3 file upload has empty binaryPropertyName', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Upload to S3', type: 'n8n-nodes-base.awsS3', typeVersion: 2, position: [450, 300], parameters: { resource: 'file', operation: 'upload', binaryData: true, binaryPropertyName: '' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130 && i.severity === 'warn')).toBe(true)
  })

  it('rule 130: no warning when AWS S3 file upload has binaryPropertyName set', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaaab', name: 'Upload to S3', type: 'n8n-nodes-base.awsS3', typeVersion: 2, position: [450, 300], parameters: { resource: 'file', operation: 'upload', binaryData: true, binaryPropertyName: 'data' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130)).toBe(false)
  })

  it('rule 130: no warning for AWS S3 when binaryData toggle is false (text content, not binary)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaaac', name: 'Upload to S3', type: 'n8n-nodes-base.awsS3', typeVersion: 2, position: [450, 300], parameters: { resource: 'file', operation: 'upload', binaryData: false, fileContent: 'hello' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130)).toBe(false)
  })

  it('rule 130: warns when Slack file upload (typeVersion 2.2+) has empty binaryPropertyName, no toggle needed', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaaad', name: 'Upload to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [450, 300], parameters: { resource: 'file', operation: 'upload', binaryPropertyName: '' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130 && i.severity === 'warn')).toBe(true)
  })

  it('rule 130: no warning when Slack file upload (typeVersion 2.2+) has binaryPropertyName set', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaaae', name: 'Upload to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [450, 300], parameters: { resource: 'file', operation: 'upload', binaryPropertyName: 'data' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130)).toBe(false)
  })

  it('rule 130: no warning for Slack typeVersion 2 (legacy) when binaryData toggle is unset (defaults to text, not binary)', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaaaf', name: 'Upload to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2, position: [450, 300], parameters: { resource: 'file', operation: 'upload', binaryPropertyName: '' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130)).toBe(false)
  })

  it('rule 130: warns for Slack typeVersion 2 (legacy) when binaryData toggle is true and binaryPropertyName is empty', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaaba', name: 'Upload to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2, position: [450, 300], parameters: { resource: 'file', operation: 'upload', binaryData: true, binaryPropertyName: '' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130 && i.severity === 'warn')).toBe(true)
  })

  it('rule 130: does not fire for other resource/operation combos', () => {
    const w = baseWorkflow()
    w.nodes.push({ id: 'aaaa0130-aaaa-4aaa-aaaa-aaaaaaaaaabb', name: 'Post Message', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [450, 300], parameters: { resource: 'message', operation: 'post' } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 130)).toBe(false)
  })

  // Rule 131: long unbranched node chain — consolidation opportunity
  function pushSetNodes(w: N8nWorkflow, count: number): void {
    for (let i = 0; i < count; i++) {
      w.nodes.push({
        id: `bbbb0131-aaaa-4aaa-aaaa-${String(i).padStart(12, '0')}`,
        name: `Set ${i}`,
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [450 + i * 100, 300],
        parameters: { assignments: { assignments: [] } },
      })
    }
  }

  it('rule 131: warns when workflow has 15+ nodes with no branching logic', () => {
    const w = baseWorkflow()
    pushSetNodes(w, 14) // 1 (trigger) + 14 = 15, hits the threshold
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 131)).toBe(true)
  })

  it('rule 131: no warning below the 15-node threshold', () => {
    const w = baseWorkflow()
    pushSetNodes(w, 5) // 1 + 5 = 6, well under threshold
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 131)).toBe(false)
  })

  it('rule 131: no warning when the workflow branches, even with 15+ nodes', () => {
    const w = baseWorkflow()
    pushSetNodes(w, 13)
    w.nodes.push({ id: 'bbbb0131-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Check Status', type: 'n8n-nodes-base.if', typeVersion: 2, position: [450, 600], parameters: { conditions: { conditions: [{ leftValue: '={{ $json.x }}', rightValue: 1, operator: { type: 'number', operation: 'equals' } }] } } })
    const result = validator.validate(w)
    expect(result.issues.some((i) => i.rule === 131)).toBe(false)
  })
})
