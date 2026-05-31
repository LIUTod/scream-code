import { describe, expect, it, vi } from "vitest";

import { ScreamTUI, type ScreamTUIStartupInput, type TUIState } from "#/tui/scream-tui";
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_LIGHT,
} from "#/tui/utils/terminal-theme";

interface StartupDriver {
  state: TUIState;
  init(): Promise<boolean>;
  initMainTui(): Promise<void>;
}

interface ThemeTrackingDriver extends StartupDriver {
  refreshTerminalThemeTracking(): void;
}

type MigrateExitDriver = StartupDriver;

function makeStartupInput(
  cliOptions: Partial<ScreamTUIStartupInput["cliOptions"]> = {},
  tuiConfig: Partial<ScreamTUIStartupInput["tuiConfig"]> = {},
  resolvedTheme: ScreamTUIStartupInput["resolvedTheme"] = "dark",
): ScreamTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      ...cliOptions,
    },
    tuiConfig: {
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
      ...tuiConfig,
    },
    version: "0.0.0-test",
    workDir: "/tmp/proj-a",
    resolvedTheme,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses-1",
    model: "k2",
    summary: { title: "Session title" },
    getStatus: vi.fn(async () => ({
      model: "k2",
      thinkingLevel: "off",
      permission: "manual",
      planMode: false,
      contextTokens: 10,
      maxContextTokens: 100,
      contextUsage: 0.1,
    })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    listSkills: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
  return {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: "scream-cli-v1", maxContextSize: 100 },
      },
    })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFlags: vi.fn(async () => ({})),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
    ...overrides,
  };
}

function makeDriver(harness: ReturnType<typeof makeHarness>, input: ScreamTUIStartupInput) {
  const driver = new ScreamTUI(harness as never, input) as unknown as StartupDriver;
  vi.spyOn(driver.state.ui, "requestRender").mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, "setProgress").mockImplementation(() => {});
  return driver;
}

type InputListener = Parameters<TUIState["ui"]["addInputListener"]>[0];
const DARK_OSC11_REPORT = "\u001B]11;rgb:2828/2c2c/3434\u0007";
const LIGHT_OSC11_REPORT = "\u001B]11;rgb:fafa/fbfb/fcfc\u0007";

function captureInputListeners(driver: StartupDriver) {
  const listeners: InputListener[] = [];
  const removeInputListener = vi.fn<() => void>();
  const write = vi.spyOn(driver.state.terminal, "write").mockImplementation(() => {});
  const addInputListener = vi
    .spyOn(driver.state.ui, "addInputListener")
    .mockImplementation((listener: InputListener) => {
      listeners.push(listener);
      return removeInputListener;
    });

  return { listeners, removeInputListener, write, addInputListener };
}

