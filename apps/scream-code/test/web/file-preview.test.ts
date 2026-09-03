import { describe, expect, it } from 'vitest';
import {
  extOfPath,
  languageForPath,
  previewKindForPath,
} from '../../src/web/frontend/src/utils/filePreview';

describe('extOfPath', () => {
  it('reads the basename extension, case-insensitively', () => {
    expect(extOfPath('/a/b/Photo.JPG')).toBe('jpg');
    expect(extOfPath('rel/dir/app.Ts')).toBe('ts');
  });

  it('uses only the last path segment (dots in dirs do not count)', () => {
    expect(extOfPath('/some.dotted.dir/README')).toBe('');
  });

  it('treats dotfiles as extension-less', () => {
    expect(extOfPath('/repo/.env')).toBe('');
    expect(extOfPath('.gitignore')).toBe('');
  });

  it('handles backslash separators', () => {
    expect(extOfPath('a\\b\\c.md')).toBe('md');
  });
});

describe('previewKindForPath', () => {
  it('dispatches image extensions', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']) {
      expect(previewKindForPath(`/x/f.${ext}`)).toBe('image');
    }
  });

  it('dispatches audio extensions', () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'ogg']) {
      expect(previewKindForPath(`/x/f.${ext}`)).toBe('audio');
    }
  });

  it('dispatches markdown extensions', () => {
    expect(previewKindForPath('/x/notes.md')).toBe('markdown');
    expect(previewKindForPath('/x/notes.markdown')).toBe('markdown');
  });

  it('falls back to source for code, text and unknown types', () => {
    expect(previewKindForPath('/x/a.ts')).toBe('source');
    expect(previewKindForPath('/x/a.txt')).toBe('source');
    expect(previewKindForPath('/x/archive.zip')).toBe('source');
    expect(previewKindForPath('/x/noext')).toBe('source');
  });
});

describe('languageForPath', () => {
  it('maps common extensions to highlighter languages', () => {
    expect(languageForPath('/a/main.ts')).toBe('typescript');
    expect(languageForPath('/a/main.py')).toBe('python');
    expect(languageForPath('/a/main.rs')).toBe('rust');
    expect(languageForPath('/a/style.scss')).toBe('scss');
  });

  it('falls back to plain text for unknown extensions', () => {
    expect(languageForPath('/a/data.bin')).toBe('text');
    expect(languageForPath('/a/noext')).toBe('text');
  });

  it('recognises special file names', () => {
    expect(languageForPath('/repo/Dockerfile')).toBe('docker');
    expect(languageForPath('/repo/Makefile')).toBe('make');
  });
});
