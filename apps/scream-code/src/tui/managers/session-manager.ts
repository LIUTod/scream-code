import type {
  ApprovalRequest,
  ApprovalResponse,
  CreateSessionOptions,
  ScreamHarness,
  Session,
  SessionSummary,
} from '@scream-code/scream-code-sdk';
import { normalizeWorkDir } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { getLlmNotSetMessage, MAIN_AGENT_ID, getNoActiveSessionMessage } from '../constant/scream-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { isBusy } from '../utils/app-state';
import { sessionRowsForPicker } from '../utils/session-picker-rows';
import { syncDiagramCapabilityPrompt } from '../utils/terminal-diagram-prompt';
import { refreshProviderBalance } from '../api-balance';
import { createApprovalRequestHandler } from '../reverse-rpc/approval/handler';
import { createQuestionAskHandler } from '../reverse-rpc/question/handler';
import { registerReverseRPCHandlers } from '../reverse-rpc/index';
import type { ApprovalController } from '../reverse-rpc/approval/controller';
import type { QuestionController } from '../reverse-rpc/question/controller';
import type { AppState, PlanModeState, TUIStartupOptions } from '../types';
import { normalizeGoalStatus } from '../types';
import type { TUIState } from '../tui-state';

/**
 * WorkDir-scoped session listing prefetched by the CLI while the loading
 * splash runs. It only supplies candidate ids for the empty-session sweep:
 * every candidate is re-checked against a live listing before deletion, and
 * resume decisions never read this snapshot.
 */
export type SessionsPrefetch = Promise<readonly SessionSummary[]>;

/**
 * How recently a session must have been touched for the empty-session pruner
 * to leave it alone. Guards against sweeping a fresh empty session that
 * another terminal is about to use.
 */
const PRUNE_EMPTY_SESSION_GRACE_MS = 5 * 60 * 1000;

/**
 * A session is prunable when it never received a user prompt and never got a
 * title (auto-generated or custom) — i.e. an empty shell left behind by a
 * one-off startup. Archived sessions and sessions touched within the grace
 * window are kept.
 */
export function isPrunableEmptySession(
  summary: Pick<SessionSummary, 'archived' | 'lastPrompt' | 'title' | 'updatedAt'>,
  now: number,
  graceMs: number = PRUNE_EMPTY_SESSION_GRACE_MS,
): boolean {
  if (summary.archived) return false;
  if (summary.lastPrompt !== undefined) return false;
  // A session whose title is the placeholder 'New Session' (the default set
  // at creation in agent-core session/index.ts) is still untitled: it has no
  // real content. The title check must mirror agent-core's isUntitled()
  // semantics, otherwise every brand-new empty session keeps its placeholder
  // title and is never pruned, leaving a growing pile of empty shells.
  if (hasRealTitle(summary.title)) return false;
  return now - summary.updatedAt > graceMs;
}

