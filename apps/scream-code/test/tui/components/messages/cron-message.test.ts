import { describe, expect, it } from 'vitest';

import { CronMessageComponent } from '#/tui/components/messages/cron-message';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('CronMessageComponent', () => {
  it('renders a scheduled reminder with prompt and metadata', () => {
    const component = new CronMessageComponent(
      'review daily report',
      {
        jobId: 'job-1',
        cron: '0 9 * * *',
        recurring: true,
      },
      darkColors,
    );

    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('定时提醒触发');
    expect(out).toContain('0 9 * * *');
    expect(out).toContain('job job-1');
    expect(out).toContain('review daily report');
  });

  it('caches render output for the same width', () => {
    const component = new CronMessageComponent(
      'reminder',
      { recurring: false },
      darkColors,
    );

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('recomputes after invalidate()', () => {
    const component = new CronMessageComponent(
      'reminder',
      { recurring: false },
      darkColors,
    );

    const first = component.render(80);
    component.invalidate();
    const second = component.render(80);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
