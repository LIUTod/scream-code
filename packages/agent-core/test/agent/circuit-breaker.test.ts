import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '#/agent';
import { ToolManager } from '#/agent/tool/index';
import { PluginManager } from '#/plugin/manager';
import { qualifyMcpToolName } from '#/mcp/tool-naming';

import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

/**
 * Wait for the fire-and-forget teardown that trip() starts. Polling (not a
 * fixed number of macrotasks) so the assertions stay honest under the
 * parallel-load of a full-suite run, where the persisted disable can take
 * tens of milliseconds.
 */
async function waitFor(check: () => boolean, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > budgetMs) {
      throw new Error('circuit teardown did not settle within budget');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function installRecord(manager: PluginManager, name: string): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `circuit-${name}-`));
  await writeFile(
    path.join(root, 'scream.plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }),
    'utf8',
  );
  await manager.install(root);
}

interface Harness {
  readonly manager: ToolManager;
  readonly plugins: PluginManager;
  readonly pluginSync: ReturnType<typeof vi.fn>;
  readonly logRecord: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), 'circuit-home-'));
  const plugins = new PluginManager({ screamHomeDir: home });
  await plugins.load();
  const pluginSync = vi.fn(async () => ({ ok: true, sessions: 0, applied: [], failed: [] }));
  const logRecord = vi.fn();
  const agent = {
    config: { hasProvider: false },
    records: { logRecord },
    goal: { getGoal: () => ({ goal: null }) },
    emitEvent: vi.fn(),
    toolServices: { plugins, pluginSync },
    rpc: undefined,
  } as unknown as Agent;
  return { manager: new ToolManager(agent), plugins, pluginSync, logRecord };
}

