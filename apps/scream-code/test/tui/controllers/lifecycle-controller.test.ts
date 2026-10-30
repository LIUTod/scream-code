import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCK_FOOTER_ROWS,
  DOCK_STATUS_ROWS,
  LifecycleController,
  reconnectReasonKey,
} from '#/tui/controllers/lifecycle-controller';
import {
  MAX_TRANSCRIPT_ENTRIES,
  TranscriptController,
  type TranscriptControllerHost,
} from '#/tui/controllers/transcript-controller';
import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import type { SidebarHubData, SidebarSessionStats } from '#/tui/components/sidebar/sidebar-panel';
import { HUB_MODEL_ROW_ID } from '#/tui/utils/hub-probe';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import * as lineStatus from '#/tui/utils/line-status';
import type { LifecycleControllerHost } from '#/tui/controllers/lifecycle-controller';
import type { ScreamHarness, Session } from '@scream-code/scream-code-sdk';
import type { AppState, ScreamTUIOptions, TranscriptEntry } from '#/tui/types';
import type { TUIState } from '#/tui/tui-state';
import type { ResolvedTheme } from '#/tui/theme/colors';
import type { Theme } from '#/tui/theme/index';
import type { AuthFlowController } from '#/tui/controllers/auth-flow';
import type { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import type { SessionReplayRenderer } from '#/tui/controllers/session-replay';
import type { SessionManager } from '#/tui/managers/session-manager';

/** SGR sequence chalk emits for a hex colour at level 3 (colour assertions). */
function hexToSgr(hex: string): string {
  const value = hex.replace(/^#/, '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${String(r)};${String(g)};${String(b)}m`;
}

import { createMockTUIState, makeMockStreamingUI } from '../fixtures/mock-host';

function createMockHost(overrides: {
  state?: TUIState;
  transcriptController?: TranscriptController;
  streamingUIOverrides?: Record<string, unknown>;
} = {}): LifecycleControllerHost {
  const host: LifecycleControllerHost = {
    state: overrides.state ?? ({ appState: {} as AppState } as TUIState),
    options: {} as ScreamTUIOptions,
    harness: {} as ScreamHarness,
    session: undefined,
    streamingUI: makeMockStreamingUI(overrides.streamingUIOverrides),
    setStartupReady: vi.fn(),
    appendStartupNotice: vi.fn(),
    refreshSkillCommands: vi.fn(),
    refreshSessionTitle: vi.fn(),
    syncRuntimeState: vi.fn(),
    closeSession: vi.fn(),
    stop: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    applyResolvedAutoTheme: vi.fn(),
    applyTheme: vi.fn(),
    updateActivityPane: vi.fn(),
    setAppState: vi.fn((patch: Partial<AppState>) => {
      Object.assign(host.state.appState, patch);
    }),
    updateEditorBorderHighlight: vi.fn(),
    authFlow: {} as AuthFlowController,
    sessionManager: {} as SessionManager,
    sessionEventHandler: {} as SessionEventHandler,
    sessionReplay: {} as SessionReplayRenderer,
    transcriptController:
      overrides.transcriptController ??
      ({
        getIngestCount: () => 0,
        getFoldedEntryCounts: () => ({ turns: 0, toolCalls: 0 }),
      } as unknown as TranscriptController),
    onEmergencyExit: vi.fn((exitCode?: number) => {
      throw new Error(`emergency-exit-${exitCode ?? 129}`);
    }) as unknown as LifecycleControllerHost['onEmergencyExit'],
  };
  return host;
}

function createDeadTerminalError(code: 'EIO' | 'EPIPE' | 'ENOTCONN'): Error {
  return Object.assign(new Error(`read ${code}`), { code });
}

describe('LifecycleController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('dock row contract', () => {
    it('keeps the footer at two rows and the status row at one', () => {
      // The footer always renders two lines (footer-context locks that); these
      // constants are what buildLayout reserves for it. A silent change here
      // would clip the second row on a short terminal.
      expect(DOCK_FOOTER_ROWS).toBe(2);
      expect(DOCK_STATUS_ROWS).toBe(1);
    });
  });

  describe('collaboration ticker', () => {
    function makeHost(ui: { requestRender: () => void }) {
      const state = {
        appState: {} as AppState,
        ui,
        theme: { colors: { warning: '#FFB020', success: '#79EB00' } },
      } as unknown as TUIState;
      return createMockHost({ state });
    }

    it('shows the newest notice and clears it after the 8s TTL', () => {
      vi.useFakeTimers();
      const ui = { requestRender: vi.fn() };
      const controller = new LifecycleController(makeHost(ui));

      controller.showCollabActivity('coder 向 Scream 求助中！问题：因为 A', 'request');
      expect(controller.getCollabActivity()).toEqual({
        text: 'coder 向 Scream 求助中！问题：因为 A',
        color: '#FFB020',
      });
      expect(ui.requestRender).toHaveBeenCalled();

      // A newer event replaces the previous one — no queue, no stacking.
      controller.showCollabActivity('Scream 已处理 coder 的请求！', 'handled');
      expect(controller.getCollabActivity()).toEqual({
        text: 'Scream 已处理 coder 的请求！',
        color: '#79EB00',
      });

      vi.advanceTimersByTime(7_999);
      expect(controller.getCollabActivity()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(controller.getCollabActivity()).toBeNull();
      // The expiry repaints so the row drops the line immediately.
      expect(ui.requestRender).toHaveBeenCalledTimes(3);

      controller.stopActivityAnimation();
    });

    it('renders the status row with one chip grammar', () => {
      vi.useFakeTimers();
      const previousLevel = chalk.level;
      chalk.level = 3;
      let controller: LifecycleController | undefined;
      let idleController: LifecycleController | undefined;
      try {
      const state = createMockTUIState({
        appState: {
          streamingPhase: 'waiting',
          reconnectAttempt: 2,
          reconnectMaxAttempts: 10,
          reconnectStatusCode: 429,
          reconnectDelayMs: 20_000,
        },
      });
      const host = createMockHost({ state });
      controller = new LifecycleController(host);

      controller.forceUpdateStatusBar();
      controller.showCollabActivity('🤝 coder 求助：因为缺少基线', 'request');
      const working = state.statusBarContainer.render(120).join('\n');
      // Alert chip and the collaboration chip coexist; both use the shared
      // `symbol label：value` grammar.
      expect(working).toContain('⚠️ 重连中 2/10：');
      expect(working).toContain('🤝 coder 求助：因为缺少基线');
      // Semantic colours: warning for the alert, warning for the request chip.
      expect(working).toContain(`${hexToSgr(state.theme.colors.warning)}⚠️ 重连中`);
      expect(working).toContain(`${hexToSgr(state.theme.colors.warning)}🤝 coder`);

      // Idle: the hint becomes `💡 <tip>` and a live notice supersedes it.
      const idle = createMockTUIState({ appState: { streamingPhase: 'idle' } });
      const idleHost = createMockHost({ state: idle });
      idleController = new LifecycleController(idleHost);
      idleController.forceUpdateStatusBar();
      const idleRow = idle.statusBarContainer.render(120).join('\n');
      expect(idleRow).toContain('💡 ');
      // The hint uses the theme's dim token, not a hardcoded grey.
      expect(idleRow).toContain(`${hexToSgr(idle.theme.colors.textDim)}💡 `);
      expect(idleRow).not.toContain(hexToSgr('#999999'));
      idleController.showCollabActivity('✓ Scream 已处理 coder 的请求', 'handled');
      const afterNotice = idle.statusBarContainer.render(120).join('\n');
      expect(afterNotice).toContain('✓ Scream 已处理');
      expect(afterNotice).not.toContain('💡');

      } finally {
        controller?.stopActivityAnimation();
        idleController?.stopActivityAnimation();
        chalk.level = previousLevel;
      }
    });

    it('mounts the ticker on both the idle and the working row', () => {
      vi.useFakeTimers();
      const state = createMockTUIState({
        appState: { streamingPhase: 'idle', reconnectAttempt: undefined },
      });
      const host = createMockHost({ state });
      const controller = new LifecycleController(host);

      controller.forceUpdateStatusBar();
      expect(state.statusBarContainer.render(80).join('\n')).not.toContain('求助中');

      controller.showCollabActivity('coder 向 Scream 求助中！问题：因为 A', 'request');
      // Idle row reads the live getter — no rebuild needed for the notice.
      expect(state.statusBarContainer.render(80).join('\n')).toContain('求助中');

      // The working row mounts the same getter, so the phase change keeps it.
      state.appState.streamingPhase = 'waiting';
      controller.forceUpdateStatusBar();
      expect(state.statusBarContainer.render(80).join('\n')).toContain('求助中');

      controller.stopActivityAnimation();
      state.statusBarContainer.clear();
      controller.forceUpdateStatusBar();
      expect(state.statusBarContainer.render(80).join('\n')).not.toContain('求助中');
    });

    it('re-arms the TTL on every new event', () => {
      vi.useFakeTimers();
      const ui = { requestRender: vi.fn() };
      const controller = new LifecycleController(makeHost(ui));

      controller.showCollabActivity('first', 'request');
      vi.advanceTimersByTime(6_000);
      controller.showCollabActivity('second', 'handled');
      vi.advanceTimersByTime(6_000);
      // 12s after the first event, but only 6s after the latest one.
      expect(controller.getCollabActivity()?.text).toBe('second');

      vi.advanceTimersByTime(2_000);
      expect(controller.getCollabActivity()).toBeNull();
      controller.stopActivityAnimation();
    });

    it('stopActivityAnimation clears the notice and its timer', () => {
      vi.useFakeTimers();
      const ui = { requestRender: vi.fn() };
      const host = makeHost(ui);
      const controller = new LifecycleController(host);

      controller.showCollabActivity('leftover', 'request');
      controller.stopActivityAnimation();
      expect(controller.getCollabActivity()).toBeNull();

      // The cleared timer must not fire after shutdown.
      const before = ui.requestRender.mock.calls.length;
      vi.advanceTimersByTime(30_000);
      expect(ui.requestRender.mock.calls.length).toBe(before);
    });
  });

  describe('footer git diff stats', () => {
    it('serves a deferred snapshot instead of probing git inside render', () => {
      vi.useFakeTimers();
      const host = createMockHost();
      const ui = { requestRender: vi.fn() };
      (host.state as unknown as { ui: typeof ui }).ui = ui;
      const controller = new LifecycleController(host);
      const internals = controller as unknown as {
        readSidebarGit: (workDir: string) => unknown;
      };
      const readSpy = vi.spyOn(internals, 'readSidebarGit').mockReturnValue({
        workDir: '/repo',
        diffAdded: 7,
        diffDeleted: 2,
        filesCount: 1,
      });

      // First frame: nothing cached yet — no synchronous git probe.
      expect(controller.getGitDiffStats('/repo')).toBeNull();
      expect(readSpy).not.toHaveBeenCalled();

      // The deferred read lands on the next tick and repaints.
      vi.advanceTimersByTime(0);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(ui.requestRender).toHaveBeenCalled();
      expect(controller.getGitDiffStats('/repo')).toEqual({ added: 7, deleted: 2 });

      // Still fresh: no second probe within the TTL.
      vi.advanceTimersByTime(0);
      expect(readSpy).toHaveBeenCalledTimes(1);

      controller.stopGitDiffRefresh();
    });

    it('does not re-probe a non-repo workdir on every frame', () => {
      vi.useFakeTimers();
      const host = createMockHost();
      const ui = { requestRender: vi.fn() };
      (host.state as unknown as { ui: typeof ui }).ui = ui;
      const controller = new LifecycleController(host);
      const internals = controller as unknown as {
        readSidebarGit: (workDir: string) => unknown;
      };
      const readSpy = vi.spyOn(internals, 'readSidebarGit').mockReturnValue(undefined);

      for (let i = 0; i < 30; i += 1) {
        expect(controller.getGitDiffStats('/not-a-repo')).toBeNull();
        vi.advanceTimersByTime(16);
      }
      // One probe per TTL window, not one per frame.
      expect(readSpy.mock.calls.length).toBeLessThanOrEqual(2);

      controller.stopGitDiffRefresh();
    });
  });

  describe('line daemon status', () => {
    it('commits the initial and interval poll results through setAppState', async () => {
      vi.useFakeTimers();
      vi.spyOn(lineStatus, 'readLineFooterStatus')
        .mockResolvedValueOnce({ active: true, platform: 'lark' })
        .mockResolvedValueOnce({ active: false, platform: 'lark' });
      const host = createMockHost();
      const controller = new LifecycleController(host);

      controller.startLinePolling();
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenNthCalledWith(1, { lineActive: true, linePlatform: 'lark' });

      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenNthCalledWith(2, { lineActive: false, linePlatform: 'lark' });

      controller.stopLinePolling();
    });

    it('stands down after a command-driven write so a stale read cannot clobber it', async () => {
      vi.useFakeTimers();
      vi.spyOn(lineStatus, 'readLineFooterStatus').mockResolvedValue({
        active: false,
        platform: 'lark',
      });
      const host = createMockHost();
      const controller = new LifecycleController(host);

      controller.startLinePolling();
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenCalledTimes(1);

      // /line start wrote `lineActive: true` a moment before the next poll
      // fires: that poll must not overwrite it with the stale read.
      vi.advanceTimersByTime(29_999);
      controller.noteLineStateWrite();
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenCalledTimes(1);

      // A later cycle (past the grace window) resumes normally.
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenCalledTimes(2);

      controller.stopLinePolling();
    });

    it('commits the delayed refresh through setAppState after 1.5 seconds', async () => {
      vi.useFakeTimers();
      vi.spyOn(lineStatus, 'readLineFooterStatus').mockResolvedValue({
        active: true,
        platform: 'wechat',
      });
      const host = createMockHost();
      const controller = new LifecycleController(host);

      controller.refreshLineStatus();
      vi.advanceTimersByTime(1499);
      expect(host.setAppState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenCalledWith({ lineActive: true, linePlatform: 'wechat' });
    });
  });

  describe('installSignalHandlers', () => {
    it('emergency-exits on stdin EIO (read EIO)', () => {
      const host = createMockHost();
      const controller = new LifecycleController(host);
      controller.installSignalHandlers();

      expect(() => {
        process.stdin.emit('error', createDeadTerminalError('EIO'));
      }).toThrow('emergency-exit-129');

      controller.uninstallSignalHandlers();
    });

    it('emergency-exits on stdout EIO', () => {
      const host = createMockHost();
      const controller = new LifecycleController(host);
      controller.installSignalHandlers();

      expect(() => {
        process.stdout.emit('error', createDeadTerminalError('EIO'));
      }).toThrow('emergency-exit-129');

      controller.uninstallSignalHandlers();
    });

    it('emergency-exits on stderr EPIPE', () => {
      const host = createMockHost();
      const controller = new LifecycleController(host);
      controller.installSignalHandlers();

      expect(() => {
        process.stderr.emit('error', createDeadTerminalError('EPIPE'));
      }).toThrow('emergency-exit-129');

      controller.uninstallSignalHandlers();
    });

    it('does not emergency-exit for unrelated stdin errors', () => {
      const host = createMockHost();
      const controller = new LifecycleController(host);
      controller.installSignalHandlers();

      // No listener should throw; the error is consumed.
      expect(() => {
        process.stdin.emit('error', Object.assign(new Error('read ENOENT'), { code: 'ENOENT' }));
      }).not.toThrow();
      expect(host.onEmergencyExit).not.toHaveBeenCalled();

      controller.uninstallSignalHandlers();
    });

    it('removes all terminal error listeners on uninstall', () => {
      const host = createMockHost();
      const controller = new LifecycleController(host);

      const beforeStdin = process.stdin.listenerCount('error');
      const beforeStdout = process.stdout.listenerCount('error');
      const beforeStderr = process.stderr.listenerCount('error');

      controller.installSignalHandlers();
      expect(process.stdin.listenerCount('error')).toBe(beforeStdin + 1);
      expect(process.stdout.listenerCount('error')).toBe(beforeStdout + 1);
      expect(process.stderr.listenerCount('error')).toBe(beforeStderr + 1);

      controller.uninstallSignalHandlers();
      expect(process.stdin.listenerCount('error')).toBe(beforeStdin);
      expect(process.stdout.listenerCount('error')).toBe(beforeStdout);
      expect(process.stderr.listenerCount('error')).toBe(beforeStderr);
      expect(host.onEmergencyExit).not.toHaveBeenCalled();
    });
  });

  describe('sidebar hub probe gating', () => {
    // The gate under test is one line in `readSidebarHub`, but it is the whole
    // privacy promise of the Hub panel: no outbound traffic while the sidebar
    // is off screen. Driving it through the private seam keeps the production
    // API unchanged, and avoids `buildSidebarData` (which would shell out to
    // git for the sibling panel).
    interface ProbeSpy {
      calls: number;
      sampleIfStale(): void;
      snapshot(): { samples: never[]; roundAt: undefined; stale: false; pending: false };
    }

    function makeController(): {
      host: LifecycleControllerHost;
      controller: LifecycleController;
      manager: SidebarManager;
      probe: ProbeSpy;
    } {
      const host = createMockHost();
      const manager = new SidebarManager(() => {});
      // `toggle()` refuses to open an empty sidebar, so the gate needs a panel
      // on the stack — a stub, because this test is about visibility only.
      manager.register({
        id: 'stub',
        title: 'Stub',
        width: 30,
        build: () => ({ invalidate: () => {}, render: () => [] }),
      });
      host.state.sidebarManager = manager;
      setProviderLatency(host, { ms: 120, sampledAt: Date.now() });
      const controller = new LifecycleController(host);
      const probe: ProbeSpy = {
        calls: 0,
        sampleIfStale() {
          probe.calls += 1;
        },
        snapshot: () => ({ samples: [], roundAt: undefined, stale: false, pending: false }),
      };
      (controller as unknown as { hubProbe: ProbeSpy }).hubProbe = probe;
      return { host, controller, manager, probe };
    }

    function readHub(controller: LifecycleController): SidebarHubData {
      return (controller as unknown as { readSidebarHub(): SidebarHubData }).readSidebarHub();
    }

    // `sessionEventHandler` is a read-only host field; the seam is the host's
    // own contract, so reach it the way the runtime would.
    function setProviderLatency(
      host: LifecycleControllerHost,
      value: { ms: number | undefined; sampledAt: number | undefined },
    ): void {
      (host as unknown as {
        sessionEventHandler: { getProviderLatency(): typeof value };
      }).sessionEventHandler = { getProviderLatency: () => value };
    }

    it('does not probe while the sidebar is closed', () => {
      const { controller, manager, probe } = makeController();
      manager.close();

      const data = readHub(controller);

      expect(probe.calls).toBe(0);
      // The provider row is measured from real requests, so it survives a
      // closed sidebar — that is not outbound traffic.
      expect(data.samples.map((sample) => sample.id)).toEqual([HUB_MODEL_ROW_ID]);
      // 120ms is over the probe line but a healthy first token: the measured row
      // is judged on its own ladder, so it reads green.
      expect(data.samples[0]).toMatchObject({ ms: 120, tone: 'ok' });
    });

    it('probes once per rebuild while visible, and stops again when closed', () => {
      const { controller, manager, probe } = makeController();

      manager.toggle();
      readHub(controller);
      readHub(controller);
      expect(probe.calls).toBe(2);

      manager.close();
      readHub(controller);
      expect(probe.calls).toBe(2);
    });

    it('keeps the measured row dim when nothing has been measured yet', () => {
      const { host, controller, manager } = makeController();
      setProviderLatency(host, { ms: undefined, sampledAt: undefined });
      manager.close();

      expect(readHub(controller).samples[0]).toMatchObject({ ms: undefined, tone: 'dim' });
    });
  });

  describe('sidebar session stats memo', () => {
    /**
     * The memo keys on the transcript ingress counter, so the harness drives a
     * real TranscriptController — including the real cap fold the counter has
     * to survive — rather than stubbing the count.
     */
    function makeStatsHarness(): {
      state: TUIState;
      transcript: TranscriptController;
      readStats: () => SidebarSessionStats;
    } {
      const state = createMockTUIState({
        appState: {
          sessionUsage: { inputOther: 10, inputCacheRead: 0, inputCacheCreation: 0, output: 5 },
          subagentUsage: {},
        },
      });
      const transcript = new TranscriptController({
        state,
        imageStore: new ImageAttachmentStore(),
        streamingUI: makeMockStreamingUI(),
        showStatus: vi.fn(),
        batchUpdate: (fn: () => void): void => {
          fn();
        },
        forceUpdateStatusBar: vi.fn(),
      } as unknown as TranscriptControllerHost);
      const host = createMockHost({ state, transcriptController: transcript });
      const controller = new LifecycleController(host);
      // Private seam: buildSidebarData would also shell out to git for the
      // sibling panel, and this test is about the stats memo alone.
      const readStats = (): SidebarSessionStats =>
        (
          controller as unknown as {
            readSidebarSessionStats(appState: AppState): SidebarSessionStats;
          }
        ).readSidebarSessionStats(state.appState);
      return { state, transcript, readStats };
    }

    it('recomputes after a capped fold that leaves the entry count unchanged', () => {
      const { state, transcript, readStats } = makeStatsHarness();
      const userEntry = (i: number): TranscriptEntry => ({
        id: `u-${String(i)}`,
        kind: 'user',
        renderMode: 'plain',
        content: `need ${String(i)}`,
      });
      for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES; i += 1) transcript.ingestEntry(userEntry(i));
      const lengthBefore = state.transcriptEntries.length;
      const countBefore = transcript.getIngestCount();
      const before = readStats();
      expect(before.turns).toBe(MAX_TRANSCRIPT_ENTRIES);
      expect(before.toolCalls).toBe(0);

      // One more ingest trips the cap: the fold makes room for the stub by
      // dropping the two oldest rows, so the array lands back on the same
      // length with a different composition. A length-only memo key would
      // serve `before` again here, and a scan-only count would fall back with
      // the dropped turns.
      transcript.ingestEntry({
        id: 't-1',
        kind: 'tool_call',
        renderMode: 'plain',
        content: 'Bash',
        toolCallData: { id: 'tc-1', name: 'Bash', args: { command: 'ls' } },
      });
      expect(state.transcriptEntries.length).toBe(lengthBefore);
      expect(transcript.getIngestCount()).toBeGreaterThan(countBefore);

      const after = readStats();
      // Turns from the folded rows are still counted — nothing fell back — and
      // the new tool call is counted too, which proves the memo recomputed
      // rather than serving `before`.
      expect(after.turns).toBe(before.turns);
      expect(after.toolCalls).toBe(1);
    });

    it('keeps counting past the cap, monotonic and true to every ingest', () => {
      const { transcript, readStats } = makeStatsHarness();
      const userEntry = (i: number): TranscriptEntry => ({
        id: `u-${String(i)}`,
        kind: 'user',
        renderMode: 'plain',
        content: `need ${String(i)}`,
      });
      const toolEntry = (i: number): TranscriptEntry => ({
        id: `t-${String(i)}`,
        kind: 'tool_call',
        renderMode: 'plain',
        content: 'Bash',
        toolCallData: { id: `tc-${String(i)}`, name: 'Bash', args: { command: 'ls' } },
      });
      const statusEntry = (i: number): TranscriptEntry => ({
        id: `s-${String(i)}`,
        kind: 'status',
        renderMode: 'plain',
        content: `row-${String(i)}`,
      });

      let turns = 0;
      let toolCalls = 0;
      let previous = readStats();
      for (let i = 0; i < 5_000; i += 1) {
        switch (i % 5) {
          case 0:
          case 1:
            transcript.ingestEntry(userEntry(i));
            turns += 1;
            break;
          case 2:
            transcript.ingestEntry(toolEntry(i));
            toolCalls += 1;
            break;
          default:
            transcript.ingestEntry(statusEntry(i));
            break;
        }
        const stats = readStats();
        // The regression this pins: past the cap every ingest pushed one row
        // out of the array, so the counters stopped following history.
        expect(stats.turns).toBeGreaterThanOrEqual(previous.turns);
        expect(stats.toolCalls).toBeGreaterThanOrEqual(previous.toolCalls);
        previous = stats;
      }

      expect(previous.turns).toBe(turns);
      expect(previous.toolCalls).toBe(toolCalls);
      expect(turns).toBe(2_000);
      expect(toolCalls).toBe(1_000);
    });

    it('matches the array-derived values while the cap is not reached', () => {
      const { state, transcript, readStats } = makeStatsHarness();
      for (let i = 0; i < 300; i += 1) {
        transcript.ingestEntry({
          id: `e-${String(i)}`,
          kind: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'tool_call' : 'status',
          renderMode: 'plain',
          content: `row-${String(i)}`,
          ...(i % 3 === 1
            ? { toolCallData: { id: `tc-${String(i)}`, name: 'Bash', args: { command: 'ls' } } }
            : {}),
        });
      }

      // Below the cap this is the old derivation, value for value.
      const scan = (kind: TranscriptEntry['kind']): number =>
        state.transcriptEntries.filter((e) => e.kind === kind && e.compactionData === undefined)
          .length;
      const stats = readStats();
      expect(transcript.getFoldedEntryCounts()).toEqual({ turns: 0, toolCalls: 0 });
      expect(stats.turns).toBe(scan('user'));
      expect(stats.toolCalls).toBe(scan('tool_call'));
      expect(stats.turns).toBe(100);
      expect(stats.toolCalls).toBe(100);
    });
  });
});

