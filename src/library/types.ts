import type { N8nWorkflow } from '../types/workflow.js'
import type { CredentialRequirement } from '../types/result.js'

export interface FailurePattern {
  rule: number
  message: string
  occurrences: number
}

export interface WorkflowMetadataInput {
  description: string
  tags?: string[]
  platform?: string
  failurePatterns?: Array<{ rule: number; message: string }>
  sourceWorkflowIds?: string[]
  generationMode?: 'direct' | 'reference' | 'scratch'
  topMatchScore?: number
  generationAttempts?: number
  credentialsNeeded?: CredentialRequirement[]
}

export interface StoredWorkflow {
  id: string
  workflow: N8nWorkflow
  description: string
  tags: string[]
  platform: string
  deployCount: number
  createdAt: string
  lastDeployedAt?: string
  failurePatterns?: FailurePattern[]
  sourceWorkflowIds?: string[]
  generationMode?: 'direct' | 'reference' | 'scratch'
  topMatchScore?: number
  generationAttempts?: number
  credentialsNeeded?: CredentialRequirement[]
}

export interface WorkflowMatch {
  workflow: StoredWorkflow
  score: number
  mode: 'direct' | 'reference' | 'scratch'
}

export interface SearchOptions {
  limit?: number
  platform?: string
}

export interface LibraryFilters {
  platform?: string
  tags?: string[]
}

export interface IWorkflowLibrary {
  initialize(): Promise<void>
  search(description: string, options?: SearchOptions): Promise<WorkflowMatch[]>
  save(workflow: N8nWorkflow, metadata: WorkflowMetadataInput): Promise<string>
  recordDeployment(id: string): Promise<void>
  get(id: string): Promise<StoredWorkflow | null>
  list(filters?: LibraryFilters): Promise<StoredWorkflow[]>
}
