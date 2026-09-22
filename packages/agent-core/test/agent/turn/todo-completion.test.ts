import { describe, expect, it } from 'vitest';

import type { TodoItem } from '../../../src/todo';
import { testAgent } from '../harness/agent';

describe('turn todo reconciliation', () => {
  it.each(['done', 'blocked'] as const)(
    'lets the model reconcile stale todos to %s before finishing',
    async (status) => {
      const ctx = testAgent();
      ctx.configure({ tools: ['TodoList'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      ctx.mockNextResponse({
        type: 'function', id: 'todo_start', name: 'TodoList',
        arguments: JSON.stringify({ todos: [{ title: 'Verify the change', status: 'in_progress' }] }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'Here is the result of the requested work.' });
      const finalTodo: TodoItem = {
        title: 'Verify the change', status,
        blocker: status === 'blocked' ? 'Waiting for the required test data' : undefined,
      };
      ctx.mockNextResponse({
        type: 'function', id: 'todo_finish', name: 'TodoList',
        arguments: JSON.stringify({ todos: [finalTodo] }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'The final task status reflects the actual result.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Complete and report the task' }] });
      const events = await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(4);
      expect(ctx.agent.tools.getTodos()).toEqual([finalTodo]);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'todo.updated', args: expect.objectContaining({ todos: [finalTodo] }),
      }));
      expect(ctx.agent.turn.hasActiveTurn).toBe(false);
    },
  );

  it('ends after one ignored reminder without fabricating completion', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['TodoList'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.mockNextResponse({
      type: 'function', id: 'todo_unfinished', name: 'TodoList',
      arguments: JSON.stringify({ todos: [{ title: 'Unfinished work', status: 'pending' }] }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'Work remains.' });
    ctx.mockNextResponse({ type: 'text', text: 'The work is still incomplete.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try the task' }] });
    const end = ctx.agent.turn.waitForCurrentTurn();
    await expect(end).resolves.toMatchObject({ event: { reason: 'completed' } });

    expect(ctx.llmCalls).toHaveLength(3);
    expect(ctx.agent.tools.getTodos()).toEqual([{ title: 'Unfinished work', status: 'pending' }]);
  });

  it('lets the parent yield while background work is still running', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['TodoList'] });
    ctx.agent.tools.updateStore('todo', [{ title: 'Wait for worker', status: 'in_progress' }]);
    ctx.agent.background.registerAgentTask(new Promise(() => {}), 'Still working');
    ctx.mockNextResponse({ type: 'text', text: 'The background worker is still running.' });
    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Check the task' }] });
      await ctx.untilTurnEnd();
      expect(ctx.llmCalls).toHaveLength(1);
      expect(ctx.agent.tools.getTodos()[0]?.status).toBe('in_progress');
    } finally {
      ctx.agent.background._reset();
    }
  });

  it.each(['done', 'blocked'] as const)('does not reopen %s work', async (status) => {
    const ctx = testAgent();
    ctx.configure({ tools: ['TodoList'] });
    const todos: TodoItem[] = [{
      title: 'Previous work', status,
      blocker: status === 'blocked' ? 'Waiting for input' : undefined,
    }];
    ctx.agent.tools.updateStore('todo', todos);
    ctx.mockNextResponse({ type: 'text', text: 'Here is the requested explanation.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Explain the result' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.agent.tools.getTodos()).toEqual(todos);
  });

  it('does not request a todo update when TodoList is unavailable', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Read'] });
    const todos: TodoItem[] = [{ title: 'Previous work', status: 'pending' }];
    ctx.agent.tools.updateStore('todo', todos);
    ctx.mockNextResponse({ type: 'text', text: 'Here is the requested explanation.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Explain the result' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.agent.tools.getTodos()).toEqual(todos);
  });
});
