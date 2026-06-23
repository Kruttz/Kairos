import { describe, it, expect, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { N8nApiClient } from '../../src/providers/n8n/api-client.js'
import { N8nFieldStripper } from '../../src/providers/n8n/stripper.js'
import { N8nProvider } from '../../src/providers/n8n/provider.js'
import { N8nValidator } from '../../src/validation/validator.js'
import type { N8nWorkflow } from '../../src/types/workflow.js'

const BASE_URL = process.env['N8N_BASE_URL']
const API_KEY = process.env['N8N_API_KEY']
const canRun = !!(BASE_URL && API_KEY)

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'workflows', 'simple-two-node.json')

describe.skipIf(!canRun)('n8n e2e roundtrip', () => {
  let provider: N8nProvider
  let deployedId: string | null = null

  const cleanup = async () => {
    if (deployedId && provider) {
      try {
        await provider.delete(deployedId, { confirm: true })
      } catch {
        // best-effort cleanup
      }
    }
  }

  afterAll(cleanup)

  it('fixture passes the 23-rule validator', async () => {
    const raw = await readFile(FIXTURE_PATH, 'utf-8')
    const workflow: N8nWorkflow = JSON.parse(raw) as N8nWorkflow

    const validator = new N8nValidator()
    const result = validator.validate(workflow)

    expect(result.valid).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  it('deploys the fixture to n8n and fetches it back', async () => {
    const apiClient = new N8nApiClient(BASE_URL!, API_KEY!, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    })
    const stripper = new N8nFieldStripper()
    provider = new N8nProvider(apiClient, stripper)

    const raw = await readFile(FIXTURE_PATH, 'utf-8')
    const workflow: N8nWorkflow = JSON.parse(raw) as N8nWorkflow

    const deployed = await provider.deploy(workflow)
    deployedId = deployed.workflowId

    expect(deployed.workflowId).toBeTruthy()
    expect(deployed.name).toBe(workflow.name)

    const fetched = await provider.get(deployed.workflowId)

    expect(fetched.name).toBe(workflow.name)
    expect(fetched.nodes).toHaveLength(workflow.nodes.length)

    const fetchedNodeNames = fetched.nodes.map((n) => n.name).sort()
    const fixtureNodeNames = workflow.nodes.map((n) => n.name).sort()
    expect(fetchedNodeNames).toEqual(fixtureNodeNames)

    const fetchedNodeTypes = fetched.nodes.map((n) => n.type).sort()
    const fixtureNodeTypes = workflow.nodes.map((n) => n.type).sort()
    expect(fetchedNodeTypes).toEqual(fixtureNodeTypes)

    expect(fetched.connections).toBeDefined()
    expect(Object.keys(fetched.connections)).toContain('Manual Trigger')
  })

  it('the deployed workflow appears in the workflow list', async () => {
    const workflows = await provider.list()
    const found = workflows.find((w) => w.id === deployedId)

    expect(found).toBeDefined()
    expect(found!.name).toBe('Kairos E2E Test — Simple Two Node')
    expect(found!.active).toBe(false)
  })

  it('deletes the deployed workflow', async () => {
    await provider.delete(deployedId!, { confirm: true })

    const workflows = await provider.list()
    const found = workflows.find((w) => w.id === deployedId)
    expect(found).toBeUndefined()

    deployedId = null
  })
})
