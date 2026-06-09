import { execSync } from 'node:child_process';

import type { createScreamDeviceId as createScreamDeviceIdFn } from '@scream-cli/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runShell } from '#/cli/run-shell';

import { captureProcessWrite, ExitCalled, mockProcessExit } from '../helpers/process';

type CreateScreamDeviceId = typeof createScreamDeviceIdFn;

const mocks = vi.hoisted(() => {
  type TuiConfigFallback = {
    theme: 'dark' | 'light' | 'auto';
    editorCommand: string | null;
    notifications: { enabled: boolean; condition: 'unfocused' | 'always' };
  };

  class TuiConfigParseError extends Error {
    readonly fallback: TuiConfigFallback;

    constructor(fallback: TuiConfigFallback) {
      super('Invalid TUI config in ~/.scream-code/tui.toml; using defaults.');
      this.fallback = fallback;
    }
  }

  const lifecycleTrack = vi.fn();

  return {
    loadTuiConfig: vi.fn(),
    detectTerminalTheme: vi.fn(),
    screamHarnessConstructor: vi.fn(),
    harnessEnsureConfigFile: vi.fn(),
    harnessGetConfig: vi.fn(async () => ({
      providers: {},
      defaultModel: 'k2',
      telemetry: true,
    })),
    harnessGetCachedAccessToken: vi.fn(),
    harnessClose: vi.fn(),
    harnessTrack: vi.fn(),
    screamTuiConstructor: vi.fn(),
    tuiStart: vi.fn(),
    tuiGetStartupMcpMs: vi.fn(async () => 0),
    tuiGetCurrentSessionId: vi.fn(() => ''),
    tuiHasSessionContent: vi.fn(() => false),
    createScreamDeviceId: vi.fn<CreateScreamDeviceId>(() => 'device-1'),
    initializeTelemetry: vi.fn(),
    setCrashPhase: vi.fn(),
    shutdownTelemetry: vi.fn(),
    telemetryTrack: vi.fn(),
    setTelemetryContext: vi.fn(),
    lifecycleTrack,
    withTelemetryContext: vi.fn(() => ({
      track: lifecycleTrack,
    })),
    resolveScreamHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/scream-code-test-home'),
    harnessCreatesDeviceIdOnConstruction: false,
    execSync: vi.fn(),
    TuiConfigParseError,
  };
});

vi.mock('@scream-cli/scream-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@scream-cli/scream-code-sdk')>();
  return {
    ...actual,
    resolveScreamHome: mocks.resolveScreamHome,
    ScreamHarness: class {
      homeDir: string;
      auth = {
        getCachedAccessToken: mocks.harnessGetCachedAccessToken,
      };
      ensureConfigFile = mocks.harnessEnsureConfigFile;
      getConfig = mocks.harnessGetConfig;
      close = mocks.harnessClose;
      track = mocks.harnessTrack;

      constructor(...args: unknown[]) {
        const options = args[0] as { readonly homeDir?: string } | undefined;
        this.homeDir = options?.homeDir ?? '/tmp/scream-code-test-home';
        if (mocks.harnessCreatesDeviceIdOnConstruction) {
          mocks.createScreamDeviceId(this.homeDir);
        }
        mocks.screamHarnessConstructor(...args);
      }
    },
  };
});

vi.mock('@scream-cli/config', async () => {
  const actual = await vi.importActual<typeof import('@scream-cli/config')>(
    '@scream-cli/config',
  );
  return {
    ...actual,
    createScreamDeviceId: mocks.createScreamDeviceId,
    SCREAM_CODE_PROVIDER_NAME: 'scream-code',
  };
});

vi.mock('@scream-cli/scream-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setCrashPhase: mocks.setCrashPhase,
  shutdownTelemetry: mocks.shutdownTelemetry,
  track: mocks.telemetryTrack,
  setTelemetryContext: mocks.setTelemetryContext,
  withTelemetryContext: mocks.withTelemetryContext,
}));

vi.mock('../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: mocks.TuiConfigParseError,
}));

vi.mock('../../src/tui/index', () => ({
  ScreamTUI: class {
    onExit?: () => Promise<void>;

    constructor(...args: unknown[]) {
      mocks.screamTuiConstructor(this, ...args);
    }

    start = mocks.tuiStart;
    getStartupMcpMs = mocks.tuiGetStartupMcpMs;
    getCurrentSessionId = mocks.tuiGetCurrentSessionId;
    hasSessionContent = mocks.tuiHasSessionContent;
  },
}));

