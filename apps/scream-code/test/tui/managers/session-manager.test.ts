import { t } from '@scream-code/config';
import type { SessionSummary } from '@scream-code/scream-code-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionManager,
  type SessionManagerHost,
} from '#/tui/managers/session-manager';
import { getLlmNotSetMessage, MAIN_AGENT_ID } from '#/tui/constant/scream-tui';
import { refreshProviderBalance } from '../../../src/tui/api-balance.js';
import type { AppState } from '#/tui/types';

import {
  createMockTUIState,
  makeMockHarness,
  makeMockSession,
  makeMockStreamingUI,
  makeMockTasksBrowser,
  type MockHarness,
  type MockSession,
} from '../fixtures/mock-host';

// api-balance performs real network lookups — never load it here.
vi.mock('../../../src/tui/api-balance.js', () => ({
  refreshProviderBalance: vi.fn(),
}));

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'ses-old',
    workDir: '/tmp/scream-test',
    sessionDir: '/tmp/scream-test/.sessions/ses-old',
    createdAt: 0,
    updatedAt: 0,
    title: 'Old Shell',
    ...overrides,
  } as SessionSummary;
}

function makeHost(options: {
  appState?: Record<string, unknown>;
  session?: MockSession;
  harness?: MockHarness;
} = {}) {
  const state = createMockTUIState({ appState: (options.appState ?? {}) as never });
  const harness = options.harness ?? makeMockHarness();
  const sessionEventHandler = {
    startSubscription: vi.fn(),
    resetRuntimeState: vi.fn(),
  };
  const sessionReplay = { hydrateFromReplay: vi.fn(async (): Promise<void> => {}) };
  const approvalController = {
    cancelAll: vi.fn(),
    respond: vi.fn(),
    setUIHooks: vi.fn(),
    show: vi.fn(),
  };
  const questionController = {
    cancelAll: vi.fn(),
    respond: vi.fn(),
    setUIHooks: vi.fn(),
    show: vi.fn(),
  };
  const host: SessionManagerHost = {
    harness: harness as never,
    state,
    session: options.session as never,
    sessionEventUnsubscribe: undefined,
    approvalController: approvalController as never,
    questionController: questionController as never,
    reverseRpcDisposers: [],
    sessionEventHandler: sessionEventHandler as never,
    sessionReplay: sessionReplay as never,
    streamingUI: makeMockStreamingUI(),
    tasksBrowserController: makeMockTasksBrowser(),
    startupNotice: undefined,

    showError: vi.fn(),
    showStatus: vi.fn(),
    setAppState: vi.fn((patch: Partial<AppState>) => {
      Object.assign(state.appState, patch);
    }),
    clearTranscriptAndRedraw: vi.fn(),
    refreshSkillCommands: vi.fn(async (): Promise<void> => {}),
    refreshSessionTitle: vi.fn(),
    updateQueueDisplay: vi.fn(),
    appendApprovalTranscriptEntry: vi.fn(),
    showApprovalPanel: vi.fn(),
    hideApprovalPanel: vi.fn(),
    showQuestionDialog: vi.fn(),
    hideQuestionDialog: vi.fn(),
    hasSessionContent: vi.fn((): boolean => false),
    stopMemoryIdleTimer: vi.fn(),
  };
  const manager = new SessionManager(host);
  return { manager, host, state, harness, sessionEventHandler, sessionReplay, approvalController, questionController };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- patch bags are asserted by key */
/** Latest setAppState patch object passed into host.setAppState. */
function lastPatch(host: SessionManagerHost): any {
  const calls = vi.mocked(host.setAppState).mock.calls;
  return calls.at(-1)![0];
}

function patches(host: SessionManagerHost): any[] {
  return vi.mocked(host.setAppState).mock.calls.map(([p]) => p);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionManager.init — startup decision tree', () => {
  it('empty --session flag arms the picker sentinel and throws', async () => {
    const { manager, state } = makeHost();
    await expect(
      manager.init({ startup: { sessionFlag: '', continueLast: false, yolo: false, auto: false, plan: false, wolfpack: false }, workDir: '/tmp/scream-test' }),
    ).rejects.toThrow('picker');
    expect(state.startupState).toBe('picker');
  });

  it('unknown session id rejects with session.not_found', async () => {
    const harness = makeMockHarness({ listSessions: vi.fn(async () => []) });
    const { manager } = makeHost({ harness });
    await expect(
      manager.init({
        startup: { sessionFlag: 'ses-zz', continueLast: false, yolo: false, auto: false, plan: false, wolfpack: false },
        workDir: '/tmp/scream-test',
      }),
    ).rejects.toThrow(t('session.not_found', { sessionId: 'ses-zz' }));
  });

  it('session in another workdir rejects with wrong_dir', async () => {
    const harness = makeMockHarness({
      listSessions: vi.fn(async () => [summary({ id: 'ses-x', workDir: '/other/dir' })]),
    });
    const { manager } = makeHost({ harness });
    await expect(
      manager.init({
        startup: { sessionFlag: 'ses-x', continueLast: false, yolo: false, auto: false, plan: false, wolfpack: false },
        workDir: '/tmp/scream-test',
      }),
    ).rejects.toThrow(t('session.wrong_dir', { sessionId: 'ses-x', workDir: '/other/dir' }));
  });

  it('--session resume: resumes, applies --model, subscribes and replays', async () => {
    const harness = makeMockHarness({
      listSessions: vi.fn(async (input: any) =>
        input['sessionId'] === 'ses-r' ? [summary({ id: 'ses-r' })] : []),
    });
    const resumed = makeMockSession({ id: 'ses-r' });
    harness.resumeSession.mockResolvedValue(resumed);
    const { manager, host, state, sessionEventHandler } = makeHost({ harness });

    const result = await manager.init({
      startup: { sessionFlag: 'ses-r', continueLast: false, yolo: false, auto: false, plan: false, wolfpack: false, model: 'gpt-new' },
      workDir: '/tmp/scream-test',
    });

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'ses-r' });
    expect(resumed.setModel).toHaveBeenCalledWith('gpt-new');
    expect(result.shouldReplay).toBe(true);
    expect(result.session).toBe(resumed);
    expect(host.session).toBe(resumed);
    expect(state.startupState).toBe('ready');
    expect(sessionEventHandler.startSubscription).toHaveBeenCalledTimes(1);
    // wolfpack flag on a resume startup must NOT be re-applied.
    expect(resumed.setWolfpackMode).not.toHaveBeenCalled();
  });

  it('continue-last without history creates a session and records a startup notice', async () => {
    const { manager, host, harness } = makeHost();
    const result = await manager.init({
      startup: { continueLast: true, yolo: true, auto: false, plan: false, wolfpack: false },
      workDir: '/tmp/scream-test',
    });
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workDir: '/tmp/scream-test', permission: 'yolo' }),
    );
    expect(result.shouldReplay).toBe(false);
    expect(host.startupNotice).toContain(t('session.no_resumable', { workDir: '/tmp/scream-test' }));
  });

  it('continue-last accumulates onto an existing startupNotice', async () => {
    const { manager, host, harness } = makeHost();
    host.startupNotice = 'earlier notice';
    await manager.init({
      startup: { continueLast: true, yolo: false, auto: true, plan: false, wolfpack: false },
      workDir: '/tmp/scream-test',
    });
    expect(host.startupNotice).toMatch(/^earlier notice\n/);
    expect(harness.createSession).toHaveBeenCalledWith(expect.objectContaining({ permission: 'auto' }));
  });

  it('plain startup creates a session, applies wolfpack, prunes empties and subscribes', async () => {
    const created = makeMockSession({ id: 'ses-new' });
    const harness = makeMockHarness({
      createSession: vi.fn(async () => created),
      listSessions: vi.fn(async () => [
        // prunable: placeholder title, no prompt, untouched for > 5 min
        summary({ id: 'ses-junk', title: 'New Session', updatedAt: Date.now() - 6 * 60_000 }),
        // keep: real title (mirrors agent-core isUntitled() semantics)
        summary({ id: 'ses-named', title: 'Kept Work', updatedAt: 0 }),
        // keep: current session
        summary({ id: 'ses-new', title: 'New Session', updatedAt: 0 }),
        // keep: has lastPrompt
        summary({ id: 'ses-used', title: 'New Session', lastPrompt: 'hi', updatedAt: 0 }),
      ]),
    });
    const { manager, sessionEventHandler } = makeHost({ harness });

    const result = await manager.init({
      startup: { continueLast: false, yolo: false, auto: false, plan: true, wolfpack: true },
      workDir: '/tmp/scream-test',
    });

    expect(harness.createSession).toHaveBeenCalledWith(expect.objectContaining({ planMode: true }));
    expect(created.setWolfpackMode).toHaveBeenCalledWith(true);
    expect(result.session).toBe(created);
    expect(sessionEventHandler.startSubscription).toHaveBeenCalledTimes(1);
    // Prune: only the stale empty shell gets deleted; current session is skipped.
    expect(harness.deleteSession).toHaveBeenCalledTimes(1);
    expect(harness.deleteSession).toHaveBeenCalledWith('ses-junk');
  });

  it('prune failures never block startup', async () => {
    const harness = makeMockHarness({
      listSessions: vi.fn(async () => { throw new Error('disk gone'); }),
    });
    const { manager, host } = makeHost({ harness });
    await expect(
      manager.init({
        startup: { continueLast: false, yolo: false, auto: false, plan: false, wolfpack: false },
        workDir: '/tmp/scream-test',
      }),
    ).resolves.toBeDefined();
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('Session cleanup skipped'));
  });
});


