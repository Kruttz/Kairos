import type { N8nWorkflow } from '../types/workflow.js'

/**
 * Extracts the `rule.interval` array from every n8n-nodes-base.scheduleTrigger
 * node in a workflow, with each interval object's keys sorted alphabetically
 * so two structurally-identical schedules serialize to the same JSON string
 * regardless of key insertion order.
 *
 * Returns one normalized array per scheduleTrigger node found (a workflow may
 * have more than one). Returns [] if the workflow has no schedule triggers,
 * or no `nodes` array at all.
 */
export function extractScheduleIntervals(workflow: N8nWorkflow | undefined): unknown[][] {
  if (!workflow || !Array.isArray(workflow.nodes)) return []

  const result: unknown[][] = []
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.scheduleTrigger') continue
    const params = node.parameters as Record<string, unknown> | undefined
    const rule = params?.['rule'] as Record<string, unknown> | undefined
    const intervals = rule?.['interval']
    if (!Array.isArray(intervals) || intervals.length === 0) continue
    result.push(intervals.map(normalizeIntervalObject))
  }
  return result
}

/** Recursively sorts object keys so JSON.stringify is order-independent. */
function normalizeIntervalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeIntervalObject)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = normalizeIntervalObject((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Produces a stable string signature for an interval array, suitable for use
 * as a Map/grouping key. Normalizes key order itself — safe to call directly
 * on raw (not pre-normalized) interval data, not just extractScheduleIntervals'
 * output. Returns null for an empty interval array (nothing to compare).
 */
export function scheduleSignature(intervals: unknown[]): string | null {
  if (!intervals || intervals.length === 0) return null
  return JSON.stringify(intervals.map(normalizeIntervalObject))
}
