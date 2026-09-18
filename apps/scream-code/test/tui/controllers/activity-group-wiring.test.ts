import { Container, Text } from '@liutod-scream/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { NoticeMessageComponent } from '#/tui/components/messages/status-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { StreamingUIHost } from '#/tui/controllers/streaming-ui';
import { TranscriptController } from '#/tui/controllers/transcript-controller';
import type { TranscriptControllerHost } from '#/tui/controllers/transcript-controller';
import { darkColors } from '#/tui/theme/colors';
import type { TUIState } from '#/tui/tui-state';
import type { ToolCallBlockData, TranscriptEntry } from '#/tui/types';

import { createMockTUIState } from '../fixtures/mock-host';

function makeToolCall(
  id: string,
  name: string,
  step = 1,
  args: Record<string, unknown> = {},
): ToolCallBlockData {
  return { id, name, args, turnId: 'turn-1', step };
}

function makeEntry(id: string): TranscriptEntry {
  return { id, kind: 'thinking', renderMode: 'plain', content: `entry ${id}` };
}

function findGroup(container: Container): ActivityGroupComponent | undefined {
  return container.children.find(
    (child): child is ActivityGroupComponent => child instanceof ActivityGroupComponent,
  );
}

function findGroups(container: Container): ActivityGroupComponent[] {
  return container.children.filter(
    (child): child is ActivityGroupComponent => child instanceof ActivityGroupComponent,
  );
}

/** Approval outcomes that were mounted as their own notice row. */
function notices(state: TUIState): NoticeMessageComponent[] {
  return state.transcriptContainer.children.filter(
    (child): child is NoticeMessageComponent => child instanceof NoticeMessageComponent,
  );
}

interface Fixture {
  readonly state: TUIState;
  readonly controller: StreamingUIController;
  readonly transcript: TranscriptController;
}

function createFixture(): Fixture {
  const state = createMockTUIState();
  const transcript = new TranscriptController({
    state,
    imageStore: {},
    streamingUI: {},
    showStatus: vi.fn(),
    batchUpdate: <T,>(fn: () => T): T => fn(),
    forceUpdateStatusBar: vi.fn(),
  } as unknown as TranscriptControllerHost);
  const host = {
    state,
    session: undefined,
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    requireSession: vi.fn(),
    deferUserMessages: false,
    shiftQueuedMessage: vi.fn(),
    pushTranscriptEntry: vi.fn(),
    onTurnCompleted: vi.fn(),
    transcriptController: transcript,
  } as unknown as StreamingUIHost;
  return { state, controller: new StreamingUIController(host), transcript };
}

