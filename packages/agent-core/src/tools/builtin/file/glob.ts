/**
 * GlobTool — file pattern matching.
 *
 * Finds files matching a glob pattern, returned sorted by modification
 * time (most recent first). Uses `jian.glob`.
 *
 * Output convention: `content` shown to the LLM is relativized to the
 * search base to save tokens; `output.paths` keeps absolute paths so
 * downstream Read/Edit can consume them directly.
 *
 * Safety rails:
 *   - Unanchored patterns — those that start with a recursive `**` segment, and
 *     pure wildcards such as `**` or `* / *` — have no literal to bound the walk. They used to be
 *     rejected, but models reach for `**` + extension constantly (a fifth of
 *     all Glob calls in practice), and the output was already bounded by
 *     `MAX_MATCHES` and `MAX_OUTPUT_BYTES`. What is not bounded is the time a
 *     walk of a huge tree takes, so those patterns run under a wall-clock
 *     budget (`UNANCHORED_WALK_BUDGET_MS`) and report a cut-short search as
 *     partial. Anchored patterns are walked as before, with no budget.
 *   - Patterns using brace expansion (`{a,b,c}`) are rejected up-front
 *     because the underlying `_globWalk` treats `{` / `}` as literals,
 *     so such patterns would silently match zero files.
 *   - `.git` and `node_modules` entries are pruned by default
 *     (`DEFAULT_GLOB_EXCLUDES`), so a recursive walk does not stat its
 *     way through VCS and dependency trees. A pattern that names one of
 *     them as its own `/`-separated segment (e.g. one starting with
 *     `node_modules/`) keeps that directory in the walk: explicit
 *     queries still resolve.
 *   - `path` is validated by `resolvePathAccess` in strict mode. Explicit
 *     paths must be absolute and within the workspace roots.
 *   - match count is capped at `MAX_MATCHES`; a separate `YIELD_SAFETY_CAP`
 *     (MAX_MATCHES × 2) on the raw yield stream is a secondary belt that
 *     still terminates the stream if the jian layer's own symlink-cycle
 *     detection were ever absent or bypassed. Primary cycle defense lives
 *     in `packages/jian/src/local.ts:_globWalk` via a path-local visited
 *     inode set.
 */

import type { Jian } from '@scream-code/jian';
import { normalize } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { resolvePathAccessPath } from '../../policies/path-access';
import type { PathClass } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { byteLength, truncateToBytes } from '../../support/result-builder';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { scanCache } from '../../support/scan-cache';
import type { WorkspaceConfig } from '../../support/workspace';
import globDescriptionTemplate from './glob.md';

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files/directories.'),
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to the directory to search in. Defaults to the current working directory.',
    ),
  include_dirs: z
    .boolean()
    .default(true)
    .optional()
    .describe(
      'Whether to include directories in results. Defaults to true. Set false to return only files.',
    ),
});

export type GlobInput = z.Infer<typeof GlobInputSchema>;

export const MAX_MATCHES = 1000;

/**
 * Wall-clock ceiling for walking an unanchored pattern (see the header).
 * Matches found before it fires are returned, marked partial.
 */
export const UNANCHORED_WALK_BUDGET_MS = 8_000;

export interface GlobToolOptions {
  /** Override of {@link UNANCHORED_WALK_BUDGET_MS}; tests use a few milliseconds. */
  readonly unanchoredWalkBudgetMs?: number;
}

/** Byte ceiling for the rendered path list (the match count is not a size cap). */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * Directory basenames the Glob tool prunes by default — see
 * `globExcludesForPattern`. Kept as one exported list so the default and
 * the explicit-pattern guard can never drift apart, and so tests assert
 * against the same source of truth the tool uses.
 */
export const DEFAULT_GLOB_EXCLUDES: readonly string[] = ['.git', 'node_modules'];

