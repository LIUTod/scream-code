import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from '../../src/config/schema';
import {
  MCP_CAPABILITY_PATTERNS,
  resolveServerCapabilities,
} from '../../src/mcp/capabilities';

function stdio(overrides: Record<string, unknown> = {}): McpServerConfig {
  return { transport: 'stdio', command: 'npx', args: [], ...overrides } as McpServerConfig;
}

describe('resolveServerCapabilities', () => {
  it('prefers explicit declaration over fingerprints', () => {
    expect(resolveServerCapabilities('my-svc', stdio({ capabilities: ['web'] }))).toEqual(['web']);
    // Explicit wins even when a fingerprint would also match.
    expect(resolveServerCapabilities('chrome-devtools', stdio({ capabilities: ['custom'] }))).toEqual(['custom']);
  });

  it('treats an explicit empty array as opt-out of fingerprinting', () => {
    expect(resolveServerCapabilities('chrome-devtools', stdio({ capabilities: [] }))).toEqual([]);
  });

  it('fingerprints the default chrome-devtools server name', () => {
    expect(resolveServerCapabilities('chrome-devtools', stdio())).toEqual(['browser']);
  });

  it('fingerprints renamed servers via the launch package in args', () => {
    const cfg = stdio({ args: ['-y', 'chrome-devtools-mcp@latest', '--headless'] });
    expect(resolveServerCapabilities('browser-tools', cfg)).toEqual(['browser']);
  });

  it('fingerprints scream-life as memory via name or clone path in args', () => {
    expect(resolveServerCapabilities('scream-life', stdio({ command: 'bun' }))).toEqual(['memory']);
    expect(
      resolveServerCapabilities('life', stdio({ args: ['/home/u/.scream-code/mcp/scream-life/Core/mcp-server.ts'] })),
    ).toEqual(['memory']);
  });

  it('normalizes declared entries: trim + lowercase + dedupe, empties dropped', () => {
    expect(
      resolveServerCapabilities('x', stdio({ capabilities: [' Browser ', 'browser', '', 'WEB'] })),
    ).toEqual(['browser', 'web']);
  });

  it('returns [] for unknown servers', () => {
    expect(resolveServerCapabilities('random-mcp', stdio({ command: 'tool' }))).toEqual([]);
  });

  // The addMcpServer RPC path (session/rpc.ts) forwards unvalidated client
  // payloads straight into the connection manager, so dirty input must
  // degrade to fingerprinting — never throw.
  it('degrades dirty capabilities values to fingerprints without throwing', () => {
    expect(resolveServerCapabilities('chrome-devtools', stdio({ capabilities: 'browser' }))).toEqual(['browser']);
    expect(resolveServerCapabilities('chrome-devtools', stdio({ capabilities: { a: 1 } }))).toEqual(['browser']);
    expect(resolveServerCapabilities('unknown', stdio({ capabilities: 42 }))).toEqual([]);
  });

  it('survives non-string args arrays', () => {
    const cfg = { transport: 'stdio', command: 'npx', args: [42, null] } as unknown as McpServerConfig;
    expect(resolveServerCapabilities('renamed', cfg)).toEqual([]);
  });

  it('exposes the fingerprint table (browser, memory)', () => {
    expect(MCP_CAPABILITY_PATTERNS.map((p) => p.capability)).toEqual(['browser', 'memory']);
  });
});
