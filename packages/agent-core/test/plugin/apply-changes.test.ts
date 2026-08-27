import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ScreamCore } from '../../src/rpc/core-impl';

/**
 * Hot-apply (`applyPluginChangesToSessions`) is host-owned: the plugin table
 * lives on the core and the session map is its only route into live agents.
 * These tests inject fake sessions into the core's map and assert the diff
 * semantics — especially the rule that user-configured MCP servers are never
 * touched and that `install` alone never starts a plugin MCP process.
 */

interface FakeSession {
  readonly id: string;
  readonly entries: Map<string, { name: string }>;
  readonly mcp: {
    readonly list: () => readonly { name: string }[];
    readonly addServer: ReturnType<typeof vi.fn>;
    readonly removeServer: ReturnType<typeof vi.fn>;
  };
  readonly ejectPlugin: ReturnType<typeof vi.fn>;
  readonly injectSkillRoots: ReturnType<typeof vi.fn>;
  readonly agents: Map<string, { tools: { unregisterToolsByOwner: ReturnType<typeof vi.fn> } }>;
}

function makeFakeSession(id: string, seedServers: readonly string[] = []): FakeSession {
  const entries = new Map(seedServers.map((name) => [name, { name }]));
  return {
    id,
    entries,
    mcp: {
      list: () => Array.from(entries.values()),
      addServer: vi.fn(async (name: string) => {
        entries.set(name, { name });
      }),
      removeServer: vi.fn(async (name: string) => {
        entries.delete(name);
      }),
    },
    ejectPlugin: vi.fn(),
    injectSkillRoots: vi.fn(async () => {}),
    agents: new Map([['main', { tools: { unregisterToolsByOwner: vi.fn(() => 0) } }]]),
  };
}

function injectSession(core: ScreamCore, session: FakeSession): void {
  const sessions = (core as unknown as { sessions: Map<string, unknown> }).sessions;
  sessions.set(session.id, session as unknown);
}

async function makeCore(): Promise<{ core: ScreamCore; home: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'scream-home-'));
  const core = new ScreamCore(async () => ({}) as never, { homeDir: home });
  await new Promise((r) => setImmediate(r));
  return { core, home };
}

