import { describe, expect, it, vi } from 'vitest';

import chalk from 'chalk';

// Force truecolor so chalk.hex emits deterministic \x1b[38;2;r;g;bm prefixes.
chalk.level = 3;

// Mock code-highlight so highlightLines returns predictable ANSI-colored output,
// simulating cli-highlight's behavior in a color-enabled terminal without
// depending on cli-highlight's own TTY detection (unreliable under vitest).
vi.mock('#/tui/components/media/code-highlight', () => ({
  langFromPath: () => 'typescript',
  highlightLines: (code: string) => {
    // Simulate: keyword const/let -> blue (\x1b[34m...\x1b[39m), rest uncolored.
    return [code.replaceAll(/\b(const|let)\b/g, '\x1B[34m$&\x1B[39m')];
  },
}));

const { renderDiffLinesClustered } = await import('#/tui/components/media/diff-preview');
const { getColorPalette } = await import('#/tui/theme/colors');

const COLORS = getColorPalette('dark');

// darkColors.diffAdded = '#79eb00' -> RGB(121,235,0) -> \x1b[38;2;121;235;0m
const DIFF_GREEN = '\x1B[38;2;121;235;0m';
const DIFF_RED = '\x1B[38;2;232;84;84m';
const SYNTAX_BLUE = '\x1B[34m';
const RESET_FG = '\x1B[39m';

describe('renderDiffCode color layering', () => {
  it('injects diff color as base foreground alongside syntax highlighting on add lines', () => {
    // Multi-line block replacement -> renderDiffCode path (not intra-line diff).
    const out = renderDiffLinesClustered(
      'const foo = 1;\nconst bar = 2;',
      'let foo = 10;\nlet bar = 20;',
      'test.ts',
      COLORS,
    );
    // Find the add line containing "foo".
    const addLine = out.find((l) => l.includes('foo') && l.includes(DIFF_GREEN));
    expect(addLine).toBeDefined();
    // Syntax color present (keyword "let" highlighted blue).
    expect(addLine).toContain(SYNTAX_BLUE);
    // After the syntax reset, the diff green prefix must be re-injected so
    // non-token spans (" foo = ") stay green instead of falling back to the
    // terminal default color. This is the core of the fix.
    expect(addLine).toContain(RESET_FG + DIFF_GREEN);
  });

  it('injects diff red as base foreground on delete lines with syntax highlighting', () => {
    const out = renderDiffLinesClustered(
      'const foo = 1;\nconst bar = 2;',
      'let foo = 10;\nlet bar = 20;',
      'test.ts',
      COLORS,
    );
    const delLine = out.find((l) => l.includes('foo') && l.includes(DIFF_RED));
    expect(delLine).toBeDefined();
    expect(delLine).toContain(SYNTAX_BLUE);
    expect(delLine).toContain(RESET_FG + DIFF_RED);
  });

  it('still applies pure diff color when syntax highlighting produces no tokens', () => {
    // No keywords -> mock returns uncolored text -> renderDiffCode falls back
    // to colorFn(rest), wrapping the whole code span in diff color.
    const out = renderDiffLinesClustered(
      'old line 1\nold line 2',
      'new line 1\nnew line 2',
      'test.ts',
      COLORS,
    );
    const addLine = out.find((l) => l.includes('new line 1'));
    expect(addLine).toBeDefined();
    // No syntax blue tokens in this line.
    expect(addLine).not.toContain(SYNTAX_BLUE);
    // Diff green is present (whole-line coloring).
    expect(addLine).toContain(DIFF_GREEN);
  });
});
