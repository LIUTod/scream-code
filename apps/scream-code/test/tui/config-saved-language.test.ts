import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSavedLanguageSync } from '#/tui/config';

function configWith(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'scream-lang-')), 'tui.toml');
  writeFileSync(path, text, 'utf8');
  return path;
}

describe('loadSavedLanguageSync (the saved UI language, before the CLI builds its text)', () => {
  it.each(['zh', 'en'] as const)('reads the saved %s', (language) => {
    expect(loadSavedLanguageSync(configWith(`theme = "auto"\nlanguage = "${language}"\n`))).toBe(language);
  });

  it('yields nothing — and creates nothing — when there is no config yet', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'scream-lang-')), 'missing', 'tui.toml');
    expect(loadSavedLanguageSync(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    ['an empty file', ''],
    ['malformed TOML', 'language = = "zh"'],
    ['a language the app does not ship', 'language = "fr"\n'],
  ])('leaves the system locale alone for %s', (_label, text) => {
    expect(loadSavedLanguageSync(configWith(text))).toBeUndefined();
  });
});
