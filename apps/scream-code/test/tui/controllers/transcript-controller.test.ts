import type { Component } from '@liutod-scream/pi-tui';
import type { ApprovalRequest, ApprovalResponse } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TRANSCRIPT_ENTRIES,
  TranscriptController,
  type TranscriptControllerHost,
} from '#/tui/controllers/transcript-controller';
import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { CompactionComponent } from '#/tui/components/dialogs/compaction';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from '#/tui/components/messages/status-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { SkillActivationComponent } from '#/tui/components/messages/skill-activation';
import { BackgroundAgentStatusComponent } from '#/tui/components/messages/background-agent-status';
import { CronMessageComponent } from '#/tui/components/messages/cron-message';

import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import { darkColors } from '#/tui/theme/colors';
import {
  CommittedTranscriptComponent,
  MAX_COMMITTED_ENTRIES,
} from '#/tui/components/transcript/committed-transcript';
import { parseCollapsedEntries } from '#/tui/utils/collapse-stub';
import type { TranscriptEntry, ToolCallBlockData } from '#/tui/types';

import { createMockTUIState, makeMockStreamingUI } from '../fixtures/mock-host';

const ESC = String.fromCodePoint(27);

function stripAnsi(text: string): string {
  return text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
}

function rendered(component: { render: (w: number) => string[] }, width = 80): string {
  return component.render(width).map(stripAnsi).join('\n');
}

function makeHost(appState: Record<string, unknown> = {}) {
  const state = createMockTUIState({ appState: appState as never });
  const mocks = {
    showStatus: vi.fn(),
    forceUpdateStatusBar: vi.fn(),
  };
  const host = {
    state,
    imageStore: new ImageAttachmentStore(),
    streamingUI: makeMockStreamingUI(),
    showStatus: mocks.showStatus,
    // TranscriptController.commit() wraps its work in batchUpdate — run inline.
    batchUpdate: (fn: () => void) => fn(),
    forceUpdateStatusBar: mocks.forceUpdateStatusBar,
  } as unknown as TranscriptControllerHost & {
    imageStore: ImageAttachmentStore;
  };
  const controller = new TranscriptController(host);
  return { controller, host, state, mocks };
}

function entry(overrides: Partial<TranscriptEntry> & { kind: TranscriptEntry['kind'] }): TranscriptEntry {
  return {
    id: overrides.id ?? `e-${Math.random().toString(36).slice(2)}`,
    renderMode: 'plain',
    content: '',
    ...overrides,
  };
}

function toolCallData(overrides: Partial<ToolCallBlockData> = {}): ToolCallBlockData {
  return {
    id: 'tc-1',
    name: 'Bash',
    args: { command: 'ls' },
    result: { tool_call_id: 'tc-1', output: 'file list', is_error: false },
    ...overrides,
  };
}

/** Minimal live component for fold tests (no real rendering needed). */
function fakeComponent(tag = ''): Component {
  return {
    render: () => (tag.length > 0 ? [tag] : []),
    invalidate: () => {},
  } as unknown as Component;
}

/** Seed the container with N registered live components, return them. */
function seedLive(
  controller: TranscriptController,
  state: ReturnType<typeof createMockTUIState>,
  count: number,
  startIndex = 0,
): Component[] {
  const added: Component[] = [];
  for (let i = startIndex; i < startIndex + count; i++) {
    const component = fakeComponent(`c-${String(i)}`);
    const e = entry({ kind: 'status', content: `msg-${String(i)}`, id: `seed-${String(i)}` });
    state.transcriptEntries.push(e);
    controller.registerLiveComponent(component, e);
    state.transcriptContainer.addChild(component);
    added.push(component);
  }
  return added;
}

