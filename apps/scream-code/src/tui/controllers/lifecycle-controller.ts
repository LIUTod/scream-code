import type { Session, ScreamHarness } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { Container, ScrollView, VStack, type Component } from '@liutod-scream/pi-tui';
import { GutterContainer } from '../components/chrome/gutter-container';
import { isEmptySessionHintDismissed } from '../utils/ui-preferences';
import { SESSION_TIPS, TIP_ROTATION_INTERVAL_MS } from '../constant/scream-tui';
import { StatusBarPaneComponent } from '../components/panes/status-bar-pane';
import { CHROME_GUTTER } from '../constant/rendering';
import type { AuthFlowController } from './auth-flow';
import type { SessionEventHandler } from './session-event-handler';
import type { SessionReplayRenderer } from './session-replay';
import type { SessionManager } from '../managers/session-manager';
import { createScreamTUIThemeBundle } from '../theme/bundle';
import type { ResolvedTheme } from '../theme/colors';
import type { Theme } from '../theme/index';
import type { AppState, ScreamTUIOptions } from '../types';
import type { TUIState } from '../tui-state';
import { checkCcConnectActive } from '../utils/cc-connect-status';
import { isDeadTerminalError } from '../utils/dead-terminal';
import { isStreaming } from '../utils/app-state';
import { installTerminalFocusTracking } from '../utils/terminal-focus';
import { installTerminalThemeTracking } from '../utils/terminal-theme';
import { MoonLoader } from '../components/chrome/moon-loader';
import { PulseWaveLoader } from '../components/chrome/pulse-wave-loader';
import { ActivityPaneComponent, type ActivityPaneMode } from '../components/panes/activity-pane';
import chalk from 'chalk';

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle';

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
  showStatus(message: string, color?: string): void;
  showNotice(title: string, detail?: string): void;
  applyResolvedAutoTheme(resolved: ResolvedTheme): void;
  applyTheme(theme: Theme, resolved?: ResolvedTheme): void;
  updateActivityPane(): void;
  setAppState(patch: Partial<AppState>): void;
  updateEditorBorderHighlight(text?: string): void;

  readonly authFlow: AuthFlowController;
  readonly sessionManager: SessionManager;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;

  onEmergencyExit(exitCode?: number): never;
}

export class LifecycleController {
  private signalCleanupHandlers: Array<() => void> = [];
  private footerWrap: GutterContainer | undefined;
  private ccConnectPollTimer: ReturnType<typeof setInterval> | undefined;
  private memoryIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private memoryCountdownTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMemoryExtractionTime = 0;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private lastActivityMode: string | undefined;
  private lastReconnectAttempt = 0;
  /** The active status-bar loader (PulseWaveLoader or MoonLoader). Owned by
   * this controller; stopped before replacement to avoid leaking timers. */
  private statusBarLoader: { stop(): void } | undefined;
  private tipRotationTimer: ReturnType<typeof setInterval> | undefined;
  private currentTipIndex = Math.floor(Math.random() * SESSION_TIPS.length);

  private static readonly MEMORY_IDLE_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly MEMORY_COUNTDOWN_MS = 15 * 1000; // 15 seconds
  private static readonly MEMORY_EXTRACT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

  constructor(private readonly host: LifecycleControllerHost) {}

