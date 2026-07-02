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
    expect(names).toContain('kairos_patterns')
    expect(names).toContain('kairos_replace')
    expect(names).toContain('kairos_library')
    expect(names).toContain('kairos_outcome')
    expect(names).toContain('kairos_record_trace')
    expect(names).toHaveLength(16)
  })

  it('kairos_prompt returns a prompt even without n8n credentials (graceful fallback)', async () => {
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

    // Should succeed (not an error) and return a usable prompt
    expect(result.isError).toBeFalsy()
    expect(content).toHaveProperty('systemPrompt')
    expect(content).toHaveProperty('kairos_run_id')
    // Should warn that credentials are missing
    expect(content.syncWarning).toContain('N8N_BASE_URL')
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

  it('kairos_replace is blocked by default (requires KAIROS_MCP_ALLOW_DEPLOY=true)', async () => {
    client.send({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'kairos_replace', arguments: { workflow_id: 'wf-1', workflow: 'not json' } },
    })
    const resp = await client.waitForResponse(9)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)

    expect(result.isError).toBe(true)
    expect(content.error).toContain('KAIROS_MCP_ALLOW_DEPLOY')
  })

  it('kairos_replace blocked same as kairos_deploy (consistent permission model)', async () => {
    const bad = JSON.stringify({ name: '', nodes: [], connections: {}, settings: {} })
    client.send({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'kairos_replace', arguments: { workflow_id: 'wf-1', workflow: bad } },
    })
    const resp = await client.waitForResponse(10)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)

    expect(result.isError).toBe(true)
    expect(content.error).toContain('KAIROS_MCP_ALLOW_DEPLOY')
  })

  it('kairos_library returns empty array when library has no entries', async () => {
    client.send({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'kairos_library', arguments: {} },
    })
    const resp = await client.waitForResponse(11)
    const result = resp['result'] as { content: Array<{ text: string }> }
    const content = JSON.parse(result.content[0].text) as unknown[]

    expect(Array.isArray(content)).toBe(true)
  })

  it('kairos_library search returns scored results', async () => {
    client.send({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'kairos_library', arguments: { query: 'slack notification' } },
    })
    const resp = await client.waitForResponse(12)
    const result = resp['result'] as { content: Array<{ text: string }> }
    const content = JSON.parse(result.content[0].text) as unknown[]

    expect(Array.isArray(content)).toBe(true)
  })

  it('kairos_outcome records feedback against a library entry', async () => {
    client.send({
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: {
        name: 'kairos_outcome',
        arguments: {
          library_id: 'nonexistent-id',
          attempts: 2,
          first_try_pass: false,
          failed_rules: [12, 17],
          mode: 'direct',
        },
      },
    })
    const resp = await client.waitForResponse(13)
    const result = resp['result'] as { content: Array<{ text: string }> }
    const content = JSON.parse(result.content[0].text) as { recorded: boolean; libraryId: string }

    expect(content.recorded).toBe(true)
    expect(content.libraryId).toBe('nonexistent-id')
  })
})

describe('Kairos MCP Server — role modes', () => {
  function startServerWithMode(mode: string): McpClient {
    const proc = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, N8N_BASE_URL: undefined, N8N_API_KEY: undefined, KAIROS_MCP_MODE: mode },
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
      send(msg: object) { proc.stdin!.write(JSON.stringify(msg) + '\n') },
      waitForResponse(id: number): Promise<Record<string, unknown>> {
        const existing = responses.get(id)
        if (existing) return Promise.resolve(existing)
        return new Promise((resolve) => { waiters.set(id, resolve) })
      },
      close() { proc.kill() },
    }
  }

  async function initClient(client: McpClient): Promise<void> {
    client.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } })
    await client.waitForResponse(0)
  }

  it('KAIROS_MCP_MODE=readonly blocks kairos_deploy', async () => {
    const c = startServerWithMode('readonly')
    await initClient(c)
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kairos_deploy', arguments: { workflow: '{}' } } })
    const resp = await c.waitForResponse(1)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)
    c.close()
    expect(result.isError).toBe(true)
    expect(content.error).toMatch(/disabled/i)
  }, 15_000)

  it('KAIROS_MCP_MODE=validate allows kairos_validate but blocks kairos_deploy', async () => {
    const c = startServerWithMode('validate')
    await initClient(c)

    // validate should work
    const validWorkflow = JSON.stringify({ name: 'Test', nodes: [{ id: '550e8400-e29b-41d4-a716-446655440001', type: 'n8n-nodes-base.webhook', typeVersion: 2, name: 'Webhook', position: [250, 300], parameters: {} }], connections: {}, settings: { executionOrder: 'v1' } })
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kairos_validate', arguments: { workflow: validWorkflow } } })
    const validateResp = await c.waitForResponse(1)
    const validateResult = validateResp['result'] as { content: Array<{ text: string }>; isError?: boolean }

    // deploy should be blocked
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kairos_deploy', arguments: { workflow: '{}' } } })
    const deployResp = await c.waitForResponse(2)
    const deployResult = deployResp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const deployContent = JSON.parse(deployResult.content[0].text)
    c.close()

    expect(validateResult.isError).toBeFalsy()
    expect(deployResult.isError).toBe(true)
    expect(deployContent.error).toMatch(/disabled/i)
  }, 15_000)

  it('KAIROS_MCP_MODE=deploy still requires KAIROS_MCP_ALLOW_DEPLOY=true (existing behavior preserved)', async () => {
    const c = startServerWithMode('deploy')
    await initClient(c)
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kairos_deploy', arguments: { workflow: '{}' } } })
    const resp = await c.waitForResponse(1)
    const result = resp['result'] as { content: Array<{ text: string }>; isError?: boolean }
    const content = JSON.parse(result.content[0].text)
    c.close()
    // deploy mode doesn't auto-allow — still requires explicit ALLOW_DEPLOY=true
    expect(result.isError).toBe(true)
    expect(content.error).toContain('KAIROS_MCP_ALLOW_DEPLOY')
  }, 15_000)
})
