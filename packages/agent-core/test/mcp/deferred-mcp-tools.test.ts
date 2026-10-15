/**
 * On-demand MCP tools (DiscoverMcpTools).
 *
 * Servers default to `exposure: 'on-demand'`: their tools stay registered and
 * permission-checked as usual, but their schemas stay out of the offered tool
 * table until the model enables them — declaring every MCP schema on every
 * request cost tens of thousands of tokens per turn. `deferAll: false`
 * (server `exposure: 'always'`) keeps the eager behaviour.
 */

import type { Tool } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { ToolManager } from '../../src/agent/tool';
import type { MCPClient } from '../../src/mcp/types';
import { DiscoverMcpToolsTool } from '../../src/tools/builtin/mcp/discover-mcp-tools';
import { executeTool } from '../tools/fixtures/execute-tool';

function fakeAgent(): Agent {
  return {
    records: {
      logRecord() {
        /* records are not asserted here */
      },
    },
    config: {
      data: () => ({ provider: undefined }),
    },
    goal: {
      getGoal: () => ({ goal: null }),
    },
  } as unknown as Agent;
}

function fakeClient(): MCPClient {
  return {
    async listTools() {
      return [
        {
          name: 'echo',
          description: 'Echoes back the text it receives',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        {
          name: 'noop',
          description: 'Does nothing at all',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
  };
}

async function discoverTools(client: MCPClient): Promise<Tool[]> {
  const defs = await client.listTools();
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.inputSchema as Record<string, unknown>,
  }));
}

async function makeManager(deferAll: boolean): Promise<ToolManager> {
  const tm = new ToolManager(fakeAgent());
  tm.setActiveTools(['mcp__*']);
  const client = fakeClient();
  tm.registerMcpServer(
    'demo',
    client,
    await discoverTools(client),
    undefined,
    deferAll ? { deferAll: true } : undefined,
  );
  return tm;
}

describe('on-demand MCP tools', () => {
  it('withholds deferred tools from the offered table until enabled', async () => {
    const tm = await makeManager(true);

    expect(tm.loopTools.map((t) => t.name)).not.toContain('mcp__demo__echo');
    expect(tm.listDeferredMcpTools().map((t) => t.name)).toEqual([
      'mcp__demo__echo',
      'mcp__demo__noop',
    ]);
    const infos = [...tm.toolInfos()].filter((i) => i.source === 'mcp');
    expect(infos.map((i) => i.active)).toEqual([false, false]);
  });

  it('offers eager servers exactly as before', async () => {
    const tm = await makeManager(false);

    expect(tm.loopTools.map((t) => t.name)).toContain('mcp__demo__echo');
    expect(tm.listDeferredMcpTools()).toEqual([]);
  });

  it('enables a specific tool and leaves the rest withheld', async () => {
    const tm = await makeManager(true);

    const { enabled, skipped } = tm.enableDeferredMcpTools([
      'mcp__demo__echo',
      'mcp__demo__missing',
    ]);
    expect(enabled).toEqual(['mcp__demo__echo']);
    expect(skipped).toEqual(['mcp__demo__missing']);

    expect(tm.loopTools.map((t) => t.name)).toContain('mcp__demo__echo');
    expect(tm.loopTools.map((t) => t.name)).not.toContain('mcp__demo__noop');
    expect(tm.listDeferredMcpTools().map((t) => t.name)).toEqual(['mcp__demo__noop']);

    // Idempotent: re-enabling reports a skip, not a duplicate.
    expect(tm.enableDeferredMcpTools(['mcp__demo__echo']).skipped).toEqual(['mcp__demo__echo']);
    expect(tm.loopTools.map((t) => t.name).filter((n) => n === 'mcp__demo__echo')).toHaveLength(1);
  });

  it('refuses to enable a name the active patterns exclude', async () => {
    const tm = new ToolManager(fakeAgent());
    const client = fakeClient();
    // Only `echo` is accessible; `noop` exists but the pattern excludes it.
    tm.setActiveTools(['mcp__demo__echo']);
    tm.registerMcpServer('demo', client, await discoverTools(client), undefined, {
      deferAll: true,
    });

    const { enabled, skipped } = tm.enableDeferredMcpTools(['mcp__demo__noop']);

    expect(enabled).toEqual([]);
    expect(skipped).toEqual(['mcp__demo__noop']);
    // Reporting success while the offer table stays empty would be a false
    // promise; listing and enabling must agree on the pattern filter.
    expect(tm.loopTools.map((t) => t.name)).not.toContain('mcp__demo__noop');
    expect(tm.listDeferredMcpTools().map((t) => t.name)).toEqual(['mcp__demo__echo']);
  });

  it('drops deferred and enabled state when the server unregisters', async () => {
    const tm = await makeManager(true);
    tm.enableDeferredMcpTools(['mcp__demo__echo']);

    expect(tm.unregisterMcpServer('demo')).toBe(true);
    expect(tm.listDeferredMcpTools()).toEqual([]);
    expect(tm.loopTools.map((t) => t.name)).not.toContain('mcp__demo__echo');
  });
});

describe('DiscoverMcpTools', () => {
  const ctx = (): { turnId: string; toolCallId: string; signal: AbortSignal } => ({
    turnId: '1',
    toolCallId: 'call_1',
    signal: new AbortController().signal,
  });

  it('summarizes servers, lists one server, and enables tools', async () => {
    const tm = await makeManager(true);
    const tool = new DiscoverMcpToolsTool(tm);

    const overview = await executeTool(tool, { ...ctx(), args: {} });
    expect(overview.isError).toBe(false);
    expect(overview.output).toContain('withheld_tools: 2');
    expect(overview.output).toContain('- demo: 2 tool(s)');

    const listed = await executeTool(tool, { ...ctx(), args: { server: 'demo' } });
    expect(listed.output).toContain('mcp__demo__echo — Echoes back the text it receives');
    expect(listed.output).toContain('mcp__demo__noop — Does nothing at all');

    const enabled = await executeTool(tool, { ...ctx(), args: { tools: ['mcp__demo__noop'] } });
    expect(enabled.output).toContain('enabled: 1');
    expect(enabled.output).toContain('mcp__demo__noop');
    expect(tm.loopTools.map((t) => t.name)).toContain('mcp__demo__noop');
  });

  it('reports when nothing is on demand', async () => {
    const tm = await makeManager(false);
    const tool = new DiscoverMcpToolsTool(tm);

    const result = await executeTool(tool, { ...ctx(), args: {} });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('No on-demand MCP tools are available');
  });
});
