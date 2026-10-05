/**
 * Guard: "did the user speak?" is answered by a named predicate, never by the
 * message role.
 *
 * Every injection path in the agent writes into history as a user-role message
 * — system reminders (`ContextMemory.appendSystemReminder`), injected context,
 * scheduled notifications, hook results, background completions. So a bare
 * user-role comparison at a call site does not answer "did the user say this";
 * it answers "may this be rendered in the user slot", and any new injection
 * silently changes the meaning of every such check. That failure mode already
 * shipped once: a plan-mode reminder treated its own re-injection as a fresh
 * user turn and re-sent the full reminder on every step.
 *
 * Authorship is defined in exactly one place — `context/identity.ts`, which
 * exports `isRealUserPrompt` (does this message start a user turn the user
 * could undo?) and `isUserAuthoredMessage` (are these the user's own words?).
 * This is a source-shape guard, in the style of `turn-stop-gate.test.ts` and
 * `prompt-placeholders.test.ts`: it reads the real sources, because the point
 * is to fail on the raw comparison itself, wherever it is written.
 *
 * Two roots are scanned on purpose:
 *   - `packages/agent-core/src` — the agent's own history handling;
 *   - `packages/ltod/src/providers` — the wire conversion layer that turns
 *     internal messages into provider requests, where the role is a transport
 *     field and branching on it is mandatory.
 */

import { globSync, readFileSync } from 'node:fs';

import { join, relative } from 'pathe';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const SCAN_ROOTS = ['packages/agent-core/src', 'packages/ltod/src/providers'] as const;

/** The module every authorship question must be routed through. */
const IDENTITY_MODULE = 'packages/agent-core/src/agent/context/identity.ts';

/**
 * Every spelling of a user-role comparison. Single and double quotes, any of
 * `===` / `!==` / `==` / `!=`, and any spacing — a reformatted comparison must
 * not slip past the guard.
 */
