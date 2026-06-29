import type {
  ApprovalRequest,
  ApprovalResponse,
  CreateSessionOptions,
  ScreamHarness,
  Session,
} from '@scream-code/scream-code-sdk';
import { LLM_NOT_SET_MESSAGE, MAIN_AGENT_ID, NO_ACTIVE_SESSION_MESSAGE } from '../constant/scream-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { isBusy } from '../utils/app-state';
import { sessionRowsForPicker } from '../utils/session-picker-rows';
import { createApprovalRequestHandler } from '../reverse-rpc/approval/handler';
import { createQuestionAskHandler } from '../reverse-rpc/question/handler';
import type { ApprovalController } from '../reverse-rpc/approval/controller';
import type { QuestionController } from '../reverse-rpc/question/controller';
import type { AppState, PlanModeState, TUIStartupOptions } from '../types';
import type { TUIState } from '../tui-state';
import type { SessionEventHandler } from '../controllers/session-event-handler';
import type { SessionReplayRenderer } from '../controllers/session-replay';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';

/**
 * Interface exposing only the ScreamTUI surface that SessionManager needs.
 * Keeps the dependency explicit and testable.
 */
export interface SessionManagerHost {
  readonly harness: ScreamHarness;
  readonly state: TUIState;
  session: Session | undefined;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  readonly reverseRpcDisposers: Array<() => void>;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly streamingUI: StreamingUIController;
  readonly tasksBrowserController: TasksBrowserController;
  startupNotice: string | undefined;

  showError(message: string): void;
  showStatus(message: string, color?: string): void;
  setAppState(patch: Partial<AppState>): void;
  clearTranscriptAndRedraw(): void;
  refreshSkillCommands(session?: Session): Promise<void>;
  refreshSessionTitle(): void;
  updateQueueDisplay(): void;
  appendApprovalTranscriptEntry(request: ApprovalRequest, response: ApprovalResponse): void;
  hasSessionContent(): boolean;
  stopMemoryIdleTimer(): void;
}

/**
 * Encapsulates all session lifecycle operations:
 * create / resume / switch / close / sync state / reset runtime.
 */
export class SessionManager {
  constructor(private readonly host: SessionManagerHost) {}

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  async init(options: {
    startup: TUIStartupOptions;
    workDir: string;
  }): Promise<{ session: Session; shouldReplay: boolean }> {
    const { startup, workDir } = options;
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
        this.host.state.startupState = 'picker';
        throw new Error('picker'); // special sentinel caught by caller
      }