describe('LifecycleController — reconnect reason wording', () => {
  function reasonKeyFor(patch: Partial<AppState>): string {
    return reconnectReasonKey(patch as AppState);
  }

  it('prefers the structured code over the legacy status-code and name checks', () => {
    // Contradictory legacy fields: the code wins.
    expect(
      reasonKeyFor({
        reconnectErrorCode: 'provider.timeout',
        reconnectStatusCode: 429,
        reconnectErrorName: 'APIStatusError',
      }),
    ).toBe('status.reason_timeout');
  });

  it.each([
    ['provider.rate_limit', 'status.reason_rate_limit'],
    ['provider.timeout', 'status.reason_timeout'],
    ['provider.connection_error', 'status.reason_connection'],
  ])('maps %s to %s', (errorCode, expected) => {
    expect(reasonKeyFor({ reconnectErrorCode: errorCode })).toBe(expected);
  });

  it('still labels a server error by its status code', () => {
    expect(
      reasonKeyFor({ reconnectErrorCode: 'provider.api_error', reconnectStatusCode: 503 }),
    ).toBe('status.reason_server');
  });

  it('falls back to the error name for retry records without a code', () => {
    // Legacy wire records: no `errorCode`, so the timeout used to be
    // recognizable only by the error class name.
    expect(reasonKeyFor({ reconnectErrorName: 'APITimeoutError' })).toBe('status.reason_timeout');
    expect(reasonKeyFor({ reconnectErrorName: 'APIConnectionError' })).toBe(
      'status.reason_connection',
    );
  });

  it('falls back to the status code for retry records without a code', () => {
    expect(reasonKeyFor({ reconnectStatusCode: 429 })).toBe('status.reason_rate_limit');
    expect(reasonKeyFor({ reconnectStatusCode: 500 })).toBe('status.reason_server');
    expect(reasonKeyFor({})).toBe('status.reason_connection');
  });
});
/**
 * The status-bar wave reports network silence: it ramps while the agent is
 * waiting on the model but receiving nothing, and stays on the brand colour
 * while a tool executes locally. These tests drive the real controller so the
 * anchor choice and the palette lookup are both covered (dark theme here — the
 * ramp itself is unit-tested).
 */
