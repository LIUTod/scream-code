/**
 * Shell dialect wiring — the BashTool drives whichever shell the probe chose.
 *
 * `detectEnvironment` falls back to PowerShell on a Windows host with no Git
 * Bash, so the argv built here decides whether that fallback is usable at all:
 * a bash-shaped script (`cd … && …`, a bash self-protection preamble) handed to
 * `pwsh -Command` is a parse error on the first command the model runs.
 *
 * The environments below mirror what the probe returns (`Environment.shellArgs`
 * included), and the Git Bash case pins the argv the tool produced before the
 * dialect split, so the POSIX path cannot drift while the PowerShell path is
 * added.
 */

import { Readable, type Writable } from 'node:stream';

import type { Environment, JianProcess } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import type { ExecutableToolResult } from '../../src/loop';
import { BashTool } from '../../src/tools/builtin/shell/bash';
import { executeTool } from './fixtures/execute-tool';
import { createFakeJian } from './fixtures/fake-jian';

/** What the probe returns after finding Git Bash on Windows. */
const windowsGitBashEnv: Environment = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
  shellArgs: ['-c'],
};

/** What the probe returns after finding no Git Bash and falling back. */
const windowsPowerShellEnv: Environment = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  shellName: 'powershell',
  shellArgs: ['-NoProfile', '-NonInteractive', '-Command'],
};

/** The same fallback, PowerShell 7 — the probe prefers it when installed. */
const windowsPwshEnv: Environment = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  shellName: 'pwsh',
  shellArgs: ['-NoProfile', '-NonInteractive', '-Command'],
};

const posixEnv: Environment = {
  osKind: 'Linux',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  shellArgs: ['-c'],
};

function fakeProcess(): JianProcess {
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 321,
    exitCode: 0,
    wait: vi.fn(async () => 0),
    kill: vi.fn(async () => {}),
  };
}

async function captureArgv(
  env: Environment,
  command: string,
  cwd: string,
): Promise<readonly string[]> {
  const execWithEnv = vi.fn().mockResolvedValue(fakeProcess());
  const tool = new BashTool(createFakeJian({ execWithEnv, osEnv: env }), cwd);

  await executeTool(tool, {
    turnId: '0',
    toolCallId: 'tc_dialect',
    args: { command, timeout: 1000 },
    signal: new AbortController().signal,
  });

  return execWithEnv.mock.calls[0]?.[0] as readonly string[];
}

/**
 * Run `command` through the tool and report both the result and whether the
 * shell was actually spawned — the two halves every self-protection case below
 * turns on.
 */
async function captureOutcome(
  env: Environment,
  command: string,
): Promise<{ result: ExecutableToolResult; execWithEnv: ReturnType<typeof vi.fn> }> {
  const execWithEnv = vi.fn().mockResolvedValue(fakeProcess());
  const tool = new BashTool(createFakeJian({ execWithEnv, osEnv: env }), 'C:\\work');

  const result = await executeTool(tool, {
    turnId: '0',
    toolCallId: 'tc_selfkill',
    args: { command, timeout: 1000 },
    signal: new AbortController().signal,
  });

  return { result, execWithEnv };
}

