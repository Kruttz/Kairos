import { KairosError } from './base.js'
import type { AttemptMetadata } from '../telemetry/types.js'

export class ResponseParseError extends KairosError {
  constructor(
    message: string,
    cause?: unknown,
    /** Present when the failure surfaced after the retry loop ran — mirrors ValidationError */
    public readonly attemptMetadata?: AttemptMetadata[],
  ) {
    super(message, cause)
    this.name = 'ResponseParseError'
  }
}