describe('status-bar wave colour', () => {
  const originalLevel = chalk.level;

  /** SGR prefix chalk emits for a hex colour at level 3. */
  const sgr = (hex: string): string => {
    const value = Number.parseInt(hex.slice(1), 16);
    return `38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  };

  beforeEach(() => {
    // Every working phase mounts a self-rescheduling 80 ms timer. Fake timers
    // keep those chains from leaking repaints into later tests.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    chalk.level = originalLevel;
  });

  function renderWave(
    appState: Partial<AppState>,
    lastActivityAgoMs = 0,
    streamingUIOverrides: Record<string, unknown> = {},
  ): string {
    chalk.level = 3; // non-TTY test env strips ANSI otherwise
    const state = createMockTUIState({ appState });
    state.lastActivityAt = lastActivityAgoMs === 0 ? 0 : Date.now() - lastActivityAgoMs;
    const controller = new LifecycleController(createMockHost({ state, streamingUIOverrides }));
    controller.updateActivityPane();
    return state.statusBarContainer.render(80).join('\n');
  }

  it('keeps the brand colour while the first token is still expected', () => {
    const line = renderWave({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now() - 2_000,
    });
    expect(line).toContain(sgr('#79eb00'));
  });

  it('turns deep red once the first-token wait passes 25s', () => {
    const line = renderWave({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now() - 40_000,
    });
    expect(line).toContain(sgr('#D32F2F'));
  });

  it('stays green while reasoning tokens keep arriving', () => {
    const line = renderWave(
      { streamingPhase: 'thinking', streamingStartTime: Date.now() - 120_000 },
      1_000,
    );
    expect(line).toContain(sgr('#79eb00'));
  });

  it('turns deep red when the reasoning stream goes silent', () => {
    const line = renderWave(
      { streamingPhase: 'thinking', streamingStartTime: Date.now() - 120_000 },
      40_000,
    );
    expect(line).toContain(sgr('#D32F2F'));
  });

  it('stays on the brand colour while a tool executes, however long it runs', () => {
    const line = renderWave({
      streamingPhase: 'tool',
      streamingStartTime: Date.now() - 10 * 60_000,
    });
    expect(line).toContain(sgr('#79eb00'));
  });

  it('still ramps while the model is authoring a tool call', () => {
    const line = renderWave({
      streamingPhase: 'tool-args',
      streamingStartTime: Date.now() - 40_000,
    });
    expect(line).toContain(sgr('#D32F2F'));
  });

  it('stays green while a tool call is in flight, whatever the phase says', () => {
    // A quiet command (or one whose arguments are still streaming in) is not a
    // dead connection: the call itself is evidence that work is underway, so
    // the wave must not ramp just because the phase or the clock lags.
    for (const phase of ['tool', 'tool-args'] as const) {
      const line = renderWave(
        { streamingPhase: phase, streamingStartTime: Date.now() - 10 * 60_000 },
        10 * 60_000,
        { hasInFlightToolCalls: vi.fn((): boolean => true) },
      );
      expect(line).toContain(sgr('#79eb00'));
    }
  });

  it('floors an in-flight tool call at yellow while a retry is in flight', () => {
    const line = renderWave(
      { streamingPhase: 'tool-args', streamingStartTime: Date.now() - 60_000, reconnectAttempt: 2 },
      0,
      { hasInFlightToolCalls: vi.fn((): boolean => true) },
    );
    expect(line).toContain(sgr('#FFD400'));
  });

  it('resets the clock when an inbound notice arrives mid-wait', () => {
    const line = renderWave(
      { streamingPhase: 'waiting', streamingStartTime: Date.now() - 120_000 },
      1_000,
    );
    expect(line).toContain(sgr('#79eb00'));
  });

  it('floors the wave at yellow while a retry is in flight', () => {
    const line = renderWave({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now() - 2_000,
      reconnectAttempt: 1,
    });
    expect(line).toContain(sgr('#FFD400'));
  });
});

/**
 * The scheduled-task reminder keeps its own slot on the status row: it must not
 * be evicted by a collaboration chip, it outlives one (10s vs 8s), and it is
 * drawn to the left so the row's truncation eats the collaboration line first.
 */
describe('scheduled-task reminder chip', () => {
  const originalLevel = chalk.level;

  beforeEach(() => {
    vi.useFakeTimers();
    chalk.level = 3;
  });

  afterEach(() => {
    vi.useRealTimers();
    chalk.level = originalLevel;
  });

  function mount() {
    const state = createMockTUIState({ appState: { streamingPhase: 'waiting' } });
    const controller = new LifecycleController(createMockHost({ state }));
    controller.updateActivityPane();
    return { state, controller };
  }

  it('renders the reminder on the working row in the accent colour', () => {
    const { state, controller } = mount();
    controller.showReminderActivity('⏰ 定时任务已触发：检查 CI 构建状态', 'fired');

    const line = state.statusBarContainer.render(120).join('\n');
    expect(line).toContain('⏰ 定时任务已触发：检查 CI 构建状态');
    expect(line).toContain(hexToSgr(state.theme.colors.accent));
  });

  it('uses the warning colour for a stale task', () => {
    const { state, controller } = mount();
    controller.showReminderActivity('⚠️ 定时任务已过期，仍触发：检查 CI', 'missed');

    const line = state.statusBarContainer.render(120).join('\n');
    expect(line).toContain(hexToSgr(state.theme.colors.warning));
  });

  it('sits before the collaboration chip so it survives truncation', () => {
    const { state, controller } = mount();
    controller.showReminderActivity('⏰ 定时任务已触发：检查 CI', 'fired');
    controller.showCollabActivity('🤝 coder 求助：缺少样例', 'request');

    const line = state.statusBarContainer.render(200).join('\n');
    expect(line.indexOf('⏰')).toBeGreaterThanOrEqual(0);
    expect(line.indexOf('⏰')).toBeLessThan(line.indexOf('🤝'));
  });

  it('expires after its own 10s, one tick after the collaboration chip', () => {
    const { state, controller } = mount();
    controller.showReminderActivity('⏰ 定时任务已触发：检查 CI', 'fired');
    controller.showCollabActivity('🤝 coder 求助：缺少样例', 'request');

    vi.advanceTimersByTime(8_001);
    let line = state.statusBarContainer.render(200).join('\n');
    expect(line).not.toContain('🤝');
    expect(line).toContain('⏰');

    vi.advanceTimersByTime(2_000);
    line = state.statusBarContainer.render(200).join('\n');
    expect(line).not.toContain('⏰');
  });

  it('clears both chips together on a session switch', () => {
    const { state, controller } = mount();
    controller.showReminderActivity('⏰ 定时任务已触发：检查 CI', 'fired');
    controller.showCollabActivity('🤝 coder 求助：缺少样例', 'request');

    controller.clearStatusActivity();

    const line = state.statusBarContainer.render(200).join('\n');
    expect(line).not.toContain('⏰');
    expect(line).not.toContain('🤝');
    expect(controller.getReminderActivity()).toBeNull();
    expect(controller.getCollabActivity()).toBeNull();
  });
});
