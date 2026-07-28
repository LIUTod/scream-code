import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { ScreamHarness, type Event, type TodoItem } from '#/index';

import { makeTempDir, removeTempDirs, waitForSDKEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.getTodos / todo.updated', () => {
  it('reads an empty list, exposes complete update events, and returns defensive snapshots', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-todos-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-todos-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_todos', workDir });
      await expect(session.getTodos()).resolves.toEqual([]);

      const input: TodoItem[] = [
        { title: 'Implement core contract', status: 'done', phase: 'Core' },
        { title: 'Consume SDK event', status: 'in_progress', phase: 'TUI' },
      ];
      const update = waitForSDKEvent(session, (event) => event.type === 'todo.updated');
      mainAgent(harness, session.id).tools.updateStore('todo', input);
      const event = await update;

      expect(event).toMatchObject({
        type: 'todo.updated',
        sessionId: session.id,
        agentId: 'main',
        todos: input,
      });
      const eventTodos = (
        event.type === 'todo.updated' ? event.todos : []
      ) as TodoItem[];
      const firstRead = (await session.getTodos()) as TodoItem[];
      input[0] = { title: 'mutated input', status: 'pending' };
      eventTodos[0] = { title: 'mutated event', status: 'pending' };
      firstRead[0] = { title: 'mutated read', status: 'pending' };

      await expect(session.getTodos()).resolves.toEqual([
        { title: 'Implement core contract', status: 'done', phase: 'Core' },
        { title: 'Consume SDK event', status: 'in_progress', phase: 'TUI' },
      ]);
      expectTypeOf(event).toEqualTypeOf<Event>();
    } finally {
      await harness.close();
    }
  });
});

interface CoreAgentTools {
  updateStore(key: 'todo', value: TodoItem[]): void;
}

function mainAgent(
  harness: ScreamHarness,
  sessionId: string,
): { readonly tools: CoreAgentTools } {
  const core = (
    harness as unknown as {
      readonly rpc: {
        readonly core: {
          readonly sessions: ReadonlyMap<
            string,
            { readonly agents: ReadonlyMap<string, { readonly tools: CoreAgentTools }> }
          >;
        };
      };
    }
  ).rpc.core;
  const session = core.sessions.get(sessionId);
  const agent = session?.agents.get('main');
  if (agent === undefined) throw new Error('Expected active main agent');
  return agent;
}
