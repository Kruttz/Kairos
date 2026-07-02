import type { N8nWorkflow } from '../types/workflow.js'
import type { CredentialRequirement } from '../types/result.js'

/**
 * Function that computes a semantic embedding vector for a text string.
 * Provide this to FileLibrary to enable hybrid (semantic + BM25) retrieval.
 * If not provided, retrieval falls back to BM25-only (existing behavior).
 *
 * Example usage with OpenAI:
 *   const embedFn = async (text) => {
 *     const resp = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
 *     return resp.data[0].embedding
 *   }
 */
export type EmbeddingFn = (text: string) => Promise<number[]>

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
  n8nWorkflowId?: string  // set when saving a workflow already deployed to n8n
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

export interface ExecutionTrace {
  recordedAt: string
  executionId: string
  status: 'success' | 'error' | 'waiting' | 'running' | 'canceled'
  durationMs: number | null
  executedNodes: string[]
  erroredNodes: Array<{ name: string; errorType: string }>
  itemCount: number
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
  n8nWorkflowId?: string  // n8n instance workflowId if this was deployed
  executionTraces?: ExecutionTrace[]
  runtimeReliabilityScore?: number  // 0-1, computed from execution trace history
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
  recordDeployment(id: string, n8nWorkflowId?: string): Promise<void>
  recordOutcome(id: string, outcome: OutcomeData): Promise<void>
  get(id: string): Promise<StoredWorkflow | null>
  list(filters?: LibraryFilters): Promise<StoredWorkflow[]>
}
