import { describe, expect, it } from 'vitest';

import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { darkColors } from '#/tui/theme/colors';
import { t } from '@scream-code/config';

const WIDTH = 200;

function headerOf(
  calls: readonly {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly display?: { kind: 'file_diff'; added: number; removed: number };
    readonly isError?: boolean;
  }[],
): string {
  const group = new ActivityGroupComponent(darkColors, undefined);
  for (const [index, call] of calls.entries()) {
    group.attachTool(
      new ToolCallComponent(
        { id: `t${index}`, name: call.name, args: call.args },
        {
          tool_call_id: `t${index}`,
          output: 'ok',
          is_error: call.isError === true,
          ...(call.display === undefined ? {} : { display: call.display }),
        },
        darkColors,
      ),
      index + 1,
    );
  }
  const lines = group.render(WIDTH);
  return lines.find((line) => line.trim().length > 0) ?? '';
}

const writeArgs = (content: string): Record<string, unknown> => ({
  file_path: '/tmp/x.ts',
  content,
});

const editArgs = (oldText: string, newText: string): Record<string, unknown> => ({
  file_path: '/tmp/y.ts',
  old_string: oldText,
  new_string: newText,
});

describe('activity group diff stat', () => {
  it('uses the exact numbers the mutation tools report', () => {
    // Write overwriting a 4-line file with 3 lines: the tools report the real
    // before/after counts, so the header must show the deletion as well.
    const header = headerOf([
      { name: 'Write', args: writeArgs('a\nb\nc'), display: { kind: 'file_diff', added: 1, removed: 2 } },
    ]);
    expect(header).toContain(t('activitygroup.diff', { added: '+1', removed: '-2' }));
    expect(header).toContain('+1 -2');
  });

  it('uses the reported numbers for a replace-all edit', () => {
    const header = headerOf([
      {
        name: 'Edit',
        args: editArgs('dup', 'DUP'),
        display: { kind: 'file_diff', added: 3, removed: 3 },
      },
    ]);
    expect(header).toContain(t('activitygroup.diff', { added: '+3', removed: '-3' }));
    expect(header).toContain('+3 -3');
  });

  it('omits the deletion count when a record cannot report it', () => {
    // Groups replayed from a resumed session carry no display payload, so the
    // argument fallback runs: it cannot know how many lines a Write replaced,
    // and the header must not claim "-0".
    const header = headerOf([{ name: 'Write', args: writeArgs('a\nb\nc\nd\ne') }]);
    expect(header).toContain(t('activitygroup.diffAddedOnly', { added: '+5' }));
    expect(header).toContain('+5');
    expect(header).not.toContain('-0');
  });

  it('keeps the deletion count out of the group total when any contributor is unknown', () => {
    const header = headerOf([
      { name: 'Write', args: writeArgs('a\nb\nc\nd\ne') },
      { name: 'Edit', args: editArgs('x', 'y'), display: { kind: 'file_diff', added: 1, removed: 2 } },
    ]);
    // Additions always add up; deletions are summed only from known
    // contributors, so a partial sum is never presented as the total.
    expect(header).toContain(t('activitygroup.diffAddedOnly', { added: '+6' }));
    expect(header).toContain('+6');
    expect(header).not.toContain('-2');
  });

  it('ignores a mutation that reports no changes', () => {
    // Identical or empty content produces a zero/zero report: the group must not
    // grow a "+0 -0" segment for a write that changed nothing.
    const header = headerOf([
      {
        name: 'Write',
        args: writeArgs('same content'),
        display: { kind: 'file_diff', added: 0, removed: 0 },
      },
    ]);
    expect(header).not.toContain('+0');
    expect(header).not.toContain('-0');
  });

  it('ignores failed mutations', () => {
    const header = headerOf([
      {
        name: 'Write',
        args: writeArgs('a\nb'),
        display: { kind: 'file_diff', added: 2, removed: 0 },
        isError: true,
      },
    ]);
    expect(header).not.toContain('+2');
  });

  it('still falls back to the argument diff for a recorded edit', () => {
    const header = headerOf([{ name: 'Edit', args: editArgs('old line', 'new line 1\nnew line 2') }]);
    expect(header).toContain(t('activitygroup.diff', { added: '+2', removed: '-1' }));
    expect(header).toContain('+2 -1');
  });
});
