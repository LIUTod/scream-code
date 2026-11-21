/**
 * Send a prompt to a session the host drives and wait until the main agent
 * is done: the last `turn.ended` with no new turn within `settleMs` (a goal
 * starts its next turn right away). Shared by job runs, continued work and
 * inbox follow-ups, so all three read events the same way.
 *
 * Nobody watches these runs, so each has a deadline: past it the turn is
 * cancelled and the run counts as failed, instead of holding a run slot and
 * keeping the machine awake forever.
 */

import type { Event, Session } from '@scream-code/scream-code-sdk';

/** Long enough for a goal driven for hours; short enough that a hang ends the same day. */
export const RUN_DEADLINE_MS = 8 * 60 * 60 * 1000;

export interface RunResult {
  /** The last turn completed normally (not cancelled, failed or cut by a token cap). */
  readonly ok: boolean;
  /** The last turn's answer. */
  readonly text: string;
  readonly timedOut: boolean;
  /**
   * Why the last turn did not complete normally — the `turn.ended` reason, or
   * the token cap — so a run that produced no text can still say what went
   * wrong instead of recording a silent failure. Absent when it completed.
   */
  readonly failedReason?: string | undefined;
}

export function runPromptToEnd(
  session: Session,
  text: string,
  options: { readonly settleMs?: number; readonly deadlineMs?: number } = {},
): Promise<RunResult> {
  const settleMs = options.settleMs ?? 2_000;
  const deadlineMs = options.deadlineMs ?? RUN_DEADLINE_MS;
  return new Promise<RunResult>((resolve, reject) => {
    let running = 0;
    let answer = '';
    let ok = false;
    let failedReason: string | undefined;
    let finished = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult): void => {
      if (finished) return;
      finished = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      clearTimeout(deadline);
      unsubscribe();
      resolve(result);
    };
    const deadline = setTimeout(() => {
      void session.cancel().catch(() => {});
      finish({ ok: false, text: answer, timedOut: true });
    }, deadlineMs);
    deadline.unref?.();
    const unsubscribe = session.onEvent((event: Event) => {
      // Events without an agent id belong to the session's main agent.
      const agentId = (event as { agentId?: string }).agentId;
      if (agentId !== undefined && agentId !== 'main') return;
      if (event.type === 'turn.started') {
        running += 1;
        answer = '';
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        settleTimer = undefined;
      } else if (event.type === 'assistant.delta') {
        answer += (event as { delta?: string }).delta ?? '';
      } else if (event.type === 'turn.ended') {
        running = Math.max(0, running - 1);
        const ended = event as { reason?: string; tokenCapReached?: unknown };
        ok = ended.reason === 'completed' && ended.tokenCapReached === undefined;
        // Kept for the caller: a run with no answer and no reason is a failure
        // nobody can act on, and the next run inherits the same silence.
        failedReason = ok
          ? undefined
          : ended.tokenCapReached === undefined
            ? `the turn ended with reason '${ended.reason ?? 'unknown'}'`
            : 'the turn ended at the token cap';
        if (running === 0) {
          settleTimer = setTimeout(() => {
            finish({
              ok,
              text: answer,
              timedOut: false,
              ...(failedReason === undefined ? {} : { failedReason }),
            });
          }, settleMs);
        }
      }
    });
    session.prompt(text).catch((error: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      unsubscribe();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
