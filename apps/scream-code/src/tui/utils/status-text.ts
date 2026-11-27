/**
 * What the session is doing, as plain text, longest variant first.
 *
 * One source for the two places that say it: the status row above the editor
 * and, on a terminal too narrow for that row, the footer.
 */
import { t } from '@scream-code/config';

import type { AppState } from '#/tui/types';

export type WorkStateKind = 'working' | 'blocked' | 'trouble';

export interface WorkState {
  readonly kind: WorkStateKind;
  /** Plain text, longest first. */
  readonly variants: readonly string[];
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`;
}

/**
 * Elapsed suffix for states that wait on the person ("等待批准 · 4m"), shown only
 * after a minute: below that a clock reads as noise, while a long silent stall
 * must be visible. Units (m/h) are language-neutral symbols, not i18n.
 */
export function stallSuffix(since: number | null | undefined, now: number = Date.now()): string {
  if (since === null || since === undefined) return '';
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return '';
  if (minutes < 60) return ` · ${String(minutes)}m`;
  return ` · ${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}

type StateInput = Pick<
  AppState,
  'streamingPhase' | 'streamingStartTime' | 'pendingUserAction' | 'pendingUserActionSince' | 'isCompacting'
> &
  Partial<Pick<AppState, 'reconnectAttempt' | 'reconnectMaxAttempts' | 'reconnectUntil'>>;

/**
 * `null` when there is nothing to say (idle). The states where nothing is
 * progressing on the model side outrank the phase table: a compaction runs as
 * `waiting`, a retry keeps the last phase of the failed attempt, and an
 * approval or question panel blocks the turn without any event.
 */
export function workState(a: StateInput, now: number = Date.now()): WorkState | null {
  if (a.pendingUserAction === 'approval') {
    return { kind: 'blocked', variants: [t('status.awaiting_approval') + stallSuffix(a.pendingUserActionSince, now)] };
  }
  if (a.pendingUserAction === 'question') {
    return { kind: 'blocked', variants: [t('status.awaiting_answer') + stallSuffix(a.pendingUserActionSince, now)] };
  }
  if (a.isCompacting) return { kind: 'blocked', variants: [t('status.compacting')] };
  if (a.streamingPhase === 'idle') return null;
  const attempt = a.reconnectAttempt ?? 0;
  if (attempt > 0 && a.reconnectUntil !== undefined) {
    return { kind: 'trouble', variants: [t('status.outage_short')] };
  }
  if (attempt > 0) {
    return {
      kind: 'trouble',
      variants: [
        t('status.reconnecting_short', { attempt: String(attempt), max: String(a.reconnectMaxAttempts ?? 0) }),
      ],
    };
  }
  const label =
    a.streamingPhase === 'tool'
      ? t('status.tool')
      : a.streamingPhase === 'tool-args'
        ? t('status.calling_tool')
        : a.streamingPhase === 'waiting'
          ? t('status.waiting')
          : a.streamingPhase === 'thinking'
            ? t('status.thinking')
            : t('status.composing');
  return { kind: 'working', variants: [`${label} · ${formatElapsed(now - a.streamingStartTime)}`, label] };
}
