import {
  Container,
  ProcessTerminal,
  TUI,
} from '@earendil-works/pi-tui';

import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import type { PulseWaveLoader } from './components/chrome/pulse-wave-loader';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { CHROME_GUTTER } from './constant/rendering';
import type { TasksBrowserState } from './controllers/tasks-browser';
import { createScreamTUIThemeBundle, type ScreamTUIThemeBundle } from './theme/bundle';
import { createTerminalState, type TerminalState } from './utils/terminal-state';
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
}

export function createTUIState(options: ScreamTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = createScreamTUIThemeBundle(initialAppState.theme, options.resolvedTheme);

  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);

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
      console.error('[scream-code] render error:', error);
    }
  };

  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent(theme.colors);
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, theme.colors);
  editor.thinking = initialAppState.thinking;
  const footer = new FooterComponent({ ...initialAppState }, theme.colors, () => {
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
  };
}
