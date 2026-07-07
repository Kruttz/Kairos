import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { N8nWorkflow } from '../types/workflow.js'
import type { N8nApiClient } from '../providers/n8n/index.js'

export function slugifyWorkflowName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workflow'
}

/**
 * Fetches a workflow's current live n8n definition and strips it down to the portable
 * N8nWorkflow shape (no n8n-internal fields like id/active/versionId/meta). Returns null
 * on any fetch failure (workflow deleted, n8n unreachable) rather than throwing -- a missing
 * workflow.json for one workflow in a pack should not abort exporting the rest.
 */
export async function fetchWorkflowJson(workflowId: string, client: N8nApiClient): Promise<N8nWorkflow | null> {
  try {
    const response = await client.getWorkflow(workflowId)
    return {
      name: response.name,
      nodes: response.nodes,
      connections: response.connections,
      ...(response.settings ? { settings: response.settings } : {}),
      ...(response.tags ? { tags: response.tags } : {}),
    }
  } catch {
    return null
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmpPath, path)
}

export interface WriteWorkflowJsonResult {
  written: Array<{ workflowName: string; path: string }>
  skipped: Array<{ workflowName: string; reason: string }>
}

/**
 * Writes one <slug>.workflow.json per workflow in the pack into outDir, fetching each
 * workflow's current definition live from n8n. Workflows with no workflowId, or whose fetch
 * fails, are skipped (reported, not thrown) so one bad workflow doesn't abort the rest.
 */
export async function writeWorkflowJsonFiles(
  workflows: Array<{ name: string; workflowId: string | null }>,
  client: N8nApiClient,
  outDir: string,
): Promise<WriteWorkflowJsonResult> {
  await mkdir(outDir, { recursive: true })
  const result: WriteWorkflowJsonResult = { written: [], skipped: [] }

  for (const wf of workflows) {
    if (!wf.workflowId) {
      result.skipped.push({ workflowName: wf.name, reason: 'no workflowId (workflow was not deployed)' })
      continue
    }
    const workflow = await fetchWorkflowJson(wf.workflowId, client)
    if (!workflow) {
      result.skipped.push({ workflowName: wf.name, reason: `could not fetch workflow ${wf.workflowId} from n8n` })
      continue
    }
    const path = join(outDir, `${slugifyWorkflowName(wf.name)}.workflow.json`)
    await writeJsonAtomic(path, workflow)
    result.written.push({ workflowName: wf.name, path })
  }

  return result
}
