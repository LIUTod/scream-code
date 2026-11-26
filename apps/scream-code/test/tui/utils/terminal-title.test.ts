import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAILLE_SPINNER_FRAMES } from '#/tui/constant/rendering';
import {
  TITLE_FRAME_MS,
  TerminalTitle,
  titleActivity,
  titlePrefix,
  type TitleState,
} from '#/tui/utils/terminal-title';

function state(patch: Partial<TitleState> = {}): TitleState {
  return {
    streamingPhase: 'idle',
    isCompacting: false,
    pendingUserAction: null,
    sessionTitle: 'fix-auth-bug',
    sessionId: 's1',
    ...patch,
  };
}

describe('titleActivity', () => {
  it('is idle when nothing runs, working while a turn or a compaction runs, waiting while a panel asks', () => {
    expect(titleActivity(state())).toBe('idle');
    expect(titleActivity(state({ streamingPhase: 'thinking' }))).toBe('working');
    expect(titleActivity(state({ isCompacting: true }))).toBe('working');
    expect(titleActivity(state({ streamingPhase: 'tool', pendingUserAction: 'approval' }))).toBe('waiting');
  });
});

describe('titlePrefix', () => {
  it('is empty when idle, so the title stays the plain name', () => {
    expect(titlePrefix(state(), 0)).toBe('');
  });

  it('is a spinner frame while working, advancing with the frame', () => {
    const working = state({ streamingPhase: 'composing' });
    expect(titlePrefix(working, 0)).toBe(`${BRAILLE_SPINNER_FRAMES[0]} `);
    expect(titlePrefix(working, 3)).toBe(`${BRAILLE_SPINNER_FRAMES[3]} `);
    expect(titlePrefix(working, BRAILLE_SPINNER_FRAMES.length)).toBe(`${BRAILLE_SPINNER_FRAMES[0]} `);
  });

  it('stands still when motion is off', () => {
    expect(titlePrefix(state({ streamingPhase: 'composing' }), 5, false)).toBe(`${BRAILLE_SPINNER_FRAMES[0]} `);
  });

  it('says what it waits for while a panel asks', () => {
    expect(titlePrefix(state({ pendingUserAction: 'approval' }), 0)).toMatch(/^◆ .+ · $/);
    const approval = titlePrefix(state({ pendingUserAction: 'approval' }), 0);
    const question = titlePrefix(state({ pendingUserAction: 'question' }), 0);
    expect(approval).not.toBe(question);
  });
});

describe('TerminalTitle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(initial: TitleState) {
    let current = initial;
    const writes: Array<{ title: string | null; prefix: string }> = [];
    const title = new TerminalTitle(
      () => current,
      (text, _id, prefix) => writes.push({ title: text, prefix }),
    );
    return {
      title,
      writes,
      set: (patch: Partial<TitleState>) => {
        current = { ...current, ...patch };
      },
    };
  }

  it('writes the plain name when idle, once', () => {
    const { title, writes } = make(state());
    title.sync();
    title.sync();
    expect(writes).toEqual([{ title: 'fix-auth-bug', prefix: '' }]);
  });

  it('turns the spinner while working and stops when the turn ends', () => {
    const { title, writes, set } = make(state());
    title.sync();
    set({ streamingPhase: 'thinking' });
    title.sync();
    vi.advanceTimersByTime(TITLE_FRAME_MS * 2);
    const spun = writes.map((write) => write.prefix);
    expect(spun).toEqual(['', `${BRAILLE_SPINNER_FRAMES[0]} `, `${BRAILLE_SPINNER_FRAMES[1]} `, `${BRAILLE_SPINNER_FRAMES[2]} `]);

    set({ streamingPhase: 'idle' });
    title.sync();
    expect(writes.at(-1)).toEqual({ title: 'fix-auth-bug', prefix: '' });
    const count = writes.length;
    vi.advanceTimersByTime(TITLE_FRAME_MS * 5);
    expect(writes).toHaveLength(count);
  });

  it('holds still while waiting for the person, with no timer running', () => {
    const { title, writes, set } = make(state({ streamingPhase: 'tool' }));
    title.sync();
    set({ pendingUserAction: 'approval' });
    title.sync();
    const count = writes.length;
    vi.advanceTimersByTime(TITLE_FRAME_MS * 4);
    expect(writes).toHaveLength(count);
    expect(writes.at(-1)?.prefix).toMatch(/^◆ /);
  });

  it('follows a renamed session', () => {
    const { title, writes, set } = make(state());
    title.sync();
    set({ sessionTitle: 'rename-me' });
    title.sync();
    expect(writes.at(-1)).toEqual({ title: 'rename-me', prefix: '' });
  });

  it('leaves the plain name, never a spinner frame, when stopped mid-turn', () => {
    const { title, writes, set } = make(state());
    set({ streamingPhase: 'thinking' });
    title.sync();
    title.stop();
    expect(writes.at(-1)).toEqual({ title: 'fix-auth-bug', prefix: '' });
    const count = writes.length;
    vi.advanceTimersByTime(TITLE_FRAME_MS * 5);
    expect(writes).toHaveLength(count);
  });

  it('writes again on refresh even when nothing changed', () => {
    const { title, writes } = make(state());
    title.sync();
    title.refresh();
    expect(writes).toHaveLength(2);
  });
});
