import { describe, expect, it } from 'vitest';

import type { ExecutableToolContext } from '#/loop/types';
import { PythonTool } from '#/tools/builtin/python/python';

const ctx = { turnId: 't', toolCallId: 'c', signal: undefined } as unknown as ExecutableToolContext;

async function runTool(t: PythonTool, args: { code: string; timeout?: number }): Promise<import('#/loop/types').ExecutableToolResult> {
  const exec = t.resolveExecution(args);
  if ('execute' in exec) return exec.execute(ctx);
  return exec;
}

/** hostHandlers are required for the RLM bootstrap (snapshot/_restore) to be
 * injected; an empty record is enough for the snapshot path. */
function makeRlmTool(snapshotPath?: string): PythonTool {
  return new PythonTool('/tmp', { hostHandlers: {}, ...(snapshotPath ? { snapshotPath } : {}) });
}

describe('rlm interrupt + snapshot', () => {
  it('preserves state across SIGINT timeout and never mis-hits stale markers', async () => {
    const tool = makeRlmTool();
    // Case 1: infinite loop with tiny timeout → SIGINT path (kernel survives).
    const r1 = await runTool(tool, { code: 'import time\nx = 42\ntime.sleep(30)', timeout: 1 });
    expect(r1.isError).toBe(true);
    expect(r1.output).toContain('kernel interrupted; state preserved');
    expect(r1.output).not.toContain('restarted');

    // Case 2: the next call must not mis-hit the stale DONE marker, must run
    // cleanly, and `x` must still exist (kernel survived the interrupt).
    const r2 = await runTool(tool, { code: 'x + 1', timeout: 10 });
    expect(r2.isError).toBe(false);
    expect(r2.output).toContain('43');

    // Case 3: normal execution still works and persists state.
    const r3 = await runTool(tool, { code: 'y = 100\ny * 2', timeout: 10 });
    expect(r3.isError).toBe(false);
    expect(r3.output).toContain('200');

    // Case 4: a real error returns a traceback, not a stale false-positive.
    const r4 = await runTool(tool, { code: 'raise ValueError("boom")', timeout: 10 });
    expect(r4.isError).toBe(true);
    expect(r4.output).toContain('ValueError');

    // Case 5: after the interrupt, state x is still there (snapshot/kernel keep).
    const r5 = await runTool(tool, { code: 'x * 2', timeout: 10 });
    expect(r5.isError).toBe(false);
    expect(r5.output).toContain('84');

    tool.dispose();
  }, 60_000);

  it('kills a kernel that does not settle after SIGINT and starts fresh', async () => {
    const tool = makeRlmTool();
    // A call that hangs the kernel hard (a loop that swallows
    // KeyboardInterrupt never returns to the REPL, so SIGINT cannot settle
    // it and the kernel must be restarted).
    const r1 = await runTool(tool, {
      code: 'import time\ntry:\n    while True: time.sleep(0.05)\nexcept KeyboardInterrupt:\n    pass',
      timeout: 1,
    });
    // Either interrupted-preserved or restarted — both are valid, but the
    // NEXT call must still work.
    expect(r1.isError).toBe(true);

    const r2 = await runTool(tool, { code: 'z = 7\nz', timeout: 10 });
    expect(r2.isError).toBe(false);
    expect(r2.output).toContain('7');

    tool.dispose();
  }, 60_000);

  it('restores RLM state from snapshot after a kernel crash', async () => {
    const snapshotPath = `/tmp/scream-rlm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pkl`;
    const tool = makeRlmTool(snapshotPath);
    // Set state, let the auto-snapshot persist it after execution.
    const r1 = await runTool(tool, { code: 'k = "kept"\ndata = [1, 2, 3]', timeout: 15 });
    expect(r1.isError).toBe(false);

    // Crash the kernel hard (os._exit terminates the process immediately —
    // no DONE marker, stream closes). This is the real-world "kernel died"
    // scenario; the next call must auto-restart the kernel and restore the
    // snapshot (k and data survive).
    const crash = await runTool(tool, { code: 'import os\nos._exit(0)', timeout: 5 });
    expect(crash.isError).toBe(true);

    const r2 = await runTool(tool, { code: 'k', timeout: 15 });
    expect(r2.isError).toBe(false);
    expect(r2.output).toContain('kept');

    const r3 = await runTool(tool, { code: 'len(data)', timeout: 15 });
    expect(r3.isError).toBe(false);
    expect(r3.output).toContain('3');

    tool.dispose();
  }, 90_000);

  it('removes the snapshot file on dispose (no tmpdir accumulation)', async () => {
    const snapshotPath = `/tmp/scream-rlm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pkl`;
    const tool = makeRlmTool(snapshotPath);
    await runTool(tool, { code: 'a = 1', timeout: 15 });
    tool.dispose();
    // unlink is fire-and-forget inside dispose; poll until it lands (bounded)
    // instead of asserting immediately, which races on slow CI machines.
    const { access } = await import('node:fs/promises');
    const deadline = Date.now() + 5000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        await access(snapshotPath);
      } catch {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
  }, 60_000);
});
