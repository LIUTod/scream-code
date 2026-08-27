import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '#/agent';
import { EventSubscriptionBus } from '#/agent/events';
import type { AgentServices } from '#/agent/index';
import { ExtensionRuntime } from '#/plugin';
import type { PluginManifest, PluginRecord } from '#/plugin';
import { HookEngine } from '#/session/hooks/engine';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures');

function pluginRecord(overrides: Partial<PluginRecord> & { id: string }): PluginRecord {
  return {
    root: FIXTURE_DIR,
    source: 'directory',
    enabled: true,
    state: 'installed',
    installedAt: new Date(0).toISOString(),
    skills: [],
    ...overrides,
  } as PluginRecord;
}

function makeAgent(hooks?: HookEngine, log?: Record<string, unknown>): Agent {
  const services = {
    tools: { registerUserTool: vi.fn(), unregisterUserTool: vi.fn() },
  } as unknown as AgentServices;
  return {
    hooks,
    eventBus: new EventSubscriptionBus(),
    services,
    log,
  } as unknown as Agent;
}

function manifestWithEntryPoint(entryPoint: string): PluginManifest {
  return { ...codeManifest, entryPoint };
}

const codeManifest: PluginManifest = {
  name: 'code-plugin',
  version: '1.0.0',
  description: 'A code plugin',
  skills: [],
  entryPoint: path.join(FIXTURE_DIR, 'plugin-entry.ts'),
  hooks: [
    { event: 'PreToolUse', command: 'echo pre' },
    { event: 'PostToolUse', command: 'echo post' },
  ],
};

