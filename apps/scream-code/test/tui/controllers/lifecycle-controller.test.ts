import { afterEach, describe, expect, it, vi } from 'vitest';

import { LifecycleController } from '#/tui/controllers/lifecycle-controller';
import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import type { SidebarHubData } from '#/tui/components/sidebar/sidebar-panel';
import { HUB_MODEL_ROW_ID } from '#/tui/utils/hub-probe';
import * as ccConnectStatus from '#/tui/utils/cc-connect-status';
import type { LifecycleControllerHost } from '#/tui/controllers/lifecycle-controller';
import type { ScreamHarness, Session } from '@scream-code/scream-code-sdk';
import type { AppState, ScreamTUIOptions } from '#/tui/types';
import type { TUIState } from '#/tui/tui-state';
import type { ResolvedTheme } from '#/tui/theme/colors';
import type { Theme } from '#/tui/theme/index';
import type { AuthFlowController } from '#/tui/controllers/auth-flow';
import type { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import type { SessionReplayRenderer } from '#/tui/controllers/session-replay';
import type { SessionManager } from '#/tui/managers/session-manager';

function createMockHost(): LifecycleControllerHost {
  const host: LifecycleControllerHost = {
    state: { appState: {} as AppState } as TUIState,
    options: {} as ScreamTUIOptions,
    harness: {} as ScreamHarness,
    session: undefined,
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

  describe('cc-connect status', () => {
    it('commits the initial and interval poll results through setAppState', async () => {
      vi.useFakeTimers();
      vi.spyOn(ccConnectStatus, 'checkCcConnectActive')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const host = createMockHost();
      const controller = new LifecycleController(host);

      controller.startCcConnectPolling();
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenNthCalledWith(1, { ccConnectActive: true });

      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenNthCalledWith(2, { ccConnectActive: false });

      controller.stopCcConnectPolling();
    });

    it('commits the delayed refresh through setAppState after three seconds', async () => {
      vi.useFakeTimers();
      vi.spyOn(ccConnectStatus, 'checkCcConnectActive').mockResolvedValue(true);
      const host = createMockHost();
      const controller = new LifecycleController(host);

      controller.refreshCcStatus();
      vi.advanceTimersByTime(2999);
      expect(host.setAppState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(host.setAppState).toHaveBeenCalledWith({ ccConnectActive: true });
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
      // 120ms is over the 100ms line, so the measured row reads as amber.
      expect(data.samples[0]).toMatchObject({ ms: 120, tone: 'warn' });
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
});