/**
 * The basename exclusions to hand jian for `pattern`: the defaults, minus
 * any name the pattern addresses explicitly.
 *
 * "Explicit" means the name appears as its own `/`-separated segment
 * (`node_modules/react/src/main.js`, `src/node_modules/*.js`). Such a
 * pattern is a deliberate query into a normally-pruned tree, so the walk
 * must be allowed in — the point of pruning is to skip trees nobody
 * asked for, not to make them unreachable. A name that only appears
 * inside a wildcard segment (`*node_modules*`) still counts as
 * unaddressed and stays pruned.
 */
export function globExcludesForPattern(pattern: string): readonly string[] {
  const segments = pattern.split('/');
  return DEFAULT_GLOB_EXCLUDES.filter((name) => !segments.includes(name));
}

const GLOB_DESCRIPTION = renderPrompt(globDescriptionTemplate, {
  MAX_MATCHES,
});

/**
 * Path-shape hint appended to the tool description only on a Windows
 * (`win32` path class) backend. The `path` argument accepts both native
 * Windows paths and POSIX-style paths, but matched paths come back in
 * Windows backslash form — a command run through Bash must convert them
 * to forward slashes first. Injected conditionally so non-Windows
 * sessions are not shown a hint that does not apply to them.
 */
export const WINDOWS_PATH_HINT =
  '\n\nWindows note: the `path` argument accepts both Windows paths ' +
  '(e.g. `C:\\Users\\foo`) and POSIX-style paths (e.g. `/c/Users/foo`). Matched paths are ' +
  'returned in Windows backslash form; convert them to forward slashes before ' +
  'using them in a Bash command.';

// POSIX file-type bits from `st_mode` (S_IFMT mask, S_IFDIR directory type).
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/**
 * Tool-level description shown to the LLM at tool declaration time.
 * Tells the model — before any round-trip — which patterns are
 * accepted and which directories are too large to recurse into. Every
 * pattern is accepted except brace expansion; ones with no literal anchor
 * are time-boxed and their results marked partial when cut short. On a Windows backend
 * the description also carries `WINDOWS_PATH_HINT` (path-shape guidance).
 */
