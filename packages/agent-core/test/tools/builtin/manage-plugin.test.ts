import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { EventSubscriptionBus } from '../../../src/agent/events';
import type { AgentServices } from '../../../src/agent/index';
import { ExtensionRuntime } from '../../../src/plugin/runtime/extension';
import { PluginManager } from '../../../src/plugin/manager';
import { ManagePluginTool } from '../../../src/tools/builtin/plugin/manage-plugin';
import type { ManagePluginInput } from '../../../src/tools/builtin/plugin/manage-plugin';
import type { ToolServices } from '../../../src/tools/support/services';
import { executeTool } from '../fixtures/execute-tool';

const signal = new AbortController().signal;
let callCounter = 0;

/** Everything a ManagePlugin call needs from the host agent. */
interface Harness {
  readonly tool: ManagePluginTool;
  readonly manager: PluginManager;
  readonly runtime: ExtensionRuntime;
  readonly home: string;
  readonly agent: Agent;
  /** Hot-apply calls recorded by the harness pluginSync, in order. */
  readonly syncCalls: Array<{ ids: readonly string[] | undefined; skipMcpAdd: boolean }>;
}

async function makeHarness(): Promise<Harness> {
  // macOS reports `/var`, which is a symlink to `/private/var`; the manager
  // stores resolved paths, so the harness compares against the real one.
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'manage-plugin-home-')));
  const manager = new PluginManager({ screamHomeDir: home });
  await manager.load();
  const runtime = new ExtensionRuntime();
  const syncCalls: Harness['syncCalls'] = [];
  const toolServices = {
    plugins: manager,
    extensionRuntime: runtime,
    pluginSync: async (ids?: readonly string[], options?: { skipMcpAdd?: boolean }) => {
      syncCalls.push({ ids, skipMcpAdd: options?.skipMcpAdd === true });
      return {
        ok: true,
        sessions: 1,
        applied: [
          { kind: 'skills.inject' as const, name: ids?.[0] ?? 'all', session: 's1' },
        ],
        failed: [],
      };
    },
  } as ToolServices;
  const agent = {
    type: 'main',
    screamHomeDir: home,
    toolServices,
    config: { cwd: home },
    services: { tools: { registerUserTool: vi.fn(), unregisterUserTool: vi.fn() } } as unknown as AgentServices,
    eventBus: new EventSubscriptionBus(),
    log: undefined,
  } as unknown as Agent;
  return { tool: new ManagePluginTool(agent), manager, runtime, home, agent, syncCalls };
}

/**
 * A plugin directory the manager will accept. `entryPoint` (when asked for) is a
 * real `.mjs` file inside the plugin so the extension runtime can import it
 * after the install copy lands in the managed root.
 */
