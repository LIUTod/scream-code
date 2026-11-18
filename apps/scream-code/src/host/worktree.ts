/**
 * A background task that acts on a git repository works in a worktree of its
 * own, never in the person's checkout.
 *
 * Nobody watches a background run, and the person may be working in the same
 * repository at that very moment: edits landing in their working tree would
 * mix with theirs, and a run that goes wrong would leave a mess there. So each
 * run gets `git worktree add` on a branch of its own
 * (`scream/<job>/<yyyymmdd-hhmm>`) under `<home>/worktrees/`, starting from the
 * commit the checkout is on. After the run, whatever changed is committed to
 * that branch by the host (not the agent: committing is not something an
 * unattended run should need permission for), and the worktree directory is
 * removed. The branch stays for the person to read, merge or delete; a run
 * that changed nothing leaves no branch behind.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunWorktree {
  /** The repository the run belongs to (its top level). */
  readonly repo: string;
  /** Where the run works. */
  readonly dir: string;
  readonly branch: string;
  /** The commit the branch started from. */
  readonly base: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function stamp(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Make a worktree for one run of `jobId`, or undefined when `workDir` is not
 * inside a git repository with at least one commit (the run then works in
 * `workDir` itself).
 */
export async function prepareRunWorktree(
  screamHomeDir: string,
  workDir: string,
  jobId: string,
  now: number,
): Promise<RunWorktree | undefined> {
  let repo: string;
  let base: string;
  try {
    repo = await git(workDir, ['rev-parse', '--show-toplevel']);
    base = await git(repo, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return undefined;
  }
  const branchBase = `scream/${jobId}/${stamp(now)}`;
  let branch = branchBase;
  for (let attempt = 2; attempt < 50; attempt++) {
    try {
      await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
      branch = `${branchBase}-${String(attempt)}`;
    } catch {
      break;
    }
  }
  const dir = join(screamHomeDir, 'worktrees', jobId, branch.split('/').at(-1) ?? stamp(now));
  await mkdir(join(screamHomeDir, 'worktrees', jobId), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, dir, base]);
  // A subdirectory of the repository stays the run's working directory.
  const relative = (await git(workDir, ['rev-parse', '--show-prefix']).catch(() => '')).replace(/[\\/]+$/, '');
  return { repo, dir: relative === '' ? dir : join(dir, relative), branch, base };
}

/**
 * Commit what the run changed to its branch and remove the worktree. Returns
 * the branch when it carries changes, undefined when the run changed nothing
 * (the empty branch is deleted then).
 */
export async function finishRunWorktree(worktree: RunWorktree, message: string): Promise<string | undefined> {
  const top = await git(worktree.dir, ['rev-parse', '--show-toplevel']).catch(() => worktree.dir);
  let changed = false;
  try {
    // The run may have committed on its own; anything still uncommitted is
    // committed here, so the branch holds all of it.
    if ((await git(top, ['status', '--porcelain'])) !== '') {
      await git(top, ['add', '-A']);
      await git(top, [
        '-c',
        'user.name=Scream',
        '-c',
        'user.email=scream@localhost',
        'commit',
        '--no-verify',
        '-m',
        message,
      ]);
    }
    changed = (await git(top, ['rev-parse', 'HEAD'])) !== worktree.base;
  } finally {
    await git(worktree.repo, ['worktree', 'remove', '--force', top]).catch(() => '');
  }
  if (!changed) {
    await git(worktree.repo, ['branch', '-D', worktree.branch]).catch(() => '');
    return undefined;
  }
  return worktree.branch;
}

// ─── Worktrees kept for a run that waits on the person ───────────────────

function heldFile(screamHomeDir: string, sessionId: string): string {
  return join(screamHomeDir, 'worktrees', 'held', `${sessionId}.json`);
}

/**
 * Keep a run's worktree after the run: it left something in the inbox, and an
 * approved action must run where the run worked. Released by
 * {@link releaseHeldWorktree} once nothing of that run waits any more.
 */
export async function holdRunWorktree(screamHomeDir: string, sessionId: string, worktree: RunWorktree): Promise<void> {
  await mkdir(join(screamHomeDir, 'worktrees', 'held'), { recursive: true });
  await writeFile(heldFile(screamHomeDir, sessionId), `${JSON.stringify(worktree)}\n`, 'utf8');
}

/** Finish a held worktree (see {@link finishRunWorktree}); undefined when none was held or nothing changed. */
export async function releaseHeldWorktree(
  screamHomeDir: string,
  sessionId: string,
  message: string,
): Promise<string | undefined> {
  let worktree: RunWorktree;
  try {
    worktree = JSON.parse(await readFile(heldFile(screamHomeDir, sessionId), 'utf8')) as RunWorktree;
  } catch {
    return undefined;
  }
  try {
    return await finishRunWorktree(worktree, message);
  } finally {
    await rm(heldFile(screamHomeDir, sessionId), { force: true });
  }
}
