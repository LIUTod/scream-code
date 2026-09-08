import { visibleWidth } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import { buildUsageReportLines, UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('UsagePanelComponent', () => {
  it('formats session, context, managed, and subagent usage sections', () => {
    const lines = buildUsageReportLines({
      colors: darkColors,
      sessionUsage: {
        byModel: {
          scream: {
            inputOther: 1000,
            inputCacheRead: 500,
            inputCacheCreation: 500,
            output: 250,
          },
        },
      } as never,
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      managedUsage: {
        summary: {
          label: 'daily',
          used: 20,
          limit: 100,
          resetHint: 'resets tomorrow',
        },
        limits: [],
      },
      subagentUsage: {
        coder: { inputOther: 100, inputCacheRead: 50, inputCacheCreation: 0, output: 75 },
      },
    }).map(strip);

    // Session total row plus the main/sub split (session total = main + sub).
    expect(lines.join('\n')).toContain('会话总计');
    expect(lines.join('\n')).toContain('主 Agent');
    expect(lines.join('\n')).toContain('子 Agent');
    // Name-column row for the model breakdown (labels live in the header row).
    expect(lines.join('\n')).toMatch(/scream\s+2\.0k\s+250\s+2\.3k/);
    // Header row carries the column labels.
    expect(lines.join('\n')).toContain('模型');
    expect(lines.join('\n')).toContain('输入');
    expect(lines.join('\n')).toContain('输出');
    expect(lines.join('\n')).toContain('总计');
    expect(lines.join('\n')).toContain('上下文窗口');
    expect(lines.join('\n')).toContain('25.0%');
    expect(lines).toContain('计划用量');
    expect(lines.join('\n')).toContain('20% 已用');
    expect(lines.join('\n')).toContain('resets tomorrow');
    expect(lines.join('\n')).toMatch(/coder\s+150\s+75\s+225/);
    // The sub-agent total lives on the `└ 子 Agent` split row above; the
    // sub-agent table itself is header + per-agent rows only.
    expect(lines.join('\n')).toMatch(/└ 子 Agent\s+150\s+75\s+225/);
    expect(lines.join('\n')).not.toContain('子 Agent 合计');
  });

  it('wraps preformatted usage lines in a bordered panel', () => {
    const component = new UsagePanelComponent(['会话用量'], darkColors.primary);
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' 用量 ');
    expect(output[1]).toContain('会话用量');
  });

  it('truncates lines wider than the terminal so the panel never overflows', () => {
    const longLine = 'error: ' + 'x'.repeat(200);
    const component = new UsagePanelComponent([longLine], darkColors.primary);
    const width = 60;

    const output = component.render(width);

    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('truncates overlong model names so rows stay within the panel width', () => {
    const longName = `custom-gpt-5.6-luna-cdx/gpt-5.6-luna-cdx-${'x'.repeat(40)}`;
    const lines = buildUsageReportLines({
      colors: darkColors,
      sessionUsage: {
        byModel: {
          [longName]: {
            inputOther: 1000,
            inputCacheRead: 500,
            inputCacheCreation: 500,
            output: 250,
          },
        },
      } as never,
      contextUsage: 0.1,
      contextTokens: 90000,
      maxContextTokens: 1000000,
    }).map(strip);
    const panel = new UsagePanelComponent(lines, darkColors.primary);
    const out = panel.render(80).map(strip);

    // No physical row may exceed the terminal width, and the long name is cut.
    for (const line of out) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(out.join('\n')).toContain('…');
  });

  it("aligns every numeric triple's right edge on the same columns", () => {
    const lines = buildUsageReportLines({
      colors: darkColors,
      sessionUsage: {
        byModel: {
          'claude-sonnet-4-5': {
            inputOther: 1099268,
            inputCacheRead: 0,
            inputCacheCreation: 0,
            output: 45210,
          },
          'gpt-5.2': { inputOther: 67004, inputCacheRead: 0, inputCacheCreation: 0, output: 8920 },
        },
      } as never,
      contextUsage: 0.42,
      contextTokens: 84000,
      maxContextTokens: 200000,
      subagentUsage: {
        coder: { inputOther: 105000, inputCacheRead: 0, inputCacheCreation: 0, output: 8000 },
      },
    }).map(strip);

    const numericRows = lines.filter(
      (l) =>
        (/^(会话总计|claude|gpt-5|coder)/.test(l) || /^(  ├|  └)/.test(l)) && /\d/.test(l),
    );
    expect(numericRows.length).toBeGreaterThanOrEqual(4);

    // Visible-column index of each numeric token's right edge. Tokens are
    // digit runs (e.g. `1.1M`, `105.0k`) after the name column.
    const tokenRightEdges = (line: string): number[] => {
      const edges: number[] = [];
      let col = 0;
      let runStart = -1;
      for (const ch of line) {
        if (/[0-9]/.test(ch)) {
          if (runStart < 0) runStart = col;
          col += 1;
          continue;
        }
        if (runStart >= 0 && (ch === '.' || ch === 'k' || ch === 'M')) {
          col += 1;
          continue;
        }
        if (runStart >= 0) {
          edges.push(col);
          runStart = -1;
        }
        col += visibleWidth(ch);
      }
      if (runStart >= 0) edges.push(col);
      return edges.filter((e) => e > 17); // skip digits inside model names
    };

    const reference = tokenRightEdges(numericRows[0]!);
    expect(reference.length).toBe(3);
    for (const row of numericRows.slice(1)) {
      expect(tokenRightEdges(row)).toEqual(reference);
    }
  });

  it('caches render output for the same width', () => {
    const component = new UsagePanelComponent(['会话用量'], darkColors.primary);

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('recomputes after invalidate()', () => {
    const component = new UsagePanelComponent(['会话用量'], darkColors.primary);

    const first = component.render(80);
    component.invalidate();
    const second = component.render(80);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
