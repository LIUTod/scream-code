import { describe, expect, it } from 'vitest';

import { isPrunableEmptySession } from '#/tui/managers/session-manager';

const now = 1_000_000_000;
const TEN_MIN = 10 * 60 * 1000;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    archived: false,
    lastPrompt: undefined,
    title: undefined,
    updatedAt: now - TEN_MIN, // older than the 5-minute grace window
    ...overrides,
  };
}

describe('isPrunableEmptySession', () => {
  it('prunes an old empty session (no prompt, no title)', () => {
    expect(isPrunableEmptySession(summary(), now)).toBe(true);
  });

  it('keeps a fresh empty session inside the grace window', () => {
    expect(isPrunableEmptySession(summary({ updatedAt: now - 1_000 }), now)).toBe(false);
  });

  it('keeps a session that received a user prompt', () => {
    expect(isPrunableEmptySession(summary({ lastPrompt: 'hello' }), now)).toBe(false);
  });

  it('keeps a session with a title (custom or auto-generated)', () => {
    expect(isPrunableEmptySession(summary({ title: 'my task' }), now)).toBe(false);
    expect(isPrunableEmptySession(summary({ title: '' }), now)).toBe(true);
  });

  it('keeps archived sessions', () => {
    expect(isPrunableEmptySession(summary({ archived: true }), now)).toBe(false);
  });

  it('honours a custom grace window', () => {
    expect(isPrunableEmptySession(summary(), now, 15 * 60 * 1000)).toBe(false);
  });
});
