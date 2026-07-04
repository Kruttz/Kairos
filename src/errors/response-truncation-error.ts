import { GenerationError } from './generation-error.js'
import type { AttemptMetadata } from '../telemetry/types.js'

/**
 * Claude's response hit the max_tokens ceiling before completing (stop_reason
 * "max_tokens"). Extends GenerationError so existing consumers catching that
 * class still work; the distinct subclass lets the retry loop identify
 * truncation precisely without matching on message text.
 */
export class ResponseTruncationError extends GenerationError {
  constructor(message: string, cause?: unknown, attemptMetadata?: AttemptMetadata[]) {
    super(message, cause, attemptMetadata)
    this.name = 'ResponseTruncationError'
  }
}
