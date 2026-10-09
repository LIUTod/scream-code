/**
 * Live ring budget accounting.
 *
 * `MAX_OUTPUT_BYTES` is a byte budget (1 MiB): the ring is presented to
 * callers as a bounded tail, so the accounting must be too. Counting UTF-16
 * code units lets non-ASCII output hold up to 3× the budget, and a single
 * chunk larger than the budget must be trimmed instead of kept whole — the
 * retired-tail path already does both (see `trimRetiredOutput`).
 */

import { PassThrough, type Writable } from 'node:stream';

import type { JianProcess } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function streamProcess(): { readonly proc: JianProcess; readonly stdout: PassThrough } {
  const stdout = new PassThrough();
  const proc: JianProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr: new PassThrough(),
    pid: 4321,
    exitCode: null,
    wait: vi.fn(() => new Promise<number>(() => {})),
    kill: vi.fn(async () => {}),
  };
  return { proc, stdout };
}

/** Let the stream's `data` listeners run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('BackgroundProcessManager — live ring byte budget', () => {
  it('keeps multi-byte output inside the budget', async () => {
    const manager = new BackgroundProcessManager();
    const { proc, stdout } = streamProcess();
    const taskId = manager.register(proc, 'flood', 'wide output');

    // 600k CJK characters: 1.8 MB of UTF-8 in 600k UTF-16 code units — inside
    // the budget only when it is counted in code units. The write is trimmed
    // to the budget's byte tail on arrival.
    stdout.write('汉'.repeat(600_000));
    await settle();
    expect(Buffer.byteLength(manager.getOutput(taskId), 'utf-8')).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );

    stdout.write('TAIL-MARKER');
    await settle();

    const output = manager.getOutput(taskId);
    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(output.endsWith('TAIL-MARKER')).toBe(true);
    expect(manager.getTask(taskId)?.status).toBe('running');
  });

  it('trims a single chunk that exceeds the whole budget', async () => {
    const manager = new BackgroundProcessManager();
    const { proc, stdout } = streamProcess();
    const taskId = manager.register(proc, 'flood', 'one oversized write');

    // One write larger than the whole budget: nothing to drop before it, so
    // the chunk's own byte tail is what the ring keeps.
    stdout.write('x'.repeat(MAX_OUTPUT_BYTES + 4096));
    await settle();

    const output = manager.getOutput(taskId);
    expect(output.length).toBe(MAX_OUTPUT_BYTES);
    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it('carries the byte total into the retired tail', async () => {
    // Grace 0: the kill path is not what this case measures, and the default
    // 5s wait would only slow it down.
    const manager = new BackgroundProcessManager({ killGracePeriodMs: 0 });
    const { proc, stdout } = streamProcess();
    const taskId = manager.register(proc, 'flood', 'wide then exit');

    stdout.write('汉'.repeat(600_000));
    await settle();
    // Exit after the wide write: the retained tail must honor the same budget.
    expect(await manager.stop(taskId)).toMatchObject({ status: 'killed' });

    const output = manager.getOutput(taskId);
    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });
});
