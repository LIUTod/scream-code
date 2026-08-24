import { describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { setLocale } from '@scream-code/config';
import {
  ShellExecutionComponent,
  shellExecutionResultRenderer,
} from '#/tui/components/messages/shell-execution';
import { darkColors } from '#/tui/theme/colors';

// Force chalk colors so highlight/dim assertions see real ANSI codes.
chalk.level = 3;

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
    expect(collapsedOutput).toContain('...（还有 5 行，按 ctrl+o 展开）');

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
    expect(expandedOutput).not.toContain('还有 5 行');
    expect(expandedOutput).not.toContain('按 ctrl+o 折叠');
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

    it('keeps the command visible but caps it at 3 lines when collapsed', () => {
      const fiveLineCmd = 'echo one\necho two\necho three\necho four\necho five';
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: fiveLineCmd },
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
      expect(rendered).toContain('$ echo one');
      expect(rendered).toContain('echo three');
      expect(rendered).not.toContain('echo four');
      expect(rendered).not.toContain('echo five');
      // Output is hidden when collapsed — only the expand hint shows.
      expect(rendered).not.toContain('ok');
      expect(rendered).toContain('ctrl+o');
    });

    it('shows the error tail when the command failed', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_err',
          name: 'Bash',
          args: { command: 'false' },
        },
        {
          tool_call_id: 'call_err',
          output: 'bash: false: command not found\nline2\nerror detail',
          is_error: true,
        },
        { expanded: false, colors: darkColors },
      );

      const rendered = components
        .flatMap((c) => c.render(100))
        .map(strip)
        .join('\n');
      // Failure: the error tail stays visible even when collapsed.
      expect(rendered).toContain('bash: false: command not found');
      expect(rendered).toContain('error detail');
    });

    it('highlights the command instead of dimming it', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: 'echo hi' },
        },
        {
          tool_call_id: 'call_1',
          output: 'ok',
          is_error: false,
        },
        { expanded: false, colors: darkColors },
      );

      const raw = components
        .flatMap((c) => c.render(100))
        .join('\n');
      const cmdLine = raw.split('\n').find((l) => l.includes('echo'));
      expect(cmdLine).toBeDefined();
      // Only the `$ ` prefix may be dim; the command body itself must not be
      // dim — bash highlighting applies truecolor (38;2;r;g;b) codes instead.
      expect(cmdLine!.includes('\u001B[2m$ ')).toBe(true);
      expect(cmdLine!).toMatch(/\u001B\[38;2;\d+;\d+;\d+m/);
      expect(cmdLine!.includes('\u001B[2mecho')).toBe(false);
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
