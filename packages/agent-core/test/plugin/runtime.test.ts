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

function makeAgent(hooks?: HookEngine): Agent {
  const services = {
    tools: { registerUserTool: vi.fn(), unregisterUserTool: vi.fn() },
  } as unknown as AgentServices;
  return {
    hooks,
    eventBus: new EventSubscriptionBus(),
    services,
  } as unknown as Agent;
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
});
