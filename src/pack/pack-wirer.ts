import type { WorkflowPackResult } from './pack-builder.js'
import type { N8nWorkflow } from '../types/workflow.js'

export interface SheetIdMapping {
  [sheetName: string]: string  // sheet name → Google Spreadsheet ID
}

export interface WireResult {
  workflowName: string
  n8nWorkflowId: string | null
  sheetsPatched: Array<{ nodeName: string; sheetName: string; spreadsheetId: string }>
  validationPassed: boolean
  validationIssues: string[]
  pushed: boolean
  error?: string
  skipped?: boolean
  skipReason?: string
}

export interface PackWireReport {
  packName: string
  dryRun: boolean
  results: WireResult[]
  totalPatched: number
  totalPushed: number
  totalErrors: number
}

// Google Sheets documentId is stored as a ResourceLocator value in n8n params
function extractSheetDocumentId(params: Record<string, unknown>): string | null {
  const doc = params['documentId'] as Record<string, unknown> | undefined
  if (!doc) return null
  const rl = doc['__rl'] as Record<string, unknown> | undefined
  if (rl) return (rl['value'] as string | undefined) ?? null
  if (typeof doc === 'string') return doc
  return null
}

function patchSheetDocumentId(
  params: Record<string, unknown>,
  newId: string,
): Record<string, unknown> {
  const doc = params['documentId'] as Record<string, unknown> | undefined
  if (!doc) return params

  const rl = doc['__rl'] as Record<string, unknown> | undefined
  if (rl) {
    return {
      ...params,
      documentId: {
        ...doc,
        __rl: { ...rl, value: newId, mode: 'id' },
      },
    }
  }

  return { ...params, documentId: newId }
}

function findSheetNodes(workflow: N8nWorkflow): Array<{
  nodeName: string
  currentDocId: string | null
  nodeIndex: number
}> {
  return workflow.nodes
    .map((node, nodeIndex) => {
      const isSheetNode =
        node.type === 'n8n-nodes-base.googleSheets' ||
        node.type === 'n8n-nodes-base.googleSheetsTrigger'
      if (!isSheetNode) return null
      return {
        nodeName: node.name,
        currentDocId: extractSheetDocumentId(node.parameters as Record<string, unknown>),
        nodeIndex,
      }
    })
    .filter((n): n is NonNullable<typeof n> => n !== null)
}

// Match a sheet node to a sheet name by looking for the sheet name in the node's sheetName param
function resolveSheetName(
  params: Record<string, unknown>,
  mapping: SheetIdMapping,
): { sheetName: string; spreadsheetId: string } | null {
  // Try to find a matching sheet name in the mapping by checking sheetName parameter
  const sheetNameParam = params['sheetName'] as string | Record<string, unknown> | undefined
  let candidate: string | undefined

  if (typeof sheetNameParam === 'string') {
    candidate = sheetNameParam
  } else if (sheetNameParam && typeof sheetNameParam === 'object') {
    const rl = (sheetNameParam as Record<string, unknown>)['__rl'] as Record<string, unknown> | undefined
    if (rl) candidate = rl['value'] as string | undefined
  }

  if (candidate) {
    // Direct match
    if (mapping[candidate]) return { sheetName: candidate, spreadsheetId: mapping[candidate] }
    // Case-insensitive match
    const lower = candidate.toLowerCase()
    for (const [name, id] of Object.entries(mapping)) {
      if (name.toLowerCase() === lower) return { sheetName: name, spreadsheetId: id }
    }
  }

  // If only one sheet in the mapping and the node has no specific sheet name, use it
  const keys = Object.keys(mapping)
  if (keys.length === 1 && keys[0]) {
    return { sheetName: keys[0], spreadsheetId: mapping[keys[0]]! }
  }

  return null
}

