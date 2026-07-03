import { describe, it, expect } from 'vitest'
import { extractScheduleIntervals, scheduleSignature } from '../../../src/utils/schedule-intervals.js'
import type { N8nWorkflow } from '../../../src/types/workflow.js'

function scheduleNode(interval: unknown[], name = 'Schedule') {
  return {
    id: 'sched-1',
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 0] as [number, number],
    parameters: { rule: { interval } },
  }
}

describe('extractScheduleIntervals', () => {
  it('returns [] for an undefined workflow', () => {
    expect(extractScheduleIntervals(undefined)).toEqual([])
  })

  it('returns [] for a workflow with no nodes array', () => {
    const workflow = { name: 'w', connections: {} } as unknown as N8nWorkflow
    expect(extractScheduleIntervals(workflow)).toEqual([])
  })

  it('returns [] for a workflow whose only node is not a scheduleTrigger', () => {
    const workflow: N8nWorkflow = {
      name: 'w',
      nodes: [{ id: '1', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0], parameters: {} }],
      connections: {},
    }
    expect(extractScheduleIntervals(workflow)).toEqual([])
  })

  it('returns one entry for a workflow with one scheduleTrigger', () => {
    const workflow: N8nWorkflow = {
      name: 'w',
      nodes: [scheduleNode([{ field: 'days', daysInterval: 1, triggerAtHour: 9 }])],
      connections: {},
    }
    const result = extractScheduleIntervals(workflow)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual([{ daysInterval: 1, field: 'days', triggerAtHour: 9 }])
  })

  it('returns two entries for a workflow with two scheduleTrigger nodes', () => {
    const workflow: N8nWorkflow = {
      name: 'w',
      nodes: [
        scheduleNode([{ field: 'days', daysInterval: 1, triggerAtHour: 9 }], 'Morning'),
        scheduleNode([{ field: 'days', daysInterval: 1, triggerAtHour: 17 }], 'Evening'),
      ],
      connections: {},
    }
    expect(extractScheduleIntervals(workflow)).toHaveLength(2)
  })

  it('skips a scheduleTrigger node with an empty interval array', () => {
    const workflow: N8nWorkflow = {
      name: 'w',
      nodes: [scheduleNode([])],
      connections: {},
    }
    expect(extractScheduleIntervals(workflow)).toEqual([])
  })
})

describe('scheduleSignature', () => {
  it('returns null for an empty interval array', () => {
    expect(scheduleSignature([])).toBeNull()
  })

  it('returns the same signature for deep-equal intervals regardless of key order', () => {
    const a = [{ field: 'days', daysInterval: 1, triggerAtHour: 9 }]
    const b = [{ triggerAtHour: 9, daysInterval: 1, field: 'days' }]
    expect(scheduleSignature(a)).toBe(scheduleSignature(b))
  })

  it('returns different signatures for genuinely different intervals', () => {
    const a = [{ field: 'days', daysInterval: 1, triggerAtHour: 9 }]
    const b = [{ field: 'days', daysInterval: 1, triggerAtHour: 17 }]
    expect(scheduleSignature(a)).not.toBe(scheduleSignature(b))
  })
})
