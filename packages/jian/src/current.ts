import { AsyncLocalStorage } from 'node:async_hooks';

import { JianError } from './errors';
import type { Jian } from './jian';
import type { JianProcess } from './process';
import type { StatResult } from './types';

const jianStorage = new AsyncLocalStorage<Jian>();

/**
 * Return the {@link Jian} instance bound to the current async context.
 *
 * Throws if nothing is bound — callers must wrap their entry point in
 * {@link runWithJian} or call {@link setCurrentJian} once at startup.
 */
export function getCurrentJian(): Jian {
  const store = jianStorage.getStore();
  if (store === undefined) {
    throw new JianError(
      'No Jian is bound to the current async context. Call `setCurrentJian(await LocalJian.create())` once at startup, or wrap the call in `runWithJian(...)`.',
    );
  }
  return store;
}

/**
 * Bind `jian` as the current instance for the running async context tree.
 * Intended for a one-shot call at process startup (e.g. in a test setup
 * file). Subsequent code in the same context — including nested awaits —
 * resolves {@link getCurrentJian} to this instance unless overridden by
 * {@link runWithJian}.
 */
export function setCurrentJian(jian: Jian): void {
  jianStorage.enterWith(jian);
}

/**
 * Run `fn` with `jian` bound as the current Jian instance for its async
 * subtree. Concurrent calls do not pollute each other — bindings are
 * scoped to the {@link AsyncLocalStorage} context.
 */
export function runWithJian<T>(jian: Jian, fn: () => T): T {
  return jianStorage.run(jian, fn);
}

// Module-level convenience functions for the current Jian instance.

export function readText(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): Promise<string> {
  return getCurrentJian().readText(path, options);
}

export function writeText(
  path: string,
  data: string,
  options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
): Promise<number> {
  return getCurrentJian().writeText(path, data, options);
}

export function readLines(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): AsyncGenerator<string> {
  return getCurrentJian().readLines(path, options);
}

export function exec(...args: string[]): Promise<JianProcess> {
  return getCurrentJian().exec(...args);
}

export function readBytes(path: string, n?: number): Promise<Buffer> {
  return getCurrentJian().readBytes(path, n);
}

export function writeBytes(path: string, data: Buffer): Promise<number> {
  return getCurrentJian().writeBytes(path, data);
}

export function stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
  return getCurrentJian().stat(path, options);
}

export function mkdir(
  path: string,
  options?: { parents?: boolean; existOk?: boolean },
): Promise<void> {
  return getCurrentJian().mkdir(path, options);
}

export function iterdir(path: string): AsyncGenerator<string> {
  return getCurrentJian().iterdir(path);
}

export function glob(
  path: string,
  pattern: string,
  options?: { caseSensitive?: boolean },
): AsyncGenerator<string> {
  return getCurrentJian().glob(path, pattern, options);
}

export function chdir(path: string): Promise<void> {
  return getCurrentJian().chdir(path);
}

export function getcwd(): string {
  return getCurrentJian().getcwd();
}

export function gethome(): string {
  return getCurrentJian().gethome();
}

export function normpath(path: string): string {
  return getCurrentJian().normpath(path);
}

export function pathClass(): 'posix' | 'win32' {
  return getCurrentJian().pathClass();
}

export function execWithEnv(args: string[], env?: Record<string, string>): Promise<JianProcess> {
  return getCurrentJian().execWithEnv(args, env);
}
