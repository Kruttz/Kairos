import type { N8nNode, N8nConnections, N8nSettings, Tag } from '../../types/workflow.js'

export interface N8nWorkflowResponse {
  id: string
  name: string
  active: boolean
  nodes: N8nNode[]
  connections: N8nConnections
  settings?: N8nSettings
  tags?: Tag[]
  createdAt: string
  updatedAt: string
  versionId?: string
  meta?: Record<string, unknown>
  pinData?: Record<string, unknown>
  staticData?: unknown
  triggerCount?: number
  shared?: boolean
  isArchived?: boolean
}

export interface N8nWorkflowListResponse {
  data: N8nWorkflowResponse[]
  nextCursor: string | null
}

export interface N8nExecutionResponse {
  id: string
  workflowId: string
  status: 'success' | 'error' | 'waiting' | 'running' | 'canceled'
  startedAt: string
  stoppedAt?: string
  mode: string
  data?: unknown
  workflowData?: unknown
}

export interface N8nExecutionListResponse {
  data: N8nExecutionResponse[]
  nextCursor: string | null
}

export interface N8nTagResponse {
  id: string
  name: string
  createdAt?: string
  updatedAt?: string
}

export interface N8nTagListResponse {
  data: N8nTagResponse[]
  nextCursor: string | null
}

export interface N8nNodeTypeInfo {
  name: string
  displayName: string
  version: number | number[]
  description?: string
  group?: string[]
  credentials?: Array<{ name: string; required?: boolean }>
}

export interface N8nNodeTypeListResponse {
  data: N8nNodeTypeInfo[]
}

export const FORBIDDEN_ON_CREATE = [
  'id',
  'createdAt',
  'updatedAt',
  'versionId',
  'meta',
  'isArchived',
  'activeVersionId',
  'activeVersion',
  'active',
  'pinData',
  'triggerCount',
  'shared',
  'staticData',
  // Confirmed live (2026-07-19, Phase 3 repair-apply's first checkpoint): n8n's PUT/POST
  // /workflows endpoints reject an explicit `tags` field outright -- "request/body/tags is
  // read-only" -- even an empty array. N8nProvider.get() legitimately includes `tags` in its
  // mapped N8nWorkflow (n8n's own GET response always carries it), so any code path that reads
  // a workflow live and later writes it back (repair-apply's snapshot/restore is the first one
  // in this codebase to do that -- replace()'s own live fetch is diff-only, never re-submitted,
  // and freshly-generated workflows never carry a tags field either) would resubmit it and get
  // rejected. Tag management belongs to a separate n8n endpoint this codebase doesn't use.
  'tags',
] as const

export const FORBIDDEN_ON_UPDATE = FORBIDDEN_ON_CREATE.filter((f) => f !== 'id')

export type ForbiddenField = (typeof FORBIDDEN_ON_CREATE)[number]
