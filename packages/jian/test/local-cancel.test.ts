/**
 * `LocalJian.iterdir` / `readLines` cooperative cancellation and
 * `iterdir` `maxEntries` bound.
 *
 * Both follow the same convention as `glob`'s `signal`: an aborted walk
 * ends like an exhausted one — the consumer's `for await` finishes, no
 * exception is thrown. These tests pin the checkpoint granularity (per
 * entry / per line) so a mid-iteration abort actually stops early.
 */

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalJian } from '#/local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('LocalJian.iterdir cancellation and maxEntries', () => {
  let jian: LocalJian;
  let tempDir: string;

  beforeEach(async () => {
    jian = await LocalJian.create();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'jian-iterdir-cancel-')));
    await jian.chdir(tempDir);
    // Six deterministic entries.
    for (let i = 0; i < 6; i++) {
      await writeFile(join(tempDir, `f${String(i)}.txt`), 'x');
    }
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('yields every entry when no options are passed (compat)', async () => {
    const entries: string[] = [];
    for await (const entry of jian.iterdir(tempDir)) {
      entries.push(entry);
    }
    expect(entries.length).toBe(6);
  });

  it('stops at maxEntries', async () => {
    const entries: string[] = [];
    for await (const entry of jian.iterdir(tempDir, { maxEntries: 2 })) {
      entries.push(entry);
    }
    expect(entries.length).toBe(2);
  });

  it('stops mid-iteration when the signal aborts', async () => {
    const controller = new AbortController();
    const entries: string[] = [];
    for await (const entry of jian.iterdir(tempDir, { signal: controller.signal })) {
      entries.push(entry);
      if (entries.length === 2) controller.abort();
    }
    // The abort checkpoint is per entry: entry 3 must not be yielded.
    expect(entries.length).toBe(2);
  });

  it('yields nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const entries: string[] = [];
    for await (const entry of jian.iterdir(tempDir, { signal: controller.signal })) {
      entries.push(entry);
    }
    expect(entries.length).toBe(0);
  });

  it('combines maxEntries with a signal without throwing', async () => {
    const controller = new AbortController();
    const entries: string[] = [];
    for await (const entry of jian.iterdir(tempDir, { signal: controller.signal, maxEntries: 3 })) {
      entries.push(entry);
    }
    expect(entries.length).toBe(3);
  });
});

describe('LocalJian.readLines cancellation', () => {
  let jian: LocalJian;
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    jian = await LocalJian.create();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'jian-readlines-cancel-')));
    await jian.chdir(tempDir);
    filePath = join(tempDir, 'lines.txt');
    const content = Array.from({ length: 50 }, (_, i) => `line-${String(i)}`).join('\n') + '\n';
    await writeFile(filePath, content, 'utf8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('reads all 50 lines when no signal is passed (compat)', async () => {
    const lines: string[] = [];
    for await (const line of jian.readLines(filePath)) {
      lines.push(line);
    }
    expect(lines.length).toBe(50);
  });

  it('stops mid-iteration when the signal aborts (default UTF-8 path)', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    for await (const line of jian.readLines(filePath, { signal: controller.signal })) {
      lines.push(line);
      if (lines.length === 3) controller.abort();
    }
    expect(lines.length).toBe(3);
  });

  it('stops mid-iteration under errors="replace"', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    for await (const line of jian.readLines(filePath, {
      errors: 'replace',
      signal: controller.signal,
    })) {
      lines.push(line);
      if (lines.length === 3) controller.abort();
    }
    expect(lines.length).toBe(3);
  });

  it('stops mid-iteration under errors="ignore"', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    for await (const line of jian.readLines(filePath, {
      errors: 'ignore',
      signal: controller.signal,
    })) {
      lines.push(line);
      if (lines.length === 3) controller.abort();
    }
    expect(lines.length).toBe(3);
  });

  it('yields nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const lines: string[] = [];
    for await (const line of jian.readLines(filePath, { signal: controller.signal })) {
      lines.push(line);
    }
    expect(lines.length).toBe(0);
  });
});
