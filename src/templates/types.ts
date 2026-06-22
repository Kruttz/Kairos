export interface TemplateSearchResponse {
  totalWorkflows: number
  workflows: TemplateListItem[]
}

export interface TemplateListItem {
  id: number
  name: string
  description: string
  totalViews: number
  createdAt: string
  price?: number
  nodes: Array<{ name: string }>
}

export interface TemplateDetailResponse {
  workflow: {
    id: number
    name: string
    description: string
    workflow: TemplateWorkflowJson
  }
}

export interface TemplateWorkflowJson {
  nodes: Array<{
    id: string
    name: string
    type: string
    typeVersion: number
    position: [number, number]
    parameters: Record<string, unknown>
    credentials?: Record<string, unknown>
  }>
  connections: Record<string, unknown>
  settings?: Record<string, unknown>
  meta?: Record<string, unknown>
  pinData?: Record<string, unknown>
}

export interface SyncProgress {
  total: number
  processed: number
  saved: number
  skippedPaid: number
  skippedDuplicate: number
  blocked: number
  reviewed: number
}
