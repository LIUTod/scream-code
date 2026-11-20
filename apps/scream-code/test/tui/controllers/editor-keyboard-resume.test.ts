/**
 * Covers: Ctrl+R on a new page resumes the conversation the welcome names,
 * and leaves the key to the editor everywhere else.
 */

import { describe, expect, it, vi } from 'vitest';

import { t } from '@scream-code/config';

import { EditorKeyboardController } from '#/tui/controllers/editor-keyboard';

function createHarness(opts: {
  transcript?: number;
  editorText?: string;
  typed?: boolean;
  recent?: { id: string; title?: string }[];
}) {
  const editor: {
    onCtrlR?: () => boolean;
    getText: () => string;
    setText: (text: string) => void;
    hasFirstInputFired: () => boolean;
  } = {
    getText: () => opts.editorText ?? '',
    setText: () => {},
    hasFirstInputFired: () => opts.typed ?? false,
  };
  const resumeSession = vi.fn().mockResolvedValue({ switched: true });
  const host = {
    state: {
      editor,
      transcriptEntries: Array.from({ length: opts.transcript ?? 0 }),
      appState: {
        sessionId: 'now',
        recentSessions: (opts.recent ?? [{ id: 'last', title: 'Fix the title' }]).map((s) => ({ ...s, updatedAt: 1 })),
        streamingPhase: 'idle',
      },
      ui: { requestRender: vi.fn() },
    },
    resumeSession,
    showError: vi.fn(),
    showStatus: vi.fn(),
  };
  new EditorKeyboardController(host as never, {} as never).install();
  return { press: () => editor.onCtrlR?.() ?? false, resumeSession, showStatus: host.showStatus };
}

describe('EditorKeyboardController — Ctrl+R resumes the last conversation', () => {
  it('resumes it at the very start of the run', () => {
    const h = createHarness({});
    expect(h.press()).toBe(true);
    expect(h.resumeSession).toHaveBeenCalledWith('last');
  });

  it('shows a "resuming" status immediately, before the async resume settles', () => {
    // A large session replays for a few seconds; the keypress must feel seen
    // right away, not after the replay. The status line goes up synchronously
    // in the key handler, ahead of the async resumeSession promise.
    const h = createHarness({});
    h.press();
    expect(h.showStatus).toHaveBeenCalledWith(t('session.resuming'));
    // …and the immediate status precedes the async resume work.
    expect(h.showStatus.mock.invocationCallOrder[0]).toBeLessThan(h.resumeSession.mock.invocationCallOrder[0] ?? 0);
  });

  it('leaves the key alone after the start, mid-chat, or with nothing to resume', () => {
    for (const opts of [
      // Mid-chat.
      { transcript: 2 },
      // Anything typed since start, even if the box is empty again (or /new).
      { typed: true },
      { editorText: 'half a thought' },
      { recent: [] },
      { recent: [{ id: 'now', title: 'this one' }] },
      { recent: [{ id: 'old', title: 'New Session' }] },
    ]) {
      const h = createHarness(opts);
      expect(h.press(), JSON.stringify(opts)).toBe(false);
      expect(h.resumeSession).not.toHaveBeenCalled();
    }
  });
});
