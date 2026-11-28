import { readFile, rm } from 'node:fs/promises';

import type { ContentPart, Tool, ToolAnnotations } from '@scream-code/ltod';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { ToolManager } from '../../src/agent/tool';
import type { McpConnectionManager } from '../../src/mcp';
import { mapMcpAnnotations } from '../../src/mcp/connection-manager';
import { MCP_PREVIEW_CHARS } from '../../src/mcp/output';
import type { MCPClient } from '../../src/mcp/types';
import { testAgent } from '../agent/harness/agent';
import { executeTool } from '../tools/fixtures/execute-tool';

function fakeAgent(calls: unknown[] = []): Agent {
  return {
    records: {
      logRecord(record: unknown) {
        calls.push(record);
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
          description: 'Echoes back',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        {
          name: 'noop',
          description: 'Does nothing',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
    },
    async callTool(name, args) {
      if (name === 'echo') {
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
  };
}

// Projects an MCP client's `listTools()` output into the ltod `Tool` shape that
// `ToolManager.registerMcpServer` expects. Annotations go through the **same**
// `mapMcpAnnotations` the connection manager uses — a hand-rolled copy would let
// a regression in either side pass this test.
async function discoverTools(client: MCPClient): Promise<Tool[]> {
  const defs = await client.listTools();
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.inputSchema as Record<string, unknown>,
    ...(d.annotations === undefined ? {} : { annotations: mapMcpAnnotations(d.annotations) }),
  }));
}


describe('ToolManager MCP integration', () => {
  it('registers MCP tools under qualified names with source=mcp', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();
    tm.registerMcpServer('local server', client, await discoverTools(client));

    const infos = [...tm.toolInfos()].filter((i) => i.source === 'mcp');
    expect(infos.map((i) => i.name).toSorted()).toEqual([
      'mcp__local_server__echo',
      'mcp__local_server__noop',
    ]);
    for (const info of infos) {
      expect(info.active).toBe(true);
    }

    const loop = tm.loopTools.map((t) => t.name);
    expect(loop).toContain('mcp__local_server__echo');
    expect(loop).toContain('mcp__local_server__noop');
  });

  it('respects enabledTools filter when registering', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client), new Set(['echo']));

    const mcpNames = [...tm.toolInfos()].filter((i) => i.source === 'mcp').map((i) => i.name);
    expect(mcpNames).toEqual(['mcp__s__echo']);
  });

  it('unregisterMcpServer removes every tool the server contributed', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();

    const before = tm.registerMcpServer('s', client, await discoverTools(client));
    expect(before.registered.length).toBe(2);
    expect(before.collisions).toEqual([]);
    expect(tm.loopTools.length).toBe(2);

    expect(tm.unregisterMcpServer('s')).toBe(true);
    expect([...tm.toolInfos()].filter((i) => i.source === 'mcp')).toEqual([]);
    expect(tm.loopTools).toEqual([]);
    expect(tm.unregisterMcpServer('s')).toBe(false);
  });

  it('reports same-server qualified-name collisions and keeps only the first tool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const colliding: MCPClient = {
      async listTools() {
        return [
          { name: 'a b', description: 'first', inputSchema: { type: 'object', properties: {} } },
          {
            name: 'a__b',
            description: 'collides after collapse',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    };
    const result = tm.registerMcpServer('srv', colliding, await discoverTools(colliding));

    expect(result.registered).toEqual(['mcp__srv__a_b']);
    expect(result.collisions).toEqual([
      {
        qualified: 'mcp__srv__a_b',
        toolName: 'a__b',
        collidesWith: { kind: 'same_server', toolName: 'a b' },
      },
    ]);
    const mcpNames = [...tm.toolInfos()].filter((i) => i.source === 'mcp').map((i) => i.name);
    expect(mcpNames).toEqual(['mcp__srv__a_b']);
  });

  it('reports cross-server collisions instead of silently overwriting another server tool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const firstClient: MCPClient = {
      async listTools() {
        return [
          { name: 'shared', description: 'first', inputSchema: { type: 'object', properties: {} } },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'first' }], isError: false };
      },
    };
    const secondClient: MCPClient = {
      async listTools() {
        return [
          {
            name: 'shared',
            description: 'second',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'second' }], isError: false };
      },
    };

    // Both servers collapse to the same sanitized form ("srv_a"), so the
    // qualified name `mcp__srv_a__shared` is contested between them.
    tm.registerMcpServer('srv a', firstClient, await discoverTools(firstClient));
    const result = tm.registerMcpServer('srv__a', secondClient, await discoverTools(secondClient));

    expect(result.registered).toEqual([]);
    expect(result.collisions).toEqual([
      {
        qualified: 'mcp__srv_a__shared',
        toolName: 'shared',
        collidesWith: { kind: 'other_server', serverName: 'srv a' },
      },
    ]);
    // First server's tool still wins and stays callable.
    expect(tm.loopTools.map((t) => t.name)).toEqual(['mcp__srv_a__shared']);
  });

  it('re-registering the same server replaces its previous tool set', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const firstClient = fakeClient();
    const secondClient: MCPClient = {
      async listTools() {
        return [
          {
            name: 'only',
            description: 'Sole tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [], isError: false };
      },
    };

    tm.registerMcpServer('s', firstClient, await discoverTools(firstClient));
    tm.registerMcpServer('s', secondClient, await discoverTools(secondClient));

    const mcpNames = [...tm.toolInfos()].filter((i) => i.source === 'mcp').map((i) => i.name);
    expect(mcpNames).toEqual(['mcp__s__only']);
  });

  it('does not write set_active_tools records when registering an MCP server', async () => {
    const calls: unknown[] = [];
    const tm = new ToolManager(fakeAgent(calls));
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));

    // MCP tools live in mcpTools map, separate from enabledTools, so
    // registering an MCP server does not mutate enabledTools and does not
    // emit a set_active_tools record. This is what keeps wire.jsonl free of
    // synthetic mutations on session resume.
    expect(calls).not.toContainEqual(
      expect.objectContaining({ type: 'tools.set_active_tools' }),
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({ type: 'tools.register_mcp_server' }),
    );
  });

  it('re-enables all registered MCP tools when re-registering a server', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const firstClient = fakeClient();
    const secondClient = fakeClient();

    tm.registerMcpServer('s', firstClient, await discoverTools(firstClient));
    tm.unregisterMcpServer('s');
    expect(tm.loopTools).toEqual([]);
    tm.registerMcpServer('s', secondClient, await discoverTools(secondClient));

    const mcpInfos = [...tm.toolInfos()]
      .filter((i) => i.source === 'mcp')
      .map((i) => ({ name: i.name, active: i.active }));
    expect(mcpInfos).toEqual([
      { name: 'mcp__s__echo', active: true },
      { name: 'mcp__s__noop', active: true },
    ]);
    expect(tm.loopTools.map((t) => t.name)).toEqual(['mcp__s__echo', 'mcp__s__noop']);
  });

  it('executing a wrapped MCP tool dispatches to client.callTool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));
    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');
    expect(echo).toBeDefined();

    const result = await executeTool(echo!, {
      turnId: '1',
      toolCallId: 'tc-1',
      args: { text: 'hello world' },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('hello world');
  });

  it('reconnects and retries once on retriable MCP connection errors', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);

    const failingClient: MCPClient = {
      async listTools() {
        return [
          {
            name: 'echo',
            description: 'Echoes back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ];
      },
      async callTool() {
        throw new Error('transport closed unexpectedly');
      },
    };

    const recoveredClient: MCPClient = {
      async listTools() {
        return [
          {
            name: 'echo',
            description: 'Echoes back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ];
      },
      async callTool(name, args) {
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      },
    };

    let activeClient = failingClient;
    const fakeMcp = {
      get: () => ({ status: 'failed' as const }),
      reconnect: async () => {
        activeClient = recoveredClient;
      },
      resolved: () => ({ client: activeClient, tools: [], enabledNames: new Set<string>() }),
    } as unknown as McpConnectionManager;

    tm.registerMcpServer('s', failingClient, await discoverTools(failingClient), undefined, {
      mcp: fakeMcp,
    });
    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');
    expect(echo).toBeDefined();

    const result = await executeTool(echo!, {
      turnId: '1',
      toolCallId: 'tc-retry',
      args: { text: 'recovered' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe('recovered');
  });

  it('does not retry non-retriable MCP call errors', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);

    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'echo',
            description: 'Echoes back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ];
      },
      async callTool() {
        throw new Error('invalid argument: text is required');
      },
    };

    const reconnect = vi.fn();
    const fakeMcp = {
      get: () => ({ status: 'connected' as const }),
      reconnect,
      resolved: () => ({ client, tools: [], enabledNames: new Set<string>() }),
    } as unknown as McpConnectionManager;

    tm.registerMcpServer('s', client, await discoverTools(client), undefined, { mcp: fakeMcp });
    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');

    const result = await executeTool(echo!, {
      turnId: '1',
      toolCallId: 'tc-no-retry',
      args: { text: 'x' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('invalid argument');
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('saves oversized MCP text output to a file and returns a preview with the path', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'big',
            description: 'Returns a huge text',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: 'text', text: 'x'.repeat(100_001) }],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const big = tm.loopTools.find((t) => t.name === 'mcp__s__big');

    const result = await executeTool(big!, {
      turnId: '1',
      toolCallId: 'tc-big-text',
      args: {},
      signal: new AbortController().signal,
    });

    // The whole text goes to a file; the model gets a preview, the size and the path.
    expect(result.isError).toBe(false);
    const output = result.output as string;
    expect(output.startsWith('x'.repeat(MCP_PREVIEW_CHARS))).toBe(true);
    expect(output).toContain('100001 characters');
    const path = /saved to (\S+) /.exec(output)?.[1];
    expect(await readFile(path!, 'utf8')).toBe('x'.repeat(100_001));
    await rm(path!);
  });

  it('wraps modestly-sized MCP image output in mcp_tool_result companions', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'snap',
            description: 'Returns a small image',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: 'image', data: 'x'.repeat(100_000), mimeType: 'image/png' }],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const snap = tm.loopTools.find((t) => t.name === 'mcp__s__snap');

    const result = await executeTool(snap!, {
      turnId: '1',
      toolCallId: 'tc-small-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // mcpResultToExecutableOutput wraps media-only output in text companions
    // tagged with the qualified tool name; the image_url itself is preserved
    // intact (~75 KiB raw, well below the 10 MiB per-part cap).
    expect(parts).toEqual([
      { type: 'text', text: '<mcp_tool_result name="mcp__s__snap">' },
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,' + 'x'.repeat(100_000) },
      },
      { type: 'text', text: '</mcp_tool_result>' },
    ]);
  });

  it('drops MCP binary parts exceeding the per-part byte cap and substitutes a notice', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    // 14 MiB base64 ≈ 10.5 MiB raw — just above the 10 MiB per-part cap.
    const huge = 'x'.repeat(14 * 1024 * 1024);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'huge_img',
            description: 'Returns an oversized image',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: 'image', data: huge, mimeType: 'image/png' }],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const tool = tm.loopTools.find((t) => t.name === 'mcp__s__huge_img');

    const result = await executeTool(tool!, {
      turnId: '1',
      toolCallId: 'tc-huge-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // applyOutputLimits swaps the oversized image for a per-part notice
    // inside the mcp_tool_result envelope: [open tag, dropped notice, close tag].
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({
      type: 'text',
      text: '<mcp_tool_result name="mcp__s__huge_img">',
    });
    expect(parts[1]?.type).toBe('text');
    expect((parts[1] as { text: string }).text).toContain('image_url dropped');
    expect((parts[1] as { text: string }).text).toContain('10 MB per-part limit');
    expect(parts[2]).toEqual({ type: 'text', text: '</mcp_tool_result>' });
    // The notice replaces the binary part; the *text* truncation marker must
    // not fire because the text character budget was never touched.
    const joined = parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    expect(joined).not.toContain('Output truncated');
  });

  it('large MCP image does not consume the text character budget', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'mixed',
            description: 'Returns text plus an image',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [
            { type: 'text', text: 'A'.repeat(100_000) },
            { type: 'image', data: 'B'.repeat(500_000), mimeType: 'image/png' },
          ],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const tool = tm.loopTools.find((t) => t.name === 'mcp__s__mixed');

    const result = await executeTool(tool!, {
      turnId: '1',
      toolCallId: 'tc-text-plus-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // The long text goes to a file (preview + path); the image survives intact.
    expect(parts).toHaveLength(2);
    const preview = parts[0]!.type === 'text' ? parts[0]!.text : '';
    expect(preview.startsWith('A'.repeat(MCP_PREVIEW_CHARS))).toBe(true);
    const path = /saved to (\S+) /.exec(preview)?.[1];
    expect(await readFile(path!, 'utf8')).toBe('A'.repeat(100_000));
    await rm(path!);
    expect(parts[1]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,' + 'B'.repeat(500_000) },
    });
  });

  it('oversized binary part does not affect neighboring small binary parts', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const huge = 'x'.repeat(14 * 1024 * 1024);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'mixed',
            description: 'Returns an oversized image plus a small audio clip',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [
            { type: 'image', data: huge, mimeType: 'image/png' },
            { type: 'audio', data: 'A'.repeat(1000), mimeType: 'audio/mpeg' },
          ],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const tool = tm.loopTools.find((t) => t.name === 'mcp__s__mixed');

    const result = await executeTool(tool!, {
      turnId: '1',
      toolCallId: 'tc-mixed-binary',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // Inside the mcp_tool_result envelope: [open tag, dropped image notice,
    // surviving audio, close tag]. The audio survives because each binary
    // part is measured against its own byte cap independently.
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({ type: 'text', text: '<mcp_tool_result name="mcp__s__mixed">' });
    expect(parts[1]?.type).toBe('text');
    expect((parts[1] as { text: string }).text).toContain('image_url dropped');
    expect(parts[2]).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/mpeg;base64,' + 'A'.repeat(1000) },
    });
    expect(parts[3]).toEqual({ type: 'text', text: '</mcp_tool_result>' });
  });

  it('forwards the execution AbortSignal through the wrapped MCP tool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    let receivedSignal: AbortSignal | undefined;
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'echo',
            description: 'Echoes back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ];
      },
      async callTool(_name, args, signal) {
        receivedSignal = signal;
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');

    const controller = new AbortController();
    await executeTool(echo!, {
      turnId: '1',
      toolCallId: 'tc-signal',
      args: { text: 'hi' },
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it('gates MCP tools by the active profile', async () => {
    const ctx = testAgent();
    const tm = ctx.agent.tools;
    const client = fakeClient();
    tm.registerMcpServer('local', client, await discoverTools(client));

    // A profile without any MCP pattern hides every MCP tool: they stay
    // registered (and visible in toolInfos) but inactive and out of the loop.
    ctx.agent.useProfile({
      name: 'no-mcp',
      systemPrompt: () => 'sys',
      tools: ['Read'],
      toolsExplicit: true,
    });
    expect(
      [...tm.toolInfos()]
        .filter((i) => i.source === 'mcp')
        .map((i) => ({ name: i.name, active: i.active })),
    ).toEqual([
      { name: 'mcp__local__echo', active: false },
      { name: 'mcp__local__noop', active: false },
    ]);
    expect(tm.loopTools.some((t) => t.name.startsWith('mcp__'))).toBe(false);

    // Adding `mcp__*` to the profile exposes them again.
    ctx.agent.useProfile({
      name: 'with-mcp',
      systemPrompt: () => 'sys',
      tools: ['Read', 'mcp__*'],
      toolsExplicit: true,
    });
    expect(
      [...tm.toolInfos()]
        .filter((i) => i.source === 'mcp')
        .map((i) => ({ name: i.name, active: i.active })),
    ).toEqual([
      { name: 'mcp__local__echo', active: true },
      { name: 'mcp__local__noop', active: true },
    ]);
    expect(tm.loopTools.map((t) => t.name)).toContain('mcp__local__echo');
  });

  it('a server-scoped MCP glob exposes only that server', async () => {
    const tm = new ToolManager(fakeAgent());
    const githubClient = fakeClient();
    const slackClient = fakeClient();
    tm.registerMcpServer('github', githubClient, await discoverTools(githubClient));
    tm.registerMcpServer('slack', slackClient, await discoverTools(slackClient));
    tm.setActiveTools(['mcp__github__*']);

    expect(tm.loopTools.map((t) => t.name).toSorted()).toEqual([
      'mcp__github__echo',
      'mcp__github__noop',
    ]);
  });

  it('an exact MCP tool name exposes only that tool', async () => {
    const tm = new ToolManager(fakeAgent());
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));
    tm.setActiveTools(['mcp__s__echo']);

    expect(tm.loopTools.map((t) => t.name)).toEqual(['mcp__s__echo']);
  });

  it('surfaces the MCP tool description on the resolved execution', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));
    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');
    expect(echo).toBeDefined();

    const execution = await echo!.resolveExecution({ text: 'hi' });
    expect(execution.isError).toBeFalsy();
    if (execution.isError !== true) {
      expect(execution.description).toBe('Echoes back');
    }
  });

  it('forwards declared tool annotations onto the registered tool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    // The server declares `echo` read-only (plus an unrecognised `title`);
    // `noop` declares nothing. The wrapper must carry the narrowed hint
    // through — ask mode reads it to decide whether the server is reachable.
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'echo',
            description: 'Echoes back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            annotations: { readOnlyHint: true, destructiveHint: false, title: 'Echo' },
          },
          {
            name: 'noop',
            description: 'Does nothing',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));

    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');
    expect(echo?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });

    // No declarations means no key at all: the permission layer reads
    // `annotations === undefined` as "nothing was declared".
    const noop = tm.loopTools.find((t) => t.name === 'mcp__s__noop');
    expect(noop).toBeDefined();
    expect(Object.hasOwn(noop!, 'annotations')).toBe(false);
  });
});
