import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

import { captureProcessWrite } from '../../../helpers/process';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('AssistantMessageComponent', () => {
  it('defines the shared status bullet as a stable non-emoji glyph', () => {
    expect(STATUS_BULLET).toBe('● ');
    expect(visibleWidth(STATUS_BULLET)).toBe(2);
  });

  it('uses the stable status bullet without stealing content width', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('abcdef');

    const lines = component.render(8).map(strip);
    expect(lines).toEqual(['', `${STATUS_BULLET}abcdef`]);
    expect(visibleWidth(lines[1] ?? '')).toBe(8);
  });

  it('renders unknown markdown fence languages as plain text without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      const theme = createMarkdownTheme(darkColors);
      expect(theme.highlightCode?.('hello\nworld', 'abcxyz')).toEqual(['hello', 'world']);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('preserves literal hook result XML in normal assistant text', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('<hook_result hook_event="UserPromptSubmit">\n{}\n</hook_result>');

    const text = component.render(80).map(strip).join('\n');
    expect(text).toContain('<hook_result hook_event="UserPromptSubmit">');
    expect(text).toContain('{}');
    expect(text).toContain('</hook_result>');
    expect(text).not.toContain('UserPromptSubmit hook');
  });

  it('caches render output after content stabilizes', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('stable content');
    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('invalidates cache when updateContent() changes text', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('first');
    const first = component.render(80);

    component.updateContent('second');
    const second = component.render(80);

    expect(second).not.toBe(first);
  });

  it('reuses the Markdown child for append-only stream updates', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('hello');
    const first = component.render(80);

    component.updateContent('hello world');
    const second = component.render(80);

    expect(second).not.toBe(first);
    expect(second.join('\n')).toContain('hello world');
  });

  it('rebuilds the Markdown child when text shortens', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('hello world');
    component.updateContent('hello');

    const lines = component.render(80).map(strip);
    expect(lines.join('\n')).toContain('hello');
    expect(lines.join('\n')).not.toContain('world');
  });

  it('rebuilds the Markdown child when text prefix changes', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('hello');
    component.updateContent('world');

    const lines = component.render(80).map(strip);
    expect(lines.join('\n')).toContain('world');
    expect(lines.join('\n')).not.toContain('hello');
  });

  it('skips content rebuild when only surrounding whitespace changes', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('hello');
    const first = component.render(80);

    component.updateContent('  hello  ');
    const second = component.render(80);

    expect(second).toBe(first);
  });
});
