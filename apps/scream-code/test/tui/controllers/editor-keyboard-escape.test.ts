/**
 * Covers: Esc queue interception in EditorKeyboardController.
 *
 * A non-empty message queue intercepts Esc: the queued texts are restored
 * to the editor and the running turn is NOT aborted. The global Esc
 * interrupt (session.cancel) only fires when the queue is empty.
 */

import { describe, expect, it, vi } from 'vitest';

import { EditorKeyboardController } from '#/tui/controllers/editor-keyboard';
import type { Session } from '@scream-code/scream-code-sdk';

interface MockEditor {
  onEscape?: () => void;
  getText: () => string;
  setText: (text: string) => void;
}

function createHarness(opts: {
  queued: string[];
  editorText?: string;
  streaming: boolean;
}) {
  let text = opts.editorText ?? '';
  const editor: MockEditor = {
    getText: () => text,
    setText: (t: string) => {
      text = t;
    },
  };
  const cancel = vi.fn().mockResolvedValue(undefined);
  const host = {
    state: {
      editor,
      activeDialog: undefined,
      queuedMessages: opts.queued.map((t) => ({ text: t, agentId: 'main' })),
      appState: {
        streamingPhase: opts.streaming ? 'composing' : 'idle',
        isCompacting: false,
        model: 'mock',
      },
      ui: { requestRender: vi.fn() },
    },
    session: { cancel } as unknown as Session,
    clearQueuedMessages: vi.fn(function (this: typeof host) {
      this.state.queuedMessages = [];
    }),
    updateQueueDisplay: vi.fn(),
    hideSessionPicker: vi.fn(),
    hideMemoryPicker: vi.fn(),
    hideHelpPanel: vi.fn(),
    restoreEditor: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    setAppState: vi.fn(),
    updateEditorBorderHighlight: vi.fn(),
  };

  const controller = new EditorKeyboardController(host as never, {} as never);
  // install() wires editor.onEscape (plus other handlers we don't touch).
  controller.install();
  return { host, editor, cancel, escape: () => editor.onEscape?.(), getText: () => text };
}

describe('EditorKeyboardController — Esc queue interception', () => {
  it('restores queued texts to the editor and does not abort the turn', () => {
    const h = createHarness({ queued: ['first queued', 'second queued'], streaming: true });

    h.escape();

    expect(h.getText()).toBe('first queued\nsecond queued');
    expect(h.host.clearQueuedMessages).toHaveBeenCalled();
    expect(h.host.state.queuedMessages).toEqual([]);
    expect(h.host.updateQueueDisplay).toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('prepends restored queue to existing editor text', () => {
    const h = createHarness({ queued: ['queued one'], editorText: 'draft', streaming: true });

    h.escape();

    expect(h.getText()).toBe('queued one\ndraft');
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('falls through to the global interrupt when the queue is empty', () => {
    const h = createHarness({ queued: [], streaming: true });

    h.escape();

    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('does nothing special when idle with an empty queue', () => {
    const h = createHarness({ queued: [], streaming: false });

    h.escape();

    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.getText()).toBe('');
  });
});
