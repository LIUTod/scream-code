import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '#/agent';
import { ToolManager } from '#/agent/tool/index';

import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

interface Harness {
  readonly manager: ToolManager;
  readonly emitEvent: ReturnType<typeof vi.fn>;
  readonly logRecord: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const emitEvent = vi.fn();
  const logRecord = vi.fn();
  const agent = {
    config: { hasProvider: false },
    records: { logRecord },
    goal: { getGoal: () => ({ goal: null }) },
    emitEvent,
    rpc: undefined,
  } as unknown as Agent;
  return { manager: new ToolManager(agent), emitEvent, logRecord };
}

function toolOf(manager: ToolManager, name: string) {
  const tool = manager.loopTools.find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe('ToolManager user-tool ownership and in-process execution', () => {
  it('runs an in-process execute without any host callback', async () => {
    const { manager } = makeHarness();
    manager.registerUserTool({
      name: 'in_proc',
      description: 'runs in process',
      parameters: {},
      execute: async (args) => ({ output: `ran:${JSON.stringify(args)}` }),
    });

    const result = await executeTool(toolOf(manager, 'in_proc'), {
      args: { x: 1 },
      turnId: '1',
      toolCallId: 'c1',
      signal,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('ran:{"x":1}');
  });

  it('converts a throwing in-process execute into an isError result', async () => {
    const { manager } = makeHarness();
    manager.registerUserTool({
      name: 'boom',
      description: 'throws',
      parameters: {},
      execute: async () => {
        throw new Error('boom');
      },
    });

    const result = await executeTool(toolOf(manager, 'boom'), {
      args: {},
      turnId: '1',
      toolCallId: 'c1',
      signal,
    });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('failed: boom');
  });

  it('treats an undefined in-process result as an error, not silence', async () => {
    const { manager } = makeHarness();
    manager.registerUserTool({
      name: 'silent',
      description: 'returns nothing',
      parameters: {},
      execute: async () => undefined as never,
    });

    const result = await executeTool(toolOf(manager, 'silent'), {
      args: {},
      turnId: '1',
      toolCallId: 'c1',
      signal,
    });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('returned no result');
  });

  it('keeps the wire record serializable: no execute, but owner survives', () => {
    const { manager, logRecord } = makeHarness();
    const registration = {
      name: 'recorded',
      description: 'shape check',
      parameters: {},
      ownerPluginId: 'owner-a',
      execute: async () => ({ output: 'ok' }),
    };
    manager.registerUserTool(registration);

    const record = logRecord.mock.calls.find(
      (call) => (call[0] as { type?: string }).type === 'tools.register_user_tool',
    )?.[0] as Record<string, unknown>;
    expect(record).toBeDefined();
    expect(record['name']).toBe('recorded');
    expect(record['ownerPluginId']).toBe('owner-a');
    expect('execute' in record).toBe(false);
  });

  it('unregisterToolsByOwner removes exactly the owner tools and emits events', () => {
    const { manager, emitEvent } = makeHarness();
    for (const [name, owner] of [
      ['a1', 'p1'],
      ['a2', 'p1'],
      ['b1', 'p2'],
      ['orphan', undefined],
    ] as const) {
      manager.registerUserTool({
        name,
        description: name,
        parameters: {},
        ...(owner !== undefined ? { ownerPluginId: owner } : {}),
        execute: async () => ({ output: name }),
      });
    }
    // Registration emits per tool before any teardown happens.
    const registeredEvents = emitEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event['reason'] === 'user.registered');
    expect(registeredEvents.map((event) => event['toolName']).toSorted()).toEqual([
      'a1',
      'a2',
      'b1',
      'orphan',
    ]);
    emitEvent.mockClear();

    expect(manager.unregisterToolsByOwner('p1')).toBe(2);

    const names = manager.loopTools.map((tool) => tool.name);
    expect(names).not.toContain('a1');
    expect(names).not.toContain('a2');
    expect(names).toContain('b1');
    expect(names).toContain('orphan');

    const reasons = emitEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const unregistered = reasons.filter((event) => event['reason'] === 'user.unregistered');
    expect(unregistered.map((event) => event['toolName']).toSorted()).toEqual(['a1', 'a2']);
  });

  it('re-registering a tool without an owner clears its previous ownership', () => {
    const { manager } = makeHarness();
    manager.registerUserTool({
      name: 'drifter',
      description: 'v1',
      parameters: {},
      ownerPluginId: 'p1',
    });
    manager.registerUserTool({ name: 'drifter', description: 'v2', parameters: {} });

    expect(manager.unregisterToolsByOwner('p1')).toBe(0);
    expect(manager.loopTools.map((tool) => tool.name)).toContain('drifter');
  });
});
