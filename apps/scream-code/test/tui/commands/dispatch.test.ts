import { t } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { getLlmNotSetMessage } from '#/tui/constant/scream-tui';
import { ExitCalled, mockProcessExit } from '../../helpers/process';
import { makeMockSession, makeMockSlashCommandHost } from '../fixtures/mock-host';

// Representative handler modules are mocked so routing assertions are exact;
// everything else (parse / resolve / registry / the remaining ~20 handler
// modules) loads for real — the module graph is proven loadable.
vi.mock('../../../src/tui/commands/config.js', () => ({
  handleAskCommand: vi.fn(async (): Promise<void> => {}),
  handleAutoCommand: vi.fn(async (): Promise<void> => {}),
  handleBotCommand: vi.fn(async (): Promise<void> => {}),
  handleCompactCommand: vi.fn(async (): Promise<void> => {}),
  handleEditorCommand: vi.fn(async (): Promise<void> => {}),
  handleFusionPlanCommand: vi.fn(async (): Promise<void> => {}),
  handleModelCommand: vi.fn(async (): Promise<void> => {}),
  handlePlanCommand: vi.fn(async (): Promise<void> => {}),
  handleWolfpackCommand: vi.fn(async (): Promise<void> => {}),
  handleThemeCommand: vi.fn(async (): Promise<void> => {}),
  handleYoloCommand: vi.fn(async (): Promise<void> => {}),
  handleRlmCommand: vi.fn(async (): Promise<void> => {}),
  handleRlmMaxDepthCommand: vi.fn(async (): Promise<void> => {}),
  showModelPicker: vi.fn(),
  showPermissionPicker: vi.fn(),
  showSettingsSelector: vi.fn(),
}));

vi.mock('../../../src/tui/commands/goal.js', () => ({
  handleGoalCommand: vi.fn(async (): Promise<void> => {}),
}));

vi.mock('../../../src/tui/commands/info.js', () => ({
  showMcpServers: vi.fn(async (): Promise<void> => {}),
  showStatusReport: vi.fn(async (): Promise<void> => {}),
  showUsage: vi.fn(async (): Promise<void> => {}),
}));

import {
  handleGoalCommand,
} from '../../../src/tui/commands/goal.js';
import {
  handleModelCommand,
  handleThemeCommand,
  showPermissionPicker,
} from '../../../src/tui/commands/config.js';
import { showStatusReport, showUsage } from '../../../src/tui/commands/info.js';

function makeHost(overrides: {
  appState?: Record<string, unknown>;
  skillCommands?: Iterable<readonly [string, string]>;
  withSession?: boolean;
} = {}): SlashCommandHost {
  return makeMockSlashCommandHost({
    appState: (overrides.appState ?? {}) as never,
    skillCommands: overrides.skillCommands,
    session: overrides.withSession === false ? undefined : makeMockSession(),
  });
}