describe("ScreamTUI startup", () => {
  it("creates a fresh session from startup flags and syncs runtime state", async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: "k2",
        thinkingLevel: "off",
        permission: "yolo",
        planMode: true,
        contextTokens: 25,
        maxContextTokens: 200,
        contextUsage: 0.125,
      })),
    });
    const harness = makeHarness(session);
    const driver = makeDriver(harness, makeStartupInput({ yolo: true, plan: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: "/tmp/proj-a",
      permission: "yolo",
      planMode: true,
    });
    expect(session.setApprovalHandler).toHaveBeenCalledOnce();
    expect(session.setQuestionHandler).toHaveBeenCalledOnce();
    expect(harness.setTelemetryContext).toHaveBeenCalledWith({ sessionId: null });
    expect(harness.setTelemetryContext).toHaveBeenLastCalledWith({ sessionId: "ses-1" });
    expect(driver.state.startupState).toBe("ready");
    expect(driver.state.appState).toMatchObject({
      sessionId: "ses-1",
      model: "k2",
      permissionMode: "yolo",
      planMode: true,
      contextTokens: 25,
      maxContextTokens: 200,
      contextUsage: 0.125,
      sessionTitle: "Session title",
    });
  });

  it("resumes the latest session for --continue and marks history for replay", async () => {
    const session = makeSession({ id: "ses-latest" });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: "ses-latest" }, { id: "ses-old" }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: "ses-latest" });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe("ready");
    expect(driver.state.appState.sessionId).toBe("ses-latest");
  });

  it("passes the CLI model override when creating a fresh startup session", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ model: "scream-code/k2.5" }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: "/tmp/proj-a",
      model: "scream-code/k2.5",
      permission: undefined,
      planMode: undefined,
    });
  });

  it("applies the CLI model override when resuming a startup session", async () => {
    let model = "k2";
    const session = makeSession({
      setModel: vi.fn(async (nextModel: string) => {
        model = nextModel;
      }),
      getStatus: vi.fn(async () => ({
        model,
        thinkingLevel: "off",
        permission: "manual",
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: "ses-latest" }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ continue: true, model: "scream-code/k2.5" }),
    );

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setModel).toHaveBeenCalledWith("scream-code/k2.5");
    expect(driver.state.appState.model).toBe("scream-code/k2.5");
  });

  it("enters picker startup for bare --session without creating a session", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ session: "" }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe("picker");
  });

  it("tracks terminal theme reports while auto theme is active", () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: "auto" }, "dark"),
    ) as unknown as ThemeTrackingDriver;
    const { listeners, write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(ENABLE_TERMINAL_THEME_REPORTING);
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(write).toHaveBeenCalledWith(QUERY_TERMINAL_THEME);
    expect(listeners).toHaveLength(1);

    write.mockClear();
    expect(listeners[0]?.(TERMINAL_THEME_LIGHT)).toEqual({ consume: true });
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(driver.state.appState.theme).toBe("auto");
    expect(driver.state.theme.resolvedTheme).toBe("dark");
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(DARK_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe("auto");
    expect(driver.state.theme.resolvedTheme).toBe("dark");
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(LIGHT_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe("auto");
    expect(driver.state.theme.resolvedTheme).toBe("light");
    expect(driver.state.ui.requestRender).toHaveBeenCalled();
  });

  it("does not track terminal theme reports for explicit themes", () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput()) as unknown as ThemeTrackingDriver;
    const { write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("disables terminal theme reports after leaving auto theme", () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: "auto" }, "dark"),
    ) as unknown as ThemeTrackingDriver;
    const { write, removeInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();
    driver.state.appState.theme = "dark";
    driver.refreshTerminalThemeTracking();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(DISABLE_TERMINAL_THEME_REPORTING);
  });

  it("keeps non-login startup session errors fatal", async () => {
    const harness = makeHarness(makeSession(), {
      createSession: vi.fn(async () => {
        throw new Error("provider config is invalid");
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).rejects.toThrow("provider config is invalid");
  });

  it("does not mount the footer when resuming a missing session fails", async () => {
    // Regression: a stray pre-startEventLoop render used to paint the footer
    // (cwd/git + "context:" statusline) to the terminal before the fatal
    // error, leaving it stranded above the error message. The footer must not
    // be in the layout tree when initMainTui() throws.
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => []),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: "missing-session" }),
    ) as unknown as StartupDriver;

    await expect(driver.initMainTui()).rejects.toThrow(
      '未找到会话 "missing-session"。',
    );
    expect(uiContainsFooter(driver)).toBe(false);
  });

  it("mounts the footer once startup reaches the main TUI", async () => {
    const session = makeSession({ id: "ses-target" });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: "ses-target", workDir: "/tmp/proj-a" }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: "ses-target" }),
    ) as unknown as MigrateExitDriver;

    // Not mounted until init() succeeds.
    expect(uiContainsFooter(driver)).toBe(false);

    await driver.initMainTui();

    expect(uiContainsFooter(driver)).toBe(true);
  });
});

function uiContainsFooter(driver: StartupDriver): boolean {
  const target: unknown = driver.state.footer;
  const visit = (node: unknown): boolean => {
    if (node === target) return true;
    const children = (node as { children?: unknown[] }).children;
    return Array.isArray(children) && children.some(visit);
  };
  return visit(driver.state.ui);
}