describe('SessionManager.resumeSession — guards (cc-connect contract)', () => {
  it('same session id is a no-op switch', async () => {
    const { manager, host, harness } = makeHost({ appState: { sessionId: 'ses-mine' } });
    const res = await manager.resumeSession('ses-mine');
    expect(res).toEqual({ switched: true });
    expect(host.showStatus).toHaveBeenCalledWith(t('session.already_in'));
    expect(harness.resumeSession).not.toHaveBeenCalled();
  });

  it('busy streaming refuses with switched:false + blocked:true', async () => {
    const { manager, host, harness } = makeHost({ appState: { streamingPhase: 'composing' } });
    const res = await manager.resumeSession('ses-other');
    expect(res).toEqual({ switched: false, blocked: true });
    expect(host.showError).toHaveBeenCalledWith(t('session.switch_streaming'));
    expect(harness.resumeSession).not.toHaveBeenCalled();
  });

  it('compacting refuses with blocked:true', async () => {
    const { manager } = makeHost({ appState: { isCompacting: true } });
    await expect(manager.resumeSession('ses-other')).resolves.toEqual({ switched: false, blocked: true });
  });

  it('switching-in-progress refuses with blocked:true (isBusy)', async () => {
    const { manager } = makeHost({ appState: { isSwitchingSession: true } });
    await expect(manager.resumeSession('ses-other')).resolves.toEqual({ switched: false, blocked: true });
  });

  it('replaying refuses with blocked:true', async () => {
    const { manager, host } = makeHost({ appState: { isReplaying: true } });
    const res = await manager.resumeSession('ses-other');
    expect(res).toEqual({ switched: false, blocked: true });
    expect(host.showError).toHaveBeenCalledWith(t('session.switch_replaying'));
  });

  it('missing session reports resume_failed WITHOUT blocked', async () => {
    const harness = makeMockHarness({
      resumeSession: vi.fn(async () => { throw new Error('no such session'); }),
    });
    const { manager, host } = makeHost({ harness });
    const res = await manager.resumeSession('ses-gone');
    // The picker relies on `blocked` being absent here to allow creating a
    // replacement session — only genuinely missing sessions lack the flag.
    expect(res).toStrictEqual({ switched: false });
    expect('blocked' in res).toBe(false);
    expect(host.showError).toHaveBeenCalledWith(
      t('session.resume_failed', { sessionId: 'ses-gone', msg: 'no such session' }),
    );
  });

  it('successful resume switches with the resumed status message', async () => {
    const resumed = makeMockSession({ id: 'ses-ok' });
    const harness = makeMockHarness({ resumeSession: vi.fn(async () => resumed) });
    const { manager, host } = makeHost({ harness });
    const res = await manager.resumeSession('ses-ok');
    expect(res).toEqual({ switched: true });
    expect(host.showStatus).toHaveBeenCalledWith(t('session.resumed', { sessionId: 'ses-ok' }));
  });
});

