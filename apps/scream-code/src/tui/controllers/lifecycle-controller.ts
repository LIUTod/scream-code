import type { Session, ScreamHarness, TokenUsage } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { Container, HStack, ScrollView, VStack } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { composeTipLabel, pickTipIndex } from '../utils/tip-hyperlink';
import { GutterContainer } from '../components/chrome/gutter-container';
import { isEmptySessionHintDismissed } from '../utils/ui-preferences';
import { SESSION_TIPS, TIP_ROTATION_INTERVAL_MS } from '../constant/scream-tui';
import { StatusBarPaneComponent, type StatusChipLine } from '../components/panes/status-bar-pane';
import { NoticeBoard } from '../utils/notice-board';
import { workState } from '../utils/status-text';
import { ScrollCue } from '../utils/scroll-cue';
import {
  SIDEBAR_MIN_VIEWPORT_WIDTH,
  type SidebarData,
  type SidebarGoalData,
  type SidebarJobsData,
  type SidebarSessionStats,
} from '../components/sidebar/session-status';
import { createGitStatusCache, type GitStatusCache } from '#/utils/git/git-status';
import {
  CHROME_GUTTER,
  DOCK_FOOTER_ROWS,
  DOCK_STATUS_ROWS,
  STATUS_ROW_MIN_WIDTH,
  TODO_PANEL_MIN_WIDTH,
} from '../constant/rendering';
import { USER_MESSAGE_BULLET } from '../constant/symbols';
import type { AuthFlowController } from './auth-flow';
import type { SessionEventHandler } from './session-event-handler';
import type { SessionReplayRenderer } from './session-replay';
import type { StreamingUIController } from './streaming-ui';
import type { TranscriptController } from './transcript-controller';
import type { SessionManager } from '../managers/session-manager';
import { createScreamTUIThemeBundle } from '../theme/bundle';
import type { ResolvedTheme } from '../theme/colors';
import type { Theme } from '../theme/index';
import type { AppState, ScreamTUIOptions } from '../types';
import type { TUIState } from '../tui-state';
import { ensureBackgroundForJobs, readJobsFooterStatus, type JobsFooterStatus } from '../utils/jobs-status';
import { readLineFooterStatus } from '../utils/line-status';
import { isDeadTerminalError } from '../utils/dead-terminal';
import { isStreaming } from '../utils/app-state';
import { installTerminalFocusTracking } from '../utils/terminal-focus';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { readActivitySince } from '#/host/activity';
import { restartStaleBackground } from '#/host/stale-build';
import { getVersion } from '#/cli/version';
import { hostShowsDesktopNotifications } from '#/host/desktop-notify';
import { readHostSettings } from '#/host/settings';
import { installTerminalThemeTracking } from '../utils/terminal-theme';
import { resolveWaveColor, WAVE_YELLOW_AT_MS } from '../utils/wave-color';
import { PulseWaveLoader } from '../components/chrome/pulse-wave-loader';
import { type ActivityPaneMode } from '../components/panes/activity-pane';

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'blocked';

export type McpNoticeKind = 'progress' | 'failed' | 'needs-auth';

/** Wording used for the retry reason in the status bar. */
type ReconnectReasonKey =
  | 'status.reason_rate_limit'
  | 'status.reason_server'
  | 'status.reason_timeout'
  | 'status.reason_connection';

/**
 * Reason label for the status-bar reconnect line.
 *
 * The structured `errorCode` carried by the retry event is authoritative. The
 * status-code and error-name checks are the fallback for retry records written
 * before that field existed — and for codes this label has no wording for.
 */
export function reconnectReasonKey(a: AppState): ReconnectReasonKey {
  if (a.reconnectErrorCode === 'provider.timeout') return 'status.reason_timeout';
  if (a.reconnectErrorCode === 'provider.rate_limit') return 'status.reason_rate_limit';
  if (a.reconnectStatusCode === 429) return 'status.reason_rate_limit';
  if (a.reconnectStatusCode !== undefined && a.reconnectStatusCode >= 500) {
    return 'status.reason_server';
  }
  // Legacy fallback (records without `errorCode`): a timeout used to be
  // recognizable only by the error class name.
  if (a.reconnectErrorCode === undefined && (a.reconnectErrorName ?? '').includes('Timeout')) {
    return 'status.reason_timeout';
  }
  return 'status.reason_connection';
}

export interface LifecycleControllerHost {
  readonly state: TUIState;
  readonly options: ScreamTUIOptions;
  readonly harness: ScreamHarness;
  session: Session | undefined;

  setStartupReady(): void;
  appendStartupNotice(extra: string): void;
  refreshSkillCommands(session?: Session): Promise<void>;
  refreshSessionTitle(): void;
  syncRuntimeState(session?: Session): Promise<void>;
  closeSession(): Promise<void>;
  stop(exitCode?: number): Promise<void>;
  /**
   * The terminal went away (its window closed, an SSH link dropped): hand
   * running goal or bot work to the background, then exit. Falls back to an
   * immediate emergency exit when absent.
   */
  onHangup?(): void;
  showStatus(message: string, color?: string): void;
  showNotice(title: string, detail?: string): void;
  applyResolvedAutoTheme(resolved: ResolvedTheme, background?: string): void;
  applyTheme(theme: Theme, resolved?: ResolvedTheme, background?: string): void;
  updateActivityPane(): void;
  setAppState(patch: Partial<AppState>): void;
  updateEditorBorderHighlight(text?: string): void;

  readonly authFlow: AuthFlowController;
  readonly sessionManager: SessionManager;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly transcriptController: TranscriptController;
  /** Read by the status-bar wave: a tool call in flight is local work, so the
   *  silence ramp must not treat it as a dead connection. */
  readonly streamingUI: StreamingUIController;