describe('TranscriptController.createComponent (via appendEntry)', () => {
  it('maps entry kinds to their live component classes', () => {
    const { controller, state } = makeHost();
    const cases: Array<[TranscriptEntry, unknown]> = [
      [entry({ kind: 'user', content: 'hi' }), UserMessageComponent],
      [entry({ kind: 'assistant', content: 'yo' }), AssistantMessageComponent],
      [entry({ kind: 'thinking', content: 'hmm' }), ThinkingComponent],
      [entry({ kind: 'tool_call', toolCallData: toolCallData() }), ToolCallComponent],
      [entry({ kind: 'tool_call', renderMode: 'notice', content: 'x', detail: 'd' }), NoticeMessageComponent],
      [entry({ kind: 'tool_call', content: 'x' }), StatusMessageComponent],
      [
        entry({ kind: 'tool_call', backgroundAgentStatus: { phase: 'started', headline: 'bg' } }),
        BackgroundAgentStatusComponent,
      ],
      [entry({ kind: 'status', content: 'ok', color: 'gray' }), StatusMessageComponent],
      [entry({ kind: 'status', renderMode: 'notice', content: 'note' }), NoticeMessageComponent],
      [
        entry({ kind: 'status', backgroundAgentStatus: { phase: 'completed', headline: 'bg' } }),
        BackgroundAgentStatusComponent,
      ],
      [
        entry({ kind: 'skill_activation', skillName: 'push', skillArgs: 'a b', skillTrigger: 'user-slash' }),
        SkillActivationComponent,
      ],
      [entry({ kind: 'cron', content: 'fired', cronData: { jobId: 'j1' } }), CronMessageComponent],
      [
        { ...entry({ kind: 'status' }), compactionData: { tokensBefore: 10, tokensAfter: 5 } },
        CompactionComponent,
      ],
    ];

    for (const [e, klass] of cases) {
      const component = controller.appendEntry(e);
      expect(component, `kind=${e.kind}`).toBeInstanceOf(klass as never);
    }
    // Every appended entry lands in transcriptEntries AND the container.
    expect(state.transcriptEntries.length).toBe(cases.length);
    expect(state.transcriptContainer.children.length).toBe(cases.length);
  });

  it('returns null (and appends no component) for welcome, keyless cron and unknown kinds', () => {
    const { controller, state } = makeHost();
    expect(controller.appendEntry(entry({ kind: 'welcome' }))).toBeNull();
    expect(controller.appendEntry(entry({ kind: 'cron', content: 'x' }))).toBeNull();
    expect(controller.appendEntry(entry({ kind: 'nonsense' as TranscriptEntry['kind'] }))).toBeNull();
    // Entries are still recorded for replay even when no component is created.
    expect(state.transcriptEntries.length).toBe(3);
    expect(state.transcriptContainer.children.length).toBe(0);
  });

  it('records the component→entry mapping for lookups', () => {
    const { controller } = makeHost();
    const e = entry({ kind: 'user', content: 'map me' });
    const component = controller.appendEntry(e);
    expect(component).not.toBeNull();
    expect(controller.findEntryForComponent(component!)).toBe(e);
    expect(controller.getLiveCount()).toBe(1);
    expect(controller.getCommittedCount()).toBe(0);
  });
});

describe('TranscriptController.commit() fold algorithm', () => {
  // Default LIVE_LIMIT is 150 (SCREAM_TRANSCRIPT_LIVE_LIMIT unset in tests).
  it('does not fold while a turn is streaming', () => {
    const { controller, state } = makeHost({ streamingPhase: 'composing' });
    seedLive(controller, state, 160);
    controller.commit();
    expect(state.transcriptContainer.children.length).toBe(160);
    expect(controller.getCommittedCount()).toBe(0);
  });

  it('does not fold at or below the live limit', () => {
    const { controller, state } = makeHost();
    seedLive(controller, state, 150);
    controller.commit();
    expect(state.transcriptContainer.children.length).toBe(150);
    expect(controller.getCommittedCount()).toBe(0);
  });

  it('folds the oldest entries down to the limit, prepending the committed summary', () => {
    const { controller, state } = makeHost();
    const components = seedLive(controller, state, 155);
    controller.commit();
    // 5 folded → live = 150 originals + 1 committed container = 151 children.
    expect(controller.getCommittedCount()).toBe(5);
    expect(controller.getLiveCount()).toBe(151);
    expect(state.transcriptContainer.children[0]).not.toBe(components[0]);
    // The first 5 (oldest) were removed from the live map.
    expect(controller.findEntryForComponent(components[0]!)).toBeUndefined();
    expect(controller.findEntryForComponent(components[10]!)).toBeDefined();
  });

  it('skips pending, welcome and unmapped children when picking fold candidates', () => {
    const { controller, state } = makeHost();
    const welcome = fakeComponent('welcome');
    controller.setWelcomeComponent(welcome as unknown as WelcomeComponent);
    state.transcriptContainer.addChild(welcome);

    const pending = seedLive(controller, state, 1);
    controller.markPending(pending[0]!);
    const rest = seedLive(controller, state, 154, 1);
    // One unregistered spacer child that must never be folded.
    const spacer = fakeComponent('spacer');
    state.transcriptContainer.addChild(spacer);
    // 1 welcome + 155 registered + 1 spacer = 157 children.
    expect(state.transcriptContainer.children.length).toBe(157);

    controller.commit();
    expect(state.transcriptContainer.children).toContain(welcome);
    expect(state.transcriptContainer.children).toContain(pending[0]!);
    expect(state.transcriptContainer.children).toContain(spacer);
    // Folded exactly to `children.length - toCommit <= 150` — pending/welcome/
    // spacer are counted but not foldable, so 7 registered entries move.
    expect(controller.getCommittedCount()).toBe(7);
    expect(rest.slice(0, 7).every((c) => controller.findEntryForComponent(c) === undefined)).toBe(true);

    controller.unmarkPending(pending[0]!);
    expect(controller.findEntryForComponent(pending[0]!)).toBeDefined();
  });

  it('creates no committed component when everything above the limit is uncommitted', () => {
    const { controller, state } = makeHost();
    // 160 children but none registered → toCommit stays empty, nothing folds.
    for (let i = 0; i < 160; i++) state.transcriptContainer.addChild(fakeComponent());
    controller.commit();
    expect(controller.getCommittedCount()).toBe(0);
    expect(state.transcriptContainer.children.length).toBe(160);
    // getLiveCount/getCommittedCount keep reporting the untouched state.
    expect(controller.getLiveCount()).toBe(160);
  });

  it('accumulates the committed count across folds', () => {
    const { controller, state } = makeHost();
    seedLive(controller, state, 155);
    controller.commit(); // folds 5 → 1 committed + 150 live = 151 children
    seedLive(controller, state, 10, 1000); // back to 161 children
    controller.commit();
    // Folds until children.length - toCommit <= 150 → 161-11=150, so +11.
    // (The committed component itself occupies one child slot.)
    expect(controller.getCommittedCount()).toBe(16);
    expect(controller.getLiveCount()).toBe(150);
  });
});

