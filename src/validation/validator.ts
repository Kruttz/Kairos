import type { N8nWorkflow, N8nNode } from '../types/workflow.js'
import type { ValidationIssue, ValidationResult } from './types.js'
import { NodeRegistry, DEFAULT_REGISTRY } from './registry.js'
import { FORBIDDEN_ON_CREATE } from '../providers/n8n/types.js'

const AI_CONNECTION_TYPES = [
  'ai_languageModel',
  'ai_memory',
  'ai_tool',
  'ai_outputParser',
  'ai_embedding',
  'ai_document',
  'ai_textSplitter',
  'ai_retriever',
  'ai_vectorStore',
]

const TRIGGER_TYPE_PATTERNS = [/trigger/i, /Trigger$/]

const NODE_TYPE_PATTERN = /^(@[a-z0-9-]+\/[a-z0-9-]+\.|n8n-nodes-[a-z0-9-]+\.)[a-zA-Z][a-zA-Z0-9-]+$/

export class N8nValidator {
  private readonly registry: NodeRegistry

  constructor(registry: NodeRegistry = new NodeRegistry(DEFAULT_REGISTRY)) {
    this.registry = registry
  }

  validate(workflow: N8nWorkflow): ValidationResult {
    const issues: ValidationIssue[] = []

    this.checkRule1(workflow, issues)
    this.checkRule2(workflow, issues)
    this.checkRule3(workflow, issues)
    this.checkRule4(workflow, issues)
    this.checkRule5(workflow, issues)
    this.checkRule6(workflow, issues)
    this.checkRule7(workflow, issues)
    this.checkRule8(workflow, issues)
    this.checkRule9(workflow, issues)
    this.checkRule10(workflow, issues)
    this.checkRule11(workflow, issues)
    this.checkRule12(workflow, issues)
    this.checkRule13(workflow, issues)
    this.checkRule14(workflow, issues)
    this.checkRule15(workflow, issues)
    this.checkRule16(workflow, issues)
    this.checkRule17(workflow, issues)
    this.checkRule18(workflow, issues)
    this.checkRule19(workflow, issues)
    this.checkRule20(workflow, issues)
    this.checkRule21(workflow, issues)
    this.checkRule22(workflow, issues)
    this.checkRule23(workflow, issues)
    this.checkRule24(workflow, issues)
    this.checkRule25(workflow, issues)
    this.checkRule26(workflow, issues)

    // Enrich issues with nodeType by looking up nodeId
    if (Array.isArray(workflow.nodes)) {
      const nodeById = new Map(workflow.nodes.map(n => [n.id, n.type]))
      for (const issue of issues) {
        if (issue.nodeId && !issue.nodeType) {
          const nt = nodeById.get(issue.nodeId)
          if (nt) issue.nodeType = nt
        }
      }
    }

    const errors = issues.filter((i) => i.severity === 'error')
    return { valid: errors.length === 0, issues }
  }

  private err(issues: ValidationIssue[], rule: number, message: string, nodeId?: string, nodeType?: string): void {
    const issue: ValidationIssue = { rule, severity: 'error', message }
    if (nodeId !== undefined) issue.nodeId = nodeId
    if (nodeType !== undefined) issue.nodeType = nodeType
    issues.push(issue)
  }

  private warn(issues: ValidationIssue[], rule: number, message: string, nodeId?: string, nodeType?: string): void {
    const issue: ValidationIssue = { rule, severity: 'warn', message }
    if (nodeId !== undefined) issue.nodeId = nodeId
    if (nodeType !== undefined) issue.nodeType = nodeType
    issues.push(issue)
  }

  private isTriggerNode(node: N8nNode): boolean {
    if (this.registry.isTrigger(node.type)) return true
    return TRIGGER_TYPE_PATTERNS.some((p) => p.test(node.type))
  }

  // Rule 1: name is a non-empty string
  private checkRule1(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (typeof w.name !== 'string' || w.name.trim() === '') {
      this.err(issues, 1, 'Workflow name is required and must be a non-empty string')
    }
  }

