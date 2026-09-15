import { Container, Text } from '@liutod-scream/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { StreamingUIHost } from '#/tui/controllers/streaming-ui';
import { TranscriptController } from '#/tui/controllers/transcript-controller';
import type { TranscriptControllerHost } from '#/tui/controllers/transcript-controller';
import { darkColors } from '#/tui/theme/colors';
import type { TUIState } from '#/tui/tui-state';
import type { ToolCallBlockData, TranscriptEntry } from '#/tui/types';

import { createMockTUIState } from '../fixtures/mock-host';

function makeToolCall(id: string, name: string, step = 1): ToolCallBlockData {
  return { id, name, args: {}, turnId: 'turn-1', step };
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

  it('keeps Read, media and plan-review cards standalone', () => {
    const { state, controller } = createFixture();

    controller.onToolCallStart(makeToolCall('r1', 'Read'));
    controller.onToolCallStart(makeToolCall('m1', 'ReadMediaFile'));
    expect(state.transcriptContainer.children.some((c) => c instanceof ToolCallComponent)).toBe(true);
    expect(findGroup(state.transcriptContainer)).toBeUndefined();

    controller.onToolCallStart(makeToolCall('p1', 'ExitPlanMode'));
    expect(findGroup(state.transcriptContainer)).toBeUndefined();
    expect(
      state.transcriptContainer.children.filter((c) => c instanceof ToolCallComponent),
    ).toHaveLength(3);
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

  it('does not flip an older block when the newest child cannot collapse', () => {
    const { state, transcript } = createFixture();
    const older = new ActivityGroupComponent(darkColors, undefined);
    const readGroup = new ReadGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(older);
    state.transcriptContainer.addChild(readGroup);

    transcript.toggleToolOutputExpansion();

    expect(state.toolOutputExpanded).toBe(true);
    expect(older.isExpanded()).toBe(false);
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

  it('opens new blocks collapsed instead of inheriting the last Ctrl+O state', () => {
    const { state, controller } = createFixture();
    state.toolOutputExpanded = true;

    controller.onToolCallStart(makeToolCall('t1', 'Bash'));

    // Expansion is per target: inheriting the toggle opened every later block
    // (and every later Read card) without the user asking for it.
    expect(findGroup(state.transcriptContainer)?.isExpanded()).toBe(false);
  });

  it('does not mount a fresh Read card in the last Ctrl+O state', () => {
    const { state, controller } = createFixture();
    state.toolOutputExpanded = true;

    controller.onToolCallStart(makeToolCall('r1', 'Read'));
    const output = Array.from(
      { length: 200 },
      (_, i) => `${String(i + 1)}\tconst n${String(i + 1)} = 1;`,
    ).join('\n');
    controller.onToolCallEnd('r1', { tool_call_id: 'r1', output });

    const card = state.transcriptContainer.children.find(
      (child): child is ToolCallComponent => child instanceof ToolCallComponent,
    );
    expect(card).toBeDefined();
    // Collapsed: the header plus the summary glance. An inherited expansion
    // would render the file body here.
    expect(card?.render(80).length).toBeLessThan(10);
  });

  it('expands a block that mounted after the previous Ctrl+O press', () => {
    const { state, controller, transcript } = createFixture();

    controller.onToolCallStart(makeToolCall('t1', 'Bash'));
    transcript.toggleToolOutputExpansion();
    const first = findGroup(state.transcriptContainer);
    expect(first?.isExpanded()).toBe(true);

    // The turn settles and the next one opens a fresh block, which mounts
    // collapsed even though the remembered state is still "expanded".
    controller.endActivityGroup();
    controller.onToolCallStart(makeToolCall('t2', 'Bash'));
    const blocks = findGroups(state.transcriptContainer);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.isExpanded()).toBe(false);

    // The press flips what the user is looking at instead of re-applying the
    // remembered state (which would have spent the keystroke invisibly).
    transcript.toggleToolOutputExpansion();
    expect(blocks[1]?.isExpanded()).toBe(true);
    expect(blocks[0]?.isExpanded()).toBe(true);
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

  it('Ctrl+O expands the newest block retroactively', () => {
    const { state, transcript } = createFixture();
    const older = new ActivityGroupComponent(darkColors, undefined);
    const newer = new ActivityGroupComponent(darkColors, undefined);
    state.transcriptContainer.addChild(older);
    state.transcriptContainer.addChild(newer);

    transcript.toggleToolOutputExpansion();

    expect(state.toolOutputExpanded).toBe(true);
    expect(newer.isExpanded()).toBe(true);
    expect(older.isExpanded()).toBe(false);

    transcript.toggleToolOutputExpansion();
    expect(state.toolOutputExpanded).toBe(false);
    expect(newer.isExpanded()).toBe(false);
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
});
