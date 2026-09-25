/**
 * Hook process-tree teardown.
 *
 * `runHook` must not leave anything running when a hook times out or is aborted:
 * the shell it starts leads a POSIX process group (or, on Windows, is torn down
 * with `taskkill /T`) so grandchildren die with it.
 *
 * `node:child_process` is wrapped rather than replaced, so a test chooses per
 * case between a real child (the POSIX tree-kill cases) and a synthetic one
 * (the Windows case, whose shell would be `cmd.exe` and cannot start here).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

const harness = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  children: [] as unknown[],
  synthetic: false,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  type Emitter = InstanceType<typeof EventEmitter>;

  // stdout/stderr need `setEncoding` + `on`; stdin additionally needs the
  // Writable surface `runHook` uses (`end`, `write`).
  interface FakeStream extends Emitter {
    setEncoding: () => void;
    end: () => void;
    write: () => boolean;
  }
  const stream = (): FakeStream => {
    const emitter = new EventEmitter() as unknown as FakeStream;
    emitter.setEncoding = () => {};
    emitter.end = () => {};
    emitter.write = () => true;
    return emitter;
  };
  const syntheticChild = (pid: number): Emitter => {
    const child = new EventEmitter() as Emitter & Record<string, unknown>;
    child['pid'] = pid;
    child['stdin'] = stream();
    child['stdout'] = stream();
    child['stderr'] = stream();
    child['kill'] = () => true;
    return child;
  };

  return {
    ...actual,
    spawn: (
      file: string,
      argsOrOptions?: readonly string[] | object,
      maybeOptions?: object,
    ) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
      harness.calls.push({ command: file, args, options: options as Record<string, unknown> });
      const child = harness.synthetic
        ? syntheticChild(SYNTHETIC_PID)
        : actual.spawn(file, args as string[], options as never);
      harness.children.push(child);
      return child;
    },
  };
});

const SYNTHETIC_PID = 31337;
const RUNNER_MODULE = '../../src/session/hooks/runner' as string;

interface HookResult {
  action: 'allow' | 'block';
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

type RunHook = (
  command: string,
  input: Record<string, unknown>,
  options: { timeout: number; cwd?: string; signal?: AbortSignal },
) => Promise<HookResult>;

async function importRunHook(): Promise<RunHook> {
  const mod = (await import(RUNNER_MODULE)) as { runHook: RunHook };
  return mod.runHook;
}

function spawnCallFor(command: string): SpawnCall {
  const call = harness.calls.find((candidate) => candidate.command === command);
  if (call === undefined) throw new Error(`no spawn recorded for ${command}`);
  return call;
}

function childrenSpawnedFor(command: string): unknown[] {
  const index = harness.calls.findIndex((candidate) => candidate.command === command);
  if (index < 0) throw new Error(`no spawn recorded for ${command}`);
  return [harness.children[index]];
}

function pidOf(child: unknown): number | undefined {
  const pid = (child as { pid?: unknown } | undefined)?.pid;
  return typeof pid === 'number' ? pid : undefined;
}

async function exitsWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

async function readPidFile(path: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(path, 'utf-8')).trim(), 10);
      if (!Number.isNaN(pid)) return pid;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return undefined;
}

async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe('runHook process-tree teardown', () => {
  beforeEach(() => {
    harness.calls.length = 0;
    harness.children.length = 0;
    harness.synthetic = false;
  });

  afterEach(() => {
    harness.synthetic = false;
  });

  it('kills a Windows hook with taskkill /F /T, without a process group', async () => {
    // The shell for a Windows hook is `cmd.exe`, which cannot start on this
    // host, so the spawn is answered synthetically: this pins the plan (spawn
    // flags + kill argv) rather than any real Windows behaviour.
    harness.synthetic = true;

    await withPlatform('win32', async () => {
      const runHook = await importRunHook();
      const result = await runHook('npm test', {}, { timeout: 0.05 });

      expect(result.timedOut).toBe(true);
      expect(spawnCallFor('npm test').options['detached']).toBe(false);

      const taskkill = spawnCallFor('taskkill');
      expect(taskkill.args).toEqual(['/F', '/T', '/PID', String(SYNTHETIC_PID)]);
      expect(taskkill.options['windowsHide']).toBe(true);
    });
  });

  it('signals the POSIX process group on timeout instead of taskkill', async () => {
    const runHook = await importRunHook();
    const result = await runHook('exec sleep 30', {}, { timeout: 1 });

    expect(result.timedOut).toBe(true);
    expect(spawnCallFor('exec sleep 30').options['detached']).toBe(true);
    expect(harness.calls.some((call) => call.command === 'taskkill')).toBe(false);

    const pid = pidOf(childrenSpawnedFor('exec sleep 30')[0]);
    expect(pid).toBeDefined();
    // SIGTERM to the group (`exec` made `sleep` the group leader itself).
    await expect(exitsWithin(pid as number, 2000)).resolves.toBe(true);
  });

  it('tears the POSIX process group down on abort', async () => {
    const runHook = await importRunHook();
    const controller = new AbortController();
    const pending = runHook('exec sleep 30', {}, { timeout: 30, signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.timedOut).toBeUndefined();
    expect(spawnCallFor('exec sleep 30').options['detached']).toBe(true);

    const pid = pidOf(childrenSpawnedFor('exec sleep 30')[0]);
    await expect(exitsWithin(pid as number, 2000)).resolves.toBe(true);
  });

  it('leaves no grandchild running after a POSIX timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-tree-'));
    try {
      const pidFile = join(dir, 'grandchild.pid');
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);",
        `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
        'setInterval(() => {}, 1000);',
      ].join('');
      const runHook = await importRunHook();

      const result = await runHook(`node -e ${JSON.stringify(script)}`, {}, { timeout: 1 });
      expect(result.timedOut).toBe(true);

      const grandchildPid = await readPidFile(pidFile, 5000);
      expect(grandchildPid).toBeDefined();
      // The grandchild is not a child of this process, so a surviving pid means
      // the tree really did outlive the hook.
      await expect(exitsWithin(grandchildPid as number, 3000)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
