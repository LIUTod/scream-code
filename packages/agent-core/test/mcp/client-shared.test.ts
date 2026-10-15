/**
 * MCP tool-definition conversion: the server's native `annotations` block must
 * survive discovery so the permission layer can consume `destructiveHint`
 * (conservatively: it can force an approval, never grant one).
 */

import { describe, expect, it } from 'vitest';

import { toMcpToolDefinition } from '../../src/mcp/client-shared';

describe('toMcpToolDefinition', () => {
  it('passes the server-declared annotations through', () => {
    const definition = toMcpToolDefinition({
      name: 'delete_everything',
      description: 'Deletes everything',
      inputSchema: { type: 'object', properties: {} },
      annotations: { destructiveHint: true, title: 'Delete everything' },
    });

    expect(definition.annotations).toEqual({
      destructiveHint: true,
      title: 'Delete everything',
    });
  });

  it('omits the field entirely when the server declares no annotations', () => {
    const definition = toMcpToolDefinition({
      name: 'ping',
      description: 'Ping',
      inputSchema: { type: 'object', properties: {} },
    });

    expect('annotations' in definition).toBe(false);
  });
});