describe('TranscriptController committed tree retention', () => {
  it('keeps the tree at its retention point across thousands of commits', () => {
    const { controller, state } = makeHost();
    const folds = 5_000;

    for (let i = 0; i < folds; i += 1) {
      // Real ingress, so both caps are live at once: the shadow array folds its
      // oldest entries while the committed tree folds its oldest children.
      controller.appendEntry(entry({ kind: 'status', content: `row-${String(i)}` }));
      controller.commit();
    }

    const committed = state.transcriptContainer.children[0];
    expect(committed).toBeInstanceOf(CommittedTranscriptComponent);
    const tree = committed as CommittedTranscriptComponent;

    // Bounded at the retention point: header + at most the cap in entry
    // children (retained rows plus the fold stub).
    expect(tree.children.length).toBeLessThanOrEqual(MAX_COMMITTED_ENTRIES + 1);
    const rows = tree.children.length - 2; // minus the header and the fold stub
    expect(rows).toBe(MAX_COMMITTED_ENTRIES - 1);
    // Folded rows + rendered rows account for every committed row: neither the
    // tree's fold nor the array's cap counts a row twice.
    expect(tree.getCollapsedCount()).toBeGreaterThan(0);
    expect(tree.getCollapsedCount() + rows).toBe(tree.getCount());

    // One fold summary per store — the tree renders exactly one, and the array
    // still holds exactly one stub entry of its own.
    const summaries = rendered(tree)
      .split('\n')
      .filter((line) => line.includes('earlier entries collapsed'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain(String(tree.getCollapsedCount()));
    const stubs = state.transcriptEntries.filter((e) => parseCollapsedEntries(e.content) > 0);
    expect(stubs).toHaveLength(1);
    expect(state.transcriptEntries[0]).toBe(stubs[0]);

    // Rendering is intact: the newest committed row survives (folds take the
    // oldest) and the header still announces the whole committed history.
    const out = rendered(tree);
    expect(out).toContain(`row-${String(tree.getCount() - 1)}`);
    expect(out).toContain(t('transcript.more_history', { count: tree.getCount() }));
  });
});

describe('TranscriptController.appendApprovalEntry', () => {
  const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest =>
    ({
      toolCallId: 'tc-1',
      toolName: 'Bash',
      action: 'run ls',
      display: { kind: 'generic', summary: 's' },
      ...overrides,
    }) as unknown as ApprovalRequest;

  const response = (overrides: Partial<ApprovalResponse> = {}): ApprovalResponse =>
    ({ decision: 'approved', ...overrides }) as ApprovalResponse;

  it('short-circuits ExitPlanMode and plan_review requests', () => {
    const { controller, host, state } = makeHost();
    controller.appendApprovalEntry(request({ toolName: 'ExitPlanMode' }), response());
    controller.appendApprovalEntry(
      request({ display: { kind: 'plan_review' } as never }),
      response(),
    );
    expect(state.transcriptEntries.length).toBe(0);
    expect(host.streamingUI.recordApproval).not.toHaveBeenCalled();
  });

  it('files decision, scope and action with the work that asked for it', () => {
    const { controller, host, state } = makeHost();
    const recordApproval = vi.mocked(host.streamingUI.recordApproval);
    controller.appendApprovalEntry(request(), response({ decision: 'approved' }));
    controller.appendApprovalEntry(
      request({ toolName: 'Write' }),
      response({ decision: 'approved', scope: 'session' }),
    );
    controller.appendApprovalEntry(request(), response({ decision: 'rejected' }));
    controller.appendApprovalEntry(request(), response({ decision: 'cancelled' }));

    expect(recordApproval.mock.calls).toEqual([
      ['tc-1', t('tc.approved'), 'run ls', 'approved'],
      ['tc-1', t('tc.approved_session'), 'run ls', 'approved_session'],
      ['tc-1', t('tc.rejected'), 'run ls', 'rejected'],
      ['tc-1', t('tc.cancelled'), 'run ls', 'cancelled'],
    ]);
    // No row of its own: streaming-ui decides where the outcome lands.
    expect(state.transcriptEntries).toHaveLength(0);
  });

  it('appends quoted feedback when present (and ignores empty feedback)', () => {
    const { controller, host } = makeHost();
    const recordApproval = vi.mocked(host.streamingUI.recordApproval);
    controller.appendApprovalEntry(request(), response({ feedback: 'be careful' }));
    controller.appendApprovalEntry(request(), response({ feedback: '' }));
    expect(recordApproval.mock.calls[0]).toEqual([
      'tc-1',
      t('tc.approved'),
      'run ls — "be careful"',
      'approved',
    ]);
    expect(recordApproval.mock.calls[1]).toEqual(['tc-1', t('tc.approved'), 'run ls', 'approved']);
  });
});

describe('TranscriptController.appendElapsedToLastAssistant', () => {
  it('stamps the suffix on the matching turnId assistant component only', () => {
    const { controller, state } = makeHost();
    const older = controller.appendEntry(entry({ kind: 'assistant', content: 'older reply', turnId: 't1' }))!;
    const target = controller.appendEntry(entry({ kind: 'assistant', content: 'target reply', turnId: 't2' }))!;

    controller.appendElapsedToLastAssistant(' ⏱ 3s', 't2');

    expect(rendered(target)).toContain('⏱ 3s');
    expect(rendered(older)).not.toContain('⏱ 3s');
    expect(vi.mocked(state.ui.requestRender)).toHaveBeenCalled();
  });

  it('is a no-op when the newest assistant entry belongs to another turn', () => {
    const { controller } = makeHost();
    const component = controller.appendEntry(entry({ kind: 'assistant', content: 'only', turnId: 't1' }))!;
    controller.appendElapsedToLastAssistant('X', 'no-such-turn');
    expect(rendered(component)).not.toContain('X');
  });

  it('is a no-op with no assistant entries and survives status entries', () => {
    const { controller } = makeHost();
    expect(() => controller.appendElapsedToLastAssistant('X', 't1')).not.toThrow();
    controller.appendEntry(entry({ kind: 'status', content: 'status only' }));
    expect(() => controller.appendElapsedToLastAssistant('X', 't1')).not.toThrow();
  });
});

describe('TranscriptController misc surface', () => {
  it('showStatus / showNotice mount real components and request a render', () => {
    const { controller, state } = makeHost();
    controller.showStatus('plain status', 'cyan');
    controller.showNotice('notice title', 'notice detail');
    const [status, notice] = state.transcriptContainer.children as [Component, Component];
    expect(status).toBeInstanceOf(StatusMessageComponent);
    expect(notice).toBeInstanceOf(NoticeMessageComponent);
    expect(rendered(status)).toContain('plain status');
    expect(rendered(notice)).toContain('notice title');
    expect(rendered(notice)).toContain('notice detail');
    expect(vi.mocked(state.ui.requestRender)).toHaveBeenCalledTimes(2);
  });

  it('showError prefixes the transcript line and sets the raw message on the banner', () => {
    const { controller, state } = makeHost();
    controller.showError('boom\twith tabs');
    const banner = state.errorBanner as unknown as { setMessage: ReturnType<typeof vi.fn> };
    expect(vi.mocked(banner.setMessage)).toHaveBeenCalledWith('boom    with tabs');
    const component = state.transcriptContainer.children[0]!;
    expect(rendered(component)).toContain(`${t('tc.error_prefix')}boom`);
  });

  it('renders a tool_result entry as the tool card it carries', () => {
    const { controller } = makeHost();

    // Its producer mounts the card itself today, but an entry routed through
    // appendEntry must not silently vanish.
    const component = controller.appendEntry(
      entry({
        kind: 'tool_result',
        renderMode: 'plain',
        content: 'AskUserQuestion',
        toolCallData: toolCallData({ name: 'AskUserQuestion' }),
      }),
    );

    expect(component).toBeInstanceOf(ToolCallComponent);
  });

  it('files a background task notice into the open block instead of the transcript', () => {
    const { controller, host, state } = makeHost();
    (host.streamingUI as unknown as { attachNotice: () => boolean }).attachNotice = () => true;

    controller.appendEntry(
      entry({
        kind: 'status',
        content: 'bg',
        turnId: 't-1',
        backgroundAgentStatus: { phase: 'started', headline: '后台任务已启动', detail: 'bash-1' },
      }),
    );

    // The block owns the row, so nothing is mounted next to it.
    expect(state.transcriptContainer.children).toHaveLength(0);
  });

  it('mounts a background task notice on its own when no block is open', () => {
    const { controller, state } = makeHost();

    controller.appendEntry(
      entry({
        kind: 'status',
        content: 'bg',
        turnId: 't-1',
        backgroundAgentStatus: { phase: 'completed', headline: '后台任务已完成' },
      }),
    );

    expect(state.transcriptContainer.children).toHaveLength(1);
    expect(state.transcriptContainer.children[0]).toBeInstanceOf(BackgroundAgentStatusComponent);
  });

  it('toggleToolOutputExpansion applies one mode to every block of the turn', () => {
    const { controller, state } = makeHost();
    // Nothing expandable on screen: the press records the mode for what mounts next.
    expect(state.toolOutputExpanded).toBe(false);
    controller.toggleToolOutputExpansion();
    expect(state.toolOutputExpanded).toBe(true);
    controller.toggleToolOutputExpansion();
    expect(state.toolOutputExpanded).toBe(false);

    const block = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(block);
    controller.toggleToolOutputExpansion();
    expect(block.isExpanded()).toBe(true);
    expect(state.toolOutputExpanded).toBe(true);

    // A block that appears while the turn is open follows the same press, and
    // the next press closes everything: the transcript never ends up half open.
    const fresh = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(fresh);
    controller.toggleToolOutputExpansion();
    expect(block.isExpanded()).toBe(false);
    expect(fresh.isExpanded()).toBe(false);
    expect(state.toolOutputExpanded).toBe(false);
  });

  it('toggleToolOutputExpansion stops at the previous turn', () => {
    const { controller, state } = makeHost();
    const earlier = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(earlier);
    state.transcriptContainer.addChild(new UserMessageComponent('next prompt', darkColors));
    const current = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(current);

    controller.toggleToolOutputExpansion();

    expect(current.isExpanded()).toBe(true);
    // Work from an earlier prompt keeps whatever it was showing.
    expect(earlier.isExpanded()).toBe(false);
  });

  it('togglePlanExpansion only flips when a plan-expandable child accepted it', () => {
    const { controller, state } = makeHost();
    const rejecting = { setPlanExpanded: vi.fn((): boolean => false) };
    state.transcriptContainer.addChild(rejecting as unknown as Component);
    expect(controller.togglePlanExpansion()).toBe(false);
    expect(state.planExpanded).toBe(false);

    const accepting = { setPlanExpanded: vi.fn((): boolean => true) };
    state.transcriptContainer.addChild(accepting as unknown as Component);
    expect(controller.togglePlanExpansion()).toBe(true);
    expect(state.planExpanded).toBe(true);
    expect(accepting.setPlanExpanded).toHaveBeenCalledWith(true);
    expect(rejecting.setPlanExpanded).toHaveBeenCalledTimes(2);

    // Flipping back calls setPlanExpanded(false).
    expect(controller.togglePlanExpansion()).toBe(true);
    expect(state.planExpanded).toBe(false);
    expect(accepting.setPlanExpanded).toHaveBeenLastCalledWith(false);
  });

  it('renderWelcome mounts a welcome component and stops breathing after first input', () => {
    const { controller, state } = makeHost();
    controller.renderWelcome();
    const welcome = controller.getWelcomeComponent();
    expect(welcome).toBeInstanceOf(WelcomeComponent);
    expect(state.transcriptContainer.children).toContain(welcome);
    expect(welcome!.borderTitle).toBe('Scream Code');
    expect(vi.mocked(state.editor.hasFirstInputFired)).toHaveBeenCalled();
    controller.stopWelcomeBreathing(); // must not throw after render
  });

  it('clearAndRedraw resets every tracked surface and re-renders welcome', () => {
    const { controller, host, state } = makeHost();
    controller.appendEntry(entry({ kind: 'user', content: 'gone' }));
    const streamingUI = host.streamingUI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const attachment = (host.imageStore as ImageAttachmentStore).addImage(
      new Uint8Array([1]),
      'image/png',
      2,
      2,
    );
    const clearSpy = vi.spyOn(host.imageStore, 'clear');

    controller.clearAndRedraw();

    expect(streamingUI['discardPending']).toHaveBeenCalled();
    expect(streamingUI['endActivityGroup']).toHaveBeenCalled();
    expect(streamingUI['disposeActiveCompactionBlock']).toHaveBeenCalled();
    expect(streamingUI['resetLiveText']).toHaveBeenCalled();
    expect(streamingUI['resetToolUi']).toHaveBeenCalled();
    expect(state.transcriptEntries.length).toBe(0);
    // Only the freshly rendered welcome remains live in the container.
    expect(state.transcriptContainer.children.length).toBe(1);
    expect(state.transcriptContainer.children[0]).toBe(controller.getWelcomeComponent());
    expect(controller.getCommittedCount()).toBe(0);
    const panels = state as unknown as {
      todoPanel: { clear: ReturnType<typeof vi.fn> };
      errorBanner: { clear: ReturnType<typeof vi.fn> };
    };
    expect(panels.todoPanel.clear).toHaveBeenCalled();
    // todoPanelContainer is a real Container: seeding + clear must empty it.
    state.todoPanelContainer.addChild(fakeComponent('todo-row'));
    expect(state.todoPanelContainer.children.length).toBe(1);
    controller.clearAndRedraw();
    expect(state.todoPanelContainer.children.length).toBe(0);
    expect(panels.errorBanner.clear).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    expect(host.imageStore.get(attachment.id)).toBeUndefined();
    expect(host.forceUpdateStatusBar).toHaveBeenCalled();
  });

  it('showProgressSpinner mounts a spinner and swaps it for a status line on stop', () => {
    vi.useFakeTimers();
    try {
      const { controller, state } = makeHost();
      const handle = controller.showProgressSpinner('loading…');
      expect(state.transcriptContainer.children.length).toBe(2); // spacer + spinner
      expect(vi.mocked(state.ui.requestRender)).toHaveBeenCalled();
      handle.setLabel('still loading');
      handle.stop({ ok: true, label: 'done in 1s' });
      // Spacer and spinner removed, replaced by one status child.
      expect(state.transcriptContainer.children.length).toBe(1);
      expect(rendered(state.transcriptContainer.children[0]!)).toContain('done in 1s');
    } finally {
      vi.useRealTimers();
    }
  });
});

// (no trailing helpers — mocks live in ../fixtures/mock-host)

describe('TranscriptController — live notice animation lifecycle', () => {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /** Timers under a loaded test run can slip well past their 80 ms beat, so poll
   *  for the change instead of sampling once at a fixed moment. */
  async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(20);
    }
    return predicate();
  }

  function countRenders(state: ReturnType<typeof createMockTUIState>): ReturnType<typeof vi.fn> {
    return state.ui.requestRender as ReturnType<typeof vi.fn>;
  }

  function noticeEntry(phase: 'started' | 'completed', trackingId: string): TranscriptEntry {
    return entry({
      kind: 'status',
      backgroundAgentStatus: { phase, headline: `task ${phase}`, detail: 'CI', trackingId },
    });
  }

  it('stops the ticker of a started notice once the task reports a terminal state', async () => {
    const { controller, state } = makeHost();
    const component = controller.appendEntry(noticeEntry('started', 'bash-1'));

    expect(component).toBeInstanceOf(BackgroundAgentStatusComponent);
    const render = countRenders(state);
    expect(await waitFor(() => render.mock.calls.length > 0)).toBe(true);

    controller.appendEntry(noticeEntry('completed', 'bash-1'));

    const settled = render.mock.calls.length;
    await sleep(400);
    expect(render.mock.calls.length).toBe(settled);
  });

  it('never leaves a ticking twin behind when the activity block claims the notice', async () => {
    const { controller, host, state } = makeHost();
    const mockStreaming = host.streamingUI as unknown as { attachNotice: ReturnType<typeof vi.fn> };
    mockStreaming.attachNotice.mockReturnValueOnce(true);

    const component = controller.appendEntry(noticeEntry('started', 'bash-block'));

    expect(component).toBeInstanceOf(BackgroundAgentStatusComponent);
    const render = countRenders(state);
    const before = render.mock.calls.length;
    await sleep(400);
    expect(render.mock.calls.length).toBe(before);
  });

  it('disposes a live notice card when the fold moves it into committed history', () => {
    const { controller, state } = makeHost();
    const component = controller.appendEntry(noticeEntry('started', 'bash-commit'));
    const dispose = vi.spyOn(component as BackgroundAgentStatusComponent, 'dispose');

    seedLive(controller, state, 154);
    controller.commit();

    expect(dispose).toHaveBeenCalled();
  });
});