describe('SessionManager.switchToSession', () => {
  it('is guarded by the re-entrancy lock', async () => {
    const { manager, host, sessionEventHandler } = makeHost({ appState: { isSwitchingSession: true } });
    await manager.switchToSession(makeMockSession() as never, 'nope');
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(sessionEventHandler.startSubscription).not.toHaveBeenCalled();
  });

  it('runs the full switch sequence and always releases the lock', async () => {
    const incoming = makeMockSession({ id: 'ses-in' });
    const { manager, host, sessionEventHandler, sessionReplay } = makeHost();

    await manager.switchToSession(incoming as never, 'switched ok');

    expect(patches(host)[0]).toEqual({ isSwitchingSession: true });
    expect(patches(host).at(-1)).toEqual({ isSwitchingSession: false });
    expect(host.session).toBe(incoming);
    expect(host.refreshSkillCommands).toHaveBeenCalledWith(incoming);
    expect(host.clearTranscriptAndRedraw).toHaveBeenCalledTimes(1);
    expect(sessionReplay.hydrateFromReplay).toHaveBeenCalledWith(incoming);
    expect(sessionEventHandler.startSubscription).toHaveBeenCalledTimes(1);
    expect(host.refreshSessionTitle).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('switched ok');
    // reverse RPC handlers registered on the fresh session
    expect(incoming.setApprovalHandler).toHaveBeenCalled();
    expect(incoming.setQuestionHandler).toHaveBeenCalled();
  });

  it('dynamic skill refresh failures are swallowed', async () => {
    const { manager, host } = makeHost();
    vi.mocked(host.refreshSkillCommands).mockRejectedValueOnce(new Error('skills down'));
    await expect(
      manager.switchToSession(makeMockSession() as never, 'msg'),
    ).resolves.toBeUndefined();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('replay failure surfaces replay_failed but keeps the session usable', async () => {
    const { manager, host, sessionReplay, sessionEventHandler } = makeHost();
    vi.mocked(sessionReplay.hydrateFromReplay).mockRejectedValueOnce(new Error('replay boom'));
    await manager.switchToSession(makeMockSession() as never, 'msg');
    expect(host.showError).toHaveBeenCalledWith(t('session.replay_failed', { msg: 'replay boom' }));
    expect(sessionEventHandler.startSubscription).toHaveBeenCalledTimes(1);
    expect(patches(host).at(-1)).toEqual({ isSwitchingSession: false });
  });

  it('resume warnings from the session are shown with the warning color', async () => {
    const session = makeMockSession({
      overrides: { getResumeState: vi.fn(() => ({ warning: '3 events dropped' })) },
    });
    const { manager, host, state } = makeHost();
    await manager.switchToSession(session as never, 'msg');
    expect(host.showStatus).toHaveBeenCalledWith(
      t('session.resume_warning', { warning: '3 events dropped' }),
      state.theme.colors.warning,
    );
  });
});

describe('SessionManager.syncRuntimeState', () => {
  async function syncWith(status: Record<string, unknown>, goal: unknown = { goal: null }) {
    const session = makeMockSession({
      id: 'ses-s',
      overrides: {
        getStatus: vi.fn(async () => ({
          model: 'gpt-x', thinkingLevel: 'low', permission: 'default',
          planMode: false, wolfpackMode: false, rlmEnabled: false,
          contextTokens: 5, maxContextTokens: 10, contextUsage: 0.5,
          ...status,
        })),
        getGoal: vi.fn(async () => goal),
      },
    });
    const { manager, host } = makeHost({ session });
    await manager.syncRuntimeState(session as never);
    return { patch: lastPatch(host), host };
  }

  it.each([
    [{ planMode: false }, 'off'],
    [{ planMode: true, planStrategy: 'normal' }, 'plan'],
    [{ planMode: true, planStrategy: 'fusion' }, 'fusionplan'],
  ])('maps status %+ to planMode=%s', async (status, expected) => {
    const { patch } = await syncWith(status);
    expect(patch.planMode).toBe(expected);
  });

  it('seeds sessionUsage only when the session reports a turnTotal', async () => {
    const withUsage = await syncWith({ usage: { turnTotal: { output: 42 } } });
    expect(withUsage.patch.sessionUsage).toEqual({ output: 42 });
    const without = await syncWith({});
    expect('sessionUsage' in without.patch).toBe(false);
  });

  it('normalizes goal status and derives goalActive', async () => {
    const { patch } = await syncWith({}, {
      goal: { objective: 'ship it', status: 'weird-value', turnsUsed: 2, wallClockMs: 300 },
    });
    const goal: any = patch.goal;
    expect(goal.status).toBe('paused');
    expect(goal.turnsUsed).toBe(2);
    expect(goal.completionCriterion).toBeNull();
    expect(patch.goalActive).toBe(false);
    expect(patch.goalJudge).toBe('awaiting');
    expect(patch.providerBalance).toBeNull();
  });

  it('active goals flip goalActive true', async () => {
    const { patch } = await syncWith({}, { goal: { objective: 'o', status: 'active' } });
    expect(patch.goalActive).toBe(true);
  });

  it('goal fetch failures degrade to a null goal', async () => {
    const session = makeMockSession({
      overrides: { getGoal: vi.fn(async () => { throw new Error('rpc down'); }) },
    });
    const { manager, host } = makeHost({ session });
    await manager.syncRuntimeState(session as never);
    const patch = lastPatch(host);
    expect(patch.goal).toBeNull();
    expect(patch.goalActive).toBe(false);
  });

  it('kicks off the provider balance refresh for the synced model', async () => {
    await syncWith({ model: 'gpt-balance' });
    expect(refreshProviderBalance).toHaveBeenCalledWith('gpt-balance', expect.any(Function));
  });
});

describe('SessionManager.createSessionFromCurrentState / createNewSession', () => {
  it('refuses while replaying', async () => {
    const { manager, host, harness } = makeHost({ appState: { isReplaying: true } });
    await manager.createNewSession();
    expect(host.showError).toHaveBeenCalledWith(t('session.new_replaying'));
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('refuses without a model, reporting through new_failed', async () => {
    const { manager, host, harness } = makeHost({ appState: { model: '' } });
    await manager.createNewSession();
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(
      t('session.new_failed', { msg: getLlmNotSetMessage() }),
    );
  });

  it('happy path wires state, permission and subscription', async () => {
    const created = makeMockSession({ id: 'ses-fresh' });
    const harness = makeMockHarness({ createSession: vi.fn(async () => created) });
    const { manager, host, state, sessionEventHandler } = makeHost({
      harness,
      appState: { permissionMode: 'acceptEdits', thinkingLevel: 'high' },
    });
    await manager.createNewSession();
    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/scream-test',
      model: 'gpt-test',
      thinking: undefined, // no previous session → inherit
      permission: 'acceptEdits',
      planMode: undefined,
    });
    expect(state.appState.sessionId).toBe('ses-fresh');
    expect(created.setPermission).toHaveBeenCalledWith('acceptEdits');
    expect(sessionEventHandler.startSubscription).toHaveBeenCalledTimes(1);
    expect(host.clearTranscriptAndRedraw).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledWith(t('session.new_started', { sessionId: 'ses-fresh' }));
  });

  it('runtime activation failure still leaves the session subscribed and reported', async () => {
    const created = makeMockSession({
      overrides: { setPermission: vi.fn(async () => { throw new Error('perm rpc down'); }) },
    });
    const harness = makeMockHarness({ createSession: vi.fn(async () => created) });
    const { manager, host, sessionEventHandler } = makeHost({ harness });
    await manager.createNewSession();
    expect(sessionEventHandler.startSubscription).toHaveBeenCalledTimes(1);
    expect(host.showError).toHaveBeenCalledWith(t('session.setup_failed', { msg: 'perm rpc down' }));
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});

describe('SessionManager session swap / reset bookkeeping', () => {
  it('setSession closes the previous session and registers handlers once', async () => {
    const first = makeMockSession({ id: 'ses-1' });
    const second = makeMockSession({ id: 'ses-2' });
    const { manager, host } = makeHost({ session: first });
    const unsubscribe = vi.fn();
    host.sessionEventUnsubscribe = unsubscribe;

    await manager.setSession(second as never);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledWith({ extractMemories: false });
    expect(first.setApprovalHandler).toHaveBeenCalledWith(undefined);
    expect(second.setApprovalHandler).toHaveBeenCalled();
    expect(host.session).toBe(second);
    // disposers must not stack across switches
    await manager.setSession(makeMockSession({ id: 'ses-3' }) as never);
    expect(host.reverseRpcDisposers.length).toBe(1);
  });

  it('closeSession cancels all pending reverse-RPC prompts and clears the session', async () => {
    const current = makeMockSession();
    const { manager, host, approvalController, questionController } = makeHost({ session: current });
    await manager.closeSession('bye');
    expect(approvalController.cancelAll).toHaveBeenCalledWith('bye');
    expect(questionController.cancelAll).toHaveBeenCalledWith('bye');
    expect(host.session).toBeUndefined();
    expect(current.close).toHaveBeenCalledWith({ extractMemories: false });
    expect(host.reverseRpcDisposers.length).toBe(0);
  });

  it('resetSessionRuntime sweeps every per-session surface', () => {
    const { manager, host, state, harness, sessionEventHandler } = makeHost();
    (state.queuedMessages as unknown[]).push({ text: 'stale' });
    harness.interactiveAgentId = 'worker-3';
    host.streamingUI.resetToolCallState = vi.fn();

    manager.resetSessionRuntime();

    expect(state.queuedMessages.length).toBe(0);
    expect(harness.interactiveAgentId).toBe(MAIN_AGENT_ID);
    expect(host.streamingUI.discardPending).toHaveBeenCalled();
    expect(host.streamingUI.resetToolCallState).toHaveBeenCalled();
    expect(host.streamingUI.resetToolUi).toHaveBeenCalled();
    expect(sessionEventHandler.resetRuntimeState).toHaveBeenCalled();
    expect(host.tasksBrowserController.close).toHaveBeenCalled();
    expect(state.footer.setBackgroundCounts).toHaveBeenCalledWith({
      bashTasks: 0, agentTasks: 0, foregroundSubagents: 0,
    });
    expect(host.streamingUI.setTodoList).toHaveBeenCalledWith([]);
    expect(host.streamingUI.setTurnId).toHaveBeenCalledWith(undefined);
    expect(host.streamingUI.setStep).toHaveBeenCalledWith(0);
    expect(host.streamingUI.resetLiveText).toHaveBeenCalled();
    expect(host.updateQueueDisplay).toHaveBeenCalled();
    expect(host.stopMemoryIdleTimer).toHaveBeenCalled();
  });

  it('fetchSessions maps rows through the picker formatter and always resets the flag', async () => {
    const harness = makeMockHarness({
      listSessions: vi.fn(async () => [
        summary({ id: 'ses-a', title: 'A', sessionDir: '/d/a' }),
        summary({ id: 'ses-b', title: 'B', sessionDir: '/d/b' }),
      ]),
    });
    const { manager, state } = makeHost({ harness, appState: { sessionId: 'ses-a' } });
    await manager.fetchSessions();
    expect(state.loadingSessions).toBe(false);
    // hasSessionContent() is false → the current empty session is filtered out.
    expect(state.sessions.map((r) => r.id)).toEqual(['ses-b']);
  });

  it('fetchSessions swallows listing errors', async () => {
    const harness = makeMockHarness({ listSessions: vi.fn(async () => { throw new Error('rpc'); }) });
    const { manager, state } = makeHost({ harness });
    await expect(manager.fetchSessions()).resolves.toBeUndefined();
    expect(state.loadingSessions).toBe(false);
  });
});
