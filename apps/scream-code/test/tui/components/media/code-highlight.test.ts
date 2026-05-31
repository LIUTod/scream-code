import { describe, expect, it } from 'vitest';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';

import { captureProcessWrite } from '../../../helpers/process';

describe('code-highlight', () => {
  it('maps known file extensions to supported highlight languages', () => {
    expect(langFromPath('src/foo.ts')).toBe('typescript');
    expect(langFromPath('src/foo.TS')).toBe('typescript');
  });

  it('treats unsupported file extensions as plain text', () => {
    expect(langFromPath('src/foo.abcxyz')).toBeUndefined();
  });

  it('does not call cli-highlight for unsupported languages', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      expect(highlightLines('hello\nworld', 'abcxyz')).toEqual(['hello', 'world']);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });
});
