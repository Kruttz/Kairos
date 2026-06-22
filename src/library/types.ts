import type { N8nWorkflow } from '../types/workflow.js'
import type { CredentialRequirement } from '../types/result.js'

export interface FailurePattern {
  rule: number
  message: string
  occurrences: number
}

export type SourceKind = 'organic' | 'n8n-template' | 'imported'
export type TrustLevel = 'safe' | 'review' | 'blocked'

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
  sourceKind?: SourceKind
  sourceId?: string
  sourceUrl?: string
  trustLevel?: TrustLevel
}

export interface OutcomeData {
  attempts: number
  firstTryPass: boolean
  failedRules: number[]
  mode: 'direct' | 'reference'
}

export interface OutcomeStats {
  totalUses: number
  totalAttempts: number
  firstTryPasses: number
  failedRules: Record<string, number>
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
  sourceKind?: SourceKind
  sourceId?: string
  sourceUrl?: string
  trustLevel?: TrustLevel
  timesRetrieved?: number
  timesUsedAsDirect?: number
  timesUsedAsReference?: number
  outcomeStats?: OutcomeStats
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
  recordOutcome(id: string, outcome: OutcomeData): Promise<void>
  get(id: string): Promise<StoredWorkflow | null>
  list(filters?: LibraryFilters): Promise<StoredWorkflow[]>
}