  onEmergencyExit(exitCode?: number): never;
}

/**
 * The footer's notice slot shows one notice at a time. Lower priority number is
 * shown first: a fired reminder is time-sensitive and must not slip by, an MCP
 * problem needs the person, a collaboration request can wait a moment, and
 * connect chatter yields to everything.
 */
const NOTICE_PRIORITY = { reminder: 1, mcpFailed: 2, mcpAuth: 2.5, collab: 3, mcpProgress: 4 } as const;
const COLLAB_NOTICE_TTL_MS = 8_000;
/** Longer than the collaboration notice: a cron fire is time-sensitive. */
const REMINDER_NOTICE_TTL_MS = 10_000;
/** MCP problems stay on screen as long as the footer pill does; the notice is the heads-up. */
const MCP_PROBLEM_NOTICE_TTL_MS = 8_000;
/** Connect progress is refreshed while servers connect and removed when they settle. */
const MCP_PROGRESS_NOTICE_TTL_MS = 15_000;
/** Footer git badge freshness window; the deferred read refreshes past it. */
const GIT_DIFF_TTL_MS = 15_000;
/** Window after a command-driven line write during which the poll stands down. */
const MANUAL_LINE_WRITE_GRACE_MS = 5_000;
/** The footer renders two rows (one on a short terminal, see COMPACT_FOOTER_ROWS);
 *  the dock reserves the two. The status row keeps one row even when it renders
 *  nothing. Both live in constant/rendering so panels can size against them;
 *  re-exported here. */
export { DOCK_FOOTER_ROWS, DOCK_STATUS_ROWS };

export class LifecycleController {
  private signalCleanupHandlers: Array<() => void> = [];
  private footerWrap: GutterContainer | undefined;
  private linePollTimer: ReturnType<typeof setInterval> | undefined;
  /** Deferred git-diff read for the footer badge (never on the render path). */
  private gitDiffRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private gitDiffSnapshot: { workDir: string; added: number; deleted: number } | null = null;
  /** Timestamp/workDir of the last probe (covers negative "not a repo" reads,
   *  so a null snapshot cannot re-trigger a probe on every frame). */
  private gitDiffReadAt = 0;
  private gitDiffReadWorkDir: string | null = null;
  private gitTimersStopped = false;
  /** Last command-driven line-state write; the poll skips right after one. */
  private lineStateManualWriteAt = 0;
  private memoryIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private memoryCountdownTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMemoryExtractionTime = 0;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private lastActivityMode: string | undefined;
  private lastReconnectAttempt = 0;
  /** The active status-bar loader (PulseWaveLoader or MoonLoader). Owned by
   * this controller; stopped before replacement to avoid leaking timers. */
  private statusBarLoader: PulseWaveLoader | undefined;
  /** Counts the replies that arrive while the transcript is scrolled up. */
  private readonly scrollCue = new ScrollCue();
  /** The footer's notice slot: reminders, collaboration requests and MCP
   *  notices queue here and are shown one at a time. */
  private readonly notices = new NoticeBoard(() => {
    this.host.state.ui?.requestRender();
  });
  /** Sum all four token buckets into the session's total token consumption. */
  private static sumTokens(usage: TokenUsage): number {
    return usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation + usage.output;
  }

  private tipRotationTimer: ReturnType<typeof setInterval> | undefined;
  private currentTipIndex = pickTipIndex(SESSION_TIPS, undefined);
  /** Git status cache behind the footer's working-tree diff. Rebuilt when the
   * workDir changes; `getStatus()` is TTL-cached so polling is cheap. */
  private gitStatusCache: GitStatusCache | undefined;
  private gitStatusCacheWorkDir = '';
  /** Memo for the session-stats aggregation: recomputed only when the
   * transcript's ingest counter/length, compaction count or usage object
   * changes. */
  private sidebarStatsMemo:
    | {
        ingestCount: number;
        length: number;
        compactions: number;
        usage: TokenUsage;
        subagentUsage: AppState['subagentUsage'];
        apiCalls: number;
        stats: SidebarSessionStats;
      }
    | undefined;

  private static readonly MEMORY_IDLE_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly MEMORY_COUNTDOWN_MS = 15 * 1000; // 15 seconds
  private static readonly MEMORY_EXTRACT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

  constructor(private readonly host: LifecycleControllerHost) {}

