/**
 * Shared mock factories for TUI controller / manager tests.
 *
 * Distills the three-layer assembly pattern first established in
 * `test/tui/controllers/session-event-handler.test.ts`:
 *   1. a literal `state` object (appState + theme.colors + real pi-tui
 *      `Container`s + mutable `transcriptEntries` / `queuedMessages` arrays),
 *   2. `vi.fn()` method sets for every host interface function,
 *   3. write-back semantics where production code relies on them
 *      (`setAppState` → `Object.assign`, spinner/status helpers → shared arrays).
 *
 * Existing test files are NOT migrated to this fixture (plan decision:
 * avoid churn); all *new* B2 tests build their host from here and extend it
 * with file-local stubs.
 */
import { Container } from '@liutod-scream/pi-tui';
import { vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { ScreamHarness, Session, SessionStatus } from '@scream-code/scream-code-sdk';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { TasksBrowserController } from '#/tui/controllers/tasks-browser';
import type { AppState, TranscriptEntry, TUIStartupState } from '#/tui/types';
import type { TUIState } from '#/tui/tui-state';
import { createScreamTUIThemeBundle } from '#/tui/theme/bundle';

// ---------------------------------------------------------------------------
// AppState / TUIState
// ---------------------------------------------------------------------------

export function createMockAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'gpt-test',
    workDir: '/tmp/scream-test',
    sessionId: 'ses-test',
    permissionMode: 'ask',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    sessionUsage: {},
    sessionApiCalls: 0,
    providerBalance: null,
    balanceUpdatedAt: 0,
    isCompacting: false,
    lastCompactionFinishedAt: undefined,
    autoCompactionCount: 0,
    isReplaying: false,
    isSwitchingSession: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: '0.0.0-test',
    hasNewVersion: false,
    latestVersion: null,
    editorCommand: null,
    language: 'zh',
    notifications: { enabled: false, condition: 'always' },
    like: {},
    fusionPlan: { maxAgents: 8 },
    subagentModels: {},
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    goalActive: false,
    goalJudge: 'awaiting',
    goalContinuationCount: 0,
    ccConnectActive: false,
    wolfpackMode: false,
    rlmEnabled: false,
    reconnectAttempt: 0,
    recentSessions: [],
    subagentUsage: {},
    ...overrides,
  } as unknown as AppState;
}

/**
 * Builds a `TUIState`-shaped object with the surfaces the B2 controllers
 * touch: real `Container` instances (so `children` / `addChild` /
 * `removeChild` behave like production), a real theme bundle (dark), and
 * `vi.fn()` stubs for editor / footer / panels.
 */
