import { t } from '@scream-code/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: the barrel must be mocked under its real file id — vi.mock('#/tui/commands')
// resolves to a different module record than the production `../commands` import
// (package-imports glob vs directory-index resolution), so the factory below is
// keyed on the explicit path the vite resolver unifies both sides onto.
import { dispatchInput, handlePlanCommand, handleFusionPlanCommand } from '../../../src/tui/commands/index.js';
import {
  InputController,
  type InputControllerHost,
} from '#/tui/controllers/input-controller';
import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';
import { QueuePaneComponent } from '#/tui/components/panes/queue-pane';
import { getLlmNotSetMessage } from '#/tui/constant/scream-tui';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import type { TranscriptEntry } from '#/tui/types';

import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';

import {
  makeMockHarness,
  makeMockSession,
  makeMockSlashCommandHost,
  type MockSession,
} from '../fixtures/mock-host';

vi.mock('../../../src/tui/commands/index.js', () => ({
  dispatchInput: vi.fn(),
  handlePlanCommand: vi.fn(async (): Promise<void> => {}),
  handleFusionPlanCommand: vi.fn(async (): Promise<void> => {}),
}));

vi.mock('#/utils/history/input-history', () => ({
  appendInputHistory: vi.fn(async (): Promise<boolean> => true),
  loadInputHistory: vi.fn(async (): Promise<unknown[]> => []),
}));

function makeController(options: {
  appState?: Record<string, unknown>;
  session?: MockSession;
  deferUserMessages?: boolean;
  turnId?: string;
} = {}) {
  const harness = makeMockHarness();
  const base = makeMockSlashCommandHost({
    appState: (options.appState ?? {}) as never,
    session: options.session,
    deferUserMessages: options.deferUserMessages,
    harness,
    streamingUIOverrides: {
      getTurnContext: vi.fn(() => ({ turnId: options.turnId ?? 't-7' })),
    },
  });
  const extras = {
    imageStore: new ImageAttachmentStore(),
    stopMemoryIdleTimer: vi.fn(),
    appendTranscriptEntry: vi.fn((_entry: TranscriptEntry): null => null),
    getSlashCommands: vi.fn((): readonly unknown[] => []),
    stopWelcomeBreathing: vi.fn(),
  };
  const queueDisplay = vi.fn();
  const host = { ...base, ...extras, updateQueueDisplay: queueDisplay } as unknown as InputControllerHost;
  const controller = new InputController(host);
  const state = base.state;
  return { controller, host, state, harness, extras, queueDisplay };
}

const BIG = 'x'.repeat(5_001);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InputController.handleInput — large-input confirmation state machine', () => {
  it('dispatches short input and persists it to history', async () => {
    const { controller, host, extras } = makeController();
    controller.handleInput('hello there');
    expect(dispatchInput).toHaveBeenCalledWith(host, 'hello there');
    expect(extras.stopMemoryIdleTimer).toHaveBeenCalled();
    expect(vi.mocked(host.state.editor.addToHistory)).toHaveBeenCalledWith('hello there');
    await vi.waitFor(() =>
      expect(vi.mocked(appendInputHistory)).toHaveBeenCalledWith(
        expect.any(String),
        'hello there',
        undefined,
      ),
    );
  });

  it('ignores blank input entirely', () => {
    const { controller } = makeController();
    controller.handleInput('   ');
    expect(dispatchInput).not.toHaveBeenCalled();
    expect(vi.mocked(appendInputHistory)).not.toHaveBeenCalled();
  });

  it('blocks input while replaying', () => {
    const { controller, host } = makeController({ appState: { isReplaying: true } });
    controller.handleInput('typing during replay');
    expect(host.showError).toHaveBeenCalledWith(t('input.replay_blocked'));
    expect(dispatchInput).not.toHaveBeenCalled();
  });

  it('intercepts >5000 chars, asks for confirmation and defers dispatch', () => {
    const { controller, host } = makeController();
    controller.handleInput(BIG);
    expect(dispatchInput).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      t('input.large_confirm', { count: BIG.length }),
      host.state.theme.colors.warning,
    );
  });

  it('confirms pending input with y (case/whitespace-insensitive)', () => {
    const { controller, host, extras } = makeController();
    controller.handleInput(BIG);
    vi.mocked(host.showStatus).mockClear();
    controller.handleInput('  Y ');
    expect(dispatchInput).toHaveBeenCalledWith(host, BIG);
    expect(extras.stopMemoryIdleTimer).toHaveBeenCalled();
    expect(vi.mocked(host.state.editor.setText)).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('cancels pending input with n and restores it into the editor', () => {
    const { controller, host } = makeController();
    controller.handleInput(BIG);
    controller.handleInput('NO');
    expect(dispatchInput).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      t('input.large_cancelled'),
      host.state.theme.colors.textDim,
    );
    expect(vi.mocked(host.state.editor.setText)).toHaveBeenCalledWith(BIG);
  });

  it('treats any other reply as new input: restore pending, then process it', () => {
    const { controller, host } = makeController();
    controller.handleInput(BIG);
    controller.handleInput('/help');
    const editor = host.state.editor as unknown as { setText: ReturnType<typeof vi.fn> };
    expect(editor.setText).toHaveBeenCalledWith(BIG);
    expect(dispatchInput).toHaveBeenCalledWith(host, '/help');
  });

  it('empty reply cancels and restores without dispatching', () => {
    const { controller, host } = makeController();
    controller.handleInput(BIG);
    controller.handleInput('   ');
    expect(dispatchInput).not.toHaveBeenCalled();
    expect(vi.mocked(host.state.editor.setText)).toHaveBeenCalledWith(BIG);
    expect(host.showStatus).toHaveBeenCalledWith(
      t('input.large_cancelled'),
      host.state.theme.colors.textDim,
    );
  });

  it('confirming with y clears the pending state so the next big paste re-arms it', () => {
    const { controller, host } = makeController();
    controller.handleInput(BIG);
    controller.handleInput('y');
    expect(dispatchInput).toHaveBeenCalledTimes(1);
    controller.handleInput(BIG);
    expect(dispatchInput).toHaveBeenCalledTimes(1); // second one is pending again
    expect(host.showStatus).toHaveBeenLastCalledWith(
      t('input.large_confirm', { count: BIG.length }),
      host.state.theme.colors.warning,
    );
  });
});

