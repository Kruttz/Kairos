export interface NodeDefinition {
  type: string
  safeTypeVersions: number[]
  requiredParams: string[]
  /** Primary/first known credential type -- kept for existing consumers. When a node accepts
   * more than one valid credential type (see credentialTypes), this is just the first one
   * seen, not necessarily the "correct" one for any particular auth mode. */
  credentialType?: string
  /** Every credential type name the live n8n instance reported for this node, in the order
   * n8n returned them. Only the names -- N8nNodeTypeInfo.credentials only types
   * {name, required?} today, with no displayOptions field, so there's no way to know from
   * this alone which auth-mode parameter value selects which entry. Whether n8n's real
   * node-types API response actually carries displayOptions (making a richer capture
   * possible) is unverified -- checked only against Kairos's own type, not a live response
   * (see docs/plans/step3-audit-report-2026-07-08.md §2). Absent when a node reports zero or
   * one credential (credentialType alone is enough in that case). */
  credentialTypes?: string[]
  isTrigger?: boolean
}

export const DEFAULT_REGISTRY: NodeDefinition[] = [
  // Trigger nodes
  { type: 'n8n-nodes-base.manualTrigger', safeTypeVersions: [1], requiredParams: [], isTrigger: true },
  { type: 'n8n-nodes-base.scheduleTrigger', safeTypeVersions: [1, 1.1, 1.2], requiredParams: [], isTrigger: true },
  { type: 'n8n-nodes-base.webhook', safeTypeVersions: [1, 1.1, 2], requiredParams: ['httpMethod', 'path'], isTrigger: true },
  { type: 'n8n-nodes-base.formTrigger', safeTypeVersions: [1, 2, 2.1, 2.2], requiredParams: [], isTrigger: true },
  { type: 'n8n-nodes-base.emailReadImap', safeTypeVersions: [2], requiredParams: [], credentialType: 'imap', isTrigger: true },
  { type: 'n8n-nodes-base.errorTrigger', safeTypeVersions: [1], requiredParams: [], isTrigger: true },
  { type: 'n8n-nodes-base.executeWorkflowTrigger', safeTypeVersions: [1, 1.1], requiredParams: [], isTrigger: true },
  { type: 'n8n-nodes-base.gmailTrigger', safeTypeVersions: [1, 1.1, 1.2], requiredParams: [], credentialType: 'gmailOAuth2', isTrigger: true },
  { type: 'n8n-nodes-base.googleDriveTrigger', safeTypeVersions: [1], requiredParams: [], credentialType: 'googleDriveOAuth2Api', isTrigger: true },
  { type: 'n8n-nodes-base.googleSheetsTrigger', safeTypeVersions: [1], requiredParams: [], credentialType: 'googleSheetsTriggerOAuth2Api', isTrigger: true },
  { type: 'n8n-nodes-base.slackTrigger', safeTypeVersions: [1], requiredParams: [], credentialType: 'slackApi', isTrigger: true },
  { type: 'n8n-nodes-base.telegramTrigger', safeTypeVersions: [1, 1.1, 1.2], requiredParams: [], credentialType: 'telegramApi', isTrigger: true },
  { type: 'n8n-nodes-base.githubTrigger', safeTypeVersions: [1], requiredParams: [], credentialType: 'githubApi', isTrigger: true },
  { type: 'n8n-nodes-base.stripeTrigger', safeTypeVersions: [1], requiredParams: [], credentialType: 'stripeApi', isTrigger: true },
  { type: 'n8n-nodes-base.airtableTrigger', safeTypeVersions: [1], requiredParams: [], credentialType: 'airtableTokenApi', isTrigger: true },
  { type: 'n8n-nodes-base.notionTrigger', safeTypeVersions: [1], requiredParams: [], credentialType: 'notionApi', isTrigger: true },
  { type: '@n8n/n8n-nodes-langchain.chatTrigger', safeTypeVersions: [1, 1.1], requiredParams: [], isTrigger: true },

  // Core logic nodes
  { type: 'n8n-nodes-base.code', safeTypeVersions: [1, 2], requiredParams: [] },
  { type: 'n8n-nodes-base.httpRequest', safeTypeVersions: [1, 2, 3, 4, 4.1, 4.2], requiredParams: ['url'] },
  { type: 'n8n-nodes-base.set', safeTypeVersions: [1, 2, 3, 3.1, 3.2, 3.3, 3.4], requiredParams: [] },
  { type: 'n8n-nodes-base.if', safeTypeVersions: [1, 2, 2.1, 2.2], requiredParams: [] },
  { type: 'n8n-nodes-base.switch', safeTypeVersions: [1, 2, 3, 3.1, 3.2], requiredParams: [] },
  { type: 'n8n-nodes-base.filter', safeTypeVersions: [1, 2, 2.1, 2.2], requiredParams: [] },
  { type: 'n8n-nodes-base.merge', safeTypeVersions: [1, 2, 2.1, 3], requiredParams: [] },
  { type: 'n8n-nodes-base.splitInBatches', safeTypeVersions: [1, 2, 3], requiredParams: [] },
  { type: 'n8n-nodes-base.wait', safeTypeVersions: [1, 1.1], requiredParams: [] },
  { type: 'n8n-nodes-base.executeWorkflow', safeTypeVersions: [1, 1.1, 1.2], requiredParams: [] },
  { type: 'n8n-nodes-base.respondToWebhook', safeTypeVersions: [1, 1.1], requiredParams: [] },
  { type: 'n8n-nodes-base.noOp', safeTypeVersions: [1], requiredParams: [] },
  { type: 'n8n-nodes-base.stopAndError', safeTypeVersions: [1], requiredParams: [] },
  { type: 'n8n-nodes-base.splitOut', safeTypeVersions: [1], requiredParams: [] },
  { type: 'n8n-nodes-base.aggregate', safeTypeVersions: [1], requiredParams: [] },
  { type: 'n8n-nodes-base.stickyNote', safeTypeVersions: [1], requiredParams: [] },

  // Email / messaging
  { type: 'n8n-nodes-base.emailSend', safeTypeVersions: [1, 2, 2.1], requiredParams: [], credentialType: 'smtp' },
  { type: 'n8n-nodes-base.slack', safeTypeVersions: [1, 2, 2.1, 2.2], requiredParams: [], credentialType: 'slackOAuth2Api' },
  { type: 'n8n-nodes-base.telegram', safeTypeVersions: [1, 1.1, 1.2], requiredParams: [], credentialType: 'telegramApi' },
  { type: 'n8n-nodes-base.discord', safeTypeVersions: [1, 2], requiredParams: [], credentialType: 'discordWebhookApi' },

  // Google
  { type: 'n8n-nodes-base.gmail', safeTypeVersions: [1, 2, 2.1], requiredParams: [], credentialType: 'gmailOAuth2' },
  { type: 'n8n-nodes-base.googleSheets', safeTypeVersions: [1, 2, 3, 4, 4.1, 4.2, 4.3, 4.4, 4.5], requiredParams: [], credentialType: 'googleSheetsOAuth2Api' },
  { type: 'n8n-nodes-base.googleDrive', safeTypeVersions: [1, 2, 3], requiredParams: [], credentialType: 'googleDriveOAuth2Api' },
  { type: 'n8n-nodes-base.googleCalendar', safeTypeVersions: [1, 1.1, 1.2, 1.3], requiredParams: [], credentialType: 'googleCalendarOAuth2Api' },

  // Project management / CRM
  { type: 'n8n-nodes-base.notion', safeTypeVersions: [1, 2, 2.1, 2.2], requiredParams: [], credentialType: 'notionApi' },
  { type: 'n8n-nodes-base.airtable', safeTypeVersions: [1, 2, 2.1], requiredParams: [], credentialType: 'airtableTokenApi' },
  { type: 'n8n-nodes-base.github', safeTypeVersions: [1, 1.1], requiredParams: [], credentialType: 'githubApi' },
  { type: 'n8n-nodes-base.jira', safeTypeVersions: [1], requiredParams: [], credentialType: 'jiraSoftwareCloudApi' },
  { type: 'n8n-nodes-base.hubspot', safeTypeVersions: [1, 2, 2.1], requiredParams: [], credentialType: 'hubspotOAuth2Api' },

  // Databases
  { type: 'n8n-nodes-base.postgres', safeTypeVersions: [1, 2, 2.1, 2.2, 2.3, 2.4, 2.5], requiredParams: [], credentialType: 'postgres' },
  { type: 'n8n-nodes-base.mySql', safeTypeVersions: [1, 2, 2.1, 2.2, 2.3, 2.4], requiredParams: [], credentialType: 'mySql' },
  { type: 'n8n-nodes-base.redis', safeTypeVersions: [1], requiredParams: [], credentialType: 'redis' },
  { type: 'n8n-nodes-base.supabase', safeTypeVersions: [1], requiredParams: [], credentialType: 'supabaseApi' },

  // Cloud
  { type: 'n8n-nodes-base.awsS3', safeTypeVersions: [1, 2], requiredParams: [], credentialType: 'aws' },

  // Payment / commerce
  { type: 'n8n-nodes-base.stripe', safeTypeVersions: [1], requiredParams: [], credentialType: 'stripeApi' },

  // AI / LangChain root nodes
  { type: '@n8n/n8n-nodes-langchain.agent', safeTypeVersions: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.chainLlm', safeTypeVersions: [1, 1.1, 1.2, 1.3, 1.4, 1.5], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.chainRetrievalQa', safeTypeVersions: [1, 1.1, 1.2, 1.3, 1.4], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.openAi', safeTypeVersions: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8], requiredParams: [], credentialType: 'openAiApi' },
  { type: '@n8n/n8n-nodes-langchain.anthropic', safeTypeVersions: [1], requiredParams: [], credentialType: 'anthropicApi' },
  { type: '@n8n/n8n-nodes-langchain.informationExtractor', safeTypeVersions: [1], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.textClassifier', safeTypeVersions: [1], requiredParams: [] },

  // AI / LangChain sub-nodes (models)
  { type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', safeTypeVersions: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7], requiredParams: [], credentialType: 'openAiApi' },
  { type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', safeTypeVersions: [1, 1.1, 1.2, 1.3], requiredParams: [], credentialType: 'anthropicApi' },
  { type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', safeTypeVersions: [1], requiredParams: [], credentialType: 'googlePalmApi' },

  // AI / LangChain sub-nodes (memory, tools, etc.)
  { type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', safeTypeVersions: [1, 1.1, 1.2, 1.3], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.toolWorkflow', safeTypeVersions: [1, 1.1, 1.2, 1.3], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.toolCode', safeTypeVersions: [1, 1.1], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.toolHttpRequest', safeTypeVersions: [1, 1.1], requiredParams: [] },
  { type: '@n8n/n8n-nodes-langchain.toolCalculator', safeTypeVersions: [1], requiredParams: [] },
]

export class NodeRegistry {
  private readonly byType: Map<string, NodeDefinition>

  constructor(definitions: NodeDefinition[] = DEFAULT_REGISTRY) {
    this.byType = new Map(definitions.map((d) => [d.type, d]))
  }

  get(type: string): NodeDefinition | undefined {
    return this.byType.get(type)
  }

  isTrigger(type: string): boolean {
    return this.byType.get(type)?.isTrigger === true
  }

  isKnown(type: string): boolean {
    return this.byType.has(type)
  }

  isVersionSafe(type: string, version: number): boolean {
    const def = this.byType.get(type)
    if (!def) return true
    return def.safeTypeVersions.includes(version)
  }

  // Returns true when the version is greater than the highest known safe version —
  // indicates a newer release rather than a bad value. Accepts decimal versions
  // (e.g. 4.3 when max known is 4.2) since n8n uses decimal patch increments.
  isVersionNewer(type: string, version: number): boolean {
    const def = this.byType.get(type)
    if (!def || def.safeTypeVersions.length === 0) return false
    const max = Math.max(...def.safeTypeVersions)
    return version > 0 && version > max
  }

  getRequiredParams(type: string): string[] {
    return this.byType.get(type)?.requiredParams ?? []
  }

  get definitions(): NodeDefinition[] {
    return [...this.byType.values()]
  }
}
