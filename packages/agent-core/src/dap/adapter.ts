/**
 * debugpy adapter resolution — where the Python debugger comes from and how a
 * session starts.
 *
 * Transport choice (evidence, not preference):
 *
 *   debugpy has two ways to expose DAP.
 *
 *   1. `python -m debugpy.adapter` with no `--port` runs the adapter over
 *      stdio. `src/debugpy/adapter/__main__.py` documents it: "If we're talking
 *      DAP over stdio …" and then constructs `clients.Client("stdio")` when
 *      `--port` is None. A `launch` request makes the adapter spawn the
 *      debuggee itself (`adapter/launchers.py`), so the whole session — DAP
 *      channel, launcher and debuggee — is one spawned process tree.
 *   2. `python -m debugpy --listen <addr> <program>` turns the debuggee into a
 *      TCP DAP server, which needs a port plus a socket connection from this
 *      side and cannot report a dynamically assigned port reliably.
 *
 *   This module picks (1): no extra socket, no port parsing, and process
 *   ownership stays with the client that spawned it.
 *
 * `python3 -m debugpy --version` is the cheap presence probe: the debugpy CLI
 * prints `debugpy.__version__` and exits 0 (`src/debugpy/server/cli.py`,
 * `print_version_and_exit`). A missing module exits non-zero, which is what
 * turns into the install instruction instead of a raw spawn error.
 */

import type { Jian, JianProcess } from '@scream-code/jian';
import type { Readable } from 'node:stream';

import type { DapLaunchSpec } from './client';

/** Actionable message for every "the adapter is not there" outcome. */
export const DEBUGPY_INSTALL_MESSAGE =
  'debugpy is not installed. Install it with: python3 -m pip install debugpy';

/** Interpreter used for both the probe and the adapter. */
export const DEFAULT_PYTHON_COMMAND = 'python3';

/** A hung probe must not stall the tool call. */
const PROBE_TIMEOUT_MS = 10_000;

export interface ResolvedDebugAdapter {
  readonly ok: true;
  /** Executable of the adapter command line. */
  readonly command: readonly string[];
  /** Fixed adapter arguments; the DAP client appends nothing else. */
  readonly args: readonly string[];
  /** Interpreter that will run the debuggee (`launch` request `python`). */
  readonly python: readonly string[];
}

export interface MissingDebugAdapter {
  readonly ok: false;
  readonly reason: string;
}

export type DebugAdapterResolution = ResolvedDebugAdapter | MissingDebugAdapter;

/** What a caller knows about the debuggee before the launch request. */
export interface LaunchSpecInput {
  readonly python: readonly string[];
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly stopOnEntry?: boolean | undefined;
  readonly justMyCode?: boolean | undefined;
}

/**
 * Probe `python3 -m debugpy --version` and, when it answers, describe the
 * stdio adapter command line.
 *
 * The caller caches a successful resolution for the session; a failure is
 * deliberately NOT cached, so installing debugpy mid-session is picked up by
 * the next launch instead of requiring a restart.
 */
export async function resolveDebugpy(
  jian: Jian,
  pythonCommand: string = DEFAULT_PYTHON_COMMAND,
): Promise<DebugAdapterResolution> {
  let proc: JianProcess;
  try {
    proc = await jian.exec(pythonCommand, '-m', 'debugpy', '--version');
  } catch {
    // Spawn failure (interpreter missing) and module failure look the same
    // from here: there is no usable debugpy.
    return { ok: false, reason: DEBUGPY_INSTALL_MESSAGE };
  }

  try {
    proc.stdin.end();
  } catch {
    // stdin already closed.
  }

  const work = Promise.all([collectStream(proc.stdout), proc.wait()]);
  // Attach a handler up front so a rejection during the timeout window is not
  // reported as unhandled.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('debugpy probe timed out'));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    const [stdout, exitCode] = await Promise.race([work, timeout]);
    if (exitCode !== 0 || stdout.trim().length === 0) {
      return { ok: false, reason: DEBUGPY_INSTALL_MESSAGE };
    }
  } catch {
    try {
      await proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    return { ok: false, reason: DEBUGPY_INSTALL_MESSAGE };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return {
    ok: true,
    command: [pythonCommand],
    args: ['-m', 'debugpy.adapter'],
    python: [pythonCommand],
  };
}

/**
 * Build the launch arguments for debugpy: program, args, cwd, stop behaviour.
 * The DAP client turns this into the wire body (it owns the transport-level
 * `console` switch that keeps the debuggee off an external terminal).
 */
export function buildLaunchSpec(input: LaunchSpecInput): DapLaunchSpec {
  return {
    python: [...input.python],
    program: input.program,
    args: [...(input.args ?? [])],
    cwd: input.cwd,
    stopOnEntry: input.stopOnEntry ?? true,
    justMyCode: input.justMyCode ?? true,
  };
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}
