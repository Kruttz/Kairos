import type { TrustLevel } from '../library/types.js'
import type { N8nWorkflow } from '../types/workflow.js'

interface SafetyResult {
  trustLevel: TrustLevel
  reasons: string[]
}

const BLOCKED_NODE_TYPES = new Set([
  'n8n-nodes-base.code',
  'n8n-nodes-base.executeCommand',
  'n8n-nodes-base.ssh',
])

const REVIEW_NODE_TYPES = new Set([
  'n8n-nodes-base.httpRequest',
])

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/,
  /AIza[a-zA-Z0-9_-]{35}/,
  /AKIA[A-Z0-9]{16}/,
]

export function assessTemplateSafety(workflow: N8nWorkflow): SafetyResult {
  const reasons: string[] = []
  let worst: TrustLevel = 'safe'

  const escalate = (level: TrustLevel, reason: string) => {
    reasons.push(reason)
    if (level === 'blocked') worst = 'blocked'
    else if (level === 'review' && worst === 'safe') worst = 'review'
  }

  for (const node of workflow.nodes) {
    if (BLOCKED_NODE_TYPES.has(node.type)) {
      escalate('blocked', `Contains ${node.type} node "${node.name}"`)
    }

    if (REVIEW_NODE_TYPES.has(node.type)) {
      escalate('review', `Contains ${node.type} node "${node.name}"`)
    }

    const paramStr = JSON.stringify(node.parameters)
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(paramStr)) {
        escalate('blocked', `Node "${node.name}" parameters contain a hardcoded secret`)
        break
      }
    }
  }

  return { trustLevel: worst, reasons }
}