describe('activity block wiring', () => {
  it('routes ordinary tool calls into the turn block instead of the transcript', () => {
    const { state, controller } = createFixture();

    controller.onToolCallStart(makeToolCall('t1', 'Bash'));

    const group = findGroup(state.transcriptContainer);
    expect(group).toBeDefined();
    expect(group?.render(90).join('\n')).toContain('Bash');
    expect(state.transcriptContainer.children.some((c) => c instanceof ToolCallComponent)).toBe(
      false,
    );
  });

  it('routes Read into the block and keeps media and plan-review cards standalone', () => {
    const { state, controller } = createFixture();

    controller.onToolCallStart(makeToolCall('r1', 'Read'));
    // Read is a step of the turn's block now, not a card of its own.
    expect(findGroup(state.transcriptContainer)).toBeDefined();
    expect(
      state.transcriptContainer.children.some((c) => c instanceof ToolCallComponent),
    ).toBe(false);

    controller.onToolCallStart(makeToolCall('m1', 'ReadMediaFile'));
    controller.onToolCallStart(makeToolCall('p1', 'ExitPlanMode'));

    expect(
      state.transcriptContainer.children.filter((c) => c instanceof ToolCallComponent),
    ).toHaveLength(2);
    // Both kinds coexist in call order: block first, standalone cards after.
    expect(state.transcriptContainer.children[0]).toBeInstanceOf(ActivityGroupComponent);
  });

  it('releases the live-component mapping of hidden pieces', () => {
    const { state, controller, transcript } = createFixture();
    const release = vi.spyOn(transcript, 'releaseLiveComponent');
    controller.setTurnId('turn-1');

    controller.onThinkingUpdate('reasoning');
    controller.onThinkingEnd();
    expect(release).toHaveBeenCalled();

    release.mockClear();
    controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    controller.onToolCallEnd('t1', { tool_call_id: 't1', output: 'done', is_error: false });
    // The borrowed card is never mounted, so its mapping has to be dropped too.
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      state.transcriptContainer.children.filter(
        (child) => child instanceof ActivityGroupComponent,
      ),
    ).toHaveLength(1);
  });

  it('opens a new block for reasoning that arrives after answer text', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');

    controller.onThinkingUpdate('first reasoning');
    controller.onStreamingTextUpdate('answer text seals the block');
    controller.onThinkingUpdate('second reasoning');

    const groups = findGroups(state.transcriptContainer);
    expect(groups).toHaveLength(2);
    const [first, second] = groups as ActivityGroupComponent[];
    expect(first?.render(90).join('\n')).toContain('first reasoning');
    expect(first?.render(90).join('\n')).not.toContain('second reasoning');
    expect(second?.render(90).join('\n')).toContain('second reasoning');
  });

  it('stops flipping at the previous turn and skips components without a collapse state', () => {
    const { state, transcript } = createFixture();
    const earlier = new ActivityGroupComponent(darkColors, undefined);
    const agentGroup = new AgentGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(earlier);
    state.transcriptContainer.addChild(agentGroup);
    state.transcriptContainer.addChild(new UserMessageComponent('next prompt', darkColors));
    const current = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(current);

    transcript.toggleToolOutputExpansion();

    expect(state.toolOutputExpanded).toBe(true);
    expect(current.isExpanded()).toBe(true);
    // The agent group has no collapse state of its own and the earlier turn is
    // above the boundary, so neither follows the press.
    expect(earlier.isExpanded()).toBe(false);
  });

  it('moves reasoning into the block and leaves the thinking component unmounted', () => {
    const { state, controller } = createFixture();

    controller.onThinkingUpdate('deliberating');

    const group = findGroup(state.transcriptContainer);
    expect(group).toBeDefined();
    expect(state.transcriptContainer.children.some((c) => c instanceof ThinkingComponent)).toBe(
      false,
    );
    expect(group?.render(80).join('\n')).toContain('deliberating');
  });

  it('keeps work in one block while the assistant says nothing', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');

    controller.onToolCallStart(makeToolCall('t1', 'Bash', 1));
    controller.onThinkingUpdate('step two reasoning');
    controller.onToolCallStart(makeToolCall('t2', 'Edit', 2));

    const groups = findGroups(state.transcriptContainer);
    expect(groups).toHaveLength(1);
    const block = groups[0] as ActivityGroupComponent;
    block.setExpanded(true);
    const rendered = block.render(90).join('\n');
    expect(rendered).toContain('Bash');
    expect(rendered).toContain('Edit');
    expect(rendered).toContain('step two reasoning');
  });

  it('seals the block as soon as visible text appears', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');

    controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    controller.onStreamingTextUpdate('Even a one-line status note counts as text.');
    controller.onToolCallStart(makeToolCall('t2', 'Edit'));

    const groups = findGroups(state.transcriptContainer);
    expect(groups).toHaveLength(2);
    const [first, second] = groups as ActivityGroupComponent[];
    // The finished block sits above the text, the new work below it.
    expect(first?.render(90).join('\n')).toContain('Bash');
    expect(first?.render(90).join('\n')).toContain('工具执行完成');
    expect(second?.render(90).join('\n')).toContain('Edit');
    expect(second?.render(90).join('\n')).not.toContain('Bash');
  });

  it('settles the previous block when a new turn starts', () => {
    const { state, controller } = createFixture();

    controller.setTurnId('turn-1');
    controller.onToolCallStart(makeToolCall('t1', 'Bash'));

    // Turn boundary: the turn-start hook settles whatever is still open.
    controller.setTurnId('turn-2');
    controller.endActivityGroup();
    controller.onThinkingUpdate('second turn reasoning');

    const groups = findGroups(state.transcriptContainer);
    expect(groups).toHaveLength(2);
    const [first, second] = groups as ActivityGroupComponent[];
    expect(first?.render(90).join('\n')).toContain('工具执行完成');
    expect(first?.render(90).join('\n')).not.toContain('second turn reasoning');
    expect(second?.render(90).join('\n')).toContain('second turn reasoning');
  });

  it('keeps earlier steps reasoning when a later step starts a new draft', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');

    controller.onThinkingUpdate('first step reasoning');
    controller.onThinkingEnd();
    controller.onThinkingUpdate('second step reasoning');

    const group = findGroup(state.transcriptContainer);
    // The collapsed summary shows the first line only, so the accumulated
    // reasoning has to be checked through the expanded excerpt.
    group?.setExpanded(true);
    const rendered = group?.render(90).join('\n') ?? '';
    expect(rendered).toContain('first step reasoning');
    expect(rendered).toContain('second step reasoning');
  });

  it('repaints a settled block when a late result lands', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');
    controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    controller.endActivityGroup();

    const group = findGroup(state.transcriptContainer);
    // Render at the final width first: a later render at the SAME width only
    // shows the result if the late result actually triggered a repaint.
    expect(group?.render(80).join('\n')).not.toContain('✓');

    controller.onToolCallEnd('t1', { tool_call_id: 't1', output: 'done', is_error: false });

    const rendered = group?.render(80).join('\n') ?? '';
    expect(rendered).toContain('✓');
    expect(rendered).not.toContain('工具执行中');
  });

  it('spins only while the turn is live, not for replayed history', () => {
    const headerOf = (state: TUIState): string => {
      const group = state.transcriptContainer.children.find(
        (child): child is ActivityGroupComponent => child instanceof ActivityGroupComponent,
      );
      if (group === undefined) return '';
      return group.render(90).find((line) => line.trim().length > 0) ?? '';
    };

    const live = createFixture();
    live.state.appState.streamingPhase = 'thinking';
    live.controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(headerOf(live.state))).toBe(true);

    const replayed = createFixture();
    replayed.controller.setTurnId('replay:1');
    replayed.controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    const replayedHeader = headerOf(replayed.state);
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(replayedHeader)).toBe(false);
    expect(replayedHeader).toContain('工具执行完成');
  });

  it('opens new blocks in the mode Ctrl+O last set', () => {
    const { state, controller } = createFixture();
    state.toolOutputExpanded = true;

    controller.onToolCallStart(makeToolCall('t1', 'Bash'));

    // The mode is sticky: a block that appears after the press matches the ones
    // the press already expanded instead of leaving the transcript inconsistent.
    expect(findGroup(state.transcriptContainer)?.isExpanded()).toBe(true);
  });

  it('mounts a standalone card in the mode Ctrl+O last set', () => {
    const { state, controller } = createFixture();
    state.toolOutputExpanded = true;

    controller.onToolCallStart(makeToolCall('m1', 'ReadMediaFile'));

    const card = state.transcriptContainer.children.find(
      (child): child is ToolCallComponent => child instanceof ToolCallComponent,
    );
    expect(card?.isExpanded()).toBe(true);
  });

  it('keeps later blocks in the same mode as the previous Ctrl+O press', () => {
    const { state, controller, transcript } = createFixture();

    controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    transcript.toggleToolOutputExpansion();
    const first = findGroup(state.transcriptContainer);
    expect(first?.isExpanded()).toBe(true);

    // The turn settles and the next block opens, matching the block above it.
    controller.endActivityGroup();
    controller.onToolCallStart(makeToolCall('t2', 'Bash'));
    const blocks = findGroups(state.transcriptContainer);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.isExpanded()).toBe(true);

    // One press closes the whole current turn at once: nothing is left open.
    transcript.toggleToolOutputExpansion();
    expect(blocks[0]?.isExpanded()).toBe(false);
    expect(blocks[1]?.isExpanded()).toBe(false);
    expect(state.toolOutputExpanded).toBe(false);
  });

  it('endActivityGroup is a no-op without a block and settles one with content', () => {
    const { state, controller } = createFixture();

    expect(() => {
      controller.endActivityGroup();
    }).not.toThrow();
    expect(findGroup(state.transcriptContainer)).toBeUndefined();

    controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    controller.endActivityGroup();

    const groups = findGroups(state.transcriptContainer);
    expect(groups).toHaveLength(1);
    expect((groups[0] as ActivityGroupComponent).render(90).join('\n')).toContain('工具执行完成');
  });

  it('Ctrl+O flips every block of the current turn', () => {
    const { state, transcript } = createFixture();
    const older = new ActivityGroupComponent(darkColors, undefined);
    const newer = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(older);
    state.transcriptContainer.addChild(newer);

    transcript.toggleToolOutputExpansion();

    expect(state.toolOutputExpanded).toBe(true);
    expect(newer.isExpanded()).toBe(true);
    expect(older.isExpanded()).toBe(true);

    transcript.toggleToolOutputExpansion();
    expect(state.toolOutputExpanded).toBe(false);
    expect(newer.isExpanded()).toBe(false);
    expect(older.isExpanded()).toBe(false);
  });

  it('folds a settled block into history without eating panels or pending blocks', () => {
    const { state, transcript } = createFixture();
    const panel = new Text('panel row', 0, 0);
    const settled = new ActivityGroupComponent(darkColors, undefined);
    const pendingBlock = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(panel);
    state.transcriptContainer.addChild(settled);
    state.transcriptContainer.addChild(pendingBlock);
    transcript.registerLiveComponent(settled, makeEntry('e1'));
    transcript.registerLiveComponent(pendingBlock, makeEntry('e2'));
    transcript.markPending(pendingBlock);
    // Push the transcript past the live-child limit so folding kicks in.
    for (let i = 0; i < 200; i += 1) {
      state.transcriptContainer.addChild(new Text(`row ${i}`, 0, 0));
    }

    transcript.commit();

    expect(state.transcriptContainer.children).not.toContain(settled);
    expect(state.transcriptContainer.children).toContain(pendingBlock);
    expect(state.transcriptContainer.children).toContain(panel);
    expect(transcript.getCommittedCount()).toBeGreaterThan(0);
  });

  it('holds an outcome until its own call becomes a row, then files it underneath', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');

    // The prompt is answered before its tool call is dispatched, so at this
    // point there is not even a block to file the row into.
    controller.recordApproval('w1', '已批准', 'Writing /tmp/cut/vad.py', 'approved');
    expect(findGroup(state.transcriptContainer)).toBeUndefined();
    expect(notices(state)).toHaveLength(0);

    controller.onToolCallStart(makeToolCall('w1', 'Write'));

    const rows = findGroup(state.transcriptContainer)?.render(90).join('\n') ?? '';
    // The outcome lands under the call it allowed — the order a replayed block
    // shows too.
    expect(rows).toContain('已批准 · Writing /tmp/cut/vad.py');
    expect(rows.indexOf('已批准')).toBeGreaterThan(rows.indexOf('Write'));
    expect(notices(state)).toHaveLength(0);
  });

  it('mounts an outcome answered between turns as its own notice', () => {
    const { state, controller } = createFixture();

    // A background agent can ask while no turn is running: no block will ever
    // open for that call, so the outcome keeps the row it always had.
    controller.recordApproval('bg-1', '已批准', 'Writing /tmp/cut/vad.py', 'approved');

    const mounted = notices(state);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.render(90).join('\n')).toContain('已批准: Writing /tmp/cut/vad.py');
  });

  it('files an outcome under the row of the call it allowed', () => {
    const { state, controller } = createFixture();
    controller.onToolCallStart(makeToolCall('bash-1', 'Bash'));

    controller.recordApproval('bash-1', '已拒绝', 'Bash rm -rf /tmp/cut', 'rejected');

    const rows = findGroup(state.transcriptContainer)?.render(90).join('\n') ?? '';
    expect(rows).toContain('已拒绝 · Bash rm -rf /tmp/cut');
    expect(rows.indexOf('已拒绝')).toBeGreaterThan(rows.indexOf('Bash'));
    expect(notices(state)).toHaveLength(0);
  });

  it('never hangs an outcome under a call that is not its own', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');
    controller.onToolCallStart(makeToolCall('main-1', 'Write'));

    // A subagent's call: its row lives in the Agent card, so the outcome must
    // not be filed under the parent's call of the same turn.
    controller.recordApproval('sub-1', '已批准', 'Writing /tmp/cut/vad.py', 'approved');

    const rows = findGroup(state.transcriptContainer)?.render(90).join('\n') ?? '';
    expect(rows).not.toContain('已批准');
    expect(notices(state)).toHaveLength(0);

    // The end of the step settles it as the row it always had.
    controller.flushPendingApprovals();
    const mounted = notices(state);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.render(90).join('\n')).toContain('已批准: Writing /tmp/cut/vad.py');
  });

  it('settles an outcome as a notice when its call stays standalone', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');
    controller.recordApproval('m1', '已批准', 'Reading /tmp/cut/frame.png', 'approved');

    controller.onToolCallStart(makeToolCall('m1', 'ReadMediaFile'));
    expect(notices(state)).toHaveLength(0);

    controller.flushPendingApprovals();

    const mounted = notices(state);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.render(90).join('\n')).toContain('已批准: Reading /tmp/cut/frame.png');
  });

  it('settles an outcome whose call never produced a row when the boundary passes', () => {
    const { state, controller } = createFixture();
    controller.setTurnId('turn-1');
    controller.recordApproval('never-1', '已取消', 'Bash du -sh /tmp', 'cancelled');
    expect(notices(state)).toHaveLength(0);

    // An interrupted step, a retry or a session switch: the decision was the
    // user's either way, so it surfaces as a notice instead of being dropped.
    controller.resetToolUi();

    const mounted = notices(state);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.render(90).join('\n')).toContain('已取消: Bash du -sh /tmp');
  });

  it('files a run of approvals from one step without letting any escape the block', () => {
    const { state, controller, transcript } = createFixture();
    controller.setTurnId('turn-1');

    // Three writes in one step, the shape a long file-editing task produces:
    // each prompt is answered before its own call is dispatched.
    controller.recordApproval('w1', '已批准', 'Writing a.py', 'approved');
    controller.onToolCallStart(makeToolCall('w1', 'Write'));
    controller.recordApproval('w2', '已批准', 'Writing b.py', 'approved');
    controller.onToolCallStart(makeToolCall('w2', 'Write'));
    controller.recordApproval('w3', '已拒绝', 'Writing c.py', 'rejected');
    controller.onToolCallStart(makeToolCall('w3', 'Write'));

    const group = findGroup(state.transcriptContainer);
    expect(group).toBeDefined();
    // Every outcome is a step of the block: nothing became a row of its own and
    // the collapsed height stays at the block's budget.
    expect(notices(state)).toHaveLength(0);
    const collapsed = (group?.render(90) ?? []).filter((line) => line.trim().length > 0);
    expect(collapsed).toHaveLength(3);

    transcript.toggleToolOutputExpansion();
    const expanded =
      group
        ?.render(90)
        .map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, ''))
        .join('\n') ?? '';
    for (const detail of ['Writing a.py', 'Writing b.py', 'Writing c.py']) {
      expect(expanded).toContain(detail);
    }
    expect(expanded).toContain('已拒绝 · Writing c.py');
  });
});

