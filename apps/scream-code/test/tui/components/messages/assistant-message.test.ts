import { visibleWidth } from '@liutod-scream/pi-tui';
import type { TUI } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { FADE_MS } from '#/tui/utils/streaming-fade';

import { captureProcessWrite } from '../../../helpers/process';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

// Extract the first truecolor foreground RGB from a line, as "r;g;b".
function bulletRgb(line: string): string | null {
  const re = /\[38;2;(\d+);(\d+);(\d+)m/;
  const m = line.match(re);
  return m ? `${m[1]};${m[2]};${m[3]}` : null;
}

describe('AssistantMessageComponent', () => {
  it('defines the shared status bullet as a stable non-emoji glyph', () => {
    expect(STATUS_BULLET).toBe('■ ');
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

  it('bullet fades from accent to roleAssistant over FADE_MS', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const ui = { requestRender } as unknown as TUI;
      const component = new AssistantMessageComponent(
        createMarkdownTheme(darkColors),
        darkColors,
        true,
        ui,
      );

      component.updateContent('hello');
      const initial = component.render(80);
      const initialBullet = initial[1] ?? '';
      // primary = #ccfb23 = rgb(204, 251, 35)
      expect(bulletRgb(initialBullet)).toBe('204;251;35');

      vi.advanceTimersByTime(FADE_MS + 100);
      const settled = component.render(80);
      const settledBullet = settled[1] ?? '';
      // roleAssistant = #E0E0E0 = rgb(224, 224, 224)
      expect(bulletRgb(settledBullet)).toBe('224;224;224');

      component.dispose();
    } finally {
      chalk.level = previousLevel;
      vi.useRealTimers();
    }
  });

  it('bullet stays in roleAssistant when SCREAM_REDUCED_MOTION is set', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    vi.useFakeTimers();
    process.env['SCREAM_REDUCED_MOTION'] = '1';
    try {
      const requestRender = vi.fn();
      const ui = { requestRender } as unknown as TUI;
      const component = new AssistantMessageComponent(
        createMarkdownTheme(darkColors),
        darkColors,
        true,
        ui,
      );

      component.updateContent('hello');
      const lines = component.render(80);
      const bullet = lines[1] ?? '';
      // No fade — bullet should be roleAssistant immediately.
      expect(bulletRgb(bullet)).toBe('224;224;224');
      expect(requestRender).not.toHaveBeenCalled();

      component.dispose();
    } finally {
      delete process.env['SCREAM_REDUCED_MOTION'];
      chalk.level = previousLevel;
      vi.useRealTimers();
    }
  });

  it('dispose stops the fade timer', () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const ui = { requestRender } as unknown as TUI;
      const component = new AssistantMessageComponent(
        createMarkdownTheme(darkColors),
        darkColors,
        true,
        ui,
      );

      component.updateContent('hello');
      const callsBefore = requestRender.mock.calls.length;
      component.dispose();
      vi.advanceTimersByTime(FADE_MS * 2);
      expect(requestRender.mock.calls.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
