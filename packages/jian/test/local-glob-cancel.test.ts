/**
 * `LocalJian.glob` cancellation (`signal`) and physical-revisit-bound
 * coverage.
 *
 * Counting seam: `stat` / `readdir` from `node:fs/promises` are wrapped by a
 * module mock that delegates to the real implementations and counts calls.
 * That is what lets these tests assert *how much of the tree a walk touched*
 * — the property that actually broke (a walk nobody reads from anymore keeps
 * running) — instead of only what it returned.
 *
 * `#/local` is instantiated by `test/setup.ts` before this file runs, so a
 * static import would bind the real `node:fs/promises` and silently skip the
 * mock; the class is therefore re-imported after `vi.resetModules()`.
 *
 * Symlink fixtures are skipped on Windows: creating a symlink there needs
 * Developer Mode or elevation. Same convention as the symlink tests in
 * `local.test.ts`.
 */

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  statCount: 0,
  readdirCount: 0,
  /** Called synchronously after every successful `stat` — the seam the
   *  "abort lands mid-walk" test uses to fire its controller from *inside*
   *  the traversal. */
  afterStat: undefined as (() => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const statImpl = actual.stat as unknown as (...args: unknown[]) => Promise<unknown>;
  const readdirImpl = actual.readdir as unknown as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    stat: async (...args: unknown[]) => {
      control.statCount++;
      const result = await statImpl(...args);
      control.afterStat?.();
      return result;
    },
    readdir: async (...args: unknown[]) => {
      control.readdirCount++;
      return readdirImpl(...args);
    },
  };
});

// `LocalJian`'s constructor is private; reach the instance type through the
// async factory instead.
type LocalJianInstance = Awaited<ReturnType<(typeof import('#/local'))['LocalJian']['create']>>;
let LocalJianCtor: (typeof import('#/local'))['LocalJian'];

beforeAll(async () => {
  vi.resetModules();
  LocalJianCtor = (await import('#/local')).LocalJian;
});

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

describe('LocalJian.glob cancellation', () => {
  let jian: LocalJianInstance;
  let tempDir: string;

  beforeEach(async () => {
    control.afterStat = undefined;
    jian = await LocalJianCtor.create();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'jian-glob-cancel-')));
    await jian.chdir(tempDir);
    // Start counting after the fixture-independent setup (chdir stats).
    control.statCount = 0;
    control.readdirCount = 0;
  });

  afterEach(async () => {
    control.afterStat = undefined;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  /** `dirs` directories under the walk root, each holding `files` .txt files. */
  async function buildTree(dirs: number, files: number): Promise<void> {
    for (let d = 0; d < dirs; d++) {
      const dir = join(tempDir, `d${String(d)}`);
      await mkdir(dir);
      for (let f = 0; f < files; f++) {
        await writeFile(join(dir, `f${String(d)}-${String(f)}.txt`), 'x');
      }
    }
  }

  it('touches no filesystem at all when the signal is already aborted', async () => {
    await buildTree(2, 3);
    const controller = new AbortController();
    controller.abort();

    const matches = await collect(jian.glob(tempDir, '**/*.txt', { signal: controller.signal }));

    expect(matches).toEqual([]);
    expect(control.statCount).toBe(0);
    expect(control.readdirCount).toBe(0);
  });

  it('stops at the next directory entry when the signal aborts mid-walk', async () => {
    await buildTree(6, 60);
    const controller = new AbortController();
    const iterator = jian.glob(tempDir, '**/*.txt', { signal: controller.signal });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(control.statCount).toBeGreaterThan(0);

    // The walk is parked on a `yield` here. The abort must be honoured on the
    // very next step, not after the ~360 entries still queued ahead.
    const statsAtAbort = control.statCount;
    const readdirsAtAbort = control.readdirCount;
    controller.abort();
    const rest = await collect(iterator);

    expect(rest).toEqual([]);
    // Unwinding is free: every enclosing frame re-checks the signal before
    // its next entry, so nothing further is stat-ed or read.
    expect(control.statCount).toBe(statsAtAbort);
    expect(control.readdirCount).toBe(readdirsAtAbort);
  });

  it('bounds entry accesses when the abort lands mid-walk', async () => {
    await buildTree(6, 60); // 6 dirs + 360 files → 367 stats for a full walk
    const controller = new AbortController();
    const abortAfter = 25;
    control.afterStat = () => {
      if (control.statCount >= abortAfter) controller.abort();
    };

    const matches = await collect(jian.glob(tempDir, '**/*.txt', { signal: controller.signal }));

    // Only the entry already in flight on each level can still complete, so
    // the walk stops a hair above the abort point instead of running through
    // the remaining ~340 entries.
    expect(control.statCount).toBeLessThanOrEqual(abortAfter + 12);
    // Matches already delivered stay delivered (they are real matches); the
    // point is that the walk never reaches the remaining directories — a full
    // walk yields 360.
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThan(120);
  });

  it('yields exactly the same matches when a live signal is passed', async () => {
    await buildTree(2, 3);

    const plain = await collect(jian.glob(tempDir, '**/*.txt'));
    const controlled = await collect(
      jian.glob(tempDir, '**/*.txt', { signal: new AbortController().signal }),
    );

    expect(plain).toHaveLength(6);
    expect(controlled).toEqual(plain);
  });
});

