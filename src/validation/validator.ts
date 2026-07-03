import type { N8nWorkflow, N8nNode } from '../types/workflow.js'
import type { ValidationIssue, ValidationResult } from './types.js'
import { NodeRegistry, DEFAULT_REGISTRY } from './registry.js'
import { FORBIDDEN_ON_CREATE } from '../providers/n8n/types.js'
import { NODE_OPERATION_CATALOG } from './node-catalog-generated.js'

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
    this.checkRule27(workflow, issues)
    this.checkRule28(workflow, issues)
    this.checkRule29(workflow, issues)
    this.checkRule30(workflow, issues)
    this.checkRule31(workflow, issues)
    this.checkRule32(workflow, issues)
    this.checkRule33(workflow, issues)
    this.checkRule34(workflow, issues)
    this.checkRule35(workflow, issues)
    this.checkRule36(workflow, issues)
    this.checkRule37(workflow, issues)
    this.checkRule38(workflow, issues)
    this.checkRule39(workflow, issues)
    this.checkRule40(workflow, issues)
    this.checkRule41(workflow, issues)
    this.checkRule42(workflow, issues)
    this.checkRule43(workflow, issues)
    this.checkRule44(workflow, issues)
    this.checkRule45(workflow, issues)
    this.checkRule46(workflow, issues)
    this.checkRule47(workflow, issues)
    this.checkRule48(workflow, issues)
    this.checkRule49(workflow, issues)
    this.checkRule50(workflow, issues)
    this.checkRule51(workflow, issues)
    this.checkRule52(workflow, issues)
    this.checkRule53(workflow, issues)
    this.checkRule54(workflow, issues)
    this.checkRule55(workflow, issues)
    this.checkRule56(workflow, issues)
    this.checkRule57(workflow, issues)
    this.checkRule58(workflow, issues)
    this.checkRule59(workflow, issues)
    this.checkRule60(workflow, issues)
    this.checkRule61(workflow, issues)
    this.checkRule62(workflow, issues)
    this.checkRule63(workflow, issues)
    this.checkRule65(workflow, issues)
    this.checkRule66(workflow, issues)
    this.checkRule67(workflow, issues)
    this.checkRule68(workflow, issues)
    this.checkRule69(workflow, issues)
    this.checkRule70(workflow, issues)
    this.checkRule71(workflow, issues)
    this.checkRule72(workflow, issues)
    this.checkRule73(workflow, issues)
    this.checkRule74(workflow, issues)
    this.checkRule75(workflow, issues)
    this.checkRule76(workflow, issues)
    this.checkRule77(workflow, issues)
    this.checkRule78(workflow, issues)
    this.checkRule79(workflow, issues)
    this.checkRule80(workflow, issues)
    this.checkRule81(workflow, issues)
    this.checkRule82(workflow, issues)
    this.checkRule83(workflow, issues)
    this.checkRule84(workflow, issues)
    this.checkRule85(workflow, issues)
    this.checkRule86(workflow, issues)
    this.checkRule87(workflow, issues)
    this.checkRule88(workflow, issues)
    this.checkRule89(workflow, issues)
    this.checkRule90(workflow, issues)
    this.checkRule91(workflow, issues)
    this.checkRule92(workflow, issues)
    this.checkRule93(workflow, issues)
    this.checkRule94(workflow, issues)
    this.checkRule95(workflow, issues)
    this.checkRule96(workflow, issues)
    this.checkRule97(workflow, issues)
    this.checkRule98(workflow, issues)
    this.checkRule99(workflow, issues)
    this.checkRule100(workflow, issues)
    this.checkRule101(workflow, issues)
    this.checkRule102(workflow, issues)
    this.checkRule103(workflow, issues)
    this.checkRule105(workflow, issues)
    this.checkRule106(workflow, issues)
    this.checkRule107(workflow, issues)
    this.checkRule108(workflow, issues)
    this.checkRule109(workflow, issues)
    this.checkRule110(workflow, issues)
    this.checkRule111(workflow, issues)
    this.checkRule112(workflow, issues)
    this.checkRule113(workflow, issues)
    this.checkRule114(workflow, issues)
    this.checkRule115(workflow, issues)
    this.checkRule116(workflow, issues)
    this.checkRule117(workflow, issues)
    this.checkRule118(workflow, issues)
    this.checkRule119(workflow, issues)
    this.checkRule120(workflow, issues)
    this.checkRule121(workflow, issues)
    this.checkRule122(workflow, issues)
    this.checkRule123(workflow, issues)
    this.checkRule124(workflow, issues)
    this.checkRule125(workflow, issues)
    this.checkRule126(workflow, issues)
    this.checkRule127(workflow, issues)
    this.checkRule128(workflow, issues)
    this.checkRule129(workflow, issues)

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
    // Track nodes that are sources of ai_* connections — they are purposefully
    // connectionless on main; they feed the agent as sub-nodes.
    const aiSubNodeSources = new Set<string>()
    for (const [sourceName, outputs] of Object.entries(w.connections)) {
      if (typeof outputs !== 'object' || outputs === null) continue
      let hasAiPort = false
      for (const [portName, portGroup] of Object.entries(outputs)) {
        if (!Array.isArray(portGroup)) continue
        const isAiPort = portName.startsWith('ai_')
        if (isAiPort) hasAiPort = true
        for (const targets of portGroup) {
          if (!Array.isArray(targets)) continue
          for (const target of targets) {
            const t = target as { node?: string }
            if (typeof t?.node === 'string') reachable.add(t.node)
          }
        }
      }
      if (hasAiPort) aiSubNodeSources.add(sourceName)
    }
    for (const node of w.nodes) {
      if (node.type.includes('stickyNote')) continue
      if (this.isTriggerNode(node)) continue
      if (aiSubNodeSources.has(node.name)) continue
      if (!reachable.has(node.name)) {
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

  // Rule 19 (WARN): typeVersion is within known safe range for registered node types.
  // In lenient mode (KAIROS_REGISTRY_STRICT != 'true'), versions higher than the known
  // max are allowed — they likely represent newer n8n releases Kairos hasn't catalogued yet.
  private checkRule19(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const strict = process.env['KAIROS_REGISTRY_STRICT'] === 'true'
    for (const node of w.nodes) {
      if (typeof node.type !== 'string' || typeof node.typeVersion !== 'number') continue
      if (this.registry.isVersionSafe(node.type, node.typeVersion)) continue
      // In lenient mode (default), a version that is simply higher than our known max
      // is likely a newer n8n release — skip the warning.
      if (!strict && this.registry.isVersionNewer(node.type, node.typeVersion)) continue
      this.warn(
        issues,
        19,
        `Node "${node.name}" uses typeVersion ${node.typeVersion} for type "${node.type}" which is not in the known safe list`,
        node.id,
      )
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

  // Rule 27 (WARN): httpRequest URL is a placeholder
  private checkRule27(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const PLACEHOLDER_RE = [
      /^https?:\/\/example\.com/i,
      /your[-_]?(api[-_]?)?url/i,
      /^https?:\/\/$/,
      /^<.+>$/,
      /placeholder/i,
    ]
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const url = params?.['url']
      if (typeof url !== 'string' || url.trim() === '') continue
      if (PLACEHOLDER_RE.some((re) => re.test(url.trim()))) {
        this.warn(
          issues,
          27,
          `Node "${node.name}" httpRequest URL appears to be a placeholder: "${url}" — replace with your actual endpoint`,
          node.id,
        )
      }
    }
  }

  // Rule 28 (WARN): code node with empty or comment-only code
  private checkRule28(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const jsCode = typeof params?.['jsCode'] === 'string' ? params['jsCode'] : ''
      const pythonCode = typeof params?.['pythonCode'] === 'string' ? params['pythonCode'] : ''
      const code = jsCode || pythonCode
      const stripped = code
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/#[^\n]*/g, '')
        .trim()
      if (!stripped) {
        this.warn(issues, 28, `Node "${node.name}" code node has no executable code`, node.id)
      }
    }
  }

  // Rule 29 (WARN): slack node message operation missing channel
  private checkRule29(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.slack') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const resource = params?.['resource'] as string | undefined
      const operation = params?.['operation'] as string | undefined
      const isMessageOp = resource === 'message' || operation === 'sendMessage' || operation === 'post'
      if (!isMessageOp) continue
      const channel = params?.['channel'] ?? params?.['channelId']
      const rlValue = typeof channel === 'object' && channel !== null
        ? (channel as Record<string, unknown>)['value']
        : undefined
      const isEmpty = channel === undefined || channel === null ||
        (typeof channel === 'string' && channel.trim() === '') ||
        (typeof channel === 'object' && (!rlValue || (typeof rlValue === 'string' && rlValue.trim() === '')))
      if (isEmpty) {
        this.warn(issues, 29, `Node "${node.name}" Slack message has no channel specified`, node.id)
      }
    }
  }

  // Rule 30 (WARN): gmail node send operation missing recipient
  private checkRule30(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.gmail') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const operation = params?.['operation'] as string | undefined
      if (operation !== 'send') continue
      const to = params?.['to'] ?? params?.['toList']
      const isEmpty = to === undefined || to === null ||
        (typeof to === 'string' && to.trim() === '') ||
        (Array.isArray(to) && to.length === 0)
      if (isEmpty) {
        this.warn(issues, 30, `Node "${node.name}" gmail send has no recipient (to) specified`, node.id)
      }
    }
  }

  // Rule 31 (WARN): if node with empty conditions
  private checkRule31(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.if') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const conditions = params?.['conditions']
      if (conditions === undefined || conditions === null) {
        this.warn(issues, 31, `Node "${node.name}" if node has no conditions defined`, node.id)
        continue
      }
      // typeVersion 2.x: { combinator, conditions: [...] }
      if (typeof conditions === 'object' && !Array.isArray(conditions)) {
        const conds = (conditions as Record<string, unknown>)['conditions']
        if (!Array.isArray(conds) || conds.length === 0) {
          this.warn(issues, 31, `Node "${node.name}" if node conditions array is empty`, node.id)
        }
      } else if (Array.isArray(conditions) && conditions.length === 0) {
        this.warn(issues, 31, `Node "${node.name}" if node conditions array is empty`, node.id)
      }
    }
  }

  // Rule 32 (WARN): set node with no assignments
  private checkRule32(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.set') continue
      const params = node.parameters as Record<string, unknown> | undefined
      // typeVersion 3.x: assignments.assignments[]
      const assignmentsObj = params?.['assignments'] as Record<string, unknown> | undefined
      const assignmentsArr = assignmentsObj?.['assignments']
      // typeVersion 1.x: values.string[] / values.number[] etc.
      const valuesObj = params?.['values'] as Record<string, unknown> | undefined
      const hasV1 = valuesObj && Object.values(valuesObj).some((v) => Array.isArray(v) && v.length > 0)
      const hasV3 = Array.isArray(assignmentsArr) && assignmentsArr.length > 0
      if (!hasV1 && !hasV3) {
        this.warn(
          issues,
          32,
          `Node "${node.name}" set node has no fields defined — it will pass data through unchanged`,
          node.id,
        )
      }
    }
  }

  // Rule 33 (WARN): scheduleTrigger with no schedule rules
  private checkRule33(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.scheduleTrigger') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const rule = params?.['rule'] as Record<string, unknown> | undefined
      const intervals = rule?.['interval']
      if (!Array.isArray(intervals) || intervals.length === 0) {
        this.warn(issues, 33, `Node "${node.name}" scheduleTrigger has no schedule rules defined`, node.id)
      }
    }
  }

  // Rule 35 (WARN): email-sending node with no duplicate-prevention signal
  private checkRule35(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    const sendNodes = w.nodes.filter(node => {
      if (node.type === 'n8n-nodes-base.gmail') {
        const op = (node.parameters as Record<string, unknown> | undefined)?.['operation'] as string | undefined
        // Default operation on Gmail node is send; also flag explicit send/reply
        return !op || op === 'send' || op === 'sendEmail' || op === 'reply'
      }
      return (
        node.type === 'n8n-nodes-base.emailSend' ||
        node.type === 'n8n-nodes-base.sendEmail'
      )
    })

    if (sendNodes.length === 0) return

    // Look for idempotency signals anywhere in the workflow JSON
    const workflowText = JSON.stringify(w).toLowerCase()
    const IDEMPOTENCY_SIGNALS = [
      'sent_at', 'last_sent', 'last_reminder', 'processed_at',
      'already_sent', 'email_sent', 'notified_at', 'reminder_sent',
      'contacted_at', 'dedupe', 'idempotent',
    ]
    const hasIdempotencySignal = IDEMPOTENCY_SIGNALS.some(s => workflowText.includes(s))

    if (!hasIdempotencySignal) {
      for (const node of sendNodes) {
        this.warn(
          issues,
          35,
          `Node "${node.name}" sends email but no duplicate-prevention signal detected — ` +
          `add a sent_at timestamp field, a prior-send IF check, or a deduplication key to avoid repeat sends`,
          node.id,
        )
      }
    }
  }

  // Rule 36 (WARN): Code node output field names don't match downstream $json references (camelCase vs snake_case)
  private checkRule36(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const jsCode = typeof params?.['jsCode'] === 'string' ? params['jsCode'] : ''
      if (!jsCode) continue

      const outputFields = this.extractCodeOutputFields(jsCode)
      if (outputFields.size === 0) continue

      const downstreamNames = this.getDownstreamNodes(node.name, w)
      if (downstreamNames.size === 0) continue

      for (const downstreamName of downstreamNames) {
        const downstreamNode = w.nodes.find(n => n.name === downstreamName)
        if (!downstreamNode) continue

        const refs = this.extractJsonFieldRefs(downstreamNode.parameters)
        const warned = new Set<string>()

        for (const ref of refs) {
          if (warned.has(ref)) continue
          const camelRef = this.snakeToCamel(ref)
          const snakeRef = this.camelToSnake(ref)

          // ref is snake_case but code outputs camelCase equivalent
          if (ref !== camelRef && outputFields.has(camelRef) && !outputFields.has(ref)) {
            warned.add(ref)
            this.warn(
              issues, 36,
              `Node "${downstreamNode.name}" references $json.${ref} but Code node "${node.name}" outputs "${camelRef}" — update expression to $json.${camelRef}`,
              downstreamNode.id,
            )
          // ref is camelCase but code outputs snake_case equivalent
          } else if (ref !== snakeRef && outputFields.has(snakeRef) && !outputFields.has(ref)) {
            warned.add(ref)
            this.warn(
              issues, 36,
              `Node "${downstreamNode.name}" references $json.${ref} but Code node "${node.name}" outputs "${snakeRef}" — update expression to $json.${snakeRef}`,
              downstreamNode.id,
            )
          }
        }
      }
    }
  }

  // Rule 37 (WARN): new Date() called on external data without a custom date parsing helper
  private checkRule37(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const jsCode = typeof params?.['jsCode'] === 'string' ? params['jsCode'] : ''
      if (!jsCode) continue

      // Detect new Date() called on a field from external data (row., item.json., $json.)
      const externalDateRe = /new\s+Date\s*\(\s*(?:row\.|item\.json\.|(?:\w+\.)+json\.)[^)]*\)/
      if (!externalDateRe.test(jsCode)) continue

      // Check for a custom date parsing helper (manually constructs date from parts)
      const hasParseHelper =
        /function\s+\w*[Pp]arse\w*[Dd]ate/.test(jsCode) ||
        /split\s*\(\s*['"\-/]['"\-/]?\s*\)/.test(jsCode) ||
        /new\s+Date\s*\(\s*parseInt/.test(jsCode) ||
        /new\s+Date\s*\(\s*\d+\s*,/.test(jsCode)

      if (!hasParseHelper) {
        this.warn(
          issues, 37,
          `Node "${node.name}" calls new Date() on external data — non-ISO strings (e.g. MM-DD-YY) return Invalid Date at runtime. Add a parseDate() helper that constructs the date from split parts.`,
          node.id,
        )
      }
    }
  }

  // Rule 38 (WARN): multiple parallel AI HTTP calls merge into same downstream node
  private checkRule38(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return

    const AI_API_PATTERNS = [
      /api\.anthropic\.com/,
      /api\.openai\.com/,
      /generativelanguage\.googleapis\.com/,
      /api\.cohere\.(?:ai|com)/,
      /api\.mistral\.ai/,
    ]

    const aiHttpNodes = new Set(
      w.nodes
        .filter(n => {
          if (n.type !== 'n8n-nodes-base.httpRequest') return false
          const url = (n.parameters as Record<string, unknown> | undefined)?.['url']
          return typeof url === 'string' && AI_API_PATTERNS.some(re => re.test(url))
        })
        .map(n => n.name),
    )

    if (aiHttpNodes.size < 2) return

    const connections = w.connections as Record<string, Record<string, unknown[][]>>
    const targetSources = new Map<string, string[]>()

    for (const sourceName of aiHttpNodes) {
      const outputs = connections[sourceName]
      if (!outputs) continue
      for (const portGroup of Object.values(outputs)) {
        if (!Array.isArray(portGroup)) continue
        for (const targets of portGroup) {
          if (!Array.isArray(targets)) continue
          for (const target of targets) {
            const t = target as { node?: string }
            if (typeof t?.node === 'string') {
              const existing = targetSources.get(t.node) ?? []
              existing.push(sourceName)
              targetSources.set(t.node, existing)
            }
          }
        }
      }
    }

    for (const [targetName, sources] of targetSources) {
      if (sources.length >= 2) {
        this.warn(
          issues, 38,
          `Node "${targetName}" merges output from ${sources.length} parallel AI HTTP Request nodes — n8n cannot reliably reference unexecuted parallel branches. Chain the AI calls sequentially instead.`,
        )
      }
    }
  }

  // Rule 39 (WARN): deprecated Claude model name in use
  private checkRule39(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    const DEPRECATED_MODELS = [
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
      'claude-3-5-haiku-20241022',
      'claude-3-sonnet-20240229',
      'claude-instant-1',
      'claude-2.0',
      'claude-2.1',
    ]

    for (const node of w.nodes) {
      const nodeText = JSON.stringify(node.parameters ?? {})
      for (const model of DEPRECATED_MODELS) {
        if (nodeText.includes(model)) {
          this.warn(
            issues, 39,
            `Node "${node.name}" uses deprecated Claude model "${model}" — update to a current model such as claude-sonnet-4-6`,
            node.id,
          )
          break
        }
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private extractCodeOutputFields(jsCode: string): Set<string> {
    const fields = new Set<string>()
    const SKIP = new Set(['true', 'false', 'null', 'undefined', 'new', 'const', 'let', 'var', 'function', 'return', 'json', 'if', 'else', 'for', 'while', 'of', 'in'])
    const jsonKeyRe = /\bjson\s*:\s*\{/g
    let m: RegExpExecArray | null
    while ((m = jsonKeyRe.exec(jsCode)) !== null) {
      let depth = 1
      let i = m.index + m[0].length
      let block = ''
      while (i < jsCode.length && depth > 0) {
        const ch = jsCode[i]!
        if (ch === '{') depth++
        else if (ch === '}') { if (--depth === 0) break }
        block += ch
        i++
      }
      // Extract explicit keys (before ":")
      const keyRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g
      let km: RegExpExecArray | null
      while ((km = keyRe.exec(block)) !== null) {
        if (!SKIP.has(km[1]!)) fields.add(km[1]!)
      }
      // Extract shorthand keys (before "," or end, not followed by ":")
      const shorthandRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=,|\s*$)/g
      let sh: RegExpExecArray | null
      while ((sh = shorthandRe.exec(block)) !== null) {
        if (!SKIP.has(sh[1]!)) fields.add(sh[1]!)
      }
    }
    return fields
  }

  private getDownstreamNodes(nodeName: string, w: N8nWorkflow): Set<string> {
    const downstream = new Set<string>()
    const connections = w.connections as Record<string, Record<string, unknown[][]>>
    const visit = (name: string): void => {
      const outputs = connections[name]
      if (!outputs) return
      for (const portGroup of Object.values(outputs)) {
        if (!Array.isArray(portGroup)) continue
        for (const targets of portGroup) {
          if (!Array.isArray(targets)) continue
          for (const target of targets) {
            const t = target as { node?: string }
            if (typeof t?.node === 'string' && !downstream.has(t.node)) {
              downstream.add(t.node)
              visit(t.node)
            }
          }
        }
      }
    }
    visit(nodeName)
    return downstream
  }

  private extractJsonFieldRefs(params: Record<string, unknown>): Set<string> {
    const refs = new Set<string>()
    const walk = (val: unknown): void => {
      if (typeof val === 'string') {
        const re = /\$json\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(val)) !== null) refs.add(m[1]!)
      } else if (Array.isArray(val)) {
        for (const item of val) walk(item)
      } else if (val !== null && typeof val === 'object') {
        for (const v of Object.values(val as Record<string, unknown>)) walk(v)
      }
    }
    walk(params)
    return refs
  }

  private camelToSnake(str: string): string {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase()
  }

  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  }

  // Rule 40 (WARN): __rl resource locator field has wrong shape (plain string instead of {__rl, mode, value})
  private checkRule40(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    const RL_FIELDS: Record<string, string[]> = {
      'n8n-nodes-base.googleSheets': ['documentId', 'sheetName'],
      'n8n-nodes-base.googleDrive': ['fileId', 'folderId'],
      'n8n-nodes-base.googleCalendar': ['calendarId'],
    }

    for (const node of w.nodes) {
      const fields = RL_FIELDS[node.type]
      if (!fields) {
        // Slack typeVersion 2+ uses __rl for channelId
        if (node.type === 'n8n-nodes-base.slack' && node.typeVersion >= 2) {
          const params = node.parameters as Record<string, unknown> | undefined
          this.checkRlField(node, 'channelId', params?.['channelId'], issues)
        }
        continue
      }
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      for (const field of fields) {
        this.checkRlField(node, field, params[field], issues)
      }
    }
  }

  private checkRlField(node: N8nNode, field: string, value: unknown, issues: ValidationIssue[]): void {
    if (value === undefined || value === null) return
    if (typeof value === 'string') {
      this.warn(
        issues, 40,
        `Node "${node.name}" parameter "${field}" is a plain string — it must use resource locator format: { "__rl": true, "mode": "id", "value": "..." }`,
        node.id,
      )
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const rl = value as Record<string, unknown>
      if (!rl['__rl']) {
        this.warn(
          issues, 40,
          `Node "${node.name}" parameter "${field}" is missing "__rl": true — use { "__rl": true, "mode": "id", "value": "..." }`,
          node.id,
        )
      } else if (typeof rl['value'] !== 'string' || rl['value'].trim() === '') {
        this.warn(
          issues, 40,
          `Node "${node.name}" parameter "${field}" has an empty __rl value — provide an actual ID, name, or URL`,
          node.id,
        )
      }
    }
  }

  // Rule 41 (WARN): HTTP Request has body content but sendBody is not true
  private checkRule41(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['sendBody'] === true) continue

      const bodyParams = params['bodyParameters'] as Record<string, unknown> | undefined
      const paramsList = bodyParams?.['parameters'] as unknown[] | undefined
      const hasBodyParams = Array.isArray(paramsList) && paramsList.length > 0

      const hasRawBody = typeof params['body'] === 'string' && (params['body'] as string).trim().length > 0
      const hasJsonBody = typeof params['jsonBody'] === 'string' && (params['jsonBody'] as string).trim().length > 0

      if (hasBodyParams || hasRawBody || hasJsonBody) {
        this.warn(
          issues, 41,
          `Node "${node.name}" has body content defined but sendBody is not set to true — the request body will be silently ignored`,
          node.id,
        )
      }
    }
  }

  // Rule 42 (WARN): SplitInBatches output 0 ("done") loops back into the batch node — outputs likely reversed
  private checkRule42(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return
    const connections = w.connections as Record<string, Record<string, unknown[][]>>

    for (const node of w.nodes) {
      if (!node.type.includes('splitInBatches')) continue
      const nodeConns = connections[node.name]
      if (!nodeConns) continue
      const mainOutputs = nodeConns['main']
      if (!Array.isArray(mainOutputs) || mainOutputs.length === 0) continue

      const doneTargets = mainOutputs[0]
      if (!Array.isArray(doneTargets) || doneTargets.length === 0) continue

      const visited = new Set<string>()
      const stack: string[] = doneTargets
        .map((t) => (t as { node?: string }).node)
        .filter(Boolean) as string[]

      let loopsBack = false
      while (stack.length > 0) {
        const current = stack.pop()!
        if (current === node.name) { loopsBack = true; break }
        if (visited.has(current)) continue
        visited.add(current)
        const curr = connections[current]
        if (!curr) continue
        const currMain = curr['main']
        if (!Array.isArray(currMain)) continue
        for (const port of currMain) {
          if (!Array.isArray(port)) continue
          for (const target of port) {
            const t = target as { node?: string }
            if (typeof t?.node === 'string') stack.push(t.node)
          }
        }
      }

      if (loopsBack) {
        this.warn(
          issues, 42,
          `Node "${node.name}" output 0 ("done") leads back into the batch loop — outputs may be reversed. ` +
          `Output 0 → post-batch processing; output 1 → per-item loop body.`,
          node.id,
        )
      }
    }
  }

  // Rule 43 (WARN): IF/Filter node condition uses string operator instead of {type, operation} object (typeVersion 2+)
  private checkRule43(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const CONDITION_NODES = new Set(['n8n-nodes-base.if', 'n8n-nodes-base.filter'])
    for (const node of w.nodes) {
      if (!CONDITION_NODES.has(node.type)) continue
      if (node.typeVersion < 2) continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const conditionsObj = params['conditions'] as Record<string, unknown> | undefined
      const conditions = conditionsObj?.['conditions'] as unknown[] | undefined
      if (!Array.isArray(conditions)) continue
      for (const cond of conditions) {
        if (typeof cond !== 'object' || cond === null) continue
        const c = cond as Record<string, unknown>
        if (typeof c['operator'] === 'string') {
          this.warn(
            issues, 43,
            `Node "${node.name}" has a condition with operator "${String(c['operator'])}" as a plain string — ` +
            `typeVersion 2+ requires an operator object: { "type": "string", "operation": "equals" }`,
            node.id,
          )
          break
        }
      }
    }
  }

  // Rule 44 (WARN): Google Sheets append/update with columnMappingMode "defineBelow" but empty fieldsUi
  private checkRule44(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const WRITE_OPS = new Set(['append', 'appendOrUpdate', 'update', 'upsert'])
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.googleSheets') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const operation = params['operation'] as string | undefined
      if (!operation || !WRITE_OPS.has(operation)) continue
      if (params['columnMappingMode'] !== 'defineBelow') continue
      const fieldsUi = params['fieldsUi'] as Record<string, unknown> | undefined
      const values = fieldsUi?.['values'] as unknown[] | undefined
      if (!Array.isArray(values) || values.length === 0) {
        this.warn(
          issues, 44,
          `Node "${node.name}" Google Sheets "${operation}" uses columnMappingMode "defineBelow" but has no field mappings — no data will be written. Add column mappings or switch to "autoMapInputData".`,
          node.id,
        )
      }
    }
  }

  // Rule 45 (ERROR): AI Agent / chain node has no ai_languageModel sub-node connected
  private checkRule45(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return

    const AGENT_TYPES = new Set([
      '@n8n/n8n-nodes-langchain.agent',
      '@n8n/n8n-nodes-langchain.chainLlm',
      '@n8n/n8n-nodes-langchain.chainRetrievalQa',
      '@n8n/n8n-nodes-langchain.chainSummarization',
    ])

    // Collect all nodes that appear as targets of ai_languageModel connections
    const lmTargets = new Set<string>()
    for (const outputs of Object.values(w.connections as Record<string, Record<string, unknown>>)) {
      if (typeof outputs !== 'object' || outputs === null) continue
      const lmPort = (outputs as Record<string, unknown[][]>)['ai_languageModel']
      if (!Array.isArray(lmPort)) continue
      for (const targets of lmPort) {
        if (!Array.isArray(targets)) continue
        for (const t of targets) {
          const target = t as { node?: string }
          if (typeof target?.node === 'string') lmTargets.add(target.node)
        }
      }
    }

    for (const node of w.nodes) {
      if (!AGENT_TYPES.has(node.type)) continue
      if (!lmTargets.has(node.name)) {
        this.err(
          issues, 45,
          `Node "${node.name}" (${node.type}) has no ai_languageModel sub-node connected — it will throw "No language model connected" at runtime`,
          node.id,
        )
      }
    }
  }

  // Rule 46 (WARN): HTTP Request has hardcoded API key / token in header values
  private checkRule46(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const SECRET_RE = /^(Bearer|Token|Basic)\s+[A-Za-z0-9+/=_\-]{20,}$/i
    const RAW_KEY_RE = /^[A-Za-z0-9_\-]{32,}$/
    const EXPR_RE = /^\s*=\{|^\{\{/

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params || params['sendHeaders'] !== true) continue

      const headerParams = params['headerParameters'] as Record<string, unknown> | undefined
      const headers = headerParams?.['parameters'] as unknown[] | undefined
      if (!Array.isArray(headers)) continue

      for (const header of headers) {
        if (typeof header !== 'object' || header === null) continue
        const h = header as Record<string, unknown>
        const name = typeof h['name'] === 'string' ? h['name'].toLowerCase() : ''
        const value = typeof h['value'] === 'string' ? h['value'] : ''
        if (!value || EXPR_RE.test(value)) continue
        const isAuthHeader = name.includes('authorization') || name.includes('x-api-key') || name.includes('api-key')
        if (isAuthHeader && (SECRET_RE.test(value) || RAW_KEY_RE.test(value))) {
          this.warn(
            issues, 46,
            `Node "${node.name}" has a hardcoded credential value in header "${h['name'] as string}" — use an n8n credential instead of putting secrets in header parameters`,
            node.id,
          )
          break
        }
      }
    }
  }

  // Rule 47 (WARN): Switch node has output route(s) with no downstream connections
  private checkRule47(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return
    const connections = w.connections as Record<string, Record<string, unknown[][]>>

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.switch') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue

      // Count declared routes (typeVersion 3.x: rules.values; older: rules)
      const rulesObj = params['rules'] as Record<string, unknown> | undefined
      const rulesArr = Array.isArray(rulesObj?.['values']) ? rulesObj!['values'] as unknown[]
        : Array.isArray(params['rules']) ? params['rules'] as unknown[]
        : []

      if (rulesArr.length === 0) continue

      const nodeConns = connections[node.name]
      const mainOutputs = nodeConns?.['main']

      for (let i = 0; i < rulesArr.length; i++) {
        const port = Array.isArray(mainOutputs) ? mainOutputs[i] : undefined
        if (!port || (Array.isArray(port) && port.length === 0)) {
          this.warn(
            issues, 47,
            `Node "${node.name}" Switch output route ${i} has no downstream connection — items matching this route will be silently dropped`,
            node.id,
          )
        }
      }
    }
  }

  // Rule 48 (WARN): deprecated OpenAI model name in use
  private checkRule48(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    const DEPRECATED_MODELS = [
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k',
      'gpt-4-0314',
      'gpt-4-32k',
      'gpt-4-0613',
      'gpt-4-32k-0613',
      'text-davinci-003',
      'text-davinci-002',
      'davinci',
    ]

    for (const node of w.nodes) {
      const nodeText = JSON.stringify(node.parameters ?? {})
      for (const model of DEPRECATED_MODELS) {
        if (nodeText.includes(model)) {
          this.warn(
            issues, 48,
            `Node "${node.name}" uses deprecated OpenAI model "${model}" — update to a current model such as gpt-4o or gpt-4o-mini`,
            node.id,
          )
          break
        }
      }
    }
  }

  // Rule 49 (WARN): executeWorkflow node has no workflowId set
  private checkRule49(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.executeWorkflow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) { this.warn(issues, 49, `Node "${node.name}" executeWorkflow has no workflowId set — it will not execute any sub-workflow`, node.id); continue }

      const workflowId = params['workflowId']
      const source = params['source']
      const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

      if (isEmpty(workflowId) && isEmpty(source)) {
        this.warn(
          issues, 49,
          `Node "${node.name}" executeWorkflow has no workflowId set — it will not execute any sub-workflow`,
          node.id,
        )
      }
    }
  }

  // Rule 50 (WARN): AI Agent promptType "auto" with no chatTrigger or formTrigger upstream
  private checkRule50(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return

    const AGENT_TYPES = new Set([
      '@n8n/n8n-nodes-langchain.agent',
      '@n8n/n8n-nodes-langchain.chainLlm',
    ])
    const CHAT_TRIGGERS = new Set([
      '@n8n/n8n-nodes-langchain.chatTrigger',
      'n8n-nodes-base.formTrigger',
    ])

    const triggerTypes = new Set(w.nodes.filter(n => this.isTriggerNode(n)).map(n => n.type))
    const hasChaTrigger = [...triggerTypes].some(t => CHAT_TRIGGERS.has(t))

    for (const node of w.nodes) {
      if (!AGENT_TYPES.has(node.type)) continue
      const params = node.parameters as Record<string, unknown> | undefined
      const promptType = params?.['promptType'] as string | undefined
      if (promptType === 'define' || promptType === 'text') continue
      if (!hasChaTrigger) {
        this.warn(
          issues, 50,
          `Node "${node.name}" uses promptType "auto" but no chatTrigger or formTrigger is present — the agent will throw "No prompt specified" at runtime. Either add a chatTrigger or set promptType to "define" with an explicit text parameter.`,
          node.id,
        )
      }
    }
  }

  // Rule 51 (WARN): Wait node in webhook-resume mode with no resumeUrl sent downstream
  private checkRule51(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.wait') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const resume = params?.['resume'] as string | undefined
      if (resume !== 'webhook' && resume !== undefined) continue

      // The default Wait resume mode IS webhook — so also flag when resume is absent
      const isWebhookMode = resume === 'webhook' || resume === undefined

      if (!isWebhookMode) continue

      // Search all downstream nodes for resumeUrl references
      const downstream = this.getDownstreamNodes(node.name, w)
      let hasResumeUrl = false

      for (const dsName of downstream) {
        const dsNode = Array.isArray(w.nodes) ? w.nodes.find(n => n.name === dsName) : undefined
        if (!dsNode) continue
        const dsText = JSON.stringify(dsNode.parameters ?? '')
        if (dsText.includes('resumeUrl') || dsText.includes('resumeWebhookUrl') || dsText.includes('$execution.resumeUrl')) {
          hasResumeUrl = true
          break
        }
      }

      // Also check all nodes (not just downstream) since the resumeUrl node might branch earlier
      if (!hasResumeUrl) {
        const allText = JSON.stringify(w)
        if (allText.includes('resumeUrl') || allText.includes('resumeWebhookUrl')) {
          hasResumeUrl = true
        }
      }

      if (!hasResumeUrl) {
        this.warn(
          issues, 51,
          `Node "${node.name}" Wait node uses webhook-resume mode but nothing in the workflow sends $execution.resumeUrl to an external system — the execution will pause indefinitely and never resume`,
          node.id,
        )
      }
    }
  }

  // Rule 52 (WARN): SQL injection risk — SQL query built with template literal + $json field in Code node
  private checkRule52(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const SQL_KEYWORDS = /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM|INTO)\b/i
    const UNSAFE_INTERP = /`[^`]*\$\{[^}]*(?:\$json|item\.json|items\[)[^`]*`|['"][^'"]*\+\s*(?:\$json|item\.json|items\[)/

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const jsCode = typeof params?.['jsCode'] === 'string' ? params['jsCode'] : ''
      if (!jsCode) continue
      if (SQL_KEYWORDS.test(jsCode) && UNSAFE_INTERP.test(jsCode)) {
        this.warn(
          issues, 52,
          `Node "${node.name}" builds a SQL query by interpolating $json fields into a string — this is a SQL injection risk. Use parameterized queries with $1/$2 placeholders and a separate values array instead.`,
          node.id,
        )
      }
    }
  }

  // Rule 53 (WARN): Merge node mode incompatible with its incoming connection count
  private checkRule53(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return

    // Build reverse connection map: node name → list of source names
    const incomingCount = new Map<string, number>()
    for (const node of w.nodes) incomingCount.set(node.name, 0)

    const connections = w.connections as Record<string, Record<string, unknown[][]>>
    for (const outputs of Object.values(connections)) {
      if (typeof outputs !== 'object' || outputs === null) continue
      const mainOutputs = (outputs as Record<string, unknown[][]>)['main']
      if (!Array.isArray(mainOutputs)) continue
      for (const port of mainOutputs) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const target = (t as { node?: string }).node
          if (typeof target === 'string') {
            incomingCount.set(target, (incomingCount.get(target) ?? 0) + 1)
          }
        }
      }
    }

    const NEEDS_TWO = new Set(['chooseBranch', 'combine', 'combineBySql', 'combineByPosition'])

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.merge') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const mode = (params?.['mode'] as string | undefined) ?? 'append'
      const count = incomingCount.get(node.name) ?? 0
      if (NEEDS_TWO.has(mode) && count < 2) {
        this.warn(
          issues, 53,
          `Node "${node.name}" Merge mode "${mode}" requires 2 inputs but only has ${count} incoming connection(s) — it will hang waiting for a second input that never arrives`,
          node.id,
        )
      }
    }
  }

  // Rule 54 (WARN): HTTP Request to known protected API domain without credentials or auth headers
  private checkRule54(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    const PROTECTED_APIS: Array<[RegExp, string]> = [
      [/api\.stripe\.com/i, 'Stripe'],
      [/api\.twilio\.com/i, 'Twilio'],
      [/api\.sendgrid\.com/i, 'SendGrid'],
      [/api\.github\.com/i, 'GitHub'],
      [/api\.hubapi\.com/i, 'HubSpot'],
      [/api\.airtable\.com/i, 'Airtable'],
      [/api\.notion\.so/i, 'Notion'],
      [/hooks\.slack\.com/i, 'Slack'],
      [/api\.mailchimp\.com/i, 'Mailchimp'],
      [/api\.resend\.com/i, 'Resend'],
    ]

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const url = typeof params['url'] === 'string' ? params['url'] : ''
      if (!url) continue

      const match = PROTECTED_APIS.find(([re]) => re.test(url))
      if (!match) continue

      const hasCredentials = node.credentials && Object.keys(node.credentials).length > 0
      const hasAuthHeader = params['sendHeaders'] === true && (() => {
        const hp = params['headerParameters'] as Record<string, unknown> | undefined
        const list = hp?.['parameters'] as unknown[] | undefined
        return Array.isArray(list) && list.some((h) => {
          const hdr = h as Record<string, unknown>
          const name = typeof hdr['name'] === 'string' ? hdr['name'].toLowerCase() : ''
          return name.includes('authorization') || name.includes('x-api-key') || name.includes('api-key')
        })
      })()
      const hasGenericAuth = params['authentication'] && params['authentication'] !== 'none'

      if (!hasCredentials && !hasAuthHeader && !hasGenericAuth) {
        this.warn(
          issues, 54,
          `Node "${node.name}" calls the ${match[1]} API (${url}) without any credentials or auth headers — the request will fail with 401/403`,
          node.id,
        )
      }
    }
  }

  // Rule 55 (WARN): Google Sheets sheetName is a placeholder literal when documentId is a real ID
  private checkRule55(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const PLACEHOLDER_SHEETS = new Set(['Sheet1', 'sheet1', 'Sheet 1', 'Лист1', 'Feuille1', 'Tabelle1'])

    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.googleSheets') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue

      const docId = params['documentId']
      const sheetName = params['sheetName']

      // Only warn if documentId is a real-looking value (not expression, not empty)
      const docValue = typeof docId === 'object' && docId !== null
        ? ((docId as Record<string, unknown>)['value'] as string | undefined) ?? ''
        : typeof docId === 'string' ? docId : ''
      if (!docValue || docValue.trim() === '' || docValue.startsWith('={{')) continue

      // Check if sheetName is a placeholder
      const sheetValue = typeof sheetName === 'object' && sheetName !== null
        ? ((sheetName as Record<string, unknown>)['value'] as string | undefined) ?? ''
        : typeof sheetName === 'string' ? sheetName : ''

      if (PLACEHOLDER_SHEETS.has(sheetValue.trim())) {
        this.warn(
          issues, 55,
          `Node "${node.name}" Google Sheets sheetName is "${sheetValue}" — this is the default placeholder. Set it to the actual tab name in your spreadsheet.`,
          node.id,
        )
      }
    }
  }

  // Rule 56 (WARN): node has continueOnFail but no immediate downstream error check on $json.error
  private checkRule56(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return
    const connections = w.connections as Record<string, Record<string, unknown[][]>>

    for (const node of w.nodes) {
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const onError = params['onError'] as string | undefined
      if (onError !== 'continueRegularOutput' && onError !== 'continueErrorOutput') continue

      // Get immediate downstream nodes (one hop only)
      const nodeConns = connections[node.name]
      if (!nodeConns) continue
      const mainOutputs = nodeConns['main']
      if (!Array.isArray(mainOutputs)) continue

      const immediateDownstream: string[] = []
      for (const port of mainOutputs) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const name = (t as { node?: string }).node
          if (typeof name === 'string') immediateDownstream.push(name)
        }
      }

      let hasErrorCheck = false
      for (const dsName of immediateDownstream) {
        const dsNode = w.nodes.find(n => n.name === dsName)
        if (!dsNode) continue
        const dsText = JSON.stringify(dsNode.parameters ?? '')
        if (dsText.includes('$json.error') || dsText.includes('$json.statusCode') || dsText.includes('.error') || dsText.includes('statusCode')) {
          hasErrorCheck = true
          break
        }
      }

      if (!hasErrorCheck && immediateDownstream.length > 0) {
        this.warn(
          issues, 56,
          `Node "${node.name}" has continueOnFail enabled but no downstream node checks $json.error — errors will be silently swallowed and the workflow will appear to succeed even when this node fails`,
          node.id,
        )
      }
    }
  }

  // Rule 57 (WARN): HTTP Request binary upload with missing or empty binaryPropertyName
  private checkRule57(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['sendBody'] !== true) continue
      const contentType = params['contentType'] ?? params['bodyContentType']
      if (contentType !== 'binaryData') continue
      const propName = params['binaryPropertyName'] ?? params['binaryProperty']
      if (!propName || (typeof propName === 'string' && propName.trim() === '')) {
        this.warn(
          issues, 57,
          `Node "${node.name}" sends binary data but binaryPropertyName is empty — n8n cannot locate the binary data to upload. Set it to the property name from the upstream node (commonly "data" or "attachment").`,
          node.id,
        )
      }
    }
  }

  // Rule 58 (WARN): wrong credential type key for the node type
  private checkRule58(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return

    // Expected credential type key per node type (primary key only; some nodes accept multiple)
    const EXPECTED_CRED: Record<string, string> = {
      'n8n-nodes-base.gmail': 'gmailOAuth2',
      'n8n-nodes-base.gmailTrigger': 'gmailOAuth2',
      'n8n-nodes-base.googleSheets': 'googleSheetsOAuth2Api',
      'n8n-nodes-base.googleDrive': 'googleDriveOAuth2Api',
      'n8n-nodes-base.googleCalendar': 'googleCalendarOAuth2Api',
      'n8n-nodes-base.slack': 'slackOAuth2Api',
      'n8n-nodes-base.slackTrigger': 'slackApi',
      'n8n-nodes-base.notion': 'notionApi',
      'n8n-nodes-base.notionTrigger': 'notionApi',
      'n8n-nodes-base.airtable': 'airtableTokenApi',
      'n8n-nodes-base.airtableTrigger': 'airtableTokenApi',
      'n8n-nodes-base.github': 'githubApi',
      'n8n-nodes-base.githubTrigger': 'githubApi',
      'n8n-nodes-base.postgres': 'postgres',
      'n8n-nodes-base.mySql': 'mySql',
      'n8n-nodes-base.telegram': 'telegramApi',
      'n8n-nodes-base.telegramTrigger': 'telegramApi',
      'n8n-nodes-base.emailSend': 'smtp',
      'n8n-nodes-base.emailReadImap': 'imap',
      'n8n-nodes-base.hubspot': 'hubspotOAuth2Api',
      'n8n-nodes-base.jira': 'jiraSoftwareCloudApi',
      '@n8n/n8n-nodes-langchain.lmChatAnthropic': 'anthropicApi',
      '@n8n/n8n-nodes-langchain.lmChatOpenAi': 'openAiApi',
      '@n8n/n8n-nodes-langchain.anthropic': 'anthropicApi',
      '@n8n/n8n-nodes-langchain.openAi': 'openAiApi',
    }

    for (const node of w.nodes) {
      const expected = EXPECTED_CRED[node.type]
      if (!expected) continue
      if (!node.credentials) continue
      const credKeys = Object.keys(node.credentials)
      if (credKeys.length === 0) continue
      if (!credKeys.includes(expected)) {
        this.warn(
          issues, 58,
          `Node "${node.name}" uses credential key "${credKeys[0]}" but ${node.type} expects "${expected}" — n8n will fail to find the credential at runtime`,
          node.id,
        )
      }
    }
  }

  // Rule 59 (WARN): webhook node has no authentication configured
  private checkRule59(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.webhook') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const auth = params?.['authentication']
      if (!auth || auth === 'none') {
        this.warn(
          issues, 59,
          `Node "${node.name}" webhook has no authentication — anyone who knows the URL can trigger this workflow. Set authentication to "Header Auth" or "Basic Auth".`,
          node.id,
        )
      }
    }
  }

  // Rule 60 (WARN): scheduleTrigger fires every minute (cron minute=* or minutesInterval=1)
  private checkRule60(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.scheduleTrigger') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const intervals = (params?.['rule'] as Record<string, unknown> | undefined)?.['interval']
      if (!Array.isArray(intervals)) continue
      for (const interval of intervals) {
        const iv = interval as Record<string, unknown>
        if (iv['field'] === 'cronExpression') {
          const expr = iv['expression'] as string | undefined
          if (!expr) continue
          const parts = expr.trim().split(/\s+/)
          if (parts[0] === '*') {
            this.warn(
              issues, 60,
              `Node "${node.name}" cronExpression "${expr}" has minute field "*" — this fires every minute and will flood your execution history.`,
              node.id,
            )
          }
        } else if (iv['field'] === 'minutes') {
          const mins = iv['minutesInterval'] as number | undefined
          if (mins === 1) {
            this.warn(
              issues, 60,
              `Node "${node.name}" schedule interval is every 1 minute — this fires every minute and will flood your execution history.`,
              node.id,
            )
          }
        }
      }
    }
  }

  // Rule 61 (WARN): toolWorkflow sub-node missing description
  private checkRule61(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.toolWorkflow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const desc = params?.['description']
      if (!desc || (typeof desc === 'string' && desc.trim() === '')) {
        this.warn(
          issues, 61,
          `Node "${node.name}" is a toolWorkflow sub-node with no description — the AI agent cannot determine when to call this tool. Add a clear description of what the tool does and when to use it.`,
          node.id,
        )
      }
    }
  }

  // Rule 62 (WARN): memoryBufferWindow without chatTrigger and no sessionKey (shared memory)
  private checkRule62(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const hasChatTrigger = w.nodes.some(n => n.type === '@n8n/n8n-nodes-langchain.chatTrigger')
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.memoryBufferWindow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const sessionKey = params?.['sessionKey'] ?? params?.['sessionId']
      if (!hasChatTrigger && (!sessionKey || (typeof sessionKey === 'string' && sessionKey.trim() === ''))) {
        this.warn(
          issues, 62,
          `Node "${node.name}" uses memoryBufferWindow without a chatTrigger or sessionKey — all executions will share the same memory buffer, mixing context across different users or runs.`,
          node.id,
        )
      }
    }
  }

  // Rule 63 (ERROR): duplicate webhook path+httpMethod in the same workflow
  private checkRule63(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const seen = new Map<string, string>()
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.webhook') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const path = (params?.['path'] as string) ?? ''
      const method = ((params?.['httpMethod'] as string) ?? 'GET').toUpperCase()
      const key = `${method}:${path}`
      if (seen.has(key)) {
        this.err(
          issues, 63,
          `Duplicate webhook path+method "${method} /${path}" in nodes "${seen.get(key)}" and "${node.name}" — n8n will route all requests to one and the other will never fire.`,
          node.id,
        )
      } else {
        seen.set(key, node.name)
      }
    }
  }

  // Rule 65 (ERROR): SplitInBatches batchSize <= 0
  private checkRule65(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.splitInBatches') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const batchSize = params?.['batchSize']
      if (typeof batchSize === 'number' && batchSize <= 0) {
        this.err(
          issues, 65,
          `Node "${node.name}" has batchSize set to ${batchSize} — batchSize must be greater than 0 or n8n will throw an error at runtime.`,
          node.id,
        )
      }
    }
  }

  // Rule 66 (ERROR): HTTP Request URL missing protocol prefix (not http:// or https://)
  private checkRule66(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const url = params?.['url']
      if (typeof url !== 'string') continue
      // n8n prefixes dynamic-value fields with "=" (e.g. "=https://{{ expr }}.com/path");
      // strip that marker before checking the protocol so mixed literal+expression URLs
      // aren't false-flagged as missing a protocol.
      const effective = url.startsWith('=') ? url.slice(1) : url
      if (effective.startsWith('{{') || effective.trim() === '') continue
      if (!/^https?:\/\//i.test(effective)) {
        this.err(
          issues, 66,
          `Node "${node.name}" HTTP Request URL "${url}" is missing a protocol prefix — n8n requires a full URL starting with https:// or http://.`,
          node.id,
        )
      }
    }
  }

  // Rule 67 (WARN): Code node $('NodeName') references a node not in the workflow
  private checkRule67(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const nodeNames = new Set(w.nodes.map(n => n.name))
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const code = (params?.['jsCode'] ?? params?.['code'] ?? '') as string
      if (!code) continue
      const refs = [...code.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m => m[1]).filter((r): r is string => r !== undefined)
      for (const ref of refs) {
        if (!nodeNames.has(ref)) {
          this.warn(
            issues, 67,
            `Node "${node.name}" references $('${ref}') but no node named "${ref}" exists in this workflow — this expression will throw at runtime.`,
            node.id,
          )
        }
      }
    }
  }

  // Rule 68 (WARN): Google Calendar create event missing timezone
  private checkRule68(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.googleCalendar') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['resource'] !== 'event' || params['operation'] !== 'create') continue
      const additional = params['additionalFields'] as Record<string, unknown> | undefined
      const tz = params['timezone'] ?? additional?.['timezone']
      if (!tz || (typeof tz === 'string' && tz.trim() === '')) {
        this.warn(
          issues, 68,
          `Node "${node.name}" creates a Google Calendar event without specifying a timezone — the event will default to UTC, which may place it at the wrong local time for attendees.`,
          node.id,
        )
      }
    }
  }

  // Rule 69 (WARN): Gmail send node missing subject
  private checkRule69(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.gmail') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['resource'] !== 'message' || params['operation'] !== 'send') continue
      const msg = params['message'] as Record<string, unknown> | undefined
      const subject = params['subject'] ?? msg?.['subject']
      if (!subject || (typeof subject === 'string' && subject.trim() === '')) {
        this.warn(
          issues, 69,
          `Node "${node.name}" sends a Gmail message with no subject — emails without a subject are often filtered as spam or ignored by recipients.`,
          node.id,
        )
      }
    }
  }

  // Rule 70 (WARN): Set node v1 with keepOnlySet=true drops all upstream fields
  private checkRule70(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.set') continue
      const version = typeof node.typeVersion === 'number' ? node.typeVersion : 0
      if (version >= 2) continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (params?.['keepOnlySet'] === true) {
        this.warn(
          issues, 70,
          `Node "${node.name}" (Set v1) has keepOnlySet=true — all upstream fields will be dropped and only explicitly set fields will pass downstream. Ensure this is intentional.`,
          node.id,
        )
      }
    }
  }

  // Rule 71 (WARN): toolWorkflow source=database missing workflowId
  private checkRule71(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.toolWorkflow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const source = params?.['source']
      if (source !== undefined && source !== 'database') continue
      const rl = params?.['workflowId'] as Record<string, unknown> | undefined
      const workflowId = typeof params?.['workflowId'] === 'string'
        ? params['workflowId']
        : rl?.['value']
      if (!workflowId || (typeof workflowId === 'string' && workflowId.trim() === '')) {
        this.warn(
          issues, 71,
          `Node "${node.name}" is a toolWorkflow with source=database but no workflowId is set — the agent will fail to find the workflow to call at runtime.`,
          node.id,
        )
      }
    }
  }

  // Rule 72 (WARN): Code node calls JSON.parse() without a try/catch
  private checkRule72(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const code = (params?.['jsCode'] ?? params?.['code'] ?? '') as string
      if (!code.includes('JSON.parse(')) continue
      if (!code.includes('try')) {
        this.warn(
          issues, 72,
          `Node "${node.name}" calls JSON.parse() without a try/catch — if the input is not valid JSON the node will throw and halt the workflow.`,
          node.id,
        )
      }
    }
  }

  // Rule 73 (WARN): AI tool sub-nodes (toolCode, toolHttpRequest, etc.) missing description
  private checkRule73(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const AI_TOOL_TYPES = new Set([
      '@n8n/n8n-nodes-langchain.toolCode',
      '@n8n/n8n-nodes-langchain.toolHttpRequest',
      '@n8n/n8n-nodes-langchain.toolCalculator',
      '@n8n/n8n-nodes-langchain.toolWikipedia',
      '@n8n/n8n-nodes-langchain.toolSerpApi',
    ])
    for (const node of w.nodes) {
      if (!AI_TOOL_TYPES.has(node.type)) continue
      const params = node.parameters as Record<string, unknown> | undefined
      const desc = params?.['description'] ?? params?.['toolDescription']
      if (!desc || (typeof desc === 'string' && desc.trim() === '')) {
        this.warn(
          issues, 73,
          `Node "${node.name}" is an AI tool sub-node with no description — the AI agent uses the description to decide when to invoke this tool. Add a clear description.`,
          node.id,
        )
      }
    }
  }

  // Rule 74 (WARN): multiple memoryBufferWindow nodes share the same static sessionKey
  private checkRule74(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const keyMap = new Map<string, string>()
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.memoryBufferWindow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const sessionKey = params?.['sessionKey'] ?? params?.['sessionId']
      if (typeof sessionKey !== 'string' || sessionKey.startsWith('={{') || sessionKey.trim() === '') continue
      if (keyMap.has(sessionKey)) {
        this.warn(
          issues, 74,
          `Nodes "${keyMap.get(sessionKey)}" and "${node.name}" share the same static sessionKey "${sessionKey}" — they will read/write the same memory buffer, mixing context across agents.`,
          node.id,
        )
      } else {
        keyMap.set(sessionKey, node.name)
      }
    }
  }

  // Rule 75 (WARN): emailSend node missing toAddresses, subject, or message
  private checkRule75(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.emailSend') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const to = params['toAddresses'] ?? params['to'] ?? params['sendTo']
      const subject = params['subject']
      const message = params['message'] ?? params['text'] ?? params['html']
      if (!to || (typeof to === 'string' && to.trim() === '')) {
        this.warn(
          issues, 75,
          `Node "${node.name}" (emailSend) is missing a "to" address — the email cannot be delivered without a recipient.`,
          node.id,
        )
      } else if (!subject || (typeof subject === 'string' && subject.trim() === '')) {
        this.warn(
          issues, 75,
          `Node "${node.name}" (emailSend) is missing a subject — emails without a subject are often filtered as spam.`,
          node.id,
        )
      } else if (!message || (typeof message === 'string' && message.trim() === '')) {
        this.warn(
          issues, 75,
          `Node "${node.name}" (emailSend) has an empty message body — the email will be sent blank.`,
          node.id,
        )
      }
    }
  }

  // Rule 76 (WARN): Telegram sendMessage missing chatId
  private checkRule76(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.telegram') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['resource'] !== 'message' || params['operation'] !== 'sendMessage') continue
      const chatId = params['chatId']
      if (!chatId || (typeof chatId === 'string' && chatId.trim() === '')) {
        this.warn(
          issues, 76,
          `Node "${node.name}" sends a Telegram message but chatId is not set — Telegram cannot route the message without a valid chatId.`,
          node.id,
        )
      }
    }
  }

  // Rule 77 (WARN): Code node in runOnceForAllItems mode uses $json without $input.all()
  private checkRule77(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (params?.['mode'] !== 'runOnceForAllItems') continue
      const code = (params?.['jsCode'] ?? params?.['code'] ?? '') as string
      if (code.includes('$json') && !code.includes('$input.all()')) {
        this.warn(
          issues, 77,
          `Node "${node.name}" runs in "runOnceForAllItems" mode and uses $json — in this mode $json only refers to the first input item. Use $input.all() to iterate over all items.`,
          node.id,
        )
      }
    }
  }

  // Rule 78 (WARN): workflow has no errorWorkflow configured in settings
  private checkRule78(w: N8nWorkflow, issues: ValidationIssue[]): void {
    const settings = w.settings as Record<string, unknown> | undefined
    const errorWorkflow = settings?.['errorWorkflow']
    if (!errorWorkflow || (typeof errorWorkflow === 'string' && errorWorkflow.trim() === '')) {
      this.warn(
        issues, 78,
        `Workflow has no errorWorkflow configured in settings — execution failures will be silent. Set settings.errorWorkflow to an error-handling workflow ID so failures are captured.`,
      )
    }
  }

  // Rule 79 (WARN): HTTP Request URL contains "webhook-test" (test URL that expires)
  private checkRule79(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const url = params?.['url']
      if (typeof url === 'string' && url.includes('webhook-test')) {
        this.warn(
          issues, 79,
          `Node "${node.name}" HTTP Request URL contains "webhook-test" — this is a test webhook URL that expires after testing. Replace with the production webhook URL.`,
          node.id,
        )
      }
    }
  }

  // Rule 80 (WARN): Set node v3+ has assignments but includeOtherInputFields is not enabled
  private checkRule80(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.set') continue
      const version = typeof node.typeVersion === 'number' ? node.typeVersion : 0
      if (version < 3) continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const assignments = (params['assignments'] as Record<string, unknown> | undefined)?.['assignments']
      if (!Array.isArray(assignments) || assignments.length === 0) continue
      if (params['includeOtherInputFields'] !== true) {
        this.warn(
          issues, 80,
          `Node "${node.name}" (Set v3+) sets fields but includeOtherInputFields is not enabled — all upstream fields will be dropped. Enable "Include Other Input Fields" if you need upstream data alongside the new fields.`,
          node.id,
        )
      }
    }
  }

  // Rule 81 (ERROR): executeWorkflow calls the current workflow (infinite loop)
  private checkRule81(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const wf = w as unknown as Record<string, unknown>
    const currentId = typeof wf['id'] === 'string' ? wf['id'] : undefined
    if (!currentId) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.executeWorkflow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const targetId = params?.['workflowId']
      if (typeof targetId === 'string' && targetId === currentId) {
        this.err(
          issues, 81,
          `Node "${node.name}" calls the current workflow (id: ${currentId}) — this creates an infinite self-call loop that will exhaust n8n execution resources.`,
          node.id,
        )
      }
    }
  }

  // Rule 82 (WARN): workflow has multiple SplitInBatches nodes (nested loop risk)
  private checkRule82(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const splitNodes = w.nodes.filter(n => n.type === 'n8n-nodes-base.splitInBatches')
    if (splitNodes.length >= 2) {
      this.warn(
        issues, 82,
        `Workflow has ${splitNodes.length} SplitInBatches nodes — nested batch loops can cause the inner loop's "done" state to persist across outer iterations, producing incorrect results. Ensure inner loops fully reset between outer passes.`,
      )
    }
  }

  // Rule 83 (ERROR): toolWorkflow source=parameter has no inline workflow nodes
  private checkRule83(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.toolWorkflow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (params?.['source'] !== 'parameter') continue
      const subWorkflow = params?.['workflow'] as Record<string, unknown> | undefined
      const subNodes = subWorkflow?.['nodes'] as unknown[] | undefined
      if (!Array.isArray(subNodes) || subNodes.length === 0) {
        this.err(
          issues, 83,
          `Node "${node.name}" is a toolWorkflow with source="parameter" but has no inline workflow nodes defined — the AI tool has no workflow to execute.`,
          node.id,
        )
      }
    }
  }

  // Rule 85 (WARN): HTTP Request has both a credential and a manual Authorization header
  private checkRule85(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      if (!node.credentials || Object.keys(node.credentials).length === 0) continue
      const params = node.parameters as Record<string, unknown> | undefined
      const headers = (params?.['headerParameters'] as Record<string, unknown> | undefined)?.['parameters']
      if (!Array.isArray(headers)) continue
      const hasAuthHeader = headers.some((h: unknown) => {
        const header = h as Record<string, unknown>
        return ((header['name'] as string) ?? '').toLowerCase() === 'authorization'
      })
      if (hasAuthHeader) {
        this.warn(
          issues, 85,
          `Node "${node.name}" has both a credential configured AND a manual Authorization header — they may conflict or cause double authentication. Remove one.`,
          node.id,
        )
      }
    }
  }

  // Rule 86 (ERROR): scheduleTrigger cronExpression has wrong number of fields
  private checkRule86(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.scheduleTrigger') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const intervals = (params?.['rule'] as Record<string, unknown> | undefined)?.['interval']
      if (!Array.isArray(intervals)) continue
      for (const interval of intervals) {
        const iv = interval as Record<string, unknown>
        if (iv['field'] !== 'cronExpression') continue
        const expr = iv['expression'] as string | undefined
        if (!expr || expr.trim() === '') {
          this.err(
            issues, 86,
            `Node "${node.name}" has a cronExpression interval with an empty expression — n8n will fail to parse the schedule.`,
            node.id,
          )
          continue
        }
        const parts = expr.trim().split(/\s+/)
        if (parts.length < 5 || parts.length > 6) {
          this.err(
            issues, 86,
            `Node "${node.name}" cronExpression "${expr}" has ${parts.length} field(s) — standard cron requires 5 fields (minute hour day month weekday) or 6 with an optional seconds prefix.`,
            node.id,
          )
        }
      }
    }
  }

  // Rule 87 (WARN): Merge combineByPosition with an upstream Filter node (item count mismatch)
  private checkRule87(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    const upstream = new Map<string, Set<string>>()
    for (const [sourceName, outputs] of Object.entries(connections)) {
      const mainOutputs = outputs['main']
      if (!Array.isArray(mainOutputs)) continue
      for (const port of mainOutputs) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const target = (t as { node?: string }).node
          if (typeof target === 'string') {
            if (!upstream.has(target)) upstream.set(target, new Set())
            upstream.get(target)!.add(sourceName)
          }
        }
      }
    }
    const filterNames = new Set(w.nodes.filter(n => n.type === 'n8n-nodes-base.filter').map(n => n.name))
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.merge') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const mode = params?.['mode'] ?? params?.['combineBy']
      if (mode !== 'combineByPosition' && mode !== 'position') continue
      const upstreamNodes = upstream.get(node.name) ?? new Set()
      for (const upName of upstreamNodes) {
        if (filterNames.has(upName)) {
          this.warn(
            issues, 87,
            `Node "${node.name}" merges by position but upstream node "${upName}" is a Filter — if Filter removes items, remaining items will be mismatched by position. Use combineByFields or rebalance with a NoOp branch.`,
            node.id,
          )
          break
        }
      }
    }
  }

  // Rule 88 (WARN): Telegram sendMessage missing text
  private checkRule88(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.telegram') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['resource'] !== 'message' || params['operation'] !== 'sendMessage') continue
      const text = params['text'] ?? params['messageText']
      if (!text || (typeof text === 'string' && text.trim() === '')) {
        this.warn(
          issues, 88,
          `Node "${node.name}" sends a Telegram message with no text — the message will be empty and cause a Telegram API error.`,
          node.id,
        )
      }
    }
  }

  // Rule 84 (ERROR): toolWorkflow source=parameter inline workflow missing executeWorkflowTrigger entry point
  private checkRule84(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.toolWorkflow') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (params?.['source'] !== 'parameter') continue
      const subWorkflow = params?.['workflow'] as Record<string, unknown> | undefined
      const subNodes = subWorkflow?.['nodes'] as unknown[] | undefined
      // Rule 83 already fires when subNodes is empty — only check non-empty case here
      if (!Array.isArray(subNodes) || subNodes.length === 0) continue
      const hasEntryTrigger = (subNodes as Array<Record<string, unknown>>).some(
        n => n['type'] === 'n8n-nodes-base.executeWorkflowTrigger',
      )
      if (!hasEntryTrigger) {
        this.err(
          issues, 84,
          `Node "${node.name}" is a toolWorkflow with source="parameter" and has inline nodes, but the inline workflow has no executeWorkflowTrigger — n8n uses this as the entry point when calling inline sub-workflows. Add an executeWorkflowTrigger to the inline workflow.nodes array.`,
          node.id,
        )
      }
    }
  }

  // Rule 89 (ERROR): chainRetrievalQa missing ai_retriever sub-node
  private checkRule89(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    const nodesWithRetriever = new Set<string>()
    for (const outputs of Object.values(connections)) {
      const retrieverPorts = outputs['ai_retriever']
      if (!Array.isArray(retrieverPorts)) continue
      for (const port of retrieverPorts) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const target = (t as { node?: string }).node
          if (typeof target === 'string') nodesWithRetriever.add(target)
        }
      }
    }
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.chainRetrievalQa') continue
      if (!nodesWithRetriever.has(node.name)) {
        this.err(
          issues, 89,
          `Node "${node.name}" (chainRetrievalQa) has no ai_retriever sub-node connected — the Retrieval QA chain requires a retriever (e.g. a vectorStore node) via the ai_retriever connection. Without it the chain throws at runtime.`,
          node.id,
        )
      }
    }
  }

  // Rule 90 (ERROR): respondToWebhook exists but no webhook has responseMode="responseNode"
  private checkRule90(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const respondNode = w.nodes.find(n => n.type === 'n8n-nodes-base.respondToWebhook')
    if (!respondNode) return
    const hasMatchingWebhook = w.nodes.some(n => {
      if (n.type !== 'n8n-nodes-base.webhook') return false
      const params = n.parameters as Record<string, unknown> | undefined
      return params?.['responseMode'] === 'responseNode'
    })
    if (!hasMatchingWebhook) {
      this.err(
        issues, 90,
        `Node "${respondNode.name}" (respondToWebhook) exists but no Webhook trigger has responseMode set to "responseNode" — n8n will throw "No webhook is waiting for a response" at runtime. Set the Webhook trigger's Response Mode to "Using Respond to Webhook Node".`,
        respondNode.id,
      )
    }
  }

  // Rule 91 (WARN): filter node has empty conditions (Rule 31 handles IF node; this handles Filter)
  private checkRule91(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.filter') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const conditions = params?.['conditions'] as Record<string, unknown> | undefined
      const condList = conditions?.['conditions']
      if (!Array.isArray(condList) || condList.length === 0) {
        this.warn(
          issues, 91,
          `Node "${node.name}" (filter) has no conditions defined — with no conditions the filter passes all items through without filtering anything. Add at least one condition.`,
          node.id,
        )
      }
    }
  }

  // Rule 92 (ERROR): expression calls .toISOString() on a Luxon DateTime ($now/$today)
  private checkRule92(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      const paramStr = JSON.stringify(node.parameters ?? '')
      if (!paramStr.includes('.toISOString()')) continue
      if (!paramStr.includes('$now') && !paramStr.includes('$today') && !paramStr.includes('DateTime')) continue
      this.warn(
        issues, 92,
        `Node "${node.name}" expression calls .toISOString() on a Luxon DateTime — in n8n, $now and $today are Luxon objects, not native JS Date objects. Use .toISO() instead: {{ $now.toISO() }}.`,
        node.id,
      )
    }
  }

  // Rule 93 (WARN): expression calls .format() (Moment.js API) instead of .toFormat() (Luxon API)
  private checkRule93(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      const paramStr = JSON.stringify(node.parameters ?? '')
      if (!paramStr.includes('$now.format(') && !paramStr.includes('$today.format(')) continue
      this.warn(
        issues, 93,
        `Node "${node.name}" expression calls .format() on a Luxon DateTime — Luxon uses .toFormat() not .format() (which is a Moment.js method). Update to: {{ $now.toFormat('yyyy-MM-dd') }}. Note: Luxon format tokens use lowercase 'yyyy' and 'dd', not 'YYYY'/'DD'.`,
        node.id,
      )
    }
  }

  // Rule 94 (WARN): toolCode AI tool node has no executable code
  private checkRule94(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.toolCode') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const code = (params?.['jsCode'] ?? params?.['code'] ?? '') as string
      const stripped = code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
      if (!stripped) {
        this.warn(
          issues, 94,
          `Node "${node.name}" is a toolCode AI tool with no executable code — when the agent invokes this tool it will return nothing. Add the JavaScript code this tool should execute.`,
          node.id,
        )
      }
    }
  }

  // Rule 95 (ERROR): toolHttpRequest AI tool has no URL defined
  private checkRule95(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.toolHttpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const url = params?.['url'] as string | undefined
      if (!url || url.trim() === '') {
        this.err(
          issues, 95,
          `Node "${node.name}" is a toolHttpRequest AI tool with no URL defined — when the agent invokes this tool it will fail immediately. Set the url parameter to the target API endpoint.`,
          node.id,
        )
      }
    }
  }

  // Rule 96 (WARN): AI Agent/chain has multiple ai_languageModel sub-nodes (n8n only uses index 0)
  private checkRule96(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    const lmSourcesPerTarget = new Map<string, string[]>()
    for (const [sourceName, outputs] of Object.entries(connections)) {
      const lmPorts = outputs['ai_languageModel']
      if (!Array.isArray(lmPorts)) continue
      for (const port of lmPorts) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const target = (t as { node?: string }).node
          if (typeof target !== 'string') continue
          if (!lmSourcesPerTarget.has(target)) lmSourcesPerTarget.set(target, [])
          lmSourcesPerTarget.get(target)!.push(sourceName)
        }
      }
    }
    const AGENT_TYPES = new Set([
      '@n8n/n8n-nodes-langchain.agent',
      '@n8n/n8n-nodes-langchain.chainLlm',
      '@n8n/n8n-nodes-langchain.chainRetrievalQa',
      '@n8n/n8n-nodes-langchain.chainSummarization',
    ])
    for (const node of w.nodes) {
      if (!AGENT_TYPES.has(node.type)) continue
      const sources = lmSourcesPerTarget.get(node.name) ?? []
      if (sources.length >= 2) {
        this.warn(
          issues, 96,
          `Node "${node.name}" has ${sources.length} language model sub-nodes connected (${sources.join(', ')}) — n8n only uses the first one. Remove the extra language model sub-node(s) or use separate agents.`,
          node.id,
        )
      }
    }
  }

  // Rule 97 (ERROR): vectorStore node missing ai_embedding sub-node
  private checkRule97(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    const nodesWithEmbedding = new Set<string>()
    for (const outputs of Object.values(connections)) {
      const embPorts = outputs['ai_embedding']
      if (!Array.isArray(embPorts)) continue
      for (const port of embPorts) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const target = (t as { node?: string }).node
          if (typeof target === 'string') nodesWithEmbedding.add(target)
        }
      }
    }
    for (const node of w.nodes) {
      if (!node.type.startsWith('@n8n/n8n-nodes-langchain.vectorStore')) continue
      if (!nodesWithEmbedding.has(node.name)) {
        this.err(
          issues, 97,
          `Node "${node.name}" (${node.type}) is a vector store without an embeddings sub-node connected — vector stores require an embeddings model (e.g. embeddingsOpenAi) via the ai_embedding connection to convert text to vectors. Without it the node throws at runtime.`,
          node.id,
        )
      }
    }
  }

  // Rule 98 (ERROR): outputParserStructured has no JSON schema
  private checkRule98(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.outputParserStructured') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const schema = params?.['jsonSchema'] ?? params?.['schema']
      const isEmpty = !schema
        || (typeof schema === 'string' && schema.trim() === '')
        || (typeof schema === 'object' && schema !== null && Object.keys(schema as Record<string, unknown>).length === 0)
      if (isEmpty) {
        this.err(
          issues, 98,
          `Node "${node.name}" (outputParserStructured) has no JSON schema defined — the structured output parser requires a schema to validate the LLM's output. Without it the parser throws at runtime. Add a schema describing the expected output structure.`,
          node.id,
        )
      }
    }
  }

  // Rule 99 (WARN): chainLlm with output parser connected but {format_instructions} missing from prompt
  private checkRule99(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    // Build set of node names that RECEIVE an ai_outputParser connection (sub-node is always the source)
    const nodesWithParser = new Set<string>()
    for (const outputs of Object.values(connections)) {
      const parserPorts = outputs['ai_outputParser']
      if (!Array.isArray(parserPorts)) continue
      for (const port of parserPorts) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const target = (t as { node?: string }).node
          if (typeof target === 'string') nodesWithParser.add(target)
        }
      }
    }
    if (nodesWithParser.size === 0) return
    for (const node of w.nodes) {
      if (node.type !== '@n8n/n8n-nodes-langchain.chainLlm') continue
      if (!nodesWithParser.has(node.name)) continue
      const params = node.parameters as Record<string, unknown> | undefined
      const prompt = params?.['prompt']
      if (!prompt || typeof prompt !== 'string') continue
      // Skip expressions — we can't inspect them statically
      if (prompt.startsWith('={{') || prompt.startsWith('{{')) continue
      if (!prompt.includes('{format_instructions}')) {
        this.warn(
          issues, 99,
          `Node "${node.name}" has an output parser connected but the prompt template does not include {format_instructions} — n8n injects the parser's formatting requirements via this placeholder. Without it the LLM won't know the expected output format and the parser will fail to parse the response. Add {format_instructions} where the formatting guidance should appear in the prompt.`,
          node.id,
        )
      }
    }
  }

  // Rule 100 (ERROR): Postgres / MySQL executeQuery node has empty SQL query
  private checkRule100(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const DB_TYPES = new Set(['n8n-nodes-base.postgres', 'n8n-nodes-base.mySql'])
    for (const node of w.nodes) {
      if (!DB_TYPES.has(node.type)) continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const operation = params['operation']
      if (operation !== 'executeQuery' && operation !== 'query') continue
      const query = params['query'] as string | undefined
      if (!query || (query.trim() === '' && !query.startsWith('={{'))) {
        this.err(
          issues, 100,
          `Node "${node.name}" (${node.type}) has an empty SQL query — a database execute node with no query will throw a SQL syntax error at runtime. Add the SQL statement to execute.`,
          node.id,
        )
      }
    }
  }

  // Rule 101 (WARN): formTrigger has no form fields defined
  private checkRule101(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.formTrigger') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const formFields = params?.['formFields'] as Record<string, unknown> | undefined
      const values = formFields?.['values']
      if (!Array.isArray(values) || values.length === 0) {
        this.warn(
          issues, 101,
          `Node "${node.name}" (formTrigger) has no form fields defined — the form will be empty and will not collect any data from users. Add at least one form field.`,
          node.id,
        )
      }
    }
  }

  // Rule 102 (ERROR): splitOut node missing fieldToSplitOut parameter
  private checkRule102(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.splitOut') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const field = params?.['fieldToSplitOut'] as string | undefined
      if (!field || (field.trim() === '' && !field.startsWith('={{'))) {
        this.err(
          issues, 102,
          `Node "${node.name}" (splitOut) has no "fieldToSplitOut" specified — n8n will throw "Field to split out is not defined" at runtime. Set fieldToSplitOut to the array field name (e.g. "items" or "results").`,
          node.id,
        )
      }
    }
  }

  // Rule 103 (WARN): Code node returns array items without the required json wrapper
  private checkRule103(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const code = (params?.['jsCode'] ?? params?.['code'] ?? '') as string
      if (!code) continue
      // Strip comments so they don't confuse the heuristic
      const stripped = code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      // Only check if there is a return of a literal array
      if (!/return\s*\[/.test(stripped)) continue
      // Skip if already using the json wrapper
      if (/\bjson\s*:/.test(stripped)) continue
      // Skip modern pass-through patterns
      if (/return\s+items\b/.test(stripped)) continue
      if (/\$input\.all\(\)/.test(stripped)) continue
      // Skip empty-array returns: return []
      if (/return\s*\[\s*\]/.test(stripped) && !/return\s*\[[\s\S]*?\{/.test(stripped)) continue
      this.warn(
        issues, 103,
        `Node "${node.name}" Code node may be returning items without the required "json" wrapper — n8n expects [{ json: { field: value } }], not [{ field: value }]. Without the "json" key all downstream $json references will be undefined. Wrap your return: return [{ json: { yourField: value } }].`,
        node.id,
      )
    }
  }

  // Rule 105 (ERROR): LM model parameter set to a non-routable alias ("latest", "default", etc.)
  private checkRule105(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const INVALID_ALIASES = new Set(['latest', 'default', 'gpt-latest', 'claude-latest', 'anthropic-latest', 'openai-latest'])
    const LM_TYPES = new Set([
      '@n8n/n8n-nodes-langchain.lmChatAnthropic',
      '@n8n/n8n-nodes-langchain.lmChatOpenAi',
      '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
      '@n8n/n8n-nodes-langchain.openAi',
      '@n8n/n8n-nodes-langchain.anthropic',
    ])
    for (const node of w.nodes) {
      if (!LM_TYPES.has(node.type)) continue
      const params = node.parameters as Record<string, unknown> | undefined
      const options = params?.['options'] as Record<string, unknown> | undefined
      const model = (params?.['model'] ?? options?.['model']) as string | undefined
      if (model && INVALID_ALIASES.has(model.toLowerCase().trim())) {
        this.err(
          issues, 105,
          `Node "${node.name}" uses "${model}" as the model name — this is not a valid model identifier. Specify an exact model name such as "claude-sonnet-4-6" or "gpt-4o". The API will return "Unknown model" at runtime.`,
          node.id,
        )
      }
    }
  }

  // Rule 106 (WARN): Switch fallbackOutput is enabled but the fallback output port has no downstream connection
  private checkRule106(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.switch') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const fallback = params?.['fallbackOutput']
      if (!fallback || fallback === 'none') continue
      const rulesContainer = params?.['rules'] as Record<string, unknown> | undefined
      const rules = rulesContainer?.['rules'] as unknown[] | undefined
      const routeCount = Array.isArray(rules) ? rules.length : 0
      const nodeConns = connections[node.name]
      const mainConns = nodeConns?.['main']
      const fallbackConns = Array.isArray(mainConns) ? mainConns[routeCount] : undefined
      if (!Array.isArray(fallbackConns) || fallbackConns.length === 0) {
        this.warn(
          issues, 106,
          `Node "${node.name}" Switch has fallback output enabled but the fallback port (output ${routeCount}) has no downstream connections — items that don't match any route will be silently dropped. Wire the fallback output to a handler node, or disable it if unmatched items should be discarded.`,
          node.id,
        )
      }
    }
  }

  // Rule 107 (WARN): trigger node expression references $json (no upstream data at trigger time)
  private checkRule107(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    // chatTrigger is skipped — it receives chat input that can be referenced
    const SKIP_TYPES = new Set(['@n8n/n8n-nodes-langchain.chatTrigger'])
    for (const node of w.nodes) {
      if (!this.isTriggerNode(node)) continue
      if (SKIP_TYPES.has(node.type)) continue
      const paramStr = JSON.stringify(node.parameters ?? '')
      // Look for $json. (with dot) inside ={{ }} to detect field access, not just the variable name
      if (/={{[^}]*\$json\.[^}]*}}/.test(paramStr)) {
        this.warn(
          issues, 107,
          `Node "${node.name}" is a trigger node that references $json in an expression — trigger nodes have no upstream node so $json is empty ({}). Access incoming data in downstream nodes instead via $('${node.name}').first().json.fieldName.`,
          node.id,
        )
      }
    }
  }

  // Rule 108 (WARN): aggregate node in field-specific mode with no fields to aggregate
  private checkRule108(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.aggregate') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['aggregate'] === 'aggregateAllItemData') continue
      const container = params['fieldsToAggregate'] as Record<string, unknown> | undefined
      const fields = container?.['fieldToAggregate']
      if (!Array.isArray(fields) || fields.length === 0) {
        this.warn(
          issues, 108,
          `Node "${node.name}" (aggregate) is configured to aggregate specific fields but no fields are defined — the node will produce empty output. Add fields to aggregate or switch to "Aggregate All Item Data" mode.`,
          node.id,
        )
      }
    }
  }

  // Rule 109 (WARN): Airtable create/update/upsert node with no field mappings
  private checkRule109(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const WRITE_OPS = new Set(['create', 'update', 'upsert'])
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.airtable') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const operation = params['operation'] as string | undefined
      if (!operation || !WRITE_OPS.has(operation)) continue
      // Support different Airtable typeVersion parameter shapes
      const fieldsUi = params['fieldsUi'] as Record<string, unknown> | undefined
      const fieldValues = fieldsUi?.['fieldValues'] as unknown[] | undefined
      const fields = params['fields'] as Record<string, unknown> | undefined
      const fieldEntries = fields?.['entries'] as unknown[] | undefined
      const hasFieldMappings =
        (Array.isArray(fieldValues) && fieldValues.length > 0) ||
        (Array.isArray(fieldEntries) && fieldEntries.length > 0)
      if (!hasFieldMappings) {
        this.warn(
          issues, 109,
          `Node "${node.name}" (Airtable ${operation}) has no field mappings defined — the ${operation} call will ${operation === 'create' ? 'create a blank record' : 'write no data'}. Add field mappings to specify which Airtable columns to populate.`,
          node.id,
        )
      }
    }
  }

  // Rule 110 (WARN): agent with promptType="define" but text is empty
  private checkRule110(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const DEFINE_TYPES = new Set([
      '@n8n/n8n-nodes-langchain.agent',
      '@n8n/n8n-nodes-langchain.chainLlm',
      '@n8n/n8n-nodes-langchain.chainRetrievalQa',
      '@n8n/n8n-nodes-langchain.chainSummarization',
    ])
    for (const node of w.nodes) {
      if (!DEFINE_TYPES.has(node.type)) continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['promptType'] !== 'define') continue
      const text = params['text'] as string | undefined
      if (!text || (text.trim() === '' && !text.startsWith('={{'))) {
        this.warn(
          issues, 110,
          `Node "${node.name}" has promptType "define" but the text field is empty — the LLM will receive no user input and the chain will produce no useful output. Set the text field to the prompt or question the chain should process.`,
          node.id,
        )
      }
    }
  }

  // Rule 111 (WARN): ai_languageModel connection targets a non-agent/chain node
  private checkRule111(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    const VALID_LM_TARGETS = new Set([
      '@n8n/n8n-nodes-langchain.agent',
      '@n8n/n8n-nodes-langchain.chainLlm',
      '@n8n/n8n-nodes-langchain.chainRetrievalQa',
      '@n8n/n8n-nodes-langchain.chainSummarization',
    ])
    const nodeTypeByName = new Map(w.nodes.map(n => [n.name, n.type]))
    const nodeIdByName = new Map(w.nodes.map(n => [n.name, n.id]))
    for (const [sourceName, outputs] of Object.entries(connections)) {
      const lmPorts = outputs['ai_languageModel']
      if (!Array.isArray(lmPorts)) continue
      for (const port of lmPorts) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const target = (t as { node?: string }).node
          if (typeof target !== 'string') continue
          const targetType = nodeTypeByName.get(target)
          if (!targetType) continue
          if (!VALID_LM_TARGETS.has(targetType)) {
            this.warn(
              issues, 111,
              `Node "${sourceName}" is connected as a language model sub-node to "${target}" (${targetType}), which is not an agent or chain node — the ai_languageModel connection will be ignored at runtime. Connect the LM sub-node to an Agent, chainLlm, chainRetrievalQa, or chainSummarization node instead.`,
              nodeIdByName.get(sourceName) ?? undefined,
            )
          }
        }
      }
    }
  }

  // Rule 112 (ERROR): Luxon .add() or .subtract() used in expressions (Moment.js methods)
  private checkRule112(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const CHECKS: [RegExp, string, string][] = [
      [/\$now\.add\(/, '$now.add()', '$now.plus({ days: 1 })'],
      [/\$today\.add\(/, '$today.add()', '$today.plus({ days: 1 })'],
      [/\$now\.subtract\(/, '$now.subtract()', '$now.minus({ days: 1 })'],
      [/\$today\.subtract\(/, '$today.subtract()', '$today.minus({ days: 1 })'],
    ]
    for (const node of w.nodes) {
      const paramStr = JSON.stringify(node.parameters ?? '')
      for (const [pattern, found, replacement] of CHECKS) {
        if (pattern.test(paramStr)) {
          this.err(
            issues, 112,
            `Node "${node.name}" uses ${found} which is a Moment.js method — Luxon's $now and $today do not have .add() or .subtract(). Use the Luxon equivalent ${replacement} instead. This throws TypeError at runtime.`,
            node.id,
          )
          break
        }
      }
    }
  }

  // Rule 113 (WARN): IF node with unconnected true or false output branch
  private checkRule113(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.if') continue
      const mainPorts = connections[node.name]?.['main']
      const trueBranch = Array.isArray(mainPorts) ? mainPorts[0] : undefined
      const falseBranch = Array.isArray(mainPorts) ? mainPorts[1] : undefined
      if (!trueBranch || (Array.isArray(trueBranch) && trueBranch.length === 0)) {
        this.warn(
          issues, 113,
          `Node "${node.name}" IF node has no connection on the true output (port 0) — items that evaluate to true are silently dropped. Connect the true branch to a handler, or wire it to a NoOp node if discarding is intentional.`,
          node.id,
        )
      }
      if (!falseBranch || (Array.isArray(falseBranch) && falseBranch.length === 0)) {
        this.warn(
          issues, 113,
          `Node "${node.name}" IF node has no connection on the false output (port 1) — items that evaluate to false are silently dropped. Connect the false branch to a handler, or wire it to a NoOp node if discarding is intentional.`,
          node.id,
        )
      }
    }
  }

  // Rule 114 (WARN): $('NodeName') in expressions references a node that does not exist
  private checkRule114(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const nodeNames = new Set(w.nodes.map(n => n.name))
    for (const node of w.nodes) {
      // Rule 67 already covers Code node jsCode strings
      if (node.type === 'n8n-nodes-base.code') continue
      const paramStr = JSON.stringify(node.parameters ?? '')
      // Single-quote refs: $('NodeName') — single quotes are not escaped in JSON stringify
      const singleRefs = [...paramStr.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]).filter((r): r is string => r !== undefined)
      // Double-quote refs: $("NodeName") — double quotes become \" in JSON stringify output
      const doubleRefs = [...paramStr.matchAll(/\$\(\\"([^\\"]+)\\"\)/g)].map(m => m[1]).filter((r): r is string => r !== undefined)
      const missingRefs = new Set(
        [...singleRefs, ...doubleRefs].filter(ref => !nodeNames.has(ref)),
      )
      for (const ref of missingRefs) {
        this.warn(
          issues, 114,
          `Node "${node.name}" references $('${ref}') in an expression but no node named "${ref}" exists in this workflow — this will throw TypeError at runtime. Check for renamed or deleted nodes and update the expression.`,
          node.id,
        )
      }
    }
  }

  // Rule 115 (WARN): SplitInBatches output 1 (loop body) has no path that loops back
  private checkRule115(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const connections = (w.connections as Record<string, Record<string, unknown[][]>>) ?? {}
    // Build adjacency list from main connections only
    const mainTargets = new Map<string, string[]>()
    for (const [sourceName, outputs] of Object.entries(connections)) {
      const mainPorts = outputs['main']
      if (!Array.isArray(mainPorts)) continue
      const targets: string[] = []
      for (const port of mainPorts) {
        if (!Array.isArray(port)) continue
        for (const t of port) {
          const tgt = (t as { node?: string }).node
          if (typeof tgt === 'string') targets.push(tgt)
        }
      }
      mainTargets.set(sourceName, targets)
    }
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.splitInBatches') continue
      const mainPorts = connections[node.name]?.['main']
      if (!Array.isArray(mainPorts)) continue
      const loopBodyPort = mainPorts[1]
      if (!Array.isArray(loopBodyPort) || loopBodyPort.length === 0) continue
      const initialTargets = loopBodyPort
        .map(t => (t as { node?: string }).node)
        .filter((n): n is string => typeof n === 'string')
      // BFS to detect loop-back to this SplitInBatches node
      const visited = new Set<string>()
      const queue = [...initialTargets]
      let foundLoopBack = false
      while (queue.length > 0) {
        const current = queue.shift()!
        if (current === node.name) { foundLoopBack = true; break }
        if (visited.has(current)) continue
        visited.add(current)
        for (const next of mainTargets.get(current) ?? []) queue.push(next)
      }
      if (!foundLoopBack) {
        this.warn(
          issues, 115,
          `Node "${node.name}" SplitInBatches loop body (output 1) has no path leading back to the SplitInBatches node — only the first batch will execute and the "done" output (port 0) will never fire. Connect the last node in the processing chain back to "${node.name}" to complete the loop.`,
          node.id,
        )
      }
    }
  }

  // Rule 116 (ERROR): LM sub-node using a model name from the wrong provider
  private checkRule116(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const CHECKS: Array<{ type: string; wrong: RegExp[]; provider: string }> = [
      {
        type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        wrong: [/^claude-/i, /^gemini-/i],
        provider: 'OpenAI',
      },
      {
        type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
        wrong: [/^gpt-/i, /^gemini-/i, /^o[0-9]-/i, /^o[0-9]$/i],
        provider: 'Anthropic',
      },
      {
        type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
        wrong: [/^gpt-/i, /^claude-/i, /^o[0-9]-/i],
        provider: 'Google Gemini',
      },
    ]
    for (const node of w.nodes) {
      const check = CHECKS.find(c => c.type === node.type)
      if (!check) continue
      const params = node.parameters as Record<string, unknown> | undefined
      const options = params?.['options'] as Record<string, unknown> | undefined
      const model = (params?.['model'] ?? options?.['model']) as string | undefined
      if (!model || model.startsWith('={{')) continue
      const wrongPattern = check.wrong.find(p => p.test(model))
      if (wrongPattern) {
        this.err(
          issues, 116,
          `Node "${node.name}" (${check.provider} LM node) has model "${model}" which belongs to a different provider — the ${check.provider} API will reject this model name with a model_not_found error. Use a ${check.provider}-compatible model identifier and ensure the credential matches the provider.`,
          node.id,
        )
      }
    }
  }

  // Rule 117 (WARN): Google Calendar create event missing start or end time
  private checkRule117(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.googleCalendar') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['resource'] !== 'event' || params['operation'] !== 'create') continue
      const additional = params['additionalFields'] as Record<string, unknown> | undefined
      const start = (params['start'] ?? additional?.['start']) as string | undefined
      const end = (params['end'] ?? additional?.['end']) as string | undefined
      const isMissing = (v: string | undefined): boolean =>
        !v || (v.trim() === '' && !v.startsWith('={{'))
      if (isMissing(start)) {
        this.warn(
          issues, 117,
          `Node "${node.name}" (googleCalendar create event) has no start time — Google Calendar requires start.dateTime for event creation and returns 400 Missing required field. Set the start parameter to an ISO 8601 datetime string or expression.`,
          node.id,
        )
      }
      if (isMissing(end)) {
        this.warn(
          issues, 117,
          `Node "${node.name}" (googleCalendar create event) has no end time — Google Calendar requires end.dateTime for event creation and returns 400 Missing required field. Set the end parameter to an ISO 8601 datetime string or expression.`,
          node.id,
        )
      }
    }
  }

  // Rule 118 (WARN): Redis node missing key (propertyName) for key-based operations
  private checkRule118(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const KEY_OPS = new Set([
      'get', 'set', 'delete', 'incr', 'decr', 'expire', 'ttl', 'type',
      'lrange', 'lset', 'lrem', 'rpush', 'lpush',
      'hset', 'hget', 'hdel', 'hgetall',
    ])
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.redis') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const operation = params?.['operation'] as string | undefined
      if (!operation || !KEY_OPS.has(operation)) continue
      const key = params?.['propertyName'] as string | undefined
      if (!key || (key.trim() === '' && !key.startsWith('={{'))) {
        this.warn(
          issues, 118,
          `Node "${node.name}" Redis ${operation} operation has no key specified — set propertyName to the Redis key to operate on. Without a key this operation will throw at runtime.`,
          node.id,
        )
      }
    }
  }

  // Rule 119 (ERROR): Supabase node missing tableId
  private checkRule119(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.supabase') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const tableId = params?.['tableId'] as string | undefined
      if (!tableId || (tableId.trim() === '' && !tableId.startsWith('={{'))) {
        this.err(
          issues, 119,
          `Node "${node.name}" (supabase) has no table specified — every Supabase operation requires a tableId. n8n will throw "No table ID provided" at runtime. Set tableId to the name of the Supabase table to operate on.`,
          node.id,
        )
      }
    }
  }

  // Rule 120 (WARN): Gmail reply operation missing messageId
  private checkRule120(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.gmail') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['operation'] !== 'reply') continue
      const message = params['message'] as Record<string, unknown> | undefined
      const messageId = (params['messageId'] ?? message?.['id'] ?? message?.['messageId']) as string | undefined
      if (!messageId || (typeof messageId === 'string' && messageId.trim() === '' && !messageId.startsWith('={{'))) {
        this.warn(
          issues, 120,
          `Node "${node.name}" Gmail reply operation has no messageId — the Gmail API cannot thread the reply without the original message ID. Set messageId to the ID of the message to reply to (e.g. $('Gmail Trigger').first().json.id).`,
          node.id,
        )
      }
    }
  }

  // Rule 121 (WARN): splitOut fieldToSplitOut contains a dot (dot-path navigation attempt)
  private checkRule121(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.splitOut') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const field = params?.['fieldToSplitOut'] as string | undefined
      if (!field || field.startsWith('={{')) continue
      if (field.includes('.')) {
        this.warn(
          issues, 121,
          `Node "${node.name}" fieldToSplitOut is "${field}" which contains a dot — splitOut treats this as a literal field name, not a path. It will look for a top-level field literally named "${field}" which almost certainly doesn't exist and will produce 0 output items. To split a nested array, first use a Set node to hoist the value (e.g. set "items" to {{ $json.${field} }}), then split on "items".`,
          node.id,
        )
      }
    }
  }

  // Rule 122 (WARN): Luxon .plus() or .minus() called with positional (n, 'unit') arguments
  private checkRule122(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    // Matches .plus(number, or .minus(number, — the 2-arg Moment.js calling convention
    const PATTERN = /\.(plus|minus)\(\s*\d+\s*,/
    for (const node of w.nodes) {
      const paramStr = JSON.stringify(node.parameters ?? '')
      const match = PATTERN.exec(paramStr)
      if (match) {
        const method = match[1]
        this.warn(
          issues, 122,
          `Node "${node.name}" calls .${method}() with positional arguments — Luxon ignores the second argument and treats the first as milliseconds, not days/hours/etc. Use the object form: .${method}({ days: 1 }) or .${method}({ hours: 2 }). Example: $now.${method}({ days: 1 }).`,
          node.id,
        )
      }
    }
  }

  // Rule 123 (WARN): HTTP Request sendQuery=true but queryParameters is empty
  private checkRule123(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.httpRequest') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['sendQuery'] !== true) continue
      // Skip if dynamic JSON query string is provided
      const queryJson = params['queryParametersJson'] as string | undefined
      if (queryJson && typeof queryJson === 'string' && queryJson.trim() !== '') continue
      // Check structured parameters array
      const qp = params['queryParameters'] as Record<string, unknown> | undefined
      const qpValues = qp?.['parameters']
      if (Array.isArray(qpValues) && qpValues.length > 0) continue
      this.warn(
        issues, 123,
        `Node "${node.name}" has sendQuery enabled but no query parameters are configured — the request will be sent without any query string. Either add query parameters (name/value pairs) or disable sendQuery if the endpoint does not require them.`,
        node.id,
      )
    }
  }

  // Rule 124 (WARN): Code node in runOnceForAllItems mode has no return statement
  private checkRule124(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      if (params['mode'] !== 'runOnceForAllItems') continue
      if (params['language'] === 'python') continue
      const code = (params['jsCode'] ?? params['code'] ?? '') as string
      if (!code) continue
      const stripped = code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      if (!stripped.trim()) continue // Rule 28 covers empty code
      if (!/\breturn\b/.test(stripped)) {
        this.warn(
          issues, 124,
          `Node "${node.name}" Code node is in "runOnceForAllItems" mode but has no return statement — unlike the default mode, a missing return in runOnceForAllItems causes the node to emit 0 items, silently terminating the data flow. Add return [{ json: { ... } }] at the end of your code.`,
          node.id,
        )
      }
    }
  }

  // Rule 125 (WARN): Luxon uppercase YYYY or DD tokens in .toFormat() calls
  private checkRule125(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      const paramStr = JSON.stringify(node.parameters ?? '')
      const hasYYYY = /\.toFormat\(['"][^'"]*YYYY[^'"]*['"]/.test(paramStr)
      // Match DD that is not part of DDD (ordinal day) — negative lookahead for third D
      const hasDD = /\.toFormat\(['"][^'"]*(?<![D])DD(?!D)[^'"]*['"]/.test(paramStr)
      if (!hasYYYY && !hasDD) continue
      const tokens = [hasYYYY && 'YYYY', hasDD && 'DD'].filter(Boolean).join(' and ')
      this.warn(
        issues, 125,
        `Node "${node.name}" uses Moment.js-style uppercase token(s) ${tokens} in a Luxon .toFormat() call — in Luxon, YYYY is the ISO week-based year (not calendar year) and DD is the ordinal day of year (1–366, not day of month). Use lowercase: yyyy for calendar year, dd for day of month. Example: $now.toFormat('yyyy-MM-dd').`,
        node.id,
      )
    }
  }

  // Rule 126 (WARN): Node ID does not match UUID v4 format
  private checkRule126(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    for (const node of w.nodes) {
      if (typeof node.id !== 'string' || node.id === '') continue // Rules 3/4 cover missing/empty
      if (!UUID_V4.test(node.id)) {
        this.warn(
          issues, 126,
          `Node "${node.name}" has ID "${node.id}" which is not a valid UUID v4 — n8n requires UUID v4 format (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx) for all node IDs. Non-UUID IDs may cause issues with execution tracking. Generate a proper UUID v4 for this node.`,
          node.id,
        )
      }
    }
  }

  // Rule 127 (WARN): Code node language/param mismatch — jsCode/pythonCode populated for the wrong language
  private checkRule127(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.code') continue
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue
      const language = params['language']
      const jsCode = typeof params['jsCode'] === 'string' ? params['jsCode'].trim() : ''
      const pythonCode = typeof params['pythonCode'] === 'string' ? params['pythonCode'].trim() : ''

      if (language === 'python' && jsCode !== '' && pythonCode === '') {
        this.warn(
          issues, 127,
          `Node "${node.name}" has language: "python" but code is set in jsCode — n8n runs the pythonCode parameter when language is python, so this code never executes. Move it to pythonCode.`,
          node.id,
        )
      } else if (language !== 'python' && pythonCode !== '' && jsCode === '') {
        this.warn(
          issues, 127,
          `Node "${node.name}" has pythonCode set but language is not "python" — n8n runs the jsCode parameter by default, so this code never executes. Move it to jsCode, or set language: "python".`,
          node.id,
        )
      }
    }
  }

  // Rule 128 (WARN): onError "continueErrorOutput" set but the dedicated error output port (index 1) is unwired
  private checkRule128(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes) || typeof w.connections !== 'object' || w.connections === null) return
    const connections = w.connections as Record<string, { main?: unknown[][] }>

    for (const node of w.nodes) {
      const params = node.parameters as Record<string, unknown> | undefined
      if (params?.['onError'] !== 'continueErrorOutput') continue

      const mainOutputs = connections[node.name]?.main
      const errorPort = Array.isArray(mainOutputs) ? mainOutputs[1] : undefined
      const hasErrorConnection = Array.isArray(errorPort) && errorPort.length > 0

      if (!hasErrorConnection) {
        this.warn(
          issues, 128,
          `Node "${node.name}" has onError: "continueErrorOutput", which gives it a second output port for error-path items — but that port (output index 1) has no connection. Every item that errors on this node is silently dropped. Wire output index 1 to an error-handling path, or use "continueRegularOutput" if errors should just pass through the normal output.`,
          node.id,
        )
      }
    }
  }

  // Rule 129 (WARN): node's resource/operation value doesn't exist in the real n8n schema for its type
  private checkRule129(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      const catalogEntry = NODE_OPERATION_CATALOG[node.type]
      if (!catalogEntry) continue // no generated data for this node type — nothing to check against
      const params = node.parameters as Record<string, unknown> | undefined
      if (!params) continue

      const resource = params['resource']
      if (typeof resource === 'string' && catalogEntry.resources.length > 0 && !catalogEntry.resources.includes(resource)) {
        this.warn(
          issues, 129,
          `Node "${node.name}" (${node.type}) sets resource: "${resource}", which is not a valid resource for this node type. Valid resources: ${catalogEntry.resources.join(', ')}.`,
          node.id,
        )
      }

      const operation = params['operation']
      if (typeof operation === 'string' && catalogEntry.operations.length > 0 && !catalogEntry.operations.includes(operation)) {
        this.warn(
          issues, 129,
          `Node "${node.name}" (${node.type}) sets operation: "${operation}", which is not a valid operation for this node type. Valid operations: ${catalogEntry.operations.join(', ')}.`,
          node.id,
        )
      }
    }
  }

  // Rule 34 (WARN): webhook path contains spaces, starts with slash, or looks like a full URL
  private checkRule34(w: N8nWorkflow, issues: ValidationIssue[]): void {
    if (!Array.isArray(w.nodes)) return
    for (const node of w.nodes) {
      if (node.type !== 'n8n-nodes-base.webhook') continue
      const params = node.parameters as Record<string, unknown> | undefined
      const path = params?.['path']
      if (typeof path !== 'string') continue
      if (/\s/.test(path)) {
        this.warn(
          issues,
          34,
          `Node "${node.name}" webhook path contains spaces: "${path}" — use hyphens or underscores instead`,
          node.id,
        )
      } else if (/^https?:\/\//i.test(path)) {
        this.warn(
          issues,
          34,
          `Node "${node.name}" webhook path looks like a full URL — it should be a relative path (e.g. "my-hook")`,
          node.id,
        )
      } else if (path.startsWith('/')) {
        this.warn(
          issues,
          34,
          `Node "${node.name}" webhook path starts with "/" — n8n adds the leading slash automatically`,
          node.id,
        )
      }
    }
  }
}