describe('activity block wiring — plan cards seal the running block', () => {
  function childIndex(state: TUIState, child: unknown): number {
    return state.transcriptContainer.children.indexOf(child as never);
  }

  function renderAll(state: TUIState): string {
    return state.transcriptContainer.children
      .map((child) => child.render(100).join('\n'))
      .join('\n')
      .replaceAll(/\u001B\[[0-9;]*m/g, '');
  }

  it('seals the block that led to the plan and starts the next block below it', () => {
    const { state, controller } = createFixture();

    controller.onToolCallStart(makeToolCall('r1', 'Read'));
    const firstBlock = findGroup(state.transcriptContainer);
    expect(firstBlock).toBeDefined();

    controller.onToolCallStart(makeToolCall('p1', 'ExitPlanMode'));
    const planCard = state.transcriptContainer.children.find(
      (child): child is ToolCallComponent => child instanceof ToolCallComponent,
    );
    expect(planCard).toBeDefined();
    // Sealing keeps the block as history: it is not removed or replaced.
    expect(findGroups(state.transcriptContainer)).toHaveLength(1);

    controller.onToolCallStart(makeToolCall('b1', 'Bash', 2));

    const groups = findGroups(state.transcriptContainer);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toBe(firstBlock);
    expect(childIndex(state, groups[1])).toBeGreaterThan(childIndex(state, planCard));
    // The sealed block keeps its own row and does not swallow the new one.
    expect(groups[0]?.render(90).join('\n')).not.toContain('Bash');
    expect(groups[1]?.render(90).join('\n')).toContain('Bash');
  });

  it('seals again for every plan revision and never spawns an empty block between them', () => {
    const { state, controller } = createFixture();
    const plan = (id: string, text: string): ToolCallBlockData => ({
      id,
      name: 'ExitPlanMode',
      args: { plan: text },
      turnId: 'turn-1',
      step: 1,
    });

    controller.onToolCallStart(makeToolCall('r1', 'Read'));
    controller.onToolCallStart(plan('p1', 'first revision'));
    controller.onToolCallStart(plan('p2', 'second revision'));
    controller.onToolCallStart(makeToolCall('b1', 'Bash', 2));

    const shape = state.transcriptContainer.children.map((child) =>
      child instanceof ActivityGroupComponent
        ? 'block'
        : child instanceof ToolCallComponent
          ? 'card'
          : 'other',
    );
    // Both revisions are kept, and no empty block appears between them.
    expect(shape).toEqual(['block', 'card', 'card', 'block']);

    const rendered = renderAll(state);
    expect(rendered).toContain('first revision');
    expect(rendered).toContain('second revision');
  });

  it('keeps the block open for the other standalone cards', () => {
    const { state, controller } = createFixture();

    controller.onToolCallStart(makeToolCall('r1', 'Read'));
    const block = findGroup(state.transcriptContainer);

    controller.onToolCallStart(makeToolCall('m1', 'ReadMediaFile'));
    controller.onToolCallStart(makeToolCall('t1', 'Bash', 2));

    const groups = findGroups(state.transcriptContainer);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toBe(block);
    expect(groups[0]?.render(90).join('\n')).toContain('Bash');
  });

  it('files an approval under its own row even when a plan sealed that block', () => {
    const { state, controller } = createFixture();

    controller.onToolCallStart(makeToolCall('b1', 'Bash', 1, { command: 'ls' }));
    const sealed = findGroup(state.transcriptContainer);
    controller.onToolCallStart(makeToolCall('p1', 'ExitPlanMode', 1, { plan: 'plan' }));

    controller.recordApproval('b1', 'Approved', 'Bash · ls', 'approved');

    // The outcome belongs under the call it allowed, wherever that row lives —
    // sealing the block must not push it to the bottom of the transcript.
    expect(sealed?.render(100).join('\n')).toContain('Approved · Bash · ls');
    expect(state.transcriptContainer.children).toHaveLength(2);
  });

  it('leaves nothing behind when the plan is the first event of the turn', () => {
    const { state, controller } = createFixture();

    controller.onToolCallStart(makeToolCall('p1', 'ExitPlanMode', 1, { plan: 'plan' }));

    // Sealing is a no-op when no block was open: no empty block is mounted.
    expect(state.transcriptContainer.children.filter((child) => child instanceof ActivityGroupComponent)).toHaveLength(0);
    expect(state.transcriptContainer.children.filter((child) => child instanceof ToolCallComponent)).toHaveLength(1);
  });
});
