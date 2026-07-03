import type { WorkflowPackResult } from './pack-builder.js'
import { scheduleSignature } from '../utils/schedule-intervals.js'

export interface PackValidationIssue {
  type: 'duplicate_name' | 'blocking_assumption' | 'unsafe_activation' | 'schedule_conflict'
  severity: 'error' | 'warning'
  message: string
  workflows?: string[]
}

export function validatePack(pack: WorkflowPackResult): PackValidationIssue[] {
  const issues: PackValidationIssue[] = []

  // Duplicate workflow names
  const names = pack.workflows.map(w => w.name)
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  if (duplicates.size > 0) {
    issues.push({
      type: 'duplicate_name',
      severity: 'error',
      message: `Duplicate workflow names: ${[...duplicates].join(', ')} — n8n may overwrite existing workflows on deploy`,
      workflows: [...duplicates],
    })
  }

  // Unresolved blocking assumptions
  const blocking = pack.assumptions.filter(a => a.type === 'blocking')
  if (blocking.length > 0) {
    const plural = blocking.length === 1 ? 'assumption' : 'assumptions'
    issues.push({
      type: 'blocking_assumption',
      severity: 'error',
      message: `${blocking.length} blocking ${plural} must be resolved before activation:\n  ${blocking.map(a => `• ${a.text}`).join('\n  ')}`,
    })
  }

  // Workflows that failed to deploy
  const failed = pack.workflows.filter(w => w.error)
  for (const wf of failed) {
    issues.push({
      type: 'unsafe_activation',
      severity: 'error',
      message: `Workflow "${wf.name}" failed to deploy: ${wf.error ?? 'unknown error'}`,
      workflows: [wf.name],
    })
  }

  // Schedule conflicts: multiple workflows sharing an identical schedule-trigger config
  const scheduleGroups = new Map<string, string[]>()
  for (const wf of pack.workflows) {
    const intervalSets = wf.scheduleIntervals ?? []
    for (const intervals of intervalSets) {
      const sig = scheduleSignature(intervals)
      if (sig === null) continue
      const names = scheduleGroups.get(sig) ?? []
      if (!names.includes(wf.name)) names.push(wf.name)
      scheduleGroups.set(sig, names)
    }
  }
  for (const names of scheduleGroups.values()) {
    if (names.length < 2) continue
    issues.push({
      type: 'schedule_conflict',
      severity: 'warning',
      message: `Workflows share an identical schedule trigger: ${names.join(', ')} — verify this is intentional (resource contention or API rate limits may collide)`,
      workflows: names,
    })
  }

  return issues
}
