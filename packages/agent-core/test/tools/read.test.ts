import type { Jian } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import type { LspClient, LspSymbolOutline } from '../../src/lsp/client';
import type { LspRegistry } from '../../src/lsp/registry';
import {
  MAX_BYTES,
  MAX_LINE_BYTES,
  MAX_LINES,
  type ReadInput,
  ReadInputSchema,
  ReadTool,
} from '../../src/tools/builtin/file/read';
import { ReadGroupTool, type ReadGroupInput } from '../../src/tools/builtin/file/read-group';
import { computeAnchor, toModelTextView } from '../../src/tools/builtin/file/line-endings';
import { MEDIA_SNIFF_BYTES } from '../../src/tools/support/file-type';
import { RepetitionGuard } from '../../src/tools/support/repetition-guard';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeJian, PERMISSIVE_WORKSPACE, toolContentString } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const REGULAR_FILE_STAT = {
  stMode: 0o100_644,
  stIno: 1,
  stDev: 1,
  stNlink: 1,
  stUid: 1000,
  stGid: 1000,
  stSize: 0,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
} satisfies Awaited<ReturnType<Jian['stat']>>;

const DIRECTORY_STAT = {
  ...REGULAR_FILE_STAT,
  stMode: 0o040_755,
} satisfies Awaited<ReturnType<Jian['stat']>>;

function context(args: ReadInput) {
  return {
    turnId: '0',
    toolCallId: 'call_read',
    args,
    signal,
  };
}

function linesFromContent(content: string): string[] {
  if (content === '') return [];
  const rawLines = content.split('\n');
  return rawLines.flatMap((line, index) => {
    if (index < rawLines.length - 1) return [`${line}\n`];
    return line === '' ? [] : [line];
  });
}

function readLinesFromContent(content: string): Jian['readLines'] {
  return async function* readLines(): AsyncGenerator<string> {
    for (const line of linesFromContent(content)) {
      yield line;
    }
  };
}

function withReadStatus(output: string, status: string, content: string): string {
  const anchor = computeAnchor(toModelTextView(content).text);
  const note = `<system>${status} Anchor: ${anchor}</system>`;
  return output.length > 0 ? `${output}\n${note}` : note;
}

function toolWithContent(content: string, workspace: WorkspaceConfig = PERMISSIVE_WORKSPACE) {
  const bytes = Buffer.from(content, 'utf8');
  return new ReadTool(
    createFakeJian({
      stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
      readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
        return n === undefined ? bytes : bytes.subarray(0, n);
      }),
      readLines: vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(content)),
      readText: vi.fn<Jian['readText']>().mockResolvedValue(content),
    }),
    workspace,
  );
}

/** ReadTool wired to a repetition guard, over content that can change between reads (simulating an edit). */
function guardedToolWithMutableContent(getContent: () => string, guard: RepetitionGuard) {
  return new ReadTool(
    createFakeJian({
      stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
      readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
        const bytes = Buffer.from(getContent(), 'utf8');
        return n === undefined ? bytes : bytes.subarray(0, n);
      }),
      readLines: vi.fn<Jian['readLines']>().mockImplementation(async function* readLines() {
        for (const line of linesFromContent(getContent())) {
          yield line;
        }
      }),
      readText: vi.fn<Jian['readText']>().mockImplementation(async () => getContent()),
    }),
    PERMISSIVE_WORKSPACE,
    undefined,
    guard,
  );
}

