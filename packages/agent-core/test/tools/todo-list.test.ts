/**
 * Covers the current TodoListTool contract.
 *
 * The todo state now lives in the agent tool store. The tool returns a
 * user-readable string in `output` and persists structured todos through
 * the injected store.
 */

import { describe, expect, it } from 'vitest';

import {
  TodoListInputSchema,
  TodoListTool,
} from '../../src/tools/builtin/state/todo-list';
import type { TodoItem } from '../../src/todo';
import type { ToolStore } from '../../src/tools/store';
import { executeTool } from './fixtures/execute-tool';
import { testAgent } from '../agent/harness/agent';

const signal = new AbortController().signal;

function makeStore(initial: readonly TodoItem[] = []): {
  store: ToolStore;
  getTodos(): readonly TodoItem[];
} {
  let todos = [...initial];
  return {
    store: {
      get: ((key: 'todo' | 'findings') => (key === 'todo' ? todos : undefined)) as import('../../src/tools/store').ToolStore['get'],
      set: ((key: 'todo' | 'findings', value: unknown) => {
        if (key === 'todo') {
          todos = [...(value as TodoItem[])];
        }
      }) as import('../../src/tools/store').ToolStore['set'],
    } as import('../../src/tools/store').ToolStore,
    getTodos: () => todos,
  };
}

function context(args: { todos?: TodoItem[] }) {
  return { turnId: '0', toolCallId: 'call_todo', args, signal };
}

function makeTool(initial: readonly TodoItem[] = []): {
  tool: TodoListTool;
  getTodos(): readonly TodoItem[];
} {
  const { store, getTodos } = makeStore(initial);
  return { tool: new TodoListTool(store), getTodos };
}

describe('TodoListTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const { tool } = makeTool();

    expect(tool.name).toBe('TodoList');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(TodoListInputSchema.safeParse({}).success).toBe(true);
    expect(
      TodoListInputSchema.safeParse({ todos: [{ title: 'x', status: 'wip' }] }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        todos: { type: 'array' },
      },
    });
  });

  it('description includes an Avoid churn section with the anti-spin guardrails', () => {
    const { tool } = makeTool();
    const { description } = tool;

    expect(description).toContain('**Avoid churn:**');
    // (1) do not re-call the tool when nothing meaningful changed between calls.
    expect(description).toMatch(/nothing meaningful has changed/i);
    expect(description).toMatch(/real progress/i);
    // (2) when unsure of the current state, use query mode first.
    expect(description).toMatch(/query mode/i);
    // (3) when stuck, tell the user instead of repeatedly re-ordering todos.
    expect(description).toMatch(/tell the user/i);
  });

  it('query mode renders the current list without mutating it', async () => {
    const { tool, getTodos } = makeTool([{ title: 'existing', status: 'in_progress' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Current todo list');
    expect(result.output).toContain('[in_progress] existing');
    expect(getTodos()).toEqual([{ title: 'existing', status: 'in_progress' }]);
  });

  it('write mode replaces the list and defensively copies todos into the store', async () => {
    const { tool, getTodos } = makeTool();
    const todos: TodoItem[] = [
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ];

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos },
      signal,
    });
    todos[0] = { title: 'leaked', status: 'done' };

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Todo list updated');
    expect(result.output).toContain('[pending] first');
    expect(result.output).toContain('[in_progress] second');
    expect(getTodos()).toEqual([
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ]);
  });

  it('renders a done todo with a marker matching the status enum value', async () => {
    const { tool } = makeTool([{ title: 'shipped', status: 'done' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('[done] shipped');
    expect(result.output).not.toContain('[completed]');
  });

  it('clear mode empties the list', async () => {
    const { tool, getTodos } = makeTool([{ title: 'x', status: 'pending' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos: [] },
      signal,
    });

    expect(result).toMatchObject({ isError: false, output: 'Todo list cleared.' });
    expect(getTodos()).toEqual([]);
  });

  it('preserves item order and phase through writes and grouped query output', async () => {
    const { tool, getTodos } = makeTool();
    const todos: TodoItem[] = [
      { title: 'phase-b first', status: 'pending', phase: 'Phase B' },
      { title: 'phase-a first', status: 'in_progress', phase: 'Phase A' },
      { title: 'phase-b second', status: 'done', phase: 'Phase B' },
    ];

    await executeTool(tool, context({ todos }));
    const query = await executeTool(tool, context({}));

    expect(getTodos()).toEqual(todos);
    expect(query.output).toBe(
      'Current todo list:\n\n## Phase B\n  [pending] phase-b first\n  [done] phase-b second\n\n## Phase A\n  [in_progress] phase-a first',
    );
  });

  it('emits complete snapshots only for successful writes and clears', async () => {
    const ctx = testAgent();
    const tool = new TodoListTool(ctx.agent.tools.toolStore);
    const todos: TodoItem[] = [
      { title: 'first', status: 'in_progress', phase: 'Build' },
      { title: 'second', status: 'pending', phase: 'Verify' },
    ];

    await executeTool(tool, context({ todos }));
    await executeTool(tool, context({}));
    await executeTool(tool, context({ todos: [] }));

    const updates = ctx.allEvents.filter(
      (event) => event.type === '[rpc]' && event.event === 'todo.updated',
    );
    expect(updates).toEqual([
      {
        type: '[rpc]',
        event: 'todo.updated',
        args: { todos },
      },
      {
        type: '[rpc]',
        event: 'todo.updated',
        args: { todos: [] },
      },
    ]);
  });

  it('returns defensive todo snapshots and does not retain caller-owned items', () => {
    const ctx = testAgent();
    const input: TodoItem[] = [{ title: 'original', status: 'pending', phase: 'Plan' }];

    ctx.agent.tools.updateStore('todo', input);
    input[0] = { title: 'mutated input', status: 'done' };
    const firstRead = ctx.agent.tools.getTodos() as TodoItem[];
    firstRead[0] = { title: 'mutated read', status: 'done' };

    expect(ctx.agent.tools.getTodos()).toEqual([
      { title: 'original', status: 'pending', phase: 'Plan' },
    ]);
  });

  it('resolveExecution description reflects the mode', () => {
    const { tool } = makeTool();
    const readExecution = tool.resolveExecution({});
    const clearExecution = tool.resolveExecution({ todos: [] });
    const updateExecution = tool.resolveExecution({ todos: [{ title: 'x', status: 'pending' }] });

    expect(readExecution.isError).toBeFalsy();
    expect(clearExecution.isError).toBeFalsy();
    expect(updateExecution.isError).toBeFalsy();
    if (
      readExecution.isError === true ||
      clearExecution.isError === true ||
      updateExecution.isError === true
    ) {
      throw new TypeError('expected runnable executions');
    }
    expect(readExecution.description).toBe('Reading todo list');
    expect(clearExecution.description).toBe('Clearing todo list');
    expect(updateExecution.description).toBe('Updating todo list');
  });
});
