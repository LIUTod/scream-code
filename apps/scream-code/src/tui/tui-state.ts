import {
  Container,
  ProcessTerminal,
  TUI,
} from '@earendil-works/pi-tui';
import { appendFileSync, mkdirSync } from 'node:fs';
import { getLogDir } from '#/utils/paths';
import { createRenderBatcher, type RenderBatchController } from './utils/render-batcher';

import { ErrorBannerComponent } from './components/chrome/error-banner';
import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { PlanModeBannerComponent } from './components/chrome/plan-mode-banner';
import type { PulseWaveLoader } from './components/chrome/pulse-wave-loader';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { CHROME_GUTTER } from './constant/rendering';
import type { TasksBrowserState } from './controllers/tasks-browser';
import { createScreamTUIThemeBundle, type ScreamTUIThemeBundle } from './theme/bundle';
import { createTerminalState, type TerminalState } from './utils/terminal-state';
import type { GitLsFilesCache } from '#/utils/git/git-ls-files';
import { createGitLsFilesCache } from '#/utils/git/git-ls-files';
import { detectFdPath } from '#/utils/process/fd-detect';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type ScreamTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';

export interface TUIState {
  ui: TUI;
  terminal: ProcessTerminal;
  transcriptContainer: Container;
  activityContainer: Container;
  todoPanelContainer: Container;
  todoPanel: TodoPanelComponent;
  queueContainer: Container;
  errorBanner: ErrorBannerComponent;
  errorBannerContainer: Container;
  planModeBanner: PlanModeBannerComponent;
  planModeBannerContainer: Container;
  editorContainer: Container;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: ScreamTUIThemeBundle;
  appState: AppState;
  startupState: TUIStartupState;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  activitySpinner: { instance: MoonLoader; style: SpinnerStyle } | null;
  pulseWave: PulseWaveLoader | null;
  toolOutputExpanded: boolean;
  planExpanded: boolean;
  sessions: SessionRow[];
  loadingSessions: boolean;
  activeDialog: 'session-picker' | 'memory-picker' | 'help' | null;
  tasksBrowser: TasksBrowserState | undefined;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  fdPath: string | null;
  gitLsFilesCache: GitLsFilesCache;
  renderBatcher: RenderBatchController;
}
function logRenderError(error: unknown): void {
  try {
    const logDir = getLogDir();
    mkdirSync(logDir, { recursive: true });
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const line = `[${new Date().toISOString()}] TUI render error: ${message}\n`;
    appendFileSync(`${logDir}/render-errors.log`, line, 'utf8');
  } catch {
    // Last-resort fallback: avoid recursion or further terminal corruption.
  }
}

export function createTUIState(options: ScreamTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = createScreamTUIThemeBundle(initialAppState.theme, options.resolvedTheme);

  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);
  // Keep differential rendering when content shrinks (e.g. transcript commit,
  // tool-call collapse). Without this, pi-tui defaults to clearing the whole
  // screen and recalculating the viewport, which causes visible jumps.
  ui.setClearOnShrink(false);

  // ── Render safety net ──────────────────────────────────────────────
  // pi-tui's doRender() runs inside process.nextTick + setTimeout, so
  // exceptions become uncaughtException and can kill the process or
  // corrupt the terminal state.  Monkey-patch doRender with a try-catch
  // so a single bad component render doesn't take down the whole TUI.
  const uiAny = ui as unknown as Record<string, unknown>;
  const originalDoRender = (uiAny['doRender'] as () => void).bind(ui);
  uiAny['doRender'] = (): void => {
    try {
      originalDoRender();
    } catch (error) {
      logRenderError(error);
    }
  };

  // Wrap pi-tui's render scheduling so multiple requestRender() calls in the
  // same microtask collapse into a single underlying call, and so
  // ScreamTUI.batchUpdate() can suppress renders during compound updates.
  const originalRequestRender = ui.requestRender.bind(ui);
  const renderBatcher = createRenderBatcher(originalRequestRender);
  ui.requestRender = (force = false): void => {
    renderBatcher.requestRender(force);
  };

  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent(theme.colors);
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const errorBanner = new ErrorBannerComponent(theme.colors);
  const errorBannerContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  errorBannerContainer.addChild(errorBanner);
  const planModeBanner = new PlanModeBannerComponent(theme.colors);
  const planModeBannerContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  planModeBannerContainer.addChild(planModeBanner);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, theme.colors);
  editor.thinking = initialAppState.thinkingLevel !== 'off';
  editor.thinkingLevel = initialAppState.thinkingLevel;
  const footer = new FooterComponent({ ...initialAppState }, theme.colors, ui, () => {
    ui.requestRender();
  });

  return {
    ui,
    terminal,
    transcriptContainer,
    activityContainer,
    todoPanelContainer,
    todoPanel,
    queueContainer,
    errorBanner,
    errorBannerContainer,
    planModeBanner,
    planModeBannerContainer,
    editorContainer,
    footer,
    editor,
    theme,
    appState: { ...initialAppState },
    startupState: 'pending',
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    activitySpinner: null,
    pulseWave: null,
    toolOutputExpanded: false,
    planExpanded: false,
    sessions: [],
    loadingSessions: false,
    activeDialog: null,
    tasksBrowser: undefined,
    externalEditorRunning: false,
    queuedMessages: [],
    fdPath: detectFdPath(),
    gitLsFilesCache: createGitLsFilesCache(initialAppState.workDir),
    renderBatcher,
  };
}
