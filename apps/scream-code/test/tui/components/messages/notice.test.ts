import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { NoticeMessageComponent } from '#/tui/components/messages/status-message';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('NoticeComponent', () => {
  it('renders top and bottom spacing around the notice copy', () => {
    const component = new NoticeMessageComponent(
      'Plan mode: ON',
      'Plan will be created here: /tmp/plans/test-plan.md',
      darkColors,
    );

    const lines = component.render(120).map((line) => strip(line));
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('Plan mode: ON');
    expect(lines[2]).toContain('Plan will be created here: /tmp/plans/test-plan.md');
    // Command feedback stays unmarked so the triangle keeps meaning "someone
    // other than the user or the assistant just spoke".
    expect(lines[1]).toMatch(/^ {2}Plan mode: ON/);
  });

  it('marks an interjection with the triangle and keeps a two-cell marker column', () => {
    const component = new NoticeMessageComponent(
      'explore 向主 Agent 求助（转交工作）',
      '需要换个能力 · 需要 独立验证这段逻辑',
      darkColors,
      darkColors.warning,
    );

    const lines = component.render(120).map((line) => strip(line));
    expect(lines[1]?.startsWith('▸ ')).toBe(true);
    expect(visibleWidth((lines[1] ?? '').slice(0, 2))).toBe(2);
    // The detail row aligns under the title text, exactly like `■ ` rows do.
    expect(lines[2]?.startsWith('  ')).toBe(true);
    expect(lines[2]?.startsWith('▸')).toBe(false);
  });
});