describe('ReadTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = toolWithContent('');

    expect(tool.name).toBe('Read');
    expect(tool.description).toContain('concrete file path');
    expect(tool.description).toContain('Pure CRLF files are displayed with LF');
    expect(tool.description).not.toContain('skip the verification re-read');
    expect(tool.description).toContain('final external contract');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: expect.stringContaining('working directory'),
        },
        line_offset: {
          description: expect.stringContaining('line number to start reading from'),
        },
        n_lines: {
          description: expect.stringContaining('number of lines to read'),
        },
      },
    });
    expect(ReadInputSchema.safeParse({ path: '/tmp/test.txt' }).success).toBe(true);
    expect(
      ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: 1, n_lines: 2 }).success,
    ).toBe(true);
    expect(ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: 0 }).success).toBe(
      false,
    );
    expect(
      ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: -(MAX_LINES + 1) }).success,
    ).toBe(false);
  });

  it('matches permission args with glob path semantics', async () => {
    const tool = toolWithContent('');
    const execution = await tool.resolveExecution({ path: '/etc/passwd' });
    if (execution.isError === true) throw new TypeError('expected runnable execution');

    expect(execution.matchesRule?.('/etc/**')).toBe(true);
    expect(execution.matchesRule?.('/var/**')).toBe(false);
  });

  it('reads text content with stable one-based line numbers', async () => {
    const tool = toolWithContent('alpha\nbeta\n');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt' }));

    expect(result).toEqual({
      output: withReadStatus(
        '1\talpha\n2\tbeta',
        '2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.',
        'alpha\nbeta\n'),
    });
  });

  it('normalizes pure CRLF files to the LF model view', async () => {
    const tool = toolWithContent('alpha\r\nbeta\r\n');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        '1\talpha\n2\tbeta',
        '2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.',
        'alpha\r\nbeta\r\n'),
    );
  });

  it('makes mixed carriage returns visible instead of normalizing them', async () => {
    const tool = toolWithContent('alpha\r\nbeta\ngamma\rdone');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        '1\talpha\\r\n2\tbeta\n3\tgamma\\rdone',
        '3 lines read from file starting from line 1. Total lines in file: 3. End of file reached. Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.',
        'alpha\r\nbeta\ngamma\rdone'),
    );
  });

  it('respects one-based line_offset and positive n_lines', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: 2, n_lines: 2 }));

    expect(result).toEqual({
      output: withReadStatus(
        '2\tb\n3\tc',
        '2 lines read from file starting from line 2. Total lines in file: 5.',
        'a\nb\nc\nd\ne'),
    });
  });

  it('returns an empty successful output when line_offset is beyond EOF', async () => {
    const tool = toolWithContent('a\nb');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: 20 }));

    expect(result).toEqual({
      output: withReadStatus(
        '',
        'No lines read from file. Total lines in file: 2. End of file reached.',
        'a\nb'),
    });
  });

  it('supports negative line_offset as tail mode with absolute line numbers', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: -3 }));

    expect(result).toEqual({
      output: withReadStatus(
        '3\tc\n4\td\n5\te',
        '3 lines read from file starting from line 3. Total lines in file: 5. End of file reached.',
        'a\nb\nc\nd\ne'),
    });
  });

  it('applies n_lines from the start of the negative line_offset tail window', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: -5, n_lines: 2 }));

    expect(result.output).toBe(
      withReadStatus(
        '1\ta\n2\tb',
        '2 lines read from file starting from line 1. Total lines in file: 5.',
        'a\nb\nc\nd\ne'),
    );
  });

  it('rejects relative traversal before reading', async () => {
    const readText = vi.fn().mockResolvedValue('secret');
    const tool = new ReadTool(createFakeJian({ readText }), {
      workspaceDir: '/workspace/project',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '../../outside.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(readText).not.toHaveBeenCalled();
  });

  it('allows explicit absolute paths outside the workspace', async () => {
    const content = 'external';
    const bytes = Buffer.from(content, 'utf8');
    const readBytes = vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
      return n === undefined ? bytes : bytes.subarray(0, n);
    });
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(content));
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes,
        readLines,
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '/tmp/external.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        '1\texternal',
        '1 line read from file starting from line 1. Total lines in file: 1. End of file reached.',
        'external'),
    );
    expect(readBytes).toHaveBeenCalledWith('/tmp/external.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/tmp/external.txt', { errors: 'strict', signal });
  });

  it('returns a friendly error for missing files before sniffing bytes', async () => {
    const statError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const readBytes = vi
      .fn<Jian['readBytes']>()
      .mockRejectedValue(new Error('readBytes should not be called for missing files'));
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(''));
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockRejectedValue(statError),
        readBytes,
        readLines,
        glob: async function* () {},
        iterdir: async function* () {},
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '/workspace/missing.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('"/workspace/missing.txt" does not exist.');
    expect(readBytes).not.toHaveBeenCalled();
    expect(readLines).not.toHaveBeenCalled();
  });

  it('returns a friendly error for directories before sniffing bytes', async () => {
    const readBytes = vi
      .fn<Jian['readBytes']>()
      .mockRejectedValue(new Error('readBytes should not be called for directories'));
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(''));
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(DIRECTORY_STAT),
        readBytes,
        readLines,
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '/workspace/src' }));

    expect(result).toEqual({
      isError: true,
      output: '"/workspace/src" is not a file.',
    });
    expect(readBytes).not.toHaveBeenCalled();
    expect(readLines).not.toHaveBeenCalled();
  });

  it('expands leading tilde paths using the jian home directory', async () => {
    const content = 'home note';
    const bytes = Buffer.from(content, 'utf8');
    const readBytes = vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
      return n === undefined ? bytes : bytes.subarray(0, n);
    });
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(content));
    const tool = new ReadTool(
      createFakeJian({
        gethome: () => '/home/test',
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes,
        readLines,
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '~/notes/today.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        '1\thome note',
        '1 line read from file starting from line 1. Total lines in file: 1. End of file reached.',
        'home note'),
    );
    expect(readBytes).toHaveBeenCalledWith('/home/test/notes/today.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/home/test/notes/today.txt', {
      errors: 'strict',
      signal,
    });
  });

  it('blocks sensitive files independently from workspace access', async () => {
    const readText = vi.fn().mockResolvedValue('SECRET=value');
    const tool = new ReadTool(createFakeJian({ readText }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '/workspace/.env' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('sensitive-file pattern');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects image files before text decoding and points to ReadMediaFile', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const readText = vi
      .fn<Jian['readText']>()
      .mockRejectedValue(new Error('readText should not be called for images'));
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(pngHeader),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/sample.png' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/image file/i);
    expect(output).toMatch(/ReadMediaFile|media/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects extensionless image files using magic-byte sniffing', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const readText = vi
      .fn<Jian['readText']>()
      .mockRejectedValue(new Error('readText should not be called for extensionless images'));
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(pngHeader),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/sample' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/image file/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects video files before text decoding', async () => {
    const mp4Header = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('mp42'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('mp42isom'),
    ]);
    const readText = vi
      .fn<Jian['readText']>()
      .mockRejectedValue(new Error('readText should not be called for videos'));
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(mp4Header),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/sample.mp4' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/video file/i);
    expect(output).toMatch(/ReadMediaFile|media/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects NUL-containing binary files before text decoding', async () => {
    const header = Buffer.concat([Buffer.from('plain prefix'), Buffer.from([0x00, 0x01])]);
    const readText = vi
      .fn<Jian['readText']>()
      .mockRejectedValue(new Error('readText should not be called for binary files'));
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(header),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/blob.bin' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/blob.bin" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(output).not.toContain('Python tools');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects NUL bytes that appear after the preflight header', async () => {
    const header = Buffer.from('text prefix without nul', 'utf8');
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(async function* readLines() {
      yield 'safe text\n';
      yield `binary${String.fromCodePoint(0)}tail\n`;
    });
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(header),
        readLines,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/blob-with-late-nul' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/blob-with-late-nul" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(output).not.toContain('Python tools');
  });

  it('rejects invalid UTF-8 instead of returning replacement characters', async () => {
    const replacement = String.fromCodePoint(0xfffd);
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(async function* readLines(
      _path,
      options,
    ) {
      if (options?.errors === 'strict') {
        throw new TypeError('The encoded data was not valid for encoding utf-8');
      }
      yield `bad${replacement}text\n`;
    });
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(Buffer.from('text header')),
        readLines,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/not-utf8.txt' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/not-utf8.txt" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(output).not.toContain('Python tools');
    expect(output).not.toContain(replacement);
    expect(output).not.toContain('encoded data was not valid');
  });

  it('truncates long lines and surfaces the affected line numbers', async () => {
    const long = 'x'.repeat(MAX_LINE_BYTES + 10);
    const tool = toolWithContent([long, 'short', long].join('\n'));

    const result = await executeTool(tool, context({ path: '/tmp/long.txt' }));

    expect(result.output).toContain('Line(s) [1, 3]');
    expect(result.output).toContain('line limit');
    expect(result.output).toContain('...');
  });

  it('checks the byte cap before adding the next rendered line', async () => {
    const line = 'x'.repeat(MAX_LINE_BYTES);
    const content = Array.from({ length: 80 }, () => line).join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool, context({ path: '/tmp/bytes.txt' }));
    const output = toolContentString(result);

    const marker = '\n<system>';
    const markerIndex = output.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(0);
    const body = output.slice(0, markerIndex);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    expect(output).toContain(`Max ${String(MAX_BYTES)} bytes reached.`);
  });

  it('reads through bounded byte preflight and streams line iteration without full readText', async () => {
    const content = Array.from({ length: MAX_LINES + 5 }, (_, i) => `line ${String(i + 1)}`).join(
      '\n',
    );
    const bytes = Buffer.from(content, 'utf8');
    const readText = vi
      .fn<Jian['readText']>()
      .mockRejectedValue(new Error('full readText should not be called'));
    let consumed = 0;
    const readLines: Jian['readLines'] = async function* readLines(): AsyncGenerator<string> {
      for (let i = 1; i <= MAX_LINES + 5; i += 1) {
        consumed = i;
        yield `line ${String(i)}\n`;
      }
    };
    const readBytes = vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
      return n === undefined ? bytes : bytes.subarray(0, n);
    });
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes,
        readLines,
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/large.txt' }));
    const output = toolContentString(result);

    expect(result.isError).toBeFalsy();
    expect(output).toContain('1\tline 1');
    expect(output).toContain(`${String(MAX_LINES)}\tline ${String(MAX_LINES)}`);
    expect(output).toContain(`Total lines in file: ${String(MAX_LINES + 5)}.`);
    expect(output).toContain(`Max ${String(MAX_LINES)} lines reached.`);
    expect(consumed).toBe(MAX_LINES + 5);
    expect(readBytes).toHaveBeenCalledWith('/tmp/large.txt', MEDIA_SNIFF_BYTES);
    expect(readText).not.toHaveBeenCalled();
  });

  it('forwards the execution signal into jian.readLines and stops the read on abort', async () => {
    // Behavioural contract: jian polls the signal per chunk/line and ends the
    // iteration where it fires, so a forwarded signal stops the read early.
    // The fake mirrors that contract and aborts the caller's controller once
    // three lines went through.
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let linesConsumed = 0;
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(async function* readLines(
      _path,
      options,
    ) {
      seenSignal = options?.signal;
      for (let i = 1; i <= 100; i += 1) {
        if (options?.signal?.aborted === true) return;
        linesConsumed = i;
        yield `line ${String(i)}\n`;
        if (i === 3) controller.abort();
      }
    });
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(Buffer.from('text header')),
        readLines,
      }),
      PERMISSIVE_WORKSPACE,
    );

    await expect(
      executeTool(tool, { ...context({ path: '/tmp/cancel.txt' }), signal: controller.signal }),
    ).rejects.toThrow();

    expect(seenSignal).toBe(controller.signal);
    // Stopped where the signal fired (line 3), not after the full 100 lines.
    expect(linesConsumed).toBe(3);
  });

  it('forwards the execution signal into jian.readLines on the tail path too', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let linesConsumed = 0;
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(async function* readLines(
      _path,
      options,
    ) {
      seenSignal = options?.signal;
      for (let i = 1; i <= 100; i += 1) {
        if (options?.signal?.aborted === true) return;
        linesConsumed = i;
        yield `line ${String(i)}\n`;
        if (i === 3) controller.abort();
      }
    });
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(Buffer.from('text header')),
        readLines,
      }),
      PERMISSIVE_WORKSPACE,
    );

    await expect(
      executeTool(tool, {
        ...context({ path: '/tmp/cancel-tail.txt', line_offset: -5 }),
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(seenSignal).toBe(controller.signal);
    expect(linesConsumed).toBe(3);
  });

  it('caps default reads at MAX_LINES', async () => {
    const content = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${String(i + 1)}`).join(
      '\n',
    );
    const tool = toolWithContent(content);

    const result = await executeTool(tool, context({ path: '/tmp/big.txt' }));

    expect(result.output).toContain(`Max ${String(MAX_LINES)} lines reached.`);
    expect(result.output).toContain(`${String(MAX_LINES)}\tline ${String(MAX_LINES)}`);
    expect(result.output).not.toContain(`${String(MAX_LINES + 1)}\tline ${String(MAX_LINES + 1)}`);
  });

  it('tail byte truncation keeps the newest lines closest to EOF', async () => {
    const numLines = Math.floor(MAX_BYTES / 1001) + 20;
    const content = Array.from({ length: numLines }, (_, i) => {
      return `${String(i + 1).padStart(4, '0')}${'B'.repeat(996)}`;
    }).join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool, context({ path: '/tmp/tail-bytes.txt', line_offset: -1000 }));
    const output = toolContentString(result);
    const outputLines = output
      .split('\n')
      .filter((line) => line.includes('\t') && !line.startsWith('<system>'));

    expect(output).toContain(`Max ${String(MAX_BYTES)} bytes reached.`);
    expect(outputLines.at(-1)).toContain(String(numLines).padStart(4, '0'));
    expect(outputLines[0]).not.toContain('0001');
  });

  it('tail n_lines is applied before byte truncation', async () => {
    const numLines = 500;
    const content = Array.from({ length: numLines }, (_, i) => {
      return `${String(i + 1).padStart(4, '0')}${'X'.repeat(1996)}`;
    }).join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool,
      context({ path: '/tmp/tail-small-window.txt', line_offset: -200, n_lines: 1 }),
    );
    const output = toolContentString(result);

    expect(output).toMatch(/^301\t0301/);
    expect(output).not.toContain('Max');
  });

  it('description pins byte caps and the Grep-over-Read preference', () => {
    const tool = toolWithContent('');
    // Line/byte caps: MAX_LINE_BYTES is in the description; MAX_LINES and
    // tail mode are documented in the field-level schema describe.
    expect(tool.description).toContain(String(MAX_LINE_BYTES));
    // Recommend Grep when searching for unknown content.
    expect(tool.description).toContain('Grep');
  });

  it('reads files inside additional_dirs via absolute path', async () => {
    const content = 'extra-dir note';
    const bytes = Buffer.from(content, 'utf8');
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
          return n === undefined ? bytes : bytes.subarray(0, n);
        }),
        readLines: vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(content)),
      }),
      { workspaceDir: '/workspace', additionalDirs: ['/extra'] },
    );

    const result = await executeTool(tool,context({ path: '/extra/notes.txt' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\textra-dir note');
  });

  it('reports nonexistent files with the expected does-not-exist phrasing', async () => {
    const statError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockRejectedValue(statError),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,context({ path: '/workspace/ghost.txt' }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist');
    // py also surfaces a separate `brief` channel with "File not found";
    // TS only has the `output` string, so we check for the equivalent
    // human phrasing in the message itself.
    expect(result.output).toMatch(/not found|does not exist/i);
  });

  it('returns empty output and Total lines: 0 for an empty file', async () => {
    const tool = toolWithContent('');

    const result = await executeTool(tool,context({ path: '/tmp/empty.txt' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      withReadStatus(
        '',
        'No lines read from file. Total lines in file: 0. End of file reached.',
        ''),
    );
  });

  it('reads unicode (CJK + emoji + accented Latin) without loss', async () => {
    const tool = toolWithContent('Hello 世界 🌍\nUnicode test: café, naïve, résumé');

    const result = await executeTool(tool,context({ path: '/tmp/unicode.txt' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\tHello 世界 🌍');
    expect(result.output).toContain('2\tUnicode test: café, naïve, résumé');
  });

  it('schema validation rejects n_lines=0 and n_lines=-1 with an n_lines-keyed error', () => {
    const zero = ReadInputSchema.safeParse({ path: '/tmp/a.txt', n_lines: 0 });
    expect(zero.success).toBe(false);
    if (!zero.success) {
      const message = JSON.stringify(zero.error.issues);
      expect(message).toContain('n_lines');
    }

    const negative = ReadInputSchema.safeParse({ path: '/tmp/a.txt', n_lines: -1 });
    expect(negative.success).toBe(false);
    if (!negative.success) {
      const message = JSON.stringify(negative.error.issues);
      expect(message).toContain('n_lines');
    }
  });

  it('schema validation accepts -1 and -MAX_LINES but rejects -(MAX_LINES + 1)', () => {
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -1 }).success).toBe(true);
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -MAX_LINES }).success).toBe(
      true,
    );
    expect(
      ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -(MAX_LINES + 1) }).success,
    ).toBe(false);
  });

  it('reads non-sensitive dotfiles like .gitignore successfully', async () => {
    const tool = toolWithContent('node_modules/\n');

    const result = await executeTool(tool,context({ path: '/workspace/.gitignore' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('node_modules/');
  });

  it('negative line_offset exceeding total lines returns the entire file', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool,context({ path: '/tmp/short.txt', line_offset: -100 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\ta');
    expect(result.output).toContain('5\te');
    expect(result.output).toContain('Total lines in file: 5.');
  });

  it('tail mode on an empty file returns empty output without erroring', async () => {
    const tool = toolWithContent('');

    const result = await executeTool(tool,context({ path: '/tmp/empty-tail.txt', line_offset: -10 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Total lines in file: 0.');
  });

  it('line_offset=-1 returns only the last line with its absolute line number', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool,context({ path: '/tmp/last.txt', line_offset: -1 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('5\te');
    expect(result.output).toContain('1 line read from file starting from line 5.');
  });

  it('tail mode reports absolute line numbers when long lines are truncated', async () => {
    const shortLine = 'short';
    const longLine = 'X'.repeat(MAX_LINE_BYTES + 500);
    const content = [shortLine, longLine, shortLine, longLine, shortLine].join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool,context({ path: '/tmp/tail-trunc.txt', line_offset: -3 }));

    expect(result.isError).toBeFalsy();
    // Last 3 lines = 3, 4, 5; line 4 is the long one.
    expect(result.output).toContain('Total lines in file: 5.');
    expect(result.output).toContain('Line(s) [4]');
    expect(result.output).toContain('line limit');
  });
});

describe('ReadTool description and schema parity', () => {
  it('encourages reading multiple files in parallel', () => {
    const tool = toolWithContent('');

    expect(tool.description).toMatch(/parallel/i);
    expect(tool.description).toMatch(/multiple `Read` calls in a single response/i);
  });

  it('explains the trailing <system> status block', () => {
    const tool = toolWithContent('');

    expect(tool.description).toContain('<system>');
    // The TS implementation appends the status block after the content.
    expect(tool.description).toMatch(/after the file content/i);
  });

  it('describes the path parameter with accurate working-directory semantics', () => {
    const tool = toolWithContent('');
    const pathProperty = (
      tool.parameters as { properties: { path: { description: string } } }
    ).properties.path;

    expect(pathProperty.description).toContain('working directory');
    expect(pathProperty.description).not.toMatch(/^Absolute path/);
  });

  it('documents the default for n_lines when omitted', () => {
    const tool = toolWithContent('');
    const nLinesProperty = (
      tool.parameters as { properties: { n_lines: { description: string } } }
    ).properties.n_lines;

    // Omitting n_lines reads up to MAX_LINES; the schema description must say so.
    expect(nLinesProperty.description).toMatch(/omit/i);
    expect(nLinesProperty.description).toContain(String(MAX_LINES));
  });

  it('warns that sensitive files are refused', () => {
    const tool = toolWithContent('');

    expect(tool.description).toMatch(/refuse|reject|decline|block/i);
    expect(tool.description).toMatch(/sensitive|credential|secret|\.env|SSH key/i);
  });

  it('explains that non-UTF-8 and binary files are refused', () => {
    const tool = toolWithContent('');

    expect(tool.description).toMatch(/UTF-?8/i);
    expect(tool.description).toMatch(/binary/i);
  });
});

describe('ReadTool suffix-match recovery', () => {
  const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  function fakeJianWithGlob(globPaths: string[], enoentPaths: string[] = []) {
    const content = 'recovered content';
    const bytes = Buffer.from(content, 'utf8');
    const enoentSet = new Set(enoentPaths);
    return createFakeJian({
      stat: vi.fn<Jian['stat']>().mockImplementation(async (p) => {
        if (enoentSet.has(p)) throw enoentError;
        return REGULAR_FILE_STAT;
      }),
      readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_p, n) =>
        n === undefined ? bytes : bytes.subarray(0, n),
      ),
      readLines: vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(content)),
      glob: async function* glob(): AsyncGenerator<string> {
        for (const p of globPaths) yield p;
      },
      iterdir: async function* iterdir(): AsyncGenerator<string> {},
    });
  }

  it('resolves missing file via unique suffix match', async () => {
    const tool = new ReadTool(
      fakeJianWithGlob(['/workspace/src/utils/foo.ts'], ['/workspace/src/tils/foo.ts']),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ path: '/workspace/src/tils/foo.ts' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('recovered content');
    expect(result.output).toContain(
      "[Path '/workspace/src/tils/foo.ts' not found; resolved to '/workspace/src/utils/foo.ts' via suffix match]",
    );
  });

  it('counts a suffix-resolved retry under the raw requested path', async () => {
    const guard = new RepetitionGuard();
    const recordSpy = vi.spyOn(guard, 'record');
    const tool = new ReadTool(
      fakeJianWithGlob(['/workspace/src/utils/foo.ts'], ['/workspace/src/tils/foo.ts']),
      { workspaceDir: '/workspace', additionalDirs: [] },
      undefined,
      guard,
    );
    const notice =
      "[Path '/workspace/src/tils/foo.ts' not found; resolved to '/workspace/src/utils/foo.ts' via suffix match]";

    const first = await executeTool(tool, context({ path: '/workspace/src/tils/foo.ts' }));
    expect(toolContentString(first)).toContain('recovered content');
    // The resolution notice is prepended exactly once, above the content and
    // outside the <system> block; the first read is still silent on repetition.
    expect(toolContentString(first).split(notice)).toHaveLength(2);
    expect(toolContentString(first).startsWith(`${notice}\n`)).toBe(true);
    expect(toolContentString(first)).not.toContain('Note: this window');

    const second = await executeTool(tool, context({ path: '/workspace/src/tils/foo.ts' }));
    const output = toolContentString(second);
    // The notice still appears exactly once, prepended and outside the
    // <system> block even on the retry that carries a repetition note.
    expect(output.split(notice)).toHaveLength(2);
    expect(output.startsWith(`${notice}\n`)).toBe(true);
    // Second identical fetch of the same RAW path → the repetition note
    // appears (count 2): both guard records keyed on the raw args.path,
    // never on the suffix-resolved absolute path.
    expect(output).toContain('Note: this window is identical to the previous read');
    expect(recordSpy.mock.calls.map((call) => call[0])).toEqual([
      'read:/workspace/src/tils/foo.ts',
      'read:/workspace/src/tils/foo.ts',
    ]);
    expect(recordSpy.mock.results.map((result) => result.value)).toEqual([
      { count: 1, level: 0 },
      { count: 2, level: 1 },
    ]);
    // The <system> block remains the output tail.
    expect(output).toMatch(/<system>.*<\/system>\s*$/);
    expect(output).toMatch(/<system>.*Note: this window is identical.*<\/system>\s*$/);
  });

  it('does not resolve when multiple suffix matches exist', async () => {
    const tool = new ReadTool(
      fakeJianWithGlob(
        ['/workspace/a/foo.ts', '/workspace/b/foo.ts'],
        ['/workspace/foo.ts'],
      ),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ path: '/workspace/foo.ts' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
    expect(result.output).not.toContain('resolved to');
  });

  it('does not resolve when no suffix match exists', async () => {
    const tool = new ReadTool(
      fakeJianWithGlob([], ['/workspace/missing.ts']),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ path: '/workspace/missing.ts' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
    expect(result.output).not.toContain('resolved to');
  });

  it('falls back when suffix-matched path also fails stat', async () => {
    const tool = new ReadTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockRejectedValue(enoentError),
        glob: async function* glob(): AsyncGenerator<string> {
          yield '/workspace/src/utils/foo.ts';
        },
        iterdir: async function* iterdir(): AsyncGenerator<string> {},
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ path: '/workspace/src/tils/foo.ts' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
  });
});

describe('ReadTool — LSP declaration outline footer', () => {
  // The footer only applies to long files (≥ OUTLINE_MIN_TOTAL_LINES lines),
  // so every fixture here crosses that threshold.
  const BIG_FILE_CONTENT = Array.from({ length: 410 }, (_, i) => `line ${String(i + 1)}`).join('\n');
  const BIG_OUTLINE: LspSymbolOutline[] = [
    { name: 'Foo', kind: 5, line: 2, depth: 0 },
    { name: 'bar', kind: 6, line: 30, depth: 1 },
  ];

  function fakeRegistryWith(client: unknown): LspRegistry {
    return {
      activeClientFor: vi.fn().mockResolvedValue(client),
      languageIdForPath: vi.fn().mockReturnValue(client === undefined ? undefined : 'typescript'),
    } as unknown as LspRegistry;
  }

  function fakeLspClient(outline: LspSymbolOutline[] | Error): LspClient {
    return {
      didOpen: vi.fn(),
      documentSymbol: vi.fn().mockImplementation(() =>
        outline instanceof Error ? Promise.reject(outline) : Promise.resolve(outline),
      ),
    } as unknown as LspClient;
  }

  function toolWithContentAndRegistry(
    content: string,
    registry?: LspRegistry,
    overrides: { readText?: Jian['readText']; stat?: Jian['stat'] } = {},
  ): ReadTool {
    const bytes = Buffer.from(content, 'utf8');
    return new ReadTool(
      createFakeJian({
        stat: overrides.stat ?? vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
          return n === undefined ? bytes : bytes.subarray(0, n);
        }),
        readLines: vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(content)),
        readText: overrides.readText ?? vi.fn<Jian['readText']>().mockResolvedValue(content),
      }),
      PERMISSIVE_WORKSPACE,
      registry,
    );
  }

  function fullReadStatus(totalLines: number): string {
    return `${String(totalLines)} lines read from file starting from line 1. Total lines in file: ${String(totalLines)}. End of file reached.`;
  }

  function renderedContent(content: string): string {
    return content
      .split('\n')
      .map((line, i) => `${String(i + 1)}\t${line}`)
      .join('\n');
  }

  function expectedOutputWithoutFooter(content: string, totalLines: number): string {
    return withReadStatus(renderedContent(content), fullReadStatus(totalLines), content);
  }

  // The footer rides the same message chain as the conflict notice, i.e.
  // AFTER the `Anchor: …` suffix that finishMessage emits last.
  function expectedOutputWithFooter(content: string, totalLines: number, footer: string): string {
    const anchor = computeAnchor(toModelTextView(content).text);
    const note = `<system>${fullReadStatus(totalLines)} Anchor: ${anchor} ${footer}</system>`;
    return `${renderedContent(content)}\n${note}`;
  }

  it('appends the declaration outline to the status block for a long file with an active client', async () => {
    const client = fakeLspClient(BIG_OUTLINE);
    const tool = toolWithContentAndRegistry(BIG_FILE_CONTENT, fakeRegistryWith(client));

    const result = await executeTool(tool, context({ path: '/tmp/big.ts' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      expectedOutputWithFooter(
        BIG_FILE_CONTENT,
        410,
        'Declarations (2): Class Foo — 3 · Method bar — 31',
      ),
    );
    expect(client.didOpen).toHaveBeenCalledWith('/tmp/big.ts', BIG_FILE_CONTENT, 'typescript');
  });

  it('stays byte-identical when the registry is absent', async () => {
    const tool = toolWithContentAndRegistry(BIG_FILE_CONTENT, undefined);

    const result = await executeTool(tool, context({ path: '/tmp/big.ts' }));

    expect(result.output).toBe(expectedOutputWithoutFooter(BIG_FILE_CONTENT, 410));
  });

  it('skips the outline entirely when no LSP client is active', async () => {
    const readText = vi.fn<Jian['readText']>().mockResolvedValue(BIG_FILE_CONTENT);
    const tool = toolWithContentAndRegistry(BIG_FILE_CONTENT, fakeRegistryWith(undefined), { readText });

    const result = await executeTool(tool, context({ path: '/tmp/big.ts' }));

    expect(result.output).toBe(expectedOutputWithoutFooter(BIG_FILE_CONTENT, 410));
    expect(readText).not.toHaveBeenCalled();
  });

  it('does not trigger any LSP work for files under the outline threshold', async () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const client = fakeLspClient(BIG_OUTLINE);
    const registry = fakeRegistryWith(client);
    const tool = toolWithContentAndRegistry(content, registry);

    const result = await executeTool(tool, context({ path: '/tmp/small.ts' }));

    expect(result.output).toBe(expectedOutputWithoutFooter(content, 50));
    expect(registry.activeClientFor).not.toHaveBeenCalled();
    expect(client.didOpen).not.toHaveBeenCalled();
  });

  it('caps the footer at 40 entries and points at LSP document_symbols for the rest', async () => {
    const outline: LspSymbolOutline[] = Array.from({ length: 45 }, (_, i) => ({
      name: `sym${String(i)}`,
      kind: 12,
      line: i,
      depth: 0,
    }));
    const tool = toolWithContentAndRegistry(BIG_FILE_CONTENT, fakeRegistryWith(fakeLspClient(outline)));

    const result = await executeTool(tool, context({ path: '/tmp/big.ts' }));

    const expected =
      `Declarations (first 40 of 45): ` +
      outline
        .slice(0, 40)
        .map((entry) => `Function ${entry.name} — ${String(entry.line + 1)}`)
        .join(' · ') +
      ' Full outline: LSP document_symbols.';
    expect(result.output).toContain(expected);
    expect(result.output).not.toContain('Function sym40');
  });

  it('stays byte-identical when the outline comes back empty', async () => {
    const tool = toolWithContentAndRegistry(BIG_FILE_CONTENT, fakeRegistryWith(fakeLspClient([])));

    const result = await executeTool(tool, context({ path: '/tmp/big.ts' }));

    expect(result.output).toBe(expectedOutputWithoutFooter(BIG_FILE_CONTENT, 410));
  });

  it('skips the footer silently when documentSymbol fails', async () => {
    const tool = toolWithContentAndRegistry(
      BIG_FILE_CONTENT,
      fakeRegistryWith(fakeLspClient(new Error('server exploded'))),
    );

    const result = await executeTool(tool, context({ path: '/tmp/big.ts' }));

    expect(result.output).toBe(expectedOutputWithoutFooter(BIG_FILE_CONTENT, 410));
  });

  it('memoizes the outline on (path, mtime) and recomputes when mtime changes', async () => {
    let mtime = 0;
    const readText = vi.fn<Jian['readText']>().mockResolvedValue(BIG_FILE_CONTENT);
    const stat = vi.fn<Jian['stat']>().mockImplementation(async () => {
      return { ...REGULAR_FILE_STAT, stMtime: mtime };
    });
    const client = fakeLspClient(BIG_OUTLINE);
    const tool = toolWithContentAndRegistry(BIG_FILE_CONTENT, fakeRegistryWith(client), {
      readText,
      stat,
    });

    await executeTool(tool, context({ path: '/tmp/big.ts' }));
    await executeTool(tool, context({ path: '/tmp/big.ts' }));
    expect(client.documentSymbol).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledTimes(1);

    mtime = 5;
    await executeTool(tool, context({ path: '/tmp/big.ts' }));
    expect(client.documentSymbol).toHaveBeenCalledTimes(2);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it('propagates an abort raised while building the outline', async () => {
    const controller = new AbortController();
    const readText = vi.fn<Jian['readText']>().mockImplementation(async () => {
      controller.abort();
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });
    const tool = toolWithContentAndRegistry(
      BIG_FILE_CONTENT,
      fakeRegistryWith(fakeLspClient(BIG_OUTLINE)),
      { readText },
    );

    await expect(
      executeTool(tool, { ...context({ path: '/tmp/big.ts' }), signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe('ReadTool repetition notice', () => {
  it('stays silent on the first read and notes the identical window on repeats', async () => {
    const guard = new RepetitionGuard();
    const tool = guardedToolWithMutableContent(() => 'a\nb\nc', guard);

    const first = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(first)).not.toContain('Note: this window is identical');

    const second = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(second)).toContain(
      'Note: this window is identical to the previous read',
    );
    // The note stays inside the <system> block, which remains the output tail.
    expect(toolContentString(second)).toMatch(
      /<system>.*Note: this window is identical.*<\/system>\s*$/,
    );

    const third = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(third)).toContain(
      'Note: this window is identical to the previous read',
    );
    expect(toolContentString(third)).not.toContain('re-read identical content');
  });

  it('escalates to the stop re-reading notice after the fourth identical read', async () => {
    const guard = new RepetitionGuard();
    const tool = guardedToolWithMutableContent(() => 'a\nb\nc', guard);
    for (let i = 0; i < 4; i += 1) {
      await executeTool(tool, context({ path: '/tmp/a.txt' }));
    }

    const fifth = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(fifth)).toContain('you have re-read identical content 5 times');
  });

  it('switches to the stop re-reading notice exactly on the fourth identical read', async () => {
    const guard = new RepetitionGuard();
    const tool = guardedToolWithMutableContent(() => 'a\nb\nc', guard);
    for (let i = 0; i < 2; i += 1) {
      await executeTool(tool, context({ path: '/tmp/a.txt' }));
    }

    // count 3: still the gentle level-1 wording.
    const third = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(third)).toContain(
      'Note: this window is identical to the previous read',
    );
    expect(toolContentString(third)).not.toContain('Stop re-reading');

    // count 4: the ladder flips to level 2 — the hard notice names the count
    // and points at line_offset/Edit, and stays inside the <system> block
    // (which remains the output tail).
    const fourth = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(fourth)).toContain('you have re-read identical content 4 times');
    expect(toolContentString(fourth)).toContain(
      'use line_offset for a different window, or Edit to change the file.',
    );
    expect(toolContentString(fourth)).toMatch(/<system>.*re-read identical content.*<\/system>\s*$/);
  });

  it('resets the count when the file changed between reads', async () => {
    const guard = new RepetitionGuard();
    let content = 'v1';
    const tool = guardedToolWithMutableContent(() => content, guard);
    await executeTool(tool, context({ path: '/tmp/a.txt' }));

    content = 'v2';
    const afterEdit = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(afterEdit)).not.toContain('Note: this window is identical');

    const repeat = await executeTool(tool, context({ path: '/tmp/a.txt' }));
    expect(toolContentString(repeat)).toContain('Note: this window is identical');
  });

  it('shares the guard with ReadGroup so counts accumulate across both tools', async () => {
    const guard = new RepetitionGuard();
    const content = 'a\nb\nc';
    const bytes = Buffer.from(content, 'utf8');
    const jian = createFakeJian({
      stat: vi.fn<Jian['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
      readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_path, n) => {
        return n === undefined ? bytes : bytes.subarray(0, n);
      }),
      readLines: vi.fn<Jian['readLines']>().mockImplementation(readLinesFromContent(content)),
      readText: vi.fn<Jian['readText']>().mockResolvedValue(content),
    });
    const readTool = new ReadTool(jian, PERMISSIVE_WORKSPACE, undefined, guard);
    await executeTool(readTool, context({ path: '/tmp/a.txt' }));

    const groupTool = new ReadGroupTool(jian, PERMISSIVE_WORKSPACE, undefined, guard);
    const group = await executeTool(groupTool, {
      turnId: '0',
      toolCallId: 'call_readgroup',
      args: { paths: ['/tmp/a.txt'] } satisfies ReadGroupInput,
      signal,
    });
    // The grouped read is the second identical fetch of this file: the inner
    // ReadTool's repetition notice surfaces inside the group's output.
    expect(toolContentString(group)).toContain('Note: this window is identical');
  });
});
