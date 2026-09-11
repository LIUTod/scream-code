import { t } from '@scream-code/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DialogManager, type DialogManagerHost } from '#/tui/managers/dialog-manager';
import type { SessionRow } from '#/tui/components/dialogs/session-picker';
import { formatMemoryMemoForInjection } from '#/tui/commands/memory';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import type { AppState } from '#/tui/types';

import {
  createMockTUIState,
  makeMockHarness,
  makeMockSession,
} from '../fixtures/mock-host';

// ---------------------------------------------------------------------------
// Component-module mocks: capture constructor props so tests can drive the
// callbacks (onSelect / onDelete / onClose / onInject…) manually.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const caps = vi.hoisted(() => ({
  picker: [] as any[],
  help: [] as any[],
  memory: [] as any[],
  approval: [] as Array<{ args: any[]; instance: any }>,
  preview: [] as Array<{ props: any; instance: any }>,
  question: [] as Array<{ args: any[]; instance: any }>,
  stores: [] as any[],
}));

vi.mock('../../../src/tui/components/dialogs/session-picker.js', () => ({
  SessionPickerComponent: class {
    stop = vi.fn();
    props: Record<string, unknown>;
    constructor(props: any) {
      this.props = props;
      caps.picker.push(props);
    }
    render(): string[] { return []; }
    invalidate(): void {}
    handleInput(): void {}
  },
}));

vi.mock('../../../src/tui/components/dialogs/help-panel.js', () => ({
  HelpPanelComponent: class {
    stop = vi.fn();
    props: Record<string, unknown>;
    constructor(props: any) {
      this.props = props;
      caps.help.push(props);
    }
    render(): string[] { return []; }
    invalidate(): void {}
    handleInput(): void {}
  },
}));

vi.mock('../../../src/tui/components/dialogs/memory-picker.js', () => ({
  MemoryPickerComponent: class {
    stop = vi.fn();
    props: Record<string, unknown>;
    constructor(props: any) {
      this.props = props;
      caps.memory.push(props);
    }
    render(): string[] { return []; }
    invalidate(): void {}
    handleInput(): void {}
  },
}));

vi.mock('../../../src/tui/components/dialogs/approval-panel.js', () => ({
  ApprovalPanelComponent: class {
    stop = vi.fn();
    constructor(...args: any[]) {
      caps.approval.push({ args, instance: this });
    }
    render(): string[] { return []; }
    invalidate(): void {}
  },
}));

vi.mock('../../../src/tui/components/dialogs/approval-preview.js', () => ({
  ApprovalPreviewViewer: class {
    props: Record<string, unknown>;
    constructor(props: any) {
      this.props = props;
      caps.preview.push({ props, instance: this });
    }
    render(): string[] { return []; }
    invalidate(): void {}
    handleInput(): void {}
  },
}));

vi.mock('../../../src/tui/components/dialogs/question-dialog.js', () => ({
  QuestionDialogComponent: class {
    stop = vi.fn();
    constructor(...args: any[]) {
      caps.question.push({ args, instance: this });
    }
    render(): string[] { return []; }
    invalidate(): void {}
  },
}));

// sqlite-backed memo store must not touch disk in unit tests.
vi.mock('@scream-code/memory', () => ({
  MemoryMemoStore: class {
    init = vi.fn(async (): Promise<void> => {});
    list = vi.fn(async () => ({ memos: [], total: 0 }));
    constructor(_dir: string) {
      caps.stores.push(this);
    }
  },
}));

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

