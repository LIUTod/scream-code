import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { EditRecoveryInjector } from '../../../src/agent/injection/edit-recovery';
import {
  EDIT_RECOVERY_INSTRUCTION,
  EditRecoveryQueue,
  type EditRecoverySignature,
} from '../../../src/tools/support/edit-recovery-queue';
import { testAgent } from '../harness/agent';

interface StubState {
  history: ContextMessage[];
  queue: EditRecoveryQueue;
}

function makeAgent(state: StubState): Agent {
  return {
    editRecoveryQueue: state.queue,
    context: {
      history: state.history,
      appendSystemReminder: (content: string, origin: unknown) => {
        state.history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin: origin as ContextMessage['origin'],
        });
      },
    },
  } as unknown as Agent;
}

function signature(line: number, message = `error ${String(line)}`): EditRecoverySignature {
  return { signature: `1:${message}:${String(line - 1)}`, line, message };
}

function reminder(
  path: string,
  signatures: readonly EditRecoverySignature[],
): {
  path: string;
  displayPath: string;
  signatures: readonly EditRecoverySignature[];
  instruction: string;
} {
  return {
    path: `/w/${path}`,
    displayPath: path,
    signatures,
    instruction: EDIT_RECOVERY_INSTRUCTION,
  };
}

function injectedTexts(state: StubState): string[] {
  return state.history
    .filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'edit_recovery_reminder',
    )
    .map((message) => (message.content[0] as { text: string }).text);
}

describe('EditRecoveryInjector', () => {
  it('renders a queued reminder in the system-reminder block', async () => {
    const state: StubState = { history: [], queue: new EditRecoveryQueue() };
    state.queue.enqueue(reminder('src/a.ts', [signature(3, 'Cannot find name x')]));

    await new EditRecoveryInjector(makeAgent(state)).inject();

    expect(injectedTexts(state)).toEqual([
      '<system-reminder>\n' +
        'Note: the edit to src/a.ts introduced 1 error(s): src/a.ts:3: Cannot find name x. ' +
        'Fix these before continuing.\n' +
        '</system-reminder>',
    ]);
  });

  it('keeps at most five signatures and summarises the rest', async () => {
    const state: StubState = { history: [], queue: new EditRecoveryQueue() };
    const signatures = Array.from({ length: 7 }, (_value, index) => signature(index + 1));
    state.queue.enqueue(reminder('src/a.ts', signatures));

    await new EditRecoveryInjector(makeAgent(state)).inject();

    const [text] = injectedTexts(state);
    expect(text).toContain('introduced 7 error(s):');
    expect(text).toContain('src/a.ts:5: error 5');
    expect(text).not.toContain('src/a.ts:6: error 6');
    expect(text).toContain('…and 2 more.');
  });

  it('renders nothing and leaves the prompt untouched when the queue is empty', async () => {
    const existing: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      toolCalls: [],
    };
    const state: StubState = { history: [existing], queue: new EditRecoveryQueue() };
    const before = JSON.stringify(state.history);

    await new EditRecoveryInjector(makeAgent(state)).inject();

    expect(state.history).toHaveLength(1);
    expect(JSON.stringify(state.history)).toBe(before);
  });

  it('injects an unchanged queue once, not on every step', async () => {
    const state: StubState = { history: [], queue: new EditRecoveryQueue() };
    state.queue.enqueue(reminder('src/a.ts', [signature(3, 'Cannot find name x')]));
    const injector = new EditRecoveryInjector(makeAgent(state));

    // `inject()` runs before every LLM step: an unchanged reminder is already
    // in the history and must not be appended again.
    await injector.inject();
    await injector.inject();
    await injector.inject();
    expect(injectedTexts(state)).toHaveLength(1);

    state.queue.clearIfResolved('/w/src/a.ts', new Set());
    await injector.inject();
    expect(injectedTexts(state)).toHaveLength(1);
  });

  it('injects again when the queue content changes', async () => {
    const state: StubState = { history: [], queue: new EditRecoveryQueue() };
    state.queue.enqueue(reminder('src/a.ts', [signature(3)]));
    const injector = new EditRecoveryInjector(makeAgent(state));

    await injector.inject();
    expect(injectedTexts(state)).toHaveLength(1);

    state.queue.enqueue(reminder('src/b.ts', [signature(4)]));
    await injector.inject();
    expect(injectedTexts(state)).toHaveLength(2);
    expect(injectedTexts(state)[1]).toContain('src/b.ts');
  });

  it('injects again after the previous copy left the context', async () => {
    const state: StubState = { history: [], queue: new EditRecoveryQueue() };
    state.queue.enqueue(reminder('src/a.ts', [signature(3)]));
    const injector = new EditRecoveryInjector(makeAgent(state));

    await injector.inject();
    injector.onContextClear();
    await injector.inject();
    expect(injectedTexts(state)).toHaveLength(2);
  });

  it('is registered with the injection manager and injects through it', async () => {
    const ctx = testAgent();
    ctx.agent.editRecoveryQueue.enqueue(reminder('src/a.ts', [signature(2)]));

    await ctx.agent.injection.inject();

    const reminders = ctx.agent.context.history.filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'edit_recovery_reminder',
    );
    expect(reminders).toHaveLength(1);
  });

  it('keeps reminders out of another agent', async () => {
    const first = testAgent();
    const second = testAgent();
    first.agent.editRecoveryQueue.enqueue(reminder('src/a.ts', [signature(2)]));

    await new EditRecoveryInjector(second.agent).inject();
    expect(second.agent.context.history).toHaveLength(0);

    await new EditRecoveryInjector(first.agent).inject();
    expect(first.agent.context.history).toHaveLength(1);
  });
});
