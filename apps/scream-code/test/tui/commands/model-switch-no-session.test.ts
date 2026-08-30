/**
 * Regression guards for /model and thinking switching:
 *  1. With NO active session (transcript may linger after the session was
 *     deleted / logged out), selecting a model or cycling thinking must
 *     NEVER create a core session behind the user's back — it only persists
 *     defaults and says so.
 *  2. With a LIVE session, switching must happen IN PLACE on that session
 *     (setModel/setThinking), keeping the same session id, and must not
 *     create or swap sessions.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('#/tui/api-balance', () => ({
  refreshProviderBalance: vi.fn(),
}));

import { changeThinkingLevel, handleModelCommand } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { ModelSelectorOptions } from '#/tui/components/dialogs/model-selector';

interface LiveSession {
  id: string;
  setModel: Mock;
  setThinking: Mock;
  getStatus: Mock;
}

function makeLiveSession(): LiveSession {
  return {
    id: 'core-live',
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ model: 'new-model', thinkingLevel: 'low' })),
  };
}

const tempHomes: string[] = [];

function makeHost(options: { withSession?: boolean; defaultModel?: string } = {}): SlashCommandHost {
  const defaultModel = options.defaultModel ?? 'old-model';
  const session = options.withSession ? makeLiveSession() : undefined;
  const host = {
    session,
    harness: {
      getConfig: vi.fn(async () => ({
        defaultModel,
        models: {
          'old-model': { provider: 'p', model: 'm-old', maxContextSize: 100_000 },
          'new-model': { provider: 'p', model: 'm-new', maxContextSize: 100_000 },
        },
        thinking: { mode: 'off' },
      })),
      setConfig: vi.fn(async () => {}),
      createSession: vi.fn(async () => {
        throw new Error('createSession must not be called by model switching');
      }),
    },
    authFlow: {
      activateModelAfterLogin: vi.fn(async () => {}),
    },
    options: { startup: {} },
    state: {
      appState: {
        workDir: '/tmp',
        model: 'old-model',
        thinkingLevel: 'off',
        streamingPhase: 'idle',
        isCompacting: false,
        contextTokens: 5000,
        planMode: 'off',
        permissionMode: 'manual',
        availableModels: {
          'old-model': { provider: 'p', model: 'm-old', maxContextSize: 100_000 },
          'new-model': { provider: 'p', model: 'm-new', maxContextSize: 100_000 },
        },
      },
      theme: { colors: darkColors },
      ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
    },
    setAppState: vi.fn(),
    setSession: vi.fn(async () => {}),
    syncRuntimeState: vi.fn(async () => {}),
    sessionEventHandler: { startSubscription: vi.fn() },
    fetchSessions: vi.fn(async () => {}),
    refreshSessionTitle: vi.fn(),
    refreshSkillCommands: vi.fn(async () => {}),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return host;
}

function getSelectorProps(host: SlashCommandHost): ModelSelectorOptions {
  const calls = (host.mountEditorReplacement as Mock).mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const component = calls.at(-1)![0] as unknown as { opts: ModelSelectorOptions };
  return component.opts;
}

/** Let the fire-and-forget switch chain drain its microtasks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

async function openPickerAndConfirm(host: SlashCommandHost, alias: string, thinkingLevel: string): Promise<void> {
  await handleModelCommand(host, alias);
  const props = getSelectorProps(host);
  // onSelect is a void-returning callback; flush() drains the real work.
  props.onSelect({ alias, thinkingLevel: thinkingLevel as never });
  await flush();
}

afterEach(async () => {
  await Promise.all(tempHomes.map((d) => rm(d, { recursive: true, force: true })));
  tempHomes.length = 0;
});

describe('/model with no active session (regression guard)', () => {
  it('selecting a model persists the default WITHOUT creating a new session', async () => {
    const host = makeHost();
    await openPickerAndConfirm(host, 'new-model', 'off');

    expect(host.harness.createSession).not.toHaveBeenCalled();
    expect((host as unknown as { setSession: Mock }).setSession).not.toHaveBeenCalled();
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
    // Persisted as the default model instead.
    expect(host.harness.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'new-model' }),
    );
    // The picker state reflects the new model for the next session.
    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'new-model' }),
    );
    // And the user is told there was no active session.
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('No active session'),
      expect.anything(),
    );
    // Storm Breaker must NOT veto on the dead session's stale token count.
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('thinking change is honestly reported when nothing can be saved', async () => {
    // Session gone, and the (stale) active alias is NOT the default model:
    // persistThinkingDefault no-ops, so the status must not claim it saved.
    const host = makeHost({ defaultModel: 'other-model' });
    await changeThinkingLevel(host, 'old-model', 'low');

    expect(host.harness.createSession).not.toHaveBeenCalled();
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('was NOT saved'),
      expect.anything(),
    );
  });
});

describe('/model with a live session (behavior preserved)', () => {
  it('switching updates the SAME session in place and never creates one', async () => {
    const host = makeHost({ withSession: true });
    await openPickerAndConfirm(host, 'new-model', 'low');

    const session = host.session as unknown as LiveSession;
    expect(session.setModel).toHaveBeenCalledWith('new-model');
    expect(session.setThinking).toHaveBeenCalledWith('low');
    expect(host.harness.createSession).not.toHaveBeenCalled();
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
    // Provider-confirmed values from getStatus() flow back into app state.
    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'new-model', thinkingLevel: 'low' }),
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Switched to new-model'),
      expect.anything(),
    );
    // Default persisted as well.
    expect(host.harness.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'new-model' }),
    );
  });

  it('thinking change on the live session applies in place', async () => {
    const host = makeHost({ withSession: true });
    await changeThinkingLevel(host, 'old-model', 'low');

    const session = host.session as unknown as LiveSession;
    expect(session.setThinking).toHaveBeenCalledWith('low');
    expect(host.harness.createSession).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Thinking set to low'),
      expect.anything(),
    );
  });

  it('Storm Breaker still vetoes a smaller-window model for the live session', async () => {
    const host = makeHost({ withSession: true });
    // 5000 tokens context; make the target window smaller than that.
    host.state.appState.contextTokens = 200_000;
    await openPickerAndConfirm(host, 'new-model', 'off');

    expect(host.showNotice).toHaveBeenCalled();
    const session = host.session as unknown as LiveSession;
    expect(session.setModel).not.toHaveBeenCalled();
    expect(host.harness.createSession).not.toHaveBeenCalled();
  });
});
