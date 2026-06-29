/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

import {
  resolveScreamCommand,
  runFusionPlan,
  SCREAM_FUSIONPLAN_SUBAGENT_ENV,
  truncateUtf8,
  type FusionPlanProgressEvent,
} from '#/tui/utils/fusion-plan';

const ORIGINAL_ENV = process.env[SCREAM_FUSIONPLAN_SUBAGENT_ENV];

function setSubagentEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[SCREAM_FUSIONPLAN_SUBAGENT_ENV];
  } else {
    process.env[SCREAM_FUSIONPLAN_SUBAGENT_ENV] = value;
  }
}

function createMockChildProcess(exitCode: number, stdoutLines: string[]): EventEmitter {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr });

  queueMicrotask(() => {
    for (const line of stdoutLines) {
      stdout.write(Buffer.from(`${line}\n`, 'utf8'));
    }
    stdout.end();
    queueMicrotask(() => {
      child.emit('close', exitCode);
    });
  });

  return child;
}

function createHangingMockChildProcess(): EventEmitter & { killMock: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killMock = vi.fn((signal: string) => {
    if (signal === 'SIGTERM') {
      child.emit('close', null);
    }
  });
  Object.assign(child, { stdout, stderr, pid: 12345, kill: killMock });
  return child as EventEmitter & { killMock: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setSubagentEnv(ORIGINAL_ENV);
  vi.clearAllMocks();
});

describe('truncateUtf8', () => {
  it('returns the original string when under the byte limit', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
  });

  it('truncates multi-byte characters without splitting code points', () => {
    const text = '你好世界';
    const result = truncateUtf8(text, 6);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(6);
    expect(result.endsWith('…')).toBe(true);
  });
});
describe('resolveScreamCommand', () => {
  const originalArgv = process.argv;
  const originalExecArgv = process.execArgv;

  afterEach(() => {
    process.argv = originalArgv;
    process.execArgv = originalExecArgv;
  });

  it('returns explicit screamBin as command with no prefix args', () => {
    const result = resolveScreamCommand('/custom/scream');
    expect(result.command).toBe('/custom/scream');
    expect(result.prefixArgs).toEqual([]);
  });

  it('falls back to source tsx when argv[1] is missing and src/main.ts exists', () => {
    process.argv = ['node'];
    const result = resolveScreamCommand();
    expect(result.command).toBe(process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    expect(result.prefixArgs[result.prefixArgs.length - 1]).toMatch(/src[\\/]main\.ts$/);
  });

  it('uses tsx with loader for a .ts source entry', () => {
    process.argv = ['node', '/app/src/main.ts'];
    process.execArgv = ['--import', 'tsx'];
    const result = resolveScreamCommand();
    expect(result.command).toBe(process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    expect(result.prefixArgs[result.prefixArgs.length - 1]).toMatch(/src[\\/]main\.ts$/);
  });

  it('redirects dev wrapper to source tsx', () => {
    process.argv = ['node', '/app/scripts/dev.mjs'];
    const result = resolveScreamCommand();
    expect(result.command).toBe(process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    expect(result.prefixArgs[result.prefixArgs.length - 1]).toMatch(/src[\\/]main\.ts$/);
  });

  it('uses node with the absolute built entry for .mjs', () => {
    process.argv = ['node', '/app/dist/main.mjs'];
    process.execArgv = [];
    const result = resolveScreamCommand();
    expect(result.command).toBe(process.execPath);
    expect(result.prefixArgs).toEqual(['/app/dist/main.mjs']);
  });
});

describe('runFusionPlan recursion guard', () => {
  it('returns an empty failed result when running inside a fusion subagent', async () => {
    setSubagentEnv('1');
    const result = await runFusionPlan({ task: 'test', cwd: '/tmp' });
    expect(result.ok).toBe(false);
    expect(result.plan).toBe('');
    expect(result.workerResults).toHaveLength(0);
  });
});

describe('runFusionPlan worker orchestration', () => {
  it('spawns scream with stream-json output and parses assistant content', async () => {
    mocks.spawn.mockImplementation((cmd: string, args: readonly string[]) => {
      const promptArg = args[args.indexOf('--prompt') + 1];
      const isSynthesis = promptArg?.includes('Synthesize the best plan');
      const stdoutLines = isSynthesis
        ? [JSON.stringify({ role: 'assistant', content: 'Final synthesized plan.' })]
        : [JSON.stringify({ role: 'assistant', content: 'Worker plan output.' })];
      return createMockChildProcess(0, stdoutLines) as never;
    });

    const result = await runFusionPlan({
      task: 'Implement feature X',
      cwd: '/tmp',
      model: 'k2',
      workerCount: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.plan).toBe('Final synthesized plan.');
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--output-format', 'stream-json', '--prompt', expect.any(String), '--model', 'k2']),
      expect.any(Object),
    );
  });

  it('reports failure details when a worker exits non-zero', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr });

      queueMicrotask(() => {
        stderr.write(Buffer.from('model not configured', 'utf8'));
        stderr.end();
        queueMicrotask(() => {
          child.emit('close', 1);
        });
      });

      return child as never;
    });

    const result = await runFusionPlan({ task: 'test', cwd: '/tmp', workerCount: 1 });

    expect(result.ok).toBe(false);
    expect(result.workerResults).toHaveLength(1);
    expect(result.workerResults[0]?.exitCode).toBe(1);
    expect(result.workerResults[0]?.stderr).toContain('model not configured');
  });

  it('emits progress events as workers start and complete', async () => {
    mocks.spawn.mockImplementation((cmd: string, args: readonly string[]) => {
      const promptArg = args[args.indexOf('--prompt') + 1];
      const isSynthesis = promptArg?.includes('Synthesize the best plan');
      const stdoutLines = isSynthesis
        ? [JSON.stringify({ role: 'assistant', content: 'Final synthesized plan.' })]
        : [JSON.stringify({ role: 'assistant', content: 'Worker plan output.' })];
      return createMockChildProcess(0, stdoutLines) as never;
    });

    const progress: FusionPlanProgressEvent[] = [];
    const result = await runFusionPlan({
      task: 'Implement feature X',
      cwd: '/tmp',
      model: 'k2',
      workerCount: 2,
      onProgress: (event) => progress.push(event),
    });

    expect(result.ok).toBe(true);
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress[0]?.phase).toBe('planning');
    expect(progress[0]?.workers).toHaveLength(2);
    expect(progress[0]?.workers[0]?.status).toBe('pending');
    expect(progress.at(-1)?.phase).toBe('completed');
    expect(progress.at(-1)?.completedWorkers).toBe(2);
  });

  it('times out a hanging worker and reports timeout duration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.spawn.mockReturnValue(createHangingMockChildProcess());

    const runPromise = runFusionPlan({
      task: 'Implement feature X',
      cwd: '/tmp',
      timeoutMs: 50,
      workerCount: 1,
    });

    await vi.advanceTimersByTimeAsync(50 + 1);
    await expect(runPromise).resolves.toEqual({
      ok: false,
      plan: '',
      workerResults: expect.arrayContaining([
        expect.objectContaining({ timedOut: true, timeoutMs: 50 }),
      ]),
    });

    vi.useRealTimers();
  }, 10_000);

});
