import type { Component } from '@liutod-scream/pi-tui';
import type { ApprovalRequest, ApprovalResponse } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TranscriptController,
  type TranscriptControllerHost,
} from '#/tui/controllers/transcript-controller';
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
import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
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

  it('routes ReadGroup tool calls to ReadGroupComponent when a result exists', () => {
    const { controller } = makeHost();
    const component = controller.appendEntry(
      entry({
        kind: 'tool_call',
        toolCallData: toolCallData({ name: 'ReadGroup', result: { tool_call_id: 'tc', output: '/a\n---\nok' } }),
      }),
    );
    expect(component).toBeInstanceOf(ReadGroupComponent);
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
    const { controller, state } = makeHost();
    controller.appendApprovalEntry(request({ toolName: 'ExitPlanMode' }), response());
    controller.appendApprovalEntry(
      request({ display: { kind: 'plan_review' } as never }),
      response(),
    );
    expect(state.transcriptEntries.length).toBe(0);
  });

  it('formats decision, scope and action into a notice entry', () => {
    const { controller, state } = makeHost();
    controller.appendApprovalEntry(request(), response({ decision: 'approved' }));
    controller.appendApprovalEntry(
      request({ toolName: 'Write' }),
      response({ decision: 'approved', scope: 'session' }),
    );
    controller.appendApprovalEntry(request(), response({ decision: 'rejected' }));
    controller.appendApprovalEntry(request(), response({ decision: 'cancelled' }));

    const texts = state.transcriptEntries.map((e) => e.content);
    expect(texts[0]).toBe(`${t('tc.approved')}: run ls`);
    expect(texts[1]).toBe(`${t('tc.approved_session')}: run ls`);
    expect(texts[2]).toBe(`${t('tc.rejected')}: run ls`);
    expect(texts[3]).toBe(`${t('tc.cancelled')}: run ls`);
    expect(state.transcriptEntries.every((e) => e.kind === 'status' && e.renderMode === 'notice')).toBe(true);
  });

  it('appends quoted feedback when present (and ignores empty feedback)', () => {
    const { controller, state } = makeHost();
    controller.appendApprovalEntry(request(), response({ feedback: 'be careful' }));
    controller.appendApprovalEntry(request(), response({ feedback: '' }));
    expect(state.transcriptEntries[0]!.content).toBe(`${t('tc.approved')}: run ls — "be careful"`);
    expect(state.transcriptEntries[1]!.content).toBe(`${t('tc.approved')}: run ls`);
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

  it('toggleToolOutputExpansion flips the global preference only', () => {
    const { controller, state } = makeHost();
    expect(state.toolOutputExpanded).toBe(false);
    controller.toggleToolOutputExpansion();
    expect(state.toolOutputExpanded).toBe(true);
    controller.toggleToolOutputExpansion();
    expect(state.toolOutputExpanded).toBe(false);
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