describe('LocalJian.glob physical-revisit bound', () => {
  let jian: LocalJianInstance;
  let tempDir: string;

  beforeEach(async () => {
    control.afterStat = undefined;
    jian = await LocalJianCtor.create();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'jian-glob-revisit-')));
    await jian.chdir(tempDir);
    control.statCount = 0;
    control.readdirCount = 0;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it.skipIf(process.platform === 'win32')(
    'enters one physical directory at most twice — a 3rd alias yields nothing',
    async () => {
      const root = join(tempDir, 'alias-root');
      const target = join(tempDir, 'alias-target');
      await mkdir(root);
      await mkdir(target);
      await writeFile(join(target, 'shared.txt'), 'x');
      for (const alias of ['a', 'b', 'c']) {
        await symlink(target, join(root, alias));
      }

      const matches = await collect(jian.glob(root, '**/*.txt'));

      // Budget per physical directory: the first entry plus one revisit. The
      // 3rd alias to `alias-target` is the 3rd entry and is skipped — which is
      // what stops alias counts from multiplying a walk. (readdir order is not
      // guaranteed, so the test pins the *count*, not which two aliases win.)
      expect(matches).toHaveLength(2);
      const aliasDirs = new Set(
        matches.map((match) => match.slice(root.length + 1).split(/[/\\]/)[0]),
      );
      expect(aliasDirs.size).toBe(2);
      for (const alias of aliasDirs) expect(['a', 'b', 'c']).toContain(alias);
      expect(matches.every((match) => match.endsWith('shared.txt'))).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a dense symlink farm proportional to the physical tree',
    async () => {
      const root = join(tempDir, 'farm');
      await mkdir(root);
      const packages = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((name) => join(root, name));
      for (const pkg of packages) {
        await mkdir(join(pkg, 'node_modules'), { recursive: true });
        await writeFile(join(pkg, 'leaf.txt'), 'x');
      }
      // Every package aliases every other one — pnpm's `.pnpm` shape, densest
      // form. Path-local cycle detection alone admits ~1956 distinct alias
      // paths through this 6-node graph, each re-reading and re-stating the
      // same physical directories.
      for (const pkg of packages) {
        for (const other of packages) {
          if (other === pkg) continue;
          await symlink(other, join(pkg, 'node_modules', basename(other)));
        }
      }

      const statsBefore = control.statCount;
      const readdirBefore = control.readdirCount;
      const matches = await collect(jian.glob(root, '**/*.txt'));
      const stats = control.statCount - statsBefore;
      const readdirs = control.readdirCount - readdirBefore;

      // 13 physical directories (root + 6 packages + 6 node_modules), ~19
      // entries. Each is entered at most twice, so the walk is bounded by the
      // physical tree instead of by the alias-path count — measured 91 stats
      // / 50 readdirs / 12 matches here, versus ~11.7k / ~2k / ~1956 when the
      // walk follows every alias path (path-local visited set only).
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.length).toBeLessThanOrEqual(30);
      expect(stats).toBeLessThanOrEqual(200);
      expect(readdirs).toBeLessThanOrEqual(100);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still follows both aliases of the same target when there are exactly two',
    async () => {
      // The bound must not change the case two aliases represent (the
      // semantics `local.test.ts` T-C6 pins): both aliases traverse.
      const root = join(tempDir, 'two-alias-root');
      const target = join(tempDir, 'two-alias-target');
      await mkdir(root);
      await mkdir(target);
      await writeFile(join(target, 'shared.txt'), 'x');
      await symlink(target, join(root, 'a'));
      await symlink(target, join(root, 'b'));

      const matches = await collect(jian.glob(root, '**/*.txt'));

      expect(matches).toHaveLength(2);
    },
  );
});