export class GlobTool implements BuiltinTool<GlobInput> {
  readonly name = 'Glob' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GlobInputSchema);
  private readonly unanchoredWalkBudgetMs: number;

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
    options: GlobToolOptions = {},
  ) {
    this.unanchoredWalkBudgetMs = options.unanchoredWalkBudgetMs ?? UNANCHORED_WALK_BUDGET_MS;
    this.description =
      this.jian.pathClass() === 'win32'
        ? GLOB_DESCRIPTION + WINDOWS_PATH_HINT
        : GLOB_DESCRIPTION;
  }

  async resolveExecution(args: GlobInput): Promise<ToolExecution> {
    let path: string | undefined;
    if (args.path !== undefined) {
      path = await resolvePathAccessPath(args.path, {
        jian: this.jian,
        workspace: this.workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const searchRoots = [path ?? this.workspace.workspaceDir];
    return {
      accesses: ToolAccesses.searchTree(searchRoots[0]!),
      description: `Searching ${args.pattern}`,
      display: { kind: 'file_io', operation: 'glob', path: searchRoots[0]! },
      approvalRule: literalRulePattern(this.name, args.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: ({ signal }) => this.execution(args, searchRoots, signal),
    };
  }

  private async execution(
    args: GlobInput,
    searchRoots: string[],
    signal?: AbortSignal,
  ): Promise<ExecutableToolResult> {
    signal?.throwIfAborted();
    if (containsBraceExpansion(args.pattern)) {
      return {
        isError: true,
        output:
          `Pattern "${args.pattern}" uses brace expansion (\`{a,b,...}\`), which ` +
          `is not supported by this Glob tool. Split it into separate calls, ` +
          `one pattern per alternative. For example, instead of "*.{ts,tsx}" ` +
          `issue two calls: "*.ts" and "*.tsx".`,
      };
    }

    // Default true. When false, directories yielded by jian are
    // filtered out using the same stat that fuels the mtime sort
    // (no second stat per path).
    const includeDirs = args.include_dirs ?? true;

    // jian.glob silently returns empty for missing or non-directory roots
    // (its _globWalk catches the readdir failure and exits without yielding).
    // Without this pre-check, a Glob against a missing path would report
    // "No matches found" instead of "does not exist", and the model would
    // not realize the search root itself was wrong. iterdir is the right
    // signal: pulling one entry triggers the same readdir that jian.glob
    // would do, so ENOENT/ENOTDIR surface here for the realistic backends
    // before the walker is invoked. Any other failure (e.g. an unmocked
    // test backend that throws "not implemented") falls through silently
    // so the existing jian.glob path still runs.
    for (const root of searchRoots) {
      try {
        // The probe needs at most one entry, and it must not outlive a
        // cancelled tool call: forward the execution signal so jian ends the
        // iteration where the abort fired, and cap the budget at that single
        // entry.
        const iter = this.jian.iterdir(root, { signal, maxEntries: 1 });
        await iter.next();
        if (typeof iter.return === 'function') {
          await iter.return(undefined);
        }
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error) {
          const code = (error as { code?: string }).code;
          if (code === 'ENOENT') {
            return { isError: true, output: `${root} does not exist` };
          }
          if (code === 'ENOTDIR') {
            return { isError: true, output: `${root} is not a directory` };
          }
        }
        // Unknown failure (including unmocked test backends): fall
        // through and let jian.glob run; it will either yield results
        // or its own catch path will surface the error.
      }
    }

    try {
      // Check scan cache before walking. Cached output is keyed by root,
      // pattern, and include_dirs and is invalidated on file writes.
      const cachedOutput = scanCache.get(searchRoots[0]!, args.pattern, includeDirs);
      if (cachedOutput !== undefined) {
        return { output: cachedOutput };
      }

      // Two counters, two jobs:
      //   - `entries.length` caps the *unique* paths we return, so a
      //     truncation warning only fires after MAX_MATCHES real hits.
      //   - `yielded` counts every path the jian stream emits, including
      //     duplicates. Secondary safety belt: the jian `_globWalk`
      //     itself detects symlink cycles, so a well-formed jian layer
      //     never re-yields the same real
      //     file. `yielded` still terminates the stream if that primary
      //     defense were ever absent or bypassed (e.g. a future jian
      //     backend without inode tracking), so the tool layer doesn't
      //     depend on the jian implementation for cycle safety.
      const seen = new Set<string>();
      const entries: Array<{ path: string; mtime: number }> = [];
      const YIELD_SAFETY_CAP = MAX_MATCHES * 2;
      let yielded = 0;
      let truncated = false;

      // Derived from the pattern alone, so the scan cache key above
      // (root + pattern + include_dirs) stays a faithful key for the
      // result: the same pattern always resolves to the same exclusions.
      const exclude = globExcludesForPattern(args.pattern);

      // An unanchored pattern may have to walk an enormous tree to find few
      // matches, so it gets a wall-clock budget on top of the caller's signal.
      // The walker stops gracefully on abort, which is how a budget that ran
      // out is told apart from a cancelled call below.
      const budgetSignal = isUnanchoredPattern(args.pattern)
        ? AbortSignal.timeout(this.unanchoredWalkBudgetMs)
        : undefined;
      const walkSignal =
        budgetSignal === undefined
          ? signal
          : signal === undefined
            ? budgetSignal
            : AbortSignal.any([signal, budgetSignal]);

      outer: for (const root of searchRoots) {
        for await (const filePath of this.jian.glob(root, args.pattern, {
          allowedRoots: [root],
          exclude,
          // Forwarded so an ESC/steer reaches the walker itself: the walk
          // checks per directory entry, which is what stops a pattern with
          // few or no matches (the `yielded % 128` heartbeat below never
          // fires for those, since it only counts yielded matches).
          signal: walkSignal,
        })) {
          yielded++;
          if (signal && yielded % 128 === 0) {
            signal.throwIfAborted();
          }
          if (yielded >= YIELD_SAFETY_CAP) {
            truncated = true;
            break outer;
          }
          if (seen.has(filePath)) continue;
          if (entries.length >= MAX_MATCHES) {
            truncated = true;
            break outer;
          }
          seen.add(filePath);
          let mtime = 0;
          let isDir = false;
          try {
            const st = await this.jian.stat(filePath);
            mtime = st.stMtime ?? 0;
            isDir = (st.stMode & S_IFMT) === S_IFDIR;
          } catch {
            // stat failure — use 0 mtime / assume file so it still surfaces
          }
          // Apply include_dirs *after* marking seen so a filtered dir
          // doesn't re-enter via a later duplicate yield, and *before*
          // pushing to entries so MAX_MATCHES continues to cap output
          // (not pre-filter) size.
          if (!includeDirs && isDir) continue;
          entries.push({ path: filePath, mtime });
        }
      }

      // The walker stops *gracefully* on abort (it returns instead of
      // throwing), so the enumeration above can end because the caller
      // cancelled it. A cancelled search must not be reported — or cached —
      // as a completed one: "No matches found" would be a false negative, and
      // the scan cache would keep serving it until the next file write.
      // Re-check the signal so the abort surfaces as AbortError, exactly as
      // the heartbeat check above and the catch block below expect.
      signal?.throwIfAborted();
      const budgetExhausted = budgetSignal?.aborted === true;

      entries.sort((a, b) => b.mtime - a.mtime);

      const paths = entries.map((e) => e.path);
      // Content shown to the LLM uses paths relative to the search base
      // to save tokens; `output.paths` keeps the absolute form so callers
      // can feed them into Read/Edit without further resolution.
      const pathClass = this.jian.pathClass();
      const relBase = searchRoots[0] ?? this.workspace.workspaceDir;
      const displayLines = paths.map((p) => relativizeIfUnder(p, relBase, pathClass));

      let output: string;
      // Header lines are not paths; the byte-cut accounting has to know how
      // many of the surviving lines are headers rather than matches.
      let headerLines = 0;
      if (entries.length === 0 && !truncated && !budgetExhausted) {
        output = 'No matches found';
      } else {
        const lines: string[] = [];
        if (budgetExhausted) {
          lines.push(
            `[Search stopped after ${String(this.unanchoredWalkBudgetMs / 1000)}s: the tree is large and "${args.pattern}" has no literal anchor, so these results are partial. ` +
              `Pass \`path\` or anchor the pattern with a subdirectory, such as "src/**/*.ts".]`,
          );
          headerLines += 1;
        }
        if (truncated) {
          lines.push(`[Truncated at ${String(MAX_MATCHES)} matches — use a more specific pattern]`);
          lines.push(`Only the first ${String(MAX_MATCHES)} matches are returned.`);
          headerLines += 2;
        }
        lines.push(...displayLines);
        if (!truncated && entries.length === MAX_MATCHES) {
          lines.push(`Found ${String(entries.length)} matches`);
        }
        output = lines.join('\n');
      }
      // A match count cap is not a size cap: 1000 very long paths can still
      // flood the context. Trim on bytes, keep whole lines, and say how many
      // paths were dropped so the caller knows to narrow the pattern.
      if (byteLength(output) > MAX_OUTPUT_BYTES) {
        // Cut on the last newline so the boundary cannot leave half a path
        // (a partial path reads as a real one and gets used).
        const raw = truncateToBytes(output, MAX_OUTPUT_BYTES - 96);
        const lastBreak = raw.lastIndexOf('\n');
        const kept = lastBreak > 0 ? raw.slice(0, lastBreak) : raw;
        // Header lines sit in front of the paths and survive every cut, so they
        // must not be counted as kept paths or the omitted count would be short.
        const keptPaths = Math.max(0, countKeptPaths(kept) - headerLines);
        const omitted = Math.max(1, displayLines.length - keptPaths);
        output = `${kept}\n[...${String(omitted)} paths omitted: output exceeds ${String(MAX_OUTPUT_BYTES / 1024)} KB — narrow the pattern]`;
      }
      // A search that ran out of time is not the answer to its pattern; caching
      // it would keep serving the partial list until the next file write.
      if (!budgetExhausted) scanCache.set(searchRoots[0]!, args.pattern, includeDirs, output);
      return { output };
    } catch (error) {
      // Re-throw AbortError so the tool runtime (runRunnableToolCall) can
      // route it to abortedToolOutput with "do not retry" semantics. Without
      // this, the catch below would swallow it into a generic error result
      // that the model might retry.
      if (signal?.aborted) throw error;
      if (error !== null && typeof error === 'object' && 'code' in error) {
        const code = (error as { code?: string }).code;
        const path = searchRoots[0] ?? this.workspace.workspaceDir;
        if (code === 'ENOENT') {
          return { isError: true, output: `${path} does not exist` };
        }
        if (code === 'ENOTDIR') {
          return { isError: true, output: `${path} is not a directory` };
        }
      }
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }
  }

}

/**
 * If `candidate` is under `base`, return the portion after `base/`.
 * Otherwise return `candidate` unchanged (absolute). Both arguments
 * should be canonical absolute paths.
 */
function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const normCandidate = normalize(candidate);
  const normBase = normalize(base);
  const comparableCandidate = pathClass === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  const comparableBase = pathClass === 'win32' ? normBase.toLowerCase() : normBase;
  if (comparableCandidate === comparableBase) return '.';
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  if (comparableCandidate.startsWith(prefix)) {
    return normCandidate.slice(prefix.length);
  }
  return normCandidate;
}

// Return true iff `pattern` begins with the literal sequence `**` followed
// by a `/`. Such patterns have no literal anchor in front of the recursive
// wildcard, so the walk has nothing to bound it on the left and descends into
// every top-level directory of the search root before any suffix constraint
// can filter.
function startsWithDoubleStarPrefix(pattern: string): boolean {
  return pattern.startsWith('**/');
}

/** A pattern with nothing literal to bound the walk: it starts with a recursive wildcard segment, or is pure wildcards. */
function isUnanchoredPattern(pattern: string): boolean {
  return startsWithDoubleStarPrefix(pattern) || isPureWildcard(pattern);
}

/**
 * Return true if `pattern` is pure wildcards — only `*`, `?`, `**`, `/`.
 * Such patterns have no literal anchor and would enumerate every file
 * under the search root. Backslash-escaped characters (`\X`) count as
 * literals so `\*` or `\?` still means "pattern has an anchor".
 */
function isPureWildcard(pattern: string): boolean {
  if (pattern === '') return false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      // escaped literal — pattern has an anchor
      return false;
    }
    if (ch !== '*' && ch !== '?' && ch !== '/') {
      return false;
    }
  }
  return true;
}

/** Return true iff `pattern` looks like it uses `{a,b,c}` brace expansion. */
function containsBraceExpansion(pattern: string): boolean {
  let inBrace = false;
  let sawCommaInsideBrace = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      i++;
      continue;
    }
    if (ch === '{') {
      inBrace = true;
      sawCommaInsideBrace = false;
      continue;
    }
    if (ch === '}') {
      if (inBrace && sawCommaInsideBrace) return true;
      inBrace = false;
      continue;
    }
    if (ch === ',' && inBrace) sawCommaInsideBrace = true;
  }
  return false;
}

/**
 * Paths that survived the byte cut.
 *
 * The cut backs up to the last newline, so every retained line is a complete
 * path: `newlines + 1`, not `newlines`.
 */
function countKeptPaths(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}
