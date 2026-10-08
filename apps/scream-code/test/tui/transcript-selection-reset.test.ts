/**
 * Regression: every host path that moves transcript rows — a wholesale
 * rebuild, a commit that evicts live rows into the summary tree, a Ctrl+O
 * height change — must drop the terminal's live text selection.
 *
 * `TuiAltScreen` stores a selection as viewport coordinates and re-applies the
 * highlight on every frame, so a stale one paints over whatever content lands
 * in those rows next and copy-on-select hands out that text instead of what the
 * user selected. `resetTextSelection()` is pi-tui's API for that; these tests
 * pin the paths that must call it and prove the reset on a real `TuiAltScreen`
 * (a genuine mouse drag, then `hasActiveSelection()`).
 */
import { Text, TuiAltScreen, type Terminal } from '@liutod-scream/pi-tui';
import type { Session } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleBlockRowsCommand } from '#/tui/commands/blockrows';
import { handleCodeBgCommand } from '#/tui/commands/codebg';
import { handleMermaidCommand } from '#/tui/commands/mermaid';
import { handleRevokeCommand } from '#/tui/commands/revoke';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { CommittedTranscriptComponent } from '#/tui/components/transcript/committed-transcript';
import {
  SessionReplayRenderer,
  type SessionReplayHost,
} from '#/tui/controllers/session-replay';
import {
  TranscriptController,
  type TranscriptControllerHost,
} from '#/tui/controllers/transcript-controller';
import type { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { ScreamTUI, type ScreamTUIStartupInput } from '#/tui/scream-tui';
import { createScreamTUIThemeBundle } from '#/tui/theme/bundle';
import type { TUIState } from '#/tui/tui-state';
import type { TranscriptEntry } from '#/tui/types';
import { getActivityLineValue, setActivityLineValue } from '#/tui/utils/activity-lines';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import {
  getMermaidDisplay,
  isCodeBlockPanelEnabled,
  setMermaidDisplay,
  toggleCodeBlockPanel,
  type MermaidDisplay,
} from '#/tui/utils/ui-preferences';

import {
  createMockTUIState,
  makeMockHarness,
  makeMockSession,
  makeMockSlashCommandHost,
  makeMockStreamingUI,
} from './fixtures/mock-host';

const bundle = createScreamTUIThemeBundle('dark', 'dark');

// ---------------------------------------------------------------------------
// Real alt-screen selection harness
// ---------------------------------------------------------------------------

/**
 * Terminal test double for a real `TuiAltScreen`: output goes nowhere, and the
 * input callback pi-tui registers is captured so a test can deliver the SGR
 * mouse sequences a terminal would send.
 */
function makeFakeTerminal(columns = 80, rows = 24) {
  let feed: ((data: string) => void) | undefined;
  const terminal = {
    start(onInput: (data: string) => void): void {
      feed = onInput;
    },
    stop(): void {
      feed = undefined;
    },
    drainInput: async (): Promise<void> => {},
    write(): void {},
    columns,
    rows,
    kittyProtocolActive: false,
    moveBy(): void {},
    hideCursor(): void {},
    showCursor(): void {},
    clearLine(): void {},
    clearFromCursor(): void {},
    clearScreen(): void {},
    setTitle(): void {},
    setProgress(): void {},
  };
  return {
    terminal: terminal as unknown as Terminal,
    feed: (data: string): void => feed?.(data),
  };
}

const liveUis: TuiAltScreen[] = [];

afterEach(() => {
  for (const ui of liveUis.splice(0)) ui.stop();
  vi.restoreAllMocks();
});

/** Swap a real `TuiAltScreen` into the state under test and give it a row of
 *  text that a drag can select. */
function installRealUi(state: TUIState): { ui: TuiAltScreen; feed: (data: string) => void } {
  const { terminal, feed } = makeFakeTerminal();
  const ui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
  ui.setLayoutRoot(new Text('rows of the transcript that is about to change', 0, 0));
  ui.start();
  // A frame has to land first: the selection resolves against the rendered
  // screen, and the press/short-click paths read it too.
  ui.renderNow(true);
  liveUis.push(ui);
  state.ui = ui;
  return { ui, feed };
}

/** A left-button drag across columns `from`..`to` of the first row. */
function dragFirstRow(ui: TuiAltScreen, feed: (data: string) => void, from: number, to: number): void {
  feed(`\u001B[<0;${String(from)};1M`); // press
  feed(`\u001B[<32;${String(to)};1M`); // drag
  feed(`\u001B[<0;${String(to)};1m`); // release
}

// ---------------------------------------------------------------------------
// Controller / replay host scaffolding
// ---------------------------------------------------------------------------

function makeControllerHost(): { controller: TranscriptController; state: TUIState } {
  const state = createMockTUIState();
  const host = {
    state,
    imageStore: new ImageAttachmentStore(),
    streamingUI: makeMockStreamingUI(),
    showStatus: vi.fn(),
    // TranscriptController.commit() wraps its work in batchUpdate — run inline.
    batchUpdate: <T,>(fn: () => T): T => fn(),
    forceUpdateStatusBar: vi.fn(),
  } as unknown as TranscriptControllerHost;
  return { controller: new TranscriptController(host), state };
}

function statusEntry(content: string): TranscriptEntry {
  return {
    id: `e-${content}`,
    kind: 'status',
    renderMode: 'plain',
    content,
  };
}

/** One replayed user turn — enough for hydrateFromReplay to reach its first
 *  mounted row (the point past which the stale highlight would paint). */
function makeReplaySession() {
  const main = {
    type: 'main',
    config: { modelAlias: 'k2', modelCapabilities: { max_context_tokens: 100 } },
    context: { tokenCount: 10, messages: [] },
    replay: [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }] } },
    ],
    permission: { mode: 'manual' },
    plan: null,
    usage: {},
    tools: [],
    background: [],
  };
  return makeMockSession({
    id: 'ses-replay',
    overrides: {
      getResumeState: vi.fn(() => ({ agents: { main } })),
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transcript rebuilds clear the terminal text selection', () => {
  it('drops a live selection when the transcript is replaced wholesale (session switch / /new)', () => {
    const { controller, state } = makeControllerHost();
    const { ui, feed } = installRealUi(state);
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);

    controller.clearAndRedraw();

    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('drops a live selection when a replay repopulates the transcript', async () => {
    const state = createMockTUIState();
    const { ui, feed } = installRealUi(state);
    const appendTranscriptEntry = vi.fn();
    const host = {
      state,
      streamingUI: makeMockStreamingUI({
        cleanupAfterReplay: vi.fn(),
        clearAssistantDraft: vi.fn(),
        onThinkingUpdate: vi.fn(),
        onThinkingEnd: vi.fn(),
        onStreamingTextStart: vi.fn(),
        onStreamingTextUpdate: vi.fn(),
        onStreamingTextEnd: vi.fn(),
        applyBackgroundTaskTerminalStatus: vi.fn(),
        removeToolComponent: vi.fn(),
      }),
      sessionEventHandler: {
        backgroundAgentMetadata: new Map(),
        backgroundTasks: new Map(),
        backgroundTaskTranscriptedTerminal: new Set<string>(),
        renderedSkillActivationIds: new Set<string>(),
      } as unknown as SessionEventHandler,
      setAppState: vi.fn(),
      showError: vi.fn(),
      appendTranscriptEntry,
      forceUpdateStatusBar: vi.fn(),
    } as unknown as SessionReplayHost;
    const renderer = new SessionReplayRenderer(host);
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);

    await expect(renderer.hydrateFromReplay(makeReplaySession() as unknown as Session)).resolves.toBe(true);

    // The replay really repopulated the transcript, and the highlight that was
    // pointing at the previous content is gone.
    expect(appendTranscriptEntry).toHaveBeenCalled();
    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('drops a live selection when /revoke removes rows', async () => {
    const session = makeMockSession({
      overrides: { undoHistory: vi.fn(async (): Promise<void> => {}) },
    });
    const host = makeMockSlashCommandHost({ session });
    const { ui, feed } = installRealUi(host.state);
    const { transcriptContainer, transcriptEntries } = host.state;
    const userRow = new UserMessageComponent('do the thing', bundle.colors);
    transcriptContainer.addChild(userRow);
    transcriptEntries.push({
      id: 'e-user',
      kind: 'user',
      renderMode: 'plain',
      content: 'do the thing',
      turnId: 'turn-1',
    });
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);

    await handleRevokeCommand(host, '');

    // The revoked row left the transcript (only the re-rendered welcome stays)
    // and the highlight that was pointing at the old rows is gone.
    expect(transcriptContainer.children).not.toContain(userRow);
    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('clears a live selection on every commit that evicts rows, the tree fold included', () => {
    const { controller, state } = makeControllerHost();
    const reset = vi.mocked(state.ui.resetTextSelection);

    // The tree fold is a >500-committed-row event, so it takes a long session to
    // reach: the loop keeps committing live rows until the tree passes its
    // retention point. The committed count tells the evicting commits from the
    // no-ops, and the reset must land on exactly the former — the entry-array cap
    // folded hundreds of times in this loop too and must not have touched the
    // selection (it changes nothing on screen).
    let movingCommits = 0;
    let foldedCommits = 0;
    for (let i = 0; i < 800; i += 1) {
      const collapsedBefore = collapsedRows(state);
      const committedBefore = controller.getCommittedCount();
      controller.appendEntry(statusEntry(`row-${String(i)}`));
      controller.commit();
      if (controller.getCommittedCount() > committedBefore) movingCommits += 1;
      if (collapsedRows(state) > collapsedBefore) foldedCommits += 1;
    }

    expect(movingCommits).toBeGreaterThan(0);
    expect(foldedCommits).toBeGreaterThan(0);
    expect(reset).toHaveBeenCalledTimes(movingCommits);
  });

  // The per-turn path, far more frequent than the fold: every settled turn
  // replaces the live view with the committed summaries, which moves rows just
  // the same and must clear too.
  it('drops a live selection when a commit replaces live rows with the summary tree', () => {
    const { controller, state } = makeControllerHost();
    const { ui, feed } = installRealUi(state);
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);
    const reset = vi.spyOn(ui, 'resetTextSelection');
    seedLiveComponents(controller, state, 155);

    controller.commit();

    expect(controller.getCommittedCount()).toBe(5);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('leaves the selection alone for a commit with nothing to evict', () => {
    const { controller, state } = makeControllerHost();
    const reset = vi.mocked(state.ui.resetTextSelection);
    // At the live limit there is no eviction, so no row moves.
    seedLiveComponents(controller, state, 150);

    controller.commit();

    expect(controller.getCommittedCount()).toBe(0);
    expect(reset).not.toHaveBeenCalled();
  });

  it('drops a live selection when Ctrl+O changes a card height', () => {
    const { controller, state } = makeControllerHost();
    const { ui, feed } = installRealUi(state);
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);
    const reset = vi.spyOn(ui, 'resetTextSelection');
    const card = { setExpanded: vi.fn(), render: () => ['card'], invalidate: (): void => {} };
    state.transcriptContainer.addChild(card as never);

    controller.toggleToolOutputExpansion();

    // The card grew/shrunk, so every row below it moved: same reset as the commit
    // path. (Drop the call from the controller and this assertion goes red.)
    expect(card.setExpanded).toHaveBeenCalledWith(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('leaves the selection alone for a Ctrl+O press that flips no card', () => {
    const { controller, state } = makeControllerHost();
    const reset = vi.mocked(state.ui.resetTextSelection);

    controller.toggleToolOutputExpansion();

    // Nothing expandable in the current turn: the press records the mode for what
    // mounts next, but no row moved, so there is no stale highlight to drop.
    expect(state.toolOutputExpanded).toBe(true);
    expect(reset).not.toHaveBeenCalled();
  });

  it('drops a live selection when a plan reveal changes the card height', () => {
    const { controller, state } = makeControllerHost();
    const { ui, feed } = installRealUi(state);
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);
    const reset = vi.spyOn(ui, 'resetTextSelection');
    const card = { setPlanExpanded: vi.fn((): boolean => true) };
    state.transcriptContainer.addChild(card as never);

    expect(controller.togglePlanExpansion()).toBe(true);

    // The ExitPlanMode card rebuilt its body around the plan box, so every row
    // below it moved: same reset, same reason as Ctrl+O. (Drop the call from
    // togglePlanExpansion and this assertion goes red.)
    expect(card.setPlanExpanded).toHaveBeenCalledWith(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('leaves the selection alone for a plan toggle that finds no plan card', () => {
    const { controller, state } = makeControllerHost();
    const { ui, feed } = installRealUi(state);
    dragFirstRow(ui, feed, 1, 9);
    const reset = vi.spyOn(ui, 'resetTextSelection');
    const card = { setPlanExpanded: vi.fn((): boolean => false) };
    state.transcriptContainer.addChild(card as never);

    expect(controller.togglePlanExpansion()).toBe(false);

    // No card consumed the press, so no row moved and the selection stays where
    // the user put it.
    expect(state.planExpanded).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(ui.hasActiveSelection()).toBe(true);
  });
});

describe('height-changing view commands clear the terminal text selection', () => {
  // These commands persist their choice into ui-preferences, which lives in this
  // test file's own temp SCREAM_CODE_HOME. Snapshot what each case may touch and
  // put it back, so the cases cannot couple through the shared file.
  let toolLines = 0;
  let mermaid: MermaidDisplay = 'on';
  let panel = true;

  beforeEach(() => {
    toolLines = getActivityLineValue('activityExpandedToolLines');
    mermaid = getMermaidDisplay();
    panel = isCodeBlockPanelEnabled();
  });

  afterEach(() => {
    setActivityLineValue('activityExpandedToolLines', toolLines);
    setMermaidDisplay(mermaid);
    if (isCodeBlockPanelEnabled() !== panel) toggleCodeBlockPanel();
  });

  /** ChoicePicker callbacks for the picker mounted through the host at `index`
   *  (step one mounts the budget list, step two the value list). */
  function pickerOf(host: SlashCommandHost, index: number): { onSelect(value: string): void } {
    const mounted = vi.mocked(host.mountEditorReplacement).mock.calls[index]?.[0] as unknown as
      | { opts: { onSelect(value: string): void } }
      | undefined;
    if (mounted === undefined) throw new Error(`no picker mounted at index ${String(index)}`);
    return mounted.opts;
  }

  /** A host whose session can absorb the capability sync /mermaid fires. */
  function makeCommandHost(): SlashCommandHost {
    const session = makeMockSession({
      overrides: { setRuntimeSystemPrompt: vi.fn(async (): Promise<void> => {}) },
    });
    return makeMockSlashCommandHost({ session });
  }

  it('drops a live selection when /blockrows saves a different budget', async () => {
    const host = makeCommandHost();
    const { ui, feed } = installRealUi(host.state);
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);
    const reset = vi.spyOn(ui, 'resetTextSelection');
    const current = getActivityLineValue('activityExpandedToolLines');
    const target = String(current === 5 ? 10 : 5);

    await handleBlockRowsCommand(host, '');
    pickerOf(host, 0).onSelect('activityExpandedToolLines');
    pickerOf(host, 1).onSelect(target);

    // Rows already on screen were laid out under the old budget and grow or
    // shrink with it: the stale coordinates are dropped before the repaint.
    // (Drop the call from /blockrows and this assertion goes red.)
    expect(getActivityLineValue('activityExpandedToolLines')).toBe(Number(target));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('leaves the selection alone when /blockrows re-saves the budget in effect', async () => {
    const host = makeCommandHost();
    const { ui, feed } = installRealUi(host.state);
    dragFirstRow(ui, feed, 1, 9);
    const reset = vi.spyOn(ui, 'resetTextSelection');

    await handleBlockRowsCommand(host, '');
    pickerOf(host, 0).onSelect('activityExpandedToolLines');
    pickerOf(host, 1).onSelect(String(getActivityLineValue('activityExpandedToolLines')));

    // The same budget redraws identical rows; nothing moved under the selection.
    expect(reset).not.toHaveBeenCalled();
    expect(ui.hasActiveSelection()).toBe(true);
  });

  it('drops a live selection when /mermaid switches between drawing and source', async () => {
    const host = makeCommandHost();
    const { ui, feed } = installRealUi(host.state);
    dragFirstRow(ui, feed, 1, 9);
    expect(ui.hasActiveSelection()).toBe(true);
    const reset = vi.spyOn(ui, 'resetTextSelection');
    setMermaidDisplay('on');

    await handleMermaidCommand(host, 'off');

    // Frames collapse back into their source blocks, so every row below moves.
    // (Drop the call from /mermaid and this assertion goes red.)
    expect(getMermaidDisplay()).toBe('off');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(ui.hasActiveSelection()).toBe(false);
  });

  it('leaves the selection alone for a box ↔ ascii re-glyph, which moves no row', async () => {
    const host = makeCommandHost();
    const { ui, feed } = installRealUi(host.state);
    dragFirstRow(ui, feed, 1, 9);
    const reset = vi.spyOn(ui, 'resetTextSelection');
    setMermaidDisplay('on');

    await handleMermaidCommand(host, 'ascii');

    // Same grid in another alphabet (one-for-one glyph swap): no row moves, so
    // the coordinate selection is still valid.
    expect(getMermaidDisplay()).toBe('ascii');
    expect(reset).not.toHaveBeenCalled();
    expect(ui.hasActiveSelection()).toBe(true);
  });

  it('leaves the selection alone for /codebg, which repaints without moving a row', async () => {
    const host = makeCommandHost();
    const { ui, feed } = installRealUi(host.state);
    dragFirstRow(ui, feed, 1, 9);
    const reset = vi.spyOn(ui, 'resetTextSelection');

    await handleCodeBgCommand(host, '');

    // The same repaint helper the two commands above use, but the panel toggle
    // only changes colours on rows that stay put — which is why the reset lives
    // at the command points instead of inside repaintTranscript.
    expect(reset).not.toHaveBeenCalled();
    expect(ui.hasActiveSelection()).toBe(true);
  });
});

describe('session switch and /new clear the selection end-to-end', () => {
  it('clears it on the way into another session and on the way into a new one', async () => {
    const session = makeMockSession({
      id: 'ses-target',
      overrides: {
        listSkills: vi.fn(async () => []),
        onEvent: vi.fn(() => () => {}),
        getStatus: vi.fn(async () => ({
          model: 'k2',
          thinkingLevel: 'off',
          permission: 'manual',
          planMode: 'off',
          contextTokens: 10,
          maxContextTokens: 100,
          contextUsage: 0.1,
        })),
      },
    });
    const harness = makeMockHarness({
      createSession: vi.fn(async () => session as unknown as Session),
      resumeSession: vi.fn(async () => session as unknown as Session),
      setSubagentModelBindings: vi.fn(),
      close: vi.fn(async () => {}),
      getExperimentalFlags: vi.fn(async () => ({})),
    });
    const driver = new ScreamTUI(harness as never, makeStartupInput());
    vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
    const reset = vi.spyOn(driver.state.ui, 'resetTextSelection');

    await driver.sessionManager.switchToSession(session as unknown as Session, 'switched');
    expect(reset).toHaveBeenCalled();

    const afterSwitch = reset.mock.calls.length;
    await driver.sessionManager.createNewSession();
    expect(reset.mock.calls.length).toBeGreaterThan(afterSwitch);
  });
});

// ---------------------------------------------------------------------------
// Helpers for the commit tests
// ---------------------------------------------------------------------------

/** Fill the container with N registered live components, the way the live
 *  transcript does before a turn settles. */
function seedLiveComponents(
  controller: TranscriptController,
  state: TUIState,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const component = {
      render: () => [`c-${String(i)}`],
      invalidate: (): void => {},
    };
    const entry = statusEntry(`seed-${String(i)}`);
    state.transcriptEntries.push(entry);
    controller.registerLiveComponent(component as never, entry);
    state.transcriptContainer.addChild(component as never);
  }
}

/** Rows the committed tree has folded into its summary stub (0 before it exists). */
function collapsedRows(state: TUIState): number {
  const committed = state.transcriptContainer.children.find(
    (child): child is CommittedTranscriptComponent =>
      child instanceof CommittedTranscriptComponent,
  );
  return committed?.getCollapsedCount() ?? 0;
}

function makeStartupInput(): ScreamTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      wolfpack: false,
      model: 'k2',
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      language: 'zh',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      like: {},
      fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
      subagentModels: {},
      autoStart: false,
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
    resolvedTheme: 'dark',
    updatePrefetched: true,
  };
}
