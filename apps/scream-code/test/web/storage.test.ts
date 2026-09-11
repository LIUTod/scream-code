// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readStoredJSON,
  readStoredString,
  writeStoredJSON,
  writeStoredString,
} from '../../src/web/frontend/src/utils/storage';

describe('storage helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips plain strings', () => {
    writeStoredString('k', 'light');
    expect(readStoredString('k')).toBe('light');
  });

  it('returns undefined on a missing key', () => {
    expect(readStoredString('nope')).toBeUndefined();
    expect(readStoredJSON('nope')).toBeUndefined();
  });

  it('round-trips JSON values', () => {
    writeStoredJSON('n', 288);
    expect(readStoredJSON<number>('n')).toBe(288);
    writeStoredJSON('o', { a: 1 });
    expect(readStoredJSON<{ a: number }>('o')).toEqual({ a: 1 });
  });

  it('reads a legacy raw numeric string as JSON', () => {
    // Older builds persisted widths via String(width); numbers are valid JSON,
    // so the JSON reader must keep understanding them.
    localStorage.setItem('legacy-width', '288');
    expect(readStoredJSON<number>('legacy-width')).toBe(288);
  });

  it('returns undefined on corrupt JSON', () => {
    localStorage.setItem('bad', '{not json');
    expect(readStoredJSON('bad')).toBeUndefined();
  });

  it('returns undefined when reading a bare word as JSON', () => {
    // Raw string values (e.g. a stored theme name) are NOT valid JSON; callers
    // that store bare words must use the string helpers instead.
    localStorage.setItem('theme', 'light');
    expect(readStoredJSON('theme')).toBeUndefined();
    expect(readStoredString('theme')).toBe('light');
  });

  it('never throws when storage access fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied');
    });
    expect(() => writeStoredString('k', 'v')).not.toThrow();
    expect(() => writeStoredJSON('k', 1)).not.toThrow();
    expect(readStoredString('k')).toBeUndefined();
    expect(readStoredJSON('k')).toBeUndefined();
    vi.restoreAllMocks();
  });
});
