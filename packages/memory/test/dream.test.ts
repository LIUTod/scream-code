import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DreamTracker } from '../src/dream.js';

describe('DreamTracker', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('persists the lock file directly under the scream home directory', async () => {
    const tracker = new DreamTracker(tmpDir);
    await tracker.init();
    await tracker.recordDream();

    const lockPath = join(tmpDir, 'dream-lock.json');
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toMatchObject({
      version: 1,
      state: {
        sessionsSinceLastDream: 0,
      },
    });
    expect(new Date(parsed.state.lastDreamAt).getTime()).toBeGreaterThan(0);
  });

  it('leaves no temp file behind after a successful write', async () => {
    const tracker = new DreamTracker(tmpDir);
    await tracker.init();
    await tracker.recordDream();

    // The write goes through a temp file + rename, so the directory holds the
    // state file and nothing else once it returns.
    expect(await readdir(tmpDir)).toEqual(['dream-lock.json']);
  });

  it('keeps the previous state file when the atomic swap fails, without throwing', async () => {
    // A directory at the lock path makes the rename fail after the temp file
    // has been written — the case the cleanup path exists for.
    const lockPath = join(tmpDir, 'dream-lock.json');
    await mkdir(lockPath);

    const tracker = new DreamTracker(tmpDir);
    await tracker.init();
    // Non-critical persistence: a failed write must not reach the caller.
    await expect(tracker.recordDream()).resolves.toBeUndefined();

    expect(await readdir(tmpDir)).toEqual(['dream-lock.json']);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
  });

  it('loads persisted state across tracker restarts', async () => {
    const first = new DreamTracker(tmpDir);
    await first.init();
    await first.recordNewSession();
    await first.recordNewSession();

    const second = new DreamTracker(tmpDir);
    await second.init();

    // A fresh tracker with the same path should not suggest yet because not
    // enough time has passed, but it should keep the session counter.
    expect(second.shouldSuggest()).toBe(false);

    // Bump the counter on the loaded tracker until it reaches the threshold.
    for (let i = 0; i < 3; i++) {
      await second.recordNewSession();
    }

    // Still not enough time; only the session threshold is met.
    expect(second.shouldSuggest()).toBe(false);
  });

  it('suggests a dream after enough time and sessions have passed', async () => {
    const lockPath = join(tmpDir, 'dream-lock.json');
    const oldState = {
      version: 1,
      state: {
        lastDreamAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        sessionsSinceLastDream: 5,
      },
    };
    await writeFile(lockPath, JSON.stringify(oldState), 'utf8');

    const tracker = new DreamTracker(tmpDir);
    await tracker.init();

    expect(tracker.shouldSuggest()).toBe(true);
    expect(tracker.getSuggestionMessage()).toContain('距离上次记忆整理已过去');
  });

  it('migrates legacy lock files to the new global location', async () => {
    const legacyDir = join(tmpDir, '.scream-code');
    await mkdir(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'dream-lock.json');
    const legacyState = {
      version: 1,
      state: {
        lastDreamAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        sessionsSinceLastDream: 3,
      },
    };
    await writeFile(legacyPath, JSON.stringify(legacyState), 'utf8');

    const tracker = new DreamTracker(tmpDir);
    await tracker.init();

    expect(tracker.shouldSuggest()).toBe(false);

    const newPath = join(tmpDir, 'dream-lock.json');
    const raw = await readFile(newPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.state.sessionsSinceLastDream).toBe(3);

    await expect(stat(legacyPath)).rejects.toThrow();
  });

  it('resets the session counter after recording a dream', async () => {
    const tracker = new DreamTracker(tmpDir);
    await tracker.init();
    for (let i = 0; i < 10; i++) {
      await tracker.recordNewSession();
    }
    await tracker.recordDream();

    const after = new DreamTracker(tmpDir);
    await after.init();
    expect(after.shouldSuggest()).toBe(false);
  });
});
