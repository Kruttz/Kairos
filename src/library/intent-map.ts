import { containsKeyword } from '../utils/keyword-match.js'

export interface RequiredCategory {
  category: string
  examples: string[]
  reason: string
}

export interface IntentRequirements {
  intent: string
  label: string
  requiredCategories: RequiredCategory[]
  antiPatterns: string[]
}

export interface IntentMatch {
  requirements: IntentRequirements
  confidence: number  // 0-1 based on keyword match count
}

// Intent definitions — ordered from most-specific to least-specific
const INTENTS: Array<IntentRequirements & { keywords: string[] }> = [
  {
    intent: 'ai_processing',
    label: 'AI Processing',
    keywords: [
      'llm', 'ai', 'agent', 'gpt', 'claude', 'openai', 'anthropic', 'chatgpt',
      'langchain', 'chain', 'output parser', 'zod schema', 'structured output',
      'extract', 'classify', 'summarize', 'summarization', 'translate', 'generate text',
      'embedding', 'vector', 'rag', 'retrieval', 'semantic search',
    ],
    requiredCategories: [
      {
        category: 'Trigger',
        examples: ['manualTrigger', 'webhook', 'chatTrigger', 'scheduleTrigger'],
        reason: 'Every workflow needs an entry point',
      },
      {
        category: 'AI Root Node',
        examples: ['@n8n/n8n-nodes-langchain.chainLlm', '@n8n/n8n-nodes-langchain.agent'],
        reason: 'The core LLM processing node — chainLlm for single-turn, agent for multi-tool',
      },
      {
        category: 'Language Model Sub-node',
        examples: ['lmChatOpenAi', 'lmChatAnthropic', 'lmChatGoogleGemini'],
        reason: 'Must be wired to the AI root node via ai_languageModel connection',
      },
    ],
    antiPatterns: [
      'Do not use a Code node to call LLM APIs directly — use the LangChain nodes instead',
      'Do not use agent for simple single-turn tasks — chainLlm is simpler and more reliable',
      'Language model sub-node must be the SOURCE pointing TO the root node (not the other way)',
    ],
  },
  {
    intent: 'notification_alert',
    label: 'Notification / Alert',
    keywords: [
      'notify', 'notification', 'alert', 'send message', 'send email', 'send slack',
      'send telegram', 'message when', 'alert when', 'inform', 'announce', 'broadcast',
      'ping', 'remind', 'reminder',
    ],
    requiredCategories: [
      {
        category: 'Trigger',
        examples: ['webhook', 'scheduleTrigger', 'googleSheetsTrigger', 'airtableTrigger'],
        reason: 'What initiates the notification',
      },
      {
        category: 'Conditional (optional but common)',
        examples: ['if', 'switch', 'filter'],
        reason: 'Notifications often have a condition — only alert if value exceeds threshold',
      },
      {
        category: 'Messaging Node',
        examples: ['gmail', 'slack', 'telegram', 'discord', 'emailSend'],
        reason: 'The actual delivery mechanism for the notification',
      },
    ],
    antiPatterns: [
      'Do not skip a conditional check if the trigger fires on every event — filter first',
      'Do not hardcode recipient email/channel in parameters — use expressions from incoming data',
    ],
  },
  {
    intent: 'data_extraction',
    label: 'Data Extraction / Transformation',
    keywords: [
      'extract', 'pull data', 'fetch data', 'scrape', 'parse', 'transform', 'convert',
      'map fields', 'reformat', 'clean data', 'normalize', 'aggregate', 'process data',
      'http request', 'api call', 'rest api',
    ],
    requiredCategories: [
      {
        category: 'Trigger',
        examples: ['scheduleTrigger', 'webhook', 'manualTrigger'],
        reason: 'What initiates the extraction',
      },
      {
        category: 'Data Source',
        examples: ['httpRequest', 'googleSheets', 'airtable', 'notion', 'postgres'],
        reason: 'Where the data comes from',
      },
      {
        category: 'Transformation',
        examples: ['code', 'set', 'chainLlm with outputParser', 'aggregate'],
        reason: 'Process or reshape the extracted data',
      },
    ],
    antiPatterns: [
      'Do not skip error handling for external HTTP requests — they can fail',
      'For AI-based extraction, use an output parser with a Zod schema to get typed results',
    ],
  },
  {
    intent: 'data_sync',
    label: 'Data Synchronization',
    keywords: [
      'sync', 'synchronize', 'mirror', 'replicate', 'keep in sync', 'update when',
      'bidirectional', 'two-way', 'propagate changes', 'when added', 'when updated',
      'when new row', 'when record',
    ],
    requiredCategories: [
      {
        category: 'Trigger',
        examples: ['googleSheetsTrigger', 'airtableTrigger', 'notionTrigger', 'webhook'],
        reason: 'Fires when the source system changes',
      },
      {
        category: 'Source Read Node',
        examples: ['googleSheets', 'airtable', 'notion', 'httpRequest'],
        reason: 'Reads the current state from the source',
      },
      {
        category: 'Destination Write Node',
        examples: ['googleSheets', 'airtable', 'notion', 'postgres'],
        reason: 'Writes the synced state to the destination',
      },
    ],
    antiPatterns: [
      'Do not create infinite sync loops — use a change-detection field or deduplication to prevent re-triggering',
      'For bidirectional sync, add a lock/flag field to prevent A→B→A cascades',
    ],
  },
  {
    intent: 'approval_human',
    label: 'Approval / Human-in-the-Loop',
    keywords: [
      'approval', 'approve', 'review', 'human', 'wait for', 'pause', 'checkpoint',
      'sign off', 'confirm', 'decision', 'vote', 'manager review',
    ],
    requiredCategories: [
      {
        category: 'Trigger',
        examples: ['webhook', 'formTrigger'],
        reason: 'Starts the approval request',
      },
      {
        category: 'Wait Node',
        examples: ['wait'],
        reason: 'Pauses the workflow until the human responds — REQUIRED for human-in-the-loop',
      },
      {
        category: 'Conditional',
        examples: ['if', 'switch'],
        reason: 'Routes based on the approval decision (approved vs rejected)',
      },
    ],
    antiPatterns: [
      'Never poll an API in a loop to check for approval — use a Wait node with webhook resume',
      'The Wait node must have a unique webhook path per execution instance',
    ],
  },
  {
    intent: 'scheduled_report',
    label: 'Scheduled Report',
    keywords: [
      'daily', 'weekly', 'monthly', 'every morning', 'every day', 'every week',
      'report', 'summary', 'digest', 'scheduled', 'recurring', 'periodic',
      'at 9am', 'at midnight', 'cron',
    ],
    requiredCategories: [
      {
        category: 'Schedule Trigger',
        examples: ['scheduleTrigger'],
        reason: 'MUST use scheduleTrigger for recurring tasks — not manualTrigger',
      },
      {
        category: 'Data Source',
        examples: ['googleSheets', 'postgres', 'airtable', 'httpRequest'],
        reason: 'What data the report is built from',
      },
      {
        category: 'Delivery Node',
        examples: ['gmail', 'slack', 'emailSend'],
        reason: 'How the report is sent',
      },
    ],
    antiPatterns: [
      'Do not use manualTrigger for scheduled tasks — use scheduleTrigger with the correct cron expression',
      'For complex schedules, prefer cron expressions in scheduleTrigger over multiple separate workflows',
    ],
  },
  {
    intent: 'webhook_handler',
    label: 'Webhook Handler',
    keywords: [
      'webhook', 'receive', 'incoming', 'http post', 'post request', 'listen',
      'endpoint', 'handle request', 'respond to webhook', 'stripe webhook',
      'github webhook', 'form submission',
    ],
    requiredCategories: [
      {
        category: 'Webhook Trigger',
        examples: ['webhook', 'formTrigger', 'stripeTrigger', 'githubTrigger'],
        reason: 'Receives the incoming HTTP request or event',
      },
      {
        category: 'Processing Node',
        examples: ['code', 'set', 'if', 'httpRequest'],
        reason: 'Processes the incoming payload',
      },
      {
        category: 'Response (if synchronous)',
        examples: ['respondToWebhook'],
        reason: 'If the caller expects a response, must include respondToWebhook',
      },
    ],
    antiPatterns: [
      'If the caller expects a response, you MUST include respondToWebhook — otherwise the HTTP request will time out',
      'Do not put heavy processing (LLM calls, slow APIs) in the synchronous response path — respond first, process async',
    ],
  },
]

export function classifyIntent(description: string): IntentMatch | null {
  const lower = description.toLowerCase()

  let bestMatch: { requirements: IntentRequirements; confidence: number } | null = null

  for (const { keywords, ...requirements } of INTENTS) {
    const matchCount = keywords.filter(kw => containsKeyword(lower, kw)).length
    if (matchCount === 0) continue

    const confidence = Math.min(matchCount / 3, 1)  // 3+ keyword matches = max confidence

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = { requirements, confidence }
    }
  }

  return bestMatch
}

export function formatIntentRequirements(match: IntentMatch): string {
  const { requirements, confidence } = match
  if (confidence < 0.2) return ''  // too low confidence — skip injection

  const categoryLines = requirements.requiredCategories
    .map(c => `- ${c.category} (e.g. ${c.examples.slice(0, 2).join(', ')}): ${c.reason}`)
    .join('\n')

  const antiPatternLines = requirements.antiPatterns.map(a => `- ${a}`).join('\n')

  return `## Build Requirements — ${requirements.label}

Your workflow MUST include these component categories:
${categoryLines}

Anti-patterns for this intent (do NOT do these):
${antiPatternLines}`
}
