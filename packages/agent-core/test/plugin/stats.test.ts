import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '#/agent';
import { PluginManager } from '../../src/plugin/manager';
import { flushStats, getUsage, recordUsageInMemory } from '../../src/plugin/stats';
import { executeTool } from '../tools/fixtures/execute-tool';

async function readStatsById(home: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path.join(home, 'plugins', 'stats.json'), 'utf8'));
  return raw.byId as Record<string, unknown>;
}

describe('plugin stats sidecar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bumps schedule exactly one debounced flush and land correct totals', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'stats-home-'));
    const id = 'counter';
    recordUsageInMemory(home, id, true);
    recordUsageInMemory(home, id, false);
    recordUsageInMemory(home, id, true);
    expect(vi.getTimerCount()).toBe(1);

    // Explicit flush = what the debounce would do, made deterministic here.
    await flushStats(home);
    expect(vi.getTimerCount()).toBe(0);

    const byId = await readStatsById(home);
    expect(byId[id]).toMatchObject({ calls: 3, okCalls: 2 });
    expect(typeof (byId[id] as { lastUsedAt?: string }).lastUsedAt).toBe('string');
  });

  it('counts survive an unloaded base: delta layer buffers until load completes', async () => {
    // Seed an existing file so the lazy base load has content to merge into.
    const home = await mkdtemp(path.join(tmpdir(), 'stats-home2-'));
    await mkdir(path.join(home, 'plugins'), { recursive: true });
    await writeFile(
      path.join(home, 'plugins', 'stats.json'),
      JSON.stringify({ version: 1, byId: { seeded: { calls: 4, okCalls: 4 } } }),
      'utf8',
    );
    // Bump BEFORE anything loaded the file: the delta layer must buffer it.
    recordUsageInMemory(home, 'seeded', false);

    const usage = await getUsage(home, 'seeded');
    expect(usage.calls).toBe(5);
    expect(usage.okCalls).toBe(4);

    await flushStats(home);
    const byId = await readStatsById(home);
    expect((byId['seeded'] as { calls: number } | undefined)?.calls).toBe(5);
    expect((byId['seeded'] as { okCalls: number } | undefined)?.okCalls).toBe(4);
  });
});

describe('PluginManager usage integration', () => {
  async function makeManager(): Promise<{ manager: PluginManager; home: string }> {
    const home = await mkdtemp(path.join(tmpdir(), 'usage-mgr-home-'));
    const manager = new PluginManager({ screamHomeDir: home });
    await manager.load();
    return { manager, home };
  }

  it('recordUsage/getUsage round-trip; unknown ids report zeros', async () => {
    const { manager } = await makeManager();
    const root = await mkdtemp(path.join(tmpdir(), 'usage-plugin-'));
    await writeFile(
      path.join(root, 'scream.plugin.json'),
      JSON.stringify({ name: 'busy', version: '1.0.0' }),
      'utf8',
    );
    await manager.install(root);

    manager.recordUsage('busy', true);
    manager.recordUsage('busy', true);
    manager.recordUsage('busy', false);

    const usage = await manager.getUsage('busy');
    expect(usage.calls).toBe(3);
    expect(usage.okCalls).toBe(2);

    const nobody = await manager.getUsage('nobody');
    expect(nobody.calls).toBe(0);
  });

  it('remove drops the counters from the sidecar', async () => {
    const { manager, home } = await makeManager();
    const root = await mkdtemp(path.join(tmpdir(), 'usage-gone-'));
    await writeFile(
      path.join(root, 'scream.plugin.json'),
      JSON.stringify({ name: 'ghost', version: '1.0.0' }),
      'utf8',
    );
    await manager.install(root);
    manager.recordUsage('ghost', true);
    await manager.remove('ghost');

    const byId = await readStatsById(home);
    expect(byId['ghost']).toBeUndefined();
  });

  it('a stats write failure never fails a management operation', async () => {
    const { manager } = await makeManager();
    const home = (manager as unknown as { screamHomeDir: string }).screamHomeDir;
    const root = await mkdtemp(path.join(tmpdir(), 'usage-flaky-'));
    await writeFile(
      path.join(root, 'scream.plugin.json'),
      JSON.stringify({ name: 'flaky', version: '1.0.0' }),
      'utf8',
    );

    // Sabotage BEFORE any install: a DIRECTORY at stats.json makes every
    // flushStats write throw (EISDIR). Management must survive regardless.
    await mkdir(path.join(home, 'plugins', 'stats.json'), { recursive: true });

    await manager.install(root);
    manager.recordUsage('flaky', true);
    await expect(manager.setEnabled('flaky', false)).resolves.not.toThrow();
    expect(manager.get('flaky')?.enabled).toBe(false);
  });

  it('skill invocations charge the owning plugin via toolServices', async () => {
    const recordUsage = vi.fn();
    const agent = {
      config: { hasProvider: false },
      records: { logRecord: vi.fn() },
      goal: { getGoal: () => ({ goal: null }) },
      emitEvent: vi.fn(),
      rpc: undefined,
      skills: {
        registry: {
          listInvocableSkills: () => [],
          getSkill: (name: string) =>
            ({
              name,
              metadata: { type: 'inline' },
              plugin: { id: 'skilled' },
            }) as never,
        },
      },
      toolServices: { plugins: { recordUsage } },
    } as unknown as Agent;

    const { SkillTool } = await import('../../src/tools/builtin/collaboration/skill-tool');
    const tool = new SkillTool(agent);
    const schemaTool = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      resolveExecution: (args: Record<string, unknown>) => tool.resolveExecution(args as never),
    };

    // The stub stops right after registration gates; later rendering may
    // throw on missing surface — the usage signal must ALREADY be recorded.
    try {
      await executeTool(schemaTool, {
        args: { skill: 'something-inline', args: {} },
        turnId: '1',
        toolCallId: 'c1',
        signal: new AbortController().signal,
      });
    } catch {
      // A deeper stub gap must not fail THIS assertion about the signal.
    }
    expect(recordUsage).toHaveBeenCalledWith('skilled', true);
  });
});
