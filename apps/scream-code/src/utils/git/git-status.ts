/**
 * Cached git branch + working-tree status (sidebar Git panel; previously
 * also the footer git badge, which the sidebar now replaces).
 *
 * Branch name refreshes every 5s, porcelain status every 15s. Branch
 * and status reads stay synchronous with short timeouts. Spawn failures
 * keep the previous snapshot instead of flashing an empty working tree.
 */

import { spawnSync } from 'node:child_process';

const BRANCH_TTL_MS = 5_000;
const STATUS_TTL_MS = 15_000;
const SPAWN_TIMEOUT_MS = 500;

/** One porcelain entry: the two-character status code plus the repo-relative
 * path. `status` follows `git status --porcelain` v1 semantics
 * (e.g. "M ", " M", "MM", "??", "R "). */
export interface GitFileEntry {
  readonly status: string;
  readonly path: string;
}

export interface GitStatus {
  readonly branch: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diffAdded: number;
  readonly diffDeleted: number;
  /** Working-tree file entries from `git status --porcelain -b` (excluding the
   * `## branch` header). Consumed by the sidebar Git panel. */
  readonly files: readonly GitFileEntry[];
}

export interface GitStatusCache {
  /** Returns current status, or `null` when workDir is not a git repo. */
  getStatus(): GitStatus | null;
}

interface BranchState {
  value: string | null;
  fetchedAt: number;
}

interface StatusState {
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
  files: GitFileEntry[];
  fetchedAt: number;
}

const AHEAD_BEHIND_RE = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/;

export function createGitStatusCache(workDir: string): GitStatusCache {
  const isRepo = detectGitRepo(workDir);
  let branch: BranchState = { value: null, fetchedAt: 0 };
  let status: StatusState = {
    dirty: false,
    ahead: 0,
    behind: 0,
    diffAdded: 0,
    diffDeleted: 0,
    files: [],
    fetchedAt: 0,
  };

  return {
    getStatus: () => {
      if (!isRepo) return null;

      const now = Date.now();
      if (now - branch.fetchedAt >= BRANCH_TTL_MS) {
        branch = { value: readBranch(workDir), fetchedAt: now };
      }
      if (branch.value === null) return null;

      if (now - status.fetchedAt >= STATUS_TTL_MS) {
        // Keep the previous snapshot on a spawn failure instead of flashing
        // an empty working tree (transient git errors are common on slow
        // filesystems / permission hiccups).
        const next = readStatus(workDir);
        if (next !== null) status = { ...next, fetchedAt: now };
        else status.fetchedAt = now;
      }

      return {
        branch: branch.value,
        dirty: status.dirty,
        ahead: status.ahead,
        behind: status.behind,
        diffAdded: status.diffAdded,
        diffDeleted: status.diffDeleted,
        files: status.files,
      };
    },
  };
}

function detectGitRepo(workDir: string): boolean {
  try {
    const result = spawnSync('git', ['-C', workDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    return result.status === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function readBranch(workDir: string): string | null {
  try {
    const result = spawnSync('git', ['-C', workDir, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (result.status !== 0) return null;
    const name = result.stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Strip the quoting/escaping `git status --porcelain` applies when
 * `core.quotePath` is active and the path contains special characters. The
 * same semantics as the web server's parser: JSON.parse handles the C-style
 * escapes git emits; exotic cases stay literal, acceptable for display. */
function unquotePorcelainPath(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Parse one porcelain entry line into a {@link GitFileEntry}. A rename entry
 * ("R  old -> new") keeps the destination path, which is what the user wants
 * to see in a changed-files list. Spaces inside the XY code are dropped
 * ("M " → "M", "MM" stays), matching the web client's status label. */
function parsePorcelainEntry(line: string): GitFileEntry {
  const status = line.slice(0, 2).replaceAll(' ', '');
  let path = line.length > 3 ? line.slice(3).trim() : '';
  const arrow = path.indexOf(' -> ');
  if (arrow !== -1) path = path.slice(arrow + 4);
  return { status, path: unquotePorcelainPath(path) };
}

/** Returns null when the porcelain read fails (spawn error / non-zero exit);
 * the caller keeps the previous snapshot on failure. */
function readStatus(workDir: string): StatusState | null {
  try {
    const result = spawnSync('git', ['-C', workDir, 'status', '--porcelain', '-b'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) return null;

    let dirty = false;
    let ahead = 0;
    let behind = 0;
    const files: GitFileEntry[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('## ')) {
        const m = AHEAD_BEHIND_RE.exec(line);
        if (m) {
          ahead = Number.parseInt(m[1] ?? '0', 10) || 0;
          behind = Number.parseInt(m[2] ?? '0', 10) || 0;
        }
      } else if (line.trim().length > 0) {
        dirty = true;
        files.push(parsePorcelainEntry(line));
      }
    }
    const diff = dirty ? readDiffStats(workDir) : { added: 0, deleted: 0 };
    return {
      dirty,
      ahead,
      behind,
      diffAdded: diff.added,
      diffDeleted: diff.deleted,
      files,
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function readDiffStats(workDir: string): { added: number; deleted: number } {
  try {
    const result = spawnSync('git', ['-C', workDir, 'diff', '--numstat', 'HEAD', '--'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) return { added: 0, deleted: 0 };

    let added = 0;
    let deleted = 0;
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const [addedText, deletedText] = line.split('\t');
      added += parseDiffNumstatCount(addedText);
      deleted += parseDiffNumstatCount(deletedText);
    }
    return { added, deleted };
  } catch {
    return { added: 0, deleted: 0 };
  }
}

function parseDiffNumstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
