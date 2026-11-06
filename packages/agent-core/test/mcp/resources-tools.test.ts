import { describe, expect, it, vi } from 'vitest';

import {
  ListMcpResourcesTool,
  ListMcpResourceTemplatesTool,
  ReadMcpResourceTool,
} from '../../src/tools/builtin/mcp/resources';
import type { MCPClient } from '../../src/mcp/types';

function fakeMcp(clients: Record<string, Partial<MCPClient>>) {
  const resolved = (name: string) => {
    const client = clients[name];
    return client === undefined ? undefined : { client: client as MCPClient, tools: [], enabledNames: [] };
  };
  return {
    list: () => Object.keys(clients).map((name) => ({ name, status: 'connected' as const })),
    resolved,
  } as never;
}

const text = (execution: {
  execute: () => Promise<{ output: string; isError?: boolean }>;
}): Promise<{ output: string; isError?: boolean }> => execution.execute();

describe('MCP resource tools', () => {
  it('lists resources from every connected server and includes instructions', async () => {
    const mcp = fakeMcp({
      docs: {
        getInstructions: () => 'Prefer /docs paths.',
        listResources: vi.fn(async () => [
          { uri: 'docs://a', name: 'A', mimeType: 'text/plain' },
        ]),
      },
      other: { listResources: vi.fn(async () => [{ uri: 'mem://b' }]) },
    });
    const tool = new ListMcpResourcesTool({ mcp });
    const execution = tool.resolveExecution({});

    const result = await text(execution as never);
    const payload = JSON.parse(result.output) as {
      resources: Array<{ server: string; uri: string }>;
      instructions: Record<string, string>;
    };

    expect(payload.resources.map((resource) => `${resource.server}:${resource.uri}`)).toEqual([
      'docs:docs://a',
      'other:mem://b',
    ]);
    expect(payload.instructions).toEqual({ docs: 'Prefer /docs paths.' });
  });

  it('narrows to one server and reports an unknown name', async () => {
    const mcp = fakeMcp({ docs: { listResources: vi.fn(async () => [{ uri: 'docs://a' }]) } });
    const tool = new ListMcpResourcesTool({ mcp });

    const known = await text(tool.resolveExecution({ server: 'docs' }) as never);
    expect(JSON.parse(known.output).resources).toEqual([{ server: 'docs', uri: 'docs://a' }]);

    const unknown = await text(tool.resolveExecution({ server: 'nope' }) as never);
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('No MCP server named "nope"');
  });

  it('reads a resource by server + uri and flags missing text', async () => {
    const mcp = fakeMcp({
      docs: {
        readResource: vi.fn(async (uri: string) => ({ uri, text: 'hello' })),
      },
      bin: { readResource: vi.fn(async (uri: string) => ({ uri, mimeType: 'image/png' })) },
    });

    const textTool = new ReadMcpResourceTool({ mcp });
    expect((await text(textTool.resolveExecution({ server: 'docs', uri: 'docs://a' }) as never)).output).toBe('hello');

    const binary = await text(textTool.resolveExecution({ server: 'bin', uri: 'bin://img' }) as never);
    expect(JSON.parse(binary.output).note).toContain('no text content');
  });

  it('lists resource templates', async () => {
    const mcp = fakeMcp({
      docs: {
        listResourceTemplates: vi.fn(async () => [{ uriTemplate: 'docs://{path}' }]),
      },
    });
    const tool = new ListMcpResourceTemplatesTool({ mcp });

    const result = await text(tool.resolveExecution({}) as never);
    expect(JSON.parse(result.output).resourceTemplates).toEqual([
      { server: 'docs', uriTemplate: 'docs://{path}' },
    ]);
  });

  it('is read-only and fails loudly when MCP is not configured', async () => {
    const tool = new ReadMcpResourceTool({});
    expect(tool.annotations.readOnlyHint).toBe(true);

    const result = await text(tool.resolveExecution({ server: 'docs', uri: 'x' }) as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP is not configured');
  });

  it('isolates a failing server so the others still list', async () => {
    const mcp = fakeMcp({
      good: { listResources: vi.fn(async () => [{ uri: 'good://a' }]) },
      broken: {
        listResources: vi.fn(async () => {
          throw new Error('connection reset');
        }),
      },
    });
    const result = await text(new ListMcpResourcesTool({ mcp }).resolveExecution({}) as never);
    const payload = JSON.parse(result.output) as {
      resources: Array<{ server: string }>;
      failures: Array<{ server: string; error: string }>;
    };

    expect(result.isError).toBe(false);
    expect(payload.resources).toEqual([{ server: 'good', uri: 'good://a' }]);
    expect(payload.failures).toEqual([{ server: 'broken', error: 'connection reset' }]);
  });
});
