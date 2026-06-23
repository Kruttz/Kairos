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
] as const

export const FORBIDDEN_ON_UPDATE = FORBIDDEN_ON_CREATE.filter((f) => f !== 'id')

export type ForbiddenField = (typeof FORBIDDEN_ON_CREATE)[number]
