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
})
