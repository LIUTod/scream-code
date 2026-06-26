import {
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui';
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  ScreamHarness,
  PermissionMode,
  Session,
} from '@scream-code/scream-code-sdk';
import type { CLIOptions } from '#/cli/options';

import {
  BUILTIN_SLASH_COMMANDS,
  buildSkillSlashCommands,
  isExperimentalFlagEnabled,
  setExperimentalFlags,
  sortSlashCommands,
  type ScreamSlashCommand,
  type SkillListSession,
} from './commands';

import type { HelpPanelCommand } from './components/dialogs/help-panel';
import { AuthFlowController } from './controllers/auth-flow';
import { EditorKeyboardController } from './controllers/editor-keyboard';
import { SessionEventHandler } from './controllers/session-event-handler';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StreamingUIController } from './controllers/streaming-ui';
import { TasksBrowserController } from './controllers/tasks-browser';
import { TranscriptController, type TranscriptControllerHost } from './controllers/transcript-controller';
import { LifecycleController, type LifecycleControllerHost } from './controllers/lifecycle-controller';
import { InputController, type InputControllerHost } from './controllers/input-controller';
import type { TuiConfig } from './config';
import {
  NO_ACTIVE_SESSION_MESSAGE,
} from './constant/scream-tui';

import { readUpdateCache } from '#/cli/update/cache';
import { refreshUpdateCache } from '#/cli/update/refresh';
import { selectUpdateTarget } from '#/cli/update/select';

import { ApprovalController } from './reverse-rpc/approval/controller';
import { registerReverseRPCHandlers } from './reverse-rpc/index';
import { QuestionController } from './reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types';
import type { ResolvedTheme } from './theme/colors';
import type { Theme } from './theme/index';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type LoginProgressSpinnerHandle,
  type ScreamTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import { createTUIState, type TUIState } from './tui-state';
import { formatErrorMessage } from './utils/event-payload';
import { ImageAttachmentStore } from './utils/image-attachment-store';
import { hasPatchChanges } from './utils/object-patch';
import { setProcessTitle } from './utils/proctitle';
import type { SessionRow } from './components/dialogs/session-picker';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import { SessionManager } from './managers/session-manager';
import { DialogManager } from './managers/dialog-manager';

export type { TUIState } from './tui-state';
export { createTUIState } from './tui-state';

export type {
  ScreamTUIOptions,
  TUIStartupOptions,
  TUIStartupState,
} from './types';
export interface ScreamTUIStartupInput {
  readonly cliOptions: CLIOptions;
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  readonly resolvedTheme?: ResolvedTheme;
}

function createInitialAppState(input: ScreamTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    sessionId: '',
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    livePaneMode: 'idle',
    theme: input.tuiConfig.theme,
    version: input.version,
    hasNewVersion: false,
    latestVersion: null,
    editorCommand: input.tuiConfig.editorCommand,
    notifications: input.tuiConfig.notifications,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    goalActive: false,
    goalContinuationCount: 0,
    ccConnectActive: false,
    wolfpackMode: false,
    recentSessions: [],
  };
}

export class ScreamTUI implements TranscriptControllerHost, LifecycleControllerHost, InputControllerHost {
  readonly harness: ScreamHarness;
  readonly options: ScreamTUIOptions;
  session: Session | undefined;
  state: TUIState;
  readonly approvalController = new ApprovalController();
  readonly questionController = new QuestionController();
  private skillCommands: readonly ScreamSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  readonly imageStore = new ImageAttachmentStore();
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private isShuttingDown = false;
  readonly reverseRpcDisposers: Array<() => void> = [];
  startupNotice: string | undefined;
  readonly sessionManager: SessionManager;
  readonly dialogManager: DialogManager;
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly editorKeyboard: EditorKeyboardController;
  readonly transcriptController: TranscriptController;
  readonly lifecycleController: LifecycleController;
  readonly inputController: InputController;

  public onExit?: (exitCode?: number) => Promise<void>;


