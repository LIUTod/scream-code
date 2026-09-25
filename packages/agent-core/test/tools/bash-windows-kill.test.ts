/**
 * BashTool background — Windows process-tree teardown.
 *
 * On Windows a plain `ChildProcess.kill()` stops the shell but leaves the
 * grandchildren a shell command spawned still running, so the teardown has to
 * go through `taskkill /F /T` (`killProcessTree`). These cases pin the wiring at
 * the layer this file owns — `BackgroundProcessManager.stop()` on a backgrounded
 * Bash command — from both sides:
 *
 *   - `emulated dialect` (any POSIX host): a Windows `Environment` drives
 *     `LocalJian`'s Windows dialect with a real shell, and a `taskkill` shim is
 *     put first on `PATH`. The shim records the argv it was called with and
 *     reaps the tree `/T` names, so both the argv contract and the reaping are
 *     real. The host is not Windows, so Windows' own `taskkill` binary is not
 *     what runs here — only a Windows host can exercise that.
 *   - `real taskkill` (Windows host only, run by hand — no CI leg covers it):
 *     the same scenario with the real Git Bash and the real `taskkill`,
 *     asserting the grandchild is gone after `stop()`.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { Environment } from '@scream-code/jian';
import { LocalJian } from '@scream-code/jian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../src/tools/background/manager';
import { BashTool } from '../../src/tools/builtin/shell/bash';
import { executeTool } from './fixtures/execute-tool';
import { toolContentString } from './fixtures/fake-jian';

/** A Windows host whose probe found Git Bash — the dialect under test. */
const WINDOWS_GIT_BASH_ENV: Environment = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash',
  shellArgs: ['-c'],
};

/**
 * A `taskkill` stand-in for a host that has no such binary. It records the
 * argv it was called with and reaps the tree `/T` names — descendants first, so
 * nothing is reparented into a survivor.
 */
const TASKKILL_SHIM = `#!/bin/sh
printf '%s\\n' "$@" >> "$TASKKILL_SHIM_LOG"
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "/PID" ]; then
    shift
    pid="$1"
  fi
  shift
done
[ -n "$pid" ] || exit 87

children_of() {
  ps -Ao pid=,ppid= | awk -v parent="$1" '$2 == parent { print $1 }'
}

for child in $(children_of "$pid"); do
  for grandchild in $(children_of "$child"); do
    kill -9 "$grandchild" 2>/dev/null
  done
  kill -9 "$child" 2>/dev/null
done
kill -9 "$pid" 2>/dev/null
exit 0
`;

/**
 * A background command that spawns a long-running grandchild, records its pid,
 * and then stays alive itself. `node` is named as the shell would see it (both
 * shells on this test's PATH) rather than by absolute path, so the command does
 * not depend on how the host spells `process.execPath`.
 */
function grandchildCommand(pidFile: string): string {
  const code = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);',
    `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  return `node -e '${code}'`;
}

/** Start the command through the tool and return the background task id. */
async function startBackgroundCommand(
  dir: string,
  pidFile: string,
  jian: LocalJian,
): Promise<{ manager: BackgroundProcessManager; taskId: string; childPid: number }> {
  const manager = new BackgroundProcessManager();
  const tool = new BashTool(jian, dir, manager);

  const result = await executeTool(tool, {
    turnId: '0',
    toolCallId: 'tc_tree_kill',
    args: {
      command: grandchildCommand(pidFile),
      run_in_background: true,
      description: 'tree teardown',
      timeout: 60,
    },
    signal: new AbortController().signal,
  });

  const output = toolContentString(result);
  const taskId = output.match(/task_id: (\S+)/)?.[1];
  if (taskId === undefined) throw new Error(`no task id in output: ${output}`);
  const childPid = manager.getTask(taskId)?.pid;
  if (childPid === undefined) throw new Error(`no pid for task ${taskId}`);

  return { manager, taskId, childPid };
}

async function pollPidFile(path: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(path, 'utf-8')).trim(), 10);
      if (!Number.isNaN(pid)) return pid;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return undefined;
}

async function exitsWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

describe.skipIf(process.platform === 'win32')(
  'BashTool background — Windows tree teardown (emulated dialect)',
  () => {
    let dir: string;
    let logPath: string;
    let grandchild: number | undefined;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'scream-win-kill-'));
      logPath = join(dir, 'taskkill.argv');
      const shimDir = join(dir, 'shim');
      await mkdir(shimDir, { recursive: true });
      await writeFile(join(shimDir, 'taskkill'), TASKKILL_SHIM, 'utf8');
      await chmod(join(shimDir, 'taskkill'), 0o755);
      // `taskkill` is looked up on `PATH`, both by the shim's own shebang and
      // by `killProcessTree`'s `spawn('taskkill', …)`.
      vi.stubEnv('PATH', `${shimDir}${delimiter}${process.env['PATH'] ?? ''}`);
      vi.stubEnv('TASKKILL_SHIM_LOG', logPath);
    });

    afterEach(async () => {
      killQuietly(grandchild);
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    it('stops the whole tree through taskkill /F /T and reports the task killed', async () => {
      const pidFile = join(dir, 'grandchild.pid');
      const jian = await LocalJian.create(dir, undefined, WINDOWS_GIT_BASH_ENV);
      const { manager, taskId, childPid } = await startBackgroundCommand(dir, pidFile, jian);

      grandchild = await pollPidFile(pidFile, 10_000);
      expect(grandchild).toBeDefined();

      await manager.stop(taskId, 'tree teardown');

      expect(manager.getTask(taskId)?.status).toBe('killed');
      // One invocation, the flags `/T` (tree) and `/F` (unconditional) require,
      // naming the backgrounded process — not a POSIX process-group signal.
      const argv = (await readFile(logPath, 'utf8')).split('\n').filter((line) => line.length > 0);
      expect(argv).toEqual(['/F', '/T', '/PID', String(childPid)]);
      await expect(exitsWithin(grandchild as number, 3_000)).resolves.toBe(true);
    });
  },
);

describe.skipIf(process.platform !== 'win32')(
  'BashTool background — Windows tree teardown (real taskkill)',
  () => {
    it('terminates the grandchild of a background command', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'scream-win-kill-'));
      let grandchild: number | undefined;
      try {
        const pidFile = join(dir, 'grandchild.pid');
        const jian = await LocalJian.create(dir);
        const { manager, taskId } = await startBackgroundCommand(dir, pidFile, jian);

        grandchild = await pollPidFile(pidFile, 15_000);
        expect(grandchild).toBeDefined();

        await manager.stop(taskId, 'tree teardown');

        // The grandchild is not a child of this process, so a surviving pid
        // means the tree really did outlive the stop.
        await expect(exitsWithin(grandchild as number, 5_000)).resolves.toBe(true);
      } finally {
        killQuietly(grandchild);
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      }
    }, 30_000);
  },
);
