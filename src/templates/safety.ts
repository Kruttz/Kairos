import type { TrustLevel } from '../library/types.js'
import type { N8nWorkflow } from '../types/workflow.js'

interface SafetyResult {
  trustLevel: TrustLevel
  reasons: string[]
}

export interface SafetyOptions {
  // 'block' (default) treats a code node as blocked, matching n8n.io template sync behavior.
  // 'review' demotes a code node alone to the review tier — used by local-dir import, where
  // code nodes are common in community workflows and are never executed by Kairos (they're
  // prompt examples only). Secrets, executeCommand, and ssh are ALWAYS blocked regardless.
  codeNodePolicy?: 'block' | 'review'
}

const CODE_NODE_TYPE = 'n8n-nodes-base.code'

const BLOCKED_NODE_TYPES = new Set([
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

// Looser prefixes for scanning inside expressions where the full token may be split
// across string concatenation (e.g. "ghp_" + "sometoken..."). We flag any expression
// containing one of these high-signal prefixes for human review.
const SECRET_PREFIXES = ['sk-', 'ghp_', 'xoxb-', 'AIza', 'AKIA']

function collectExpressionStrings(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === 'string') {
    if (obj.includes('={{')) out.push(obj)
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectExpressionStrings(item, out)
  } else if (obj !== null && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      collectExpressionStrings(val, out)
    }
  }
  return out
}

export function assessTemplateSafety(workflow: N8nWorkflow, options?: SafetyOptions): SafetyResult {
  const codeNodePolicy = options?.codeNodePolicy ?? 'block'
  const reasons: string[] = []
  let worst: TrustLevel = 'safe'

  const escalate = (level: TrustLevel, reason: string) => {
    reasons.push(reason)
    if (level === 'blocked') worst = 'blocked'
    else if (level === 'review' && worst === 'safe') worst = 'review'
  }

  for (const node of workflow.nodes) {
    if (node.type === CODE_NODE_TYPE) {
      escalate(codeNodePolicy === 'review' ? 'review' : 'blocked', `Contains ${node.type} node "${node.name}"`)
    } else if (BLOCKED_NODE_TYPES.has(node.type)) {
      escalate('blocked', `Contains ${node.type} node "${node.name}"`)
    }

    if (REVIEW_NODE_TYPES.has(node.type)) {
      escalate('review', `Contains ${node.type} node "${node.name}"`)
    }

    // Scan serialized parameters for literal secrets
    const paramStr = JSON.stringify(node.parameters)
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(paramStr)) {
        escalate('blocked', `Node "${node.name}" parameters contain a hardcoded secret`)
        break
      }
    }

    // Scan expression strings for split/concatenated secret prefixes
    // e.g. ={{ "ghp_" + variable }} won't match the full regex but the prefix is a red flag
    const expressions = collectExpressionStrings(node.parameters)
    for (const expr of expressions) {
      for (const prefix of SECRET_PREFIXES) {
        if (expr.includes(prefix)) {
          escalate('review', `Node "${node.name}" has an expression containing credential-like prefix "${prefix}"`)
          break
        }
      }
    }
  }

  return { trustLevel: worst, reasons }
}
