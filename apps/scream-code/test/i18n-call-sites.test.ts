/**
 * Guards the one i18n mistake the compiler cannot see: `t()` takes its key and
 * its params as plain strings and objects, so a typo in either is silent — the
 * user just reads `lifecycle.memory_done` or a literal `{limit}` on screen.
 *
 * For every `t('literal.key', { … })` call in the app source this checks that
 *   1. the key exists in the dictionaries, and
 *   2. the call supplies every `{placeholder}` the key's text uses (in either
 *      language — the parity test in `packages/config` keeps them equal).
 *
 * Calls whose key is not a literal, or whose params are not an object literal
 * (a variable, a spread), cannot be judged statically and are skipped; the
 * count of judged calls is asserted so a broken scanner cannot pass by
 * judging nothing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getLocale, setLocale, t, type Locale } from '@scream-code/config';
import { afterAll, describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  /** Param names supplied by the call; null when they cannot be known statically. */
  readonly given: ReadonlySet<string> | null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/**
 * Split the object literal starting at `source[open] === '{'` into its
 * top-level property chunks, honouring strings, template literals (including
 * `${…}`), comments and nested brackets. Returns undefined when unbalanced.
 */
function topLevelProperties(source: string, open: number): string[] | undefined {
  const chunks: string[] = [];
  let depth = 0;
  let chunk = '';
  for (let i = open; i < source.length; i += 1) {
    const char = source[i] as string;
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return undefined;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      i = end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== char) {
        if (source[j] === '\\') j += 1;
        else if (char === '`' && source[j] === '$' && source[j + 1] === '{') {
          let inner = 1;
          j += 2;
          while (j < source.length && inner > 0) {
            if (source[j] === '{') inner += 1;
            else if (source[j] === '}') inner -= 1;
            j += 1;
          }
          continue;
        }
        j += 1;
      }
      chunk += source.slice(i, j + 1);
      i = j;
      continue;
    }
    if ('({['.includes(char)) {
      depth += 1;
      if (depth > 1) chunk += char;
      continue;
    }
    if (')}]'.includes(char)) {
      depth -= 1;
      if (depth === 0) {
        chunks.push(chunk);
        return chunks;
      }
      chunk += char;
      continue;
    }
    if (char === ',' && depth === 1) {
      chunks.push(chunk);
      chunk = '';
      continue;
    }
    chunk += char;
  }
  return undefined;
}

const PROPERTY_NAME = /^\s*(?:\[\s*)?(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))(?:\s*\])?\s*(?::|$)/;

/** Every `t('literal')` call in `source`, with the param names it supplies. */
export function findCallSites(source: string, file = 'inline'): CallSite[] {
  const sites: CallSite[] = [];
  for (const match of source.matchAll(/\bt\(\s*(['"])([A-Za-z0-9_.-]+)\1\s*([,)])/g)) {
    const key = match[2] as string;
    const line = source.slice(0, match.index).split('\n').length;
    if (match[3] === ')') {
      sites.push({ file, line, key, given: new Set() });
      continue;
    }
    let open = (match.index ?? 0) + match[0].length;
    while (/\s/.test(source[open] ?? '')) open += 1;
    if (source[open] !== '{') {
      sites.push({ file, line, key, given: null }); // params passed as a variable
      continue;
    }
    const chunks = topLevelProperties(source, open);
    if (chunks === undefined || chunks.some((c) => c.trim().startsWith('...'))) {
      sites.push({ file, line, key, given: null });
      continue;
    }
    const names = chunks.flatMap((c) => {
      const named = PROPERTY_NAME.exec(c);
      const name = named?.[1] ?? named?.[2] ?? named?.[3];
      return name === undefined ? [] : [name];
    });
    sites.push({ file, line, key, given: new Set(names) });
  }
  return sites;
}

function placeholdersOf(key: string): ReadonlySet<string> {
  const found = new Set<string>();
  const original = getLocale();
  try {
    for (const locale of ['en', 'zh'] as Locale[]) {
      setLocale(locale);
      // `t(key)` with no params leaves every `{name}` in place.
      for (const m of t(key).matchAll(/\{([A-Za-z0-9_]+)\}/g)) found.add(m[1] as string);
    }
  } finally {
    setLocale(original);
  }
  return found;
}

function keyExists(key: string): boolean {
  const original = getLocale();
  try {
    return (['en', 'zh'] as Locale[]).every((locale) => {
      setLocale(locale);
      return t(key) !== key;
    });
  } finally {
    setLocale(original);
  }
}

/** What is wrong with one call site, or undefined when it is fine. */
function problemWith(site: CallSite): string | undefined {
  if (!keyExists(site.key)) return `unknown key "${site.key}"`;
  if (site.given === null) return undefined;
  const missing = [...placeholdersOf(site.key)].filter((name) => !site.given!.has(name));
  return missing.length > 0 ? `"${site.key}" does not supply {${missing.join('}, {')}}` : undefined;
}

afterAll(() => {
  setLocale('zh');
});

describe('t() call sites', () => {
  const sites = sourceFiles(SRC).flatMap((file) =>
    findCallSites(readFileSync(file, 'utf8'), relative(SRC, file)),
  );

  it('judges a meaningful number of calls (the scanner is not silently judging nothing)', () => {
    expect(sites.filter((s) => s.given !== null).length).toBeGreaterThan(1_000);
  });

  it('uses only keys that exist, and supplies every placeholder the text uses', () => {
    const problems = sites.flatMap((site) => {
      const problem = problemWith(site);
      return problem === undefined ? [] : [`${site.file}:${site.line} — ${problem}`];
    });
    expect(problems).toEqual([]);
  });
});

describe('the call-site checker itself', () => {
  const flagged = (source: string): string[] =>
    findCallSites(source).flatMap((site) => {
      const problem = problemWith(site);
      return problem === undefined ? [] : [problem];
    });

  it('accepts correct calls in every shape the codebase uses', () => {
    expect(flagged("t('budget.set', { limit: formatTokenLimit(limit) })")).toEqual([]);
    expect(flagged("t('model.switch_guard_notice', { alias, current: a, max: b })")).toEqual([]);
    expect(
      flagged("t('compact.guard_notice', {\n  current: fmt(a, b),\n  max: `${x}`,\n  // why\n  pct,\n})"),
    ).toEqual([]);
    expect(flagged('t("budget.cleared")')).toEqual([]);
  });

  it('flags a wrong param name, a missing param, and a missing params object', () => {
    expect(flagged("t('budget.set', { lim: 1 })")).toEqual(['"budget.set" does not supply {limit}']);
    expect(flagged("t('compact.guard_notice', { current: a, pct })")).toEqual([
      '"compact.guard_notice" does not supply {max}',
    ]);
    expect(flagged("t('budget.set')")).toEqual(['"budget.set" does not supply {limit}']);
  });

  it('flags an unknown key', () => {
    expect(flagged("t('budget.sett', { limit: 1 })")).toEqual(['unknown key "budget.sett"']);
  });

  it('does not guess when params are not an object literal', () => {
    expect(flagged("t('budget.set', params)")).toEqual([]);
    expect(flagged("t('budget.set', { ...params })")).toEqual([]);
  });
});
