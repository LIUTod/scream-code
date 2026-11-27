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
import type { SidebarSessionStats } from '#/tui/components/sidebar/session-status';
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

/** A rendered row without its colour codes. */
function plainRow(lines: string[]): string {
  return lines.join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
}

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
    it('keeps the footer at one row and the status row at one', () => {
      // The footer renders one line at every size (footer.test locks it); these
      // constants are what panels size against. A silent change here would let a
      // panel overlap the footer or leave a dead row above it.
      expect(DOCK_FOOTER_ROWS).toBe(1);
      expect(DOCK_STATUS_ROWS).toBe(1);
    });
  });

  describe('footer notice slot', () => {
    function makeHost(ui: { requestRender: () => void }) {
      const state = {
        appState: {} as AppState,
        ui,
        theme: { colors: { warning: '#FFB020', success: '#79EB00', accent: '#00FFAA', error: '#FF4040', textMuted: '#6b7280' } },
      } as unknown as TUIState;
      return createMockHost({ state });
    }

    it('shows the newest collaboration notice and clears it after the 8s TTL', () => {
      vi.useFakeTimers();
      const ui = { requestRender: vi.fn() };
      const controller = new LifecycleController(makeHost(ui));

      controller.showCollabActivity('coder 向 Scream 求助中！问题：因为 A', 'request');
      expect(controller.getNotice()).toEqual({ text: 'coder 向 Scream 求助中！问题：因为 A', color: '#FFB020' });
      expect(ui.requestRender).toHaveBeenCalled();

      // A newer event replaces the previous one: same key, no stacking.
      controller.showCollabActivity('Scream 已处理 coder 的请求！', 'handled');
      expect(controller.getNotice()).toEqual({ text: 'Scream 已处理 coder 的请求！', color: '#79EB00' });

      vi.advanceTimersByTime(7_999);
      expect(controller.getNotice()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(controller.getNotice()).toBeNull();
      // The expiry repaints so the footer drops the line immediately.
      expect(ui.requestRender).toHaveBeenCalledTimes(3);

      controller.stopActivityAnimation();
    });

    it('re-arms the TTL on every new event', () => {
      vi.useFakeTimers();
      const controller = new LifecycleController(makeHost({ requestRender: vi.fn() }));

      controller.showCollabActivity('first', 'request');
      vi.advanceTimersByTime(6_000);
      controller.showCollabActivity('second', 'handled');
      vi.advanceTimersByTime(6_000);
      // 12s after the first event, but only 6s after the latest one.
      expect(controller.getNotice()?.text).toBe('second');
      vi.advanceTimersByTime(2_000);
      expect(controller.getNotice()).toBeNull();
      controller.stopActivityAnimation();
    });

    it('shows one notice at a time, by priority: reminder, MCP problem, collaboration, MCP progress', () => {
      vi.useFakeTimers();
      const controller = new LifecycleController(makeHost({ requestRender: vi.fn() }));

      controller.showMcpNotice('progress', 'MCP 连接中 2/5', '#6b7280');
      expect(controller.getNotice()?.text).toBe('MCP 连接中 2/5');
      controller.showCollabActivity('🤝 coder 求助：缺少样例', 'request');
      expect(controller.getNotice()?.text).toBe('🤝 coder 求助：缺少样例');
      controller.showMcpNotice('failed', '1 个 MCP 服务器失败 · /mcp', '#FF4040');
      expect(controller.getNotice()?.text).toBe('1 个 MCP 服务器失败 · /mcp');
      controller.showReminderActivity('⏰ 定时任务已触发：检查 CI', 'fired');
      expect(controller.getNotice()?.text).toBe('⏰ 定时任务已触发：检查 CI');

      // They are read one after another as each one expires.
      vi.advanceTimersByTime(15_000);
      expect(controller.getNotice()).toBeNull();
      controller.stopActivityAnimation();
    });

    it('hands over to the next notice when the first expires', () => {
      vi.useFakeTimers();
      const controller = new LifecycleController(makeHost({ requestRender: vi.fn() }));
      controller.showReminderActivity('⏰ 提醒', 'fired');
      controller.showCollabActivity('🤝 求助', 'request');
      expect(controller.getNotice()?.text).toBe('⏰ 提醒');
      vi.advanceTimersByTime(10_000);
      expect(controller.getNotice()).toBeNull();

      controller.showReminderActivity('⏰ 提醒', 'fired');
      controller.showCollabActivity('🤝 求助', 'request');
      vi.advanceTimersByTime(8_001);
      // The collaboration notice ran out while the reminder was ahead of it.
      expect(controller.getNotice()?.text).toBe('⏰ 提醒');
      controller.stopActivityAnimation();
    });

    it('colours a reminder with the accent, and a missed one with the warning colour', () => {
      vi.useFakeTimers();
      const controller = new LifecycleController(makeHost({ requestRender: vi.fn() }));
      controller.showReminderActivity('⏰ 定时任务已触发', 'fired');
      expect(controller.getNotice()?.color).toBe('#00FFAA');
      controller.showReminderActivity('⚠️ 定时任务已过期，仍触发', 'missed');
      expect(controller.getNotice()?.color).toBe('#FFB020');
      controller.stopActivityAnimation();
    });

    it('removes an MCP progress notice when the servers settle, and keeps the others', () => {
      vi.useFakeTimers();
      const controller = new LifecycleController(makeHost({ requestRender: vi.fn() }));
      controller.showMcpNotice('progress', 'MCP 连接中 2/5', '#6b7280');
      controller.showMcpNotice('needs-auth', '1 个 MCP 服务器需要认证 · /mcp', '#FFB020');
      controller.clearMcpNotice('progress');
      expect(controller.getNotice()?.text).toBe('1 个 MCP 服务器需要认证 · /mcp');
      controller.clearMcpNotice('needs-auth');
      expect(controller.getNotice()).toBeNull();
    });

    it('a session switch drops every notice', () => {
      vi.useFakeTimers();
      const controller = new LifecycleController(makeHost({ requestRender: vi.fn() }));
      controller.showReminderActivity('⏰ 提醒', 'fired');
      controller.showCollabActivity('🤝 求助', 'request');
      controller.showMcpNotice('failed', 'x', '#f00');
      controller.clearStatusActivity();
      expect(controller.getNotice()).toBeNull();
    });

    it('stopActivityAnimation clears the notices and their timer', () => {
      vi.useFakeTimers();
      const ui = { requestRender: vi.fn() };
      const controller = new LifecycleController(makeHost(ui));

      controller.showCollabActivity('leftover', 'request');
      controller.stopActivityAnimation();
      expect(controller.getNotice()).toBeNull();

      // The cleared timer must not fire after shutdown.
      const before = ui.requestRender.mock.calls.length;
      vi.advanceTimersByTime(30_000);
      expect(ui.requestRender.mock.calls.length).toBe(before);
    });
  });

  describe('status row', () => {
    const originalLevel = chalk.level;
    beforeEach(() => {
      chalk.level = 3;
    });
    afterEach(() => {
      chalk.level = originalLevel;
    });

    it('says the phase and how long while working, and the reconnect detail when a retry runs', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
      const state = createMockTUIState({
        appState: { streamingPhase: 'thinking', streamingStartTime: Date.now() - 12_000, reconnectAttempt: 0 },
      });
      const controller = new LifecycleController(createMockHost({ state }));
      controller.forceUpdateStatusBar();
      expect(state.statusBarContainer.render(100).join('\n')).toContain('思考中 · 12s');

      // The clock is read live: no rebuild is needed for it to move.
      vi.advanceTimersByTime(3_000);
      expect(state.statusBarContainer.render(100).join('\n')).toContain('思考中 · 15s');

      Object.assign(state.appState, {
        streamingPhase: 'waiting',
        reconnectAttempt: 2,
        reconnectMaxAttempts: 10,
        reconnectStatusCode: 429,
        reconnectDelayMs: 20_000,
      });
      controller.forceUpdateStatusBar();
      const retry = state.statusBarContainer.render(120).join('\n');
      expect(retry).toContain('⚠️ 重连中 2/10：');
      expect(retry).toContain(`${hexToSgr(state.theme.colors.warning)}⚠️ 重连中`);
      expect(retry).not.toContain('思考中');
      controller.stopActivityAnimation();
    });

    it('names what the session waits for instead of going empty', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
      const state = createMockTUIState({
        appState: {
          streamingPhase: 'tool',
          streamingStartTime: Date.now() - 300_000,
          pendingUserAction: 'approval',
          pendingUserActionSince: Date.now() - 240_000,
        },
      });
      (state.livePane as { pendingApproval: unknown }).pendingApproval = { id: 'a' };
      const controller = new LifecycleController(createMockHost({ state }));
      controller.forceUpdateStatusBar();
      expect(plainRow(state.statusBarContainer.render(100))).toContain('◆ 等待批准 · 4m');

      (state.livePane as { pendingApproval: unknown }).pendingApproval = null;
      (state.livePane as { pendingQuestion: unknown }).pendingQuestion = { id: 'q' };
      Object.assign(state.appState, { pendingUserAction: 'question', pendingUserActionSince: Date.now() });
      controller.forceUpdateStatusBar();
      expect(plainRow(state.statusBarContainer.render(100))).toContain('◆ 等待回答');

      (state.livePane as { pendingQuestion: unknown }).pendingQuestion = null;
      Object.assign(state.appState, { pendingUserAction: null, isCompacting: true });
      controller.forceUpdateStatusBar();
      expect(plainRow(state.statusBarContainer.render(100))).toContain('◆ 压缩中');
      controller.stopActivityAnimation();
    });

    it('stays empty while a dialog owns the screen', () => {
      const state = createMockTUIState({ appState: { streamingPhase: 'idle' } });
      (state as { activeDialog: string | null }).activeDialog = 'help';
      const controller = new LifecycleController(createMockHost({ state }));
      controller.forceUpdateStatusBar();
      expect(state.statusBarContainer.render(100)).toEqual([]);
      controller.stopActivityAnimation();
    });

    it('shows one tip while the chat is empty, with its close key, and notices are not on this row', () => {
      vi.useFakeTimers();
      const state = createMockTUIState({ appState: { streamingPhase: 'idle', reconnectAttempt: undefined } });
      // Following the output, so the scroll cue is not what shares the row.
      (state.ui as unknown as { isFollowingOutput: boolean }).isFollowingOutput = true;
      const controller = new LifecycleController(createMockHost({ state }));
      controller.forceUpdateStatusBar();
      const row = state.statusBarContainer.render(120).join('\n');
      expect(row).toContain('Tips');
      expect(row).toContain('Ctrl+B 关闭');
      expect(row).not.toContain('💡');
      expect(row).toContain(hexToSgr(state.theme.colors.textMuted));

      controller.showCollabActivity('✓ Scream 已处理 coder 的请求', 'handled');
      expect(state.statusBarContainer.render(120).join('\n')).not.toContain('已处理');
      controller.stopActivityAnimation();
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
        readGitStatus: (workDir: string) => unknown;
      };
      const readSpy = vi.spyOn(internals, 'readGitStatus').mockReturnValue({
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
        readGitStatus: (workDir: string) => unknown;
      };
      const readSpy = vi.spyOn(internals, 'readGitStatus').mockReturnValue(undefined);

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

