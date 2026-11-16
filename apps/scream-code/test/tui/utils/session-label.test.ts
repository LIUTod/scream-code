import { getLocale, setLocale } from '@scream-code/config';
import { describe, expect, it } from 'vitest';

import { formatSessionLabel, isImportedSession } from '#/tui/utils/session-label';

function inLocale<T>(locale: 'en' | 'zh', fn: () => T): T {
  const previous = getLocale();
  setLocale(locale);
  try {
    return fn();
  } finally {
    setLocale(previous);
  }
}

describe('isImportedSession', () => {
  it('is true only for the boolean true flag', () => {
    expect(isImportedSession({ imported_from_scream_cli: true })).toBe(true);
    for (const value of ['true', 1, 'yes', null, undefined, {}]) {
      expect(isImportedSession({ imported_from_scream_cli: value })).toBe(false);
    }
    expect(isImportedSession(undefined)).toBe(false);
    expect(isImportedSession({})).toBe(false);
  });
});

describe('formatSessionLabel', () => {
  const imported = { title: 'Migrated session', metadata: { imported_from_scream_cli: true } };

  it('badges an imported session in the UI language', () => {
    expect(inLocale('zh', () => formatSessionLabel(imported))).toBe('[已导入] Migrated session');
    expect(inLocale('en', () => formatSessionLabel(imported))).toBe('[imported] Migrated session');
  });

  it('leaves a native session unbadged in either language', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(inLocale(locale, () => formatSessionLabel({ title: 'Fresh session' }))).toBe('Fresh session');
    }
  });
});