describe('TranscriptController ingest bounding (transcript-bound)', () => {
  it('stores a bounded tool output — the full middle never reaches transcriptEntries', () => {
    const { controller, state } = makeHost();
    const middleSentinel = 'middle-sentinel-line-12345';
    const lines = Array.from({ length: 10_000 }, (_, i) =>
      i === 5_000 ? middleSentinel : `payload-line-${String(i)}`,
    );
    const entryToAppend = entry({
      kind: 'tool_call',
      toolCallData: toolCallData({
        result: { tool_call_id: 'tc-1', output: lines.join('\n'), is_error: false },
      }),
    });

    controller.appendEntry(entryToAppend);

    const stored = state.transcriptEntries[0]!;
    const output = stored.toolCallData!.result!.output;
    expect(output).not.toContain(middleSentinel);
    expect(output.length).toBeLessThanOrEqual(8_000 + 64); // budget + marker slack
    expect(output).toContain('payload-line-0');
    expect(output).toContain('payload-line-9999');
  });

  it('creates the live component and entry mapping from the same bounded entry', () => {
    const { controller, state } = makeHost();
    const lines = Array.from({ length: 500 }, (_, i) => `row-${String(i)}`);
    const entryToAppend = entry({
      kind: 'tool_call',
      toolCallData: toolCallData({
        result: { tool_call_id: 'tc-1', output: lines.join('\n'), is_error: false },
      }),
    });

    const component = controller.appendEntry(entryToAppend);

    const stored = state.transcriptEntries[0]!;
    expect(controller.findEntryForComponent(component!)).toBe(stored);
    expect(stored.toolCallData!.result!.output).not.toBe(entryToAppend.toolCallData!.result!.output);
    expect(stored.toolCallData!.result!.output).toContain('lines elided');
  });
});

