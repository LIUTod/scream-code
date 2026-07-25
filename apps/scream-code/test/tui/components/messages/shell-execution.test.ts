import { describe, expect, it } from 'vitest';

import { setLocale } from '@scream-code/config';
import {
  ShellExecutionComponent,
  shellExecutionResultRenderer,
} from '#/tui/components/messages/shell-execution';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('ShellExecutionComponent', () => {
  it('renders shell command previews with prompt indentation', () => {
    const component = new ShellExecutionComponent({
      command: 'printf hello\nprintf world',
      colors: darkColors,
      showCommand: true,
    });

    const output = component.render(100).map((line) => strip(line).trimEnd());

    expect(output).toContain('  $ printf hello');
    expect(output).toContain('    printf world');
  });

  it('keeps collapsed shell output short and expands on demand', () => {
    setLocale('zh');
    const lines = Array.from({ length: 20 }, (_, i) =>
      `line${String(i + 1).padStart(2, '0')}`,
    );
    const output = lines.join('\n');

    const collapsed = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output,
        is_error: false,
      },
      colors: darkColors,
    });

    const collapsedOutput = collapsed.render(100).map(strip).join('\n');
    // Tail preview: last 15 lines shown, first 5 hidden.
    expect(collapsedOutput).toContain('line06');
    expect(collapsedOutput).toContain('line20');
    expect(collapsedOutput).not.toContain('line01');
    expect(collapsedOutput).not.toContain('line05');
    expect(collapsedOutput).toContain('▸ 还有 5 行，按 ctrl+o 展开');

    const expanded = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output,
        is_error: false,
      },
      colors: darkColors,
      expanded: true,
    });

    const expandedOutput = expanded.render(100).map(strip).join('\n');
    expect(expandedOutput).toContain('line01');
    expect(expandedOutput).toContain('line20');
    expect(expandedOutput).not.toContain('ctrl+o to expand');
    expect(expandedOutput).toContain('▾ 按 ctrl+o 折叠');
  });

  it('renders unbounded command preview when previewLines is undefined', () => {
    const cmd = Array.from({ length: 20 }, (_, i) => `step${String(i + 1)}`).join('\n');
    const component = new ShellExecutionComponent({
      command: cmd,
      colors: darkColors,
      showCommand: true,
      commandPreviewLines: undefined,
    });

    const output = component.render(100).map(strip).join('\n');
    expect(output).toContain('$ step1');
    expect(output).toContain('step20');
  });

  describe('shellExecutionResultRenderer', () => {
    const longCmd = `echo ${'a'.repeat(200)}\necho done`;

    it('omits the command preview when collapsed', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: 'ok',
          is_error: false,
        },
        { expanded: false, colors: darkColors },
      );

      const rendered = components
        .flatMap((c) => c.render(100))
        .map(strip)
        .join('\n');
      expect(rendered).not.toContain('$ echo');
      expect(rendered).toContain('ok');
    });

    it('reveals the full multi-line command when expanded', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: 'ok',
          is_error: false,
        },
        { expanded: true, colors: darkColors },
      );

      const rendered = components
        .flatMap((c) => c.render(300))
        .map(strip)
        .join('\n');
      expect(rendered).toContain(`$ echo ${'a'.repeat(200)}`);
      expect(rendered).toContain('echo done');
      expect(rendered).toContain('ok');
    });
  });
});
