import {
  deleteAllKittyImages,
  type AutocompleteItem,
  type Component,
  type Focusable,
  getCapabilities,
  type SlashCommand,
  Spacer,
} from '@earendil-works/pi-tui';
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CreateSessionOptions,
  ScreamHarness,
  PermissionMode,
  PromptPart,
  Session,
} from '@scream-cli/scream-code-sdk';
import chalk from 'chalk';
import type { GitLsFilesCache } from '#/utils/git/git-ls-files';
import { createGitLsFilesCache } from '#/utils/git/git-ls-files';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { getInputHistoryFile } from '#/utils/paths';
import { detectFdPath } from '#/utils/process/fd-detect';
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

import { GutterContainer } from './components/chrome/gutter-container';
import { CHROME_GUTTER } from './constant/rendering';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader';
import { PulseWaveLoader } from './components/chrome/pulse-wave-loader';
import { WelcomeComponent } from './components/chrome/welcome';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from './components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from './components/dialogs/approval-preview';
import { CompactionComponent } from './components/dialogs/compaction';
import { HelpPanelComponent } from './components/dialogs/help-panel';
import { QuestionDialogComponent } from './components/dialogs/question-dialog';
import { SessionPickerComponent } from './components/dialogs/session-picker';
import { MemoryPickerComponent } from './components/dialogs/memory-picker';
import { formatMemoryMemoForInjection } from './commands/memory';
import { MemoryMemoStore, resolveProjectDir, type MemoryMemoSummary } from '@scream-cli/memory';
import { getDataDir } from '#/utils/paths';
import { AuthFlowController } from './controllers/auth-flow';
import { EditorKeyboardController } from './controllers/editor-keyboard';
import { SessionEventHandler } from './controllers/session-event-handler';
import * as slashCommands from './commands/dispatch';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StreamingUIController } from './controllers/streaming-ui';
import { TasksBrowserController } from './controllers/tasks-browser';
import { FileMentionProvider } from './components/editor/file-mention-provider';
import { AssistantMessageComponent } from './components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from './components/messages/background-agent-status';
import { SkillActivationComponent } from './components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { ThinkingComponent } from './components/messages/thinking';
import { ToolCallComponent } from './components/messages/tool-call';
import { UserMessageComponent } from './components/messages/user-message';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { TuiConfig } from './config';
import {
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  NO_ACTIVE_SESSION_MESSAGE,
} from './constant/scream-tui';

import { readUpdateCache } from '#/cli/update/cache';
import { selectUpdateTarget } from '#/cli/update/select';

import { adaptPanelResponse } from './reverse-rpc/approval/adapter';
import { ApprovalController } from './reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from './reverse-rpc/approval/handler';
import { registerReverseRPCHandlers } from './reverse-rpc/index';
import { QuestionController } from './reverse-rpc/question/controller';
import { createQuestionAskHandler } from './reverse-rpc/question/handler';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types';
import { createScreamTUIThemeBundle } from './theme/bundle';
import type { ResolvedTheme } from './theme/colors';
import type { Theme } from './theme/index';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type ScreamTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import { createTUIState, type TUIState } from './tui-state';
import { isExpandable, isPlanExpandable } from './utils/component-capabilities';
import { isDeadTerminalError } from './utils/dead-terminal';
import { formatErrorMessage } from './utils/event-payload';
import { checkCcConnectActive } from './utils/cc-connect-status';
import { ImageAttachmentStore, type ImageAttachment } from './utils/image-attachment-store';
import { extractMediaAttachments } from './utils/image-placeholder';
import { hasPatchChanges } from './utils/object-patch';
import { setProcessTitle } from './utils/proctitle';
import { sessionRowsForPicker } from './utils/session-picker-rows';
import { installTerminalFocusTracking } from './utils/terminal-focus';
import { notifyTerminalOnce } from './utils/terminal-notification';
import { installTerminalThemeTracking } from './utils/terminal-theme';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import { nextTranscriptId } from './utils/transcript-id';

export type { TUIState } from './tui-state';
export { createTUIState } from './tui-state';
import type { LoginProgressSpinnerHandle } from './types';

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

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';

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
    parallelMode: false,
  };
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

