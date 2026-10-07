import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '#/agent/index';
import { createRlmHostHandlers } from '#/agent/tool/index';
import type { SubagentCompletion, SubagentHandle } from '#/session/subagent-host';
import { PythonTool } from '#/tools/builtin/python/python';

import { testAgent } from './harness/agent';

/** Minimal Agent stand-in carrying exactly what createRlmHostHandlers reads. */
function fakeAgent(
  spawn: (profile: string, options: { signal: AbortSignal }) => Promise<SubagentHandle>,
  opts: { depth?: number; maxDepth?: number } = {},
): Agent {
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? Infinity;
  return {
    subagentHost: { spawn },
    getRlmDepth: () => depth,
    getRlmMaxDepth: () => maxDepth,
    getCapabilityMode: () => 'all',
  } as unknown as Agent;
}

function handleOf(agentId: string, completion: Promise<SubagentCompletion>): SubagentHandle {
  return { agentId, profileName: 'coder', resumed: false, completion };
}

describe('createRlmHostHandlers', () => {
  it('answers `{ result: <string> }` from both timings — settled-before-wait and settle-during-wait', async () => {
    // Fast child: the completion is already settled when rlm.result arrives,
    // so the cached-result branch answers.
    const fastHandlers = createRlmHostHandlers(
      fakeAgent(async () => handleOf('fast', Promise.resolve({ result: 'fast summary' }))),
    );
    const fastRun = await fastHandlers['rlm.run']!({ task: 'do a thing' });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the settle callback land
    const fastResult = await fastHandlers['rlm.result']!({ id: fastRun['id'] });
    expect(fastResult).toEqual({ result: 'fast summary' });

    // Slow child: rlm.result arrives first and waits for the completion.
    let settle!: (completion: SubagentCompletion) => void;
    const slowCompletion = new Promise<SubagentCompletion>((resolve) => {
      settle = resolve;
    });
    const slowHandlers = createRlmHostHandlers(
      fakeAgent(async () => handleOf('slow', slowCompletion)),
    );
    const slowRun = await slowHandlers['rlm.run']!({ task: 'do a slow thing' });
    const waiting = slowHandlers['rlm.result']!({ id: slowRun['id'] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    settle({ result: 'slow summary', turns: 3, toolCallCount: 7 });
    const slowResult = await waiting;

    // Same shape, same payload type on both paths. The bug returned the whole
    // completion object on the cached path and the string on the waiting
    // path, so the kernel saw two different types for the same call.
    expect(slowResult).toEqual({ result: 'slow summary' });
    expect(typeof fastResult['result']).toBe('string');
    expect(typeof slowResult['result']).toBe('string');
  }, 10_000);

  it('keeps a settled handle readable — repeated rlm_wait returns the same result', async () => {
    const handlers = createRlmHostHandlers(
      fakeAgent(async () => handleOf('h1', Promise.resolve({ result: 'done once' }))),
    );
    const run = await handlers['rlm.run']!({ task: 'x' });
    const first = await handlers['rlm.result']!({ id: run['id'] });
    const second = await handlers['rlm.result']!({ id: run['id'] });
    expect(first).toEqual({ result: 'done once' });
    expect(second).toEqual({ result: 'done once' });
  }, 10_000);

  it('rejects rlm.run once the recursion depth cap is reached', async () => {
    const spawn = vi.fn(async () => handleOf('never', Promise.resolve({ result: 'nope' })));
    const capped = createRlmHostHandlers(fakeAgent(spawn, { depth: 2, maxDepth: 2 }));
    await expect(capped['rlm.run']!({ task: 'x' })).rejects.toThrow(/depth limit/i);
    expect(spawn).not.toHaveBeenCalled();

    // One level below the cap the same configuration spawns normally.
    const below = createRlmHostHandlers(fakeAgent(spawn, { depth: 1, maxDepth: 2 }));
    await expect(below['rlm.run']!({ task: 'x' })).resolves.toMatchObject({ id: 'never' });
    expect(spawn).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('aborts in-flight children and drops every handle on __dispose__', async () => {
    let captured: AbortSignal | undefined;
    const spawn = vi.fn(async (_profile: string, options: { signal: AbortSignal }) => {
      captured = options.signal;
      return handleOf('h9', new Promise<SubagentCompletion>(() => {})); // never settles
    });
    const handlers = createRlmHostHandlers(fakeAgent(spawn));
    const run = await handlers['rlm.run']!({ task: 'x' });
    expect(captured?.aborted).toBe(false);

    await handlers['__dispose__']!({});
    expect(captured?.aborted).toBe(true);
    await expect(handlers['rlm.result']!({ id: run['id'] })).rejects.toThrow('unknown rlm handle');
  }, 10_000);

  it('keeps the live python tool across registry rebuilds, resetting it only on a cwd change', () => {
    const harness = testAgent();
    harness.configure();
    const tools = harness.agent.tools;
    const first = tools.getBuiltinTool('python');
    expect(first).toBeInstanceOf(PythonTool);

    // A rebuild (config refresh / skill reload) must reuse the instance: the
    // running kernel, its in-memory state and the rlm() handle table live on
    // it, so a fresh instance would silently drop all three.
    tools.initializeBuiltinTools();
    expect(tools.getBuiltinTool('python')).toBe(first);

    // A different cwd is a different workspace: deterministic reset.
    harness.agent.config.update({ cwd: tmpdir() });
    const reset = tools.getBuiltinTool('python');
    expect(reset).toBeInstanceOf(PythonTool);
    expect(reset).not.toBe(first);
    expect((reset as PythonTool).cwd).toBe(tmpdir());
  }, 10_000);
});