describe('InputController.steerMessage decision matrix', () => {
  it('queues every part while deferUserMessages is on', () => {
    const session = makeMockSession();
    const { controller, state, harness } = makeController({
      session,
      deferUserMessages: true,
      appState: { streamingPhase: 'composing' },
    });
    controller.steerMessage(session as never, ['p1', 'p2']);
    expect(state.queuedMessages).toEqual([
      { text: 'p1', agentId: harness.interactiveAgentId, parts: undefined, imageAttachmentIds: undefined },
      { text: 'p2', agentId: harness.interactiveAgentId, parts: undefined, imageAttachmentIds: undefined },
    ]);
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('queues while compacting', () => {
    const session = makeMockSession();
    const { controller, state } = makeController({
      session,
      appState: { isCompacting: true, streamingPhase: 'idle' },
    });
    controller.steerMessage(session as never, ['wait for me']);
    expect(state.queuedMessages.length).toBe(1);
    expect(session.steer).not.toHaveBeenCalled();
  });

  it('sends directly when idle (no steer path)', () => {
    const session = makeMockSession();
    const { controller, extras } = makeController({ session });
    controller.steerMessage(session as never, ['now']);
    expect(session.prompt).toHaveBeenCalledWith('now');
    expect(session.steer).not.toHaveBeenCalled();
    // Direct-send path echoes the user entry with no turnId (turn not started).
    const entry = vi.mocked(extras.appendTranscriptEntry).mock.calls[0]![0] as TranscriptEntry;
    expect(entry.kind).toBe('user');
    expect(entry.turnId).toBeUndefined();
  });

  it('steers with \\n\\n join while streaming, echoing entries with the live turnId', () => {
    const session = makeMockSession();
    const { controller, extras } = makeController({
      session,
      turnId: 't-42',
      appState: { streamingPhase: 'thinking' },
    });
    controller.steerMessage(session as never, ['a', 'b']);
    const entry = vi.mocked(extras.appendTranscriptEntry).mock.calls[0]![0] as TranscriptEntry;
    expect(entry.turnId).toBe('t-42');
    expect(entry.content).toBe('a');
    expect(session.steer).toHaveBeenCalledWith('a\n\nb');
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('surfaces steer rejection as a guide_failed error', async () => {
    const session = makeMockSession({
      overrides: { steer: vi.fn(async () => { throw new Error('session closed'); }) },
    });
    const { controller, host } = makeController({
      session,
      appState: { streamingPhase: 'composing' },
    });
    controller.steerMessage(session as never, ['x']);
    await vi.waitFor(() =>
      expect(host.showError).toHaveBeenCalledWith(t('input.guide_failed', { message: 'session closed' })),
    );
  });
});

describe('InputController.sendNormalUserInput + media capabilities', () => {
  it('rejects when no model is configured', () => {
    const session = makeMockSession();
    const { controller, host } = makeController({ session, appState: { model: '  ' } });
    void controller.sendNormalUserInput('hi');
    expect(host.showError).toHaveBeenCalledWith(getLlmNotSetMessage());
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('rejects when there is no live session', () => {
    const { controller, host } = makeController({ appState: { model: 'gpt-test' } });
    void controller.sendNormalUserInput('hi');
    expect(host.showError).toHaveBeenCalledWith(getLlmNotSetMessage());
  });

  it('sends text through prompt + beginSessionRequest and updates the queue display', () => {
    const session = makeMockSession();
    const { controller, host, extras, queueDisplay, state } = makeController({ session });
    void controller.sendNormalUserInput('plain message');
    expect(session.prompt).toHaveBeenCalledWith('plain message');
    expect(host.beginSessionRequest).toHaveBeenCalled();
    const entry = vi.mocked(extras.appendTranscriptEntry).mock.calls[0]![0] as TranscriptEntry;
    expect(entry.content).toBe('plain message');
    expect(queueDisplay).toHaveBeenCalled();
    expect(vi.mocked(state.ui.requestRender)).toHaveBeenCalled();
  });

  it('queues instead of sending while busy', () => {
    const session = makeMockSession();
    const { controller, state } = makeController({
      session,
      appState: { streamingPhase: 'tool' },
    });
    void controller.sendNormalUserInput('later');
    expect(session.prompt).not.toHaveBeenCalled();
    expect(state.queuedMessages).toEqual([
      { text: 'later', agentId: 'main', parts: undefined, imageAttachmentIds: undefined },
    ]);
  });

  it('blocks image media when the model lacks image_in', () => {
    const session = makeMockSession();
    const { controller, host, extras } = makeController({ session });
    const attachment = extras.imageStore.addImage(new Uint8Array([1, 2]), 'image/png', 640, 480);
    (host.state.appState as unknown as Record<string, unknown>)['availableModels'] = {
      'gpt-test': { capabilities: ['text'] },
    };
    void controller.sendNormalUserInput(`look ${attachment.placeholder}`);
    expect(host.showError).toHaveBeenCalledWith(t('error.image_not_supported'));
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('blocks video media when the model lacks video_in', () => {
    const session = makeMockSession();
    const { controller, host, extras } = makeController({ session });
    const video = extras.imageStore.addVideo('video/mp4', '/tmp/clip.mp4', 'clip.mp4');
    (host.state.appState as unknown as Record<string, unknown>)['availableModels'] = {
      'gpt-test': { capabilities: ['image_in'] },
    };
    void controller.sendNormalUserInput(`watch ${video.placeholder}`);
    expect(host.showError).toHaveBeenCalledWith(t('error.video_not_supported'));
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('allows media when capabilities are undefined (default open) and passes parts', () => {
    const session = makeMockSession();
    const { controller, extras } = makeController({ session });
    const attachment = extras.imageStore.addImage(new Uint8Array([1, 2]), 'image/png', 640, 480);
    void controller.sendNormalUserInput(`look ${attachment.placeholder}`);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(session.prompt).mock.calls[0]![0];
    expect(Array.isArray(arg)).toBe(true); // extraction.parts, not the raw string
    const entry = vi.mocked(extras.appendTranscriptEntry).mock.calls[0]![0] as TranscriptEntry;
    expect(entry.imageAttachmentIds).toEqual([attachment.id]);
  });

  it('sendQueuedMessage re-points the interactive agent before sending', () => {
    const session = makeMockSession();
    const { controller, harness } = makeController({ session });
    controller.sendQueuedMessage(session as never, { text: 'queued', agentId: 'worker-9' });
    expect(harness.interactiveAgentId).toBe('worker-9');
    expect(session.prompt).toHaveBeenCalledWith('queued');
  });

  it('prompt rejection funnels into failSessionRequest', async () => {
    const session = makeMockSession({
      overrides: { prompt: vi.fn(async () => { throw new Error('agent_busy'); }) },
    });
    const { controller, host } = makeController({ session });
    void controller.sendNormalUserInput('boom');
    await vi.waitFor(() =>
      expect(host.failSessionRequest).toHaveBeenCalledWith(
        t('input.send_failed', { message: 'agent_busy' }),
      ),
    );
  });
});

describe('InputController.handlePlanModeStateChange', () => {
  it('routes off / on / fusionplan to the command handlers', () => {
    const { controller, host } = makeController();
    controller.handlePlanModeStateChange('off');
    expect(handlePlanCommand).toHaveBeenCalledWith(host, 'off');
    controller.handlePlanModeStateChange('plan');
    expect(handlePlanCommand).toHaveBeenLastCalledWith(host, 'on');
    controller.handlePlanModeStateChange('fusionplan');
    expect(handleFusionPlanCommand).toHaveBeenCalledWith(host, 'on');
  });
});

describe('InputController.updateEditorBorderHighlight + breathing', () => {
  it('paints the static plan-mode color when input is present', () => {
    const { controller, state } = makeController({ appState: { planMode: 'plan' } });
    controller.updateEditorBorderHighlight('typed text');
    const editor = state.editor as unknown as { borderHex: string };
    expect(editor.borderHex).toBe(state.theme.colors.planMode);
    (state.appState as unknown as Record<string, unknown>)['planMode'] = 'fusionplan';
    controller.updateEditorBorderHighlight('x');
    expect(editor.borderHex).toBe(state.theme.colors.fusionPlanMode);
  });

  it('breathes on an empty editor and freezes after the cycle with fake timers', () => {
    vi.useFakeTimers();
    try {
      const { controller, state } = makeController();
      const editor = state.editor as unknown as { borderHex: string; getText: ReturnType<typeof vi.fn> };
      editor.getText.mockReturnValue('');
      controller.setupAutocomplete();
      const start = editor.borderHex;
      vi.advanceTimersByTime(40);
      expect(editor.borderHex).not.toBe(start);
      expect(editor.borderHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(vi.mocked(state.ui.requestRender)).toHaveBeenCalled();
      // After the 2s cycle the animation stops permanently on the static color.
      vi.advanceTimersByTime(2_000);
      expect(editor.borderHex).toBe(state.theme.colors.primary);
      const frozen = editor.borderHex;
      vi.advanceTimersByTime(400);
      expect(editor.borderHex).toBe(frozen);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setupAutocomplete filters builtin skills from the provider and wires onFirstInput', () => {
    const { controller, host, state, extras } = makeController();
    extras.getSlashCommands.mockReturnValue([
      { name: 'skill:builtinska', source: 'builtin', description: 'd' },
      { name: 'skill:userskill', source: 'user', description: 'd' },
      { name: 'help', source: 'builtin', description: 'd' },
    ] as never);
    controller.setupAutocomplete();
    const provider = vi.mocked(state.editor.setAutocompleteProvider).mock.calls[0]![0];
    expect(provider).toBeInstanceOf(FileMentionProvider);
    const items = (provider as unknown as { slashCommandItems: Array<{ value: string }> })
      .slashCommandItems;
    const values = items.map((i) => i.value);
    expect(values).toContain('skill:userskill');
    expect(values).toContain('help');
    expect(values).not.toContain('skill:builtinska');

    // First keystroke stops welcome + editor breathing forever.
    const onFirstInput = (state.editor as unknown as { onFirstInput?: () => void }).onFirstInput;
    expect(typeof onFirstInput).toBe('function');
    onFirstInput!();
    expect(extras.stopWelcomeBreathing).toHaveBeenCalled();
    expect((host.state.editor as unknown as { borderHex: string }).borderHex).toBe(
      host.state.theme.colors.primary,
    );
  });

  it('stopBreathingForStreaming kills the animation timer', () => {
    vi.useFakeTimers();
    try {
      const { controller, state } = makeController();
      (state.editor as unknown as { getText: ReturnType<typeof vi.fn> }).getText.mockReturnValue('');
      controller.setupAutocomplete();
      controller.stopBreathingForStreaming();
      const hex = (state.editor as unknown as { borderHex: string }).borderHex;
      vi.advanceTimersByTime(500);
      expect((state.editor as unknown as { borderHex: string }).borderHex).toBe(hex);
      controller.dispose(); // must be safe when already stopped
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InputController queue display + persisted history', () => {
  it('updateQueueDisplay renders a QueuePane only for non-empty queues', () => {
    const { controller, state } = makeController();
    controller.updateQueueDisplay();
    expect(state.queueContainer.children.length).toBe(0);
    (state.queuedMessages as unknown[]).push({ text: 'q1', agentId: 'main' });
    controller.updateQueueDisplay();
    expect(state.queueContainer.children.length).toBe(1);
    expect(state.queueContainer.children[0]).toBeInstanceOf(QueuePaneComponent);
    controller.updateQueueDisplay();
    expect(state.queueContainer.children.length).toBe(1); // cleared then re-added
  });

  it('loadPersistedInputHistory seeds the editor history in order', async () => {
    vi.mocked(loadInputHistory).mockResolvedValueOnce([
      { content: 'first' },
      { content: 'second' },
    ] as never);
    const { controller, state } = makeController();
    await controller.loadPersistedInputHistory();
    const addToHistory = vi.mocked(state.editor.addToHistory);
    expect(addToHistory.mock.calls.map(([c]) => c)).toEqual(['first', 'second']);
    // Dedupe anchor: the next identical input is not appended again.
    vi.mocked(appendInputHistory).mockClear();
    controller.handleInput('second');
    expect(vi.mocked(appendInputHistory)).not.toHaveBeenCalled();
  });

  it('loadPersistedInputHistory swallows storage errors', async () => {
    vi.mocked(loadInputHistory).mockRejectedValueOnce(new Error('no file'));
    const { controller } = makeController();
    await expect(controller.loadPersistedInputHistory()).resolves.toBeUndefined();
  });
});