describe('TranscriptController entry-count cap (collapse stub)', () => {
  const STUB_PATTERN = /^…\((\d+) earlier entries collapsed\)$/;

  function appendMany(controller: TranscriptController, count: number, from = 0): void {
    for (let i = from; i < from + count; i++) {
      controller.appendEntry(entry({ kind: 'status', content: `row-${String(i)}` }));
    }
  }

  /** Reads the head stub back the way a renderer would: from its content. */
  function readStub(entries: TranscriptEntry[]): number {
    const match = STUB_PATTERN.exec(entries[0]?.content ?? '');
    expect(match).not.toBeNull();
    return Number(match![1]);
  }

  it('caps a 5000-entry flood at the limit and counts every folded entry', () => {
    const { controller, state } = makeHost();

    appendMany(controller, 5_000);

    const entries = state.transcriptEntries;
    expect(entries.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES + 1);
    // Folded + kept accounts for all 5000 appends — nothing double-counted.
    expect(readStub(entries)).toBe(5_000 - (entries.length - 1));
    // The newest rows survive and the oldest are gone.
    expect(entries.at(-1)!.content).toBe('row-4999');
    expect(entries.some((e) => e.content === 'row-0')).toBe(false);
  });

  it('folds into the same stub as later entries arrive', () => {
    const { controller, state } = makeHost();
    appendMany(controller, MAX_TRANSCRIPT_ENTRIES + 3);
    const before = readStub(state.transcriptEntries);

    appendMany(controller, 2, 5_000);

    expect(state.transcriptEntries.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES + 1);
    const after = readStub(state.transcriptEntries);
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(MAX_TRANSCRIPT_ENTRIES + 5 - (state.transcriptEntries.length - 1));
  });

  it('adds no stub while the transcript stays within the cap', () => {
    const { controller, state } = makeHost();

    appendMany(controller, MAX_TRANSCRIPT_ENTRIES);

    expect(state.transcriptEntries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(state.transcriptEntries.some((e) => STUB_PATTERN.test(e.content))).toBe(false);
  });

  it('moves the monotonic ingest counter on every ingest and on each fold', () => {
    const { controller, state } = makeHost();
    expect(controller.getIngestCount()).toBe(0);

    appendMany(controller, MAX_TRANSCRIPT_ENTRIES);
    const atCap = controller.getIngestCount();
    expect(atCap).toBe(MAX_TRANSCRIPT_ENTRIES);
    const lengthAtCap = state.transcriptEntries.length;

    // Tripping the cap folds the oldest rows into the stub: the array lands
    // back on the same length, so only the counter can tell a memoized
    // aggregate that the composition changed. The append moves it once for
    // the ingest and once for the fold it triggered.
    controller.appendEntry(entry({ kind: 'status', content: 'row-over' }));
    expect(state.transcriptEntries.length).toBe(lengthAtCap);
    expect(controller.getIngestCount()).toBe(atCap + 2);
  });
});

describe('TranscriptController folded-entry contributions', () => {
  const statusRow = (content: string): TranscriptEntry =>
    entry({ kind: 'status', content });

  it('carries the contributions of rows the cap folds out of the array', () => {
    const { controller, state } = makeHost();
    controller.appendEntry(entry({ kind: 'user', content: 'q-0' }));
    controller.appendEntry(entry({ kind: 'user', content: 'q-1' }));
    controller.appendEntry(
      entry({ kind: 'tool_call', content: 'Bash-1', toolCallData: toolCallData() }),
    );
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES - 3; i += 1) {
      controller.appendEntry(statusRow(`row-${String(i)}`));
    }
    // Exactly at the cap: nothing has folded yet.
    expect(state.transcriptEntries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(controller.getFoldedEntryCounts()).toEqual({ turns: 0, toolCalls: 0 });

    // Two overflows fold four rows out — the two turns and the tool call among
    // them — and their contributions survive the array dropping them.
    controller.appendEntry(statusRow('overflow-1'));
    controller.appendEntry(statusRow('overflow-2'));

    expect(state.transcriptEntries.some((e) => e.content === 'q-0')).toBe(false);
    expect(state.transcriptEntries.some((e) => e.content === 'Bash-1')).toBe(false);
    expect(controller.getFoldedEntryCounts()).toEqual({ turns: 2, toolCalls: 1 });
    // The stub's own count and the retained rows still account for every
    // appended row — 3 rows out (the two turns and the tool call), 502 in.
    const folded = parseCollapsedEntries(state.transcriptEntries[0]!.content);
    expect(folded).toBe(3);
    expect(folded + state.transcriptEntries.length - 1).toBe(MAX_TRANSCRIPT_ENTRIES + 2);
  });

  it('never counts compression markers, folded or retained', () => {
    const { controller } = makeHost();
    controller.appendEntry({
      ...entry({ kind: 'tool_call', content: 'auto-compact' }),
      compactionData: { tokensBefore: 100, tokensAfter: 10 },
    });
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES - 1; i += 1) {
      controller.appendEntry(statusRow(`row-${String(i)}`));
    }

    controller.appendEntry(statusRow('overflow'));

    // The marker rode the fold — a real invocation would have counted.
    expect(controller.getFoldedEntryCounts()).toEqual({ turns: 0, toolCalls: 0 });
  });

  it('starts the contributions over with the session', () => {
    const { controller } = makeHost();
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 2; i += 1) {
      controller.appendEntry(entry({ kind: 'user', content: `q-${String(i)}` }));
    }
    expect(controller.getFoldedEntryCounts().turns).toBeGreaterThan(0);

    controller.clearAndRedraw();

    expect(controller.getFoldedEntryCounts()).toEqual({ turns: 0, toolCalls: 0 });
  });
});