  constructor(harness: ScreamHarness, startupInput: ScreamTUIStartupInput) {
    this.harness = harness;
    const tuiOptions: ScreamTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
      startup: {
        sessionFlag: startupInput.cliOptions.session,
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        auto: startupInput.cliOptions.auto,
        plan: startupInput.cliOptions.plan,
        model: startupInput.cliOptions.model,
        startupNotice: startupInput.startupNotice,
      },
      resolvedTheme: startupInput.resolvedTheme,
    };
    this.options = tuiOptions;
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(tuiOptions);

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(this.approvalController, this.questionController, {
        showApprovalPanel: (payload) => {
          this.showApprovalPanel(payload);
        },
        hideApprovalPanel: () => {
          this.hideApprovalPanel();
        },
        showQuestionDialog: (payload) => {
          this.showQuestionDialog(payload);
        },
        hideQuestionDialog: () => {
          this.hideQuestionDialog();
        },
      }),
    );
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.sessionManager = new SessionManager(this);
    this.dialogManager = new DialogManager(this);
    this.transcriptController = new TranscriptController(this);
    this.lifecycleController = new LifecycleController(this);
    this.inputController = new InputController(this);
    this.lifecycleController.buildLayout();
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  getSlashCommands(): readonly ScreamSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter((command) =>
      isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands];
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      this.skillCommands = [];
      this.skillCommandMap.clear();
      this.inputController.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    const builtinNames = new Set(
      BUILTIN_SLASH_COMMANDS.flatMap((cmd) => [cmd.name, ...cmd.aliases]),
    );
    const skillCommands = buildSkillSlashCommands(skills, builtinNames);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.inputController.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle (delegated to LifecycleController)
  // =========================================================================

  async start(): Promise<void> {
    this.lifecycleController.installSignalHandlers();
    try {
      const shouldReplayHistory = await this.initMainTui();
      this.lifecycleController.startEventLoop();
      try {
        await this.finishStartup(shouldReplayHistory);
        this.lifecycleController.startCcConnectPolling();
      } catch (error) {
        this.lifecycleController.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.lifecycleController.uninstallSignalHandlers();
      throw error;
    }
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    // Load recent sessions for the welcome screen.
    try {
      const sessions = await this.harness.listSessions({ workDir: this.state.appState.workDir });
      this.state.appState.recentSessions = sessions.slice(0, 3).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      }));
    } catch {
      this.state.appState.recentSessions = [];
    }

    // Mount only after init() succeeds; see mountFooter().
    this.lifecycleController.mountFooter();
    this.transcriptController.renderWelcome();
    setExperimentalFlags(await this.harness.getExperimentalFlags());
    this.inputController.setupAutocomplete();
    void this.inputController.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    return shouldReplayHistory;
  }

  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    if (this.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) {
      await this.sessionReplay.hydrateFromReplay(this.requireSession());
    }
    const resumeState = this.session?.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`警告：${resumeState.warning}`, this.state.theme.colors.warning);
    }
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
    }
    void this.fetchSessions();
    if (this.session !== undefined) {
      this.refreshSessionTitle();
    }
    void this.refreshSkillCommands(this.session);
    void this.checkForUpdates();
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, this.state.theme.colors.warning);
  }

  private async init(): Promise<boolean> {
    await this.authFlow.refreshAvailableModels();
    try {
      const { shouldReplay } = await this.sessionManager.init({
        startup: this.options.startup,
        workDir: this.state.appState.workDir,
      });
      return shouldReplay;
    } catch (error) {
      if (error instanceof Error && error.message === 'picker') {
        return false;
      }
      throw error;
    }
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.lifecycleController.stopCcConnectPolling();
    this.lifecycleController.uninstallSignalHandlers();
    this.aborted = true;
    // Cancel any in-flight operation (e.g. OAuth login flow) before teardown.
    this.cancelInFlight?.();
    this.cancelInFlight = undefined;
    this.streamingUI.discardPending();
    this.editorKeyboard.clearPendingExit();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.lifecycleController.disposeTerminalTracking();
    this.inputController.dispose();
    this.showStatus('正在整理会话记忆...', this.state.theme.colors.textDim);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await this.closeSession();
    await this.harness.close();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.state.ui.stop();
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  markMemoryExtracted(): void {
    this.lifecycleController.markMemoryExtracted();
  }

  /** Called by StreamingUIController when a turn finishes with no queued continuations. */
  onTurnCompleted(): void {
    this.lifecycleController.onTurnCompleted();
  }

  /** Trigger an immediate cc-connect liveness poll. Called by /cc after start/stop/restart. */
  refreshCcStatus(): void {
    this.lifecycleController.refreshCcStatus();
  }

  refreshTerminalThemeTracking(): void {
    this.lifecycleController.refreshTerminalThemeTracking();
  }

  applyResolvedAutoTheme(resolved: ResolvedTheme): void {
    if (this.state.appState.theme !== 'auto') return;
    if (this.state.theme.resolvedTheme === resolved) return;
    this.applyTheme('auto', resolved);
  }

  onEmergencyExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.lifecycleController.uninstallSignalHandlers();
    process.exit(exitCode);
  }

  stopMemoryIdleTimer(): void {
    this.lifecycleController.stopMemoryIdleTimer();
  }

  registerSignalHandlers(): void {
    this.lifecycleController.installSignalHandlers();
  }

  unregisterSignalHandlers(): void {
    this.lifecycleController.uninstallSignalHandlers();
  }

  emergencyTerminalExit(exitCode?: number): never {
    this.onEmergencyExit(exitCode);
  }

  // =========================================================================
  // Input Dispatch (delegated to InputController)
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    this.inputController.handlePlanToggle(next);
  }

  sendNormalUserInput(text: string): void {
    this.inputController.sendNormalUserInput(text);
  }

  steerMessage(session: Session, input: string[]): void {
    this.inputController.steerMessage(session, input);
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  beginSessionRequest(): void {
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();

    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    this.inputController.sendQueuedMessage(session, item);
  }

  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    this.beginSessionRequest();
    void session.activateSkill(skillName, skillArgs).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Skill "${skillName}" 执行失败：${message}`);
    });
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = 'ready';
  }

  clearQueuedMessages(): void {
    this.state.queuedMessages = [];
  }

  recallLastQueued(): string | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const last = this.state.queuedMessages.at(-1)!;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    return last.text;
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const [first, ...rest] = this.state.queuedMessages;
    this.state.queuedMessages = rest;
    return first;
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
  }

  cancelPendingMemoryExtraction(): void {
    this.lifecycleController.cancelPendingMemoryExtraction();
  }

  setTasksBrowser(value: TUIState['tasksBrowser']): void {
    this.state.tasksBrowser = value;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice =
      this.startupNotice !== undefined ? `${this.startupNotice}\n${extra}` : extra;
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  getCurrentWorkDir(): string {
    return this.state.appState.workDir;
  }

  getSessions(): SessionRow[] {
    return this.state.sessions;
  }

  getIsLoadingSessions(): boolean {
    return this.state.loadingSessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (sessionId === this.session?.id) {
      await this.sessionManager.closeSession('session deleted');
    }
    await this.harness.deleteSession(sessionId);
  }

  async getStartupMcpMs(): Promise<number> {
    const session = this.session;
    if (session === undefined) return 0;
    try {
      const metrics = await session.getMcpStartupMetrics();
      return metrics.durationMs;
    } catch {
      return 0;
    }
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    if ('thinking' in patch) {
      this.state.editor.thinking = patch.thinking ?? false;
    }
    // Stop the welcome breathing animation once the first message is sent —
    // the panel scrolls off-screen but the 40 ms timer keeps firing
    // requestRender, causing flicker and broken scroll.
    if ('streamingPhase' in patch && patch.streamingPhase !== 'idle') {
      this.transcriptController.stopWelcomeBreathing();
    }
    this.state.footer.setState(this.state.appState);
    this.lifecycleController.updateActivityPane();
    if (busyChanged) this.inputController.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    if ('mode' in patch) {
      this.state.appState.livePaneMode = patch.mode!;
      this.state.footer.setState(this.state.appState);
    }
    this.lifecycleController.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.lifecycleController.updateActivityPane();
    this.state.ui.requestRender();
  }

  // =========================================================================
  // Session Runtime
  // =========================================================================

  requireSession(): Session {
    if (this.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.session;
  }

  async setSession(session: Session): Promise<void> {
    await this.sessionManager.setSession(session);
  }

  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    await this.sessionManager.syncRuntimeState(session);
  }

  async closeSession(): Promise<void> {
    await this.sessionManager.closeSession();
  }

  async fetchSessions(): Promise<void> {
    await this.sessionManager.fetchSessions();
  }

  private async checkForUpdates(): Promise<void> {
    try {
      // Refresh from GitHub Releases API first so we always have a fresh
      // cache before comparing.  Errors (network offline, rate-limited) are
      // swallowed — the stale cache is still usable as a fallback.
      await refreshUpdateCache().catch(() => {});
      const cache = await readUpdateCache();
      const target = selectUpdateTarget(this.state.appState.version, cache.latest);
      if (target !== null) {
        this.setAppState({ hasNewVersion: true, latestVersion: target.version });
      }
    } catch {
      /* silently ignore */
    }
  }

  refreshSessionTitle(): void {
    setProcessTitle(this.state.appState.sessionTitle, this.state.appState.sessionId);
  }

  resetSessionRuntime(): void {
    this.sessionManager.resetSessionRuntime();
  }

  /**
   * Pin the editor + footer to the terminal bottom. The pi-tui patch adds a
   * `fixedBottomLineCount` property: the last N rendered lines stay pinned
   * while the transcript above scrolls independently.
   *
   * We override `doRender` to measure the editor + footer height each frame
   * and set the count before the real render runs.
   */

  async resumeSession(targetSessionId: string): Promise<boolean> {
    const result = await this.sessionManager.resumeSession(targetSessionId);
    return result.switched;
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    await this.sessionManager.switchToSession(session, statusMessage);
  }

  async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError('历史回放期间无法启动新会话。');
      return;
    }

    await this.sessionManager.createNewSession();
  }

  // =========================================================================
  // Transcript Rendering (delegated to TranscriptController)
  // =========================================================================

  stopWelcomeBreathing(): void {
    this.transcriptController.stopWelcomeBreathing();
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.transcriptController.appendEntry(entry);
  }

  appendApprovalTranscriptEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    this.transcriptController.appendApprovalEntry(request, response);
  }

  private renderWelcome(): void {
    this.transcriptController.renderWelcome();
  }

  clearTranscriptAndRedraw(): void {
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.transcriptController.clearAndRedraw();
  }

  showStatus(message: string, color?: string): void {
    this.transcriptController.showStatus(message, color);
  }

  showNotice(title: string, detail?: string): void {
    this.transcriptController.showNotice(title, detail);
  }

  showError(message: string): void {
    this.transcriptController.showError(message);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.transcriptController.showProgressSpinner(label);
  }

  updateActivityPane(): void {
    this.lifecycleController.updateActivityPane();
  }

  updateQueueDisplay(): void {
    this.inputController.updateQueueDisplay();
  }

  toggleToolOutputExpansion(): void {
    this.transcriptController.toggleToolOutputExpansion();
  }

  // Returns true when at least one card toggled, so the caller can consume the keystroke.
  togglePlanExpansion(): boolean {
    return this.transcriptController.togglePlanExpansion();
  }

  updateEditorBorderHighlight(text?: string): void {
    this.inputController.updateEditorBorderHighlight(text);
  }

  applyTheme(theme: Theme, resolved?: ResolvedTheme): void {
    this.lifecycleController.applyTheme(theme, resolved);
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  private swapEditor(component: Component & Focusable): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(component);
    this.state.ui.setFocus(component);
    this.state.ui.requestRender();
  }

  mountEditorReplacement(panel: Component & Focusable): void {
    this.swapEditor(panel);
  }

  restoreEditor(): void {
    this.swapEditor(this.state.editor);
  }

  showHelpPanel(): void {
    this.dialogManager.showHelpPanel(this.getSlashCommands() as unknown as readonly HelpPanelCommand[]);
  }

  private hideHelpPanel(): void {
    this.dialogManager.hideHelpPanel();
  }

  async showSessionPicker(): Promise<void> {
    await this.dialogManager.showSessionPicker();
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.dialogManager.showSessionPicker();
  }

  hideSessionPicker(): void {
    this.dialogManager.hideSessionPicker();
  }

  showMemoryPicker(): void {
    this.dialogManager.showMemoryPicker();
  }

  hideMemoryPicker(): void {
    this.dialogManager.hideMemoryPicker();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.dialogManager.showApprovalPanel(payload);
  }

  private hideApprovalPanel(): void {
    this.dialogManager.hideApprovalPanel();
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.dialogManager.showQuestionDialog(payload);
  }

  private hideQuestionDialog(): void {
    this.dialogManager.hideQuestionDialog();
  }

}