  installSignalHandlers(): void {
    this.uninstallSignalHandlers();

    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.host.onEmergencyExit();
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

  startCcConnectPolling(): void {
    const POLL_INTERVAL_MS = 30_000;
    void checkCcConnectActive().then((active) => {
      this.host.setAppState({ ccConnectActive: active });
    });
    this.ccConnectPollTimer = setInterval(() => {
      void checkCcConnectActive().then((active) => {
        this.host.setAppState({ ccConnectActive: active });
      });
    }, POLL_INTERVAL_MS);
  }

  stopCcConnectPolling(): void {
    if (this.ccConnectPollTimer !== undefined) {
      clearInterval(this.ccConnectPollTimer);
      this.ccConnectPollTimer = undefined;
    }
  }

  refreshCcStatus(): void {
    setTimeout(() => {
      void checkCcConnectActive().then((active) => {
        this.host.setAppState({ ccConnectActive: active });
      });
    }, 3000);
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
    // Official pi-tui layout (mirrors coding-agent interactive-mode):
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
    });
    const dock = new VStack([
      // Hide the todo panel on narrow terminals so the editor and footer
      // keep enough room (replaces the removed setTightMode gutter collapse).
      {
        component: this.host.state.todoPanelContainer,
        shrink: 1,
        minSize: 0,
        visible: (viewport) => viewport.width >= 90,
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
        minSize: 1,
        visible: (viewport) => viewport.width >= 60,
      },
      { component: this.host.state.editorContainer, shrink: 1, minSize: 3 },
      {
        component: this.ensureFooterWrap(),
        shrink: 1,
        minSize: 1,
      },
    ]);
    const layoutRoot = new VStack([
      { component: transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
    ]);
    ui.setLayoutRoot(layoutRoot);
    // Keep the root reachable so full-screen overlays (approval preview,
    // tasks browser) can swap the layout temporarily and restore it.
    this.host.state.layoutRoot = layoutRoot;
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

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.host.state, (resolved) => {
      this.host.applyResolvedAutoTheme(resolved);
    });
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  applyTheme(theme: Theme, resolved?: ResolvedTheme): void {
    const nextTheme = createScreamTUIThemeBundle(theme, resolved);
    const { state } = this.host;
    Object.assign(state.theme.colors, nextTheme.colors);
    state.theme.resolvedTheme = nextTheme.resolvedTheme;
    state.theme.styles = nextTheme.styles;
    state.theme.markdownTheme = nextTheme.markdownTheme;
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
    // The status bar (above the editor) now owns the live work-phase
    // indicator (spinner / pulse wave). The activity pane no longer renders
    // a duplicate indicator — it stays empty. We still stop the shared
    // activity spinner/pulse timers so nothing leaks.
    switch (effectiveMode) {
      case 'hidden':
      case 'idle':
        this.stopActivitySpinner();
        this.stopPulseWave();
        break;
      case 'waiting':
      case 'thinking':
      case 'composing':
      case 'tool':
        this.stopActivitySpinner();
        this.stopPulseWave();
        break;
    }
    state.ui.requestRender();
  }

  /**
   * Updates the fixed status bar above the editor to reflect the current
   * work phase. Called only when the phase actually changes. Uses its OWN
   * spinner/pulse instances (a component can only have one parent, so the
   * activity pane's instances must not be shared). Recreating a loader on
   * every call would leak setInterval timers (each PulseWaveLoader.start()
   * registers one and the old instance is never stopped), so the previous
   * instance is explicitly stopped before a new one is mounted. Idle leaves
   * the bar empty.
   */
  private updateStatusBar(mode: EffectiveActivityPaneMode): void {
    const { state } = this.host;
    state.statusBarContainer.clear();
    // Tear down the previous loader's interval before replacing it.
    this.statusBarLoader?.stop();
    this.statusBarLoader = undefined;
    this.stopTipRotation();

    switch (mode) {
      case 'waiting':
      case 'composing':
      case 'tool':
        // All working phases show the same pulse wave. PulseWaveLoader
        // renders reliably under layout-root swaps (an approval dialog
        // replaces the root and restores it); the MoonLoader animation did
        // not survive that restore, so a single wave is used everywhere.
        {
          const loader = new PulseWaveLoader(state.ui, state.theme.colors.primary);
          this.statusBarLoader = loader;
          state.statusBarContainer.addChild(
            new StatusBarPaneComponent({
              mode,
              label: this.buildReconnectLabel(state),
              pulseWave: loader,
            }),
          );
        }
        break;
      case 'thinking':
        // Thinking indicator lives in the output-area thinking block
        // (spinner + "thinking..." + toks/s); showing it again here would
        // duplicate. Leave the status bar empty during thinking.
        break;
      case 'idle':
      case 'hidden':
        // When the chat is completely empty (fresh session / just switched),
        // show a one-line hint above the editor pointing at the model-provider
        // partner page, with Ctrl+F to open it. Once the user sends anything
        // the phase leaves idle and the bar rebuilds, so the hint disappears
        // automatically — no extra state to clean up.
        if (
          mode === 'idle'
          && state.transcriptEntries.length === 0
          && !isEmptySessionHintDismissed()
        ) {
          // Quiet interactive cue: dimmed label, lighter than body text.
          const tip = SESSION_TIPS[this.currentTipIndex] ?? SESSION_TIPS[0]!;
          state.statusBarContainer.addChild(
            new StatusBarPaneComponent({
              mode: 'idle',
              label: t(tip.i18nKey),
              // Fixed light grey, deliberately theme-independent: the tip
              // carousel reads as a quiet cue in both dark and light themes.
              labelColor: '#999999',
            }),
          );
          this.startTipRotation();
        }
        break;
    }
    state.ui.requestRender();
  }