describe('ExtensionRuntime', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__pluginActivated;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__pluginDeactivated;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__liveSubscriptionHits;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__leakedSubscriptionHits;
  });

  it('discovers only plugins that declare an entryPoint', () => {
    const runtime = new ExtensionRuntime();
    const plugins = [
      pluginRecord({ id: 'code', manifest: codeManifest }),
      pluginRecord({ id: 'skill-only', manifest: { name: 's', version: '1', skills: [] } }),
    ];

    const discovered = runtime.discover(plugins);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.pluginId).toBe('code');
  });

  it('loads an entry point module that exports activate', async () => {
    const runtime = new ExtensionRuntime();
    const module = await runtime.load(codeManifest.entryPoint!);
    expect(typeof module.activate).toBe('function');
  });

  it('activate injects manifest hooks and calls the module activate', async () => {
    const runtime = new ExtensionRuntime();
    const hooks = new HookEngine();
    const agent = makeAgent(hooks);
    const [extension] = runtime.discover([pluginRecord({ id: 'code', manifest: codeManifest })]);

    await runtime.activate(agent, extension!);

    // Manifest hooks were injected into the agent's HookEngine.
    expect(hooks.summary["PreToolUse"]).toBe(1);
    expect(hooks.summary["PostToolUse"]).toBe(1);
    // The module's activate ran with the plugin id and config exposure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__pluginActivated).toBe('code');
    expect(runtime.isActive('code')).toBe(true);
    expect(runtime.activePluginIds()).toEqual(['code']);
  });

  it('deactivate removes hooks and calls the module deactivate', async () => {
    const runtime = new ExtensionRuntime();
    const hooks = new HookEngine();
    const agent = makeAgent(hooks);
    const [extension] = runtime.discover([pluginRecord({ id: 'code', manifest: codeManifest })]);
    await runtime.activate(agent, extension!);

    await runtime.deactivate('code');

    expect(hooks.summary["PreToolUse"]).toBeUndefined();
    expect(hooks.summary["PostToolUse"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__pluginDeactivated).toBe(true);
    expect(runtime.isActive('code')).toBe(false);
  });

  it('rolls back injected hooks when the module activate throws', async () => {
    const runtime = new ExtensionRuntime();
    const hooks = new HookEngine();
    const agent = makeAgent(hooks);
    const throwing: PluginManifest = {
      ...codeManifest,
      entryPoint: path.join(FIXTURE_DIR, 'plugin-entry-throw.ts'),
    };
    const [extension] = runtime.discover([pluginRecord({ id: 'code', manifest: throwing })]);

    await expect(runtime.activate(agent, extension!)).rejects.toThrow('boom');
    // Hooks were injected first and rolled back on failure.
    expect(hooks.summary["PreToolUse"]).toBeUndefined();
    expect(runtime.isActive('code')).toBe(false);
  });

  it('activate without hooks leaves the HookEngine untouched', async () => {
    const runtime = new ExtensionRuntime();
    const hooks = new HookEngine();
    const agent = makeAgent(hooks);
    const manifest: PluginManifest = { ...codeManifest, hooks: undefined };
    const [extension] = runtime.discover([pluginRecord({ id: 'code', manifest })]);

    await runtime.activate(agent, extension!);

    expect(hooks.summary).toEqual({});
    expect(runtime.isActive('code')).toBe(true);
  });

  it('deactivate of an inactive plugin is a no-op', async () => {
    const runtime = new ExtensionRuntime();
    await expect(runtime.deactivate('never-activated')).resolves.toBeUndefined();
  });

  it('rejects activating the same plugin twice (no hook leak)', async () => {
    const runtime = new ExtensionRuntime();
    const hooks = new HookEngine();
    const agent = makeAgent(hooks);
    const [extension] = runtime.discover([pluginRecord({ id: 'code', manifest: codeManifest })]);
    await runtime.activate(agent, extension!);

    await expect(runtime.activate(agent, extension!)).rejects.toThrow('already active');
    // The first activation's hooks stay exactly as they were — no duplicate injection.
    expect(hooks.summary['PreToolUse']).toBe(1);
    expect(hooks.summary['PostToolUse']).toBe(1);
    expect(runtime.isActive('code')).toBe(true);
  });

  it('keeps a subscription made during a successful activation', async () => {
    const runtime = new ExtensionRuntime();
    const agent = makeAgent(new HookEngine());
    const manifest = manifestWithEntryPoint(path.join(FIXTURE_DIR, 'plugin-entry-subscribe.ts'));
    const [extension] = runtime.discover([pluginRecord({ id: 'sub', manifest })]);

    await runtime.activate(agent, extension!);
    agent.eventBus.dispatch({ type: 'turn.started' } as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__liveSubscriptionHits).toBe(1);
  });

  it('releases the plugin subscription on deactivate', async () => {
    const runtime = new ExtensionRuntime();
    const agent = makeAgent(new HookEngine());
    const manifest = manifestWithEntryPoint(path.join(FIXTURE_DIR, 'plugin-entry-subscribe.ts'));
    const [extension] = runtime.discover([pluginRecord({ id: 'sub', manifest })]);
    await runtime.activate(agent, extension!);
    agent.eventBus.dispatch({ type: 'turn.started' } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__liveSubscriptionHits).toBe(1);

    await runtime.deactivate('sub');
    agent.eventBus.dispatch({ type: 'turn.started' } as never);

    // No handler survives the deactivation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__liveSubscriptionHits).toBe(1);
  });

  it('releases event subscriptions when the module activate throws', async () => {
    const runtime = new ExtensionRuntime();
    const agent = makeAgent(new HookEngine());
    const manifest = manifestWithEntryPoint(
      path.join(FIXTURE_DIR, 'plugin-entry-subscribe-throw.ts'),
    );
    const [extension] = runtime.discover([pluginRecord({ id: 'leaky', manifest })]);

    await expect(runtime.activate(agent, extension!)).rejects.toThrow('subscribe-then-boom');
    expect(runtime.isActive('leaky')).toBe(false);

    agent.eventBus.dispatch({ type: 'turn.started' } as never);

    // The subscription the failed activation created is gone: the dead handler
    // never runs, and there is no handle left to leak.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__leakedSubscriptionHits).toBeUndefined();
  });

  it('isolates a throwing module deactivate and still cleans the activation', async () => {
    const runtime = new ExtensionRuntime();
    const warn = vi.fn();
    const hooks = new HookEngine();
    const agent = makeAgent(hooks, { warn });
    const manifest = manifestWithEntryPoint(
      path.join(FIXTURE_DIR, 'plugin-entry-deactivate-throw.ts'),
    );
    const [extension] = runtime.discover([pluginRecord({ id: 'bad', manifest })]);
    await runtime.activate(agent, extension!);

    await expect(runtime.deactivate('bad')).resolves.toBeUndefined();

    expect(hooks.summary['PreToolUse']).toBeUndefined();
    expect(runtime.isActive('bad')).toBe(false);
    expect(runtime.activePluginIds()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'plugin deactivate failed',
      expect.objectContaining({ pluginId: 'bad', error: 'deactivate boom' }),
    );
  });

  it('deactivateAll drops every activation and isolates a failing one', async () => {
    const runtime = new ExtensionRuntime();
    const warn = vi.fn();
    const hooks = new HookEngine();
    const agent = makeAgent(hooks, { warn });
    const good = pluginRecord({ id: 'good', manifest: codeManifest });
    const bad = pluginRecord({
      id: 'bad',
      manifest: manifestWithEntryPoint(
        path.join(FIXTURE_DIR, 'plugin-entry-deactivate-throw.ts'),
      ),
    });
    for (const extension of runtime.discover([good, bad])) {
      await runtime.activate(agent, extension);
    }
    expect(runtime.activePluginIds()).toEqual(['good', 'bad']);

    await expect(runtime.deactivateAll()).resolves.toBeUndefined();

    // The healthy plugin ran its own deactivate ...
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__pluginDeactivated).toBe(true);
    // ... and the broken one only produced a warning, yet both were unregistered.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'plugin deactivate failed',
      expect.objectContaining({ pluginId: 'bad' }),
    );
    expect(runtime.activePluginIds()).toEqual([]);
    expect(hooks.summary['PreToolUse']).toBeUndefined();
  });

  it('deactivateAll is a no-op when nothing is active', async () => {
    const runtime = new ExtensionRuntime();
    await expect(runtime.deactivateAll()).resolves.toBeUndefined();
  });
});

