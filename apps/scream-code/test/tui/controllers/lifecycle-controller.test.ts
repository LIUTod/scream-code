import { afterEach, describe, expect, it, vi } from 'vitest';

import { LifecycleController } from '#/tui/controllers/lifecycle-controller';
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
});
