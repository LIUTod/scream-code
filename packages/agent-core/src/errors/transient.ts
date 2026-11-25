import { ErrorCodes } from './codes';
import type { ScreamErrorPayload } from './serialize';

/**
 * Failures that say nothing about the work and usually clear by themselves:
 * the provider timed out, the network was down (a laptop just woke, Wi-Fi not
 * back yet), the provider was overloaded or broke a stream. Unattended work
 * waits these out and tries again instead of recording a failure. Anything
 * else — a rejected key, a bad request, a refused tool — needs a person.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.PROVIDER_TIMEOUT,
  ErrorCodes.PROVIDER_CONNECTION_ERROR,
  ErrorCodes.PROVIDER_RATE_LIMIT,
  ErrorCodes.PROVIDER_STREAM_ERROR,
]);

/** Whether `error` (a turn's `turn.ended` error) is worth waiting out. */
export function isTransientFailure(error: Pick<ScreamErrorPayload, 'code' | 'details'> | undefined): boolean {
  if (error === undefined) return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  // A provider's own outage (5xx) clears like an overload does; a 4xx is the
  // request's fault and will fail the same way again.
  if (error.code === ErrorCodes.PROVIDER_API_ERROR) {
    const status = error.details?.['statusCode'];
    return typeof status === 'number' && status >= 500;
  }
  return false;
}
