import { describe, expect, it } from 'vitest';

import { JianExecError } from '@scream-code/jian';
import { npmLaunchPlan } from '#/utils/exec/npm';

const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

describe('npmLaunchPlan', () => {
  it('spawns the bare name on POSIX platforms', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(npmLaunchPlan(['view', 'scream-code', 'version'], platform)).toEqual({
        command: 'npm',
        args: ['view', 'scream-code', 'version'],
        windowsVerbatimArguments: false,
        platform,
      });
    }
  });

  it('defaults to the running platform', () => {
    const plan = npmLaunchPlan(['--version']);
    expect(plan.platform).toBe(process.platform);
    if (process.platform === 'win32') {
      expect(plan.windowsVerbatimArguments).toBe(true);
      expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    } else {
      expect(plan).toEqual({
        command: 'npm',
        args: ['--version'],
        windowsVerbatimArguments: false,
        platform: process.platform,
      });
    }
  });

  it('routes the .cmd shim through cmd.exe on Windows', () => {
    // Node refuses to spawn a batch file directly (EINVAL — a `.cmd` cannot be
    // launched by CreateProcess), so the shim goes through the interpreter that
    // can run one, with the command line pre-quoted and passed verbatim.
    expect(npmLaunchPlan(['install', '-g', 'scream-code@latest'], 'win32', COMSPEC)).toEqual({
      command: COMSPEC,
      args: ['/d', '/s', '/c', '"npm.cmd install -g scream-code@latest"'],
      windowsVerbatimArguments: true,
      platform: 'win32',
    });
  });

  it('falls back to cmd.exe when %ComSpec% is unset', () => {
    expect(npmLaunchPlan(['--version'], 'win32', undefined).command).toBe('cmd.exe');
  });

  it('quotes a token that carries spaces or cmd metacharacters', () => {
    const plan = npmLaunchPlan(
      [
        '--prefix',
        'C:\\Program Files\\npm',
        'a&b',
        'c|d',
        // A path with no space needs no quotes: `\` is not special to `cmd`.
        'C:\\Users\\me\\plain',
      ],
      'win32',
      COMSPEC,
    );

    expect(plan.args[3]).toBe(
      '"npm.cmd --prefix "C:\\Program Files\\npm" "a&b" "c|d" C:\\Users\\me\\plain"',
    );
  });

  it('keeps an empty argument as its own quoted slot', () => {
    // `""` is how `cmd` spells an empty argument; collapsing it to nothing would
    // hand npm one argument fewer than the caller passed.
    const plan = npmLaunchPlan(['install', '-g', ''], 'win32', COMSPEC);

    expect(plan.args[3]).toBe('"npm.cmd install -g """');
  });

  it('refuses a token that carries a double quote or a line break', () => {
    // `cmd` has no escape character for `"` and a line break ends the parsed
    // line; either would let the rest of the token run as a second command, so
    // the plan fails instead of producing an injectable command line. The
    // refusal comes from the shared jian helper, which is the point: this plan
    // and the Windows spawn path cannot drift apart on it.
    expect(() => npmLaunchPlan(['a" & calc & "b'], 'win32', COMSPEC)).toThrow(JianExecError);
    expect(() => npmLaunchPlan(['a\ncalc'], 'win32', COMSPEC)).toThrow(/Cannot quote/);
  });
});
