import { describe, expect, it } from 'vitest';

import { t } from '@scream-code/config';
import { pickChip } from '#/tui/components/messages/tool-renderers/chip';
import { pickResultRenderer } from '#/tui/components/messages/tool-renderers/registry';
import { parseReadGroupOutput, readGroupListSummary } from '#/tui/components/messages/tool-renderers/read-group-list';
import { TOOL_OUTPUT_PREVIEW_LINES } from '#/tui/constant/rendering';
import { darkColors } from '#/tui/theme/colors';

const WIDTH = 100;

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function toolCall(args: Record<string, unknown> = {}): {
  id: string;
  name: string;
  args: Record<string, unknown>;
} {
  return { id: 'call_read_group', name: 'ReadGroup', args };
}

function result(output: string): {
  tool_call_id: string;
  output: string;
  is_error: boolean;
} {
  return { tool_call_id: 'call_read_group', output, is_error: false };
}

function renderBody(output: string, expanded: boolean): string {
  const components = readGroupListSummary(toolCall(), result(output), {
    expanded,
    colors: darkColors,
  });
  return components
    .flatMap((component) => component.render(WIDTH))
    .map(strip)
    .join('\n');
}

const TWO_FILES = [
  '--- /workspace/a.ts ---',
  '1\tconst x = 1;',
  '2\tconst y = 2;',
  '<system>2 lines read from file</system>',
  '',
  '--- /workspace/b.ts ---',
  '1\tconst z = 3;',
  '<system>1 lines read from file</system>',
].join('\n');

describe('parseReadGroupOutput', () => {
  it('parses clean file sections with line counts', () => {
    const results = parseReadGroupOutput(TWO_FILES);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      filePath: '/workspace/a.ts',
      lines: 2,
      failed: false,
      hasConflicts: false,
    });
    expect(results[1]).toMatchObject({
      filePath: '/workspace/b.ts',
      lines: 1,
      failed: false,
      hasConflicts: false,
    });
  });

  it('keeps the line count when the reader appends trailing blocks', () => {
    // The reader reports trailing `Imports:` / `Skipped:` blocks after the
    // content, so anchoring the count to the end of the section lost it.
    const output = [
      '--- /workspace/a.ts ---',
      '1\tconst x = 1;',
      '2\tconst y = 2;',
      '<system>2 lines read from file</system>',
      '',
      'Imports: ./b.ts',
      'Skipped: 3 lines unchanged',
    ].join('\n');

    const results = parseReadGroupOutput(output);

    expect(results).toHaveLength(1);
    expect(results[0]?.lines).toBe(2);
  });

  it('flags files containing merge conflict markers', () => {
    const output = [
      '--- /workspace/clean.ts ---',
      '1\tfunction foo() {',
      '2\t  return 1;',
      '3\t}',
      '<system>3 lines read from file</system>',
      '',
      '--- /workspace/conflict.ts ---',
      '1\tfunction foo() {',
      '2\t<<<<<<< HEAD',
      '3\t  return 1;',
      '4\t=======',
      '5\t  return 2;',
      '6\t>>>>>>> branch',
      '7\t}',
      '<system>7 lines read from file</system>',
    ].join('\n');

    const results = parseReadGroupOutput(output);

    expect(results).toHaveLength(2);
    expect(results[0]?.hasConflicts).toBe(false);
    expect(results[1]?.hasConflicts).toBe(true);
  });

  it('marks failed entries when section starts with [ERROR]', () => {
    const output = ['--- /workspace/missing.ts ---', '[ERROR] file does not exist'].join('\n');

    const results = parseReadGroupOutput(output);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      filePath: '/workspace/missing.ts',
      failed: true,
      lines: 0,
    });
    expect(results[0]?.hasConflicts).toBeFalsy();
  });
});

describe('readGroupListSummary', () => {
  it('stays empty while collapsed — the header chip carries the summary', () => {
    expect(renderBody(TWO_FILES, false)).toBe('');
  });

  it('lists each file with its own line count once expanded', () => {
    const body = renderBody(TWO_FILES, true);

    expect(body).toContain('/workspace/a.ts');
    expect(body).toContain(t('readgroup.lines_suffix', { count: '2' }));
    expect(body).toContain('/workspace/b.ts');
    expect(body).toContain(t('readgroup.lines_suffix', { count: '1' }));
  });

  it('marks failed files and conflict markers', () => {
    const output = [
      '--- /workspace/missing.ts ---',
      '[ERROR] file does not exist',
      '',
      '--- /workspace/conflict.ts ---',
      '1\t<<<<<<< HEAD',
      '2\t=======',
      '3\t>>>>>>> branch',
      '<system>3 lines read from file</system>',
    ].join('\n');

    const body = renderBody(output, true);

    expect(body).toContain(t('readgroup.failed_suffix'));
    expect(body).toContain(t('readgroup.conflict_suffix'));
  });

  it('caps the list at the preview budget and counts the rest', () => {
    const sections: string[] = [];
    for (let i = 0; i < TOOL_OUTPUT_PREVIEW_LINES + 4; i += 1) {
      sections.push(`--- /workspace/f${String(i)}.ts ---`, '1\tconst x = 1;', '<system>1 lines read from file</system>', '');
    }
    const body = renderBody(sections.join('\n'), true);
    const rows = body.split('\n').filter((line) => line.includes('/workspace/'));

    expect(rows).toHaveLength(TOOL_OUTPUT_PREVIEW_LINES);
    expect(body).toContain(t('readgroup.more_files', { count: '4' }));
  });

  it('is the renderer the registry picks for ReadGroup', () => {
    expect(pickResultRenderer('ReadGroup')).toBe(readGroupListSummary);
  });
});

describe('readGroupChip', () => {
  it('summarises files and lines', () => {
    const chip = pickChip('ReadGroup');

    expect(chip?.(toolCall(), result(TWO_FILES))).toBe('2 files · 3 lines');
  });

  it('reports failures without dropping the successful counts', () => {
    const chip = pickChip('ReadGroup');
    const output = [
      '--- /workspace/a.ts ---',
      '1\tconst x = 1;',
      '<system>1 lines read from file</system>',
      '',
      '--- /workspace/missing.ts ---',
      '[ERROR] file does not exist',
    ].join('\n');

    expect(chip?.(toolCall(), result(output))).toBe('2 files · 1 line · 1 failed');
  });

  it('reports an all-failed batch as failed', () => {
    const chip = pickChip('ReadGroup');
    const output = ['--- /workspace/missing.ts ---', '[ERROR] file does not exist'].join('\n');

    expect(chip?.(toolCall(), result(output))).toBe('1 file · failed');
  });
});
