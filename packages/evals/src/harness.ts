/**
 * Minimal end-to-end eval harness built on the public node-sdk
 * `ScreamHarness`. Each eval run gets an isolated temp **workspace** so runs
 * never touch real project files; the scream home defaults to the real one so
 * the provider/API-key configuration in `~/.scream-code/config.toml` is
 * honored (pass `screamHome` to override for fully isolated runs). Model
 * selection follows `SCREAM_EVAL_MODEL` (e.g. `provider/model`);
 * when unset the harness throws with a clear message.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScreamHarness, type Session } from '@scream-code/scream-code-sdk';

/** The main agent id; only its events settle the eval turn wait. */
const MAIN_AGENT_ID = 'main';

export interface EvalHarnessOptions {
  /** Model selector, e.g. `provider/model`. Defaults to
   *  `SCREAM_EVAL_MODEL`; when unset, the harness default model applies. */
  readonly model?: string;
  /** Thinking effort (`off` default for deterministic cheap runs). */
  readonly thinking?: string;
  /** Override the workspace directory (defaults to a fresh mkdtemp). */
  readonly workDir?: string;
  /** Override the scream home (defaults to the real home so the eval honors
   *  the developer's provider config; pass a temp dir for full isolation). */
  readonly screamHome?: string;
  /** When set, after the turn ends (or times out) the harness checks whether
   *  `path` exists in the workspace with exactly `content`. Used by the
   *  write-file case so a model that loops after writing still verifies the
   *  Write tool actually landed the file. */
  readonly verifyFileAfterTurn?: { readonly path: string; readonly content: string };
}

export interface EvalUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface EvalResult {
  readonly output: string;
  readonly usage: EvalUsage;
  /** True when the turn hit the timeout instead of ending naturally. */
  readonly timedOut: boolean;
  /** True when `verifyFileAfterTurn` matched (file exists with exact content). */
  readonly verifiedFile: boolean;
}

export interface EvalFixture {
  readonly name: string;
  readonly content: string;
}

export interface EvalRunInput {
  readonly prompt: string;
  /** Fixture files written into the workspace before the session starts. */
  readonly fixtures?: readonly EvalFixture[];
}

/** The current scream default model, when resolvable from config. */
const DEFAULT_EVAL_MODEL = process.env['SCREAM_EVAL_MODEL'];

/**
 * Runs a single end-to-end prompt against a fresh isolated session and
 * returns the final assistant text plus token usage. The session, workspace
 * and scream home are torn down afterwards.
 */
