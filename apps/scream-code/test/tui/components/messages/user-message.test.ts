import { describe, expect, it } from 'vitest';

import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { darkColors } from '#/tui/theme/colors';

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('UserMessageComponent', () => {
  it('renders video placeholders as plain text, not inline image escapes', () => {
    const component = new UserMessageComponent(
      'please inspect [video #1 sample.mov]',
      darkColors,
      [],
    );

    const out = stripAnsi(component.render(80).join('\n'));

    expect(out).toContain('[video #1 sample.mov]');
  });

  it('caches render output for the same width and returns the same array reference', () => {
    const component = new UserMessageComponent('cached message', darkColors);

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('recomputes after invalidate() is called', () => {
    const component = new UserMessageComponent('cached message', darkColors);

    const first = component.render(80);
    component.invalidate();
    const second = component.render(80);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('recomputes when width changes', () => {
    const component = new UserMessageComponent('cached message', darkColors);

    const narrow = component.render(40);
    const wide = component.render(80);

    expect(wide).not.toBe(narrow);
  });
});
