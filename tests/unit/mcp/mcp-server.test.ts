import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { resolve } from 'path'

const SERVER_PATH = resolve(__dirname, '../../../dist/mcp-server.js')

interface McpClient {
  proc: ChildProcess
  send: (msg: object) => void
  waitForResponse: (id: number) => Promise<Record<string, unknown>>
  close: () => void
}

function startMcpServer(): McpClient {
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, N8N_BASE_URL: undefined, N8N_API_KEY: undefined },
  })

  let buffer = ''
  const responses = new Map<number, Record<string, unknown>>()
  const waiters = new Map<number, (v: Record<string, unknown>) => void>()

  proc.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as Record<string, unknown>
      const id = parsed['id'] as number
      responses.set(id, parsed)
      waiters.get(id)?.(parsed)
      waiters.delete(id)
    }
  })

  return {
    proc,
    send(msg: object) {
      proc.stdin!.write(JSON.stringify(msg) + '\n')
    },
    waitForResponse(id: number): Promise<Record<string, unknown>> {
      const existing = responses.get(id)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve) => { waiters.set(id, resolve) })
    },
    close() {
      proc.kill()
    },
  }
}

describe('Kairos MCP Server', () => {
  let client: McpClient

  beforeAll(async () => {
    client = startMcpServer()
    client.send({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    })
    await client.waitForResponse(0)
  }, 30_000)

  afterAll(() => {
    client.close()
  })

  it('lists all expected tools', async () => {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const resp = await client.waitForResponse(1)
    const result = resp['result'] as { tools: Array<{ name: string }> }
    const names = result.tools.map(t => t.name)

    expect(names).toContain('kairos_prompt')
    expect(names).toContain('kairos_validate')
    expect(names).toContain('kairos_deploy')
    expect(names).toContain('kairos_search')
    expect(names).toContain('kairos_list')
    expect(names).toContain('kairos_get')
    expect(names).toContain('kairos_activate')
    expect(names).toContain('kairos_deactivate')
    expect(names).toContain('kairos_delete')
    expect(names).toContain('kairos_executions')
    expect(names).toContain('kairos_sync')
    expect(names).toHaveLength(11)
  })

  it('kairos_prompt requires n8n credentials', async () => {
    client.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'kairos_prompt',
        arguments: { description: 'Send a Slack message when a webhook fires' },
      },
    })
    const resp = await client.waitForResponse(2)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)

    expect(result.isError).toBe(true)
    expect(content.error).toContain('N8N_BASE_URL')
  })

  it('kairos_validate passes a valid workflow', async () => {
    const workflow = JSON.stringify({
      name: 'Test Workflow',
      nodes: [{
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        name: 'Webhook',
        position: [250, 300],
        parameters: { httpMethod: 'POST', path: 'test' },
      }],
      connections: {},
      settings: { executionOrder: 'v1' },
    })

    client.send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'kairos_validate', arguments: { workflow } },
    })
    const resp = await client.waitForResponse(3)
    const result = resp['result'] as { content: Array<{ text: string }> }
    const content = JSON.parse(result.content[0].text)

    expect(content.valid).toBe(true)
    expect(content.errorCount).toBe(0)
    expect(content.deployable).toBe(true)
  })

  it('kairos_validate catches errors in invalid workflow', async () => {
    const workflow = JSON.stringify({
      name: '',
      nodes: [
        { id: 'same', type: 'n8n-nodes-base.set', typeVersion: 3.4, name: 'Set', position: [250, 300], parameters: {} },
        { id: 'same', type: 'n8n-nodes-base.set', typeVersion: 3.4, name: 'Set', position: [470, 300], parameters: {} },
      ],
      connections: {},
      settings: {},
    })

    client.send({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'kairos_validate', arguments: { workflow } },
    })
    const resp = await client.waitForResponse(4)
    const result = resp['result'] as { content: Array<{ text: string }> }
    const content = JSON.parse(result.content[0].text)

    expect(content.valid).toBe(false)
    expect(content.errorCount).toBeGreaterThanOrEqual(3)
    expect(content.deployable).toBe(false)

    const rules = content.errors.map((e: { rule: number }) => e.rule)
    expect(rules).toContain(1)
    expect(rules).toContain(4)
    expect(rules).toContain(14)
    expect(rules).toContain(16)
  })

  it('kairos_validate rejects invalid JSON', async () => {
    client.send({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'kairos_validate', arguments: { workflow: 'not json' } },
    })
    const resp = await client.waitForResponse(5)
    const result = resp['result'] as { content: Array<{ text: string }> }
    const content = JSON.parse(result.content[0].text)

    expect(content.valid).toBe(false)
    expect(content.error).toContain('Invalid JSON')
  })

  it('kairos_deploy is blocked by default', async () => {
    client.send({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'kairos_deploy', arguments: { workflow: '{}' } },
    })
    const resp = await client.waitForResponse(6)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)

    expect(result.isError).toBe(true)
    expect(content.error).toContain('KAIROS_MCP_ALLOW_DEPLOY')
  })

  it('kairos_activate is blocked by default', async () => {
    client.send({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'kairos_activate', arguments: { workflow_id: 'test' } },
    })
    const resp = await client.waitForResponse(7)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)

    expect(result.isError).toBe(true)
    expect(content.error).toContain('KAIROS_MCP_ALLOW_ACTIVATE')
  })

  it('kairos_delete is blocked by default', async () => {
    client.send({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'kairos_delete', arguments: { workflow_id: 'test' } },
    })
    const resp = await client.waitForResponse(8)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)

    expect(result.isError).toBe(true)
    expect(content.error).toContain('KAIROS_MCP_ALLOW_DELETE')
  })
})
