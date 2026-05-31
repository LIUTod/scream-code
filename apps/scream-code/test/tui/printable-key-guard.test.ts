/**
 * Guard test: scan every TUI component and reject `data === '<printable>'`
 * bare-literal comparisons. When the terminal enables the Kitty keyboard
 * protocol (e.g. the VSCode integrated terminal), printable keys arrive as
 * CSI-u sequences, so a bare comparison silently disables the shortcut.
 * See `apps/scream-code/src/tui/utils/printable-key.ts`.
 *
 * Every printable-character comparison must first go through
 * `printableChar(data)`. Control characters (codepoint < 32) should use
 * `matchesKey` with `Key.*` or stay as escape literals (`'\t'`, ...);
 * those are exempted by the guard's regex.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const COMPONENTS_ROOT = join(__dirname, '..', '..', 'src', 'tui', 'components');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(p);
  }
  return out;
}

// Single-character visible-ASCII (codepoint 32-126) bare-literal
// comparisons, e.g. `data === 'q'`, `data === ' '`. The regex deliberately
// permits escape sequences (`data === '\t'`, control-char literals),
// multi-character sequences (`data === '[A'`), and comparisons on
// variables other than `data` (the decoded value is usually `k` or
// `printable`).
const BARE_PRINTABLE = /\bdata\s*===\s*'([\u0020-\u007E])'/g;

describe('TUI handleInput — printable-key guard', () => {
  it('forbids bare-literal printable comparisons on `data` (use printableChar)', () => {
    const offenders: { file: string; line: number; snippet: string }[] = [];
    for (const file of walk(COMPONENTS_ROOT)) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.trimStart().startsWith('//')) continue;
        BARE_PRINTABLE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = BARE_PRINTABLE.exec(line)) !== null) {
          offenders.push({
            file: file.slice(file.indexOf('src/')),
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    }
    expect(
      offenders,
      `Found bare-literal \`data === '...'\` comparisons. ` +
        `In VSCode/Kitty terminals these never match because keys arrive as ` +
        `CSI-u sequences. Use \`printableChar(data)\` from ` +
        `\`@/tui/utils/printable-key\` and compare the decoded value instead.\n` +
        offenders.map((o) => `  ${o.file}:${String(o.line)}  ${o.snippet}`).join('\n'),
    ).toEqual([]);
  });
});
