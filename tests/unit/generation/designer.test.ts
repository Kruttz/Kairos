import { describe, it, expect, vi } from 'vitest'
import { WorkflowDesigner } from '../../../src/generation/designer.js'
import { nullLogger } from '../../../src/utils/logger.js'
import type { DesignRequest } from '../../../src/generation/types.js'

const VALID_WORKFLOW = {
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
}

function makeMockAnthropic(toolInput: Record<string, unknown>, stopReason: string | null = 'tool_use') {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        stop_reason: stopReason,
        content: [{ type: 'tool_use', name: 'generate_workflow', input: toolInput }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  }
}

const REQUEST: DesignRequest = { description: 'A simple test workflow' }

describe('WorkflowDesigner — max_tokens configuration', () => {
  it('defaults max_tokens to 16000 when not specified', async () => {
    const mockAnthropic = makeMockAnthropic({ workflow: VALID_WORKFLOW, credentialsNeeded: [] })
    const designer = new WorkflowDesigner(
      mockAnthropic as never, 'claude-sonnet-4-6', nullLogger,
    )

    await designer.design(REQUEST, [])

    expect(mockAnthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 16000 }),
      expect.anything(),
    )
  })

  it('uses a custom maxTokens value when provided', async () => {
    const mockAnthropic = makeMockAnthropic({ workflow: VALID_WORKFLOW, credentialsNeeded: [] })
    const designer = new WorkflowDesigner(
      mockAnthropic as never, 'claude-sonnet-4-6', nullLogger, undefined, undefined, 32000,
    )

    await designer.design(REQUEST, [])

    expect(mockAnthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 32000 }),
      expect.anything(),
    )
  })
})

describe('WorkflowDesigner — retry-loop feedback includes warn-severity issues', () => {
  it('includes a warn-level rule (126, invalid UUID) alongside an error-level rule in the attempt-2 correction message', async () => {
    // Deliberately broken on two fronts: name is empty (Rule 1, ERROR — guarantees a
    // retry happens) and the node ID is not a valid UUID v4 (Rule 126, WARN).
    const brokenWorkflow = {
      name: '',
      nodes: [
        {
          id: 'not-a-valid-uuid-at-all',
          name: 'Manual Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [250, 300],
          parameters: {},
        },
      ],
      connections: {},
    }

    const create = vi.fn()
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'generate_workflow', input: { workflow: brokenWorkflow, credentialsNeeded: [] } }],
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'generate_workflow', input: { workflow: VALID_WORKFLOW, credentialsNeeded: [] } }],
        usage: { input_tokens: 100, output_tokens: 50 },
      })
    const mockAnthropic = { messages: { create } }

    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)
    const result = await designer.design(REQUEST, [])

    expect(result.attempts).toBe(2)
    expect(create).toHaveBeenCalledTimes(2)

    // The second call's user message is the correction prompt built from attempt 1's issues.
    const secondCallArgs = create.mock.calls[1]![0] as { messages: Array<{ content: string }> }
    const correctionMessage = secondCallArgs.messages[0]!.content

    // Bracketed form avoids "Rule 1" matching as a substring of "Rule 126"
    expect(correctionMessage).toContain('[Rule 1]')   // the error that actually blocked attempt 1
    expect(correctionMessage).toContain('[Rule 126]') // the warn issue riding along, now visible too
  })

  it('does not include warn-level issues in the thrown ValidationError differently than before (unchanged pass/fail semantics)', async () => {
    // A workflow with ONLY a warn-level issue (bad UUID) and nothing error-level should
    // still pass immediately on attempt 1 -- confirming this fix didn't change what
    // counts as a passing build, only what gets fed back during an already-happening retry.
    const warnOnlyWorkflow = {
      name: 'Valid Name',
      nodes: [
        {
          id: 'not-a-valid-uuid-at-all',
          name: 'Manual Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [250, 300],
          parameters: {},
        },
      ],
      connections: {},
    }
    const mockAnthropic = makeMockAnthropic({ workflow: warnOnlyWorkflow, credentialsNeeded: [] })
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    const result = await designer.design(REQUEST, [])

    expect(result.attempts).toBe(1)
    expect(mockAnthropic.messages.create).toHaveBeenCalledTimes(1)
  })
})

describe('WorkflowDesigner — stringified-workflow recovery shim', () => {
  it('recovers when Claude returns the workflow as a JSON string instead of an object', async () => {
    // The exact failure captured by the diagnostic: workflow present but stringified.
    const mockAnthropic = makeMockAnthropic({
      workflow: JSON.stringify(VALID_WORKFLOW),
      credentialsNeeded: [],
    })
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    const result = await designer.design(REQUEST, [])

    expect(result.attempts).toBe(1)
    expect(result.workflow.name).toBe('Test Workflow')
    expect(result.workflow.nodes).toHaveLength(1)
  })

  it('recovers stringified credentialsNeeded alongside a stringified workflow', async () => {
    const creds = [{ service: 'Slack', credentialType: 'slackOAuth2Api', description: 'Slack access' }]
    const mockAnthropic = makeMockAnthropic({
      workflow: JSON.stringify(VALID_WORKFLOW),
      credentialsNeeded: JSON.stringify(creds),
    })
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    const result = await designer.design(REQUEST, [])

    expect(result.credentialsNeeded).toHaveLength(1)
    expect(result.credentialsNeeded[0]!.service).toBe('Slack')
  })
})

