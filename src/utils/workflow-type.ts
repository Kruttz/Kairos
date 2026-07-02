import { containsKeyword } from './keyword-match.js'

// First match wins — more specific service names come before generic terms.
const TYPE_KEYWORDS: Array<[string, string]> = [
  ['gmail', 'email'],
  ['imap', 'email'],
  ['smtp', 'email'],
  ['email', 'email'],
  ['emails', 'email'],
  ['slack', 'slack'],
  ['telegram', 'messaging'],
  ['discord', 'messaging'],
  ['sms', 'messaging'],
  ['twilio', 'messaging'],
  ['webhook', 'webhook'],
  ['google sheets', 'data'],
  ['spreadsheet', 'data'],
  ['airtable', 'data'],
  ['notion', 'data'],
  ['github', 'devops'],
  ['gitlab', 'devops'],
  ['schedule', 'schedule'],
  ['cron', 'schedule'],
  ['daily', 'schedule'],
  ['weekly', 'schedule'],
  ['hourly', 'schedule'],
  ['every day', 'schedule'],
  ['every hour', 'schedule'],
  ['every morning', 'schedule'],
  ['postgres', 'database'],
  ['mysql', 'database'],
  ['supabase', 'database'],
  ['redis', 'database'],
  ['database', 'database'],
  ['llm', 'ai'],
  ['gpt', 'ai'],
  ['claude', 'ai'],
  ['agent', 'ai'],
  ['langchain', 'ai'],
  ['ai', 'ai'],
  ['http request', 'api'],
  ['rest api', 'api'],
  ['api', 'api'],
]

export function inferWorkflowType(description: string): string | null {
  const lower = description.toLowerCase()
  for (const [keyword, type] of TYPE_KEYWORDS) {
    if (containsKeyword(lower, keyword)) return type
  }
  return null
}
