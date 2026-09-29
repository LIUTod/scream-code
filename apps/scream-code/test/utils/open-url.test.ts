import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOpenInvocation, openUrl } from '#/tui/utils/open-url';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execFileMock = vi.mocked(execFile);

/** PowerShell reads `-EncodedCommand` as Base64-encoded UTF-16LE. */
function decodeCommand(args: string[]): string {
  return Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
}

describe('buildOpenInvocation', () => {
  it('uses `open` on macOS and `xdg-open` elsewhere, passing the URL through', () => {
    expect(buildOpenInvocation('https://example.com/a?b=1', 'darwin')).toEqual({
      command: 'open',
      args: ['https://example.com/a?b=1'],
    });
    expect(buildOpenInvocation('https://example.com/a?b=1', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com/a?b=1'],
    });
  });

  it('routes Windows through an encoded PowerShell command instead of cmd', () => {
    const invocation = buildOpenInvocation('https://x.com/a?b=1&c=2', 'win32');

    expect(invocation.command).toBe('powershell.exe');
    expect(invocation.args).toContain('-EncodedCommand');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    // `&` separates commands in cmd.exe: the URL has to survive verbatim, and
    // the invocation must not go through a shell at all.
    expect(decodeCommand(invocation.args)).toBe("Start 'https://x.com/a?b=1&c=2'");
    expect(invocation.args.join(' ')).not.toContain('cmd');
  });

  it('escapes single quotes so a URL cannot break out of the PowerShell string', () => {
    const invocation = buildOpenInvocation("https://x.com/it's", 'win32');
    expect(decodeCommand(invocation.args)).toBe("Start 'https://x.com/it''s'");
  });

  it('keeps non-ASCII URLs intact through the Windows encoding step', () => {
    const invocation = buildOpenInvocation('https://例え.jp/パス', 'win32');
    expect(decodeCommand(invocation.args)).toBe("Start 'https://例え.jp/パス'");
  });
});

describe('openUrl', () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });

  it('launches the invocation the platform builder produced', () => {
    openUrl('https://example.com');
    const expected = buildOpenInvocation('https://example.com');
    const call = execFileMock.mock.calls.at(-1);

    expect(call?.[0]).toBe(expected.command);
    expect(call?.[1]).toEqual(expected.args);
  });

  it('swallows launcher failures instead of surfacing them', () => {
    openUrl('https://example.com');

    // execFile(command, args, options, callback) — the callback is the last arg.
    const callback = execFileMock.mock.calls.at(-1)?.[3] as (error: Error | null) => void;
    expect(() => {
      callback(new Error('spawn xdg-open ENOENT'));
    }).not.toThrow();
  });
});