function makeResponse(toolInput: Record<string, unknown>, stopReason: string | null = 'tool_use') {
  return {
    stop_reason: stopReason,
    content: [{ type: 'tool_use', name: 'generate_workflow', input: toolInput }],
    usage: { input_tokens: 100, output_tokens: 50 },
  }
}

describe('WorkflowDesigner — parse/truncation failures are retried, not instant-fatal', () => {
  it('retries after an unparseable stringified workflow and succeeds on attempt 2', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(makeResponse({ workflow: '{not valid json', credentialsNeeded: [] }))
      .mockResolvedValueOnce(makeResponse({ workflow: VALID_WORKFLOW, credentialsNeeded: [] }))
    const mockAnthropic = { messages: { create } }
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    const result = await designer.design(REQUEST, [])

    expect(result.attempts).toBe(2)
    expect(create).toHaveBeenCalledTimes(2)
    const secondCallArgs = create.mock.calls[1]![0] as { messages: Array<{ content: string }> }
    expect(secondCallArgs.messages[0]!.content).toContain('[Format]')
  })

  it('retries after truncation (stop_reason max_tokens) and succeeds on attempt 2', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(makeResponse({ workflow: VALID_WORKFLOW, credentialsNeeded: [] }, 'max_tokens'))
      .mockResolvedValueOnce(makeResponse({ workflow: VALID_WORKFLOW, credentialsNeeded: [] }))
    const mockAnthropic = { messages: { create } }
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    const result = await designer.design(REQUEST, [])

    expect(result.attempts).toBe(2)
    const secondCallArgs = create.mock.calls[1]![0] as { messages: Array<{ content: string }> }
    expect(secondCallArgs.messages[0]!.content).toContain('more compact workflow')
  })

  it('does NOT retry when Claude explicitly declines (input.error) — fails fast', async () => {
    const mockAnthropic = makeMockAnthropic({ error: 'Cannot fulfill this request' })
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    await expect(designer.design(REQUEST, [])).rejects.toThrow('Claude declined to generate workflow')
    expect(mockAnthropic.messages.create).toHaveBeenCalledTimes(1)
  })

  it('rethrows the parse/truncation error with attemptMetadata after exhausting all 3 attempts', async () => {
    const mockAnthropic = makeMockAnthropic({ workflow: 'still not valid json', credentialsNeeded: [] })
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    let caught: unknown
    try {
      await designer.design(REQUEST, [])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const err = caught as { name: string; attemptMetadata?: unknown[] }
    expect(err.name).toBe('ResponseParseError')
    expect(err.attemptMetadata).toHaveLength(3)
    expect(mockAnthropic.messages.create).toHaveBeenCalledTimes(3)
  })

  it('preserves the prior validation issue across an intervening parse failure (attempt 3 sees both)', async () => {
    // Attempt 1: a real validation error (empty name, Rule 1). Attempt 2: parse failure
    // (learns nothing new about Rule 1). Attempt 3: valid workflow -- but its correction
    // message (built from attempt 2's failure) must still carry attempt 1's Rule 1 issue.
    const brokenWorkflow = { ...VALID_WORKFLOW, name: '' }
    const create = vi.fn()
      .mockResolvedValueOnce(makeResponse({ workflow: brokenWorkflow, credentialsNeeded: [] }))
      .mockResolvedValueOnce(makeResponse({ workflow: '{broken', credentialsNeeded: [] }))
      .mockResolvedValueOnce(makeResponse({ workflow: VALID_WORKFLOW, credentialsNeeded: [] }))
    const mockAnthropic = { messages: { create } }
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    const result = await designer.design(REQUEST, [])

    expect(result.attempts).toBe(3)
    const thirdCallArgs = create.mock.calls[2]![0] as { messages: Array<{ content: string }> }
    const message = thirdCallArgs.messages[0]!.content
    expect(message).toContain('[Rule 1]')
    expect(message).toContain('[Format]')
  })
})

describe('WorkflowDesigner — timeout configuration', () => {
  it('defaults the abort timeout to 300000ms when not specified', async () => {
    const mockAnthropic = makeMockAnthropic({ workflow: VALID_WORKFLOW, credentialsNeeded: [] })
    const designer = new WorkflowDesigner(mockAnthropic as never, 'claude-sonnet-4-6', nullLogger)

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    await designer.design(REQUEST, [])

    const abortCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 300000)
    expect(abortCall).toBeDefined()
    setTimeoutSpy.mockRestore()
  })

  it('uses a custom timeoutMs value when provided', async () => {
    const mockAnthropic = makeMockAnthropic({ workflow: VALID_WORKFLOW, credentialsNeeded: [] })
    const designer = new WorkflowDesigner(
      mockAnthropic as never, 'claude-sonnet-4-6', nullLogger, undefined, undefined, undefined, 600000,
    )

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    await designer.design(REQUEST, [])

    const abortCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 600000)
    expect(abortCall).toBeDefined()
    setTimeoutSpy.mockRestore()
  })
})
