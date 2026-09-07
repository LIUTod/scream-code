import { describe, expect, it, vi } from 'vitest';

import { WolfPackTool } from '../../src/tools/builtin/collaboration/wolfpack';
import type { ExecutableToolContext, ExecutableToolResult } from '../../src/loop/types';

/**
 * T1 regression tests: WolfPack forwards batch-level output_schema /
 * output_token_hint / capability_mode to every spawned subagent (same
 * semantics as Agent), keeps unlimited concurrency, and surfaces per-item
 * structured results. Without output_schema the behaviour is unchanged.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHost() {
  const spawn = vi.fn();
  return { spawn };
}

function makeTool(host: ReturnType<typeof makeHost>): WolfPackTool {
  return new WolfPackTool(host as never, () => true, {
    log: undefined,
    allowedSpawns: undefined,
    timeoutMs: 30_000,
  });
}

function execute(tool: WolfPackTool, args: Record<string, unknown>): Promise<ExecutableToolResult> {
  const exec = tool.resolveExecution(args as never) as {
    execute(ctx: unknown): Promise<ExecutableToolResult>;
  };
  return exec.execute({ toolCallId: 'call_1', signal: new AbortController().signal } as unknown as ExecutableToolContext);
}

describe('WolfPackTool batch-level options', () => {
  it('forwards output_schema and capability_mode to every spawned subagent', async () => {
    const host = makeHost();
    const tool = makeTool(host);
    const done = deferred<{ result: string; usage: unknown }>();
    host.spawn.mockResolvedValueOnce({
      agentId: 'agent-0',
      profileName: 'reviewer',
      completion: done.promise,
    });

    const execPromise = execute(tool, {
      description: 'batch review',
      subagent_type: 'reviewer',
      prompt_template: 'review {{item}}',
      items: ['a.ts'],
      output_schema: '{"type":"object","properties":{"issues":{"type":"array"}}}',
      output_token_hint: 1024,
      capability_mode: 'read-only',
    });
    done.resolve({ result: '{"issues":[]}', usage: {} });
    const output = await execPromise;

    expect(host.spawn).toHaveBeenCalledWith(
      'reviewer',
      expect.objectContaining({
        outputSchema: '{"type":"object","properties":{"issues":{"type":"array"}}}',
        capabilityMode: 'read-only',
        prompt: expect.stringContaining('Keep your final answer within 1024 tokens'),
      }),
    );
    expect(output.isError).toBeUndefined();
    expect(output.output).toContain('[structured]');
    expect(output.output).toContain('issues');
    expect(output.output).toContain('Success: 1');
  });

  it('marks non-JSON item results as structured: invalid when a schema is requested', async () => {
    const host = makeHost();
    const tool = makeTool(host);
    const done = deferred<{ result: string; usage: unknown }>();
    host.spawn.mockResolvedValueOnce({
      agentId: 'agent-0',
      profileName: 'reviewer',
      completion: done.promise,
    });

    const execPromise = execute(tool, {
      description: 'batch review',
      prompt_template: 'review {{item}}',
      items: ['a.ts'],
      output_schema: '{"type":"object"}',
    });
    done.resolve({ result: 'plain text answer', usage: {} });
    const output = await execPromise;

    expect(output.output).toContain('structured: invalid');
    expect(output.output).toContain('plain text answer');
  });

  it('keeps plain text aggregation when output_schema is absent (unchanged behaviour)', async () => {
    const host = makeHost();
    const tool = makeTool(host);
    const done = deferred<{ result: string; usage: unknown }>();
    host.spawn.mockResolvedValueOnce({
      agentId: 'agent-0',
      profileName: 'coder',
      completion: done.promise,
    });

    const execPromise = execute(tool, {
      description: 'batch lint',
      prompt_template: 'lint {{item}}',
      items: ['a.ts'],
    });
    done.resolve({ result: 'ok', usage: {} });
    const output = await execPromise;

    expect(output.output).not.toContain('[structured]');
    expect(output.output).not.toContain('structured: invalid');
    expect(output.output).toContain('ok');
    expect(host.spawn.mock.calls[0]![1]).toMatchObject({
      outputSchema: undefined,
      capabilityMode: undefined,
    });
  });

  it('spawns all items in parallel without a concurrency cap', async () => {
    const host = makeHost();
    const tool = makeTool(host);
    const completions = [deferred<{ result: string; usage: unknown }>(), deferred<{ result: string; usage: unknown }>()];
    for (const d of completions) {
      host.spawn.mockResolvedValueOnce({
        agentId: 'agent-x',
        profileName: 'coder',
        completion: d.promise,
      });
    }

    const execPromise = execute(tool, {
      description: 'batch scan',
      prompt_template: 'scan {{item}}',
      items: ['a.ts', 'b.ts'],
    });
    // Both handles must have been spawned (unlimited concurrency) before any
    // completion resolves.
    expect(host.spawn).toHaveBeenCalledTimes(2);
    completions[0]!.resolve({ result: 'ok', usage: {} });
    completions[1]!.resolve({ result: 'ok', usage: {} });
    const output = await execPromise;

    expect(output.output).toContain('Success: 2');
  });
});
