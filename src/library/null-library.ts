import type { IWorkflowLibrary, WorkflowMatch, StoredWorkflow, WorkflowMetadataInput, LibraryFilters, SearchOptions, OutcomeData, ExecutionTrace, SourceKind } from './types.js'
import type { N8nWorkflow } from '../types/workflow.js'
import { generateUUID } from '../utils/uuid.js'

export class NullLibrary implements IWorkflowLibrary {
  async initialize(): Promise<void> {}

  async search(_description: string, _options?: SearchOptions): Promise<WorkflowMatch[]> {
    return []
  }

  async save(_workflow: N8nWorkflow, _metadata: WorkflowMetadataInput): Promise<string> {
    return generateUUID()
  }

  async recordDeployment(_id: string): Promise<void> {}

  async recordOutcome(_id: string, _outcome: OutcomeData): Promise<void> {}

  async recordTrace(_id: string, _trace: ExecutionTrace): Promise<void> {}

  async pruneBySource(_sourceKind: SourceKind): Promise<{ removed: string[] }> {
    return { removed: [] }
  }

  async get(_id: string): Promise<StoredWorkflow | null> {
    return null
  }

  async list(_filters?: LibraryFilters): Promise<StoredWorkflow[]> {
    return []
  }
}
