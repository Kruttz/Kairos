import type { N8nWorkflow, N8nNode } from '../types/workflow.js'
import type { CredentialRequirement } from '../types/result.js'
import type { ValidationIssue } from '../validation/types.js'
import { NodeRegistry, DEFAULT_REGISTRY } from '../validation/registry.js'

const registry = new NodeRegistry(DEFAULT_REGISTRY)

function isTriggerType(type: string): boolean {
  return registry.isTrigger(type) || /trigger/i.test(type)
}

// Short human labels for the most common n8n node types. Anything not listed here falls
// back to a cleaned-up version of the raw type string rather than guessing a description —
// this must never require a new Claude call, so an unrecognized type just says what it is.
const NODE_LABELS: Record<string, string> = {
  'n8n-nodes-base.webhook': 'receives an incoming webhook',
  'n8n-nodes-base.scheduleTrigger': 'runs on a schedule',
  'n8n-nodes-base.manualTrigger': 'is triggered manually',
  'n8n-nodes-base.formTrigger': 'receives a form submission',
  'n8n-nodes-base.emailReadImap': 'watches an email inbox',
  'n8n-nodes-base.gmailTrigger': 'watches Gmail for new email',
  'n8n-nodes-base.slackTrigger': 'watches Slack for events',
  'n8n-nodes-base.telegramTrigger': 'watches Telegram for messages',
  'n8n-nodes-base.githubTrigger': 'watches a GitHub repo for events',
  'n8n-nodes-base.stripeTrigger': 'watches Stripe for payment events',
  'n8n-nodes-base.airtableTrigger': 'watches an Airtable base for changes',
  'n8n-nodes-base.notionTrigger': 'watches Notion for changes',
  'n8n-nodes-base.googleDriveTrigger': 'watches Google Drive for changes',
  'n8n-nodes-base.googleSheetsTrigger': 'watches a Google Sheet for changes',
  'n8n-nodes-base.errorTrigger': 'runs when another workflow errors',
  '@n8n/n8n-nodes-langchain.chatTrigger': 'receives a chat message',
  'n8n-nodes-base.httpRequest': 'calls an external API',
  'n8n-nodes-base.slack': 'sends a Slack message',
  'n8n-nodes-base.gmail': 'sends an email via Gmail',
  'n8n-nodes-base.emailSend': 'sends an email',
  'n8n-nodes-base.googleSheets': "reads or writes a Google Sheet",
  'n8n-nodes-base.airtable': 'reads or writes an Airtable base',
  'n8n-nodes-base.notion': 'reads or writes Notion',
  'n8n-nodes-base.postgres': 'queries a Postgres database',
  'n8n-nodes-base.mySql': 'queries a MySQL database',
  'n8n-nodes-base.redis': 'reads or writes Redis',
  'n8n-nodes-base.mongoDb': 'queries a MongoDB database',
  'n8n-nodes-base.telegram': 'sends a Telegram message',
  'n8n-nodes-base.awsS3': 'reads or writes S3',
  'n8n-nodes-base.set': 'transforms or sets data fields',
  'n8n-nodes-base.code': 'runs custom code',
  'n8n-nodes-base.if': 'branches based on a condition',
  'n8n-nodes-base.switch': 'routes based on a condition',
  'n8n-nodes-base.merge': 'merges multiple data streams',
  'n8n-nodes-base.splitInBatches': 'processes items in batches',
  'n8n-nodes-base.filter': 'filters items',
  'n8n-nodes-base.wait': 'pauses before continuing',
  'n8n-nodes-base.respondToWebhook': 'sends the webhook response',
  '@n8n/n8n-nodes-langchain.agent': 'runs an AI agent',
}

function humanLabel(node: N8nNode): string {
  const known = NODE_LABELS[node.type]
  if (known) return known
  const shortType = node.type.replace(/^.*\./, '')
  return `uses ${shortType}`
}

/**
 * Deterministic, plain-English "what this workflow does" summary — built entirely from
 * data a build already produces (no new Claude call). Falls back to the raw node type for
 * anything not in the label dictionary rather than inventing a description.
 */
export function summarizeWorkflow(
  workflow: N8nWorkflow,
  credentialsNeeded: CredentialRequirement[],
  issues: ValidationIssue[],
): string {
  const lines: string[] = []
  const triggers = workflow.nodes.filter((n) => isTriggerType(n.type))
  const steps = workflow.nodes.filter((n) => !isTriggerType(n.type))

  lines.push(`"${workflow.name}"`)

  if (triggers.length === 0) {
    lines.push('No trigger node found.')
  } else {
    for (const t of triggers) {
      lines.push(`Trigger: "${t.name}" — ${humanLabel(t)}.`)
    }
  }

  if (steps.length > 0) {
    lines.push(`Then (${steps.length} step${steps.length === 1 ? '' : 's'}):`)
    for (const s of steps) {
      lines.push(`  - "${s.name}" — ${humanLabel(s)}`)
    }
  }

  if (credentialsNeeded.length > 0) {
    lines.push('')
    lines.push('Credentials needed:')
    for (const c of credentialsNeeded) {
      lines.push(`  - ${c.service} (${c.credentialType}): ${c.description}`)
    }
  }

  const warnings = issues.filter((i) => i.severity === 'warn')
  if (warnings.length > 0) {
    lines.push('')
    lines.push(`Warnings (${warnings.length}):`)
    for (const w of warnings) {
      lines.push(`  - ${w.message}`)
    }
  }

  return lines.join('\n')
}
