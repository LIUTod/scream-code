import { afterEach, describe, expect, it, vi } from 'vitest';

import { en } from '../src/i18n/locale/en';
import { zh } from '../src/i18n/locale/zh';
import type { Locale } from '../src/i18n';

type I18nModule = typeof import('../src/i18n');

const LOCALE_ENV_KEYS = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'] as const;

/**
 * Re-evaluate the i18n module with full control over the environment variables
 * `detectSystemLocale` reads. Keys not provided in `env` are cleared so module
 * initialization stays deterministic regardless of the developer machine.
 */
async function loadI18n(env: Record<string, string> = {}): Promise<I18nModule> {
  const saved: Record<string, string | undefined> = {};
  for (const key of LOCALE_ENV_KEYS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    vi.resetModules();
    return await import('../src/i18n');
  } finally {
    for (const key of LOCALE_ENV_KEYS) {
      const original = saved[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

function placeholders(text: string): string[] {
  return (text.match(/\{\w+\}/g) ?? []).toSorted();
}

afterEach(() => {
  vi.doUnmock('../src/i18n/locale/en');
  vi.resetModules();
});

describe('i18n dictionary symmetry', () => {
  it('every zh key exists in en', () => {
    const missing = Object.keys(zh).filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });

  it('every en key exists in zh', () => {
    const missing = Object.keys(en).filter((key) => !(key in zh));
    expect(missing).toEqual([]);
  });

  it('every shared key carries the same placeholder multiset in both locales', () => {
    const mismatches: Array<{ key: string; zh: string[]; en: string[] }> = [];
    for (const key of Object.keys(zh)) {
      const zhText = zh[key];
      const enText = en[key];
      if (zhText === undefined || enText === undefined) continue;
      const zhPh = placeholders(zhText);
      const enPh = placeholders(enText);
      if (zhPh.join('\u0000') !== enPh.join('\u0000')) {
        mismatches.push({ key, zh: zhPh, en: enPh });
      }
    }
    expect(mismatches).toEqual([]);
  });

  // Regression guard: this key used to exist only in zh (en.ts was one key short).
  it('footer.context_short is defined in both locales', () => {
    expect(zh['footer.context_short']).toBe('上下文: {bar}');
    expect(en['footer.context_short']).toBe('Context: {bar}');
  });
});

describe('i18n t() interpolation', () => {
  it('interpolates named params', async () => {
    const { t, setLocale } = await loadI18n({ LANG: 'en_US.UTF-8' });
    setLocale('en');
    expect(t('footer.context', { bar: '▓▓░░', tokens: '8.2k', maxTokens: '200k' })).toBe(
      'Context: ▓▓░░ (8.2k/200k)',
    );
  });

  it('replaces every occurrence of the same placeholder', async () => {
    const { t, setLocale } = await loadI18n({ LANG: 'en_US.UTF-8' });
    setLocale('en');
    const text = t('session.wrong_dir', { sessionId: 'abc123', workDir: '/tmp/x' });
    expect(text).toContain('"abc123"');
    expect(text).toContain('-r abc123');
    expect(text).not.toContain('{sessionId}');
    expect(text).toContain('cd "/tmp/x"');
  });

  it('converts number params to string', async () => {
    const { t, setLocale } = await loadI18n({ LANG: 'en_US.UTF-8' });
    setLocale('en');
    expect(t('footer.tasks_running', { count: 5 })).toBe('bg task x5');
  });

  it('keeps the literal {var} when the param is not provided', async () => {
    const { t, setLocale } = await loadI18n({ LANG: 'en_US.UTF-8' });
    setLocale('en');
    expect(t('footer.context', { bar: '▓░' })).toBe('Context: ▓░ ({tokens}/{maxTokens})');
  });

  it('returns the key itself when missing in both dictionaries', async () => {
    const { t, setLocale } = await loadI18n({ LANG: 'en_US.UTF-8' });
    setLocale('en');
    expect(t('no.such.key.anywhere')).toBe('no.such.key.anywhere');
    expect(t('no.such.key.anywhere', { bar: 'x' })).toBe('no.such.key.anywhere');
  });
});

describe('i18n setLocale / getLocale', () => {
  it('switches the rendering language', async () => {
    const mod = await loadI18n({ LANG: 'en_US.UTF-8' });
    mod.setLocale('en');
    expect(mod.getLocale()).toBe('en');
    expect(mod.t('footer.context', { bar: 'B', tokens: 'T', maxTokens: 'M' })).toBe(
      'Context: B (T/M)',
    );
    mod.setLocale('zh');
    expect(mod.getLocale()).toBe('zh');
    expect(mod.t('footer.context', { bar: 'B', tokens: 'T', maxTokens: 'M' })).toBe(
      '上下文: B (T/M)',
    );
  });

  it('silently ignores invalid locales', async () => {
    const mod = await loadI18n({ LANG: 'en_US.UTF-8' });
    expect(mod.getLocale()).toBe('en');
    const bogus: string = 'fr';
    mod.setLocale(bogus as Locale);
    expect(mod.getLocale()).toBe('en');
    expect(mod.t('footer.hit')).toBe('HitR');
  });
});

describe('i18n fallback chain (current locale -> zh -> key)', () => {
  it('falls back to zh when the active locale dictionary lacks the key', async () => {
    vi.doMock('../src/i18n/locale/en', () => ({ en: {} }));
    const mod = await loadI18n({ LANG: 'en_US.UTF-8' });
    mod.setLocale('en');
    expect(mod.t('footer.context', { bar: '▓░', tokens: '1', maxTokens: '2' })).toBe(
      '上下文: ▓░ (1/2)',
    );
    // Still missing in zh as well -> raw key.
    expect(mod.t('totally.absent.key')).toBe('totally.absent.key');
  });

  it('prefers the active locale dictionary when the key exists there', async () => {
    vi.doMock('../src/i18n/locale/en', () => ({ en: { 'footer.hit': 'HitR-EN' } }));
    const mod = await loadI18n({ LANG: 'en_US.UTF-8' });
    mod.setLocale('en');
    expect(mod.t('footer.hit')).toBe('HitR-EN');
  });
});

describe('i18n detectSystemLocale', () => {
  it.each([
    ['LC_ALL', 'zh_CN'],
    ['LC_MESSAGES', 'zh_TW.UTF-8'],
    ['LANG', 'zh_CN.UTF-8'],
    ['LANGUAGE', 'zh'],
  ])('%s=%s on a fresh module detects zh', async (key, value) => {
    const mod = await loadI18n({ [key]: value });
    expect(mod.getLocale()).toBe('zh');
  });

  it('detects en for a non-zh locale env var', async () => {
    const mod = await loadI18n({ LANG: 'en_US.UTF-8' });
    expect(mod.getLocale()).toBe('en');
  });

  it('respects priority LC_ALL > LC_MESSAGES > LANG > LANGUAGE', async () => {
    const mod = await loadI18n({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' });
    expect(mod.getLocale()).toBe('en');
  });

  it('falls back to Intl when no locale env var is set', async () => {
    const mod = await loadI18n();
    let resolved = 'en';
    try {
      resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      resolved = 'en';
    }
    const expected = resolved.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    expect(['zh', 'en']).toContain(mod.getLocale());
    expect(mod.getLocale()).toBe(expected);
  });
});
