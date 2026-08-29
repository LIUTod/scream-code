import { describe, expect, it } from 'vitest';

import { writeTextClipboard, type RunCommand } from '#/utils/clipboard/clipboard-text';

function stubRun(ok: boolean, error?: string): RunCommand {
  return () => ({ ok, error });
}

describe('writeTextClipboard', () => {
  it('sends text to pbcopy on macOS', async () => {
    const calls: Array<{ command: string; args: string[]; input: string }> = [];
    const run: RunCommand = (command, args, input) => {
      calls.push({ command, args, input });
      return { ok: true };
    };
    // macOS is the CI platform; patch process.platform for the test.
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await writeTextClipboard('hello', run);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
    expect(calls).toEqual([{ command: 'pbcopy', args: [], input: 'hello' }]);
  });

  it('uses wl-copy on Wayland and xclip on X11', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalEnv = process.env['WAYLAND_DISPLAY'];
    const commands: string[] = [];
    const run: RunCommand = (command) => {
      commands.push(command);
      return { ok: true };
    };
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      process.env['WAYLAND_DISPLAY'] = ':0';
      await writeTextClipboard('a', run);
      process.env['WAYLAND_DISPLAY'] = '';
      await writeTextClipboard('a', run);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
      if (originalEnv === undefined) delete process.env['WAYLAND_DISPLAY'];
      else process.env['WAYLAND_DISPLAY'] = originalEnv;
    }
    expect(commands).toEqual(['wl-copy', 'xclip']);
  });

  it('falls through the candidate chain when the preferred Linux tool is missing', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalEnv = process.env['WAYLAND_DISPLAY'];
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: RunCommand = (command, args) => {
      calls.push({ command, args });
      // Simulate a missing preferred tool: first candidate fails (ENOENT),
      // second succeeds.
      if (calls.length === 1) return { ok: false, error: 'spawnSync ENOENT' };
      return { ok: true };
    };
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      process.env['WAYLAND_DISPLAY'] = ':0';
      await writeTextClipboard('a', run);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
      if (originalEnv === undefined) delete process.env['WAYLAND_DISPLAY'];
      else process.env['WAYLAND_DISPLAY'] = originalEnv;
    }
    expect(calls.map((c) => c.command)).toEqual(['wl-copy', 'xclip']);
    expect(calls[1]?.args).toEqual(['-selection', 'clipboard', '-i']);
  });

  it('includes xsel as the third Linux candidate and reports install hints when all fail', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalEnv = process.env['WAYLAND_DISPLAY'];
    const commands: string[] = [];
    const run: RunCommand = (command) => {
      commands.push(command);
      return { ok: false, error: `no ${command} here` };
    };
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      process.env['WAYLAND_DISPLAY'] = ':0';
      await expect(writeTextClipboard('a', run)).rejects.toThrow(/wl-clipboard/);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
      if (originalEnv === undefined) delete process.env['WAYLAND_DISPLAY'];
      else process.env['WAYLAND_DISPLAY'] = originalEnv;
    }
    expect(commands).toEqual(['wl-copy', 'xclip', 'xsel']);
  });

  it('tries xclip first on X11 and falls through to xsel before wl-copy', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalEnv = process.env['WAYLAND_DISPLAY'];
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: RunCommand = (command, args) => {
      calls.push({ command, args });
      // Simulate xclip missing (ENOENT); xsel succeeds.
      if (command === 'xclip') return { ok: false, error: 'spawnSync ENOENT' };
      return { ok: true };
    };
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      delete process.env['WAYLAND_DISPLAY'];
      await writeTextClipboard('a', run);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
      if (originalEnv === undefined) delete process.env['WAYLAND_DISPLAY'];
      else process.env['WAYLAND_DISPLAY'] = originalEnv;
    }
    expect(calls.map((c) => c.command)).toEqual(['xclip', 'xsel']);
    expect(calls[1]?.args).toEqual(['--clipboard', '--input']);
  });

  it('passes base64 to powershell Set-Clipboard on Windows', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: RunCommand = (command, args) => {
      calls.push({ command, args });
      return { ok: true };
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await writeTextClipboard('héllo', run);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
    expect(calls[0]?.command).toBe('powershell');
    const script = calls[0]?.args.join(' ');
    expect(script).toContain('Set-Clipboard');
    expect(script).toContain('FromBase64String');
  });

  it('throws when the platform command fails', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await expect(writeTextClipboard('x', stubRun(false, 'boom'))).rejects.toThrow('boom');
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('throws on unsupported platforms', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'freebsd' });
    try {
      await expect(writeTextClipboard('x', stubRun(true))).rejects.toThrow('unsupported');
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});
