import { describe, it, expect, vi } from 'vitest';

import { getLocale, setLocale, t } from '@scream-code/config';

import type { ScreamSlashCommand } from '#/tui/commands/index';
import {
  defaultKeyboardShortcuts,
  HelpPanelComponent,
} from '#/tui/components/dialogs/help-panel';
import { darkColors } from '#/tui/theme/colors';

function cmd(name: string, description: string, aliases: string[] = []): ScreamSlashCommand {
  return {
    name,
    aliases,
    description,
  };
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('HelpPanelComponent', () => {
  it('renders keyboard shortcuts + slash commands sections', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('exit', 'Exit', ['quit', 'q'])],
      colors: darkColors,
      onClose: () => {},
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/帮助/);
    expect(out).toMatch(/键盘快捷键/);
    expect(out).toMatch(/Shift-Tab/);
    expect(out).toMatch(/Ctrl-O/);
    expect(out).toMatch(/Shift-Enter \/ Ctrl-J/);
    expect(out).toMatch(/斜杠命令/);
    expect(out).toMatch(/\/exit \(\/quit, \/q\)/);
    expect(out).toMatch(/Exit/);
  });

  it('lists the newer global bindings and advertises /config image', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('model', 'Switch model')],
      colors: darkColors,
      onClose: () => {},
      maxVisible: 40,
    });
    const out = strip(panel.render(80).join('\n'));
    // Tab cycles the thinking effort when the input is empty.
    expect(out).toMatch(/空输入时循环思考档位/);
    expect(out).toMatch(/Ctrl-E/);
    expect(out).toMatch(/Ctrl-X/);
    expect(out).toMatch(/Ctrl-B/);
    expect(out).toMatch(/Ctrl-W/);
    // The hidden-commands line surfaces the image-generation setup path.
    expect(out).toMatch(/\/config image 生图配置/);
  });

  it('sorts slash commands by name', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('zebra', 'Z'), cmd('alpha', 'A'), cmd('mango', 'M')],
      colors: darkColors,
      onClose: () => {},
      maxVisible: 40,
    });
    const out = strip(panel.render(80).join('\n'));
    const alphaIdx = out.indexOf('/alpha');
    const mangoIdx = out.indexOf('/mango');
    const zebraIdx = out.indexOf('/zebra');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it('Escape fires onClose', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      colors: darkColors,
      onClose,
    });
    panel.handleInput('\u001B'); // Esc
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q / Enter also close the panel', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      colors: darkColors,
      onClose,
    });
    panel.handleInput('q');
    panel.handleInput('\r');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('clips to maxVisible with a "showing X-Y of Z" tail', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, `Desc ${String(i)}`));
    const panel = new HelpPanelComponent({
      commands: many,
      colors: darkColors,
      onClose: () => {},
      maxVisible: 6,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/显示 1-6 \/ /);
  });

  it('arrow keys shift the scroll window', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      colors: darkColors,
      onClose: () => {},
      maxVisible: 6,
    });
    panel.handleInput('\u001B[B'); // ↓
    panel.handleInput('\u001B[B'); // ↓
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/显示 3-8 \/ /);
    panel.handleInput('\u001B[A'); // ↑
    const out2 = strip(panel.render(80).join('\n'));
    expect(out2).toMatch(/显示 2-7 \/ /);
  });
});


describe('defaultKeyboardShortcuts', () => {
  it('描述随当前 locale 求值，不冻结在 import 时的语言', () => {
    const previous = getLocale();
    try {
      const descriptionOf = (key: string): string | undefined =>
        defaultKeyboardShortcuts().find((shortcut) => shortcut.keys === key)?.description;

      setLocale('zh');
      const zhExpected = t('help.toggle_plan');
      setLocale('en');
      const enExpected = t('help.toggle_plan');
      expect(zhExpected).not.toBe(enExpected);

      setLocale('zh');
      expect(descriptionOf('Shift-Tab')).toBe(zhExpected);
      setLocale('en');
      expect(descriptionOf('Shift-Tab')).toBe(enExpected);
      // 再切回中文仍然生效（同一模块实例，无缓存冻结）
      setLocale('zh');
      expect(descriptionOf('Shift-Tab')).toBe(zhExpected);
    } finally {
      setLocale(previous);
    }
  });

  it('键位标签不含需要翻译的 CJK 文本（语言差异只出现在描述里）', () => {
    // 箭头等键位符号是通用记法，允许；CJK 文本（如"忙碌时"）必须进描述。
    const cjk = /[\u3000-\u9FFF\uFF00-\uFFEF]/u;
    for (const shortcut of defaultKeyboardShortcuts()) {
      expect(cjk.test(shortcut.keys)).toBe(false);
    }
  });
});
