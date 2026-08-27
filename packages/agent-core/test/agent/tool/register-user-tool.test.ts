import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Agent } from '#/agent';
import { ToolManager } from '#/agent/tool/index';
import { defineUserTool } from '#/agent/tool/define-tool';

import { executeTool } from '../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function makeManager(rpc: unknown): ToolManager {
  const agent = {
    config: { hasProvider: false },
    records: { logRecord: vi.fn() },
    goal: { getGoal: () => ({ goal: null }) },
    emitEvent: vi.fn(),
    rpc,
  } as unknown as Agent;
  return new ToolManager(agent);
}

function registerPluginTool(manager: ToolManager): void {
  manager.registerUserTool(
    defineUserTool({
      name: 'plugin_echo',
      description: 'Echoes its input back through the host.',
      parameters: z.object({ text: z.string() }),
    }),
  );
}

function pluginTool(manager: ToolManager) {
  const tool = manager.loopTools.find((candidate) => candidate.name === 'plugin_echo');
  expect(tool).toBeDefined();
  return tool!;
}

describe('ToolManager.registerUserTool host callback support', () => {
  it('reports a tool error instead of throwing when the host has no rpc', async () => {
    const manager = makeManager(undefined);
    registerPluginTool(manager);

    const result = await executeTool(pluginTool(manager), {
      args: { text: 'hi' },
      turnId: '7',
      toolCallId: 'call_1',
      signal,
    });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('host does not support in-band tool callbacks');
  });

  it('reports a tool error when the host rpc has no toolCall method', async () => {
    const manager = makeManager({ emitEvent: vi.fn() });
    registerPluginTool(manager);

    const result = await executeTool(pluginTool(manager), {
      args: { text: 'hi' },
      turnId: '7',
      toolCallId: 'call_1',
      signal,
    });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('"plugin_echo" cannot execute');
  });

  it('forwards the call to the host when toolCall exists', async () => {
    const toolCall = vi.fn().mockResolvedValue({ output: 'echo: hi' });
    const manager = makeManager({ toolCall });
    registerPluginTool(manager);

    const result = await executeTool(pluginTool(manager), {
      args: { text: 'hi' },
      turnId: '7',
      toolCallId: 'call_1',
      signal,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('echo: hi');
    expect(toolCall).toHaveBeenCalledWith(
      { turnId: 7, toolCallId: 'call_1', args: { text: 'hi' } },
      { signal },
    );
  });
});
