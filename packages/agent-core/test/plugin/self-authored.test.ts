import { mkdtemp, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { EventSubscriptionBus } from '../../src/agent/events';
import type { AgentServices } from '../../src/agent/index';
import type { UserToolRegistration } from '../../src/agent/tool/types';
import type { ExecutableToolContext } from '../../src/loop';
import { PluginManager } from '../../src/plugin/manager';
import { ExtensionRuntime } from '../../src/plugin/runtime/extension';
import { ManagePluginTool } from '../../src/tools/builtin/plugin/manage-plugin';
import type { ManagePluginInput } from '../../src/tools/builtin/plugin/manage-plugin';
import type { ToolServices } from '../../src/tools/support/services';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;
const toolContext: ExecutableToolContext = {
  turnId: '1',
  toolCallId: 'call_self_authored',
  signal,
};
let callCounter = 0;

interface Harness {
  readonly tool: ManagePluginTool;
  readonly manager: PluginManager;
  readonly runtime: ExtensionRuntime;
  readonly registered: Map<string, UserToolRegistration>;
}

/**
 * A tool registry with the two members a plugin activation touches, kept as a
 * plain Map so a test can execute exactly what the plugin registered.
 */
function makeToolRegistry() {
  const registered = new Map<string, UserToolRegistration>();
  const tools = {
    registerUserTool(input: UserToolRegistration): void {
      registered.set(input.name, input);
    },
    unregisterUserTool(name: string): void {
      registered.delete(name);
    },
    unregisterToolsByOwner(ownerPluginId: string): number {
      let removed = 0;
      for (const [name, tool] of registered) {
        if (tool.ownerPluginId !== ownerPluginId) continue;
        registered.delete(name);
        removed += 1;
      }
      return removed;
    },
  };
  return { registered, tools };
}

/**
 * A capability sync that behaves like the host: anything not `enabled && ok`
 * is unwound. The default stub returns success without touching the runtime,
 * which is why an activation that the real host tears down can still look fine.
 */
function makeSyncLikeTheHost(runtime: ExtensionRuntime, manager: PluginManager) {
  return async (ids: readonly string[]) => {
    for (const id of ids) {
      const record = manager.get(id);
      const live = record !== undefined && record.enabled && record.state === 'ok';
      if (!live && runtime.isActive(id)) await runtime.deactivate(id);
    }
    return { ok: true, sessions: 1, applied: [], failed: [] };
  };
}

interface HarnessOptions {
  /** Replace the capability sync; the default is a no-op success stub. */
  readonly realisticSync?: boolean;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  // macOS reports `/var`, a symlink to `/private/var`; the manager stores
  // resolved paths, so the fixture roots are realpath'd up front.
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'self-authored-home-')));
  const manager = new PluginManager({ screamHomeDir: home });
  await manager.load();
  const runtime = new ExtensionRuntime();
  const { registered, tools } = makeToolRegistry();
  const pluginSync = options.realisticSync === true
    ? makeSyncLikeTheHost(runtime, manager)
    : async () => ({ ok: true, sessions: 1, applied: [], failed: [] });
  const toolServices = {
    plugins: manager,
    extensionRuntime: runtime,
    pluginSync,
  } as unknown as ToolServices;
  const agent = {
    type: 'main',
    screamHomeDir: home,
    toolServices,
    config: { cwd: home },
    services: { tools } as unknown as AgentServices,
    eventBus: new EventSubscriptionBus(),
    log: undefined,
  } as unknown as Agent;
  return { tool: new ManagePluginTool(agent), manager, runtime, registered };
}

/** Write a plugin directory in place: a manifest plus an optional entry file. */
async function writePlugin(input: {
  manifest: Record<string, unknown>;
  entry?: string;
}): Promise<{ root: string; entryPath: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'self-authored-')));
  await writeFile(path.join(root, 'scream.plugin.json'), JSON.stringify(input.manifest), 'utf8');
  const entryPath = path.join(root, 'index.mjs');
  if (input.entry !== undefined) await writeFile(entryPath, input.entry, 'utf8');
  return { root, entryPath };
}

/**
 * A plugin entry point that registers one tool. `marker` is baked into the
 * module source, so rewriting the file with a new marker makes it observable
 * whether the runtime imported the edited code or a stale cached module.
 */
function entrySource(marker: string): string {
  return `
export async function activate(context) {
  context.services.tools.registerUserTool({
    name: 'text_stats',
    description: 'Count lines and characters in a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async (args) => ({ output: '${marker}:' + String(args['path']) }),
  });
}

export async function deactivate() {}
`;
}

async function run(harness: Harness, args: ManagePluginInput) {
  return executeTool(harness.tool, {
    args,
    turnId: '1',
    toolCallId: `call_${++callCounter}`,
    signal,
  });
}

/** Every action answers with a JSON string; parse it once for readability. */
async function json(harness: Harness, args: ManagePluginInput): Promise<any> {
  const result = await run(harness, args);
  return JSON.parse(result.output as string);
}

