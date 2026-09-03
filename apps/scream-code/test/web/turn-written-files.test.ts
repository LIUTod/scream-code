import { describe, expect, it } from 'vitest';

import type { ChatMessage, ToolMessage } from '../../src/web/frontend/src/types';
import {
  extractTurnWrittenFiles,
  resolveWrittenPath,
} from '../../src/web/frontend/src/utils/turnWrittenFiles';

const CWD = '/Users/dev/project';

let seq = 0;

/** A ToolMessage in its real shape; defaults to a settled successful call. */
function tool(overrides: Partial<ToolMessage>): ToolMessage {
  seq += 1;
  return { toolCallId: `tc-${seq}`, name: 'Write', output: 'ok', ...overrides };
}

function msg(tools: ToolMessage[], content = 'done'): ChatMessage {
  return { id: 'm1', role: 'assistant', content, tools };
}

describe('extractTurnWrittenFiles', () => {
  it('collects successful write/edit calls in first-seen order', () => {
    const m = msg([
      tool({ name: 'Write', args: { path: 'src/a.ts', content: 'x' } }),
      tool({ name: 'Edit', args: { path: 'src/b.ts', old_string: 'a', new_string: 'b' } }),
    ]);
    expect(extractTurnWrittenFiles(m, CWD)).toEqual([
      { filePath: '/Users/dev/project/src/a.ts', toolName: 'Write' },
      { filePath: '/Users/dev/project/src/b.ts', toolName: 'Edit' },
    ]);
  });

  it('reads file_path in preference to path and skips calls without a path arg', () => {
    const m = msg([
      tool({ name: 'Edit', args: { path: 'ignored.ts', file_path: 'winner.ts' } }),
      tool({ name: 'Write', args: { content: 'no path here' } }),
      tool({ name: 'Write' }), // no args at all
    ]);
    expect(extractTurnWrittenFiles(m, CWD)).toEqual([
      { filePath: '/Users/dev/project/winner.ts', toolName: 'Edit' },
    ]);
  });

  it('skips failed calls, suspended calls, and calls without a result yet', () => {
    const m = msg([
      tool({ name: 'Write', args: { path: 'a.ts' }, isError: true, output: 'boom' }),
      tool({ name: 'Write', args: { path: 'b.ts' }, output: undefined }),
      tool({ name: 'Edit', args: { path: 'c.ts' }, suspended: true, output: undefined }),
      tool({ name: 'Write', args: { path: 'd.ts' }, output: '' }), // empty output is still a result
    ]);
    expect(extractTurnWrittenFiles(m, CWD)).toEqual([
      { filePath: '/Users/dev/project/d.ts', toolName: 'Write' },
    ]);
  });

  it('skips non-writing tools even when they succeed', () => {
    const m = msg([
      tool({ name: 'Read', args: { path: 'a.ts' } }),
      tool({ name: 'Bash', args: { command: 'echo hi > a.ts' } }),
      tool({ name: 'Grep', args: { pattern: 'x', path: 'src' } }),
    ]);
    expect(extractTurnWrittenFiles(m, CWD)).toEqual([]);
  });

  it('normalizes write/edit tool names case-insensitively', () => {
    const m = msg([
      tool({ name: 'write', args: { path: 'a.ts' } }),
      tool({ name: 'EDIT', args: { path: 'b.ts' } }),
      tool({ name: 'multi_edit', args: { path: 'c.ts' } }),
    ]);
    expect(extractTurnWrittenFiles(m, CWD).map((f) => f.filePath)).toEqual([
      '/Users/dev/project/a.ts',
      '/Users/dev/project/b.ts',
      '/Users/dev/project/c.ts',
    ]);
  });

  it('dedupes by resolved path while keeping first-seen order', () => {
    const m = msg([
      tool({ name: 'Write', args: { path: 'src/a.ts' } }),
      tool({ name: 'Edit', args: { path: './src/a.ts' } }),
      tool({ name: 'Write', args: { path: 'src/b.ts' } }),
      tool({ name: 'Edit', args: { path: '/Users/dev/project/src/a.ts' } }),
    ]);
    expect(extractTurnWrittenFiles(m, CWD).map((f) => f.filePath)).toEqual([
      '/Users/dev/project/src/a.ts',
      '/Users/dev/project/src/b.ts',
    ]);
  });

  it('keeps relative paths untouched when no cwd is available', () => {
    const m = msg([tool({ name: 'Write', args: { path: './src/a.ts' } })]);
    expect(extractTurnWrittenFiles(m)).toEqual([
      { filePath: 'src/a.ts', toolName: 'Write' },
    ]);
  });

  it('returns an empty list for a message without tools', () => {
    expect(extractTurnWrittenFiles(msg([]))).toEqual([]);
  });

  it('never derives entries from the message text itself', () => {
    const m = msg([], '我本想写 /tmp/mentioned.ts，但没有动手');
    expect(extractTurnWrittenFiles(m, CWD)).toEqual([]);
  });
});

describe('resolveWrittenPath', () => {
  it('joins relative paths onto cwd and strips leading ./ segments', () => {
    expect(resolveWrittenPath('src/a.ts', CWD)).toBe('/Users/dev/project/src/a.ts');
    expect(resolveWrittenPath('./src/a.ts', CWD)).toBe('/Users/dev/project/src/a.ts');
  });

  it('tolerates a trailing slash on cwd', () => {
    expect(resolveWrittenPath('a.ts', `${CWD}/`)).toBe('/Users/dev/project/a.ts');
  });

  it('keeps absolute paths untouched', () => {
    expect(resolveWrittenPath('/etc/hosts', CWD)).toBe('/etc/hosts');
  });

  it('keeps ~ paths untouched', () => {
    expect(resolveWrittenPath('~/notes.md', CWD)).toBe('~/notes.md');
  });
});
