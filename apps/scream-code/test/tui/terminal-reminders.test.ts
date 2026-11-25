import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AWAY_MS, TerminalReminders, type TerminalReminderEvent } from '#/tui/utils/terminal-reminders';

let unfocusedAt: number | undefined;
const sent: TerminalReminderEvent[] = [];
let reminders: TerminalReminders;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  unfocusedAt = undefined;
  sent.length = 0;
  reminders = new TerminalReminders({
    unfocusedAt: () => unfocusedAt,
    send: async (event) => {
      sent.push(event);
    },
  });
});
afterEach(() => {
  reminders.dispose();
  vi.useRealTimers();
});

const failed: TerminalReminderEvent = { state: 'failed', key: 's:1', title: 't' };

describe('terminal reminders', () => {
  it('stay quiet while the terminal has focus, or on one that never reports it', async () => {
    reminders.note(failed);
    await vi.advanceTimersByTimeAsync(AWAY_MS * 2);
    expect(sent).toEqual([]);
  });

  it('go out at once when the person has been away for a while', async () => {
    unfocusedAt = Date.now() - AWAY_MS - 1_000;
    reminders.note(failed);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([failed]);
  });

  it('wait until the person has been away long enough, and drop it when they came back', async () => {
    unfocusedAt = Date.now() - 60_000;
    reminders.note(failed);
    await vi.advanceTimersByTimeAsync(AWAY_MS - 61_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([failed]);

    sent.length = 0;
    unfocusedAt = Date.now() - 60_000;
    reminders.note({ ...failed, key: 's:2' });
    unfocusedAt = undefined; // back at the terminal
    await vi.advanceTimersByTimeAsync(AWAY_MS);
    expect(sent).toEqual([]);
  });

  it('drop it when the person was back meanwhile, even if gone again', async () => {
    unfocusedAt = Date.now() - 60_000;
    reminders.note(failed);
    await vi.advanceTimersByTimeAsync(30_000);
    unfocusedAt = Date.now(); // came back, looked, left again
    await vi.advanceTimersByTimeAsync(AWAY_MS);
    expect(sent).toEqual([]);
  });

  it('hold a finished turn a few seconds and drop it when another turn started', async () => {
    unfocusedAt = Date.now() - AWAY_MS * 2;
    let idle = true;
    reminders.note({ state: 'done', key: 's:3', stillHolds: () => idle });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([]);
    idle = false; // a goal's next turn began
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
  });
});
