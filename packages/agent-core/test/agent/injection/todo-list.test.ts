import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { TodoListReminderInjector } from '../../../src/agent/injection/todo-list';
import type { TodoItem } from '../../../src/todo';
import { testJian } from '../../fixtures/test-jian';

interface StubState {
  history: ContextMessage[];
  todos: readonly TodoItem[];
}

function makeAgent(state: StubState): Agent {
  return {
    type: 'main',
    jian: testJian,
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
    tools: {
      data: () => [{ name: 'TodoList', active: true }],
      storeData: () => ({ todo: state.todos }),
    },
  } as unknown as Agent;
}

function assistant(text: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function todoWrite(todos: readonly TodoItem[]): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'Updated the todo list.' }],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo',
        name: 'TodoList',
        arguments: JSON.stringify({ todos }),
      },
    ],
  };
}

/** `count` plain assistant turns that neither write the list nor carry a reminder. */
function idleTurns(count: number): ContextMessage[] {
  return Array.from({ length: count }, (_value, index) => assistant(`turn ${String(index + 1)}`));
}

function injectedTexts(state: StubState): string[] {
  return state.history
    .filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'todo_list_reminder',
    )
    .map((message) => (message.content[0] as { text: string }).text);
}

const OPEN_TODOS: readonly TodoItem[] = [
  { title: 'Ship the feature', status: 'in_progress' },
  { title: 'Write the docs', status: 'pending' },
];

describe('TodoListReminderInjector', () => {
  it('injects the rendered list when items are unfinished and the thresholds are met', async () => {
    const state: StubState = { history: idleTurns(20), todos: OPEN_TODOS };
    const injector = new TodoListReminderInjector(makeAgent(state));

    await injector.inject();

    expect(state.history).toHaveLength(21);
    const text = injectedTexts(state)[0];
    expect(text).toContain('The TodoList tool has not been updated recently');
    expect(text).toContain('Current todo list:');
    expect(text).toContain('1. [in_progress] Ship the feature');
    expect(text).toContain('2. [pending] Write the docs');
    expect(state.history.at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'todo_list_reminder',
    });
  });

  it('keeps silent when the todo list is empty', async () => {
    const state: StubState = { history: idleTurns(20), todos: [] };
    const injector = new TodoListReminderInjector(makeAgent(state));

    await injector.inject();

    expect(state.history).toHaveLength(20);
    expect(injectedTexts(state)).toHaveLength(0);
  });

  it('keeps silent when every todo is done', async () => {
    const state: StubState = {
      history: idleTurns(20),
      todos: [
        { title: 'Ship the feature', status: 'done' },
        { title: 'Write the docs', status: 'done' },
      ],
    };
    const injector = new TodoListReminderInjector(makeAgent(state));

    await injector.inject();

    expect(state.history).toHaveLength(20);
    expect(injectedTexts(state)).toHaveLength(0);
  });

  it('still fires when the only remaining items are blocked', async () => {
    const state: StubState = {
      history: idleTurns(20),
      todos: [{ title: 'Waiting on review', status: 'blocked' }],
    };
    const injector = new TodoListReminderInjector(makeAgent(state));

    await injector.inject();

    const text = injectedTexts(state)[0];
    expect(text).toContain('Current todo list:');
    expect(text).toContain('1. [blocked] Waiting on review');
  });

  it('keeps silent below the raised thresholds', async () => {
    // The list was written 15 turns ago: past the old 10-turn floor, below the
    // raised 20-turn one.
    const state: StubState = {
      history: [todoWrite(OPEN_TODOS), ...idleTurns(15)],
      todos: OPEN_TODOS,
    };
    const injector = new TodoListReminderInjector(makeAgent(state));

    await injector.inject();

    expect(state.history).toHaveLength(16);
    expect(injectedTexts(state)).toHaveLength(0);
  });

  it('does not re-inject on the turn right after a reminder', async () => {
    const state: StubState = { history: idleTurns(20), todos: OPEN_TODOS };
    const injector = new TodoListReminderInjector(makeAgent(state));

    await injector.inject();
    await injector.inject();

    expect(injectedTexts(state)).toHaveLength(1);
  });
});
