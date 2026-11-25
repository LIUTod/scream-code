import { describe, expect, it } from 'vitest';

import { changedLinesSnippet, editSnippet } from '../../src/tools/support/file-views';

describe('editSnippet', () => {
  it('shows the edited lines with one line of context, numbered like Read', () => {
    expect(editSnippet('a\nb\nC\nd\ne\n', 3, 3)).toBe('2\tb\n3\tC\n4\td');
  });

  it('keeps the head and tail of a long span', () => {
    const view = Array.from({ length: 30 }, (_, i) => `l${String(i + 1)}`).join('\n') + '\n';
    const snippet = editSnippet(view, 5, 25, 8)!;
    expect(snippet.split('\n')).toHaveLength(7);
    expect(snippet).toContain('4\tl4');
    expect(snippet).toContain('26\tl26');
    expect(snippet).toMatch(/… \(\d+ more lines\)/);
  });
});

describe('changedLinesSnippet', () => {
  it('shows the new lines around a change and notes removed runs', () => {
    const snippet = changedLinesSnippet('a\nb\nc\nd\n', 'a\nB\nc\n')!;
    expect(snippet).toContain('2\tB');
    expect(snippet).toMatch(/removed/);
  });

  it('is undefined when nothing changed', () => {
    expect(changedLinesSnippet('same\n', 'same\n')).toBeUndefined();
  });
});
