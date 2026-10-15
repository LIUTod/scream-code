/**
 * Loop-local error helpers.
 */

import { APIContextOverflowError } from '@scream-code/ltod';

import { ErrorCodes, isScreamError } from '#/errors';

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