/** dispatchInput fires async handlers via `void` — drain microtasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

let unhandledGuard: (error: unknown) => void;

beforeEach(() => {
  vi.clearAllMocks();
  // The exit-catch path throws ExitCalled from inside a floating
  // `.catch(() => process.exit(1))` chain; keep it from failing the run.
  unhandledGuard = (error: unknown): void => {
    if (!(error instanceof ExitCalled)) {
      // re-throw everything else loudly
      throw error;
    }
  };
  process.on('unhandledRejection', unhandledGuard);
});

afterEach(() => {
  process.off('unhandledRejection', unhandledGuard);
});

describe('dispatchInput — command vs message split', () => {
  it('routes non-slash text straight to sendNormalUserInput', () => {
    const host = makeHost();
    dispatchInput(host, 'just prose');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('just prose');
  });

  it('routes an unknown slash command as a message (resolve → message intent)', () => {
    const host = makeHost();
    dispatchInput(host, '/definitely-not-a-command hello');
    void settle();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('/definitely-not-a-command hello');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('routes /help to the host help panel', async () => {
    const host = makeHost();
    dispatchInput(host, '/help');
    await settle();
    expect(host.showHelpPanel).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchInput — intent routing', () => {
  it('blocked (streaming): refuses idle-only commands with the busy message', async () => {
    const host = makeHost({ appState: { streamingPhase: 'waiting' } });
    dispatchInput(host, '/model gpt-x');
    await settle();
    expect(handleModelCommand).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(
      'Cannot /model while streaming — press Esc or Ctrl-C first.',
    );
  });

  it('blocked (compacting): refuses while a compaction runs', async () => {
    const host = makeHost({ appState: { isCompacting: true } });
    dispatchInput(host, '/model');
    await settle();
    expect(host.showError).toHaveBeenCalledWith(
      'Cannot /model while compacting — wait for compaction to finish first.',
    );
  });

  it('builtin: forwards name and args to the handler', async () => {
    const host = makeHost();
    dispatchInput(host, '/theme solar');
    await settle();
    expect(handleThemeCommand).toHaveBeenCalledWith(host, 'solar');
  });

  it('builtin: synchronous handlers route too (permission picker)', async () => {
    const host = makeHost();
    dispatchInput(host, '/permission');
    await settle();
    expect(showPermissionPicker).toHaveBeenCalledWith(host);
  });

  it('skill: maps slash alias to sendSkillActivation with trimmed args', async () => {
    const host = makeHost({ skillCommands: [['flow', 'my-flow']] });
    dispatchInput(host, '/flow   arg one  ');
    await settle();
    expect(host.sendSkillActivation).toHaveBeenCalledWith(
      host.session,
      'my-flow',
      'arg one',
    );
  });

  it('skill: guarded when no model is configured', async () => {
    const host = makeHost({ skillCommands: [['flow', 'my-flow']], appState: { model: '' } });
    dispatchInput(host, '/flow go');
    await settle();
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(getLlmNotSetMessage());
  });

  it('skill: guarded when there is no live session', async () => {
    const host = makeHost({ skillCommands: [['flow', 'my-flow']], withSession: false });
    dispatchInput(host, '/flow go');
    await settle();
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(getLlmNotSetMessage());
  });

  it('invalid intent surfaces via showError naming the command', async () => {
    // Pre-fix the switch had no 'invalid' case at all: an invalid intent
    // (part of resolveSlashCommandInput's declared return type) fell
    // through the switch and the input vanished silently.
    const resolveNs = await import('#/tui/commands/resolve');
    const spy = vi.spyOn(resolveNs, 'resolveSlashCommandInput').mockReturnValue({
      kind: 'invalid',
      commandName: 'frobnicate',
      reason: 'unknown',
    });
    try {
      const host = makeHost();
      dispatchInput(host, '/frobnicate x');
      await settle();
      expect(host.showError).toHaveBeenCalledTimes(1);
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('frobnicate'));
      expect(handleModelCommand).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('unhandled intent kind hits the defensive default arm (showError, never silent)', async () => {
    // The switch's `never` default guards intent kinds beyond today's union
    // (compile-time exhaustiveness + a runtime error line as backstop).
    const resolveNs = await import('#/tui/commands/resolve');
    const spy = vi
      .spyOn(resolveNs, 'resolveSlashCommandInput')
      .mockReturnValue({ kind: 'bogus-future-intent' } as never);
    try {
      const host = makeHost();
      dispatchInput(host, '/anything');
      await settle();
      expect(host.showError).toHaveBeenCalledTimes(1);
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('Unhandled slash-command intent'),
      );
      expect(handleModelCommand).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('dispatchInput — goaloff dark branch', () => {
  it('/goaloff resolves to the goal builtin and forces args to "off"', async () => {
    const host = makeHost();
    dispatchInput(host, '/goaloff');
    await settle();
    expect(handleGoalCommand).toHaveBeenCalledTimes(1);
    expect(handleGoalCommand).toHaveBeenCalledWith(host, 'off');
  });

  it('/goal keeps user args untouched', async () => {
    const host = makeHost();
    dispatchInput(host, '/goal refactor the parser');
    await settle();
    expect(handleGoalCommand).toHaveBeenCalledWith(host, 'refactor the parser');
  });

  it('/goal status is never blocked even while streaming (availability fn)', async () => {
    const host = makeHost({ appState: { streamingPhase: 'composing' } });
    dispatchInput(host, '/goal status');
    await settle();
    expect(handleGoalCommand).toHaveBeenCalledWith(host, 'status');
    expect(host.showError).not.toHaveBeenCalled();
  });
});

describe('dispatchInput — host-level commands & catch paths', () => {
  it('/version reports the app version', async () => {
    const host = makeHost({ appState: { version: '1.2.3-rc' } });
    dispatchInput(host, '/version');
    await settle();
    expect(host.showStatus).toHaveBeenCalledWith('Scream Code v1.2.3-rc');
  });

  it('/exit stops cleanly without touching process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new ExitCalled(0);
    }) as never);
    const host = makeHost();
    dispatchInput(host, '/exit');
    await settle();
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('/exit forces process.exit(1) when stop() rejects', async () => {
    const exitSpy = mockProcessExit();
    try {
      const host = makeHost();
      vi.mocked(host.stop).mockRejectedValueOnce(new Error('terminal gone'));
      dispatchInput(host, '/exit');
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
      expect((exitSpy as unknown as { mock: { calls: Array<[string | number | null | undefined]> } }).mock.calls[0]![0]).toBe(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('/sessions surfaces a picker bootstrap failure via session_picker_failed', async () => {
    const host = makeHost();
    vi.mocked(host.showSessionPicker).mockRejectedValueOnce(new Error('picker boom'));
    dispatchInput(host, '/sessions');
    await settle();
    await settle();
    expect(host.showError).toHaveBeenCalledWith(
      t('dispatch.session_picker_failed', { error: 'picker boom' }),
    );
  });

  it('/tasks surfaces a tasks-browser failure', async () => {
    const host = makeHost();
    vi.mocked(host.tasksBrowserController.show).mockRejectedValueOnce(new Error('task boom'));
    dispatchInput(host, '/tasks');
    await settle();
    await settle();
    expect(host.showError).toHaveBeenCalledWith(
      t('dispatch.tasks_browser_failed', { error: 'task boom' }),
    );
  });

  it('/usage surfaces an info failure through usage_failed', async () => {
    const host = makeHost();
    vi.mocked(showUsage).mockRejectedValueOnce(new Error('usage boom'));
    dispatchInput(host, '/usage');
    await settle();
    await settle();
    expect(host.showError).toHaveBeenCalledWith(
      t('dispatch.usage_failed', { error: 'usage boom' }),
    );
  });

  it('/status routes to showStatusReport', async () => {
    const host = makeHost();
    dispatchInput(host, '/status');
    await settle();
    expect(showStatusReport).toHaveBeenCalledWith(host);
  });

  it('/new creates a session and forces a render afterwards', async () => {
    const host = makeHost();
    dispatchInput(host, '/new');
    await settle();
    expect(host.createNewSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.state.ui.requestRender)).toHaveBeenCalled();
  });

  it('a rejecting builtin handler is caught and shown as an error', async () => {
    const host = makeHost();
    vi.mocked(handleThemeCommand).mockRejectedValueOnce(new Error('theme fail'));
    dispatchInput(host, '/theme broken');
    await settle();
    expect(host.showError).toHaveBeenCalledWith('theme fail');
  });
});
