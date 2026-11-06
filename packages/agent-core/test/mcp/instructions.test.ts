import { describe, expect, it, vi } from 'vitest';

import { collectMcpInstructions } from '../../src/mcp/instructions';

function fakeMcp(
  servers: Array<{ name: string; status: string; instructions?: string }>,
) {
  return {
    list: () => servers.map((server) => ({ name: server.name, status: server.status })),
    resolved: (name: string) => {
      const server = servers.find((entry) => entry.name === name);
      if (server === undefined) return undefined;
      return {
        client: { getInstructions: () => server.instructions },
        tools: [],
        enabledNames: [],
      };
    },
  } as never;
}

describe('collectMcpInstructions', () => {
  it('lists instructions from connected servers only', () => {
    const mcp = fakeMcp([
      { name: 'docs', status: 'connected', instructions: 'Prefer /docs paths.' },
      { name: 'broken', status: 'error', instructions: 'should not appear' },
      { name: 'quiet', status: 'connected' },
    ]);

    expect(collectMcpInstructions(mcp)).toBe('- **docs**: Prefer /docs paths.');
  });

  it('indents multi-line instructions so the bullet stays one block', () => {
    const mcp = fakeMcp([
      { name: 'docs', status: 'connected', instructions: 'line one\nline two' },
    ]);

    expect(collectMcpInstructions(mcp)).toBe('- **docs**: line one\n  line two');
  });

  it('returns an empty string when nothing is connected or no MCP exists', () => {
    expect(collectMcpInstructions(undefined)).toBe('');
    expect(collectMcpInstructions(fakeMcp([]))).toBe('');
  });
});
