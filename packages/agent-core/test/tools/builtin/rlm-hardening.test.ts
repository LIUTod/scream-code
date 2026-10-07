import { spawnSync } from 'node:child_process';
import { access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, type TestContext, vi } from 'vitest';

import type { ExecutableToolContext, ExecutableToolResult } from '#/loop/types';
import { PythonTool } from '#/tools/builtin/python/python';
import { parentInterjectReason } from '#/utils/abort';

const ctx = { turnId: 't', toolCallId: 'c', signal: undefined } as unknown as ExecutableToolContext;

function ctxWithSignal(signal: AbortSignal): ExecutableToolContext {
  return { turnId: 't', toolCallId: 'c', signal } as unknown as ExecutableToolContext;
}

async function runToolWith(
  t: PythonTool,
  args: { code: string; timeout?: number },
  context: ExecutableToolContext,
): Promise<ExecutableToolResult> {
  const exec = t.resolveExecution(args);
  if ('execute' in exec) return exec.execute(context);
  return exec;
}

async function runTool(
  t: PythonTool,
  args: { code: string; timeout?: number },
): Promise<ExecutableToolResult> {
  return runToolWith(t, args, ctx);
}

function textOf(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

function makeRlmTool(options: { snapshotPath?: string; snapshotByteLimit?: number } = {}): PythonTool {
  return new PythonTool(process.cwd(), { hostHandlers: {}, ...options });
}

describe('PythonTool hardening', () => {
  // SIGINT-based interruption only applies on POSIX; on Windows the kernel is
  // restarted instead (Node signals are unreliable for pipe children), which
  // is a different, deliberately chosen contract — see rlm-interrupt.test.ts.
  const win = process.platform === 'win32';

  it(
    'aborts a running call, settles quickly, and leaves the kernel usable',
    async (tctx: TestContext) => {
      if (win) {
        tctx.skip();
        return;
      }
      const tool = makeRlmTool();
      try {
        const warm = await runTool(tool, { code: 'kept = 123' });
        expect(warm.isError).toBeFalsy();

        const controller = new AbortController();
        const exec = tool.resolveExecution({ code: 'import time\ntime.sleep(30)', timeout: 60 });
        if (!('execute' in exec)) throw new Error('resolveExecution returned an error result');
        const pending = exec.execute(ctxWithSignal(controller.signal));
        // The kernel is warm, so by this point it is inside the sleep.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const abortAt = Date.now();
        controller.abort();
        const result = await pending;
        const settledMs = Date.now() - abortAt;

        // R-03 contract: settle within ~2s (SIGINT grace + sync round-trip),
        // report the interruption as an error, keep the kernel alive.
        expect(settledMs).toBeLessThan(3000);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('Interrupted by user');
        expect(textOf(result)).toContain('kernel state preserved');

        // busy cleared + kernel state intact: the next call must run, not
        // report "busy", and must still see the pre-abort state.
        const after = await runTool(tool, { code: 'kept' });
        expect(after.isError).toBe(false);
        expect(textOf(after)).toContain('123');
      } finally {
        tool.dispose();
      }
    },
    60_000,
  );

  it(
    'attributes an abort caused by a parent interject to the parent agent',
    async (tctx: TestContext) => {
      if (win) {
        tctx.skip();
        return;
      }
      const tool = makeRlmTool();
      try {
        await runTool(tool, { code: 'marker = "here"' });
        const controller = new AbortController();
        const exec = tool.resolveExecution({ code: 'import time\ntime.sleep(30)', timeout: 60 });
        if (!('execute' in exec)) throw new Error('resolveExecution returned an error result');
        const pending = exec.execute(ctxWithSignal(controller.signal));
        await new Promise((resolve) => setTimeout(resolve, 1000));
        controller.abort(parentInterjectReason());
        const result = await pending;
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('Interrupted by the parent agent');
      } finally {
        tool.dispose();
      }
    },
    60_000,
  );

  it('rejects a concurrent call with an error while the kernel is running one, and spawns once', async () => {
    const tool = makeRlmTool();
    const spawnSpy = vi.spyOn(
      PythonTool.prototype as unknown as { spawnKernel: () => Promise<unknown> },
      'spawnKernel',
    );
    try {
      const first = runTool(tool, { code: 'import time\ntime.sleep(0.8)\nx = 5' });
      const second = await runTool(tool, { code: 'y = 6' });
      // R-08 busy contract: an error, and a message that points at the
      // real remedy (wait / interrupt) instead of a nonexistent TaskStop.
      expect(second.isError).toBe(true);
      expect(textOf(second)).toContain('busy');
      expect(textOf(second)).not.toContain('TaskStop');

      const firstResult = await first;
      expect(firstResult.isError).toBeFalsy();
      // R-04: a racing pair must never spawn two kernels.
      expect(spawnSpy).toHaveBeenCalledTimes(1);

      // Single kernel: only the winning call's state exists in it.
      const probe = await runTool(tool, { code: "print('x' in globals(), 'y' in globals())" });
      expect(probe.isError).toBeFalsy();
      expect(textOf(probe)).toContain('True False');
    } finally {
      spawnSpy.mockRestore();
      tool.dispose();
    }
  }, 60_000);

  it('warns exactly once, in the next call, when the state snapshot is skipped for size', async () => {
    const tool = makeRlmTool({ snapshotByteLimit: 256 });
    try {
      const r1 = await runTool(tool, { code: 'big = "x" * 5000' });
      expect(r1.isError).toBeFalsy();
      // The skipped-snapshot warning is queued, not mixed into this call.
      expect(textOf(r1)).not.toContain('⚠ RLM:');

      const r2 = await runTool(tool, { code: '1 + 1' });
      const text2 = textOf(r2);
      expect(text2).toContain('⚠ RLM:');
      expect(text2).toContain('snapshot limit');
      expect(text2.split('⚠ RLM:').length - 1).toBe(1);

      // Deduped: the same warning never repeats in later calls.
      const r3 = await runTool(tool, { code: '2 + 2' });
      expect(textOf(r3)).not.toContain('⚠ RLM:');
    } finally {
      tool.dispose();
    }
  }, 60_000);

  it('warns once, in the first call, when the snapshot cannot be restored', async () => {
    const snapshotPath = join(
      tmpdir(),
      `scream-rlm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pkl`,
    );
    await writeFile(snapshotPath, 'this is not a pickle', 'utf8');
    const tool = makeRlmTool({ snapshotPath });
    try {
      const r1 = await runTool(tool, { code: 'ok = True' });
      expect(r1.isError).toBeFalsy();
      const text1 = textOf(r1);
      expect(text1).toContain('⚠ RLM:');
      expect(text1).toContain('restore failed');

      const r2 = await runTool(tool, { code: 'ok' });
      expect(textOf(r2)).not.toContain('⚠ RLM:');
    } finally {
      tool.dispose();
    }
  }, 60_000);

  it('flags only kernel-reported failures — not output that merely contains "error:"', async () => {
    const tool = makeRlmTool();
    try {
      const r1 = await runTool(tool, { code: 'print("error: not a failure")' });
      expect(r1.isError).toBe(false);
      expect(textOf(r1)).toContain('error: not a failure');

      const r2 = await runTool(tool, { code: '1 / 0' });
      expect(r2.isError).toBe(true);
      expect(textOf(r2)).toContain('ZeroDivisionError');
      // The internal channel marker is stripped from the output.
      expect(textOf(r2)).not.toContain('__SCREAM');
    } finally {
      tool.dispose();
    }
  }, 60_000);

  it('flags exceptions raised on background threads (stderr-only tracebacks)', async () => {
    const tool = makeRlmTool();
    try {
      const result = await runTool(tool, {
        code: [
          'import threading',
          'def _boom():',
          '    raise ZeroDivisionError("thread boom")',
          't = threading.Thread(target=_boom)',
          't.start()',
          't.join()',
          'threaded_marker = 1',
        ].join('\n'),
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('ZeroDivisionError');

      const after = await runTool(tool, { code: 'threaded_marker' });
      expect(after.isError).toBe(false);
      expect(textOf(after)).toContain('1');
    } finally {
      tool.dispose();
    }
  }, 60_000);

  it('treats legacy marker literals and bridge substrings printed by user code as plain output', async () => {
    const tool = makeRlmTool();
    try {
      const r1 = await runTool(tool, { code: 'print("__SCREAM_PY_DONE__")' });
      expect(r1.isError).toBe(false);
      expect(textOf(r1)).toContain('__SCREAM_PY_DONE__');

      const r2 = await runTool(tool, { code: 'print("the \\"host_request\\" substring")' });
      expect(r2.isError).toBe(false);
      expect(textOf(r2)).toContain('host_request');
      expect(textOf(r2)).toContain('substring');
    } finally {
      tool.dispose();
    }
  }, 60_000);

  it('sweeps stale reply files whose owning kernel is gone', async () => {
    // A real, already-exited pid: the sweep must treat it as dead.
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(typeof dead.pid).toBe('number');
    const staleFile = join(tmpdir(), `scream-rlm-a1b2c3d4-${String(dead.pid)}-1.json`);
    await writeFile(staleFile, '{"type":"host_reply","id":1,"result":null}', 'utf8');
    const tool = makeRlmTool();
    try {
      await runTool(tool, { code: '1 + 1' }); // kernel start fires the sweep
      let gone = false;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          await access(staleFile);
        } catch {
          gone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(gone).toBe(true);
    } finally {
      tool.dispose();
      await rm(staleFile, { force: true });
    }
  }, 60_000);
});