export class ScreamTUI {
  readonly harness: ScreamHarness;
  readonly options: ScreamTUIOptions;
  session: Session | undefined;
  state: TUIState;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly ScreamSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  private readonly fdPath: string | null = detectFdPath();
  private readonly gitLsFilesCache: GitLsFilesCache;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private ccConnectPollTimer: ReturnType<typeof setInterval> | undefined;
  private welcomeComponent: WelcomeComponent | undefined;
  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private lastHistoryContent: string | undefined;
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly editorKeyboard: EditorKeyboardController;

  // The currently-mounted approval panel, if any. Kept so the full-screen
  // preview viewer can restore focus to the exact same instance (and its
  // selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // Active full-screen approval preview. While set, the root UI's normal
  // children are stashed in `savedChildren`; closing restores them.
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        savedChildren: readonly Component[];
        panel: ApprovalPanelComponent;
      }
    | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  track(
    event: string,
    properties?: Parameters<ScreamHarness['track']>[1],
  ): void {
    this.harness.track(event, properties);
  }

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
    this.gitLsFilesCache = createGitLsFilesCache(tuiOptions.initialAppState.workDir);

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
    this.buildLayout();
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  private getSlashCommands(): readonly ScreamSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter((command) =>
      isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands];
  }

  private setupAutocomplete(): void {
    // Hide skill commands from the autocomplete dropdown — they clutter the
    // list (~40 extra entries) and cause rendering ghosting when scrolling.
    // Skills are still invocable by typing the full /skill:<name> manually.
    const visible = this.getSlashCommands().filter((cmd) => !cmd.name.startsWith("skill:"));
    const slashCommands: (AutocompleteItem | SlashCommand)[] = visible.map((cmd) => ({
      value: cmd.name,
      label: `/${cmd.name} — ${cmd.description}`,
    }));
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
      this.gitLsFilesCache,
    );
    this.state.editor.setAutocompleteProvider(provider);
    this.state.editor.onFirstInput = () => this.welcomeComponent?.stopBreathing();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      this.skillCommands = [];
      this.skillCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    // Signal handlers must be installed before raw mode to avoid EIO loops.
    this.registerSignalHandlers();
    // Outer try rolls back signal listeners on startup failure.
    try {
      const shouldReplayHistory = await this.initMainTui();
      this.startEventLoop();
      try {
        await this.finishStartup(shouldReplayHistory);
        this.startCcConnectPolling();
      } catch (error) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    // Mount only after init() succeeds; see mountFooter().
    this.mountFooter();
    this.renderWelcome();
    setExperimentalFlags(await this.harness.getExperimentalFlags());
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    return shouldReplayHistory;
  }

  private startEventLoop(): void {
    this.state.ui.start();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state);
    this.refreshTerminalThemeTracking();
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

    const { startup } = this.options;
    const { workDir } = this.state.appState;
    let session: Session | undefined;
    let shouldReplayHistory = false;
    const isResumeStartup = startup.sessionFlag !== undefined || startup.continueLast;
    const createSessionOptions: CreateSessionOptions = {
      workDir,
      model: startup.model,
      permission: startup.auto ? 'auto' : startup.yolo ? 'yolo' : undefined,
      planMode: startup.plan ? true : undefined,
    };

    if (isResumeStartup) {
      if (startup.sessionFlag === '') {
        this.state.startupState = 'picker';
        return false;
      }

      if (startup.sessionFlag !== undefined) {
        const sessions = await this.harness.listSessions({
          sessionId: startup.sessionFlag,
          workDir,
        });
        const target = sessions[0];
        if (target === undefined) {
          throw new Error(`未找到会话 "${startup.sessionFlag}"。`);
        }
        if (target.workDir !== workDir) {
          this.state.ui.stop();
          process.stderr.write(
            `${chalk.yellow(
              `会话 "${startup.sessionFlag}" 是在其他目录下创建的。\n` +
                `  cd "${target.workDir}" && scream -r ${startup.sessionFlag}`,
            )}\n\n`,
          );
          throw new Error(
            `会话 "${startup.sessionFlag}" 是在其他目录下创建的。`,
          );
        }
        session = await this.harness.resumeSession({ id: startup.sessionFlag });
        shouldReplayHistory = true;
      } else {
        const sessions = await this.harness.listSessions({ workDir });
        const target = sessions[0];
        if (target !== undefined) {
          session = await this.harness.resumeSession({ id: target.id });
          shouldReplayHistory = true;
        } else {
          session = await this.harness.createSession(createSessionOptions);
          this.startupNotice =
            this.startupNotice !== undefined
              ? `${this.startupNotice}\n"${workDir}" 下没有可继续的会话；正在启动新会话。`
              : `"${workDir}" 下没有可继续的会话；正在启动新会话。`;
        }
      }
    } else {
      session = await this.harness.createSession(createSessionOptions);
    }
    if (session !== undefined && startup.model !== undefined && isResumeStartup) {
      await session.setModel(startup.model);
    }

    if (session === undefined) {
      throw new Error('启动会话未初始化。');
    }
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.state.startupState = 'ready';
    return shouldReplayHistory;
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.stopCcConnectPolling();
    this.unregisterSignalHandlers();
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
    this.disposeTerminalTracking();
    await this.closeSession('shutting down');
    await this.harness.close();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.state.ui.stop();
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  private startCcConnectPolling(): void {
    const POLL_INTERVAL_MS = 30_000;
    // First check immediately, then poll.
    void checkCcConnectActive().then((active) => {
      this.setAppState({ ccConnectActive: active });
    });
    this.ccConnectPollTimer = setInterval(() => {
      void checkCcConnectActive().then((active) => {
        this.setAppState({ ccConnectActive: active });
      });
    }, POLL_INTERVAL_MS);
  }

  private stopCcConnectPolling(): void {
    if (this.ccConnectPollTimer !== undefined) {
      clearInterval(this.ccConnectPollTimer);
      this.ccConnectPollTimer = undefined;
    }
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids
  // EIO write-loop that can pin a CPU core). SIGTERM → normal stop().
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.emergencyTerminalExit();
          return;
        }
        // Registering a SIGTERM listener disables Node's default exit(143),
        // so we must reinstate it after stop() or on failure.
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // Exit codes follow POSIX 128+signum: 129 = SIGHUP, 143 = SIGTERM.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  private buildLayout(): void {
    const { ui } = this.state;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.todoPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.editorContainer);
    // Footer is mounted later (mountFooter), not here.
  }

  // Footer is the only chrome with content before a session is ready, so
  // mounting it at construction lets a stray pre-start render leak it to the
  // terminal — e.g. above the error when resuming a missing session. Mount it
  // only once init() succeeds. FooterComponent isn't a Container, so wrap it to
  // pick up the same outer gutter as the panels above.
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    this.state.ui.addChild(footerWrap);
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this, next ? 'on' : 'off');
  }

  handleUserInput(text: string): void {
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError('会话历史正在回放时无法发送输入。');
      return;
    }
    void this.persistInputHistory(text);
    slashCommands.dispatchInput(this, text);
  }

  sendNormalUserInput(text: string): void {
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    const extraction = extractMediaAttachments(text, this.imageStore);
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = this.session;
    if (session === undefined) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  private validateMediaCapabilities(
    extraction: ReturnType<typeof extractMediaAttachments>,
  ): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError('当前模型不支持图片输入。');
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.showError('当前模型不支持视频输入。');
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.state.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): string | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const last = this.state.queuedMessages.at(-1)!;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    return last.text;
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  private enqueueMessage(text: string, options?: SendMessageOptions): void {
    this.state.queuedMessages.push({
      text,
      agentId: this.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
    });
    this.track('input_queue');
  }

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
    this.harness.interactiveAgentId = item.agentId ?? MAIN_AGENT_ID;
    this.sendMessageInternal(session, item.text, {
      parts: item.parts,
      imageAttachmentIds: item.imageAttachmentIds,
    });
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    });

    this.beginSessionRequest();

    // When parallel mode is active, prepend a system instruction that tells
    // the model to prefer FanOut for independent subtasks.  The instruction is
    // only visible to the model — the transcript still shows the user's
    // original message unchanged.
    let modelInput: string | readonly PromptPart[] = options?.parts ?? input;
    if (this.state.appState.parallelMode && options?.parts === undefined) {
      modelInput =
        '[系统指令：当前处于 Agent 优先并行模式。对于文件或目录不重叠的独立子任务，请直接使用 FanOut 工具一次并行派发，不要逐个串行调用 Agent。只有当任务之间有硬依赖或操作同一文件时，才回退到串行 Agent。]\n\n' +
        input;
    }

    void session.prompt(modelInput).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`发送失败：${message}`);
    });
  }

  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    this.beginSessionRequest();
    void session.activateSkill(skillName, skillArgs).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Skill "${skillName}" 执行失败：${message}`);
    });
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    if (
      this.deferUserMessages ||
      this.state.appState.streamingPhase !== 'idle' ||
      this.state.appState.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  steerMessage(session: Session, input: string[]): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      for (const part of input) {
        this.enqueueMessage(part);
      }
      return;
    }
    if (this.state.appState.streamingPhase === 'idle') {
      for (const part of input) {
        this.sendMessageInternal(session, part);
      }
      return;
    }

    for (const part of input) {
      this.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: part,
      });
    }

    void session.steer(input.join('\n\n')).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.showError(`引导失败：${message}`);
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
    // Stop the welcome breathing animation once the first message is sent —
    // the panel scrolls off-screen but the 40 ms timer keeps firing
    // requestRender, causing flicker and broken scroll.
    if ('streamingPhase' in patch && patch.streamingPhase !== 'idle') {
      this.welcomeComponent?.stopBreathing();
    }
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    if ('mode' in patch) {
      this.state.appState.livePaneMode = patch.mode!;
      this.state.footer.setState(this.state.appState);
    }
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
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

  private async createSessionFromCurrentState(): Promise<Session> {
    const model = this.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(LLM_NOT_SET_MESSAGE);
    }
    return this.harness.createSession({
      workDir: this.state.appState.workDir,
      model,
      thinking:
        this.session === undefined ? undefined : this.state.appState.thinking ? 'on' : 'off',
      permission: this.state.appState.permissionMode,
      planMode: this.state.appState.planMode ? true : undefined,
    });
  }

  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
  }

  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const status = await session.getStatus();
    const custom = session.metadata?.['custom'] as Record<string, unknown> | undefined;
    const goalMeta = custom?.['goal'] as
      | { active: boolean; content: string | null; continuationCount: number }
      | undefined;
    this.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinking: status.thinkingLevel !== 'off',
      permissionMode: status.permission,
      planMode: status.planMode,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      sessionTitle: session.summary?.title ?? null,
      goal: goalMeta?.content ?? null,
      goalActive: goalMeta?.active ?? false,
      goalContinuationCount: goalMeta?.continuationCount ?? 0,
    });
  }

  // Plan mode is set by createSession — do not re-enter it here.
  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.harness.setTelemetryContext({ sessionId: null });
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    // Clear the array so session-switch (unloadCurrentSession) doesn't leave
    // stale disposers that would be double-disposed on the next call.
    this.reverseRpcDisposers.length = 0;
  }

  private registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(this.approvalController, (request, response) => {
        this.appendApprovalTranscriptEntry(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.questionController));
  }

  async fetchSessions(): Promise<void> {
    this.state.loadingSessions = true;
    try {
      const sessions = await this.harness.listSessions({});
      this.state.sessions = sessionRowsForPicker(
        sessions,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
    } catch {
      /* silently ignore */
    } finally {
      this.state.loadingSessions = false;
    }
  }

  private async checkForUpdates(): Promise<void> {
    try {
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
    this.aborted = false;
    this.streamingUI.discardPending();
    this.state.queuedMessages = [];
    this.harness.interactiveAgentId = MAIN_AGENT_ID;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus('已在该会话中。');
      return true;
    }
    if (this.state.appState.streamingPhase !== 'idle') {
      this.showError('流式传输期间无法切换会话 — 请先按 Esc 或 Ctrl-C。');
      return false;
    }
    if (this.state.appState.isReplaying) {
      this.showError('历史回放期间无法切换会话。');
      return false;
    }

    let session: Session;
    try {
      session = await this.harness.resumeSession({ id: targetSessionId });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`恢复会话 ${targetSessionId} 失败：${msg}`);
      return false;
    }

    await this.switchToSession(session, `已恢复会话 (${session.id})。`);
    return true;
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.refreshSessionTitle();
    try {
      await this.refreshSkillCommands(this.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`重放会话历史失败：${msg}`);
    } finally {
      this.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`警告：${resumeState.warning}`, this.state.theme.colors.warning);
    }
    this.showStatus(statusMessage);
  }

  async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError('历史回放期间无法启动新会话。');
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`启动新会话失败：${msg}`);
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(`创建后设置失败：${msg}`);
      return;
    }
    try {
      await this.refreshSkillCommands(this.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    this.clearTranscriptAndRedraw();
    this.showStatus(`已启动新会话 (${session.id})。`);
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(
        this.state.theme.colors,
        this.state.ui,
        data.instruction,
      );
      block.markDone(data.tokensBefore, data.tokensAfter);
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        return new UserMessageComponent(entry.content, this.state.theme.colors, images);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          this.state.theme.colors,
        );
      case 'assistant': {
        const component = new AssistantMessageComponent(
          this.state.theme.markdownTheme,
          this.state.theme.colors,
        );
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, this.state.theme.colors, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.theme.colors,
            this.state.ui,
            this.state.theme.markdownTheme,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          if (this.state.planExpanded) tc.setPlanExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            this.state.theme.colors,
          );
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail, this.state.theme.colors)
          : new StatusMessageComponent(entry.content, this.state.theme.colors, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            this.state.theme.colors,
          );
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail, this.state.theme.colors)
          : new StatusMessageComponent(entry.content, this.state.theme.colors, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      this.state.transcriptContainer.addChild(component);
      this.state.ui.requestRender();
    }
  }

  private appendApprovalTranscriptEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    if (request.toolName === 'ExitPlanMode' || request.display.kind === 'plan_review') return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(response.scope === 'session' ? '已批准（当前会话）' : '已批准');
        break;
      case 'rejected':
        parts.push('已拒绝');
        break;
      case 'cancelled':
        parts.push('已取消');
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  private renderWelcome(): void {
    this.welcomeComponent?.stopBreathing();
    const welcome = new WelcomeComponent(this.state.appState, this.state.theme.colors, this.state.ui);
    this.welcomeComponent = welcome;
    // If the editor was already used in this session (e.g. session switch),
    // the welcome onFirstInput hook won't fire again — stop breathing now.
    if (this.state.editor.getText().length > 0) {
      welcome.stopBreathing();
    }
    this.state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  private clearTranscriptAndRedraw(): void {
    this.streamingUI.discardPending();
    this.state.transcriptEntries = [];
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.welcomeComponent?.stopBreathing();
    this.welcomeComponent = undefined;
    this.state.editor.resetFirstInputGate();
    this.state.transcriptContainer.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    this.imageStore.clear();
    this.renderWelcome();
  }

  showStatus(message: string, color?: string): void {
    this.state.transcriptContainer.addChild(
      new StatusMessageComponent(message, this.state.theme.colors, color),
    );
    this.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(
      new NoticeMessageComponent(title, detail, this.state.theme.colors),
    );
    this.state.ui.requestRender();
  }

  showError(message: string): void {
    this.showStatus(`错误：${message}`, this.state.theme.colors.error);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => chalk.hex(this.state.theme.colors.primary)(s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }: { ok: boolean; label: string }) => {
        spinner.stop();
        const tone = ok ? this.state.theme.colors.success : this.state.theme.colors.error;
        const symbol = ok ? '✓' : '✗';
        spinner.setText(chalk.hex(tone)(`${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
    };
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));

    if (
      effectiveMode === this.lastActivityMode &&
      (effectiveMode === 'waiting' || effectiveMode === 'thinking' || effectiveMode === 'tool')
    ) {
      return;
    }

    this.lastActivityMode = effectiveMode;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.stopPulseWave();
        this.state.ui.requestRender();
        return;
      case 'waiting': {
        this.stopActivitySpinner();
        const pulseWave = this.ensurePulseWave();
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            pulseWave,
          }),
        );
        break;
      }
      case 'thinking': {
        this.stopActivitySpinner();
        this.stopPulseWave();
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'working...', (s) =>
          chalk.hex(this.state.theme.colors.primary)(s),
        );
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
          }),
        );
        break;
      }
      case 'tool': {
        this.stopActivitySpinner();
        const pulseWave = this.ensurePulseWave();
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            pulseWave,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        this.stopPulseWave();
        break;
      }
    }
    this.state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.activeDialog === 'session-picker' || this.state.activeDialog === 'memory-picker') return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.state.appState.streamingPhase;
    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.state.queuedMessages;
    if (queued.length === 0) return;

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        colors: this.state.theme.colors,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.streamingPhase !== 'idle',
        canSteerImmediately: !this.deferUserMessages,
      }),
    );
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    for (const child of this.state.transcriptContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(this.state.toolOutputExpanded);
      }
    }
    this.state.ui.requestRender();
  }

  // Returns true when at least one card toggled, so the caller can consume the keystroke.
  togglePlanExpansion(): boolean {
    const next = !this.state.planExpanded;
    let toggled = false;
    for (const child of this.state.transcriptContainer.children) {
      if (isPlanExpandable(child) && child.setPlanExpanded(next)) {
        toggled = true;
      }
    }
    if (!toggled) return false;
    this.state.planExpanded = next;
    this.state.ui.requestRender();
    return true;
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const colorToken =
      this.state.appState.planMode || trimmed.startsWith('/')
        ? this.state.theme.colors.primary
        : this.state.theme.colors.border;
    this.state.editor.borderColor = (s: string) => chalk.hex(colorToken)(s);
    this.state.ui.requestRender();
  }

  applyTheme(theme: Theme, resolved?: ResolvedTheme): void {
    const nextTheme = createScreamTUIThemeBundle(theme, resolved);
    Object.assign(this.state.theme.colors, nextTheme.colors);
    this.state.theme.resolvedTheme = nextTheme.resolvedTheme;
    this.state.theme.styles = nextTheme.styles;
    this.state.theme.markdownTheme = nextTheme.markdownTheme;
    this.setAppState({ theme });
    this.updateEditorBorderHighlight();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (this.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.state, (resolved) => {
      this.applyResolvedAutoTheme(resolved);
    });
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private applyResolvedAutoTheme(resolved: ResolvedTheme): void {
    if (this.state.appState.theme !== 'auto') return;
    if (this.state.theme.resolvedTheme === resolved) return;
    this.applyTheme('auto', resolved);
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private syncTerminalProgress(active: boolean): void {
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === null) {
      const instance = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinner = { instance, style };
      return instance;
    }

    this.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.state.activitySpinner !== null) {
      this.state.activitySpinner.instance.stop();
      this.state.activitySpinner = null;
    }
  }

  private ensurePulseWave(): PulseWaveLoader {
    if (this.state.pulseWave !== null) return this.state.pulseWave;
    const instance = new PulseWaveLoader(this.state.ui, this.state.theme.colors.primary);
    this.state.pulseWave = instance;
    return instance;
  }

  private stopPulseWave(): void {
    if (this.state.pulseWave !== null) {
      this.state.pulseWave.stop();
      this.state.pulseWave = null;
    }
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  mountEditorReplacement(panel: Component & Focusable): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
  }

  restoreEditor(): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.state.ui.requestRender();
  }

  showHelpPanel(): void {
    this.state.activeDialog = 'help';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.getSlashCommands(),
        colors: this.state.theme.colors,
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  private hideHelpPanel(): void {
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  async showSessionPicker(): Promise<void> {
    await this.fetchSessions();
    this.mountSessionPicker(() => {
      this.hideSessionPicker();
    });
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.fetchSessions();
    this.mountSessionPicker(() => {
      this.hideSessionPicker();
      void this.stop();
    });
  }

  hideSessionPicker(): void {
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  async showMemoryPicker(): Promise<void> {
    const store = new MemoryMemoStore(
      resolveProjectDir(getDataDir(), this.state.appState.workDir),
    );
    let memos: MemoryMemoSummary[] = [];
    let total = 0;
    try {
      const result = await store.list({ limit: 50 });
      memos = result.memos;
      total = result.total;
    } catch {
      // show empty list on error
    }

    this.state.activeDialog = 'memory-picker';
    this.mountEditorReplacement(
      new MemoryPickerComponent({
        store,
        memos,
        total,
        loading: false,
        colors: this.state.theme.colors,
        onCancel: () => {
          this.hideMemoryPicker();
        },
        onInject: (memo) => {
          const injection = formatMemoryMemoForInjection(memo);
          this.sendNormalUserInput(injection);
          this.showStatus(`已注入备忘录 #${memo.id}`);
          this.hideMemoryPicker();
        },
      }),
    );
  }

  hideMemoryPicker(): void {
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private mountSessionPicker(onCancel: () => void): void {
    this.state.activeDialog = 'session-picker';
    this.mountEditorReplacement(
      new SessionPickerComponent({
        sessions: this.state.sessions,
        loading: this.state.loadingSessions,
        currentSessionId: this.state.appState.sessionId,
        colors: this.state.theme.colors,
        onSelect: (pickerId: string) => {
          const row = this.state.sessions.find((s) => s.id === pickerId);
          const isCc = row?.metadata?.['source'] === 'cc-connect';
          const realId = isCc
            ? (row!.metadata!['agentSessionId'] as string)
            : pickerId;
          void this.resumeSession(realId).then(async (switched) => {
            if (switched) {
              this.hideSessionPicker();
              return;
            }
            // Resume failed.  For CC sessions the ScreamCode session directory
            // may not exist yet (e.g. cleaned up by an older version).  Create
            // a fresh session with the same ID so CC reconnects correctly.
            if (isCc) {
              try {
                const session = await this.harness.createSession({
                  id: realId,
                  workDir: this.state.appState.workDir,
                  model: this.state.appState.model,
                  permission: this.state.appState.permissionMode,
                });
                await this.switchToSession(session, `已连接 CC 会话 (${session.id})。`);
                this.hideSessionPicker();
              } catch (err) {
                this.showError(`创建会话失败：${formatErrorMessage(err)}`);
              }
            }
          });
        },
        onCancel,
        onDelete: (sessionId: string) => {
          const row = this.state.sessions.find((s) => s.id === sessionId);
          if (row?.metadata?.['source'] === 'cc-connect') {
            // CC sessions are managed by cc-connect; skip deletion.
            this.showStatus('CC 会话由 cc-connect 管理，请在聊天通道中操作。');
            return;
          }
          void this.harness.deleteSession(sessionId).then(async () => {
            await this.fetchSessions();
            if (this.state.sessions.length === 0) {
              this.hideSessionPicker();
            } else if (this.state.activeDialog === 'session-picker') {
              this.mountSessionPicker(onCancel);
            }
          });
        },
      }),
    );
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: 'Scream Code 需要审批',
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      this.state.theme.colors,
      () => {
        this.toggleToolOutputExpansion();
      },
      () => {
        this.togglePlanExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  private hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  // Mounts the full-screen approval preview viewer on top of the current
  // approval panel. Uses the same nested-takeover pattern as
  // openTaskOutputViewer: we snapshot the root container's children, swap
  // in the viewer, and restore on close. The approval panel instance is
  // kept around in `activeApprovalPanel` so its selection state survives.
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const savedChildren = [...this.state.ui.children];
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        colors: this.state.theme.colors,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    this.state.ui.clear();
    this.state.ui.addChild(viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, savedChildren, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    this.state.ui.clear();
    for (const child of preview.savedChildren) {
      this.state.ui.addChild(child);
    }
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: 'Scream Code 需要您的回答',
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      this.state.theme.colors,
      undefined,
      () => {
        this.toggleToolOutputExpansion();
      },
      () => {
        this.togglePlanExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }

}