      if (startup.sessionFlag !== undefined) {
        const sessions = await this.host.harness.listSessions({
          sessionId: startup.sessionFlag,
          workDir,
        });
        const target = sessions[0];
        if (target === undefined) {
          throw new Error(`未找到会话 "${startup.sessionFlag}"。`);
        }
        if (target.workDir !== workDir) {
          throw new Error(
            `会话 "${startup.sessionFlag}" 是在其他目录下创建的。\n  cd "${target.workDir}" && scream -r ${startup.sessionFlag}`,
          );
        }
        session = await this.host.harness.resumeSession({ id: startup.sessionFlag });
        shouldReplayHistory = true;
      } else {
        const sessions = await this.host.harness.listSessions({ workDir });
        const target = sessions[0];
        if (target !== undefined) {
          session = await this.host.harness.resumeSession({ id: target.id });
          shouldReplayHistory = true;
        } else {
          session = await this.host.harness.createSession(createSessionOptions);
          this.host.startupNotice =
            this.host.startupNotice !== undefined
              ? `${this.host.startupNotice}\n"${workDir}" 下没有可继续的会话；正在启动新会话。`
              : `"${workDir}" 下没有可继续的会话；正在启动新会话。`;
        }
      }
    } else {
      session = await this.host.harness.createSession(createSessionOptions);
    }

    if (session !== undefined && startup.model !== undefined && isResumeStartup) {
      await session.setModel(startup.model);
    }

    if (session === undefined) {
      throw new Error('启动会话未初始化。');
    }
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.host.state.startupState = 'ready';
    // Subscribe to session events for the newly initialized session. This is
    // required for the initial createSession path; resume/switch paths call
    // startSubscription in their own flows.
    this.host.sessionEventHandler.startSubscription();
    return { session, shouldReplay: shouldReplayHistory };
  }

  // ---------------------------------------------------------------------------
  // Set / sync
  // ---------------------------------------------------------------------------
  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close({ extractMemories: false });
    this.host.session = session;
    this.registerSessionHandlers(session);
  }

  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const status = await session.getStatus();
    const goalResult = await session.getGoal().catch(() => ({ goal: null }));
    const goal = goalResult.goal;
    this.host.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinkingLevel: status.thinkingLevel as import('@scream-code/scream-code-sdk').ThinkingEffort,
      planMode: (status.planMode ? 'plan' : 'off') as PlanModeState,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      sessionTitle: session.summary?.title ?? null,
      goal: goal?.objective ?? null,
      goalActive: goal?.status === 'active',
      goalContinuationCount: 0,
    });
  }

  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.host.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  // ---------------------------------------------------------------------------
  // Close / unload
  // ---------------------------------------------------------------------------
  async closeSession(reason?: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason ?? 'closing');
    await previous?.close();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.host.session;
    this.host.sessionEventUnsubscribe?.();
    this.host.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.host.approvalController.cancelAll(reason);
    this.host.questionController.cancelAll(reason);
    this.host.session = undefined;
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.host.reverseRpcDisposers) {
      dispose();
    }
    this.host.reverseRpcDisposers.length = 0;
  }

  private registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(this.host.approvalController, (request, response) => {
        this.host.appendApprovalTranscriptEntry(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.host.questionController));
  }

  // ---------------------------------------------------------------------------
  // List / fetch
  // ---------------------------------------------------------------------------
  async fetchSessions(): Promise<void> {
    this.host.state.loadingSessions = true;
    try {
      const sessions = await this.host.harness.listSessions({});
      this.host.state.sessions = sessionRowsForPicker(
        sessions,
        this.host.state.appState.sessionId,
        this.host.hasSessionContent(),
      );
    } catch {
      /* silently ignore */
    } finally {
      this.host.state.loadingSessions = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Resume / switch
  // ---------------------------------------------------------------------------
  async resumeSession(targetSessionId: string): Promise<{ switched: boolean; session?: Session }> {
    if (targetSessionId === this.host.state.appState.sessionId) {
      this.host.showStatus('已在该会话中。');
      return { switched: true };
    }
    if (isBusy(this.host.state.appState)) {
      this.host.showError('流式传输期间无法切换会话 — 请先按 Esc 或 Ctrl-C。');
      return { switched: false };
    }
    if (this.host.state.appState.isReplaying) {
      this.host.showError('历史回放期间无法切换会话。');
      return { switched: false };
    }

    let session: Session;
    try {
      session = await this.host.harness.resumeSession({ id: targetSessionId });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`恢复会话 ${targetSessionId} 失败：${msg}`);
      return { switched: false };
    }

    await this.switchToSession(session, `已恢复会话 (${session.id})。`);
    return { switched: true };
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.host.refreshSessionTitle();
    try {
      await this.host.refreshSkillCommands(this.host.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.host.clearTranscriptAndRedraw();
    try {
      await this.host.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`重放会话历史失败：${msg}`);
    } finally {
      this.host.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.host.showStatus(`警告：${resumeState.warning}`, this.host.state.theme.colors.warning);
    }
    this.host.showStatus(statusMessage);
  }

  // ---------------------------------------------------------------------------
  // Create new
  // ---------------------------------------------------------------------------
  async createNewSession(): Promise<void> {
    if (this.host.state.appState.isReplaying) {
      this.host.showError('历史回放期间无法启动新会话。');
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`启动新会话失败：${msg}`);
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.host.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.host.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.host.showError(`创建后设置失败：${msg}`);
      return;
    }
    try {
      await this.host.refreshSkillCommands(this.host.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.host.sessionEventHandler.startSubscription();
    this.host.clearTranscriptAndRedraw();
    this.host.showStatus(`已启动新会话 (${session.id})。`);
  }

  private async createSessionFromCurrentState(): Promise<Session> {
    const model = this.host.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(LLM_NOT_SET_MESSAGE);
    }
    return this.host.harness.createSession({
      workDir: this.host.state.appState.workDir,
      model,
      thinking:
        this.host.session === undefined
          ? undefined
          : this.host.state.appState.thinkingLevel === 'off'
            ? 'off'
            : this.host.state.appState.thinkingLevel,
      permission: this.host.state.appState.permissionMode,
      planMode: this.host.state.appState.planMode !== 'off' ? true : undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  resetSessionRuntime(): void {
    this.host.state.queuedMessages = [];
    this.host.harness.interactiveAgentId = MAIN_AGENT_ID;
    this.host.streamingUI.discardPending();
    this.host.streamingUI.resetToolCallState();
    this.host.streamingUI.resetToolUi();
    this.host.sessionEventHandler.resetRuntimeState();
    this.host.tasksBrowserController.close();
    this.host.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.host.streamingUI.setTodoList([]);
    this.host.streamingUI.setTurnId(undefined);
    this.host.streamingUI.setStep(0);
    this.host.streamingUI.resetLiveText();
    this.host.updateQueueDisplay();
    this.host.stopMemoryIdleTimer();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private requireSession(): Session {
    if (this.host.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.host.session;
  }
}
