export type MemorySource = 'user' | 'build' | 'system'

/**
 * preference = how this client wants things done; history = what was built/changed;
 * incident = escalations/failures/drift events; reference = external facts (sheet IDs,
 * channel names, contacts).
 */
export type MemoryType = 'preference' | 'history' | 'incident' | 'reference'

export interface MemoryNode {
  id: string
  createdAt: string
  updatedAt: string
  source: MemorySource
  type: MemoryType
  confidence: number
  tags: string[]
  description: string
  body: string
}

export interface RememberInput {
  type: MemoryType
  description: string
  body: string
  source?: MemorySource
  confidence?: number
  tags?: string[]
}

export interface MemoryIndexEntry {
  id: string
  path: string
  type: MemoryType
  description: string
  createdAt: string
  updatedAt: string
}