  // Rule 2: nodes is an array with at least one element
  private checkRule2(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || w.nodes.length === 0) {
      this.err(issues, 2, 'Workflow must have at least one node')
    }
  }

  // Rule 3: every node has a non-empty id
  private checkRule3(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.id !== 'string' || node.id.trim() === '') {
        this.err(issues, 3, `Node "${node.name ?? 'unknown'}" is missing a valid id`, node.id)
      }
    }
  }

  // Rule 4: node ids are unique
  private checkRule4(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const seen = new Set<string>()
    for (const node of w.nodes) {
      if (!node.id) continue
      if (seen.has(node.id)) {
        this.err(issues, 4, `Duplicate node id: "${node.id}"`, node.id)
      }
      seen.add(node.id)
    }
  }

  // Rule 5: every node has a non-empty type string
  private checkRule5(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.type !== 'string' || node.type.trim() === '') {
        this.err(issues, 5, `Node "${node.name ?? node.id}" is missing a type`, node.id)
      }
    }
  }

  // Rule 6: every node has a positive typeVersion number
  private checkRule6(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.typeVersion !== 'number' || node.typeVersion <= 0) {
        this.err(issues, 6, `Node "${node.name}" has invalid typeVersion: ${String(node.typeVersion)}`, node.id)
      }
    }
  }

  // Rule 7: every node has a valid [x, y] position
  private checkRule7(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      const pos = node.position
      if (
        !Array.isArray(pos) ||
        pos.length !== 2 ||
        typeof pos[0] !== 'number' ||
        typeof pos[1] !== 'number'
      ) {
        this.err(issues, 7, `Node "${node.name}" has invalid position (must be [x, y])`, node.id)
      }
    }
  }

  // Rule 8: every node has a non-empty name
  private checkRule8(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.name !== 'string' || node.name.trim() === '') {
        this.err(issues, 8, `Node with id "${node.id}" is missing a name`, node.id)
      }
    }
  }

  // Rule 9: connections is a plain object
  private checkRule9(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (typeof w.connections !== 'object' || w.connections === null || Array.isArray(w.connections)) {
      this.err(issues, 9, 'connections must be a plain object (use {} for single-node workflows)')
    }
  }

  // Rule 10: every connection target node name exists in nodes
  private checkRule10(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return
    const nodeNames = new Set(w.nodes.map((n) => n.name))
    for (const [sourceName, outputs] of Object.entries(w.connections)) {
      if (!nodeNames.has(sourceName)) {
        this.err(issues, 10, `Connection source "${sourceName}" does not exist in nodes`)
        continue
      }
      if (typeof outputs !== 'object' || outputs === null) continue
      for (const portGroup of Object.values(outputs)) {
        if (!Array.isArray(portGroup)) continue
        for (const targets of portGroup) {
          if (!Array.isArray(targets)) continue
          for (const target of targets) {
            const t = target as { node?: string }
            if (typeof t?.node === 'string' && !nodeNames.has(t.node)) {
              this.err(issues, 10, `Connection target "${t.node}" does not exist in nodes`)
            }
          }
        }
      }
    }
  }

  // Rule 11 (WARN): every non-trigger node has at least one incoming connection
  private checkRule11(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return
    const reachable = new Set<string>()
    for (const [, outputs] of Object.entries(w.connections)) {
      if (typeof outputs !== 'object' || outputs === null) continue
      for (const portGroup of Object.values(outputs)) {
        if (!Array.isArray(portGroup)) continue
        for (const targets of portGroup) {
          if (!Array.isArray(targets)) continue
          for (const target of targets) {
            const t = target as { node?: string }
            if (typeof t?.node === 'string') reachable.add(t.node)
          }
        }
      }
    }
    for (const node of w.nodes) {
      if (node.type.includes('stickyNote')) continue
      if (!this.isTriggerNode(node) && !reachable.has(node.name)) {
        this.warn(issues, 11, `Node "${node.name}" has no incoming connections and may never execute`, node.id)
      }
    }
  }

  // Rule 12: forbidden fields absent from workflow root
  private checkRule12(w: N8nWorkflow, issues: ValidationIssue[]): void {
    const wObj = w as unknown as Record<string, unknown>
    for (const field of FORBIDDEN_ON_CREATE) {
      if (field in wObj) {
        this.err(issues, 12, `Forbidden field "${field}" present in workflow — remove it before deploying`)
      }
    }
  }

  // Rule 13: settings, if present, is a plain object
  private checkRule13(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (w.settings !== undefined) {
      if (typeof w.settings !== 'object' || w.settings === null || Array.isArray(w.settings)) {
        this.err(issues, 13, 'workflow.settings must be a plain object')
      }
    }
  }

  // Rule 14: at least one trigger node is present
  private checkRule14(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const hasTrigger = w.nodes.some((n) => this.isTriggerNode(n))
    if (!hasTrigger) {
      this.err(issues, 14, 'Workflow must contain at least one trigger node')
    }
  }

  // Rule 15: node type string matches expected format
  private checkRule15(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.type !== 'string') continue
      if (!NODE_TYPE_PATTERN.test(node.type)) {
        this.err(issues, 15, `Node "${node.name}" has malformed type string: "${node.type}"`, node.id)
      }
    }
  }

  // Rule 16: node names are unique within the workflow
  private checkRule16(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const seen = new Set<string>()
    for (const node of w.nodes) {
      if (!node.name) continue
      if (seen.has(node.name)) {
        this.err(issues, 16, `Duplicate node name: "${node.name}"`, node.id)
      }
      seen.add(node.name)
    }
  }

  // Rule 17: credentials shape — each entry has id and name
  private checkRule17(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (!node.credentials) continue
      for (const [credType, credRef] of Object.entries(node.credentials)) {
        if (typeof credRef !== 'object' || credRef === null) {
          this.err(issues, 17, `Node "${node.name}" credential "${credType}" must be an object with id and name`, node.id)
          continue
        }
        const ref = credRef as unknown as Record<string, unknown>
        if (
          typeof ref['id'] !== 'string' || ref['id'].trim() === '' ||
          typeof ref['name'] !== 'string' || ref['name'].trim() === ''
        ) {
          this.err(issues, 17, `Node "${node.name}" credential "${credType}" must have non-empty string id and name fields`, node.id)
        }
      }
    }
  }

  // Rule 18 (ERROR): AI connections must originate from sub-nodes, not the agent/chain root
  private checkRule18(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (typeof w.connections !== 'object' || w.connections === null) return
    const agentTypes = new Set([
      '@n8n/n8n-nodes-langchain.agent',
      '@n8n/n8n-nodes-langchain.chainLlm',
      '@n8n/n8n-nodes-langchain.chainRetrievalQa',
      '@n8n/n8n-nodes-langchain.chainSummarization',
    ])
    if (!Array.isArray(w.nodes)) return
    const nodesByName = new Map(w.nodes.map((n) => [n.name, n]))

    for (const [sourceName, outputs] of Object.entries(w.connections)) {
      const sourceNode = nodesByName.get(sourceName)
      if (!sourceNode) continue
      if (!agentTypes.has(sourceNode.type)) continue
      if (typeof outputs !== 'object' || outputs === null) continue
      for (const connType of AI_CONNECTION_TYPES) {
        if (connType in outputs) {
          this.err(
            issues,
            18,
            `Node "${sourceName}" uses AI connection type "${connType}" as a SOURCE — AI sub-nodes should be the source, not the agent/chain root`,
            sourceNode.id,
          )
        }
      }
    }
  }

  // Rule 19 (WARN): typeVersion is within known safe range for registered node types
  private checkRule19(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.type !== 'string' || typeof node.typeVersion !== 'number') continue
      if (!this.registry.isVersionSafe(node.type, node.typeVersion)) {
        this.warn(
          issues,
          19,
          `Node "${node.name}" uses typeVersion ${node.typeVersion} for type "${node.type}" which is not in the known safe list`,
          node.id,
        )
      }
    }
  }

  // Rule 20 (WARN): cycle detection — no node should be reachable from itself
  // Exempts splitInBatches loops which are an intentional n8n pattern
  private checkRule20(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return

    const splitBatchNodes = new Set(
      w.nodes.filter((n) => n.type.includes('splitInBatches')).map((n) => n.name),
    )

    const adj = new Map<string, string[]>()
    for (const [sourceName, outputs] of Object.entries(w.connections)) {
      if (typeof outputs !== 'object' || outputs === null) continue
      const targets: string[] = []
      for (const portGroup of Object.values(outputs)) {
        if (!Array.isArray(portGroup)) continue
        for (const conns of portGroup) {
          if (!Array.isArray(conns)) continue
          for (const conn of conns) {
            const t = conn as { node?: string }
            if (typeof t?.node === 'string') {
              if (splitBatchNodes.has(t.node)) continue
              targets.push(t.node)
            }
          }
        }
      }
      adj.set(sourceName, targets)
    }

    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    for (const node of w.nodes) color.set(node.name, WHITE)

    const dfs = (name: string): boolean => {
      color.set(name, GRAY)
      for (const neighbor of adj.get(name) ?? []) {
        const c = color.get(neighbor)
        if (c === GRAY) return true
        if (c === WHITE && dfs(neighbor)) return true
      }
      color.set(name, BLACK)
      return false
    }

    for (const node of w.nodes) {
      if (color.get(node.name) === WHITE && dfs(node.name)) {
        this.warn(issues, 20, 'Workflow contains a connection cycle — this may cause infinite loops')
        return
      }
    }
  }

  // Rule 22 (WARN): check requiredParams from registry
  private checkRule22(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.type !== 'string') continue
      const required = this.registry.getRequiredParams(node.type)
      if (required.length === 0) continue
      const params = (node.parameters ?? {}) as Record<string, unknown>
      for (const param of required) {
        const value = params[param]
        if (value === undefined || value === null || value === '') {
          this.warn(
            issues,
            22,
            `Node "${node.name}" (${node.type}) is missing required parameter "${param}"`,
            node.id,
          )
        }
      }
    }
  }

  // Rule 23 (WARN): unknown node types not in registry
  private checkRule23(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (typeof node.type !== 'string') continue
      if (node.type.includes('stickyNote')) continue
      if (!NODE_TYPE_PATTERN.test(node.type)) continue
      if (!this.registry.isKnown(node.type)) {
        this.warn(
          issues,
          23,
          `Node "${node.name}" uses unknown type "${node.type}" — it may not exist in n8n`,
          node.id,
        )
      }
    }
  }

  // Rule 24 (WARN): deprecated accessor syntax in expressions
  private checkRule24(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const deprecated = /\$node\s*\[/
    for (const node of w.nodes) {
      for (const expr of this.extractExpressions(node.parameters)) {
        if (deprecated.test(expr)) {
          this.warn(
            issues,
            24,
            `Node "${node.name}" uses deprecated accessor $node["..."] — use $('NodeName').item.json.field instead`,
            node.id,
          )
          break
        }
      }
    }
  }

  // Rule 25 (WARN): wrong item index assumptions in expressions
  private checkRule25(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const itemIndex = /\$json\s*\.\s*items\s*\[/
    for (const node of w.nodes) {
      for (const expr of this.extractExpressions(node.parameters)) {
        if (itemIndex.test(expr)) {
          this.warn(
            issues,
            25,
            `Node "${node.name}" accesses $json.items[n] — n8n flattens items automatically, use $json.field directly`,
            node.id,
          )
          break
        }
      }
    }
  }

  // Rule 26 (WARN): missing .first() or .all() on node references
  private checkRule26(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const bareRef = /\$\(\s*'[^']+'\s*\)\s*\.json/
    for (const node of w.nodes) {
      for (const expr of this.extractExpressions(node.parameters)) {
        if (bareRef.test(expr)) {
          this.warn(
            issues,
            26,
            `Node "${node.name}" references $('NodeName').json without .first() or .all() — use $('NodeName').first().json.field`,
            node.id,
          )
          break
        }
      }
    }
  }

  private extractExpressions(params: Record<string, unknown>): string[] {
    const expressions: string[] = []
    const walk = (val: unknown): void => {
      if (typeof val === 'string') {
        if (val.includes('={{') || val.includes('$node') || val.includes("$('")) {
          expressions.push(val)
        }
      } else if (Array.isArray(val)) {
        for (const item of val) walk(item)
      } else if (val !== null && typeof val === 'object') {
        for (const v of Object.values(val as Record<string, unknown>)) walk(v)
      }
    }
    walk(params)
    return expressions
  }

  // Rule 21 (WARN): webhook with responseMode="responseNode" must have respondToWebhook node
  private checkRule21(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    const webhooksNeedingResponse = w.nodes.filter((n) => {
      if (!n.type.includes('webhook')) return false
      const params = n.parameters as Record<string, unknown> | undefined
      return params?.responseMode === 'responseNode'
    })

    if (webhooksNeedingResponse.length === 0) return

    const hasRespondNode = w.nodes.some((n) => n.type.includes('respondToWebhook'))
    if (!hasRespondNode) {
      for (const wh of webhooksNeedingResponse) {
        this.warn(
          issues,
          21,
          `Webhook "${wh.name}" uses responseMode "responseNode" but no respondToWebhook node exists in the workflow`,
          wh.id,
        )
      }
    }
  }
}
