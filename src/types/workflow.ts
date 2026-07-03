export interface Tag {
  id: string
  name: string
}

export interface N8nCredentialReference {
  id: string
  name: string
}

export type ConnectionPort = {
  node: string
  type: string
  index: number
}

export type ConnectionPortList = ConnectionPort[]

export interface N8nConnections {
  [nodeName: string]: {
    main?: ConnectionPortList[]
    ai_languageModel?: ConnectionPortList[]
    ai_memory?: ConnectionPortList[]
    ai_tool?: ConnectionPortList[]
    ai_document?: ConnectionPortList[]
    ai_embedding?: ConnectionPortList[]
    ai_vectorStore?: ConnectionPortList[]
    ai_retriever?: ConnectionPortList[]
    ai_outputParser?: ConnectionPortList[]
    ai_textSplitter?: ConnectionPortList[]
    [key: string]: ConnectionPortList[] | undefined
  }
}

export interface N8nNode {
  id: string
  name: string
  type: string
  typeVersion: number
  position: [number, number]
  parameters: Record<string, unknown>
  credentials?: Record<string, N8nCredentialReference>
  disabled?: boolean
  notes?: string
  notesInFlow?: boolean
  continueOnFail?: boolean
  onError?: 'continueRegularOutput' | 'continueErrorOutput' | 'stopWorkflow'
  retryOnFail?: boolean
  maxTries?: number
  waitBetweenTries?: number
}

export interface N8nSettings {
  executionOrder?: 'v0' | 'v1'
  saveManualExecutions?: boolean
  callerPolicy?: string
  errorWorkflow?: string
  timezone?: string
  [key: string]: unknown
}

export interface N8nWorkflow {
  name: string
  nodes: N8nNode[]
  connections: N8nConnections
  settings?: N8nSettings
  tags?: Tag[]
}