describe('BashTool — Windows PowerShell fallback', () => {
  it('spawns the interpreter with its own non-interactive switches', async () => {
    const argv = await captureArgv(
      windowsPowerShellEnv,
      'Get-ChildItem',
      'C:\\Users\\me\\project',
    );

    expect(argv[0]).toBe(windowsPowerShellEnv.shellPath);
    expect(argv.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    // Five elements: the script is the last one, with no `-c` bolted on.
    expect(argv).toHaveLength(5);
  });

  it('sets the working directory with the cmdlet, in the native path form', async () => {
    const argv = await captureArgv(
      windowsPowerShellEnv,
      'Get-ChildItem',
      'C:\\Users\\me\\project',
    );
    const script = argv[4]!;

    // The cwd statement still comes first and the command last; the
    // self-protection preamble is what sits between them.
    expect(
      script.startsWith("Set-Location -LiteralPath 'C:\\Users\\me\\project' -ErrorAction Stop; "),
    ).toBe(true);
    expect(script.endsWith('; Get-ChildItem')).toBe(true);
  });

  it('does not convert the cwd to a POSIX path', async () => {
    const argv = await captureArgv(windowsPowerShellEnv, 'pwd', 'C:\\Users\\me\\project');
    const script = argv[4]!;

    expect(script).toContain('C:\\Users\\me\\project');
    expect(script).not.toContain('/c/Users/me/project');
  });

  it('installs a PowerShell self-protection preamble', async () => {
    const argv = await captureArgv(windowsPowerShellEnv, 'Get-ChildItem', 'C:\\work');
    const script = argv[4]!;

    // The bash shims are a parse error under PowerShell, so this branch carries
    // its own guard for the same two identities (SCREAM_PID = the process that
    // started the shell, $PID = the shell) and shadows every command that can
    // kill one of them.
    expect(script).toContain('function _ScreamGuardPid(');
    expect(script).toContain('$env:SCREAM_PID');
    expect(script).toContain('[string] $PID');
    expect(script).toContain('function Stop-Process {');
    expect(script).toContain('function taskkill {');
    expect(script).toContain('Set-Alias -Name kill -Value Stop-Process -Force');
    // Forwarding must reach the real commands, not the shadows: the cmdlet by
    // its module-qualified name, the executable with its extension.
    expect(script).toContain('Microsoft.PowerShell.Management\\Stop-Process');
    expect(script).toContain('taskkill.exe @args');
    // By-name killing carries no pid for the guard above to compare, so both
    // shadowed commands are also wired to a by-name refusal that fires whatever
    // the name is — the strength the POSIX branch gets from refusing `pkill` /
    // `killall` outright. Both spellings are covered: `Stop-Process`'s `-Name`
    // (plus the `-N` / `-Na` / `-Nam` abbreviations PowerShell binds to it) and
    // `taskkill`'s `/IM` switch.
    expect(script).toContain('function _ScreamGuardByName(');
    expect(script).toContain('_ScreamGuardPid $args; _ScreamGuardByName $args;');
    expect(script).toContain('^-(N|Na|Nam|Name)(:|$)');
    expect(script).toContain('^[/-]IM(:|$)');
    // `-InputObject` names its victim with an object rather than a pid or a
    // name, so the shadow refuses the switch spelling *and* any argument that is
    // itself a process object (`-InputObject` is positional in its parameter
    // set, so `Stop-Process $proc` reaches the same place). The pipeline form
    // the shadow re-invokes internally is module-qualified and unaffected.
    expect(script).toContain('function _ScreamGuardInputObject(');
    expect(script).toContain('_ScreamGuardInputObject $args;');
    expect(script).toContain(
      '^-(I|In|Inp|Inpu|Input|InputO|InputOb|InputObj|InputObje|InputObjec|InputObject)(:|$)',
    );
    expect(script).toContain('-is [System.Diagnostics.Process]');
  });

  it('sends no bash preamble and no bash cwd chain', async () => {
    const argv = await captureArgv(windowsPowerShellEnv, 'Get-ChildItem', 'C:\\work');
    const script = argv[4]!;

    // Bash syntax reaching `pwsh -Command` is a parse error, not a nuisance —
    // the PowerShell preamble is a different mechanism, not a port of this one.
    expect(script).not.toContain('_SCREAM_CHECK');
    expect(script).not.toContain('$SCREAM_PID');
    expect(script).not.toContain('cd ');
    expect(script).not.toContain('&&');
  });

  it('leaves the bash nul redirect alone', async () => {
    const argv = await captureArgv(windowsPowerShellEnv, 'Get-ChildItem >nul', 'C:\\work');

    // `>nul` is the Windows null device; rewriting it to `/dev/null` is bash
    // syntax PowerShell has no path for.
    expect(argv[4]).toContain('>nul');
    expect(argv[4]).not.toContain('/dev/null');
  });

  it('quotes a cwd carrying a single quote by doubling it', async () => {
    const argv = await captureArgv(windowsPowerShellEnv, 'pwd', "C:\\Users\\o'brien");
    const script = argv[4]!;

    expect(
      script.startsWith("Set-Location -LiteralPath 'C:\\Users\\o''brien' -ErrorAction Stop; "),
    ).toBe(true);
    expect(script.endsWith('; pwd')).toBe(true);
  });

  it('treats pwsh as the same dialect', async () => {
    const argv = await captureArgv(windowsPwshEnv, 'pwd', 'C:\\work');

    expect(argv[0]).toBe(windowsPwshEnv.shellPath);
    expect(argv.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(argv[4]!.startsWith("Set-Location -LiteralPath 'C:\\work' -ErrorAction Stop; ")).toBe(
      true,
    );
    expect(argv[4]!.endsWith('; pwd')).toBe(true);
  });

  it('falls back to the PowerShell switches when the environment carries no args', async () => {
    const argv = await captureArgv(
      { ...windowsPowerShellEnv, shellArgs: undefined },
      'pwd',
      'C:\\work',
    );

    expect(argv.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  });

  it('refuses a kill by process or image name, whatever the name is', async () => {
    // A by-name kill names no pid for the runtime pid guard to compare, and the
    // name need not be the host's own: `nod*` and `node*` reach it too. So the
    // pre-flight layer refuses the form itself — as the POSIX branch refuses
    // `pkill` / `killall` unconditionally — and the preamble refuses the same
    // forms at runtime.
    for (const command of [
      'Stop-Process -Name node',
      'Stop-Process -Name nod*',
      'Stop-Process -Name $n',
      'Stop-Process -Na node',
      'Stop-Process -N node',
      'Stop-Process -Name:node',
      'taskkill /IM node.exe',
      'taskkill /IM nod*',
      'taskkill /F /IM:node.exe',
      'Get-Process -Name nod* | Stop-Process',
    ]) {
      const { result, execWithEnv } = await captureOutcome(windowsPowerShellEnv, command);

      expect(result.isError, command).toBe(true);
      expect(result.output, command).toContain('self-protection');
      expect(execWithEnv, command).not.toHaveBeenCalled();
    }
  });

  it('refuses a kill aimed at this run through -InputObject, whatever the operand', async () => {
    // `-InputObject`'s operand is an arbitrary expression, and by the time it
    // reaches the shadow's `$args` PowerShell has already evaluated it while
    // `$input` stays empty — so the pid guard never sees the victim and `@args`
    // hands the live process object to the real cmdlet. The form is refused, on
    // the same reasoning as a by-name kill: it names the victim in a shape no
    // pid comparison can read. The shadow refuses it at runtime too, shorthand
    // and `-Switch:value` spellings included.
    for (const command of [
      'Stop-Process -InputObject (Get-Process -Id $PID)',
      'Stop-Process -InputObject (Get-Process -Id $env:SCREAM_PID)',
      'Stop-Process -InputObject:$p',
      'Stop-Process -In (Get-Process -Id $PID)',
      'Stop-Process -Input (Get-Process -Id $PID)',
    ]) {
      const { result, execWithEnv } = await captureOutcome(windowsPowerShellEnv, command);

      expect(result.isError, command).toBe(true);
      expect(result.output, command).toContain('self-protection');
      expect(execWithEnv, command).not.toHaveBeenCalled();
    }
  });

  it('keeps -Id and a filtered pipeline out of the -InputObject refusal', async () => {
    // The refusal keys on the switch name, so the neighbouring `-Id` spelling is
    // untouched — and a pipeline that selects processes by a filter still runs,
    // because only `-InputObject` (and a bare process object) is refused.
    for (const command of [
      'Stop-Process -Id 4321',
      'Get-Process | Where-Object { $_.Id -ne $PID } | Stop-Process -Force',
    ]) {
      const { result, execWithEnv } = await captureOutcome(windowsPowerShellEnv, command);

      expect(result.isError, command).toBe(false);
      expect(execWithEnv, command).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a kill aimed at this run through a shadow-bypassing spelling', async () => {
    // The preamble refuses every plain spelling of a kill aimed at this run, so
    // this layer only carries the three forms that never pass a shadow: the
    // module-qualified cmdlet, the `.exe` image, and the .NET process API.
    for (const command of [
      '[System.Diagnostics.Process]::GetProcessById($env:SCREAM_PID).Kill()',
      '[Diagnostics.Process]::GetProcessById($PID).Kill()',
      'Microsoft.PowerShell.Management\\Stop-Process -Id $env:SCREAM_PID',
      'taskkill.exe /F /PID $env:SCREAM_PID',
      'taskkill.exe /F /PID %SCREAM_PID%',
    ]) {
      const { result, execWithEnv } = await captureOutcome(windowsPowerShellEnv, command);

      expect(result.isError, command).toBe(true);
      expect(result.output, command).toContain('self-protection');
      expect(execWithEnv, command).not.toHaveBeenCalled();
    }
  });

  it('leaves the plain spellings to the guards the preamble installs', async () => {
    // These used to be refused here as well, but matching a kill verb anywhere
    // near a pid is what made `git commit -m "kill $PID"` a false positive, and
    // the preamble already refuses each of them at runtime — `kill` because its
    // PowerShell alias resolves to the guarded `Stop-Process`, `kill -Name node`
    // included.
    for (const command of [
      'Stop-Process -Id $env:SCREAM_PID',
      'kill $PID',
      'kill -Name node',
      'taskkill /F /PID %SCREAM_PID%',
    ]) {
      const { result, execWithEnv } = await captureOutcome(windowsPowerShellEnv, command);

      expect(result.isError, command).toBe(false);
      expect(execWithEnv, command).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves an ordinary command that only mentions a kill verb and a pid alone', async () => {
    // Neither spellings a shadow-bypassing command nor names a victim by name;
    // a doc string or a commit message that happens to quote `$PID` is not a
    // kill attempt, and the runtime guards are what stop a real one.
    for (const command of [
      'Write-Output "taskkill /PID $PID is blocked"',
      'git commit -m "kill $PID"',
      'Write-Output "Stop-Process -Id $env:SCREAM_PID"',
      "[System.Diagnostics.Process]::Start('notepad')",
    ]) {
      const { result, execWithEnv } = await captureOutcome(windowsPowerShellEnv, command);

      expect(result.isError, command).toBe(false);
      expect(execWithEnv, command).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves a command that only mentions $PID in a filter alone', async () => {
    // The PID guard is per statement, so an unrelated `Stop-Process` downstream
    // of a filter that reads `$PID` still runs.
    const argv = await captureArgv(
      windowsPowerShellEnv,
      'Get-Process | Where-Object { $_.Id -ne $PID } | Stop-Process -Force',
      'C:\\work',
    );

    expect(argv).toHaveLength(5);
    expect(argv[4]).toContain('Stop-Process -Force');
  });
});

describe('BashTool — Windows Git Bash regression', () => {
  it('keeps the pre-split argv for a Windows POSIX shell', async () => {
    const argv = await captureArgv(
      windowsGitBashEnv,
      'echo ok 2>nul',
      'C:\\Users\\me\\project',
    );

    expect(argv[0]).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(argv[1]).toBe('-c');
    expect(argv).toHaveLength(3);
    // Baseline shape (unchanged by the dialect split): POSIX-converted cwd,
    // `&&` chain, Windows self-protection preamble, `>nul` → `/dev/null`.
    expect(argv[2]).toMatch(/^cd '\/c\/Users\/me\/project' && _SCREAM_CHECK\(\)\{[\s\S]*\necho ok 2>\/dev\/null$/);
    expect(argv[2]).toContain('taskkill(){');
  });

  it('keeps the POSIX argv for a non-Windows host', async () => {
    const argv = await captureArgv(posixEnv, 'printf ok', '/workspace');

    expect(argv[0]).toBe('/bin/bash');
    expect(argv[1]).toBe('-c');
    expect(argv[2]).toMatch(/^cd '\/workspace' && [\s\S]*\nprintf ok$/);
    expect(argv[2]).not.toContain('taskkill(){');
  });
});

describe('BashTool — description dialect', () => {
  it('describes PowerShell chaining rules to a PowerShell host', () => {
    const tool = new BashTool(
      createFakeJian({ execWithEnv: vi.fn(), osEnv: windowsPowerShellEnv }),
      'C:\\work',
    );

    expect(tool.description).toContain('Execute a `powershell` command');
    expect(tool.description).toContain('$env:NAME');
    expect(tool.description).toContain('Get-Command');
    // The bash-only idioms must not survive into the PowerShell rendering.
    expect(tool.description).not.toContain('cd /path && ls -la');
    expect(tool.description).not.toContain('`case`');
  });

  it('keeps the bash chaining guidance for a POSIX host', () => {
    const tool = new BashTool(
      createFakeJian({ execWithEnv: vi.fn(), osEnv: posixEnv }),
      '/workspace',
    );

    expect(tool.description).toContain('Execute a `bash` command');
    expect(tool.description).toContain('cd /path && ls -la');
    expect(tool.description).not.toContain('$env:NAME');
  });
});
