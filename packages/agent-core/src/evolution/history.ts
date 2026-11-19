/**
 * The history of what Scream changed about itself: its skills and its
 * memories, kept in a git repository at `<home>/evolution`.
 *
 * The repository mirrors two things: `skills/` (a copy of `<home>/skills`)
 * and `memory/<id>.json` (one file per memory, so a change to one memory is a
 * change to one file). {@link snapshotEvolution} copies the live state in and
 * commits it when anything changed — around every self-review run, and
 * before a rollback so nothing live is lost. {@link rollbackEvolution} undoes
 * one change: it reverts that commit in the repository and writes the files
 * it touched back to the live skills and memories.
 *
 * Plugins are not mirrored here: they keep their own rollback.
 *
 * Needs `git` on PATH; without it the history is unavailable and says so.
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { sharedMemoStore, type MemoryMemo } from '@scream-code/memory';

const execFileAsync = promisify(execFile);

export interface EvolutionChange {
  readonly sha: string;
  readonly at: number;
  readonly message: string;
  /** Paths in the repository the change touched (`skills/…`, `memory/<id>.json`). */
  readonly files: readonly string[];
}

export type EvolutionResult = { readonly ok: true; readonly sha?: string } | { readonly ok: false; readonly error: string };

export function evolutionDir(screamHomeDir: string): string {
  return join(screamHomeDir, 'evolution');
}

async function git(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repo, '-c', 'user.name=Scream', '-c', 'user.email=scream@localhost', '-c', 'core.autocrlf=false', ...args],
    { timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.trim();
}

async function ensureRepo(screamHomeDir: string): Promise<string> {
  const repo = evolutionDir(screamHomeDir);
  if (!existsSync(join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true });
    await git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'README.md'), 'What Scream changed about itself (skills and memories). Managed by Scream.\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '--no-verify', '-m', 'start']);
  }
  return repo;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

function memoFileText(memo: MemoryMemo): string {
  // Recall counters are bookkeeping, not content: mirroring them would turn
  // every recall into a "memory changed" entry in the history.
  const { recallCount: _recallCount, lastRecalledAt: _lastRecalledAt, ...content } = memo;
  return `${JSON.stringify(JSON.parse(stableJson(content)) as unknown, null, 2)}\n`;
}

async function allMemos(screamHomeDir: string): Promise<MemoryMemo[]> {
  const store = sharedMemoStore(screamHomeDir);
  await store.init();
  const memos: MemoryMemo[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await store.list({ limit: 200, offset });
    for (const summary of page.memos) {
      const memo = await store.get(summary.id);
      if (memo !== undefined) memos.push(memo);
    }
    if (page.memos.length < 200) break;
  }
  return memos;
}

/** Copy the live skills and memories into the repository's working tree. */
async function mirrorLive(screamHomeDir: string, repo: string): Promise<void> {
  const skillsMirror = join(repo, 'skills');
  rmSync(skillsMirror, { recursive: true, force: true });
  const liveSkills = join(screamHomeDir, 'skills');
  if (existsSync(liveSkills)) {
    cpSync(liveSkills, skillsMirror, {
      recursive: true,
      // Skills are text; links and bulky dependency folders are not history.
      filter: (source) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(source),
      verbatimSymlinks: true,
    });
  }
  const memoryMirror = join(repo, 'memory');
  rmSync(memoryMirror, { recursive: true, force: true });
  mkdirSync(memoryMirror, { recursive: true });
  for (const memo of await allMemos(screamHomeDir)) {
    writeFileSync(join(memoryMirror, `${memo.id}.json`), memoFileText(memo), 'utf8');
  }
}

/**
 * Commit the live skills and memories as one change named `message`, when
 * anything changed since the last one. Resolves with the new commit, or
 * without one when nothing changed.
 */
export async function snapshotEvolution(screamHomeDir: string, message: string): Promise<EvolutionResult> {
  try {
    const repo = await ensureRepo(screamHomeDir);
    await mirrorLive(screamHomeDir, repo);
    await git(repo, ['add', '-A']);
    if ((await git(repo, ['status', '--porcelain'])) === '') return { ok: true };
    await git(repo, ['commit', '-q', '--no-verify', '-m', message.slice(0, 500)]);
    return { ok: true, sha: await git(repo, ['rev-parse', 'HEAD']) };
  } catch (error) {
    return { ok: false, error: describeGitError(error) };
  }
}

