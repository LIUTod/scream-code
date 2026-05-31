import type { ScreamErrorCode } from './codes';

export interface ScreamErrorOptions {
  /** JSON-serializable structured details. */
  readonly details?: Record<string, unknown>;
  /** Original error or value. Local-only; never serialized to the wire. */
  readonly cause?: unknown;
}

/**
 * The single Scream error class.
 *
 * Discrimination is always by `code`. Cross-process consumers receive
 * `ScreamErrorPayload` and must branch on `code` rather than class identity.
 */
export class ScreamError extends Error {
  readonly code: ScreamErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: ScreamErrorCode, message: string, options: ScreamErrorOptions = {}) {
    super(message);
    this.name = 'ScreamError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}
