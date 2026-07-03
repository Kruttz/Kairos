import { KairosError } from './base.js'

/**
 * Thrown when a workflow was successfully created in n8n but a later build step
 * (currently: activation) failed. Carries workflowId so callers can decide whether
 * to leave the orphaned workflow, activate it manually later, or delete it
 * themselves — Kairos never deletes it automatically.
 */
export class DeployActivationError extends KairosError {
  constructor(message: string, public readonly workflowId: string, cause?: unknown) {
    super(message, cause)
    this.name = 'DeployActivationError'
  }
}