export async function wirePackSheets(
  pack: WorkflowPackResult,
  sheetIds: SheetIdMapping,
  options: {
    dryRun: boolean
    n8nBaseUrl?: string
    n8nApiKey?: string
  },
): Promise<PackWireReport> {
  const { dryRun, n8nBaseUrl, n8nApiKey } = options

  const results: WireResult[] = []

  for (const wf of pack.workflows) {
    if (wf.error || !wf.workflowId) {
      results.push({
        workflowName: wf.name,
        n8nWorkflowId: wf.workflowId,
        sheetsPatched: [],
        validationPassed: false,
        validationIssues: [],
        pushed: false,
        skipped: true,
        skipReason: wf.error ? 'Workflow had a build error' : 'Workflow was not deployed (no ID)',
      })
      continue
    }

    const result: WireResult = {
      workflowName: wf.name,
      n8nWorkflowId: wf.workflowId,
      sheetsPatched: [],
      validationPassed: false,
      validationIssues: [],
      pushed: false,
    }

    try {
      // Fetch current workflow from n8n (or skip if no connection info)
      let workflow: N8nWorkflow

      if (!dryRun && n8nBaseUrl && n8nApiKey) {
        const { N8nApiClient } = await import('../providers/n8n/api-client.js')
        const client = new N8nApiClient(n8nBaseUrl, n8nApiKey)
        const response = await client.getWorkflow(wf.workflowId)
        workflow = response as unknown as N8nWorkflow
      } else {
        // Dry run or no n8n connection: nothing to fetch, report what would be patched
        result.skipped = true
        result.skipReason = dryRun ? 'Dry run — no changes made' : 'No n8n connection configured'

        // Still find sheet nodes and report what would be patched
        const sheetNodes = findSheetNodes({
          name: wf.name,
          nodes: [],
          connections: {},
        })

        results.push(result)
        continue
      }

      // Find all Google Sheets nodes
      const sheetNodes = findSheetNodes(workflow)

      if (sheetNodes.length === 0) {
        result.skipped = true
        result.skipReason = 'No Google Sheets nodes found in this workflow'
        results.push(result)
        continue
      }

      // Patch each sheet node
      let patched = false
      const patchedWorkflow: N8nWorkflow = {
        ...workflow,
        nodes: [...workflow.nodes],
      }

      for (const { nodeName, nodeIndex } of sheetNodes) {
        const node = patchedWorkflow.nodes[nodeIndex]!
        const params = node.parameters as Record<string, unknown>
        const match = resolveSheetName(params, sheetIds)

        if (!match) {
          result.validationIssues.push(
            `Node "${nodeName}": could not match to a sheet in the provided mapping. ` +
            `Available sheets: ${Object.keys(sheetIds).join(', ')}`,
          )
          continue
        }

        const newParams = patchSheetDocumentId(params, match.spreadsheetId)
        patchedWorkflow.nodes[nodeIndex] = { ...node, parameters: newParams }
        result.sheetsPatched.push({
          nodeName,
          sheetName: match.sheetName,
          spreadsheetId: match.spreadsheetId,
        })
        patched = true
      }

      if (!patched) {
        result.validationIssues.push('No sheet nodes could be matched to the provided sheet ID mapping')
        results.push(result)
        continue
      }

      // Re-validate the patched workflow
      const { N8nValidator } = await import('../validation/validator.js')
      const { NodeRegistry } = await import('../validation/registry.js')
      const registry = new NodeRegistry()
      const validator = new N8nValidator(registry)
      const validation = validator.validate(patchedWorkflow)
      const errors = validation.issues.filter(i => i.severity === 'error')

      result.validationPassed = errors.length === 0
      if (errors.length > 0) {
        result.validationIssues.push(...errors.map(e => `[Rule ${e.rule}] ${e.message}`))
      }

      // Push back to n8n if validation passed and not a dry run
      if (result.validationPassed && !dryRun && n8nBaseUrl && n8nApiKey) {
        const { N8nApiClient } = await import('../providers/n8n/api-client.js')
        const client = new N8nApiClient(n8nBaseUrl, n8nApiKey)
        await client.updateWorkflow(wf.workflowId, patchedWorkflow)
        result.pushed = true
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
    }

    results.push(result)
  }

  const totalPatched = results.reduce((s, r) => s + r.sheetsPatched.length, 0)
  const totalPushed = results.filter(r => r.pushed).length
  const totalErrors = results.filter(r => r.error).length

  return { packName: pack.packName, dryRun, results, totalPatched, totalPushed, totalErrors }
}

export function formatWireReport(report: PackWireReport): string {
  const lines: string[] = []
  const tag = report.dryRun ? '[DRY RUN] ' : ''

  lines.push(`${tag}Pack Wire Report — "${report.packName}"`)
  lines.push('='.repeat(60))

  for (const r of report.results) {
    if (r.skipped) {
      lines.push(`\n  SKIP  ${r.workflowName} — ${r.skipReason}`)
      continue
    }
    if (r.error) {
      lines.push(`\n  ERROR ${r.workflowName}: ${r.error}`)
      continue
    }

    const status = r.validationPassed ? (r.pushed ? '  DONE' : '  VALID') : ' FAIL '
    lines.push(`\n${status}  ${r.workflowName}`)

    for (const p of r.sheetsPatched) {
      const action = r.pushed ? 'Patched' : 'Would patch'
      lines.push(`         → ${action} node "${p.nodeName}" → sheet "${p.sheetName}" (${p.spreadsheetId})`)
    }

    if (r.validationIssues.length > 0) {
      for (const issue of r.validationIssues) {
        lines.push(`         ✗ ${issue}`)
      }
    }
  }

  lines.push('')
  lines.push('─'.repeat(60))
  if (report.dryRun) {
    lines.push(`Dry run complete. ${report.totalPatched} patch(es) would be applied across ${report.results.length} workflow(s).`)
  } else {
    lines.push(`Done. ${report.totalPushed} workflow(s) updated, ${report.totalPatched} sheet(s) patched, ${report.totalErrors} error(s).`)
  }

  return lines.join('\n')
}
