import { describe, expect, it } from 'vitest';

import { TruncatedOutputComponent } from '#/tui/components/messages/tool-renderers/truncated';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

/** Visible text, with OSC 8 hyperlink wrappers removed as well. */
function stripOsc8(text: string): string {
  return text.replaceAll(/\u001B\]8;;[^\u0007]*\u0007/g, '');
}

/**
 * Visible text with complete CSI sequences removed — the TUI sanitizer's
 * contract. A torn fragment (no leading ESC) survives here, because that is
 * exactly what the terminal would render as literal text.
 */
function stripCsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

describe('TruncatedOutputComponent', () => {
  it('renders small output unchanged', () => {
    const component = new TruncatedOutputComponent('hello\nworld', {
      expanded: false,
      isError: false,
      colors: darkColors,
    });

    const lines = component.render(80).map(strip);
    expect(lines[0]).toContain('hello');
    expect(lines[1]).toContain('world');
  });

  it('keeps the tail when output exceeds the byte cap', () => {
    const tail = 'visible tail line';
    const padding = 'x'.repeat(200_000);
    const output = padding + '\n' + tail;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 1024,
    });

    const lines = component.render(80).map(strip);
    const text = lines.join('\n');
    expect(text).toContain(tail);
    expect(text).not.toContain(padding.slice(0, 100));
  });

  it('does not split multi-byte UTF-8 characters when truncating', () => {
    const tail = '中文字尾';
    const padding = 'a'.repeat(200_000);
    const output = padding + tail;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 16,
    });

    const lines = component.render(80).map(strip);
    const text = lines.join('\n');
    expect(text).toContain(tail);
    // Each CJK character is 3 bytes in UTF-8; with a 16-byte cap we should
    // still see all four characters (12 bytes) rather than a split.
    expect(text).toContain('中文字尾');
  });

  it('renders oversized output without throwing', () => {
    const output = 'line\n'.repeat(1_000_000);

    expect(() => {
      const component = new TruncatedOutputComponent(output, {
        expanded: false,
        isError: false,
        colors: darkColors,
        maxBytes: 1024,
      });
      component.render(80);
    }).not.toThrow();
  });

  it('caps the body while expanded and keeps the head when asked', () => {
    const output = Array.from({ length: 40 }, (_, i) => `row ${String(i + 1)}`).join('\n');

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      capWhenExpanded: true,
      keep: 'head',
      isError: false,
      colors: darkColors,
      maxLines: 5,
      hintFormatter: (remaining) => `hidden ${String(remaining)}`,
    });

    const lines = component.render(80).map(strip);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('row 1');
    expect(lines[4]).toContain('row 5');
    // The hidden count is announced below the kept head, not above it.
    expect(lines.at(-1)).toContain('hidden 35');
  });

  it('leaves an expanded body uncapped unless the caller asks for a cap', () => {
    const output = Array.from({ length: 40 }, (_, i) => `row ${String(i + 1)}`).join('\n');

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxLines: 5,
    });

    expect(component.render(80)).toHaveLength(40);
  });

  it('wraps URLs in the body as clickable OSC 8 hyperlinks', () => {
    // Tool output (PaperSearch, WebSearch, FetchURL) delivers its links as bare
    // URLs; without this the user can only copy them out of the terminal.
    const output = ['Title: Memory Layers for Long-Horizon Agents', 'URL: https://arxiv.org/abs/2405.00001'].join('\n');

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
    });
    const [titleLine = '', urlLine = ''] = component.render(80);

    expect(urlLine).toContain('\u001B]8;;https://arxiv.org/abs/2405.00001\u0007');
    // The visible text is unchanged — only zero-width escapes were added.
    expect(stripOsc8(urlLine)).toContain('URL: https://arxiv.org/abs/2405.00001');
    expect(titleLine).not.toContain(']8;;');
  });

  it('keeps punctuation that follows a URL outside the hyperlink', () => {
    const component = new TruncatedOutputComponent('see https://example.com/x).', {
      expanded: true,
      isError: false,
      colors: darkColors,
    });
    const [line = ''] = component.render(80);

    expect(line).toContain('\u001B]8;;https://example.com/x\u0007');
    expect(stripOsc8(line)).toContain('see https://example.com/x).');
  });

  it('aligns the byte cut to the next line instead of keeping a torn CSI fragment', () => {
    // maxBytes = 32 puts the cut right after `\u001B[31`; a raw byte slice
    // keeps `mred first line`, whose `m` is sequence residue the sanitizer
    // cannot strip. Aligning to the next newline drops the torn line only.
    const output = `${'x'.repeat(64)}\u001B[31mred first line\nkept second line`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 32,
    });

    const visible = stripCsi(component.render(80).join('\n'));
    expect(visible).toContain('kept second line');
    expect(visible).not.toContain('red first line');
  });

  it('keeps a byte-capped tail that already starts on a line boundary', () => {
    const output = `first\nsecond\n${'z'.repeat(4)}`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 4,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe('zzzz');
  });

  it('drops a bare `m` fragment when a single line has no newline to align to', () => {
    // The retained window would be `mred`; `red` is the only visible text.
    const output = `${'x'.repeat(64)}\u001B[31mred`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 4,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe('red');
  });

  it('drops a fragment whose ESC byte was cut away (`[31m` shape)', () => {
    // The retained window would be `[31mred` — the opener's ESC is in the
    // dropped prefix, so nothing here looks like a sequence to the sanitizer.
    const output = `${'x'.repeat(64)}\u001B[31mred`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 7,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe('red');
  });

  it('does not back onto the introducer ESC when the torn CSI never closes', () => {
    // maxBytes = 101 puts the byte cut right after the `\u001B[` opener, one
    // byte past the ESC, of a parameter run that reaches the end of the output
    // with no final byte. The look-back would keep the ESC, but the sequence
    // never closes, so the sanitizer cannot strip it: the window would start
    // with a bare ESC and a terminal would swallow the bytes behind it. The raw
    // cut keeps a text-only head (`[3…`) instead.
    const output = `${'x'.repeat(10)}\u001B[${'3'.repeat(100)}`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 101,
    });

    // Rendered wide enough that the run stays on one line, then stripped of
    // complete sequences exactly like the TUI sanitizer does.
    const visible = stripCsi(component.render(200).join('\n')).trim();
    expect(visible).toBe(`[${'3'.repeat(100)}`);
    expect(visible.startsWith('\u001B')).toBe(false);
  });

  it('drops a `0m` fragment when the cut lands after `ESC [`', () => {
    const output = `${'x'.repeat(64)}\u001B[0mtail`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 6,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe('tail');
  });

  it('drops a torn escape-intermediate fragment (`ESC ( B` shape)', () => {
    // maxBytes = 5 keeps `Bbody`; the dropped prefix ends inside `ESC (`, an
    // ISO-2022 charset selection torn in its intermediate run.
    const output = `${'x'.repeat(64)}\u001B(Bbody`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 5,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe('body');
  });

  it('skips the rest of an open OSC sequence instead of leaking its payload', () => {
    // maxBytes = 16 lands inside the OSC 8 hyperlink payload: a raw slice
    // would leak `source\u0007` (URL residue) as visible text.
    const output = `${'x'.repeat(64)}\u001B]8;;https://example.com/resource\u0007link text`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 16,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe('link text');
  });

  it('keeps the newest bytes when the byte cut opens inside an unterminated OSC', () => {
    // A command killed mid-title leaves an OSC with no BEL / ST behind it. The
    // open-string rule used to jump to the end of the text, which left the
    // body empty — the card rendered nothing at all.
    const output = `\u001B]0;build 42%${'p'.repeat(200)}NEWEST`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 40,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe(output.slice(-40));
  });

  it('skips a torn OSC opener instead of leaking its header into the byte cut', () => {
    // maxBytes = 62 puts the cut between the `0` and the `;` of `\u001B]0;`:
    // the head starts on the payload, not on the `0;` fragment.
    const output = `\u001B]0;${'A'.repeat(60)}`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 62,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe('A'.repeat(60));
  });

  it('resumes visible text after a CAN / SUB aborts a string sequence', () => {
    // CAN (0x18) / SUB (0x1A) abort a string sequence: the payload goes and
    // parsing resumes after the abort byte, so the text that follows — real
    // output — stays visible instead of being swallowed.
    for (const abort of ['\u0018', '\u001A']) {
      const output = `\u001B]0;${'g'.repeat(200)}${abort}AFTER${'v'.repeat(50)}`;

      const component = new TruncatedOutputComponent(output, {
        expanded: true,
        isError: false,
        colors: darkColors,
        maxBytes: 60,
      });

      expect(stripCsi(component.render(80).join('\n')).trim()).toBe(`AFTER${'v'.repeat(50)}`);
    }
  });

  it('does not spend more than half the byte budget aligning to a far-away newline', () => {
    // Rule 1 restarts after the next `\n`; with a 5000-char line ahead, a
    // 100-byte budget would come back as the 9 bytes after it. The raw cut
    // keeps the newest output the reader actually asked for.
    const output = `head\n${'L'.repeat(5000)}\ntail-line`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 100,
    });

    const visible = stripCsi(component.render(80).join('\n'));
    expect(visible).toContain('L'.repeat(20));
    expect(visible).toContain('tail-line');
  });

  it('does not spend more than half the byte budget skipping a torn CSI colour run', () => {
    // The cut lands inside the parameter run of an SGR sequence whose final
    // `m` sits 23 units past it. Skipping to that `m` would keep only the 17
    // units of visible text behind it — 57% of the 40 asked for gone. Past the
    // bound the raw cut keeps the newest bytes, fragment and all.
    const output = `${'x'.repeat(200)}\u001B[38;2;255;0;0;48;2;0;255;0;7;4;1mtail-after-colour`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 40,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe(output.slice(-40));
  });

  it('does not spend more than half the byte budget on a torn 100-unit CSI parameter run', () => {
    // Same torn cut with a synthetic run: the skip would keep only the 8 units
    // behind the sequence's final byte.
    const output = `${'y'.repeat(200)}\u001B[${'1'.repeat(100)}mabcdefgh`;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 59,
    });

    expect(stripCsi(component.render(80).join('\n')).trim()).toBe(output.slice(-59));
  });
});