function toolNamed(manager: ToolManager, name: string) {
  const tool = manager.loopTools.find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe('ToolManager circuit breaker', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await installRecord(harness.plugins, 'clumsy');
  });

  it('three consecutive in-process failures trip, disable, and advise the model', async () => {
    harness.manager.registerUserTool({
      name: 'clumsy_tool',
      description: 'always fails',
      parameters: {},
      ownerPluginId: 'clumsy',
      execute: async () => {
        throw new Error('always broken');
      },
    });
    const tool = toolNamed(harness.manager, 'clumsy_tool');

    const first = await executeTool(tool, { args: {}, turnId: '1', toolCallId: 'c1', signal });
    expect(first.isError).toBe(true);
    expect(String(first.output)).not.toContain('[circuit]');
    expect(harness.manager.getCircuitFailures('clumsy')).toBe(1);

    await executeTool(tool, { args: {}, turnId: '1', toolCallId: 'c2', signal });
    expect(harness.manager.getCircuitFailures('clumsy')).toBe(2);

    const third = await executeTool(tool, { args: {}, turnId: '1', toolCallId: 'c3', signal });
    expect(third.isError).toBe(true);
    expect(String(third.output)).toContain('[circuit]');
    expect(String(third.output)).toContain('reset');

    await waitFor(() => harness.plugins.get('clumsy')?.enabled === false);
    expect(harness.plugins.get('clumsy')?.enabled).toBe(false);
    expect(harness.plugins.get('clumsy')?.state).toBe('error');
    expect(
      harness.plugins.get('clumsy')?.diagnostics.some((d) => /circuit tripped/.test(d.message)),
    ).toBe(true);
    expect(harness.pluginSync).toHaveBeenCalledWith(['clumsy']);
    // Teardown asked for; the tool leaves the loop only once the sync pass ran.
    harness.manager.unregisterToolsByOwner('clumsy');
    expect(harness.manager.loopTools.map((t) => t.name)).not.toContain('clumsy_tool');
  });

  it('a success between failures clears the streak', async () => {
    let failNext = true;
    harness.manager.registerUserTool({
      name: 'flaky',
      description: 'fails sometimes',
      parameters: {},
      ownerPluginId: 'clumsy',
      execute: async () => {
        if (failNext) {
          failNext = false;
          return { output: 'kaboom', isError: true };
        }
        failNext = true;
        return { output: 'fine' };
      },
    });
    const tool = toolNamed(harness.manager, 'flaky');

    await executeTool(tool, { args: {}, turnId: '1', toolCallId: 'c1', signal });
    expect(harness.manager.getCircuitFailures('clumsy')).toBe(1);
    await executeTool(tool, { args: {}, turnId: '1', toolCallId: 'c2', signal });
    expect(harness.manager.getCircuitFailures('clumsy')).toBe(0);
    await executeTool(tool, { args: {}, turnId: '1', toolCallId: 'c3', signal });
    expect(harness.manager.getCircuitFailures('clumsy')).toBe(1);
    expect(harness.manager.isCircuitTripped('clumsy')).toBe(false);
  });

  it('tools without an owner plugin never charge a breaker', async () => {
    harness.manager.registerUserTool({
      name: 'homeless',
      description: 'no owner',
      parameters: {},
      execute: async () => {
        throw new Error('nope');
      },
    });
    const tool = toolNamed(harness.manager, 'homeless');
    for (let call = 0; call < 5; call += 1) {
      await executeTool(tool, { args: {}, turnId: '1', toolCallId: `c${String(call)}`, signal });
    }
    expect(harness.manager.isCircuitTripped('clumsy')).toBe(false);
    expect(harness.pluginSync).not.toHaveBeenCalled();
  });

  it('a plugin MCP server failure streak trips the owning plugin', async () => {
    const failingClient = {
      callTool: vi.fn(async () => {
        throw new Error('server down');
      }),
    } as unknown as Parameters<ToolManager['registerMcpServer']>[1];
    harness.manager.registerMcpServer(
      'plugin-clumsy:srv',
      failingClient,
      [{ name: 'do', description: 'does', parameters: {} }] as never,
    );
    // The fake agent has no profile MCP access patterns, so read the tool
    // straight off the registration map instead of via loopTools.
    const mcpTools = (
      harness.manager as unknown as {
        mcpTools: Map<string, { tool: Parameters<typeof executeTool>[0] }>;
      }
    ).mcpTools;
    const entry = mcpTools.get(qualifyMcpToolName('plugin-clumsy:srv', 'do'));
    expect(entry).toBeDefined();
    const tool = entry!.tool;

    let last: { output?: unknown; isError?: boolean } = {};
    for (let call = 0; call < 3; call += 1) {
      last = await executeTool(tool, {
        args: {},
        turnId: '1',
        toolCallId: `m${String(call)}`,
        signal,
      });
    }
    expect(last.isError).toBe(true);
    expect(String(last.output)).toContain('[circuit]');
    await waitFor(() => harness.plugins.get('clumsy')?.enabled === false);
    expect(harness.plugins.get('clumsy')?.enabled).toBe(false);
  });

  it('resetCircuit clears both the streak and the trip mark', async () => {
    harness.manager.registerUserTool({
      name: 'tripme',
      description: 'd',
      parameters: {},
      ownerPluginId: 'clumsy',
      execute: async () => {
        throw new Error('x');
      },
    });
    const tool = toolNamed(harness.manager, 'tripme');
    for (let call = 0; call < 3; call += 1) {
      await executeTool(tool, { args: {}, turnId: '1', toolCallId: `t${String(call)}`, signal });
    }
    expect(harness.manager.isCircuitTripped('clumsy')).toBe(true);

    harness.manager.resetCircuit('clumsy');

    expect(harness.manager.isCircuitTripped('clumsy')).toBe(false);
    expect(harness.manager.getCircuitFailures('clumsy')).toBe(0);
  });

  it('a tripped plugin cannot keep charging (trip fires exactly once)', async () => {
    harness.manager.registerUserTool({
      name: 'persist_bad',
      description: 'd',
      parameters: {},
      ownerPluginId: 'clumsy',
      execute: async () => {
        throw new Error('x');
      },
    });
    const tool = toolNamed(harness.manager, 'persist_bad');
    for (let call = 0; call < 6; call += 1) {
      await executeTool(tool, { args: {}, turnId: '1', toolCallId: `p${String(call)}`, signal });
    }
    await waitFor(() => harness.pluginSync.mock.calls.length > 0);
    // A brief grace period: nothing may schedule a second teardown wave.
    await new Promise((r) => setTimeout(r, 100));
    // No second teardown wave after the first trip.
    expect(harness.pluginSync).toHaveBeenCalledTimes(1);
  });
});
