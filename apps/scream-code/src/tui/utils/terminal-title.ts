/**
 * What the terminal's title says about the session.
 *
 * With several tabs open the title is the only thing visible of the ones that
 * are not in front: a plain session name cannot tell a tab that is working
 * from one that has finished, or one that has stopped to ask for approval.
 * So the title carries a prefix while there is something to say:
 *
 *   working   a braille spinner turning, `⠋ fix-auth-bug`
 *   waiting   `◆ 等待批准 · fix-auth-bug` (or the question it asks)
 *   idle      the plain name, as before
 *
 * The spinner turns slowly (a title repaint is not free in every terminal)
 * and stands still when motion is off (`SCREAM_MOTION`).
 */

import { t } from '@scream-code/config';

import { BRAILLE_SPINNER_FRAMES } from '#/tui/constant/rendering';
import type { AppState } from '#/tui/types';

import { motionEnabled } from './motion';
import { setProcessTitle } from './proctitle';

export type TitleActivity = 'idle' | 'working' | 'waiting';

export type TitleState = Pick<AppState, 'streamingPhase' | 'isCompacting' | 'pendingUserAction' | 'sessionTitle' | 'sessionId'>;

/** Between two frames of the title spinner. */
export const TITLE_FRAME_MS = 700;

export function titleActivity(state: Pick<AppState, 'streamingPhase' | 'isCompacting' | 'pendingUserAction'>): TitleActivity {
  if (state.pendingUserAction !== null) return 'waiting';
  if (state.isCompacting || state.streamingPhase !== 'idle') return 'working';
  return 'idle';
}

/** The text in front of the session name for this state and spinner frame. */
export function titlePrefix(
  state: Pick<AppState, 'streamingPhase' | 'isCompacting' | 'pendingUserAction'>,
  frame: number,
  animated: boolean = true,
): string {
  switch (titleActivity(state)) {
    case 'waiting':
      return `◆ ${state.pendingUserAction === 'question' ? t('status.awaiting_answer') : t('status.awaiting_approval')} · `;
    case 'working':
      return `${BRAILLE_SPINNER_FRAMES[animated ? frame % BRAILLE_SPINNER_FRAMES.length : 0]!} `;
    case 'idle':
      return '';
  }
}

/** Keeps the terminal's title in step with the session; owns the spinner's timer. */
export class TerminalTitle {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private written: string | undefined;

  constructor(
    private readonly read: () => TitleState,
    private readonly write: (title: string | null, sessionId: string, prefix: string) => void = setProcessTitle,
  ) {}

  /** The state changed: write the title if it differs, start or stop the spinner. */
  sync(): void {
    const state = this.read();
    const spinning = titleActivity(state) === 'working' && motionEnabled();
    if (spinning && this.timer === undefined) {
      this.timer = setInterval(() => {
        this.frame += 1;
        this.apply();
      }, TITLE_FRAME_MS);
      this.timer.unref();
    } else if (!spinning && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.frame = 0;
    }
    this.apply();
  }

  /** Write the title again even if it did not change (the terminal may have lost it). */
  refresh(): void {
    this.written = undefined;
    this.sync();
  }

  /** Stop the spinner and leave the plain name behind, never a frame of it. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const state = this.read();
    this.write(state.sessionTitle, state.sessionId, '');
    this.written = undefined;
  }

  private apply(): void {
    const state = this.read();
    const prefix = titlePrefix(state, this.frame, motionEnabled());
    const key = `${prefix}\u0000${state.sessionTitle ?? ''}`;
    if (key === this.written) return;
    this.written = key;
    this.write(state.sessionTitle, state.sessionId, prefix);
  }
}