describe('ExtensionRuntime tool ownership', () => {
  it('stamps ownerPluginId onto tools a plugin registers without one', async () => {
    const runtime = new ExtensionRuntime();
    const registerUserTool = vi.fn();
    const services = {
      tools: { registerUserTool, unregisterUserTool: vi.fn() },
    } as unknown as AgentServices;
    const agent = {
      hooks: new HookEngine(),
      eventBus: new EventSubscriptionBus(),
      services,
      log: undefined,
    } as unknown as Agent;
    const manifest: PluginManifest = {
      ...codeManifest,
      entryPoint: path.join(FIXTURE_DIR, 'plugin-entry-registers-tool.ts'),
    };
    const [extension] = runtime.discover([pluginRecord({ id: 'owner-demo', manifest })]);

    await runtime.activate(agent, extension!);

    expect(registerUserTool).toHaveBeenCalledTimes(1);
    const input = registerUserTool.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input['name']).toBe('fixture_owned_tool');
    // The ownership stamp is what lets remove/disable/circuit-trip reclaim
    // exactly this plugin's tools later.
    expect(input['ownerPluginId']).toBe('owner-demo');
    // The in-process execute must survive the stamping untouched.
    expect(typeof input['execute']).toBe('function');
  });

  it('an explicit ownerPluginId from the plugin wins over the stamp', async () => {
    const runtime = new ExtensionRuntime();
    const registerUserTool = vi.fn();
    const services = {
      tools: { registerUserTool, unregisterUserTool: vi.fn() },
    } as unknown as AgentServices;
    const agent = {
      hooks: new HookEngine(),
      eventBus: new EventSubscriptionBus(),
      services,
      log: undefined,
    } as unknown as Agent;
    const manifest: PluginManifest = {
      ...codeManifest,
      entryPoint: path.join(FIXTURE_DIR, 'plugin-entry-explicit-owner.ts'),
    };
    const [extension] = runtime.discover([pluginRecord({ id: 'owner-demo', manifest })]);

    await runtime.activate(agent, extension!);

    expect(registerUserTool).toHaveBeenCalledTimes(1);
    const input = registerUserTool.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input['ownerPluginId']).toBe('declared-owner');
  });
});

describe('ExtensionRuntime event-handler circuit', () => {
  it('deactivates a plugin whose handler keeps throwing, at the trip threshold', async () => {
    const runtime = new ExtensionRuntime();
    const agent = makeAgent(new HookEngine());
    const manifest: PluginManifest = {
      ...codeManifest,
      entryPoint: path.join(FIXTURE_DIR, 'plugin-entry-subscribe-faulty.ts'),
    };
    const [extension] = runtime.discover([pluginRecord({ id: 'faulty', manifest })]);
    await runtime.activate(agent, extension!);

    const fire = () => {
      // The bus isolates handler throws; the tracked view counts them.
      agent.eventBus.dispatch({ type: 'turn.started', turnId: '1' } as never);
    };
    fire();
    fire();
    expect(runtime.isActive('faulty')).toBe(true);
    fire();

    // The deactivation is async but its map cleanup runs synchronously first.
    await new Promise((r) => setImmediate(r));
    expect(runtime.isActive('faulty')).toBe(false);
    // The 4th dispatch must not hit a handler that has been pulled.
    const hitsBefore = (globalThis as Record<string, unknown>)['__faultyHandlerHits'] as number;
    fire();
    expect((globalThis as Record<string, unknown>)['__faultyHandlerHits'] as number).toBe(
      hitsBefore,
    );
  });
});

describe('ExtensionRuntime deactivation tool reclaim', () => {
  it('event-fault deactivation reclaims the plugin-owned user tools too', async () => {
    const runtime = new ExtensionRuntime();
    const unregisterToolsByOwner = vi.fn();
    const services = {
      tools: {
        registerUserTool: vi.fn(),
        unregisterUserTool: vi.fn(),
        unregisterToolsByOwner,
      },
    } as unknown as AgentServices;
    const agent = {
      hooks: new HookEngine(),
      eventBus: new EventSubscriptionBus(),
      services,
      log: undefined,
    } as unknown as Agent;
    const manifest: PluginManifest = {
      ...codeManifest,
      entryPoint: path.join(FIXTURE_DIR, 'plugin-entry-subscribe-faulty.ts'),
    };
    const [extension] = runtime.discover([pluginRecord({ id: 'faulty', manifest })]);
    await runtime.activate(agent, extension!);

    const fire = () => {
      agent.eventBus.dispatch({ type: 'turn.started', turnId: '1' } as never);
    };
    fire();
    fire();
    fire();
    await new Promise((r) => setImmediate(r));

    // A deactivated plugin leaves no "dead limb" tools behind — whatever path
    // (explicit action, sync teardown, event-fault circuit) caused it.
    expect(unregisterToolsByOwner).toHaveBeenCalledWith('faulty');
  });
});
