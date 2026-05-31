import { describe, expect, it } from 'vitest';

import { CompactionComponent } from '#/tui/components/dialogs/compaction';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('CompactionComponent', () => {
  it('renders the custom instruction below the compacting label', () => {
    const component = new CompactionComponent(darkColors, undefined, 'keep the recent files only');

    try {
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('正在压缩上下文...');
      expect(text).toContain('  keep the recent files only');
    } finally {
      component.dispose();
    }
  });

  it('renders a cancelled terminal state', () => {
    const component = new CompactionComponent(darkColors);

    try {
      component.markCanceled();
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('压缩已取消');
      expect(text).not.toContain('正在压缩上下文...');
    } finally {
      component.dispose();
    }
  });
});
