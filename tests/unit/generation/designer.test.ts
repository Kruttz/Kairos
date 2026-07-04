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
