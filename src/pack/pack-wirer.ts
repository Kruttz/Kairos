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

// Google Sheets documentId is an n8n ResourceLocator: { "__rl": true, "mode": "id", "value": "..." }
// (__rl is a boolean flag; mode and value are siblings on the documentId object itself)
export function extractSheetDocumentId(params: Record<string, unknown>): string | null {
  const doc = params['documentId']
  if (typeof doc === 'string') return doc
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const value = (doc as Record<string, unknown>)['value']
    return typeof value === 'string' ? value : null
  }
  return null
}

export function patchSheetDocumentId(
  params: Record<string, unknown>,
  newId: string,
): Record<string, unknown> {
  const doc = params['documentId']
  const existing = doc && typeof doc === 'object' && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)
    : {}
  return {
    ...params,
    documentId: { ...existing, __rl: true, mode: 'id', value: newId },
  }
}

export function findSheetNodes(workflow: N8nWorkflow): Array<{
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
export function resolveSheetName(
  params: Record<string, unknown>,
  mapping: SheetIdMapping,
): { sheetName: string; spreadsheetId: string } | null {
  // Try to find a matching sheet name in the mapping by checking sheetName parameter
  const sheetNameParam = params['sheetName'] as string | Record<string, unknown> | undefined
  let candidate: string | undefined

  if (typeof sheetNameParam === 'string') {
    candidate = sheetNameParam
  } else if (sheetNameParam && typeof sheetNameParam === 'object') {
    // ResourceLocator: { __rl: true, mode, value } — value holds the sheet name/id
    const value = (sheetNameParam as Record<string, unknown>)['value']
    if (typeof value === 'string') candidate = value
  }

  if (candidate) {
    // Direct match
    const direct = mapping[candidate]
    if (direct) return { sheetName: candidate, spreadsheetId: direct }
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

  // A single client for all workflows. Wiring always needs to READ the deployed
  // workflow from n8n — even in dry-run — because the pack result doesn't carry
  // the workflow JSON. Dry-run only skips the write-back.
  let client: import('../providers/n8n/api-client.js').N8nApiClient | null = null
  if (n8nBaseUrl && n8nApiKey) {
    const { N8nApiClient } = await import('../providers/n8n/api-client.js')
    const { nullLogger } = await import('../utils/logger.js')
    client = new N8nApiClient(n8nBaseUrl, n8nApiKey, nullLogger)
  }

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
      if (!client) {
        result.skipped = true
        result.skipReason = 'No n8n connection configured — set N8N_BASE_URL and N8N_API_KEY (wiring reads the deployed workflow even in dry-run)'
        results.push(result)
        continue
      }

      const response = await client.getWorkflow(wf.workflowId)
      // Build a clean workflow from the response — the raw GET payload carries
      // read-only fields (id, active, createdAt, versionId, …) that n8n's
      // PUT /workflows rejects as additional properties.
      const workflow: N8nWorkflow = {
        name: response.name,
        nodes: response.nodes,
        connections: response.connections,
        settings: response.settings ?? {},
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
      if (result.validationPassed && !dryRun) {
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