function makeHost(options: {
  appState?: Record<string, unknown>;
  rows?: SessionRow[];
} = {}) {
  const state = createMockTUIState({ appState: (options.appState ?? {}) as never });
  const harness = makeMockHarness();
  const rowsBox = { rows: options.rows ?? [] };
  const approvalController = { respond: vi.fn(), cancelAll: vi.fn(), setUIHooks: vi.fn() };
  const questionController = { respond: vi.fn(), cancelAll: vi.fn(), setUIHooks: vi.fn() };
  const host: DialogManagerHost = {
    state,
    approvalController: approvalController as never,
    questionController: questionController as never,
    harness: harness as never,
    showError: vi.fn(),
    showStatus: vi.fn(),
    forceUpdateStatusBar: vi.fn(),
    exitFullScreenTakeover: vi.fn(),
    sendNormalUserInput: vi.fn(),
    resumeSession: vi.fn(async () => ({ switched: true })),
    switchToSession: vi.fn(async (): Promise<void> => {}),
    deleteSession: vi.fn(async (): Promise<void> => {}),
    fetchSessions: vi.fn(async (): Promise<void> => {}),
    getSessions: vi.fn(() => rowsBox.rows),
    getIsLoadingSessions: vi.fn((): boolean => false),
    getCurrentSessionId: vi.fn((): string => 'ses-current'),
    getCurrentWorkDir: vi.fn((): string => '/tmp/scream-test'),
    toggleToolOutputExpansion: vi.fn(),
    togglePlanExpansion: vi.fn(),
    patchLivePane: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(state.livePane, patch);
    }),
  };
  const manager = new DialogManager(host);
  const editor = state.editor as unknown as { render: () => string[] };
  return { manager, host, state, harness, rowsBox, editor, approvalController, questionController };
}

function row(id: string, metadata?: Record<string, unknown>): SessionRow {
  return { id, title: null, last_prompt: null, work_dir: '/w', session_dir: '/s', updated_at: 0, metadata } as SessionRow;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(caps)) (caps as unknown as Record<string, unknown[]>)[k]!.length = 0;
});

describe('DialogManager — help panel state machine', () => {
  it('opens the help panel, focuses it and restores the editor on close', () => {
    const { manager, host, state, editor } = makeHost();
    manager.showHelpPanel([{ name: 'help', description: 'd', aliases: [] }]);
    expect(state.activeDialog).toBe('help');
    expect(caps.help.length).toBe(1);
    expect(caps.help[0]!.commands).toEqual([{ name: 'help', description: 'd', aliases: [] }]);
    expect(state.editorContainer.children.length).toBe(1);
    expect(state.ui.setFocus).toHaveBeenCalledTimes(1);
    expect(state.ui.requestRender).toHaveBeenCalledTimes(1);
    expect(host.exitFullScreenTakeover).toHaveBeenCalledTimes(1);
    expect(host.forceUpdateStatusBar).toHaveBeenCalledTimes(1);

    (caps.help[0]!.onClose as () => void)();
    expect(state.activeDialog).toBeNull();
    expect(state.editorContainer.children).toContain(editor);
  });
});