export function createMockTUIState(options: { appState?: Partial<AppState> } = {}): TUIState {
  const theme = createScreamTUIThemeBundle('dark');
  const editor = {
    getText: vi.fn((): string => ''),
    setText: vi.fn(),
    addToHistory: vi.fn(),
    setAutocompleteProvider: vi.fn(),
    hasFirstInputFired: vi.fn((): boolean => true),
    borderHex: '#a3be8c',
    borderColor: (s: string): string => s,
    onFirstInput: undefined as (() => void) | undefined,
    dispose: vi.fn(),
  };
  const state = {
    ui: {
      requestRender: vi.fn(),
      setFocus: vi.fn(),
      setLayoutRoot: vi.fn(),
    },
    terminal: { write: vi.fn(), title: undefined },
    layoutRoot: { render: (): string[] => ['root'], invalidate: (): void => {} },
    transcriptContainer: new Container(),
    activityContainer: new Container(),
    statusBarContainer: new Container(),
    todoPanelContainer: new Container(),
    queueContainer: new Container(),
    errorBannerContainer: new Container(),
    planModeBannerContainer: new Container(),
    editorContainer: new Container(),
    todoPanel: {
      getTodos: vi.fn((): unknown[] => []),
      setTodos: vi.fn(),
      clear: vi.fn(),
    },
    errorBanner: {
      setMessage: vi.fn(),
      clear: vi.fn(),
    },
    planModeBanner: { setMode: vi.fn(), clear: vi.fn() },
    footer: {
      setBackgroundCounts: vi.fn(),
      requestRender: vi.fn(),
    },
    editor,
    theme,
    appState: createMockAppState(options.appState),
    startupState: 'pending' as TUIStartupState,
    livePane: {
      pendingApproval: null,
      pendingQuestion: null,
      viewer: null,
    },
    transcriptEntries: [] as TranscriptEntry[],
    terminalState: {
      notificationKeys: new Set<string>(),
      focused: true,
      supportsOsc9: false,
      insideTmux: false,
    },
    activitySpinner: null,
    pulseWave: null,
    toolOutputExpanded: false,
    planExpanded: false,
    sessions: [] as unknown[],
    loadingSessions: false,
    activeDialog: null as TUIState['activeDialog'],
    tasksBrowser: undefined,
    externalEditorRunning: false,
    queuedMessages: [] as TranscriptEntry[],
    fdPath: null,
    gitLsFilesCache: {},
    renderBatcher: { beginBatch: vi.fn(), endBatch: vi.fn() },
  };
  return state as unknown as TUIState;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export function makeMockStreamingUI(
  overrides: Record<string, unknown> = {},
): StreamingUIController {
  const streamingUI = {
    setStep: vi.fn(),
    setTurnId: vi.fn(),
    resetLiveText: vi.fn(),
    resetToolUi: vi.fn(),
    resetToolCallState: vi.fn(),
    discardPending: vi.fn(),
    disposeActiveCompactionBlock: vi.fn(),
    flushNow: vi.fn(),
    finalizeLiveTextBuffers: vi.fn(),
    finalizeAssistantStream: vi.fn(),
    finalizeTurn: vi.fn(),
    registerToolCall: vi.fn(),
    completeToolResult: vi.fn(),
    scheduleFlush: vi.fn(),
    appendAssistantDelta: vi.fn(),
    appendThinkingDelta: vi.fn(),
    hasThinkingDraft: vi.fn((): boolean => false),
    flushThinkingToTranscript: vi.fn(),
    getTurnContext: vi.fn((): { turnId: string } => ({ turnId: 't-1' })),
    setTodoList: vi.fn(),
    endCompaction: vi.fn(),
    cancelCompaction: vi.fn(),
    markStepTruncated: vi.fn((): number => 0),
    getToolComponent: vi.fn((): undefined => undefined),
    getActiveToolCall: vi.fn((): undefined => undefined),
    onToolCallStart: vi.fn(),
    hasActiveTurn: vi.fn((): boolean => false),
    ...overrides,
  };
  return streamingUI as unknown as StreamingUIController;
}

export function makeMockTasksBrowser(
  overrides: Record<string, unknown> = {},
): TasksBrowserController {
  const controller = {
    show: vi.fn(async (): Promise<void> => {}),
    close: vi.fn(),
    refreshOutputViewer: vi.fn(),
    repaint: vi.fn(),
    ...overrides,
  };
  return controller as unknown as TasksBrowserController;
}

// ---------------------------------------------------------------------------
// Session / Harness
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_STATUS: SessionStatus = {
  model: 'gpt-test',
  thinkingLevel: 'off',
  permission: 'ask',
  planMode: false,
  wolfpackMode: false,
  rlmEnabled: false,
  contextTokens: 1_000,
  maxContextTokens: 200_000,
  contextUsage: 0.005,
};

/**
 * Structural shape of the mock session. Method members are `vi.fn()`s, so
 * tests can keep the concrete type (not the opaque sdk `Session`) and inspect
 * `.mock.calls` directly. Pass through `host.session = mock as unknown as
 * Session` (or via `makeMockSlashCommandHost({ session })`, which casts for
 * you) when a strict sdk `Session` is required — same convention as the
 * existing golden tests.
 */
export interface MockSession {
  id: string;
  summary: { title?: string | null } | undefined;
  prompt: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setApprovalHandler: ReturnType<typeof vi.fn>;
  setQuestionHandler: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  getGoal: ReturnType<typeof vi.fn>;
  getResumeState: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermission: ReturnType<typeof vi.fn>;
  setWolfpackMode: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

export function makeMockSession(
  options: { id?: string; overrides?: Record<string, unknown> } = {},
): MockSession {
  const session: MockSession = {
    id: options.id ?? 'ses-mock',
    summary: undefined,
    prompt: vi.fn(async (): Promise<void> => {}),
    steer: vi.fn(async (): Promise<void> => {}),
    close: vi.fn(async (): Promise<void> => {}),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    getStatus: vi.fn(async () => ({ ...DEFAULT_SESSION_STATUS })),
    getGoal: vi.fn(async () => ({ goal: null })),
    getResumeState: vi.fn((): undefined => undefined),
    setModel: vi.fn(async (): Promise<void> => {}),
    setPermission: vi.fn(async (): Promise<void> => {}),
    setWolfpackMode: vi.fn(async (): Promise<void> => {}),
    ...options.overrides,
  };
  return session;
}

export interface MockHarness {
  interactiveAgentId: string;
  createSession: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

export function makeMockHarness(overrides: Record<string, unknown> = {}): MockHarness {
  const harness: MockHarness = {
    interactiveAgentId: 'main',
    createSession: vi.fn(async () => makeMockSession() as unknown as Session),
    resumeSession: vi.fn(
      async () => makeMockSession({ id: 'ses-resumed' }) as unknown as Session,
    ),
    listSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async (): Promise<void> => {}),
    ...overrides,
  };
  return harness;
}

// ---------------------------------------------------------------------------
// SlashCommandHost
// ---------------------------------------------------------------------------

export interface MockSlashCommandHostOptions {
  appState?: Partial<AppState>;
  session?: MockSession | Session;
  skillCommands?: Iterable<readonly [string, string]>;
  deferUserMessages?: boolean;
  harness?: MockHarness;
  streamingUIOverrides?: Record<string, unknown>;
}

/**
 * Full `SlashCommandHost` mock: state literal + vi.fn method set +
 * write-back `setAppState` (the golden three-layer pattern). `host.state`
 * is the mutable mock state; interface methods are plain `vi.fn()`s so
 * tests inspect them with `vi.mocked(host.showStatus)` etc.
 */
export function makeMockSlashCommandHost(
  options: MockSlashCommandHostOptions = {},
): SlashCommandHost {
  const state = createMockTUIState({ appState: options.appState });

  const host: SlashCommandHost = {
    state,
    session: options.session as Session | undefined,
    harness: (options.harness ?? makeMockHarness()) as unknown as ScreamHarness,
    cancelInFlight: undefined,
    deferUserMessages: options.deferUserMessages ?? false,

    setAppState: vi.fn((patch: Partial<AppState>) => {
      Object.assign(state.appState, patch);
    }),
    resetLivePane: vi.fn(() => {
      Object.assign(state.livePane, {
        pendingApproval: null,
        pendingQuestion: null,
        viewer: null,
      });
    }),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    setPlanModeBanner: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),

    requireSession: vi.fn((): Session => {
      if (host.session === undefined) {
        throw new Error('no active session');
      }
      return host.session;
    }),
    switchToSession: vi.fn(async (): Promise<void> => {}),
    beginSessionRequest: vi.fn(),
    failSessionRequest: vi.fn(),
    sendQueuedMessage: vi.fn(),

    showProgressSpinner: vi.fn(
      (): { stop(opts: { ok: boolean; label: string }): void; setLabel(label: string): void } => ({
        stop: vi.fn(),
        setLabel: vi.fn(),
      }),
    ),

    applyTheme: vi.fn(),
    refreshTerminalThemeTracking: vi.fn(),

    stop: vi.fn(async (): Promise<void> => {}),
    showHelpPanel: vi.fn(),
    createNewSession: vi.fn(async (): Promise<void> => {}),
    showSessionPicker: vi.fn(async (): Promise<void> => {}),
    showMemoryPicker: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendSkillActivation: vi.fn(),
    skillCommandMap: new Map<string, string>(
      options.skillCommands === undefined
        ? undefined
        : Array.from(options.skillCommands, ([key, value]) => [key, value]),
    ),
    refreshCcStatus: vi.fn(),

    streamingUI: makeMockStreamingUI(options.streamingUIOverrides),
    tasksBrowserController: makeMockTasksBrowser(),
    authFlow: {} as unknown as SlashCommandHost['authFlow'],
  };

  return host;
}