export async function runEvalPrompt(
  input: EvalRunInput | string,
  options: EvalHarnessOptions = {},
): Promise<EvalResult> {
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), 'scream-eval-ws-')));
  // Real scream home by default so the developer's provider config applies.
  // Caller-provided screamHome is NEVER deleted here (it may be the real
  // home or a directory the caller owns); only the temp workDir we created
  // is cleaned up.
  const screamHome = options.screamHome;
  const createdWorkDir = options.workDir === undefined;
  let harness: ScreamHarness | undefined;
  let session: Session | undefined;
  try {
    for (const fixture of (typeof input === 'string' ? [] : input.fixtures) ?? []) {
      await writeFile(join(workDir, fixture.name), fixture.content, 'utf-8');
    }

    const prompt = typeof input === 'string' ? input : input.prompt;
    const model = options.model ?? DEFAULT_EVAL_MODEL;
    if (model === undefined || model.length === 0) {
      throw new Error(
        'No eval model configured. Set SCREAM_EVAL_MODEL, e.g. ' +
          'SCREAM_EVAL_MODEL=provider/model pnpm eval',
      );
    }
    // Pass the model straight through: `createSession` accepts any configured
    // model alias (matching session-manager.ts createSessionFromCurrentState),
    // not only `provider/model` pairs. The split below only feeds the usage
    // report and tolerates aliases without a slash.
    const [provider, modelId, ...rest] = model.split('/');
    const usageProvider = rest.length > 0 ? model : provider ?? 'unknown';
    const usageModel = modelId === undefined || rest.length > 0 ? model : modelId;

    harness = new ScreamHarness({ homeDir: screamHome });
    session = await harness.createSession({
      workDir,
      model,
      thinking: options.thinking ?? 'off',
      permission: 'yolo',
    });
    const { timedOut } = await promptAndWaitForTurnEnd(session, prompt);

    // When the turn timed out, `getContext` may not reflect a final reply;
    // read whatever state exists but treat output as best-effort.
    let output = '';
    try {
      const context = await session.getContext();
      output = lastAssistantText(context.history);
    } catch {
      output = '';
    }
    const usage = await session.getUsage().catch(() => undefined);
    const total = usage?.total;

    // Verify a side-effect file if requested (write-file case): a model may
    // loop after the Write call instead of finishing the turn, but the file
    // landing is the actual capability being tested.
    let verifiedFile = false;
    if (options.verifyFileAfterTurn !== undefined) {
      try {
        const actual = await readFile(
          join(workDir, options.verifyFileAfterTurn.path),
          'utf-8',
        );
        verifiedFile = actual === options.verifyFileAfterTurn.content;
      } catch {
        verifiedFile = false;
      }
    }

    return {
      output,
      timedOut,
      verifiedFile,
      usage: {
        provider: usageProvider,
        model: usageModel,
        inputTokens: total?.inputOther ?? 0,
        outputTokens: total?.output ?? 0,
        totalTokens:
          (total?.inputOther ?? 0) + (total?.output ?? 0) + (total?.inputCacheRead ?? 0) + (total?.inputCacheCreation ?? 0),
      },
    };
  } finally {
    if (session !== undefined) {
      await session.close({ extractMemories: false }).catch(() => {});
    }
    if (createdWorkDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function lastAssistantText(history: readonly unknown[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i] as { role?: string; content?: readonly { type?: string; text?: string }[] };
    if (message.role !== 'assistant') continue;
    const parts = message.content ?? [];
    const text = parts
      .filter((part): part is { type: string; text: string } => part.type === 'text' && part.text !== undefined)
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

/**
 * Sends a prompt and resolves when the main agent's turn ends. `Session.prompt`
 * only enqueues the RPC request; the assistant reply arrives asynchronously as
 * events, so we must wait for the `turn.ended` event to know the run finished.
 *
 * A hard timeout guards against a turn that never ends (e.g. a model looping
 * through tools instead of converging, or a network interruption). On timeout
 * we cancel the session so the caller's cleanup path still runs instead of
 * leaking the session and temp workspace. 90s is enough to complete any
 * legitimate single-turn tool round-trip; longer waits are almost always a
 * stuck model, so we fail fast instead of burning tokens.
 */
const TURN_WAIT_TIMEOUT_MS = 90_000;

/**
 * Resolves with `timedOut: true` when the turn hit the timeout (model looping
 * or stuck) instead of throwing, so callers can still inspect side effects
 * (e.g. a file the Write tool already created). Real errors (turn failed /
 * error event) still reject.
 */
async function promptAndWaitForTurnEnd(
  session: Session,
  prompt: string,
): Promise<{ timedOut: boolean }> {
  const { promise, resolve, reject } = promiseWithResolvers<{ timedOut: boolean }>();
  let activeTurnId: number | undefined;
  let activeAgentId: string | undefined;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  /** Set once the timeout fires; guards against the cancel-triggered
   *  `turn.ended('cancelled')` being misread as a real failure. */
  let timeoutFired = false;

  const finish = (result: { timedOut: boolean } | Error): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (result instanceof Error) reject(result);
    else resolve(result);
  };

  const unsubscribe = session.onEvent((event) => {
    // Only the main agent settles this wait. Subagent/background agents emit
    // their own error/turn events that must not abort or hijack the main turn
    // (mirrors run-prompt.ts filtering).
    if (event.agentId !== MAIN_AGENT_ID) {
      return;
    }
    if (event.type === 'error') {
      finish(new Error(`${event.code}: ${event.message}`));
      return;
    }
    if (event.type === 'turn.started' && activeTurnId === undefined) {
      activeTurnId = event.turnId;
      activeAgentId = event.agentId;
      return;
    }
    if (
      activeTurnId === undefined ||
      activeAgentId === undefined ||
      !('turnId' in event) ||
      event.turnId !== activeTurnId ||
      event.agentId !== activeAgentId
    ) {
      return;
    }
    if (event.type === 'turn.ended') {
      if (event.reason === 'completed') {
        finish({ timedOut: false });
      } else if (timeoutFired && event.reason === 'cancelled') {
        // The timeout fired and we cancelled the session; the resulting
        // 'cancelled' turn.ended is our own doing, not a real failure.
        // Let the grace timer resolve with timedOut.
        return;
      } else {
        finish(new Error(`Turn ended with reason: ${event.reason}`));
      }
    }
  });

  try {
    await session.prompt(prompt);
    timeout = setTimeout(() => {
      timeoutFired = true;
      void session.cancel().catch(() => {});
      // Give the cancel a moment to land so in-flight tool calls finish and
      // side effects (files) are flushed before we inspect them.
      graceTimer = setTimeout(() => {
        finish({ timedOut: true });
      }, 500);
    }, TURN_WAIT_TIMEOUT_MS);
    return await promise;
  } finally {
    unsubscribe();
    if (timeout !== undefined) clearTimeout(timeout);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