/** The newest changes first (the repository's first commit is left out). */
export async function listEvolution(screamHomeDir: string, limit = 30): Promise<EvolutionChange[]> {
  const repo = evolutionDir(screamHomeDir);
  if (!existsSync(join(repo, '.git'))) return [];
  let log: string;
  try {
    log = await git(repo, ['log', `-n${String(limit + 1)}`, '--name-only', '--format=%x1e%H%x1f%ct%x1f%s']);
  } catch {
    return [];
  }
  const changes: EvolutionChange[] = [];
  for (const block of log.split('\u001E')) {
    const [header = '', ...rest] = block.trim().split('\n');
    const [sha, at, message] = header.split('\u001F');
    if (sha === undefined || sha === '' || at === undefined) continue;
    const files = rest.map((line) => line.trim()).filter((line) => line !== '' && line !== 'README.md');
    if (files.length === 0 && message === 'start') continue;
    changes.push({ sha, at: Number(at) * 1000, message: message ?? '', files });
  }
  return changes.slice(0, limit);
}

/** The change's diff, for reading (`git show --stat` plus the patch, capped). */
export async function showEvolutionChange(screamHomeDir: string, sha: string, maxChars = 20_000): Promise<string> {
  const text = await git(evolutionDir(screamHomeDir), ['show', '--stat', '--patch', '--format=%s%n', sha]);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

/**
 * Undo one change. The live state is committed first (so nothing unrecorded
 * is lost), then the change is reverted in the repository and every file it
 * touched is written back: a skill file restored or removed, a memory
 * restored, rewritten or deleted. Fails without changing anything live when
 * a later change touched the same lines (git cannot revert it cleanly).
 */
export async function rollbackEvolution(screamHomeDir: string, sha: string): Promise<EvolutionResult> {
  const repo = evolutionDir(screamHomeDir);
  if (!existsSync(join(repo, '.git'))) return { ok: false, error: 'no history yet' };
  let message: string;
  let files: string[];
  try {
    message = await git(repo, ['log', '-n1', '--format=%s', sha]);
    files = (await git(repo, ['show', '--name-only', '--format=', sha])).split('\n').filter((line) => line.trim() !== '');
  } catch (error) {
    return { ok: false, error: describeGitError(error) };
  }
  const before = await snapshotEvolution(screamHomeDir, 'changes made outside a recorded step');
  if (!before.ok) return before;
  try {
    await git(repo, ['revert', '--no-commit', sha]);
  } catch (error) {
    await git(repo, ['revert', '--abort']).catch(() => '');
    await git(repo, ['reset', '--hard', '-q', 'HEAD']).catch(() => '');
    return { ok: false, error: `a later change touched the same content (${describeGitError(error)})` };
  }
  try {
    await applyFilesToLive(screamHomeDir, repo, files);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `rollback: ${message}`.slice(0, 500)]);
    return { ok: true, sha: await git(repo, ['rev-parse', 'HEAD']) };
  } catch (error) {
    return { ok: false, error: describeGitError(error) };
  }
}

async function applyFilesToLive(screamHomeDir: string, repo: string, files: readonly string[]): Promise<void> {
  const store = sharedMemoStore(screamHomeDir);
  await store.init();
  for (const file of files) {
    const mirrored = join(repo, file);
    if (file.startsWith('skills/')) {
      const live = join(screamHomeDir, file);
      if (existsSync(mirrored)) {
        mkdirSync(dirname(live), { recursive: true });
        cpSync(mirrored, live);
      } else {
        rmSync(live, { force: true });
        removeEmptyParents(dirname(live), join(screamHomeDir, 'skills'));
      }
      continue;
    }
    const memoId = /^memory\/(.+)\.json$/.exec(file)?.[1];
    if (memoId === undefined) continue;
    if (!existsSync(mirrored)) {
      await store.delete(memoId);
      continue;
    }
    const memo = JSON.parse(readFileSync(mirrored, 'utf8')) as MemoryMemo;
    if ((await store.get(memoId)) === undefined) await store.append(memo);
    else await store.update(memoId, memo);
  }
}

function removeEmptyParents(dir: string, stopAt: string): void {
  let current = dir;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      if (readdirSync(current).length > 0) return;
      rmSync(current, { recursive: true, force: true });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function describeGitError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT') return 'git is not installed (it is needed for the change history)';
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim().split('\n')[0] ?? stderr.trim();
  return error instanceof Error ? error.message : String(error);
}