describe('self-authored plugins', () => {
  it('rejects a manifest whose entryPoint file does not exist', async () => {
    const harness = await makeHarness();
    const { root } = await writePlugin({ manifest: { name: 'missing-entry', entryPoint: './index.mjs' } });

    const result = await run(harness, { action: 'register_generated', source: root });
    const payload = JSON.parse(result.output as string);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('entry_file_missing');
    expect(payload.error.next).toContain('entry file');
    expect(harness.manager.get('missing-entry')).toBeUndefined();
  });

  it('refuses a manifest whose entryPoint escapes the plugin directory', async () => {
    const harness = await makeHarness();
    const { root } = await writePlugin({
      manifest: { name: 'escaping', entryPoint: './../outside.mjs' },
    });
    // The target exists — the manifest layer still refuses it for living
    // outside the plugin root. Registering it as data-only would leave the
    // caller believing it had registered code, so this is an error.
    await writeFile(path.resolve(root, '..', 'outside.mjs'), 'export function activate() {}\n', 'utf8');

    const result = await run(harness, { action: 'register_generated', source: root });
    const payload = JSON.parse(result.output as string);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('entry_point_rejected');
    expect(payload.error.message).toContain('outside the plugin');
    expect(harness.manager.get('escaping')).toBeUndefined();
  });

  it('registers, activates, and unwinds a plugin written in this session', async () => {
    const harness = await makeHarness();
    const { root } = await writePlugin({
      manifest: { name: 'text-stats', entryPoint: './index.mjs' },
      entry: entrySource('v1'),
    });

    const registered = await json(harness, { action: 'register_generated', source: root });
    expect(registered).toMatchObject({ registered: true, hasCodeEntryPoint: true });
    expect(registered.note).toContain('separate activate');
    // Registration never runs the entry point.
    expect(harness.registered.size).toBe(0);
    expect(harness.runtime.isActive('text-stats')).toBe(false);

    const activated = await json(harness, { action: 'activate', id: 'text-stats' });
    expect(activated).toMatchObject({ active: true, id: 'text-stats' });
    expect(harness.runtime.isActive('text-stats')).toBe(true);

    const tool = harness.registered.get('text_stats');
    expect(tool).toBeDefined();
    expect(tool!.ownerPluginId).toBe('text-stats');
    await expect(tool!.execute!({ path: 'notes.txt' }, toolContext)).resolves.toEqual({
      output: 'v1:notes.txt',
    });

    await json(harness, { action: 'deactivate', id: 'text-stats' });
    expect(harness.runtime.isActive('text-stats')).toBe(false);
    expect(harness.registered.has('text_stats')).toBe(false);
  });

  it('re-imports edited code on deactivate + activate', async () => {
    const harness = await makeHarness();
    const { root, entryPath } = await writePlugin({
      manifest: { name: 'text-stats', entryPoint: './index.mjs' },
      entry: entrySource('v1'),
    });
    await json(harness, { action: 'register_generated', source: root });
    await json(harness, { action: 'activate', id: 'text-stats' });
    expect(
      await harness.registered.get('text_stats')!.execute!({ path: 'a' }, toolContext),
    ).toEqual({ output: 'v1:a' });

    // Edit the plugin's own code, then reload it the way /extension reload does.
    await writeFile(entryPath, entrySource('v2'), 'utf8');
    await json(harness, { action: 'deactivate', id: 'text-stats' });
    await json(harness, { action: 'activate', id: 'text-stats' });

    expect(
      await harness.registered.get('text_stats')!.execute!({ path: 'a' }, toolContext),
    ).toEqual({ output: 'v2:a' });
  });

  it('re-imports a fixed entry point after a failed activation', async () => {
    const harness = await makeHarness();
    const { root, entryPath } = await writePlugin({
      manifest: { name: 'text-stats', entryPoint: './index.mjs' },
      entry: 'export async function activate() { throw new Error("boom v1"); }\n',
    });
    await json(harness, { action: 'register_generated', source: root });

    const first = await json(harness, { action: 'activate', id: 'text-stats' });
    expect(first.error.message).toContain('boom v1');
    expect(harness.runtime.isActive('text-stats')).toBe(false);

    // Fix the plugin and reload exactly the way `/extension reload` does. The
    // failed activation left no activation record, so deactivate is a no-op:
    // the fixed code has to be re-imported by the activate below.
    await writeFile(entryPath, entrySource('v2'), 'utf8');
    await json(harness, { action: 'deactivate', id: 'text-stats' });
    const second = await json(harness, { action: 'activate', id: 'text-stats' });

    expect(second).toMatchObject({ active: true });
    await expect(
      harness.registered.get('text_stats')!.execute!({ path: 'a' }, toolContext),
    ).resolves.toEqual({ output: 'v2:a' });
  });

  it('reports a missing entry file when the plugin root is behind a symlink', async () => {
    const harness = await makeHarness();
    // Deliberately not realpath'd: on macOS the temp root is `/var/...`, whose
    // canonical form is `/private/var/...`. The containment check used to
    // compare the unresolved target against the canonical root, which dropped
    // the entryPoint instead of reporting the missing file.
    const root = await mkdtemp(path.join(tmpdir(), 'self-authored-unresolved-'));
    await writeFile(
      path.join(root, 'scream.plugin.json'),
      JSON.stringify({ name: 'symlinked-root', entryPoint: './index.mjs' }),
      'utf8',
    );

    const result = await run(harness, { action: 'register_generated', source: root });
    const payload = JSON.parse(result.output as string);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('entry_file_missing');
    expect(harness.manager.get('symlinked-root')).toBeUndefined();
  });

  it('keeps a fixed plugin live after a failed activation, even when the sync runs', async () => {
    // The host sync unwinds anything whose record is not `enabled && ok`. A
    // failed activation used to leave state at 'error' forever, so the fix-and-
    // retry loop activated the plugin and then had it torn down milliseconds
    // later while reporting active: true.
    const harness = await makeHarness({ realisticSync: true });
    const { root, entryPath } = await writePlugin({
      manifest: { name: 'text-stats', entryPoint: './index.mjs' },
      entry: 'export async function activate() { throw new Error("boom v1"); }\n',
    });
    await json(harness, { action: 'register_generated', source: root });
    await json(harness, { action: 'activate', id: 'text-stats' });
    expect(harness.manager.get('text-stats')?.state).toBe('error');

    await writeFile(entryPath, entrySource('fixed'), 'utf8');
    const second = await json(harness, { action: 'activate', id: 'text-stats' });

    expect(second).toMatchObject({ active: true });
    expect(harness.runtime.isActive('text-stats')).toBe(true);
    expect(harness.registered.has('text_stats')).toBe(true);
  });

  it('refuses to activate a disabled plugin instead of reporting a doomed success', async () => {
    const harness = await makeHarness({ realisticSync: true });
    const { root } = await writePlugin({
      manifest: { name: 'text-stats', entryPoint: './index.mjs' },
      entry: entrySource('v1'),
    });
    await json(harness, { action: 'register_generated', source: root });
    await harness.manager.setEnabled('text-stats', false);

    const outcome = await json(harness, { action: 'activate', id: 'text-stats' });

    expect(outcome.error.code).toBe('plugin_disabled');
    expect(harness.runtime.isActive('text-stats')).toBe(false);
  });

  it('re-imports edited code through reload_code', async () => {
    const harness = await makeHarness();
    const { root, entryPath } = await writePlugin({
      manifest: { name: 'text-stats', entryPoint: './index.mjs' },
      entry: entrySource('v1'),
    });
    await json(harness, { action: 'register_generated', source: root });
    await json(harness, { action: 'activate', id: 'text-stats' });
    await writeFile(entryPath, entrySource('v2'), 'utf8');

    const outcome = await json(harness, { action: 'reload_code', id: 'text-stats' });

    expect(outcome).toMatchObject({ action: 'reload_code', reloaded: true });
    await expect(
      harness.registered.get('text_stats')!.execute!({ path: 'a' }, toolContext),
    ).resolves.toEqual({ output: 'v2:a' });
  });

  it('refuses to activate when the entry point was swapped for a symlink out of the directory', async () => {
    const harness = await makeHarness();
    const { root, entryPath } = await writePlugin({
      manifest: { name: 'text-stats', entryPoint: './index.mjs' },
      entry: entrySource('v1'),
    });
    await json(harness, { action: 'register_generated', source: root });
    // Parse-time confinement cannot see this: the path was fine when the
    // manifest was read, and Node resolves the symlink again at import time.
    const outside = await mkdtemp(path.join(tmpdir(), 'self-authored-outside-'));
    const outsideEntry = path.join(outside, 'evil.mjs');
    await writeFile(outsideEntry, entrySource('evil'), 'utf8');
    await unlink(entryPath);
    await symlink(outsideEntry, entryPath);

    const outcome = await json(harness, { action: 'activate', id: 'text-stats' });

    expect(outcome.error.message).toContain('resolves outside the plugin directory');
    expect(harness.runtime.isActive('text-stats')).toBe(false);
  });

  it('classifies a non-string entryPoint as a rejected entry, not a path problem', async () => {
    const harness = await makeHarness();
    const { root } = await writePlugin({
      manifest: { name: 'bad-entry', entryPoint: 42 },
      entry: entrySource('v1'),
    });

    const outcome = await json(harness, { action: 'register_generated', source: root });

    expect(outcome.error.code).toBe('entry_point_rejected');
    expect(outcome.error.message).toContain('must be a string');
  });

  it('warns instead of silently dropping code when an installed manifest has a rejected entryPoint', async () => {
    const harness = await makeHarness();
    // Install is a third-party path: portable manifests may use a bare relative
    // path, so the plugin still installs — but the caller must learn that its
    // code entry was rejected, otherwise it believes it installed a code plugin.
    const { root } = await writePlugin({
      manifest: { name: 'portable', entryPoint: 'index.mjs' },
      entry: entrySource('v1'),
    });

    const payload = await json(harness, { action: 'install', source: root });

    expect(payload.hasCodeEntryPoint).toBe(false);
    expect(String(payload.warn)).toContain('entryPoint');
  });
});
