import { sleep } from '@antfu/utils';
import {
  APIProviderRateLimitError,
  APIStreamFormatError,
  ChatProviderError,
  calculateRateLimitBackoffMs,
} from '@scream-code/ltod';

import { ErrorCodes, isScreamError, isTransientFailure, toScreamErrorPayload } from '#/errors';
import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError, isContextOverflowError } from './errors';
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

// Malformed provider streams (spliced tool-call indices, deltas for a closed
// block) are retryable — one spliced chunk does not make the request bad —
// but a gateway that *always* mangles its tool-call streams never gets
// healthier by re-issuing. Three attempts ride out a transient splice; a
// persistent one fails fast instead of burning the full 10-attempt budget.
export const STREAM_FORMAT_RETRY_ATTEMPTS = 3;

// How many times one request may rotate to another API key of a multi-key
// pool. Rotations are immediate (no backoff, no attempt consumed), so this cap
// is what bounds them: a 5-key pool still stops after 4 hops instead of
// walking a pool whose every key is exhausted.
export const DEFAULT_MAX_KEY_ROTATIONS = 4;

const BASE_DELAY_MS = 500;
// Per-attempt backoff cap (32s). The default 10-attempt ramp reaches the
// cap on the 7th retry, so most of the budget is spent at the cap waiting
// out multi-minute provider overload.
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
// Up to 25% jitter on top of the exponential base to avoid herd retries.
const JITTER_FACTOR = 0.25;

/**
 * Consecutive transient failures (overload, 5xx, network, timeout) of the
 * session model after which a configured fallback model takes over, instead
 * of spending minutes of backoff on a provider that is down.
 */
export const FALLBACK_AFTER_TRANSIENT_FAILURES = 3;

/** The fallback model of a request: resolved only when it is needed. */
export interface ChatFallback {
  /** The fallback model's LLM, or undefined when none is set or it does not resolve. */
  readonly resolve: () => LLM | undefined;
  /** Called once when the request switches, so the rest of the turn stays on it. */
  readonly onSwitch: (llm: LLM) => void;
}

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  /**
   * Cap on immediate key rotations for this request (only providers with a
   * multi-key pool rotate). Defaults to {@link DEFAULT_MAX_KEY_ROTATIONS}.
   */
  readonly maxRotations?: number;
  /**
   * Unattended work (an active goal, a bot-mode run) waits out an outage: once
   * the attempt budget is spent on a failure that clears by itself — a
   * timeout, the network down (a laptop that just woke), an overloaded
   * provider — the request keeps being tried, less and less often, until
   * this long after its first failure. Interactive turns leave it unset and
   * fail after the usual budget, so a person is never kept waiting
   * unknowingly. Esc still cancels the wait.
   */
  readonly outageWaitMs?: number | undefined;
  /** Clock, for tests. */
  readonly now?: (() => number) | undefined;
  readonly log?: Logger | undefined;
  /**
   * A model to switch to when the session model keeps failing: after
   * {@link FALLBACK_AFTER_TRANSIENT_FAILURES} transient failures in a row,
   * on an authentication error or a missing model, on a quota no other key
   * can cover, or once the retry budget is spent. Tried once per request.
   */
  readonly fallback?: ChatFallback | undefined;
}

/** The first wait once the budget is spent, doubled each time up to {@link OUTAGE_MAX_DELAY_MS}. */
const OUTAGE_FIRST_DELAY_MS = 30_000;
const OUTAGE_MAX_DELAY_MS = 5 * 60_000;

/**
 * Whether a request that spent its budget on `error` may wait out an outage.
 * Not a quota the account ran out of, nor a gateway that always breaks its
 * streams: those have short budgets on purpose.
 */
function waitsOutOutage(error: unknown): boolean {
  if (isQuotaExhaustedError(error) || error instanceof APIStreamFormatError) return false;
  return isTransientFailure(toScreamErrorPayload(error));
}