describe('DialogManager — session picker callbacks', () => {
  it('fetches sessions before mounting and tracks activeDialog', async () => {
    const { manager, host, state } = makeHost({ rows: [row('ses-a')] });
    await manager.showSessionPicker();
    expect(host.fetchSessions).toHaveBeenCalledTimes(1);
    expect(state.activeDialog).toBe('session-picker');
    expect(caps.picker.length).toBe(1);
    expect(caps.picker[0]!.sessions).toEqual([row('ses-a')]);
    expect(caps.picker[0]!.currentSessionId).toBe('ses-current');
  });

  it('cancel closes the picker and restores the editor', async () => {
    const { manager, state, editor } = makeHost();
    await manager.showSessionPicker();
    (caps.picker[0]!.onCancel as () => void)();
    expect(state.activeDialog).toBeNull();
    expect(state.editorContainer.children).toContain(editor);
  });

  it('onSelect (plain row) resumes by picker id and hides on success', async () => {
    const { manager, host, state } = makeHost({ rows: [row('ses-a')] });
    await manager.showSessionPicker();
    (caps.picker[0]!.onSelect as (id: string) => void)('ses-a');
    await settle();
    expect(host.resumeSession).toHaveBeenCalledWith('ses-a');
    expect(state.activeDialog).toBeNull();
  });

  it('onSelect (cc-connect row) resumes the AGENT session id, not the row id', async () => {
    const { manager, host } = makeHost({
      rows: [row('cc-row', { source: 'cc-connect', agentSessionId: 'agent-9' })],
    });
    await manager.showSessionPicker();
    (caps.picker[0]!.onSelect as (id: string) => void)('cc-row');
    await settle();
    expect(host.resumeSession).toHaveBeenCalledWith('agent-9');
  });

  it('cc-connect + blocked:true must NOT create a replacement session', async () => {
    const { manager, host, harness } = makeHost({
      rows: [row('cc-row', { source: 'cc-connect', agentSessionId: 'agent-9' })],
    });
    vi.mocked(host.resumeSession).mockResolvedValueOnce({ switched: false, blocked: true });
    await manager.showSessionPicker();
    (caps.picker[0]!.onSelect as (id: string) => void)('cc-row');
    await settle();
    // cc-connect contract: transient busy/replaying refusals never force a
    // new session mid-stream (paired with SessionManager.resumeSession).
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(host.switchToSession).not.toHaveBeenCalled();
  });

  it('cc-connect + genuinely-missing session creates it and switches', async () => {
    const created = makeMockSession({ id: 'agent-9' });
    const { manager, host, harness, state } = makeHost({
      rows: [row('cc-row', { source: 'cc-connect', agentSessionId: 'agent-9' })],
    });
    vi.mocked(host.resumeSession).mockResolvedValueOnce({ switched: false });
    vi.mocked(harness.createSession).mockResolvedValueOnce(created);
    await manager.showSessionPicker();
    (caps.picker[0]!.onSelect as (id: string) => void)('cc-row');
    await settle();
    expect(harness.createSession).toHaveBeenCalledWith({
      id: 'agent-9',
      workDir: '/tmp/scream-test',
      model: 'gpt-test',
      permission: host.state.appState.permissionMode,
    });
    expect(host.switchToSession).toHaveBeenCalledWith(created, t('dialog.cc_session_connected', { id: 'agent-9' }));
    expect(state.activeDialog).toBeNull();
  });

  it('cc-connect replacement failure reports create_session_failed', async () => {
    const { manager, host, harness } = makeHost({
      rows: [row('cc-row', { source: 'cc-connect', agentSessionId: 'agent-9' })],
    });
    vi.mocked(host.resumeSession).mockResolvedValueOnce({ switched: false });
    vi.mocked(harness.createSession).mockRejectedValueOnce(new Error('disk full'));
    await manager.showSessionPicker();
    (caps.picker[0]!.onSelect as (id: string) => void)('cc-row');
    await settle();
    expect(host.showError).toHaveBeenCalledWith(t('dialog.create_session_failed'));
  });

  it('non-cc missing session does not auto-create', async () => {
    const { manager, host, harness } = makeHost({ rows: [row('ses-a')] });
    vi.mocked(host.resumeSession).mockResolvedValueOnce({ switched: false });
    await manager.showSessionPicker();
    (caps.picker[0]!.onSelect as (id: string) => void)('ses-a');
    await settle();
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('onDelete exempts cc-connect rows', async () => {
    const { manager, host } = makeHost({ rows: [row('cc-row', { source: 'cc-connect' })] });
    await manager.showSessionPicker();
    (caps.picker[0]!.onDelete as (id: string) => void)('cc-row');
    await settle();
    expect(host.showStatus).toHaveBeenCalledWith(t('dialog.cc_managed'));
    expect(host.deleteSession).not.toHaveBeenCalled();
  });

  it('onDelete closes the picker when the last row was removed', async () => {
    const { manager, host, rowsBox, state } = makeHost({ rows: [row('ses-a')] });
    await manager.showSessionPicker();
    vi.mocked(host.fetchSessions).mockImplementation(async () => {
      rowsBox.rows = [];
    });
    (caps.picker[0]!.onDelete as (id: string) => void)('ses-a');
    await settle();
    expect(host.deleteSession).toHaveBeenCalledWith('ses-a');
    expect(state.activeDialog).toBeNull();
    expect(caps.picker.length).toBe(1); // no re-mount after auto-close
  });

  it('onDelete re-mounts the picker when other rows remain', async () => {
    const { manager, host, rowsBox } = makeHost({ rows: [row('ses-a'), row('ses-b')] });
    await manager.showSessionPicker();
    vi.mocked(host.fetchSessions).mockImplementation(async () => {
      rowsBox.rows = [row('ses-b')];
    });
    (caps.picker[0]!.onDelete as (id: string) => void)('ses-a');
    await settle();
    expect(caps.picker.length).toBe(2);
    expect(caps.picker[1]!.sessions).toEqual([row('ses-b')]);
  });

  it('onDeleteMany strips cc ids and deletes the rest', async () => {
    const { manager, host, rowsBox } = makeHost({
      rows: [row('cc-1', { source: 'cc-connect' }), row('a'), row('b')],
    });
    await manager.showSessionPicker();
    vi.mocked(host.fetchSessions).mockImplementation(async () => {
      rowsBox.rows = [row('cc-1', { source: 'cc-connect' })];
    });
    (caps.picker[0]!.onDeleteMany as (ids: string[]) => void)(['cc-1', 'a', 'b']);
    await settle();
    expect(vi.mocked(host.deleteSession).mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(caps.picker.length).toBe(2); // re-mounted, not auto-closed
  });

  it('onDeleteMany with only cc ids reports cc_managed and deletes nothing', async () => {
    const { manager, host } = makeHost({ rows: [row('cc-1', { source: 'cc-connect' })] });
    await manager.showSessionPicker();
    (caps.picker[0]!.onDeleteMany as (ids: string[]) => void)(['cc-1']);
    await settle();
    expect(host.showStatus).toHaveBeenCalledWith(t('dialog.cc_managed'));
    expect(host.deleteSession).not.toHaveBeenCalled();
  });

  it('onDeleteMany stops at the first failure but still refreshes', async () => {
    const { manager, host, rowsBox } = makeHost({ rows: [row('a'), row('b'), row('c')] });
    await manager.showSessionPicker();
    vi.mocked(host.deleteSession).mockRejectedValueOnce(new Error('locked'));
    vi.mocked(host.fetchSessions).mockImplementation(async () => {
      rowsBox.rows = [row('b'), row('c')];
    });
    (caps.picker[0]!.onDeleteMany as (ids: string[]) => void)(['a', 'b', 'c']);
    await settle();
    expect(host.showError).toHaveBeenCalledWith('locked');
    expect(vi.mocked(host.deleteSession).mock.calls.map(([id]) => id)).toEqual(['a']);
    // 2 = initial load for showSessionPicker + post-loop refresh
    expect(host.fetchSessions).toHaveBeenCalledTimes(2);
    expect(caps.picker.length).toBe(2);
  });

  it('onDeleteMany auto-closes when everything is gone', async () => {
    const { manager, host, rowsBox, state } = makeHost({ rows: [row('a')] });
    await manager.showSessionPicker();
    vi.mocked(host.fetchSessions).mockImplementation(async () => {
      rowsBox.rows = [];
    });
    (caps.picker[0]!.onDeleteMany as (ids: string[]) => void)(['a']);
    await settle();
    expect(state.activeDialog).toBeNull();
  });
});

describe('DialogManager — approval panel & preview', () => {
  const payload = { id: 'ap-1', tool_call_id: 'tc-1', tool_name: 'Bash', action: 'run', description: 'd', display: [], choices: [] };

  it('mounts the panel, patches the live pane and adapts the response', () => {
    const { manager, host, state, approvalController } = makeHost();
    manager.showApprovalPanel(payload as unknown as ApprovalPanelData);
    expect(host.patchLivePane).toHaveBeenCalledWith({ pendingApproval: { data: payload } });
    expect(state.livePane.pendingApproval).not.toBeNull();
    expect(state.editorContainer.children.length).toBe(1);
    const panel = caps.approval[0]!.instance;
    expect(panel).toBe(state.editorContainer.children[0]);

    const onResponse: (r: unknown) => void = caps.approval[0]!.args[1];
    onResponse({ response: 'approved_for_session', feedback: 'lgtm' });
    expect(approvalController.respond).toHaveBeenCalledWith({
      decision: 'approved',
      scope: 'session',
      feedback: 'lgtm',
      selectedLabel: undefined,
    });
    expect(panel.stop).toHaveBeenCalled();
  });

  it('a second panel stops the previous one; hide resets everything', () => {
    const { manager, host, state } = makeHost();
    manager.showApprovalPanel(payload as unknown as ApprovalPanelData);
    const first = caps.approval[0]!.instance;
    manager.showApprovalPanel({ ...payload, id: 'ap-2' } as unknown as ApprovalPanelData);
    expect(first.stop).toHaveBeenCalled();

    manager.hideApprovalPanel();
    expect(host.patchLivePane).toHaveBeenLastCalledWith({ pendingApproval: null });
    expect(state.livePane.pendingApproval).toBeNull();
    expect(state.editorContainer.children).toContain(state.editor);
  });

  it('preview swaps the layout root, is single-layer and restores on close', () => {
    const { manager, state } = makeHost();
    manager.showApprovalPanel(payload as unknown as ApprovalPanelData);
    const openPreview: (b: unknown) => void = caps.approval[0]!.args[5];
    const panel = caps.approval[0]!.instance;

    openPreview({ kind: 'diff', text: 'x' });
    openPreview({ kind: 'diff', text: 'y' }); // second open ignored
    expect(caps.preview.length).toBe(1);
    expect(state.ui.setLayoutRoot).toHaveBeenCalledTimes(1);
    expect(state.ui.setLayoutRoot).toHaveBeenCalledWith(caps.preview[0]!.instance);

    (caps.preview[0]!.props.onClose as any)();
    expect(state.ui.setLayoutRoot).toHaveBeenLastCalledWith(state.layoutRoot);
    expect(state.ui.setLayoutRoot).toHaveBeenCalledTimes(2);
    expect(state.ui.setFocus).toHaveBeenLastCalledWith(panel);
    // requestRender: panel mount (1) + preview open force (2) + preview close force (3)
    expect(state.ui.requestRender).toHaveBeenCalledTimes(3);
    expect(state.ui.requestRender).toHaveBeenLastCalledWith(true);
  });

  it('hideApprovalPanel closes an open preview first', () => {
    const { manager, state } = makeHost();
    manager.showApprovalPanel(payload as unknown as ApprovalPanelData);
    (caps.approval[0]!.args[5] as any)({ kind: 'diff', text: 'x' });
    manager.hideApprovalPanel();
    // layout root restored once (preview close) before editor restore
    expect(state.ui.setLayoutRoot).toHaveBeenLastCalledWith(state.layoutRoot);
    expect(caps.preview.length).toBe(1);
  });

  it('question dialog mounts, responds raw and hides cleanly', () => {
    const { manager, host, state, questionController } = makeHost();
    const q = { id: 'q-1', questions: [{ question: 'which?', header: 'h', options: [] }] };
    manager.showQuestionDialog(q as unknown as QuestionPanelData);
    expect(host.patchLivePane).toHaveBeenCalledWith({ pendingQuestion: { data: q } });
    const onResponse: (r: unknown) => void = caps.question[0]!.args[1];
    const answer = { accepted: true, answers: { 'which?': 'a' } };
    onResponse(answer);
    expect(questionController.respond).toHaveBeenCalledWith(answer);
    manager.hideQuestionDialog();
    expect(host.patchLivePane).toHaveBeenLastCalledWith({ pendingQuestion: null });
    expect(state.livePane.pendingQuestion).toBeNull();
  });
});

describe('DialogManager — memory picker', () => {
  const memo = {
    id: 'm1',
    recordedAt: Date.parse('2026-01-02T03:04:05Z'),
    userNeed: 'need',
    approach: 'approach',
    outcome: 'ok',
    tags: ['x'],
    sourceSessionId: 'session-abcdef123456',
    sourceSessionTitle: 'Prev',
  };

  it('preloaded render is synchronous and inject routes back through user input', () => {
    const { manager, host, state } = makeHost();
    manager.showMemoryPicker([memo as never], 1);
    expect(state.activeDialog).toBe('memory-picker');
    expect(caps.memory.length).toBe(1);
    expect(caps.memory[0]!.loading).toBe(false);
    expect(caps.memory[0]!.total).toBe(1);

    (caps.memory[0]!.onInject as (m: unknown) => void)(memo);
    expect(host.sendNormalUserInput).toHaveBeenCalledWith(formatMemoryMemoForInjection(memo as never));
    expect(host.showStatus).toHaveBeenCalledWith(t('dialog.memo_injected', { id: 'm1' }));
    expect(state.activeDialog).toBeNull();
  });

  it('lazy load re-mounts only while the picker is still open', async () => {
    const { manager, state } = makeHost();
    manager.showMemoryPicker();
    expect(caps.memory[0]!.loading).toBe(true);
    const store = caps.stores[0]!;
    store.list.mockResolvedValueOnce({ memos: [memo], total: 7 });
    await settle();
    expect(store.init).toHaveBeenCalled();
    expect(caps.memory.length).toBe(2);
    expect(caps.memory[1]!.loading).toBe(false);
    expect(caps.memory[1]!.total).toBe(7);
  });

  it('hideMemoryPicker restores the editor', () => {
    const { manager, state } = makeHost();
    manager.showMemoryPicker([], 0);
    manager.hideMemoryPicker();
    expect(state.activeDialog).toBeNull();
    expect(state.editorContainer.children).toContain(state.editor);
  });
});
