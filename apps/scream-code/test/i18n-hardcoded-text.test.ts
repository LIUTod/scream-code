/**
 * The app has an English and a Chinese UI (`t()` + the two dictionaries in
 * `packages/config`). A Chinese string literal written straight into a source
 * file bypasses that: an English user sees it as it is. This is how the CLI's
 * `--help`, its option errors, the update prompt, `/trace`, the plugin
 * marketplace errors and even a prompt sent to the model came to be Chinese
 * under `LANG=en_US`.
 *
 * So: no CJK text outside comments in `src/`, except where it is deliberate.
 * Every exception below says why, and must still be needed — a stale entry is a
 * failure too, so the list cannot rot into a blanket pass.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');

/** Directories whose Chinese is deliberate, keyed by path prefix. */
const ALLOWED_PREFIXES: Readonly<Record<string, string>> = {
  'line/': 'IM channel (Feishu/Lark, WeChat): replies go to Chinese chat platforms and are Chinese by design',
};

/** Files whose Chinese is deliberate, keyed by path relative to `src/`. */
const ALLOWED_FILES: Readonly<Record<string, string>> = {
  'tui/commands/language.ts': 'each language is named in itself (中文 / English)',
  'tui/commands/knowledge-web.ts': 'the page ships its own zh/en dictionaries and a language toggle',
  'tui/components/sidebar/panels/goal-panel.ts': 'sidebar duration format branches on getLocale() — the sidebar pattern',
  'tui/reverse-rpc/approval/adapter.ts': 'approval source label branches on getLocale() — the sidebar pattern',
  'utils/usage/token-limit.ts': 'parser vocabulary: accepts 万 / 亿 and Chinese "off" words as input',
};

const CJK = /[㐀-䶿一-鿿]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Source with comments removed (line numbers kept); quote-aware for `//`. */
export function withoutComments(source: string): string {
  const noBlocks = source.replaceAll(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
  return noBlocks
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quote !== undefined) {
          if (char === '\\') i += 1;
          else if (char === quote) quote = undefined;
        } else if (char === "'" || char === '"' || char === '`') {
          quote = char;
        } else if (char === '/' && line[i + 1] === '/') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** `file:line` of every line with CJK text outside comments. */
export function cjkLines(source: string): number[] {
  return withoutComments(source)
    .split('\n')
    .flatMap((line, index) => (CJK.test(line) ? [index + 1] : []));
}

const files = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path), path }));
const isAllowed = (rel: string): boolean =>
  rel in ALLOWED_FILES || Object.keys(ALLOWED_PREFIXES).some((prefix) => rel.startsWith(prefix));

describe('hard-coded Chinese text in app source', () => {
  it('lives only where it is deliberate — everything else goes through t()', () => {
    const offenders = files
      .filter(({ rel }) => !isAllowed(rel))
      .flatMap(({ rel, path }) => cjkLines(readFileSync(path, 'utf8')).map((line) => `${rel}:${line}`));

    expect(
      offenders,
      'Chinese text outside comments. Put it in packages/config/src/i18n/locale/{en,zh}.ts and use t(), ' +
        'or — if it is deliberate — add the file to ALLOWED_FILES in this test with the reason.',
    ).toEqual([]);
  });

  it('keeps every exception honest: each allowed file still has Chinese text to allow', () => {
    const known = new Set(files.map(({ rel }) => rel));
    for (const rel of Object.keys(ALLOWED_FILES)) {
      expect(known.has(rel), `${rel} no longer exists — remove it from ALLOWED_FILES`).toBe(true);
      const path = files.find((f) => f.rel === rel)!.path;
      expect(
        cjkLines(readFileSync(path, 'utf8')).length,
        `${rel} has no Chinese text any more — remove it from ALLOWED_FILES`,
      ).toBeGreaterThan(0);
    }
    for (const prefix of Object.keys(ALLOWED_PREFIXES)) {
      expect(files.some(({ rel }) => rel.startsWith(prefix)), `${prefix} no longer exists`).toBe(true);
    }
  });
});

describe('the Chinese-text scanner itself', () => {
  it('flags a literal, a template literal and JSX-less call sites', () => {
    expect(cjkLines("const a = '你好';\nconst b = `共 ${n} 条`;\nfoo('x');")).toEqual([1, 2]);
  });

  it('ignores line comments, block comments and JSDoc', () => {
    expect(cjkLines('// 中文注释\n/* 块注释 中文 */\n/**\n * 文档注释\n */\nconst a = 1; // 行尾中文')).toEqual([]);
  });

  it('does not mistake a URL in a string for a comment', () => {
    // `//` inside a string must not hide the Chinese that follows it on the line.
    expect(cjkLines("const u = 'https://example.com/' + '中文';")).toEqual([1]);
  });

  it('keeps line numbers across multi-line block comments', () => {
    expect(cjkLines("/* a\n b\n c */\nconst x = '中';")).toEqual([4]);
  });
});