export async function chatWithRetry(input: ChatWithRetryInput): Promise<LLMChatResponse> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;

  if (input.llm.isRetryableError === undefined || maxAttempts <= 1) {
    const effectiveMaxAttempts = Math.max(maxAttempts, 1);
    try {
      return await input.llm.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
    } catch (error) {
      logRequestFailure(input, input.llm, error, 1, effectiveMaxAttempts);
      // No retry budget, but a fallback model still stands in once for a
      // model that is down, out of quota or unusable.
      const fallback = input.fallback;
      const worthSwitching =
        fallback !== undefined &&
        !input.params.signal.aborted &&
        !isAbortError(error) &&
        !isContextOverflowError(error) &&
        (needsAnotherModel(error) || isQuotaExhaustedError(error) || isTransientFailure(toScreamErrorPayload(error)));
      const next = worthSwitching ? fallback.resolve() : undefined;
      if (fallback === undefined || next === undefined || next.modelName === input.llm.modelName) throw error;
      input.log?.warn('llm request: switching to the fallback model', {
        from: input.llm.modelName,
        to: next.modelName,
        reason: 'no retry budget',
      });
      fallback.onSwitch(next);
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: 1,
        nextAttempt: 1,
        maxAttempts: effectiveMaxAttempts,
        delayMs: 0,
        fallbackModel: next.modelName,
        ...retryErrorFields(error),
      });
      try {
        return await next.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
      } catch (fallbackError) {
        logRequestFailure(input, next, fallbackError, 1, effectiveMaxAttempts);
        throw fallbackError;
      }
    }
  }

  const delays = retryBackoffDelays(maxAttempts);
  const maxRotations = input.maxRotations ?? DEFAULT_MAX_KEY_ROTATIONS;
  // Rotations are tracked separately from `attempt`: they do not consume the
  // generic attempt budget (no backoff is paid for them), so a quota error on
  // a multi-key pool gets `attemptLimit` real backoffs AND up to
  // `maxRotations` immediate key hops.
  let rotations = 0;
  const now = input.now ?? Date.now;
  let firstFailureAt: number | undefined;
  let outageWaits = 0;
  // The model this request is sent to: the session model, or the fallback
  // once it has taken over.
  let llm = input.llm;
  let fallbackTried = false;
  let transientStreak = 0;

  for (let attempt = 1; ; attempt += 1) {
    /**
     * Hand the request to the fallback model, once. Returns false when there is
     * none (or it is the same model), so the caller goes on as before. On a
     * switch the budgets start over for the new model and the next attempt is 1.
     */
    // oxlint-disable-next-line no-loop-func -- per-attempt helper that resets this request's retry state on a switch.
    const switchToFallback = (error: unknown, reason: string): boolean => {
      // A cancelled request is not a failing model.
      if (fallbackTried || input.fallback === undefined || input.params.signal.aborted || isAbortError(error)) return false;
      fallbackTried = true;
      const next = input.fallback.resolve();
      if (next === undefined || next.modelName === llm.modelName) return false;
      input.params.signal.throwIfAborted();
      logRequestFailure(input, llm, error, attempt, maxAttempts);
      input.log?.warn('llm request: switching to the fallback model', {
        from: llm.modelName,
        to: next.modelName,
        reason,
      });
      llm = next;
      input.fallback.onSwitch(next);
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: attempt,
        nextAttempt: 1,
        maxAttempts,
        delayMs: 0,
        fallbackModel: next.modelName,
        ...retryErrorFields(error),
      });
      rotations = 0;
      firstFailureAt = undefined;
      outageWaits = 0;
      transientStreak = 0;
      attempt = 0;
      return true;
    };

    try {
      return await llm.chat(paramsForAttempt(input, attempt, maxAttempts));
    } catch (error) {
      // Overflow errors can't be fixed by retrying — they need compaction.
      // Fail fast so the turn-level handler can trigger emergency compaction
      // without wasting retry attempts on the same overflow. Both shapes are
      // recognized: the ltod error class and the ScreamError(CONTEXT_OVERFLOW)
      // wrap some non-ltod provider adapters produce.
      if (isContextOverflowError(error)) {
        logRequestFailure(input, llm, error, attempt, maxAttempts);
        throw error;
      }

      // Quota-style 429s are retried too — but with a smaller budget. A
      // provider phrase like "allocated quota exceeded" frequently means a
      // per-minute or dynamic quota window that clears within a minute, and
      // failing instantly left subagents dead on the first 429. A genuinely
      // exhausted account still fails after a few short 30s backoffs.
      const attemptLimit = computeAttemptLimit(error, maxAttempts);

      if (llm.isRetryableError === undefined || !llm.isRetryableError(error)) {
        // A bad key or a model that does not exist fails the same way on every
        // retry; another model may well work.
        if (needsAnotherModel(error) && switchToFallback(error, 'unusable model')) continue;
        logRequestFailure(input, llm, error, attempt, attemptLimit);
        throw error;
      }

      // A quota rejection is per-credential, so a multi-key pool tries the
      // next key immediately instead of paying a 30s backoff on the key that
      // just failed. The provider cools the failed key down itself; here we
      // only decide to re-issue, and refund the attempt so the rotation does
      // not shorten the generic budget.
      if (
        isQuotaExhaustedError(error) &&
        rotations < maxRotations &&
        llm.rotateAuth?.() === true
      ) {
        rotations += 1;
        input.params.signal.throwIfAborted();
        input.dispatchEvent({
          type: 'step.retrying',
          turnId: input.turnId,
          step: input.currentStep,
          stepUuid: input.stepUuid,
          failedAttempt: attempt,
          // The rotation refunds the attempt below, so the retry re-runs the
          // SAME attempt number; the event must not claim the next one.
          nextAttempt: attempt,
          maxAttempts: attemptLimit,
          delayMs: 0,
          ...retryErrorFields(error),
        });
        attempt -= 1;
        continue;
      }
      // A quota no other key covers: the account is out, for this model at least.
      if (isQuotaExhaustedError(error) && switchToFallback(error, 'quota exhausted')) continue;
      // A provider that keeps failing is likely down for a while.
      transientStreak = isTransientFailure(toScreamErrorPayload(error)) ? transientStreak + 1 : 0;
      if (transientStreak >= FALLBACK_AFTER_TRANSIENT_FAILURES && switchToFallback(error, 'repeated failures')) {
        continue;
      }

      firstFailureAt ??= now();
      if (attempt >= attemptLimit) {
        if (switchToFallback(error, 'retry budget spent')) continue;
        const outageUntil =
          input.outageWaitMs === undefined || input.outageWaitMs <= 0 ? undefined : firstFailureAt + input.outageWaitMs;
        if (outageUntil !== undefined && waitsOutOutage(error) && now() < outageUntil) {
          // Past the usual budget: an outage, waited out at a slower pace.
          const delayMs = Math.min(
            OUTAGE_MAX_DELAY_MS,
            OUTAGE_FIRST_DELAY_MS * 2 ** outageWaits,
            Math.max(1_000, outageUntil - now()),
          );
          outageWaits += 1;
          input.params.signal.throwIfAborted();
          input.log?.warn('llm request: waiting out an outage', {
            attempt,
            delayMs,
            outageUntil,
            error: error instanceof Error ? error.message : String(error),
          });
          input.dispatchEvent({
            type: 'step.retrying',
            turnId: input.turnId,
            step: input.currentStep,
            stepUuid: input.stepUuid,
            failedAttempt: attempt,
            nextAttempt: attempt + 1,
            maxAttempts: attemptLimit,
            delayMs,
            outageUntil,
            ...retryErrorFields(error),
          });
          await sleepForRetry(delayMs, input.params.signal);
          continue;
        }
        logRequestFailure(input, llm, error, attempt, attemptLimit);
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

/** Attempt budget for this failure class: quota and stream-format errors get fewer. */
function computeAttemptLimit(error: unknown, maxAttempts: number): number {
  if (isQuotaExhaustedError(error)) return Math.min(QUOTA_RETRY_ATTEMPTS, maxAttempts);
  if (error instanceof APIStreamFormatError) return Math.min(STREAM_FORMAT_RETRY_ATTEMPTS, maxAttempts);
  return maxAttempts;
}

/** A 429 whose reason marks the account/key quota as exhausted, not a burst. */
function isQuotaExhaustedError(error: unknown): boolean {
  return error instanceof APIProviderRateLimitError && error.reason === 'QUOTA_EXHAUSTED';
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

/** An error no retry of the same model can fix, but another model might: a rejected key, a model that is gone. */
function needsAnotherModel(error: unknown): boolean {
  const payload = toScreamErrorPayload(error);
  if (payload.code === ErrorCodes.PROVIDER_AUTH_ERROR) return true;
  return payload.code === ErrorCodes.PROVIDER_API_ERROR && payload.details?.['statusCode'] === 404;
}

function logRequestFailure(
  input: ChatWithRetryInput,
  llm: LLM,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: llm.modelName,
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
  readonly errorCode?: string;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
    errorCode: retryErrorCode(error),
  };
}

/**
 * Error-protocol classification of a failed attempt, for consumers that label
 * the retry (e.g. the TUI's reconnect status bar string).
 *
 * Only errors the protocol actually classifies get a code: an unrecognized
 * error is omitted rather than reported as `internal`, so consumers can tell
 * "unclassified" apart from "classified as an internal fault" and keep their
 * own fallback wording for the former.
 */
function retryErrorCode(error: unknown): string | undefined {
  if (isScreamError(error)) return error.code;
  // Every ltod provider error (status / connection / timeout / rate limit) is
  // a ChatProviderError; the payload mapper holds the subclass precedence, so
  // this one check covers them all without duplicating that ordering here.
  return error instanceof ChatProviderError ? toScreamErrorPayload(error).code : undefined;
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
