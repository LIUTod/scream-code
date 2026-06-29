// Streaming-phase state machine — the single source of truth for the work
// phase shown in the footer and activity pane.
//
// Phases:
//   idle      — no active turn (footer shows "○ 空闲")
//   waiting   — turn started, awaiting first token (footer "等待响应")
//   thinking  — model emitting reasoning tokens (footer "思考中")
//   composing — model emitting assistant text (footer "输出中")
//   tool      — tool call executing (footer "执行中")
//
// Transitions are directed. The graph below is intentionally permissive —
// any non-self transition is allowed — because real event streams can skip
// `turn.started` or interleave thinking/tool/assistant deltas in any order.
// `canTransitionTo` therefore reduces to `from !== to` but keeps a named
// call site so future tightening (e.g. dev-mode warnings for unexpected
// edges) has a single place to land.

import type { AppState } from '#/tui/types';

export type StreamingPhase = AppState['streamingPhase'];

export const STREAMING_PHASES: readonly StreamingPhase[] = [
  'idle',
  'waiting',
  'thinking',
  'composing',
  'tool',
] as const;

/**
 * Returns true when transitioning `from → to` is a valid directed edge.
 * Self-loops are no-ops and return false so callers can use this as an
 * idempotency guard:
 *   if (canTransitionTo(state.appState.streamingPhase, 'thinking')) {
 *     setAppState({ streamingPhase: 'thinking' });
 *   }
 */
export function canTransitionTo(from: StreamingPhase, to: StreamingPhase): boolean {
  return from !== to;
}
