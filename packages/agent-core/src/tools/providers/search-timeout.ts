/**
 * Hard timeout for outbound web-search requests (omp pattern).
 *
 * A stalled TCP/TLS connection can keep an undici fetch pending for minutes;
 * composing the caller's signal with a fixed ceiling guarantees the request
 * settles. Fires as a `TimeoutError` DOMException, which the tool layer maps
 * to "Search timed out".
 */

/**
 * Ceiling for a single provider request. HTML SERPs respond in <5s when
 * healthy; 15s keeps a stalled TCP/TLS handshake from eating the whole
 * fallback-chain budget. (Only the three search providers use this.)
 */
export const SEARCH_HARD_TIMEOUT_MS = 15_000;

export function withHardTimeout(
  signal: AbortSignal | undefined,
  ms: number = SEARCH_HARD_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
}
