import { describe, it, expect, afterEach } from 'vitest'
import {
  assertNotProduction,
  applySandboxPrefix,
  stripCredentialBindings,
  SANDBOX_WORKFLOW_PREFIX,
} from '../../../../src/reliability/sandbox/manager.js'
import { GuardError } from '../../../../src/errors/guard-error.js'
import type { N8nWorkflow } from '../../../../src/types/workflow.js'

describe('assertNotProduction -- the single guardrail every write path in this module calls', () => {
  const ORIGINAL_N8N_BASE_URL = process.env['N8N_BASE_URL']

  afterEach(() => {
    if (ORIGINAL_N8N_BASE_URL === undefined) delete process.env['N8N_BASE_URL']
    else process.env['N8N_BASE_URL'] = ORIGINAL_N8N_BASE_URL
  })

  it('does not throw when N8N_BASE_URL is not configured at all', () => {
    delete process.env['N8N_BASE_URL']
    expect(() => assertNotProduction('http://localhost:15679')).not.toThrow()
  })

  it('does not throw when the sandbox URL differs from production', () => {
    process.env['N8N_BASE_URL'] = 'https://my-real-instance.app.n8n.cloud'
    expect(() => assertNotProduction('http://localhost:15679')).not.toThrow()
  })

  it('throws when the sandbox URL exactly matches production', () => {
    process.env['N8N_BASE_URL'] = 'http://localhost:15679'
    expect(() => assertNotProduction('http://localhost:15679')).toThrow(GuardError)
  })

  it('throws when origins match despite different paths/trailing slashes', () => {
    process.env['N8N_BASE_URL'] = 'http://localhost:15679/'
    expect(() => assertNotProduction('http://localhost:15679/some/path')).toThrow(GuardError)
  })

  it('throws when a real production Cloud URL is accidentally passed as the sandbox URL', () => {
    // The realistic accident this guards against: a caller wiring config.baseUrl wrong and
    // ending up pointing sandbox operations at the actual configured production instance.
    process.env['N8N_BASE_URL'] = 'https://empire-homecare.app.n8n.cloud'
    expect(() => assertNotProduction('https://empire-homecare.app.n8n.cloud')).toThrow(GuardError)
  })

  it('does not throw (fails open on the guard itself) when either URL is unparseable', () => {
    // An unparseable URL can't be proven equal to anything -- the caller's own URL
    // validation (N8nApiClient's constructor) is what rejects malformed URLs, not this guard.
    process.env['N8N_BASE_URL'] = 'not-a-valid-url'
    expect(() => assertNotProduction('http://localhost:15679')).not.toThrow()
  })

  it('error message names both URLs so a human can immediately see the collision', () => {
    process.env['N8N_BASE_URL'] = 'http://localhost:15679'
    try {
      assertNotProduction('http://localhost:15679')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(GuardError)
      expect((err as Error).message).toContain('localhost:15679')
      expect((err as Error).message).toContain('production')
    }
  })
})

describe('applySandboxPrefix', () => {
  it('prepends the prefix to an unprefixed name', () => {
    expect(applySandboxPrefix('My Workflow')).toBe(`${SANDBOX_WORKFLOW_PREFIX} My Workflow`)
  })

  it('does not double-prefix a name that already carries it', () => {
    const already = `${SANDBOX_WORKFLOW_PREFIX} My Workflow`
    expect(applySandboxPrefix(already)).toBe(already)
  })
})

describe('stripCredentialBindings', () => {
  it('removes credentials from every node that has them', () => {
    const workflow: N8nWorkflow = {
      nodes: [
        { id: '1', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0], parameters: {}, credentials: { httpBasicAuth: { id: 'cred-1', name: 'My Cred' } } },
        { id: '2', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} },
      ],
      connections: {},
      settings: {},
    }
    const stripped = stripCredentialBindings(workflow)
    expect(stripped.nodes[0]!.credentials).toBeUndefined()
    expect(stripped.nodes[1]!.credentials).toBeUndefined()
  })

  it('does not mutate the original workflow object', () => {
    const workflow: N8nWorkflow = {
      nodes: [{ id: '1', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0], parameters: {}, credentials: { httpBasicAuth: { id: 'cred-1', name: 'My Cred' } } }],
      connections: {},
      settings: {},
    }
    stripCredentialBindings(workflow)
    expect(workflow.nodes[0]!.credentials).toBeDefined()
  })

  it('leaves nodes without credentials untouched', () => {
    const workflow: N8nWorkflow = {
      nodes: [{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'x' } }],
      connections: {},
      settings: {},
    }
    const stripped = stripCredentialBindings(workflow)
    expect(stripped.nodes[0]!.parameters).toEqual({ path: 'x' })
  })
})
