import { sleep } from '@antfu/utils';
import {
  APIContextOverflowError,
  APIProviderRateLimitError,
  calculateRateLimitBackoffMs,
} from '@scream-code/ltod';

import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

// Default retry budget per step: 10 attempts (9 retries). With the
// exponential ramp below the backoff climbs 0.5s, 1s, 2s … up to the 32s
// cap, giving roughly 2–3 minutes of total wait - enough to ride out a
// typical provider overload window (sustained 429s) instead of surfacing
// the error after a couple of quick retries.
export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

// Quota-style 429s get fewer attempts than generic retries (3 total):
// providers phrase transient per-minute quota windows as "quota exceeded",
// and those clear within ~1 minute, but a genuinely exhausted account must
// not burn the full 10-attempt budget (≈2-3 min) waiting for nothing.
// With the 30s quota backoff this totals ≈1 minute before surfacing.
export const QUOTA_RETRY_ATTEMPTS = 3;

const BASE_DELAY_MS = 500;
// Per-attempt backoff cap (32s). The default 10-attempt ramp reaches the
// cap on the 7th retry, so most of the budget is spent at the cap waiting
// out multi-minute provider overload.
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
// Up to 25% jitter on top of the exponential base to avoid herd retries.
const JITTER_FACTOR = 0.25;

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  readonly log?: Logger | undefined;
}

export async function chatWithRetry(input: ChatWithRetryInput): Promise<LLMChatResponse> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;

  if (input.llm.isRetryableError === undefined || maxAttempts <= 1) {
    const effectiveMaxAttempts = Math.max(maxAttempts, 1);
    try {
      return await input.llm.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
    } catch (error) {
      logRequestFailure(input, error, 1, effectiveMaxAttempts);
      throw error;
    }
  }

  const delays = retryBackoffDelays(maxAttempts);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await input.llm.chat(paramsForAttempt(input, attempt, maxAttempts));
    } catch (error) {
      // Overflow errors can't be fixed by retrying — they need compaction.
      // Fail fast so the turn-level handler can trigger emergency compaction
      // without wasting retry attempts on the same overflow.
      // NOTE: only instanceof APIContextOverflowError is checked here.
      // If a provider wraps the overflow as ScreamError(CONTEXT_OVERFLOW),
      // it will be retried. This is an edge case for non-ltod provider adapters.
      if (error instanceof APIContextOverflowError) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      // Quota-style 429s are retried too — but with a smaller budget. A
      // provider phrase like "allocated quota exceeded" frequently means a
      // per-minute or dynamic quota window that clears within a minute, and
      // failing instantly left subagents dead on the first 429. A genuinely
      // exhausted account still fails after a few short 30s backoffs.
      const attemptLimit =
        error instanceof APIProviderRateLimitError && error.reason === 'QUOTA_EXHAUSTED'
          ? Math.min(QUOTA_RETRY_ATTEMPTS, maxAttempts)
          : maxAttempts;

      if (attempt >= attemptLimit || !input.llm.isRetryableError(error)) {
        logRequestFailure(input, error, attempt, attemptLimit);
        throw error;
      }

      // Rate-limited requests get reason-aware backoff instead of the default
      // exponential 300ms-5s. A 529 (MODEL_CAPACITY) needs 45-75s; a per-minute
      // rate limit needs 30s; the default exponential stays for network/timeout.
      const delayMs = computeDelayMs(error, delays, attempt);
      input.params.signal.throwIfAborted();
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts: attemptLimit,
        delayMs,
        ...retryErrorFields(error),
      });
      await sleepForRetry(delayMs, input.params.signal);
    }
  }
}

export function computeDelayMs(error: unknown, delays: number[], attempt: number): number {
  // A server `Retry-After` (carried on the error) overrides the computed
  // backoff. The chosen delay is what gets reported on the
  // `step.retrying` event via `delayMs` either way.
  const retryAfter = readRetryAfterMs(error);
  if (retryAfter !== null) return retryAfter;
  if (error instanceof APIProviderRateLimitError) {
    return calculateRateLimitBackoffMs(error.reason);
  }
  return delays[attempt - 1] ?? 0;
}

/**
 * Server-requested backoff carried on an `APIStatusError` (parsed from
 * the `Retry-After` response header). When present and positive it
 * overrides the computed backoff - a server `Retry-After` directive
 * takes precedence over the local exponential delay.
 */
function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && value > 0 ? value : null;
}

function logRequestFailure(
  input: ChatWithRetryInput,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: input.llm.modelName,
    ...retryErrorFields(error),
  });
}

function paramsForAttempt(
  input: ChatWithRetryInput,
  attempt: number,
  maxAttempts: number,
): LLMChatParams {
  return {
    ...input.params,
    requestLogContext: {
      turnId: input.turnId,
      step: input.currentStep,
      stepUuid: input.stepUuid,
      attempt,
      maxAttempts,
    },
  };
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  // For attempt (1-based) the base delay is min(500ms * 2^(attempt-1), 32s),
  // plus up to 25% jitter. Index i here is 0-based, so attempt = i + 1.
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, i), MAX_DELAY_MS);
    delays.push(base + Math.random() * JITTER_FACTOR * base);
  }
  return delays;
}

export async function sleepForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await abortable(sleep(delayMs), signal);
}

interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