const ROLE_USER_RE = /role\s*(?:===|!==|==|!=)\s*(["'])user\1/;

/**
 * The sites where a user-role comparison is legitimate, each one argued for.
 *
 * `file` is repo-relative, `code` is the exact trimmed source line the entry
 * licenses. Licensing the line rather than the file keeps the allowlist
 * precise: a second comparison added elsewhere in the same file still fails.
 * An entry that matches nothing is an error too (see the staleness assertion),
 * so this list cannot rot into a blanket permission.
 */
const ALLOWED_ROLE_USER_SITES: readonly {
  readonly file: string;
  readonly code: string;
  readonly reason: string;
}[] = [
  {
    file: IDENTITY_MODULE,
    code: "if (message.role !== 'user') return false;",
    reason:
      'Definition site of `isRealUserPrompt` — this comparison *is* the predicate.',
  },
  {
    file: IDENTITY_MODULE,
    code: "return message.role === 'user' && message.origin?.kind === 'user';",
    reason:
      'Definition site of `isUserAuthoredMessage` — this comparison *is* the predicate.',
  },
  {
    file: 'packages/agent-core/src/agent/compaction/strategy.ts',
    code: "if (m2.role === 'user') {",
    reason:
      'Retention heuristic: counts how many recent user messages the preserved suffix must keep. It measures message *shape* for the split bound, not authorship.',
  },
  {
    file: 'packages/agent-core/src/agent/compaction/strategy.ts',
    code: "if (m.role === 'user') return false;",
    reason:
      'Split safety (`canSplitAfter`): a transcript must never be cut immediately after a user message, whatever authored it. Shape, not authorship.',
  },
  {
    file: 'packages/agent-core/src/agent/compaction/full.ts',
    code: "if (m.role === 'user') return false;",
    reason:
      'Split safety on `ContextMessage` (`canSplitAfterContext`) — the same rule as `compaction/strategy.ts`, kept in sync deliberately.',
  },
  {
    file: 'packages/agent-core/src/agent/index.ts',
    code: "if (msg.role !== 'user' && msg.role !== 'assistant') continue;",
    reason:
      'Side-question transcript: picks the two role slots worth quoting back and then labels each line with its role. The label is the role; nothing here asks who authored the message.',
  },
  {
    file: 'packages/ltod/src/providers/anthropic.ts',
    code: "if (message.role !== 'user') return false;",
    reason:
      'Provider wire conversion (`isToolResultOnly`): `tool_result` blocks are only legal inside a user-role message, so the transport role is the only question on this path.',
  },
];

interface RoleUserHit {
  /** Repo-relative path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** Trimmed source line, comments excluded. */
  readonly code: string;
}

const QUOTES = new Set(["'", '"', '`']);

/**
 * Blank out line and block comments so prose that *mentions* a role comparison
 * cannot trip the guard, and so a comparison written inside a comment cannot
 * masquerade as a checked one.
 */
function stripComments(line: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? '';
    if (quote !== null) {
      out += char;
      if (char === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (QUOTES.has(char)) {
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && line[i + 1] === '/') break;
    out += char;
  }
  return out;
}

function collectHits(): RoleUserHit[] {
  const hits: RoleUserHit[] = [];
  for (const root of SCAN_ROOTS) {
    const files = globSync('**/*.ts', { cwd: join(REPO_ROOT, root) })
      .map((file) => file.split('\\').join('/'))
      .toSorted();
    for (const file of files) {
      const absolute = join(REPO_ROOT, root, file);
      const lines = readFileSync(absolute, 'utf8').split('\n');
      lines.forEach((raw, index) => {
        const code = stripComments(raw).trim();
        if (!ROLE_USER_RE.test(code)) return;
        const file = relative(REPO_ROOT, absolute).split('\\').join('/');
        hits.push({ file, line: index + 1, code });
      });
    }
  }
  return hits;
}

const hits = collectHits();

/**
 * All `.ts` files the guard actually read, for the self-check below.
 *
 * `globSync` yields host-native separators, so the entries are normalised to
 * `/` before they are compared against the repo-relative constants above — the
 * same normalisation `collectHits()` applies. Without it a Windows walk returns
 * `packages\agent-core\src\…` and the self-check fails against a guard that is
 * in fact scanning exactly the right files.
 */
const scannedFiles = SCAN_ROOTS.flatMap((root) =>
  globSync('**/*.ts', { cwd: join(REPO_ROOT, root) }).map(
    (file) => `${root}/${file.split('\\').join('/')}`,
  ),
);

const allowedKey = (site: { file: string; code: string }) => `${site.file}\u0000${site.code}`;
const allowedKeys = new Set(ALLOWED_ROLE_USER_SITES.map(allowedKey));

function describeHit(hit: RoleUserHit): string {
  return `  ${hit.file}:${String(hit.line)}  ${hit.code}`;
}

describe('context identity — user-role comparisons', () => {
  it('scanned the real sources (a mistyped root must not pass vacuously)', () => {
    expect(
      scannedFiles.length,
      `only ${String(scannedFiles.length)} .ts files were scanned under ` +
        `${SCAN_ROOTS.join(' / ')} — the roots or the walk are wrong, so every ` +
        'assertion below would pass without looking at anything.',
    ).toBeGreaterThan(150);
    expect(
      scannedFiles,
      `the identity module ${IDENTITY_MODULE} was not scanned; the guard is blind ` +
        'to the file that defines the predicates.',
    ).toContain(IDENTITY_MODULE);

    const identitySource = readFileSync(join(REPO_ROOT, IDENTITY_MODULE), 'utf8');
    for (const predicate of ['isRealUserPrompt', 'isUserAuthoredMessage']) {
      expect(
        identitySource.includes(`export function ${predicate}(`),
        `${IDENTITY_MODULE} must export \`${predicate}\` — the single definition the ` +
          'whole agent routes its authorship questions through.',
      ).toBe(true);
    }
  });

  it('finds the comparisons it exists to police', () => {
    expect(
      hits.length,
      'no user-role comparison matched anywhere — the pattern or the comment ' +
        'stripping is broken, so the allowlist below is only being checked against ' +
        'an empty set.',
    ).toBeGreaterThan(0);
  });

  it('argues for every allowlisted site', () => {
    const silent = ALLOWED_ROLE_USER_SITES.filter((entry) => entry.reason.trim().length === 0);
    expect(
      silent.map((entry) => `${entry.file}  ${entry.code}`),
      'Every allowlisted user-role comparison needs a written reason: the entry is a ' +
        'claim that the comparison is not an authorship test, and an unwritten claim ' +
        'cannot be reviewed or revisited.',
    ).toEqual([]);
  });

  it('routes every user-role comparison through the identity predicates', () => {
    const offenders = hits
      .filter((hit) => !allowedKeys.has(allowedKey(hit)))
      .map(
        (hit) =>
          `${describeHit(hit)}\n` +
          '      → authorship must be asked through `isRealUserPrompt()` (does this ' +
          'message start a user turn the user could undo?) or `isUserAuthoredMessage()` ' +
          '(are these the user\'s own words?), both from ' +
          '`agent/context/identity.ts`. Injections, system reminders, notifications, ' +
          'hook results and model-triggered skills all land in history as user-role ' +
          'messages, so this comparison is true for messages the user never sent. If ' +
          'the comparison is genuinely not an authorship test, add a line to ' +
          '`ALLOWED_ROLE_USER_SITES` in test/agent/context-identity-guard.test.ts with ' +
          'the reason it is not.',
      );

    expect(
      offenders,
      'user-role comparisons outside the identity predicates:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('keeps the allowlist free of entries that no longer license anything', () => {
    const stale = ALLOWED_ROLE_USER_SITES.filter(
      (entry) => !hits.some((hit) => allowedKey(hit) === allowedKey(entry)),
    ).map((entry) => `${entry.file}  ${entry.code}`);
    expect(
      stale,
      'these allowlist entries match no source line any more — the code moved or was ' +
        'rewritten, and the entry is now a permission with no subject. Re-point it at ' +
        'the current line or drop it.',
    ).toEqual([]);
  });
});