/** True when the title is a user-meaningful title (not missing / placeholder). */
function hasRealTitle(title: string | undefined): boolean {
  return typeof title === 'string' && title.trim().length > 0 && title !== 'New Session';
}
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
  showApprovalPanel(payload: import('../reverse-rpc/types').ApprovalPanelData): void;
  hideApprovalPanel(): void;
  showQuestionDialog(payload: import('../reverse-rpc/types').QuestionPanelData): void;
  hideQuestionDialog(): void;
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
    /** Session listing prefetched by the shell during the loading splash.
     * Used only as the empty-session prune's candidate enumeration; the
     * deletion decision is made on a live re-check, and resume decisions
     * never read this snapshot. */
    sessionsPrefetch?: SessionsPrefetch | undefined;
  }): Promise<{ session: Session; shouldReplay: boolean }> {
    const { startup, workDir, sessionsPrefetch } = options;
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
        const target = await this.findSessionById(startup.sessionFlag, workDir);
        if (target === undefined) {
          throw new Error(t('session.not_found', { sessionId: startup.sessionFlag }));
        }
        // Indexed workDir values are stored normalized (nearest .git/
        // package.json root); normalize both sides so a nested cwd still
        // matches its own project instead of reporting a false wrong_dir.
        if (normalizeWorkDir(target.workDir) !== normalizeWorkDir(workDir)) {
          throw new Error(
            t('session.wrong_dir', { sessionId: startup.sessionFlag, workDir: target.workDir }),
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
              ? `${this.host.startupNotice}\n${t('session.no_resumable', { workDir })}`
              : t('session.no_resumable', { workDir });
        }
      }
    } else {
      session = await this.host.harness.createSession(createSessionOptions);
    }

    if (session !== undefined && startup.model !== undefined && isResumeStartup) {
      await session.setModel(startup.model);
    }

    if (session === undefined) {
      throw new Error(t('session.init_failed'));
    }
    await this.setSession(session);
    await this.syncRuntimeState(session);

    // Apply CLI startup flags that are not part of CreateSessionOptions.
    // WolfPack is a runtime session mode; set it after the session is live.
    if (startup.wolfpack && !isResumeStartup) {
      await session.setWolfpackMode(true);
    }

    this.host.state.startupState = 'ready';
    // Prune empty sessions (never had a user prompt, never renamed) so the
    // session list does not accumulate one-off empty shells from repeated
    // startups. Best-effort — cleanup failures never block startup.
    await this.pruneEmptySessions(workDir, session.id, sessionsPrefetch);
    // Subscribe to session events for the newly initialized session. This is
    // required for the initial createSession path; resume/switch paths call
    // startSubscription in their own flows.
    this.host.sessionEventHandler.startSubscription();
    return { session, shouldReplay: shouldReplayHistory };
  }

  /**
   * Deletes sessions in this workdir that never received a user prompt and
   * were never renamed — repeated startups otherwise leave a growing pile of
   * one-off empty session shells. The session about to be used is skipped, as
   * are archived sessions, any session that produced a prompt or a title, and
   * any session touched within the grace window (protects a fresh empty
   * session being used from another terminal). The prefetched listing, when
   * present, only enumerates candidates: the snapshot can lag the splash
   * duration, so every candidate is re-checked against a live id lookup and is
   * deleted only if it still looks prunable right now (a session that woke up
   * meanwhile — prompt, rename, new activity — stays). Best-effort: cleanup
   * failures never block startup.
   */
  private async pruneEmptySessions(
    workDir: string,
    currentSessionId: string,
    prefetch?: SessionsPrefetch,
  ): Promise<void> {
    try {
      const now = Date.now();
      // Store summaries carry the normalized root; a raw nested cwd must
      // still match its own bucket (see normalizeWorkDir).
      const normalizedWorkDir = normalizeWorkDir(workDir);
      const candidates = prefetch === undefined
        ? await this.host.harness.listSessions({ workDir })
        : await prefetch;
      for (const summary of candidates) {
        if (summary.id === currentSessionId) continue;
        if (!isPrunableEmptySession(summary, now)) continue;
        // Live re-check: the snapshot may be stale by the whole splash
        // duration, so the deletion decision is made on fresh state only.
        const fresh = await this.host.harness.listSessions({ sessionId: summary.id, workDir });
        const latest = fresh[0];
        if (latest === undefined) continue;
        // An id query falls back to a global lookup; a hit from another
        // workDir must never be deleted by this sweep (compared normalized:
        // the summary carries the normalized root, the sweep gets a raw cwd).
        if (normalizeWorkDir(latest.workDir) !== normalizedWorkDir) continue;
        if (!isPrunableEmptySession(latest, Date.now())) continue;
        // Per-item best-effort janitor: one locked session must not abort
        // the sweep for the rest (explicit user deletes still fail loudly
        // in the dialog paths).
        await this.host.harness.deleteSession(summary.id).catch(() => {});
      }
    } catch (error) {
      this.host.showStatus(`Session cleanup skipped: ${String(error)}`);
    }
  }

  /**
   * Resolve the `--session <id>` target from a live listing (resume decisions
   * never read the prefetched snapshot). The id-filtered form is the only call
   * that can tell "no such session" apart from "session lives in another
   * workDir".
   */
  private async findSessionById(
    sessionId: string,
    workDir: string,
  ): Promise<SessionSummary | undefined> {
    const sessions = await this.host.harness.listSessions({ sessionId, workDir });
    return sessions[0];
  }

  // ---------------------------------------------------------------------------
  // Set / sync
  // ---------------------------------------------------------------------------
  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close({ extractMemories: false });
    this.host.session = session;
    this.registerSessionHandlers(session);
    // The runtime prompt is per-session state, so every time this surface takes
    // a session it has to restate what this terminal can draw — otherwise a
    // switched-to session would either lose the statement or keep one that no
    // longer matches the current `/mermaid` choice.
    await syncDiagramCapabilityPrompt(session);
  }


  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const status = await session.getStatus();
    const goalResult = await session.getGoal().catch(() => ({ goal: null }));
    const goal = goalResult.goal;
    this.host.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinkingLevel: status.thinkingLevel as import('@scream-code/scream-code-sdk').ThinkingEffort,
      planMode: (status.planMode
        ? status.planStrategy === 'fusion' ? 'fusionplan' : 'plan'
        : 'off') as PlanModeState,
      wolfpackMode: status.wolfpackMode,
      rlmEnabled: status.rlmEnabled,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      // Seed the per-session HitR with the session's durable turn-scoped usage
      // (restored from the wire log on resume) so it survives process restarts.
      // When absent (fresh session) the sessionChanged reset keeps it at zero
      // and the footer renders "--".
      ...(status.usage?.turnTotal !== undefined ? { sessionUsage: status.usage.turnTotal } : {}),
      sessionTitle: session.summary?.title ?? null,
      goal: goal ? {
        objective: goal.objective,
        status: normalizeGoalStatus(goal.status),
        turnsUsed: goal.turnsUsed ?? 0,
        wallClockMs: goal.wallClockMs ?? 0,
        wallClockBaseAt: Date.now(),
        completionCriterion: goal.completionCriterion ?? null,
        tokensUsed: goal.tokensUsed ?? 0,
        inputTokens: goal.inputTokens ?? null,
        outputTokens: goal.outputTokens ?? null,
      } : null,
      goalActive: goal?.status === 'active',
      goalJudge: 'awaiting',
      goalContinuationCount: 0,
      // Clear any balance from a previous session/provider; the lookup
      // below commits the fresh value asynchronously.
      providerBalance: null,
    });
    // Kick off a provider balance lookup once the model is known at
    // startup / session restore; the footer renders it when it lands.
    refreshProviderBalance(status.model ?? '', (patch) => this.host.setAppState(patch));
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
    await previous?.close({ extractMemories: false });
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
    // Re-register reverse RPC UI hooks after they were cleared by
    // clearReverseRpcPanels() during session switch.
    if (this.host.reverseRpcDisposers.length === 0) {
      this.host.reverseRpcDisposers.push(
        ...registerReverseRPCHandlers(this.host.approvalController, this.host.questionController, {
          showApprovalPanel: (payload) => {
            this.host.showApprovalPanel(payload);
          },
          hideApprovalPanel: () => {
            this.host.hideApprovalPanel();
          },
          showQuestionDialog: (payload) => {
            this.host.showQuestionDialog(payload);
          },
          hideQuestionDialog: () => {
            this.host.hideQuestionDialog();
          },
        }),
      );
    }
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
  async resumeSession(targetSessionId: string): Promise<{ switched: boolean; session?: Session; blocked?: boolean }> {
    if (targetSessionId === this.host.state.appState.sessionId) {
      this.host.showStatus(t('session.already_in'));
      return { switched: true };
    }
    if (isBusy(this.host.state.appState)) {
      this.host.showError(t('session.switch_streaming'));
      // blocked: the refusal is transient state, not "session missing" —
      // callers (cc-connect picker) must not treat it as a reason to create
      // and force-switch to a new session mid-stream.
      return { switched: false, blocked: true };
    }
    if (this.host.state.appState.isReplaying) {
      this.host.showError(t('session.switch_replaying'));
      return { switched: false, blocked: true };
    }

    let session: Session;
    try {
      session = await this.host.harness.resumeSession({ id: targetSessionId });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(t('session.resume_failed', { sessionId: targetSessionId, msg }));
      return { switched: false };
    }

    await this.switchToSession(session, t('session.resumed', { sessionId: session.id }));
    return { switched: true };
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    if (this.host.state.appState.isSwitchingSession) {
      return;
    }
    this.host.setAppState({ isSwitchingSession: true });
    try {
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
        this.host.showError(t('session.replay_failed', { msg }));
      } finally {
        this.host.sessionEventHandler.startSubscription();
      }
      const resumeState = session.getResumeState();
      if (resumeState?.warning !== undefined) {
        this.host.showStatus(t('session.resume_warning', { warning: resumeState.warning }), this.host.state.theme.colors.warning);
      }
      this.host.showStatus(statusMessage);
    } finally {
      this.host.setAppState({ isSwitchingSession: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Create new
  // ---------------------------------------------------------------------------
  async createNewSession(): Promise<void> {
    if (this.host.state.appState.isReplaying) {
      this.host.showError(t('session.new_replaying'));
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(t('session.new_failed', { msg }));
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
      this.host.showError(t('session.setup_failed', { msg }));
      return;
    }
    try {
      await this.host.refreshSkillCommands(this.host.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.host.sessionEventHandler.startSubscription();
    this.host.clearTranscriptAndRedraw();
    this.host.showStatus(t('session.new_started', { sessionId: session.id }));
  }

  private async createSessionFromCurrentState(): Promise<Session> {
    const model = this.host.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(getLlmNotSetMessage());
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
    this.host.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 0 });
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
      throw new Error(getNoActiveSessionMessage());
    }
    return this.host.session;
  }
}