  /** Builds the reconnect label shown next to the status-bar pulse wave
   * while a step retry is in flight, e.g. "重连中 3/10 · 限流 · 20s 后重试".
   * Returns an empty string when no retry is active. Static by design: the
   * delay shown is the value from the latest retry event, not a ticking
   * countdown. */
  private buildReconnectLabel(state: TUIState): string {
    const a = state.appState;
    if (a.reconnectAttempt <= 0) return '';
    const reasonKey =
      a.reconnectStatusCode === 429
        ? 'status.reason_rate_limit'
        : a.reconnectStatusCode !== undefined && a.reconnectStatusCode >= 500
          ? 'status.reason_server'
          : (a.reconnectErrorName ?? '').includes('Timeout')
            ? 'status.reason_timeout'
            : 'status.reason_connection';
    const reason = a.reconnectStatusCode !== undefined
      ? `${t(reasonKey)} (${String(a.reconnectStatusCode)})`
      : a.reconnectErrorName !== undefined && a.reconnectErrorName.length > 0
        ? `${t(reasonKey)} (${a.reconnectErrorName})`
        : t(reasonKey);
    const delaySec = Math.max(1, Math.round((a.reconnectDelayMs ?? 0) / 1000));
    const label = t('status.reconnecting_detail', {
      attempt: String(a.reconnectAttempt),
      max: String(a.reconnectMaxAttempts ?? 0),
      reason,
      delay: String(delaySec),
    });
    // Render in the same dim gray as the thinking chain (theme textDim) so
    // the reconnect info reads as secondary status text.
    return chalk.hex(state.theme.colors.textDim)(label);
  }

  /** Force a status-bar refresh even when the mode is unchanged. Used after
   *  session switches/clears: the transcript is emptied, so the empty-session
   *  hint must (re)appear even though idle -> idle normally short-circuits. */
  forceUpdateStatusBar(): void {
    this.lastActivityMode = undefined;
    this.updateActivityPane();
  }

  /** Current tip index (for Ctrl+F to check if the visible tip is the ad). */
  get currentTipIdx(): number {
    return this.currentTipIndex;
  }

  /** Start the random tip rotation timer. Picks a random tip different
   *  from the current one and refreshes the status bar. */
  private startTipRotation(): void {
    if (this.tipRotationTimer !== undefined) return;
    this.tipRotationTimer = setInterval(() => {
      if (SESSION_TIPS.length <= 1) return;
      let next: number;
      do {
        next = Math.floor(Math.random() * SESSION_TIPS.length);
      } while (next === this.currentTipIndex);
      this.currentTipIndex = next;
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
    if (state.livePane.pendingApproval !== null) return 'hidden';
    if (state.appState.isCompacting) return 'hidden';
    if (state.livePane.pendingQuestion !== null) return 'hidden';

    // streamingPhase is the single source of truth for the work phase —
    // 'tool' covers tool execution, the rest map directly to activity-pane
    // display modes. 'idle' maps to the idle branch below.
    const streamingPhase = state.appState.streamingPhase;
    if (streamingPhase === 'waiting' || streamingPhase === 'thinking' || streamingPhase === 'composing' || streamingPhase === 'tool') {
      return streamingPhase;
    }
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

  private stopActivitySpinner(): void {
    if (this.host.state.activitySpinner !== null) {
      this.host.state.activitySpinner.instance.stop();
      this.host.state.activitySpinner = null;
    }
  }

  private stopPulseWave(): void {
    if (this.host.state.pulseWave !== null) {
      this.host.state.pulseWave.stop();
      this.host.state.pulseWave = null;
    }
  }
}
