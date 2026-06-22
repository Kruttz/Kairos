import { KairosError } from './base.js'
import type { ValidationIssue } from '../validation/types.js'

export type { ValidationIssue }

export class ValidationError extends KairosError {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[],
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}
