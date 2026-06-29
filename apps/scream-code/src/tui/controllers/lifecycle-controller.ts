import type { Session, ScreamHarness } from '@scream-code/scream-code-sdk';
import { GutterContainer } from '../components/chrome/gutter-container';
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
import { MoonLoader, type SpinnerStyle } from '../components/chrome/moon-loader';
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
  private ccConnectPollTimer: ReturnType<typeof setInterval> | undefined;
  private memoryIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private memoryCountdownTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMemoryExtractionTime = 0;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private lastActivityMode: string | undefined;

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
      this.host.state.appState.ccConnectActive = active;
    });
    this.ccConnectPollTimer = setInterval(() => {
      void checkCcConnectActive().then((active) => {
        this.host.state.appState.ccConnectActive = active;
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
        this.host.state.appState.ccConnectActive = active;
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
      '15 分钟未操作，即将整理会话记忆',
      `按 Ctrl+W 取消（${Math.round(LifecycleController.MEMORY_COUNTDOWN_MS / 1000)} 秒后自动开始）`,
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
    this.host.showStatus('已取消记忆提取', this.host.state.theme.colors.textDim);
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

    this.host.showStatus('正在整理会话记忆...', state.theme.colors.textDim);
    state.ui.requestRender();
    try {
      const count = await session.extractMemoriesOnExit();
      this.host.showStatus(
        count > 0 ? `已沉淀 ${count} 条记忆至备忘录` : '本次无需沉淀新记忆',
        state.theme.colors.textDim,
      );
    } catch {
      this.host.showStatus('记忆整理失败，稍后再试', state.theme.colors.warning);
    } finally {
      this.lastMemoryExtractionTime = Date.now();
      state.ui.requestRender();
    }
  }

  markMemoryExtracted(): void {
    this.lastMemoryExtractionTime = Date.now();
  }

  onTurnCompleted(): void {
    this.startMemoryIdleTimer();
  }

  startEventLoop(): void {
    this.host.state.ui.start();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.host.state);
    this.refreshTerminalThemeTracking();
  }

  buildLayout(): void {
    const { ui } = this.host.state;
    ui.clear();
    ui.addChild(this.host.state.transcriptContainer);
    ui.addChild(this.host.state.activityContainer);
    ui.addChild(this.host.state.todoPanelContainer);
    ui.addChild(this.host.state.queueContainer);
    ui.addChild(this.host.state.errorBannerContainer);
    ui.addChild(this.host.state.planModeBannerContainer);
    ui.addChild(this.host.state.editorContainer);
  }

  mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.host.state.footer);
    this.host.state.ui.addChild(footerWrap);
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

    if (effectiveMode === this.lastActivityMode) {
      return;
    }

    this.lastActivityMode = effectiveMode;
    const { state } = this.host;
    state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.stopPulseWave();
        state.ui.requestRender();
        return;
      case 'waiting': {
        this.stopActivitySpinner();
        const pulseWave = this.ensurePulseWave();
        state.activityContainer.addChild(
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
          chalk.hex(state.theme.colors.primary)(s),
        );
        state.activityContainer.addChild(
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
        state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            pulseWave,
          }),
        );
        break;
      }
      case 'idle': {
        this.stopActivitySpinner();
        this.stopPulseWave();
        break;
      }
    }
    state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    const { state } = this.host;
    if (state.activeDialog === 'session-picker' || state.activeDialog === 'memory-picker') return 'hidden';
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

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.host.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.host.state.activitySpinner === null) {
      const instance = new MoonLoader(this.host.state.ui, style, colorFn, label);
      this.host.state.activitySpinner = { instance, style };
      return instance;
    }

    this.host.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.host.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.host.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.host.state.activitySpinner !== null) {
      this.host.state.activitySpinner.instance.stop();
      this.host.state.activitySpinner = null;
    }
  }

  private ensurePulseWave(): PulseWaveLoader {
    if (this.host.state.pulseWave !== null) return this.host.state.pulseWave;
    const instance = new PulseWaveLoader(this.host.state.ui, this.host.state.theme.colors.primary);
    this.host.state.pulseWave = instance;
    return instance;
  }

  private stopPulseWave(): void {
    if (this.host.state.pulseWave !== null) {
      this.host.state.pulseWave.stop();
      this.host.state.pulseWave = null;
    }
  }
}