async function makePlugin(
  name: string,
  options: {
    entryPoint?: boolean;
    mcpServers?: Record<string, unknown>;
    skills?: readonly string[];
    keywords?: readonly string[];
    displayName?: string;
  } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `manage-plugin-${name}-`));
  const manifest: Record<string, unknown> = {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
  };
  if (options.keywords !== undefined) manifest['keywords'] = options.keywords;
  if (options.displayName !== undefined) manifest['interface'] = { displayName: options.displayName };
  if (options.mcpServers !== undefined) manifest['mcpServers'] = options.mcpServers;
  const skillNames = options.skills ?? [];
  if (skillNames.length > 0) {
    manifest['skills'] = './skills/';
    for (const skillName of skillNames) {
      await mkdir(path.join(root, 'skills', skillName), { recursive: true });
      await writeFile(
        path.join(root, 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: A fixture skill\n---\nbody`,
        'utf8',
      );
    }
  }
  if (options.entryPoint === true) {
    manifest['entryPoint'] = './entry.mjs';
    await writeFile(
      path.join(root, 'entry.mjs'),
      'export function activate(context) {\n' +
        '  globalThis.__managedPluginActivations = (globalThis.__managedPluginActivations ?? 0) + 1;\n' +
        '  globalThis.__managedPluginId = context.pluginId;\n' +
        '}\n' +
        'export function deactivate() {\n' +
        '  globalThis.__managedPluginDeactivations = (globalThis.__managedPluginDeactivations ?? 0) + 1;\n' +
        '}\n',
      'utf8',
    );
  }
  await writeFile(path.join(root, 'scream.plugin.json'), JSON.stringify(manifest), 'utf8');
  return root;
}

async function run(harness: Harness, args: ManagePluginInput) {
  return executeTool(harness.tool, {
    args,
    turnId: '1',
    toolCallId: `call_${++callCounter}`,
    signal,
  });
}

/**
 * Counters and marks the fixture entry point writes on `globalThis`, which is how
 * a test proves whether plugin code actually ran. One typed accessor because the
 * test tsconfig forbids implicit index signatures on the global object.
 */
const pluginGlobals = globalThis as unknown as Record<string, unknown>;

/**
 * Clear the counters before a test reads them, so an assertion means "this call
 * ran the code exactly once" rather than depending on which tests ran first.
 */
function resetPluginGlobals(): void {
  pluginGlobals['__managedPluginActivations'] = 0;
  pluginGlobals['__managedPluginDeactivations'] = 0;
  pluginGlobals['__managedPluginId'] = undefined;
}

/**
 * Every action answers with a JSON string; parse it once for readability. The
 * payload stays `any` so assertions can read fields by name.
 */
async function json(harness: Harness, args: ManagePluginInput): Promise<any> {
  const result = await run(harness, args);
  return JSON.parse(String(result.output));
}

describe('ManagePluginTool read-only actions', () => {
  it('list returns an empty table before anything is installed', async () => {
    const harness = await makeHarness();
    const payload = await json(harness, { action: 'list' });
    expect(payload.error).toBeUndefined();
    expect(payload.count).toBe(0);
    expect(payload.plugins).toEqual([]);
  });

  it('list reports the compact fields of every record', async () => {
    const harness = await makeHarness();
    await harness.manager.install(
      await makePlugin('listed', { keywords: ['demo', 'listed'], displayName: 'Listed One', skills: ['listed-skill'] }),
    );

    const payload = await json(harness, { action: 'list' });
    expect(payload.count).toBe(1);
    const plugin = payload.plugins[0];
    expect(plugin).toMatchObject({
      id: 'listed',
      name: 'listed',
      displayName: 'Listed One',
      version: '1.0.0',
      state: 'ok',
      enabled: true,
      source: 'local-path',
      keywords: ['demo', 'listed'],
      skillCount: 1,
      hasCodeEntryPoint: false,
      hasErrors: false,
    });
    expect(plugin.path).toBe(path.join(harness.home, 'plugins', 'managed', 'listed'));
  });

  it('info returns full detail including diagnostics and MCP servers', async () => {
    const harness = await makeHarness();
    await harness.manager.install(
      await makePlugin('detailed', { mcpServers: { finance: { command: 'finance-mcp' } } }),
    );

    const payload = await json(harness, { action: 'info', id: 'detailed' });
    expect(payload.active).toBe(false);
    expect(payload.plugin.mcpServers).toEqual([
      expect.objectContaining({ name: 'finance', enabled: true, transport: 'stdio' }),
    ]);
    expect(payload.plugin.diagnostics).toEqual([]);
    expect(payload.plugin.manifestPath).toContain('scream.plugin.json');
    expect(payload.plugin.skillRoots).toEqual([]);
  });

  it('check reports stored diagnostics and flags an error record', async () => {
    const harness = await makeHarness();
    await harness.manager.install(await makePlugin('healthy'));
    await harness.manager.install(await makePlugin('broken'));
    await harness.manager.markError('broken', 'entry point threw on activate');

    const single = await json(harness, { action: 'check', id: 'broken' });
    expect(single.checked).toBe(1);
    expect(single.healthy).toBe(false);
    expect(single.plugins[0]).toMatchObject({
      id: 'broken',
      state: 'error',
      errors: ['entry point threw on activate'],
    });

    const all = await json(harness, { action: 'check' });
    expect(all.checked).toBe(2);
    expect(all.healthy).toBe(false);
    expect(all.unhealthy).toEqual(['broken']);
    // The contract is explicit: check reads stored diagnostics, it does not
    // invent a reload log.
    expect(all.note).toContain('reload');
  });

  it('marketplace reads a local catalog file and applies the query filter', async () => {
    const harness = await makeHarness();
    const catalogPath = path.join(harness.home, 'marketplace.json');
    await writeFile(
      catalogPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'alpha',
            name: 'Alpha Skills',
            description: 'Spreadsheet helpers',
            source: 'https://github.com/fixture/alpha',
            tier: 'official',
            version: '2.1.0',
            tags: ['sheets'],
          },
          { id: 'beta', displayName: 'Beta', description: 'PDF tools', source: './beta.zip' },
          { id: 'gamma', displayName: 'Gamma', description: 'no source, skipped' },
        ],
      }),
      'utf8',
    );

    const all = await json(harness, {
      action: 'marketplace',
      source: catalogPath,
    });
    expect(all.error).toBeUndefined();
    expect(all.catalog).toBe(catalogPath);
    // The entry without a source is dropped rather than failing the catalog.
    expect(all.count).toBe(2);
    expect(all.entries[0]).toMatchObject({
      id: 'alpha',
      displayName: 'Alpha Skills',
      source: 'https://github.com/fixture/alpha',
      tier: 'official',
      version: '2.1.0',
      keywords: ['sheets'],
    });
    // A relative entry source resolves against the catalog's directory.
    expect(all.entries[1].source).toBe(path.join(harness.home, 'beta.zip'));

    const filtered = await json(harness, { action: 'marketplace', source: catalogPath, query: 'pdf' });
    expect(filtered.query).toBe('pdf');
    expect(filtered.entries.map((entry: { id: string }) => entry.id)).toEqual(['beta']);

    const miss = await json(harness, { action: 'marketplace', source: catalogPath, query: 'nothing-matches' });
    expect(miss.count).toBe(0);
  });

  it('marketplace fails with an actionable next when the catalog is unreadable', async () => {
    const harness = await makeHarness();
    const payload = await json(harness, {
      action: 'marketplace',
      source: path.join(harness.home, 'missing.json'),
    });
    expect(payload.error.code).toBe('marketplace_unavailable');
    expect(payload.error.next).toContain('source');
  });
});

describe('ManagePluginTool mutating actions', () => {
  it('install lands the files without executing any code', async () => {
    const harness = await makeHarness();
    resetPluginGlobals();
    const source = await makePlugin('installer', { entryPoint: true });

    const payload = await json(harness, { action: 'install', source });
    expect(payload).toMatchObject({
      action: 'install',
      id: 'installer',
      installed: true,
      activated: false,
      codeExecuted: false,
      hasCodeEntryPoint: true,
    });
    expect(payload.message).toContain('code not executed yet');
    expect(harness.runtime.isActive('installer')).toBe(false);
    expect(pluginGlobals['__managedPluginActivations']).toBe(0);
    expect(await harness.manager.get('installer')?.root).toBe(
      path.join(harness.home, 'plugins', 'managed', 'installer'),
    );
  });

  it('register_generated accepts a data-only plugin directory', async () => {
    const harness = await makeHarness();
    const source = await makePlugin('generated', { skills: ['generated-skill'] });

    const payload = await json(harness, { action: 'register_generated', source });
    expect(payload).toMatchObject({ registered: true, id: 'generated', hasCodeEntryPoint: false });
    // Registered in place — no copy into the managed root.
    expect(await harness.manager.get('generated')?.root).toContain('manage-plugin-generated-');
    expect((await json(harness, { action: 'list' })).count).toBe(1);
  });

  it('register_generated refuses a manifest with an entryPoint', async () => {
    const harness = await makeHarness();
    const source = await makePlugin('sneaky', { entryPoint: true });

    const result = await run(harness, { action: 'register_generated', source });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('code_entry_point_not_allowed');
    expect(payload.error.message).toContain('entryPoint');
    expect(payload.error.next).toContain('activate');
    expect(await harness.manager.get('sneaky')).toBeUndefined();
  });

  it('register_generated reports an invalid manifest instead of throwing', async () => {
    const harness = await makeHarness();
    const empty = await mkdtemp(path.join(tmpdir(), 'manage-plugin-empty-'));

    const result = await run(harness, { action: 'register_generated', source: empty });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('manifest_invalid');
    expect(payload.error.next).toContain('manifest');
  });

  it('enable and disable flip the record', async () => {
    const harness = await makeHarness();
    await harness.manager.install(await makePlugin('toggle'));

    expect((await json(harness, { action: 'disable', id: 'toggle' })).enabled).toBe(false);
    expect(await harness.manager.get('toggle')?.enabled).toBe(false);
    expect((await json(harness, { action: 'enable', id: 'toggle' })).enabled).toBe(true);
    expect(await harness.manager.get('toggle')?.enabled).toBe(true);
  });

  it('set_mcp_enabled toggles one server of a plugin', async () => {
    const harness = await makeHarness();
    await harness.manager.install(
      await makePlugin('mcp-host', { mcpServers: { one: { command: 'one-mcp' }, two: { command: 'two-mcp' } } }),
    );

    const off = await json(harness, { action: 'set_mcp_enabled', id: 'mcp-host', server: 'one', enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.mcpServers.find((server: { name: string }) => server.name === 'one').enabled).toBe(false);
    expect(off.mcpServers.find((server: { name: string }) => server.name === 'two').enabled).toBe(true);
    expect(Object.keys(await harness.manager.enabledMcpServers())).toEqual([
      'plugin-mcp-host:two',
    ]);
  });

  it('activate runs a code entry point and deactivate unwinds it', async () => {
    const harness = await makeHarness();
    resetPluginGlobals();
    await harness.manager.install(await makePlugin('runner', { entryPoint: true }));

    const activated = await json(harness, { action: 'activate', id: 'runner' });
    expect(activated).toMatchObject({ action: 'activate', id: 'runner', active: true });
    expect(harness.runtime.isActive('runner')).toBe(true);
    expect(pluginGlobals['__managedPluginActivations']).toBe(1);
    expect(pluginGlobals['__managedPluginId']).toBe('runner');
    expect((await json(harness, { action: 'info', id: 'runner' })).active).toBe(true);

    // Re-activating is a no-op that says so rather than a second import.
    const again = await json(harness, { action: 'activate', id: 'runner' });
    expect(again.alreadyActive).toBe(true);
    expect(pluginGlobals['__managedPluginActivations']).toBe(1);

    const deactivated = await json(harness, { action: 'deactivate', id: 'runner' });
    expect(deactivated).toMatchObject({ active: false, wasActive: true });
    expect(harness.runtime.isActive('runner')).toBe(false);
    expect(pluginGlobals['__managedPluginDeactivations']).toBe(1);
  });

  it('activate explains that a skill-only plugin has nothing to run', async () => {
    const harness = await makeHarness();
    await harness.manager.install(await makePlugin('data-only', { skills: ['data-skill'] }));

    const result = await run(harness, { action: 'activate', id: 'data-only' });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('no_code_entry_point');
    expect(payload.error.next).toContain('enable');
  });

  it('activate records a failed entry point on the plugin', async () => {
    const harness = await makeHarness();
    const root = await mkdtemp(path.join(tmpdir(), 'manage-plugin-failing-'));
    await writeFile(
      path.join(root, 'scream.plugin.json'),
      JSON.stringify({ name: 'falling', version: '1.0.0', entryPoint: './entry.mjs' }),
      'utf8',
    );
    await writeFile(
      path.join(root, 'entry.mjs'),
      'export function activate() {\n  throw new Error("boom on purpose");\n}\n',
      'utf8',
    );
    await harness.manager.install(root);

    const result = await run(harness, { action: 'activate', id: 'falling' });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('activation_failed');
    expect(payload.error.message).toContain('boom on purpose');
    expect(payload.error.next).toContain('info');
    expect(await harness.manager.get('falling')?.state).toBe('error');
  });

  it('remove drops the record and unwinds a live activation first', async () => {
    const harness = await makeHarness();
    await harness.manager.install(await makePlugin('leaving', { entryPoint: true }));
    await harness.runtime.activate(
      { services: {}, eventBus: new EventSubscriptionBus() } as unknown as Agent,
      harness.runtime.discover([(await harness.manager.get('leaving'))!])[0]!,
    );

    const payload = await json(harness, { action: 'remove', id: 'leaving' });
    expect(payload).toMatchObject({ removed: true, deactivatedFirst: true });
    expect(harness.runtime.isActive('leaving')).toBe(false);
    expect((await json(harness, { action: 'list' })).count).toBe(0);
  });

  it('reload re-reads the table from disk and returns the fresh summary', async () => {
    const harness = await makeHarness();
    await harness.manager.install(await makePlugin('reloader'));

    const summary = await json(harness, { action: 'reload' });
    expect(summary.error).toBeUndefined();
    expect(summary).toMatchObject({ action: 'reload', added: [], removed: [], errors: [] });

    // A record written behind the manager's back shows up after reload.
    const other = new PluginManager({ screamHomeDir: harness.home });
    await other.load();
    await other.install(await makePlugin('surprise'));
    const after = await json(harness, { action: 'reload' });
    expect(after.added).toEqual(['surprise']);
  });
});

describe('ManagePluginTool error contract', () => {
  it('an unknown id returns isError with a next that points at list', async () => {
    const harness = await makeHarness();
    for (const action of ['info', 'check', 'enable', 'disable', 'activate', 'deactivate', 'remove'] as const) {
      const result = await run(harness, { action, id: 'ghost' });
      const payload = JSON.parse(String(result.output));
      expect(result.isError, action).toBe(true);
      expect(payload.error.code, action).toBe('plugin_not_found');
      expect(payload.error.next, action).toContain('list');
    }
  });

  it('missing required args are rejected before any state is touched', async () => {
    const harness = await makeHarness();

    const noId = await run(harness, { action: 'enable' });
    expect(noId.isError).toBe(true);
    expect(JSON.parse(String(noId.output)).error.code).toBe('missing_id');

    const noSource = await run(harness, { action: 'install' });
    expect(JSON.parse(String(noSource.output)).error.code).toBe('missing_source');
    expect(JSON.parse(String(noSource.output)).error.next).toContain('marketplace');

    const blankSource = await run(harness, { action: 'install', source: '   ' });
    expect(JSON.parse(String(blankSource.output)).error.code).toBe('missing_source');

    const noServer = await run(harness, { action: 'set_mcp_enabled', id: 'x' });
    expect(JSON.parse(String(noServer.output)).error.code).toBe('missing_server');
    const noEnabled = await run(harness, { action: 'set_mcp_enabled', id: 'x', server: 'y' });
    expect(JSON.parse(String(noEnabled.output)).error.code).toBe('missing_enabled');
  });

  it('an unknown action is rejected without a prompt or a state change', async () => {
    const harness = await makeHarness();
    const result = await run(
      harness,
      { action: 'not_a_real_action' } as unknown as ManagePluginInput,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.output)).error.code).toBe('unknown_action');
    expect((await json(harness, { action: 'list' })).count).toBe(0);
  });

  it('a thrown manager error is converted into an isError JSON result', async () => {
    const harness = await makeHarness();
    const failing = Object.create(PluginManager.prototype);
    Object.assign(failing, {
      list: () => [],
      install: () => Promise.reject(new Error('disk is on fire')),
    });
    const agent = {
      type: 'main',
      toolServices: { plugins: failing as unknown as PluginManager },
      config: { cwd: harness.home },
    } as unknown as Agent;

    const result = await executeTool(new ManagePluginTool(agent), {
      args: { action: 'install', source: '/tmp/whatever' },
      turnId: '1',
      toolCallId: `call_${++callCounter}`,
      signal,
    });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('plugin_operation_failed');
    expect(payload.error.message).toContain('disk is on fire');
    expect(typeof payload.error.next).toBe('string');
  });

  it('reports a clear error when the host exposes no plugin manager', async () => {
    const agent = { type: 'main', config: { cwd: '/' } } as unknown as Agent;
    const result = await executeTool(new ManagePluginTool(agent), {
      args: { action: 'list' },
      turnId: '1',
      toolCallId: `call_${++callCounter}`,
      signal,
    });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('plugin_center_unavailable');
  });

  it('maps an already-installed registration to the "already exists" next', async () => {
    const harness = await makeHarness();
    const source = await makePlugin('dupe', { skills: ['dupe-skill'] });
    await harness.manager.registerGenerated(source);

    const result = await run(harness, { action: 'register_generated', source });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.message).toContain('already exists');
    expect(payload.error.next).toContain('enable');
  });

  it('points a relative install source at the accepted source forms', async () => {
    const harness = await makeHarness();
    const result = await run(harness, { action: 'install', source: 'relative/path' });
    const payload = JSON.parse(String(result.output));
    expect(result.isError).toBe(true);
    expect(payload.error.next).toContain('absolute');
  });
});

describe('ManagePluginTool approval identity', () => {
  it('carries a per-action rule so a session grant does not cover other actions', async () => {
    const harness = await makeHarness();
    const list = harness.tool.resolveExecution({ action: 'list' });
    const install = harness.tool.resolveExecution({ action: 'install', source: 'https://github.com/o/r' });
    const enable = harness.tool.resolveExecution({ action: 'enable', id: 'demo' });
    if (list.isError === true || install.isError === true || enable.isError === true) {
      throw new TypeError('expected runnable executions');
    }

    expect(list.approvalRule).toBe('ManagePlugin(list)');
    expect(enable.approvalRule).toBe('ManagePlugin(enable)');
    // The install rule keeps the source, so it cannot be replayed for another.
    expect(install.approvalRule).toContain('install');
    expect(install.approvalRule).toContain('https://github.com/o/r');

    expect(enable.matchesRule?.('enable')).toBe(true);
    expect(enable.matchesRule?.('install')).toBe(false);
    expect(install.matchesRule?.('install https://github.com/o/r')).toBe(true);
    expect(install.matchesRule?.('install https://github.com/evil/r')).toBe(false);
    expect(list.matchesRule?.('')).toBe(true);
  });

  it('surfaces the full source string in the install approval description', async () => {
    const harness = await makeHarness();
    const source = 'https://github.com/owner/spreadsheet-tools/tree/v1.2.0';
    const execution = harness.tool.resolveExecution({ action: 'install', source });
    if (execution.isError === true) throw new Error('expected a runnable execution');
    expect(execution.description).toContain(source);
    expect(execution.description).toContain('not executed');

    const register = harness.tool.resolveExecution({ action: 'register_generated', source: '/tmp/gen' });
    if (register.isError === true) throw new Error('expected a runnable execution');
    expect(register.description).toContain('/tmp/gen');
  });

  it('declares no filesystem accesses for read actions and all-of-side-effects for writes', async () => {
    const harness = await makeHarness();
    const read = harness.tool.resolveExecution({ action: 'marketplace' });
    const write = harness.tool.resolveExecution({ action: 'remove', id: 'demo' });
    if (read.isError === true || write.isError === true) throw new Error('expected runnable executions');
    expect(read.accesses).toEqual([]);
    expect(write.accesses).toEqual([{ kind: 'all' }]);
  });

  it('advertises the strict action enum', async () => {
    const harness = await makeHarness();
    const schema = harness.tool.parameters as {
      properties: { action: { enum: readonly string[] } };
      required: readonly string[];
    };
    expect(schema.properties.action.enum).toContain('register_generated');
    expect(schema.properties.action.enum).toContain('set_mcp_enabled');
    // `reset` arrived with the circuit breaker (Phase D).
    expect(schema.properties.action.enum).toContain('reset');
    expect(schema.required).toEqual(['action']);
  });
});

describe('ManagePluginTool hot-apply wiring', () => {
  it('install syncs with skipMcpAdd and surfaces the report', async () => {
    const harness = await makeHarness();
    const source = await makePlugin('sync-install');
    const payload = await json(harness, { action: 'install', source });

    expect(harness.syncCalls).toEqual([{ ids: ['sync-install'], skipMcpAdd: true }]);
    expect(payload.sync).toMatchObject({ ok: true });
    expect(payload.error).toBeUndefined();
  });

  it('register_generated syncs skill data with skipMcpAdd', async () => {
    const harness = await makeHarness();
    const source = await makePlugin('sync-generated', { skills: ['gen'] });
    const payload = await json(harness, { action: 'register_generated', source });

    expect(payload.registered).toBe(true);
    expect(harness.syncCalls.at(-1)).toEqual({ ids: ['sync-generated'], skipMcpAdd: true });
  });

  it('enable, disable, and remove sync without skipMcpAdd', async () => {
    const harness = await makeHarness();
    const source = await makePlugin('sync-toggle');
    await harness.manager.install(source);
    harness.syncCalls.length = 0;

    await json(harness, { action: 'disable', id: 'sync-toggle' });
    await json(harness, { action: 'enable', id: 'sync-toggle' });
    await json(harness, { action: 'remove', id: 'sync-toggle' });

    expect(harness.syncCalls).toEqual([
      { ids: ['sync-toggle'], skipMcpAdd: false },
      { ids: ['sync-toggle'], skipMcpAdd: false },
      { ids: ['sync-toggle'], skipMcpAdd: false },
    ]);
  });

  it('reload syncs a full rescan with no ids', async () => {
    const harness = await makeHarness();
    await json(harness, { action: 'reload' });
    expect(harness.syncCalls).toEqual([{ ids: undefined, skipMcpAdd: false }]);
  });

  it('read-only actions never trigger hot-apply', async () => {
    const harness = await makeHarness();
    await json(harness, { action: 'list' });
    await json(harness, { action: 'check' });
    expect(harness.syncCalls).toHaveLength(0);
  });

  it('a failing sync is reported without failing the mutation', async () => {
    const harness = await makeHarness();
    (harness.agent.toolServices as { pluginSync?: unknown }).pluginSync = async () => {
      throw new Error('boom-sync');
    };
    const source = await makePlugin('sync-throw');
    const payload = await json(harness, { action: 'install', source });

    expect(payload.error).toBeUndefined();
    expect(payload.installed).toBe(true);
    expect(payload.sync).toMatchObject({ ok: false });
    expect(payload.sync.failed[0].message).toContain('boom-sync');
  });
});

describe('ManagePluginTool circuit recovery', () => {
  it('reset clears the ledger, re-enables, and hot-applies without running code', async () => {
    const harness = await makeHarness();
    await harness.manager.install(await makePlugin('tripped'));
    // Simulate a disabled/broken record: reset must bring it back cleanly.
    await harness.manager.setEnabled('tripped', false);
    harness.syncCalls.length = 0;

    const payload = await json(harness, { action: 'reset', id: 'tripped' });

    expect(payload).toMatchObject({
      action: 'reset',
      id: 'tripped',
      enabled: true,
      state: 'ok',
      circuit: { cleared: true },
    });
    expect(payload.sync).toBeDefined();
    expect(harness.syncCalls).toEqual([{ ids: ['tripped'], skipMcpAdd: false }]);
    expect((await harness.manager.get('tripped'))?.enabled).toBe(true);
    // The plugin's code was NOT activated by the reset.
    expect(harness.runtime.isActive('tripped')).toBe(false);
  });

  it('reset on an unknown id follows the not-found contract', async () => {
    const harness = await makeHarness();
    const payload = await json(harness, { action: 'reset', id: 'nobody' });
    expect(payload.error.code).toBe('plugin_not_found');
    expect(payload.error.next).toContain('list');
  });

  it('check surfaces live circuit state per plugin', async () => {
    const harness = await makeHarness();
    await harness.manager.install(await makePlugin('watched'));
    const payload = await json(harness, { action: 'check', id: 'watched' });
    expect(payload.plugins[0].circuit).toEqual({ failures: 0, tripped: false });
  });
});