  installSignalHandlers(): void {
    this.uninstallSignalHandlers();

    // SIGHUP: the terminal window was closed or the SSH link dropped. Node
    // raises it on Windows too when the console window closes (Windows then
    // ends the process about 10 seconds later, whatever it is doing).
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          if (this.host.onHangup !== undefined) this.host.onHangup();
          else this.host.onEmergencyExit();
          return;
        }
      this.host.stop(143).then(
        () => {
          process.exit(143);
        },
        () => {
          this.host.onEmergencyExit(143);
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
        this.host.onEmergencyExit();
      }
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    process.stdin.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stdin.off('error', terminalErrorHandler);
    });
  }

  uninstallSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  onEmergencyExit(exitCode = 129): never {
    this.host.onEmergencyExit(exitCode);
  }

  startLinePolling(): void {
    const POLL_INTERVAL_MS = 30_000;
    const sync = (): void => {
      void readLineFooterStatus().then(({ active, platform }) => {
        // A command write that landed while this read was in flight is newer
        // than the read's snapshot — never clobber it.
        if (Date.now() - this.lineStateManualWriteAt < MANUAL_LINE_WRITE_GRACE_MS) return;
        this.host.setAppState({ lineActive: active, linePlatform: platform });
      });
    };
    sync();
    this.linePollTimer = setInterval(sync, POLL_INTERVAL_MS);
  }

  stopLinePolling(): void {
    if (this.linePollTimer !== undefined) {
      clearInterval(this.linePollTimer);
      this.linePollTimer = undefined;
    }
    if (this.jobsPollTimer !== undefined) {
      clearInterval(this.jobsPollTimer);
      this.jobsPollTimer = undefined;
    }
  }

  private jobsPollTimer: ReturnType<typeof setInterval> | undefined;
  /** The count of items needing the person, last seen by the jobs poll; undefined before the first. */
  private lastWaiting: number | undefined;
  private waitingNotices = 0;

  /**
   * Where the background cannot show a system notification itself (a Mac
   * without terminal-notifier, SSH, a Linux without a desktop), the terminal
   * raises it when a new approval or question waits for the person — from the
   * terminal app, so a click brings this window forward. Memories wait quietly,
   * as in the background; items already waiting at start only show in the footer.
   */
  private announceNewWaiting(waiting: number): void {
    const previous = this.lastWaiting;
    this.lastWaiting = waiting;
    if (previous === undefined || waiting <= previous) return;
    if (hostShowsDesktopNotifications() || !readHostSettings().desktopNotifications) return;
    this.waitingNotices += 1;
    notifyTerminalOnce(this.host.state, `jobs-waiting:${String(this.waitingNotices)}`, {
      title: t('host.notify.waiting_title'),
      body: t('host.notify.waiting_body', { count: String(waiting) }),
    });
  }
  /** Background activity up to here has been looked at for failures to announce. */
  private activitySeenAt = Date.now();

  /**
   * A background failure — a job run, work handed over, the background itself
   * (it keeps crashing, a chat reminder could not be sent) — raised by the
   * terminal where the background cannot show a system notification (same
   * rule as {@link announceNewWaiting}). Only what happened while this
   * terminal is open: the rest is in "while you were away".
   */
  private announceNewTrouble(): void {
    const entries = readActivitySince(this.activitySeenAt);
    if (entries.length === 0) return;
    this.activitySeenAt = Math.max(this.activitySeenAt, ...entries.map((entry) => entry.at));
    if (hostShowsDesktopNotifications() || !readHostSettings().desktopNotifications) return;
    for (const entry of entries) {
      const failed = entry.ok === false && (entry.kind === 'job' || entry.kind === 'continued');
      if (!failed && entry.kind !== 'health') continue;
      notifyTerminalOnce(this.host.state, `activity:${entry.kind}:${String(entry.at)}`, {
        title:
          entry.kind === 'health'
            ? entry.title
            : t(entry.kind === 'job' ? 'host.notify.job_failed_title' : 'host.notify.continued_failed_title'),
        body: entry.kind === 'health' ? entry.detail : entry.title,
      });
    }
  }

  /** The sidebar's jobs row, refreshed by the jobs poll. */
  private sidebarJobs: SidebarJobsData | undefined;

  /**
   * Jobs: the footer counts (on, waiting, whether the background runs), and
   * the background is started when jobs are on and it is not up — so jobs
   * run without /service, until the computer restarts.
   */
  startJobsPolling(): void {
    const POLL_INTERVAL_MS = 30_000;
    const apply = (status: JobsFooterStatus): void => {
      this.announceNewWaiting(status.needsYou ?? 0);
      this.announceNewTrouble();
      this.sidebarJobs = { hostRunning: status.hostRunning, waiting: status.waiting, rows: status.jobs ?? [] };
      this.host.setAppState({ jobsEnabled: status.enabled, jobsWaiting: status.waiting, jobsHostRunning: status.hostRunning });
    };
    const sync = (): void => {
      // An upgrade leaves the background on the build it loaded: move it to
      // this one once it is idle (host/stale-build.ts; asked at most every
      // few minutes, and only when the background is older).
      void restartStaleBackground().then((outcome) => {
        if (outcome === 'restarted') {
          this.host.showStatus(t('host.restarted_on_build', { version: getVersion() }), this.host.state.theme.colors.textDim);
        }
      });
      void readJobsFooterStatus().then(async (status) => {
        apply(status);
        if (await ensureBackgroundForJobs(status)) {
          setTimeout(() => {
            void readJobsFooterStatus().then(apply);
          }, 3_000).unref?.();
        }
      });
    };
    sync();
    this.jobsPollTimer = setInterval(sync, POLL_INTERVAL_MS);
    this.jobsPollTimer.unref?.();
  }

  refreshLineStatus(): void {
    setTimeout(() => {
      void readLineFooterStatus().then(({ active, platform }) => {
        this.host.setAppState({ lineActive: active, linePlatform: platform });
      });
    }, 1500);
  }

  startMemoryIdleTimer(): void {
    this.stopMemoryIdleTimer();
    this.memoryIdleTimer = setTimeout(() => {
      this.memoryIdleTimer = undefined;
      this.startExtractionCountdown();
    }, LifecycleController.MEMORY_IDLE_MS);
  }

  stopMemoryIdleTimer(): void {
    if (this.memoryIdleTimer !== undefined) {
      clearTimeout(this.memoryIdleTimer);
      this.memoryIdleTimer = undefined;
    }
    if (this.memoryCountdownTimer !== undefined) {
      clearTimeout(this.memoryCountdownTimer);
      this.memoryCountdownTimer = undefined;
    }
  }

  private startExtractionCountdown(): void {
    if (this.memoryCountdownTimer !== undefined) return;
    this.host.showNotice(
      t('lifecycle.memory_countdown'),
      t('lifecycle.memory_cancel_hint', { seconds: String(Math.round(LifecycleController.MEMORY_COUNTDOWN_MS / 1000)) }),
    );
    this.host.state.ui.requestRender();
    this.memoryCountdownTimer = setTimeout(() => {
      this.memoryCountdownTimer = undefined;
      void this.performIdleMemoryExtraction();
    }, LifecycleController.MEMORY_COUNTDOWN_MS);
  }

  cancelPendingMemoryExtraction(): void {
    if (this.memoryCountdownTimer === undefined) return;
    clearTimeout(this.memoryCountdownTimer);
    this.memoryCountdownTimer = undefined;
    this.host.showStatus(t('lifecycle.memory_cancelled'), this.host.state.theme.colors.textDim);
    this.startMemoryIdleTimer();
  }

  private async performIdleMemoryExtraction(): Promise<void> {
    const now = Date.now();
    if (now - this.lastMemoryExtractionTime < LifecycleController.MEMORY_EXTRACT_COOLDOWN_MS) return;
    const { state, session } = this.host;
    if (isStreaming(state.appState)) return;
    if (state.appState.isCompacting) return;
    if (state.appState.isReplaying) return;
    if (session === undefined) return;

    this.host.showStatus(t('lifecycle.memory_processing'), state.theme.colors.textDim);
    state.ui.requestRender();
    try {
      const count = await session.extractMemoriesOnExit();
      this.host.showStatus(
        count > 0 ? t('lifecycle.memory_done', { count: String(count) }) : t('lifecycle.memory_none'),
        state.theme.colors.textDim,
      );
    } catch {
      this.host.showStatus(t('lifecycle.memory_failed'), state.theme.colors.warning);
    } finally {
      this.lastMemoryExtractionTime = Date.now();
      state.ui.requestRender();
    }
  }

  markMemoryExtracted(): void {
    this.lastMemoryExtractionTime = Date.now();
  }

  onTurnCompleted(): void {
    // Idle memory extraction disabled — extraction is now manual-only via /memory.
  }

  startEventLoop(): void {
    this.host.state.ui.start();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.host.state);
    this.refreshTerminalThemeTracking();
  }

  buildLayout(): void {
    const { ui } = this.host.state;
    ui.clear();
    // Layout contract:
    //   - ScrollView wraps the output regions (transcript/activity/queue),
    //     so scrolling only moves the output, not the chrome.
    //   - A fixed VStack dock holds todo + banners + editor + footer,
    //     pinned to the bottom (grow: 0).
    const scrollContent = new Container();
    scrollContent.addChild(this.host.state.transcriptContainer);
    scrollContent.addChild(this.host.state.activityContainer);
    scrollContent.addChild(this.host.state.queueContainer);
    const transcriptScrollView = new ScrollView(scrollContent, {
      follow: 'end',
      primary: true,
      scrollbar: 'auto',
      // Scrolled up past a prompt, the first row keeps saying what the stretch
      // on screen is an answer to. Quieter than the prompt itself: it is a
      // reminder, not another message.
      stickyPrompt: (text) => this.stickyPromptRow(text),
    });
    const dock = new VStack([
      // Hide the todo panel on narrow terminals so the editor and footer
      // keep enough room (replaces the removed setTightMode gutter collapse).
      {
        component: this.host.state.todoPanelContainer,
        shrink: 1,
        minSize: 0,
        visible: (viewport) => viewport.width >= TODO_PANEL_MIN_WIDTH,
      },
      { component: this.host.state.errorBannerContainer, shrink: 1, minSize: 0 },
      { component: this.host.state.planModeBannerContainer, shrink: 1, minSize: 0 },
      // Fixed one-line status bar above the editor: current work phase
      // (thinking/working/tool) with its spinner. Empty when idle. minSize 1
      // guarantees the bar survives dock shrink (tool calls resize the
      // editor, and a minSize 0 bar would be squeezed to zero height).
      {
        component: this.host.state.statusBarContainer,
        shrink: 1,
        minSize: DOCK_STATUS_ROWS,
        visible: (viewport) => viewport.width >= STATUS_ROW_MIN_WIDTH,
      },
      { component: this.host.state.editorContainer, shrink: 1, minSize: 3 },
      {
        component: this.ensureFooterWrap(),
        // The footer is a fixed block of its rendered height: two rows, or one
        // on a short terminal (it folds itself, see COMPACT_FOOTER_ROWS). It
        // must not shrink below that, otherwise a row is clipped away.
        shrink: 0,
        minSize: 1,
      },
    ]);
    // The session-status sidebar reads its numbers from here on every frame it
    // is open (and only then), so the data is a cheap snapshot: stats are
    // memoized, the usage count lives in its own tracker.
    this.host.state.sidebarManager.setDataProvider(() => this.buildSidebarData());

    // Wide-terminal sidebar: the output region becomes a horizontal split of
    // the transcript ScrollView (left) and the sidebar (right). The sidebar is
    // hidden below SIDEBAR_MIN_VIEWPORT_WIDTH columns and while closed, matching
    // the existing todoPanel/statusBar width gates.
    const sidebar = this.host.state.sidebarView;
    const topRegion = new HStack([
      { component: transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      {
        component: sidebar,
        // Content-driven width: the sidebar's body answers the stack's width
        // question from the manager (or is empty when closed), so open/close
        // and a resize move the split without rebuilding the layout.
        basis: 'auto',
        grow: 0,
        shrink: 0,
        minSize: 0,
        visible: (viewport) => viewport.width >= SIDEBAR_MIN_VIEWPORT_WIDTH,
      },
    ]);
    const layoutRoot = new VStack([
      { component: topRegion, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      // The dock's own floor matches the footer's two rows: shrinking the dock
      // below that would clip the footer's second row.
      { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 2 },
    ]);
    ui.setLayoutRoot(layoutRoot);
    // Keep the root reachable so full-screen overlays (approval preview,
    // tasks browser) can swap the layout temporarily and restore it.
    this.host.state.layoutRoot = layoutRoot;
  }

  /** The sidebar's data snapshot: jobs, session stats, agents, goal and the
   *  first-token history. The sidebar re-reads it every frame, so it stays cheap. */
  private buildSidebarData(): SidebarData {
    const appState = this.host.state.appState;
    return {
      ...(this.sidebarJobs === undefined ? {} : { jobs: this.sidebarJobs }),
      sessionStats: this.readSidebarSessionStats(appState),
      agents: this.host.sessionEventHandler.getSubagentSlots(),
      goal: this.readSidebarGoal(appState),
      firstToken: this.host.sessionEventHandler.getFirstTokenHistory(),
    };
  }

  /**
   * Working-tree diff stats for the footer's line-1 git badge.
   *
   * This is called from `render()`, so it must never touch git directly: the
   * snapshot is served from a cached field and a stale/mismatched workDir only
   * schedules a deferred refresh. Shares the sidebar's cache, so a read costs
   * no extra git spawn.
   */
  getGitDiffStats(workDir: string): { added: number; deleted: number } | null {
    const fresh = this.gitDiffReadWorkDir === workDir && Date.now() - this.gitDiffReadAt < GIT_DIFF_TTL_MS;
    if (!fresh) this.scheduleGitDiffRefresh(workDir);
    return this.gitDiffSnapshot !== null && this.gitDiffReadWorkDir === workDir
      ? { added: this.gitDiffSnapshot.added, deleted: this.gitDiffSnapshot.deleted }
      : null;
  }

  /** Deferred git read: `spawnSync` inside `render()` would stall the frame. */
  private scheduleGitDiffRefresh(workDir: string): void {
    if (this.gitDiffRefreshTimer !== undefined) return;
    this.gitDiffRefreshTimer = setTimeout(() => {
      this.gitDiffRefreshTimer = undefined;
      if (this.gitTimersStopped) return;
      const diff = this.readGitStatus(workDir);
      this.gitDiffSnapshot =
        diff === undefined ? null : { workDir, added: diff.diffAdded, deleted: diff.diffDeleted };
      this.gitDiffReadWorkDir = workDir;
      this.gitDiffReadAt = Date.now();
      // Deferred: the host may already be tearing down.
      this.host.state.ui?.requestRender();
    }, 0);
  }

  /** Cancel the deferred git read (shutdown). */
  stopGitDiffRefresh(): void {
    this.gitTimersStopped = true;
    if (this.gitDiffRefreshTimer !== undefined) {
      clearTimeout(this.gitDiffRefreshTimer);
      this.gitDiffRefreshTimer = undefined;
    }
  }

  /**
   * Marks a command-driven line-state write (`/line start|stop|uninstall`), so
   * an in-flight poll result cannot clobber it with a stale read.
   */
  noteLineStateWrite(): void {
    this.lineStateManualWriteAt = Date.now();
  }

  private readGitStatus(workDir: string): { diffAdded: number; diffDeleted: number } | undefined {
    if (this.gitStatusCache === undefined || this.gitStatusCacheWorkDir !== workDir) {
      this.gitStatusCache = createGitStatusCache(workDir);
      this.gitStatusCacheWorkDir = workDir;
    }
    const status = this.gitStatusCache.getStatus();
    // null = workDir is not a git repo.
    if (status === null) return undefined;
    return { diffAdded: status.diffAdded, diffDeleted: status.diffDeleted };
  }

  private readSidebarSessionStats(appState: AppState): SidebarSessionStats {
    const entries = this.host.state.transcriptEntries;
    const ingestCount = this.host.transcriptController.getIngestCount();
    const usage = appState.sessionUsage;
    const subagentUsage = appState.subagentUsage;
    const memo = this.sidebarStatsMemo;
    // The entry list is not append-only: once the transcript hits its entry cap
    // the oldest rows are folded into one aggregate stub, which lands the array
    // back on the same length with a different composition. The monotonic
    // ingest counter catches that; length and the usage object refs (replaced
    // per update) stay in the key to cover mutations outside the ingress —
    // replay splices and the per-session reset. The call count is explicit
    // because a step can complete without carrying usage, which would leave
    // every other input unchanged.
    if (
      memo !== undefined &&
      memo.ingestCount === ingestCount &&
      memo.length === entries.length &&
      memo.compactions === appState.autoCompactionCount &&
      memo.usage === usage &&
      memo.subagentUsage === subagentUsage &&
      memo.apiCalls === appState.sessionApiCalls
    ) {
      return memo.stats;
    }
    let turns = 0;
    let toolCalls = 0;
    for (const entry of entries) {
      if (entry.kind === 'user') turns += 1;
      // Compression markers reuse kind 'tool_call' but carry compactionData;
      // they are not real tool invocations.
      if (entry.kind === 'tool_call' && entry.compactionData === undefined) toolCalls += 1;
    }
    // The array is capped: once it trips, the oldest rows are folded into a
    // stub and their contributions leave the scan with them. Add back what the
    // cap has already folded so a long session's counters keep counting
    // history instead of falling back at the retention point.
    const foldedAway = this.host.transcriptController.getFoldedEntryCounts();
    turns += foldedAway.turns;
    toolCalls += foldedAway.toolCalls;
    // Subagent output is separate from the main agent's output; sum it in so
    // the sidebar total matches what the user actually pays for.
    let subagentOutput = 0;
    for (const sub of Object.values(subagentUsage)) {
      subagentOutput += sub.output;
    }
    const stats: SidebarSessionStats = {
      turns,
      toolCalls,
      compactions: appState.autoCompactionCount,
      apiCalls: appState.sessionApiCalls,
      tokensTotal: LifecycleController.sumTokens(usage) + subagentOutput,
      tokensInputCacheHit: usage.inputCacheRead,
      tokensInputCacheMiss: usage.inputOther + usage.inputCacheCreation,
      tokensOutput: usage.output + subagentOutput,
    };
    this.sidebarStatsMemo = {
      ingestCount,
      length: entries.length,
      compactions: appState.autoCompactionCount,
      usage,
      subagentUsage,
      apiCalls: appState.sessionApiCalls,
      stats,
    };
    return stats;
  }

  private readSidebarGoal(appState: AppState): SidebarGoalData | undefined {
    if (appState.goal === null) return undefined;
    return {
      objective: appState.goal.objective,
      status: appState.goal.status,
      turnsUsed: appState.goal.turnsUsed,
      wallClockMs: appState.goal.wallClockMs,
      wallClockBaseAt: appState.goal.wallClockBaseAt,
      continuationCount: appState.goalContinuationCount,
      completionCriterion: appState.goal.completionCriterion,
      tokensUsed: appState.goal.tokensUsed,
      inputTokens: appState.goal.inputTokens,
      outputTokens: appState.goal.outputTokens,
      judge: appState.goalJudge,
    };
  }

  mountFooter(): void {
    // The container is created at buildLayout time (so the dock references a
    // stable instance); the footer component itself is only added once init
    // succeeds. A failed resume therefore never leaves the footer mounted.
    this.ensureFooterWrap();
    this.footerWrap!.addChild(this.host.state.footer);
  }

  private ensureFooterWrap(): GutterContainer {
    if (this.footerWrap === undefined) {
      this.footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    }
    return this.footerWrap;
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (this.host.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(
      this.host.state,
      (resolved, background) => {
        this.host.applyResolvedAutoTheme(resolved, background);
      },
    );
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.terminalFocusTrackingDispose?.();
    this.host.state.reminders.dispose();
    this.terminalFocusTrackingDispose = undefined;
  }

  applyTheme(theme: Theme, resolved?: ResolvedTheme, background?: string): void {
    const nextTheme = createScreamTUIThemeBundle(theme, resolved, background);
    const { state } = this.host;
    Object.assign(state.theme.colors, nextTheme.colors);
    state.theme.resolvedTheme = nextTheme.resolvedTheme;
    state.theme.backgroundHex = nextTheme.backgroundHex;
    state.theme.styles = nextTheme.styles;
    state.theme.markdownTheme = nextTheme.markdownTheme;
    // The palette is mutated in place, so the wave's cached frame still holds
    // the old colour; repaint it before the triggered render.
    this.statusBarLoader?.repaint();
    this.host.setAppState({ theme });
    this.host.updateEditorBorderHighlight();
    for (const child of state.transcriptContainer.children) {
      child.invalidate?.();
    }
    state.ui.requestRender(true);
  }

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));

    // Rebuild the status bar not only on mode change, but also when the
    // reconnect attempt counter advances: a step retry keeps the mode at
    // 'waiting', so mode-change alone would leave the reconnect label stale.
    const reconnectAttempt = this.host.state.appState.reconnectAttempt;
    const reconnectChanged = reconnectAttempt !== this.lastReconnectAttempt;
    if (effectiveMode === this.lastActivityMode && !reconnectChanged) {
      return;
    }

    this.lastActivityMode = effectiveMode;
    this.lastReconnectAttempt = reconnectAttempt;
    this.updateStatusBar(effectiveMode);
    const { state } = this.host;
    state.activityContainer.clear();
    // The status bar (above the editor) owns the live work-phase indicator;
    // the activity pane stays empty, so there is nothing else to tear down.
    state.ui.requestRender();
  }

  /**
   * Updates the fixed status row above the editor to reflect the current mode.
   * Called only when the mode actually changes. Uses its OWN pulse wave (a
   * component can only have one parent). Recreating a loader on every call
   * would leak setInterval timers (each PulseWaveLoader.start() registers one
   * and the old instance is never stopped), so the previous instance is
   * explicitly stopped before a new one is mounted.
   *
   *   working  wave + phase + how long (read live, so the clock moves)
   *   blocked  what the session waits for the person to do (approval, answer)
   *            or a compaction; the row used to be empty exactly then
   *   idle     one tip while the chat is empty
   */
  private updateStatusBar(mode: EffectiveActivityPaneMode): void {
    const { state } = this.host;
    state.statusBarContainer.clear();
    // Tear down the previous loader's interval before replacing it.
    this.statusBarLoader?.stop();
    this.statusBarLoader = undefined;
    this.stopTipRotation();

    const colors = state.theme.colors;
    const live = () => workState(state.appState);
    const scrollCue = () => this.getScrollCue();

    switch (mode) {
      case 'waiting':
      case 'composing':
      case 'tool':
      case 'thinking': {
        // Every working phase shows the same pulse wave, reasoning included: the
        // reasoning rows now live inside the activity block, and a folded block
        // is too quiet to tell at a glance that work is still going on.
        // PulseWaveLoader renders reliably under layout-root swaps (an approval
        // dialog replaces the root and restores it).
        const loader = new PulseWaveLoader(state.ui, () => this.currentWaveColor());
        this.statusBarLoader = loader;
        state.statusBarContainer.addChild(
          new StatusBarPaneComponent({
            mode: 'working',
            colors,
            pulseWave: loader,
            state: live,
            reconnect: this.buildReconnectLabel(state),
            scrollCue,
          }),
        );
        break;
      }
      case 'blocked':
        state.statusBarContainer.addChild(new StatusBarPaneComponent({ mode: 'blocked', colors, state: live, scrollCue }));
        break;
      case 'idle': {
        // While the chat is completely empty (fresh session / just switched)
        // the row shows one tip. Once the user sends anything the phase leaves
        // idle and the row rebuilds, so the tip disappears automatically.
        const showHint = state.transcriptEntries.length === 0 && !isEmptySessionHintDismissed();
        const tip = showHint ? (SESSION_TIPS[this.currentTipIndex] ?? SESSION_TIPS[0]!) : undefined;
        // The row is mounted even without a tip: the scroll cue reads live and
        // may appear while the session sits idle.
        state.statusBarContainer.addChild(
          new StatusBarPaneComponent({
            mode: 'idle',
            colors,
            ...(tip === undefined ? {} : { tip: composeTipLabel(t(tip.i18nKey), tip, colors.primary) }),
            scrollCue,
          }),
        );
        if (tip !== undefined) this.startTipRotation();
        break;
      }
      case 'hidden':
        break;
    }
    state.ui.requestRender();
  }

  /** The pinned prompt row at the top of a scrolled-up transcript. */
  private stickyPromptRow(text: string): string {
    const colors = this.host.state.theme.colors;
    const gutter = ' '.repeat(CHROME_GUTTER);
    return `${gutter}${chalk.hex(colors.roleUser)(USER_MESSAGE_BULLET)}${chalk.hex(colors.textDim)(text)}`;
  }

  /** "↓ 2 new messages" while the transcript is scrolled up and the session goes on below. */
  private getScrollCue(): StatusChipLine | null {
    const { state } = this.host;
    const cue = this.scrollCue.read(state.ui.isFollowingOutput, state.transcriptEntries);
    if (cue === null) return null;
    const colors = state.theme.colors;
    const hint = chalk.hex(colors.textDim)(t('scrollcue.back'));
    if (cue.newReplies === 0) return { text: `${chalk.hex(colors.primary).bold('↓')} ${hint}` };
    const news = cue.newReplies === 1 ? t('scrollcue.one') : t('scrollcue.many', { count: String(cue.newReplies) });
    return { text: `${chalk.hex(colors.primary).bold(news)} ${chalk.hex(colors.textDim)('·')} ${hint}` };
  }

  /** The idle tip line delegates its optional domain link to composeTipLabel
   *  (see tui/utils/tip-hyperlink.ts): linked tips render the bare domain as
   *  a clickable OSC 8 hyperlink against the dimmed cue text. */
  /** Builds the reconnect label shown next to the status-bar pulse wave
   * while a step retry is in flight, e.g. "重连中 3/10 · 限流 · 20s 后重试".
   * Returns an empty string when no retry is active. Static by design: the
   * delay shown is the value from the latest retry event, not a ticking
   * countdown. */
  private buildReconnectLabel(state: TUIState): string {
    const a = state.appState;
    if (a.reconnectAttempt <= 0) return '';
    const reasonKey = reconnectReasonKey(a);
    const reason = a.reconnectStatusCode !== undefined
      ? `${t(reasonKey)} (${String(a.reconnectStatusCode)})`
      : a.reconnectErrorName !== undefined && a.reconnectErrorName.length > 0
        ? `${t(reasonKey)} (${a.reconnectErrorName})`
        : t(reasonKey);
    const delaySec = Math.max(1, Math.round((a.reconnectDelayMs ?? 0) / 1000));
    if (a.reconnectUntil !== undefined) {
      // Past the retry budget, waiting out an outage: when it tries next and
      // until when, instead of an attempt count past its maximum.
      const until = new Date(a.reconnectUntil);
      return t('status.outage_detail', {
        reason,
        delay: delaySec >= 60 ? t('status.outage_minutes', { m: String(Math.round(delaySec / 60)) }) : `${String(delaySec)}s`,
        until: `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`,
      });
    }
    const label = t('status.reconnecting_detail', {
      attempt: String(a.reconnectAttempt),
      max: String(a.reconnectMaxAttempts ?? 0),
      reason,
      delay: String(delaySec),
    });
    // Plain text: the row applies the semantic colour (warning) uniformly to
    // the whole chip, so the label must not carry its own ANSI.
    return label;
  }

  /** Force a status-bar refresh even when the mode is unchanged. Used after
   *  session switches/clears: the transcript is emptied, so the empty-session
   *  hint must (re)appear even though idle -> idle normally short-circuits. */
  forceUpdateStatusBar(): void {
    this.lastActivityMode = undefined;
    this.updateActivityPane();
  }

  /**
   * Collaboration request or acknowledgement (subagent ↔ main agent traffic).
   * A newer one replaces the previous one; it shows in the footer's notice slot
   * for `COLLAB_NOTICE_TTL_MS` or until a higher-priority notice takes the slot.
   */
  showCollabActivity(text: string, tone: 'request' | 'handled'): void {
    const colors = this.host.state.theme.colors;
    this.notices.post({
      key: 'collab',
      text,
      color: tone === 'request' ? colors.warning : colors.success,
      priority: NOTICE_PRIORITY.collab,
      ttlMs: COLLAB_NOTICE_TTL_MS,
    });
    this.host.state.ui?.requestRender();
  }

  /**
   * Scheduled-task reminder (`⏰ 定时任务已触发：…`). First in line: it outlives
   * the collaboration notice because a cron fire is time-sensitive. `missed` (a
   * stale/overdue task) switches to `warning` so an out-of-date schedule is not
   * mistaken for a fresh one.
   */
  showReminderActivity(text: string, tone: 'fired' | 'missed'): void {
    const colors = this.host.state.theme.colors;
    this.notices.post({
      key: 'reminder',
      text,
      color: tone === 'missed' ? colors.warning : colors.accent,
      priority: NOTICE_PRIORITY.reminder,
      ttlMs: REMINDER_NOTICE_TTL_MS,
    });
    this.host.state.ui?.requestRender();
  }

  /**
   * MCP notice. `progress` is the connect summary (kept fresh by the caller and
   * removed with `clearMcpNotice` once the servers settle); `failed` and
   * `needs-auth` are the heads-up for a problem, which also lives on as the
   * footer pill. Healthy servers say nothing.
   */
  showMcpNotice(kind: McpNoticeKind, text: string, color: string): void {
    const spec =
      kind === 'progress'
        ? { priority: NOTICE_PRIORITY.mcpProgress, ttlMs: MCP_PROGRESS_NOTICE_TTL_MS }
        : kind === 'failed'
          ? { priority: NOTICE_PRIORITY.mcpFailed, ttlMs: MCP_PROBLEM_NOTICE_TTL_MS }
          : { priority: NOTICE_PRIORITY.mcpAuth, ttlMs: MCP_PROBLEM_NOTICE_TTL_MS };
    this.notices.post({ key: `mcp-${kind}`, text, color, ...spec });
    this.host.state.ui?.requestRender();
  }

  clearMcpNotice(kind: McpNoticeKind): void {
    this.notices.remove(`mcp-${kind}`);
    this.host.state.ui?.requestRender();
  }

  /** Live getter the footer reads on every render: the notice to draw now. */
  getNotice(): { text: string; color: string } | null {
    return this.notices.top();
  }

  /** Drops every notice (session switch, shutdown). */
  clearStatusActivity(): void {
    this.notices.clear();
  }

  /**
   * Stops every animation this controller owns. Called from the shutdown path:
   * the pulse wave re-schedules itself every 80ms, so without this the render
   * chain keeps running until the process exits.
   */
  stopActivityAnimation(): void {
    this.statusBarLoader?.stop();
    this.statusBarLoader = undefined;
    this.stopTipRotation();
    this.notices.dispose();
  }

  /** Current tip index (for Ctrl+F to check if the visible tip is the ad). */
  get currentTipIdx(): number {
    return this.currentTipIndex;
  }

  /** Start the tip rotation timer: the first frame shows the offer ad, then
   *  every rotation picks uniformly from the whole pool (ads included) and
   *  never repeats the line currently on screen. */
  private startTipRotation(): void {
    if (this.tipRotationTimer !== undefined) return;
    this.tipRotationTimer = setInterval(() => {
      this.currentTipIndex = pickTipIndex(SESSION_TIPS, this.currentTipIndex);
      this.lastActivityMode = undefined;
      this.updateActivityPane();
    }, TIP_ROTATION_INTERVAL_MS);
  }

  private stopTipRotation(): void {
    if (this.tipRotationTimer !== undefined) {
      clearInterval(this.tipRotationTimer);
      this.tipRotationTimer = undefined;
    }
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    const { state } = this.host;
    if (state.activeDialog !== null) return 'hidden';
    // Waiting on the person, or compacting: the row names it instead of going empty.
    if (state.livePane.pendingApproval !== null) return 'blocked';
    if (state.appState.isCompacting) return 'blocked';
    if (state.livePane.pendingQuestion !== null) return 'blocked';

    // streamingPhase is the single source of truth for the work phase. Both
    // tool phases share the activity-pane mode: 'tool-args' is the model
    // authoring a call, 'tool' is it executing. 'idle' maps to the idle branch.
    const streamingPhase = state.appState.streamingPhase;
    if (streamingPhase === 'waiting' || streamingPhase === 'thinking' || streamingPhase === 'composing') {
      return streamingPhase;
    }
    if (streamingPhase === 'tool-args' || streamingPhase === 'tool') return 'tool';
    return 'idle';
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.host.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private syncTerminalProgress(active: boolean): void {
    if (this.host.state.terminalState.progressActive === active) return;
    this.host.state.terminal.setProgress(active);
    this.host.state.terminalState.progressActive = active;
  }

  /**
   * Colour for the status-bar pulse wave.
   *
   * Measures silence in the *model* work: a request awaiting its first token,
   * a reasoning/text stream that stopped delivering. A tool call in flight is
   * exempt for its whole lifetime — both while the process runs (a quiet
   * `sleep`, build, or MCP call is still working) and while its arguments are
   * still streaming in (`调用中`, a preview the user is watching fill out). Only
   * a known retry lifts the wave to yellow there.
   *
   * Timing is an early warning only: retries are driven by real transport
   * errors (the 60s stall timeout, disconnects, rate limits), never by this
   * colour. Resolved per frame, so the ramp advances and a live theme switch
   * applies without rebuilding the status bar.
   */
  private currentWaveColor(): string {
    const { appState, theme, lastActivityAt } = this.host.state;
    const colors = theme.colors;
    const { streamingPhase, streamingStartTime, reconnectAttempt } = appState;
    if (streamingPhase === 'idle') return colors.primary;
    // Judged from the call itself, not from the phase: the preview mounts
    // before `tool.call.started` lands, and a lagging phase must never make a
    // running command read as a dead connection. A retry in flight is still a
    // known failure, so it keeps the yellow floor.
    if (streamingPhase === 'tool' || this.host.streamingUI.hasInFlightToolCalls()) {
      return reconnectAttempt > 0 ? colors.waveMid : colors.primary;
    }
    // Anchor to whichever anchor is newer. `waiting` usually has no traffic
    // yet, so this resolves to the request itself; when an inbound notice does
    // arrive mid-wait (an empty-id tool delta) the clock resets like it does
    // in every other phase.
    const anchor = Math.max(lastActivityAt, streamingStartTime);
    if (anchor === 0) return colors.primary;
    const elapsed = Date.now() - anchor;
    // A retry is a known failure, not normal silence: floor the ramp at yellow
    // so the wave never reads "healthy" while the status bar says "reconnecting".
    const effective = reconnectAttempt > 0 ? Math.max(elapsed, WAVE_YELLOW_AT_MS) : elapsed;
    return resolveWaveColor(effective, {
      green: colors.primary,
      yellow: colors.waveMid,
      red: colors.wavePeak,
    });
  }
}
