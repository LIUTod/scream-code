/**
 * Loop-local error helpers.
 */

import { APIContextOverflowError } from '@scream-code/ltod';

import { ErrorCodes, ScreamError, isScreamError } from '#/errors';

export function createMaxStepsExceededError(maxSteps: number, message?: string): ScreamError {
  return new ScreamError(ErrorCodes.LOOP_MAX_STEPS_EXCEEDED, message ?? `Turn exceeded maxSteps=${maxSteps}`, {
    details: { maxSteps },
  });
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return isScreamError(error) && error.code === ErrorCodes.LOOP_MAX_STEPS_EXCEEDED;
}

/**
 * Context-window overflow, in both shapes it reaches the loop: the ltod error
 * class thrown by provider adapters, and the `ScreamError(CONTEXT_OVERFLOW)`
 * wrap produced by non-ltod adapters. Both need compaction, never a retry, so
 * retry.ts and the turn-level overflow handler must agree on this predicate.
 */
export function isContextOverflowError(error: unknown): boolean {
  return (
    error instanceof APIContextOverflowError ||
    (isScreamError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
  );
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError';
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
