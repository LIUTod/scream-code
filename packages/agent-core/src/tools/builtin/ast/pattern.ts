/**
 * Shared plumbing for the AST tools (@ast-grep/napi).
 *
 * The dependency ships large platform binaries and most sessions never touch
 * structural search, so it is loaded lazily on first use. A failed load
 * degrades to a clear tool error — never a boot failure.
 */
import type { Jian } from '@scream-code/jian';
import { basename } from 'pathe';

export type AstLanguage = 'typescript' | 'tsx' | 'javascript';

export const AST_MAX_MATCHES = 100;
export const AST_MAX_FILES = 200;
const AST_MAX_WALK_DEPTH = 8;
const AST_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next']);

type NapiModule = typeof import('@ast-grep/napi');
let loadOnce: Promise<NapiModule | undefined> | undefined;

/** Load the optional AST engine once; undefined when it cannot be loaded. */
export async function loadAstGrep(): Promise<NapiModule | undefined> {
  loadOnce ??= import('@ast-grep/napi').then(
    (mod) => mod,
    () => undefined,
  );
  return loadOnce;
}

export function inferAstLanguage(path: string): AstLanguage | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'javascript';
  }
  return undefined;
}

export function resolveAstLang(mod: NapiModule, language: AstLanguage) {
  switch (language) {
    case 'typescript':
      return mod.Lang.TypeScript;
    case 'tsx':
      return mod.Lang.Tsx;
    case 'javascript':
      return mod.Lang.JavaScript;
  }
}

/**
 * Out-parameter of `walkAstFiles`: `truncated` is set when the walk stopped at
 * the file cap while candidate entries were still pending, so the caller
 * cannot present its total as complete.
 */
export interface AstWalkState {
  truncated: boolean;
}

/**
 * Separator-agnostic basename for walk entries. `iterdir` yields the platform's
 * own separators (backslashes on Windows), so a hard-coded `/` split leaves the
 * whole path in place and breaks the skip-directory check.
 */
export function pathBasename(entry: string): string {
  return basename(entry);
}

/**
 * Bounded recursive walk for directory searches. Skips build/VCS directories
 * and stops at the file cap; cancellation is cooperative via iterdir's signal.
 * Pass `state` to learn whether the cap cut the walk short.
 */
export async function* walkAstFiles(
  jian: Jian,
  root: string,
  language: AstLanguage | undefined,
  signal?: AbortSignal,
  state?: AstWalkState,
): AsyncGenerator<string> {
  const markTruncated = (): void => {
    if (state !== undefined) state.truncated = true;
  };
  let yielded = 0;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    // Directories are still queued, so more candidates exist beyond the cap.
    if (yielded >= AST_MAX_FILES) {
      markTruncated();
      return;
    }
    const next = stack.pop();
    if (next === undefined) break;
    const { dir, depth } = next;
    const entries: string[] = [];
    try {
      for await (const entry of jian.iterdir(dir, signal !== undefined ? { signal } : undefined)) {
        entries.push(entry);
      }
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Entries of this directory are still unvisited.
      if (yielded >= AST_MAX_FILES) {
        markTruncated();
        return;
      }
      const base = pathBasename(entry);
      let stat;
      try {
        stat = await jian.stat(entry, { followSymlinks: false });
      } catch {
        continue;
      }
      if (isDirectoryMode(stat.stMode)) {
        if (depth + 1 <= AST_MAX_WALK_DEPTH && !AST_SKIP_DIRS.has(base)) {
          stack.push({ dir: entry, depth: depth + 1 });
        }
        continue;
      }
      const inferred = inferAstLanguage(entry);
      if (inferred === undefined) continue;
      if (language !== undefined && inferred !== language) continue;
      yielded += 1;
      yield entry;
    }
  }
}

const METAVAR_RE = new RegExp('\\$([A-Z_][A-Z0-9_]*)', 'g');

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** Stat mode checks — Jian exposes raw st_mode, mirroring git-worktree.ts. */
export function isDirectoryMode(stMode: number): boolean {
  return (stMode & 0o170000) === S_IFDIR;
}

export function isFileMode(stMode: number): boolean {
  return (stMode & 0o170000) === S_IFREG;
}

export interface RewriteExpansion {
  readonly ok: boolean;
  readonly text: string;
  readonly missing: readonly string[];
}

/**
 * Expand `$NAME` metavariables in a rewrite template from one match node.
 * The engine's `replace()` takes final text and does NOT expand `$NAME`, so
 * the substitution lives here. `$$$MULTI` capture expansion is not supported
 * in v1 — callers reject it up front with guidance instead of guessing a
 * joining convention.
 */
export function expandRewrite(
  template: string,
  node: { getMatch(name: string): { text(): string } | null },
): RewriteExpansion {
  const missing = new Set<string>();
  const text = template.replace(METAVAR_RE, (_match, name: string) => {
    const hit = node.getMatch(name);
    if (hit === null) {
      missing.add(name);
      return '$' + name;
    }
    return hit.text();
  });
  return { ok: missing.size === 0, text, missing: [...missing] };
}

export function formatAstMatch(
  displayPath: string,
  node: { range(): { start: { line: number; column: number } }; text(): string },
  maxTextLength = 160,
): string {
  const range = node.range();
  const firstLine = node.text().split('\n', 1)[0] ?? '';
  const text = firstLine.length > maxTextLength ? `${firstLine.slice(0, maxTextLength)}…` : firstLine;
  return `${displayPath}:${range.start.line + 1}:${range.start.column + 1}  ${text}`;
}