vi.mock('../../src/tui/theme/detect', () => ({
  detectTerminalTheme: mocks.detectTerminalTheme,
}));

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
}));

vi.mock('../../src/tui/components/chrome/loading', () => ({
  runLoadingAnimation: vi.fn(() => Promise.resolve()),
}));

describe('runShell', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.harnessGetConfig.mockResolvedValue({
      providers: {},
      defaultModel: 'k2',
      telemetry: true,
    });
    mocks.tuiGetStartupMcpMs.mockResolvedValue(0);
    mocks.tuiGetCurrentSessionId.mockReturnValue('');
    mocks.tuiHasSessionContent.mockReturnValue(false);
    mocks.createScreamDeviceId.mockImplementation(() => 'device-1');
    mocks.resolveScreamHome.mockImplementation(
      (homeDir?: string) => homeDir ?? '/tmp/scream-code-test-home',
    );
    mocks.harnessCreatesDeviceIdOnConstruction = false;
  });

  it('constructs ScreamHarness and ScreamTUI with startup input', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetStartupMcpMs.mockResolvedValue(47);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-startup');

    const cliOptions = {
      session: undefined,
      continue: false,
      yolo: true,
      auto: false,
      plan: true,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    };

    await runShell(cliOptions, '1.2.3-test');

    expect(mocks.screamHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          userAgentProduct: 'scream-code-cli',
          version: '1.2.3-test',
        }),
      }),
    );
    expect(mocks.harnessEnsureConfigFile).toHaveBeenCalledOnce();
    expect(mocks.harnessEnsureConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.harnessGetConfig.mock.invocationCallOrder[0]!,
    );
    expect(execSync).toHaveBeenCalledWith('stty -ixon', { stdio: 'ignore' });
    expect(mocks.screamTuiConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.createScreamDeviceId).toHaveBeenCalledWith(
      '/tmp/scream-code-test-home',
      expect.any(Object),
    );
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith({
      homeDir: '/tmp/scream-code-test-home',
      deviceId: 'device-1',
      enabled: true,
      appName: 'scream-code-cli',
      version: '1.2.3-test',
      uiMode: 'shell',
      model: 'k2',
      getAccessToken: expect.any(Function),
    });
    expect(mocks.setCrashPhase).toHaveBeenCalledWith('runtime');

    const [, harness, startupInput] = mocks.screamTuiConstructor.mock.calls[0]!;
    expect(harness).toBeTypeOf('object');
    expect(startupInput).toMatchObject({
      cliOptions,
      tuiConfig: {
        theme: 'dark',
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' },
      },
      version: '1.2.3-test',
      workDir: process.cwd(),
      resolvedTheme: 'dark',
    });
    expect(mocks.tuiStart).toHaveBeenCalledOnce();
    expect(mocks.harnessTrack).not.toHaveBeenCalledWith('started', expect.anything());
    expect(mocks.withTelemetryContext).toHaveBeenCalledWith({ sessionId: 'ses-startup' });
    expect(mocks.lifecycleTrack).toHaveBeenCalledWith('started', {
      resumed: false,
      yolo: true,
      auto: false,
      plan: true,
      afk: false,
    });
    expect(mocks.lifecycleTrack).toHaveBeenCalledWith('startup_perf', {
      duration_ms: expect.any(Number),
      config_ms: expect.any(Number),
      init_ms: expect.any(Number),
      mcp_ms: 47,
    });
  });

  it('tracks first launch when device id creation reports first launch', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.createScreamDeviceId.mockImplementationOnce((homeDir, options) => {
      const deviceId = `device-for-${homeDir}`;
      options?.onFirstLaunch?.(deviceId);
      return deviceId;
    });

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
      },
      '1.2.3-test',
    );

    expect(mocks.createScreamDeviceId).toHaveBeenCalledWith(
      '/tmp/scream-code-test-home',
      expect.objectContaining({ onFirstLaunch: expect.any(Function) }),
    );
    expect(mocks.harnessTrack).toHaveBeenCalledWith('first_launch');
  });

  it('registers first launch before harness construction can create the device id', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.harnessCreatesDeviceIdOnConstruction = true;
    const createdHomes = new Set<string>();
    mocks.createScreamDeviceId.mockImplementation((homeDir, options) => {
      const deviceId = `device-for-${homeDir}`;
      if (!createdHomes.has(homeDir)) {
        createdHomes.add(homeDir);
        options?.onFirstLaunch?.(deviceId);
      }
      return deviceId;
    });

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
      },
      '1.2.3-test',
    );

    expect(mocks.createScreamDeviceId).toHaveBeenNthCalledWith(
      1,
      '/tmp/scream-code-test-home',
      expect.objectContaining({ onFirstLaunch: expect.any(Function) }),
    );
    expect(mocks.createScreamDeviceId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.screamHarnessConstructor.mock.invocationCallOrder[0]!,
    );
    expect(mocks.screamHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/tmp/scream-code-test-home' }),
    );
    expect(mocks.harnessTrack).toHaveBeenCalledWith('first_launch');
  });

  it('marks resumed lifecycle starts from session flags', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');

    await runShell(
      {
        session: 'ses-1',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
      },
      '1.2.3-test',
    );

    expect(mocks.lifecycleTrack).toHaveBeenCalledWith('started', {
      resumed: true,
      yolo: false,
      auto: false,
      plan: false,
      afk: false,
    });
  });

  it('binds startup_perf to the session captured before MCP metrics resolve', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    let currentSessionId = 'ses-startup';
    mocks.tuiGetCurrentSessionId.mockImplementation(() => currentSessionId);
    mocks.tuiGetStartupMcpMs.mockImplementation(async () => {
      currentSessionId = 'ses-later';
      return 47;
    });

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
      },
      '1.2.3-test',
    );

    expect(mocks.withTelemetryContext).toHaveBeenNthCalledWith(1, { sessionId: 'ses-startup' });
    expect(mocks.withTelemetryContext).toHaveBeenNthCalledWith(2, { sessionId: 'ses-startup' });
    expect(mocks.lifecycleTrack).toHaveBeenNthCalledWith(2, 'startup_perf', {
      duration_ms: expect.any(Number),
      config_ms: expect.any(Number),
      init_ms: expect.any(Number),
      mcp_ms: 47,
    });
  });

  it('detects auto theme and forwards config parse warnings as startup notice', async () => {
    mocks.loadTuiConfig.mockRejectedValue(
      new mocks.TuiConfigParseError({
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      }),
    );
    mocks.detectTerminalTheme.mockResolvedValue('light');
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: '',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
      },
      '1.2.3-test',
    );

    expect(mocks.detectTerminalTheme).toHaveBeenCalledOnce();
    const [, , startupInput] = mocks.screamTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice: 'Invalid TUI config in ~/.scream-code/tui.toml; using defaults.',
      resolvedTheme: 'light',
      tuiConfig: {
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      },
    });
  });

  it('closes the harness when TUI startup fails', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockRejectedValue(new Error('boom'));

    await expect(
      runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
        auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
        },
        '1.2.3-test',
      ),
    ).rejects.toThrow('boom');

    expect(mocks.setCrashPhase).toHaveBeenCalledWith('shutdown');
    expect(mocks.harnessTrack).toHaveBeenCalledWith('exit', { duration_s: expect.any(Number) });
    expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce();
    expect(mocks.harnessClose).toHaveBeenCalledOnce();
  });

  it('tracks exit and prints resume instructions from the TUI exit handler', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite('stdout');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
        auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
        },
        '1.2.3-test',
      );
      const [tui] = mocks.screamTuiConstructor.mock.calls[0]!;
      mocks.harnessTrack.mockClear();
      mocks.lifecycleTrack.mockClear();
      mocks.withTelemetryContext.mockClear();

      await expect((tui as { onExit: () => Promise<void> }).onExit()).rejects.toBeInstanceOf(
        ExitCalled,
      );

      expect(mocks.setCrashPhase).toHaveBeenCalledWith('shutdown');
      expect(mocks.withTelemetryContext).toHaveBeenCalledWith({ sessionId: 'ses-1' });
      expect(mocks.lifecycleTrack).toHaveBeenCalledWith('exit', {
        duration_s: expect.any(Number),
      });
      expect(mocks.harnessTrack).not.toHaveBeenCalledWith('exit', expect.anything());
      expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce();
      expect(stdout.text()).toBe(' 再见！\n');
      expect(stderr.text()).toContain(' 恢复此会话：scream -r ses-1');
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });

});
