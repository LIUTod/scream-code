/**
 * Derived predicates over AppState.
 *
 * `streamingPhase !== 'idle'` is checked at ~12 call sites to decide whether an
 * operation may run. The intent is not uniform: some call sites mean "the model
 * is actively streaming" (Ctrl-C / Esc cancellation, history folding), others
 * mean "the turn is busy and the user should wait" (model switch, session
 * switch, /update, /revoke). The latter must also respect `isCompacting`.
 *
 * Routing both intents through these named functions makes the distinction
 * explicit at the call site (`isBusy(state)` vs `isStreaming(state)`) instead
 * of leaving each caller to remember whether to OR in `isCompacting`.
 */
import type { AppState } from '#/tui/types';

/** True when a model turn is in progress (waiting / thinking / composing). */
export function isStreaming(state: AppState): boolean {
  return state.streamingPhase !== 'idle';
}

/** True when the session is busy and should reject state-changing operations.
 *  Covers both active streaming and context compaction. */
export function isBusy(state: AppState): boolean {
  return isStreaming(state) || state.isCompacting;
}