async function makePluginRoot(
  name: string,
  options: { mcp?: boolean; skills?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  const manifest: Record<string, unknown> = { name, version: '1.0.0' };
  if (options.mcp === true) manifest['mcpServers'] = { finance: { command: 'finance-mcp' } };
  if (options.skills === true) {
    // Skill dirs only survive manifest resolution when they actually contain
    // a SKILL.md, so seed one.
    manifest['skills'] = ['./skills/'];
    await mkdir(path.join(root, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(root, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: A fixture skill\n---\nbody',
      'utf8',
    );
  }
  await writeFile(path.join(root, 'scream.plugin.json'), JSON.stringify(manifest), 'utf8');
  return root;
}

describe('ScreamCore.applyPluginChangesToSessions', () => {
  it('install hot-applies skills but never starts plugin MCP servers', async () => {
    const { core } = await makeCore();
    const session = makeFakeSession('s1');
    injectSession(core, session);

    await core.installPlugin({ source: await makePluginRoot('demo', { mcp: true, skills: true }) });

    expect(session.mcp.addServer).not.toHaveBeenCalled();
    expect(session.entries.has('plugin-demo:finance')).toBe(false);
    expect(session.ejectPlugin).toHaveBeenCalledWith('demo');
    expect(session.injectSkillRoots).toHaveBeenCalledTimes(1);
    const roots = session.injectSkillRoots.mock.calls[0]?.[0] as readonly {
      plugin?: { id: string };
    }[];
    expect(roots[0]?.plugin?.id).toBe('demo');
  });

  it('enable adds the plugin MCP server; disable removes it and skips add', async () => {
    const { core } = await makeCore();
    const session = makeFakeSession('s1');
    injectSession(core, session);
    await core.installPlugin({ source: await makePluginRoot('demo', { mcp: true }) });

    // Disable, then enable: the enable pass must start the server.
    await core.setPluginEnabled({ id: 'demo', enabled: false });
    await core.setPluginEnabled({ id: 'demo', enabled: true });

    expect(session.mcp.addServer).toHaveBeenCalledWith(
      'plugin-demo:finance',
      expect.objectContaining({ command: 'finance-mcp' }),
    );
    expect(session.entries.has('plugin-demo:finance')).toBe(true);

    await core.setPluginEnabled({ id: 'demo', enabled: false });
    expect(session.mcp.removeServer).toHaveBeenCalledWith('plugin-demo:finance');
    expect(session.entries.has('plugin-demo:finance')).toBe(false);
  });

  it('never touches user-configured MCP servers, and clears stale plugin ones on rescan', async () => {
    const { core } = await makeCore();
    const session = makeFakeSession('s1', ['my-finance', 'plugin-gone:old']);
    injectSession(core, session);

    await core.installPlugin({ source: await makePluginRoot('demo', { mcp: true }) });
    await core.setPluginEnabled({ id: 'demo', enabled: false });
    await core.reloadPlugins({});

    const allRemovals = [
      ...session.mcp.removeServer.mock.calls.map((call) => String(call[0])),
      ...session.mcp.addServer.mock.calls.map((call) => String(call[0])),
    ];
    expect(allRemovals).not.toContain('my-finance');
    expect(session.mcp.removeServer).toHaveBeenCalledWith('plugin-gone:old');
    // The user server is still there, untouched.
    expect(session.entries.has('my-finance')).toBe(true);
  });

  it('removePlugin tears down code ownership, tools, MCP, and skills in one pass', async () => {
    const { core } = await makeCore();
    const session = makeFakeSession('s1', ['plugin-demo:finance']);
    injectSession(core, session);
    // Install without a live session first so the seeded name looks connected.
    await core.installPlugin({ source: await makePluginRoot('demo', { mcp: true, skills: true }) });
    const owner = session.agents.get('main')!;
    owner.tools.unregisterToolsByOwner.mockImplementation(() => 1);

    await core.removePlugin({ id: 'demo' });

    expect(owner.tools.unregisterToolsByOwner).toHaveBeenCalledWith('demo');
    expect(session.mcp.removeServer).toHaveBeenCalledWith('plugin-demo:finance');
    expect(session.ejectPlugin).toHaveBeenCalledWith('demo');
  });

  it('a failing sub-action is reported, not thrown', async () => {
    const { core } = await makeCore();
    const session = makeFakeSession('s1');
    session.mcp.addServer.mockRejectedValue(new Error('spawn EACCES'));
    injectSession(core, session);
    await core.installPlugin({ source: await makePluginRoot('demo', { mcp: true }) });

    const report = await core.applyPluginChangesToSessions(['demo']);

    expect(report.ok).toBe(false);
    expect(report.failed.some((f) => f.step === 'mcp.add' && /EACCES/.test(f.message))).toBe(true);
    expect(report.sessions).toBe(1);
  });

  it('deactivatePlugin drops plugin-owned tools from live agents', async () => {
    const { core } = await makeCore();
    const session = makeFakeSession('s1');
    injectSession(core, session);
    const owner = session.agents.get('main')!;
    owner.tools.unregisterToolsByOwner.mockImplementation(() => 2);

    await core.deactivatePlugin({ pluginId: 'runner' });

    expect(owner.tools.unregisterToolsByOwner).toHaveBeenCalledWith('runner');
  });
});

describe('ScreamCore.applyPluginChangesToSessions failure modes', () => {
  it('an unreadable desired table freezes MCP edits instead of tearing them down', async () => {
    const { core } = await makeCore();
    const session = makeFakeSession('s1', ['plugin-demo:finance']);
    injectSession(core, session);
    await core.installPlugin({ source: await makePluginRoot('demo', { mcp: true }) });
    session.mcp.addServer.mockClear();
    session.mcp.removeServer.mockClear();
    session.ejectPlugin.mockClear();

    // Simulate a broken table read: "could not read" must never be read as
    // "remove everything" — that inversion would tear healthy plugins down.
    const plugins = (
      core as unknown as { plugins: { enabledMcpServers: () => unknown } }
    ).plugins;
    plugins.enabledMcpServers = () => {
      throw new Error('table corrupt');
    };

    const report = await core.applyPluginChangesToSessions(['demo']);

    expect(session.mcp.removeServer).not.toHaveBeenCalled();
    expect(session.mcp.addServer).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
    expect(report.failed.some((f) => f.step === 'mcp.add')).toBe(true);
    // Only MCP is frozen; skill reconciliation still runs.
    expect(session.ejectPlugin).toHaveBeenCalledWith('demo');
  });
});
