import type { ExecutionDetail } from '../types/result.js'
import type { ExecutionTrace } from '../library/types.js'

export type { ExecutionTrace }

/** Computes a runtime reliability score from trace history: 0–1 */
export function computeRuntimeReliability(traces: ExecutionTrace[]): number {
  if (traces.length === 0) return 0.5  // neutral — no data

  const successCount = traces.filter(t => t.status === 'success').length
  const successRate = successCount / traces.length

  // Apply a reliability multiplier: 100% success = 1.1x boost, 0% = 0.8x penalty
  // Clamped to [0.8, 1.1] to avoid extreme swings with small sample sizes
  const multiplier = 0.8 + successRate * 0.3
  return Math.min(Math.max(successRate * multiplier, 0), 1)
}

/**
 * Parse raw n8n execution detail into a structured ExecutionTrace.
 * Handles the complex nested shape of n8n's execution data object.
 */
export function parseExecutionTrace(execution: ExecutionDetail): ExecutionTrace {
  const startedAt = execution.startedAt ? new Date(execution.startedAt).getTime() : null
  const stoppedAt = execution.stoppedAt ? new Date(execution.stoppedAt).getTime() : null
  const durationMs = startedAt && stoppedAt ? stoppedAt - startedAt : null

  const executedNodes: string[] = []
  const erroredNodes: Array<{ name: string; errorType: string }> = []
  const nodeDurations: Record<string, number> = {}
  let itemCount = 0

  // n8n execution data shape:
  // data.resultData.runData: Record<nodeName, Array<{ data: { main: [items[]] }, error?: {...} }>>
  const data = execution.data as Record<string, unknown> | undefined
  const resultData = data?.['resultData'] as Record<string, unknown> | undefined
  const runData = resultData?.['runData'] as Record<string, unknown[]> | undefined

  if (runData && typeof runData === 'object') {
    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      if (!Array.isArray(nodeRuns) || nodeRuns.length === 0) continue

      executedNodes.push(nodeName)

      for (const run of nodeRuns) {
        const runObj = run as Record<string, unknown>

        // n8n's real ITaskData carries executionTime (ms) at the top level of each
        // run object — summed across runs so a looped node's total cost is visible,
        // matching how itemCount already sums across all of a node's runs.
        const executionTime = runObj['executionTime']
        if (typeof executionTime === 'number') {
          nodeDurations[nodeName] = (nodeDurations[nodeName] ?? 0) + executionTime
        }

        // Check for errors (only capture the error type/name, not the message content)
        const error = runObj['error'] as Record<string, unknown> | undefined
        if (error) {
          const errorType = (error['name'] as string | undefined)
            ?? (error['type'] as string | undefined)
            ?? 'UnknownError'
          // Avoid duplicate error entries for the same node
          if (!erroredNodes.some(e => e.name === nodeName)) {
            erroredNodes.push({ name: nodeName, errorType })
          }
        }

        // Count items from the main output path (privacy-safe: count only, not values)
        const nodeData = runObj['data'] as Record<string, unknown> | undefined
        const mainOutput = nodeData?.['main'] as unknown[][] | undefined
        if (Array.isArray(mainOutput)) {
          for (const outputItems of mainOutput) {
            if (Array.isArray(outputItems)) itemCount += outputItems.length
          }
        }
      }
    }
  }

  return {
    recordedAt: new Date().toISOString(),
    executionId: execution.id,
    status: execution.status,
    durationMs,
    executedNodes,
    erroredNodes,
    itemCount,
    nodeDurations,
  }
}

/** Top N slowest nodes from a trace's nodeDurations, sorted descending by ms. */
export function getSlowestNodes(nodeDurations: Record<string, number>, n = 3): Array<{ name: string; ms: number }> {
  return Object.entries(nodeDurations)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, ms]) => ({ name, ms }))
}

const MAX_TRACES_PER_WORKFLOW = 10

/**
 * Merge a new trace into an existing trace history (capped at MAX_TRACES_PER_WORKFLOW).
 * Most recent traces are kept.
 */
export function mergeTraces(
  existing: ExecutionTrace[],
  newTrace: ExecutionTrace,
): ExecutionTrace[] {
  // Deduplicate by executionId
  const deduped = existing.filter(t => t.executionId !== newTrace.executionId)
  const merged = [...deduped, newTrace]
  // Keep most recent (sort by recordedAt descending, keep top N)
  return merged
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
    .slice(0, MAX_TRACES_PER_WORKFLOW)
}

/**
 * Fetch the most recent execution for a given n8n workflow ID and return a parsed trace.
 * Returns null if no executions found or if the API call fails.
 */
export async function fetchLatestTrace(
  workflowId: string,
  n8nBaseUrl: string,
  n8nApiKey: string,
): Promise<ExecutionTrace | null> {
  try {
    const { N8nApiClient } = await import('../providers/n8n/api-client.js')
    const { nullLogger } = await import('../utils/logger.js')
    const client = new N8nApiClient(n8nBaseUrl, n8nApiKey, nullLogger)

    const executions = await client.getExecutions(workflowId, { limit: 1 })
    if (executions.length === 0) return null

    const detail = await client.getExecution(executions[0]!.id)
    return parseExecutionTrace(detail)
  } catch {
    return null
  }
}
