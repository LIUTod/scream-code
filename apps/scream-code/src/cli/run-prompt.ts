import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';
import {
  ScreamHarness,
  log,
  resolveScreamHome,
  type Event,
  type HookResultEvent,
  type Session,
  type SessionStatus,
} from '@scream-code/scream-code-sdk';
import { setLocale, t } from '@scream-code/config';

import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { formatTokenLimit } from '#/utils/usage/token-limit';
import { formatTokenCount } from '#/utils/usage/usage-format';
import { formatDurationMs } from './duration';
import type { CLIOptions, PromptOutputFormat } from './options';
import { createScreamCodeHostIdentity } from './version';

interface PromptOutput {
  readonly columns?: number | undefined;
  write(chunk: string): boolean;
}

interface PromptRunIO {
  readonly stdout?: PromptOutput;
  readonly stderr?: PromptOutput;
  readonly process?: PromptProcess;
}

interface PromptProcess {
  once(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  off(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  exit(code?: number): never | void;
}

/** Exit status of a run stopped by `--max-time` — the conventional `timeout` command's status. */
export const PROMPT_TIMEOUT_EXIT_CODE = 124;

/** A prompt run stopped because `--max-time` ran out; the session is saved and resumable. */
export class PromptTimeoutError extends Error {
  readonly exitCode = PROMPT_TIMEOUT_EXIT_CODE;
  constructor(limitMs: number) {
    super(t('cli.prompt.max_time', { duration: formatDurationMs(limitMs) }));
    this.name = 'PromptTimeoutError';
  }
}

const PROMPT_UI_MODE = 'print';
/**
 * This process exits when the prompt is answered, so a scheduled task created
 * here could never fire, and one already in a resumed session must not fire
 * into this one-off run instead of the interactive session it belongs to.
 * (`uiMode` cannot carry this: the IM channel daemon is also 'print' and its
 * sessions do run scheduled tasks.)
 */
const PROMPT_SCHEDULED_TASKS = false;
const PROMPT_MAIN_AGENT_ID = 'main';
const PROMPT_BLOCK_BULLET = '• ';
const PROMPT_BLOCK_INDENT = '  ';

export async function runPrompt(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const workDir = process.cwd();
  const homeDir = resolveScreamHome();
  const harness = new ScreamHarness({
    homeDir,
    identity: createScreamCodeHostIdentity(version),
    uiMode: PROMPT_UI_MODE,
    skillDirs: opts.skillsDirs,
  });

  // Read `[subagentModels]` from tui.toml so `/model diy` bindings configured
  // in the interactive TUI also apply to `scream -p` sessions. tui.toml is
  // read once here — prompt mode is single-shot, no live updates needed.
  // A malformed tui.toml falls back to empty bindings rather than aborting.
  let promptTuiConfig;
  try {
    promptTuiConfig = await loadTuiConfig();
    setLocale(promptTuiConfig.language);
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    promptTuiConfig = error.fallback;
    setLocale(promptTuiConfig.language);
  }
  const promptSubagentModels = promptTuiConfig.subagentModels;
  harness.setSubagentModelBindings(() => promptSubagentModels);
  // Same for the per-purpose bindings (`[modelTiers]`): role routing and the
  // housekeeping compaction model configured in the TUI must apply here too.
  const promptModelTiers = promptTuiConfig.modelTiers ?? {};
  harness.setModelTierBindings(() => promptModelTiers);

  log.info('scream-code starting', {
    version,
    uiMode: PROMPT_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });
  let restorePromptSessionPermission = async (): Promise<void> => {};
  let cleanupEphemeralSession = async (): Promise<void> => {};
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanupPromptRun = async (): Promise<void> => {
    cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      try {
        await restorePromptSessionPermission();
      } finally {
        try {
          await cleanupEphemeralSession();
        } finally {
          await harness.close();
        }
      }
    })();
    await cleanupPromise;
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanupPromptRun);
  let timedOut = false;

  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    const { session, restorePermission } = await resolvePromptSession(
      harness,
      opts,
      workDir,
      config.defaultModel,
      stderr,
      (restorePermission) => {
        restorePromptSessionPermission = restorePermission;
      },
    );
    restorePromptSessionPermission = restorePermission;

    const outputFormat = opts.outputFormat ?? 'text';
    try {
      await runPromptTurn(session, opts.prompt!, outputFormat, stdout, stderr, opts.maxTimeMs);
    } catch (error) {
      // The work done so far is saved, so tell the caller how to carry on.
      if (error instanceof PromptTimeoutError) {
        timedOut = true;
        writeResumeHint(session.id, outputFormat, stdout, stderr);
      }
      throw error;
    }
    writeResumeHint(session.id, outputFormat, stdout, stderr);
  } finally {
    if (timedOut) {
      // The time limit is the verdict (exit 124) and callers script against it:
      // a failure while winding down a run that was already stopped must not
      // replace it with a generic error. It is still worth a log line.
      await cleanupPromptRun().catch((error: unknown) => {
        log.warn('prompt run cleanup failed after --max-time', { error: String(error) });
      });
    } else {
      await cleanupPromptRun();
    }
  }
}

interface ResolvedPromptSession {
  readonly session: Session;
  readonly resumed: boolean;
  readonly restorePermission: () => Promise<void>;
}

async function resolvePromptSession(
  harness: ScreamHarness,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<ResolvedPromptSession> {
  if (opts.session !== undefined) {
    const sessions = await harness.listSessions({ sessionId: opts.session, workDir });
    const target = sessions[0];
    if (target === undefined) {
      throw new Error(t('cli.prompt.session_not_found', { id: opts.session }));
    }
    if (!sameWorkDir(target.workDir, workDir)) {
      stderr.write(
        `${chalk.yellow(
          `${t('cli.prompt.session_other_dir', { id: opts.session })}\n` +
            `  cd "${target.workDir}" && scream -r ${opts.session}`,
        )}\n\n`,
      );
      throw new Error(t('cli.prompt.session_other_dir', { id: opts.session }));
    }
    const session = await harness.resumeSession({
      id: opts.session,
      scheduledTasks: PROMPT_SCHEDULED_TASKS,
    });
    const status = await session.getStatus();
    const restorePermission = await forcePromptPermission(
      session,
      status.permission,
      setRestorePermission,
    );
    if (opts.model !== undefined) {
      await session.setModel(opts.model);
    }
    installHeadlessHandlers(session);
    return {
      session,
      resumed: true,
      restorePermission,
    };
  }

  if (opts.continue) {
    const sessions = await harness.listSessions({ workDir });
    const previous = sessions[0];
    if (previous !== undefined) {
      const session = await harness.resumeSession({
        id: previous.id,
        scheduledTasks: PROMPT_SCHEDULED_TASKS,
      });
      const status = await session.getStatus();
      const restorePermission = await forcePromptPermission(
        session,
        status.permission,
        setRestorePermission,
      );
      if (opts.model !== undefined) {
        await session.setModel(opts.model);
      }
      installHeadlessHandlers(session);
      return {
        session,
        resumed: true,
        restorePermission,
      };
    }
    stderr.write(`${t('cli.prompt.no_session_to_continue', { dir: workDir })}\n`);
  }

  const model = requireConfiguredModel(opts.model, defaultModel);
  const session = await harness.createSession({
    workDir,
    model,
    permission: 'auto',
    scheduledTasks: PROMPT_SCHEDULED_TASKS,
  });
  installHeadlessHandlers(session);
  return { session, resumed: false, restorePermission: async () => {} };
}

async function forcePromptPermission(
  session: Session,
  restoredPermission: SessionStatus['permission'],
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<() => Promise<void>> {
  // A session saved by an older build can still carry the removed `manual`
  // mode; restore into `yolo` instead of a posture the engine no longer has.
  const previousPermission: SessionStatus['permission'] =
    (restoredPermission as string) === 'manual' ? 'yolo' : restoredPermission;
  let overridePermission: Promise<void> | undefined;
  const restorePermission = async () => {
    await overridePermission?.catch(() => {});
    if (previousPermission !== 'auto') {
      await session.setPermission(previousPermission);
    }
  };
  setRestorePermission(restorePermission);
  if (previousPermission !== 'auto') {
    overridePermission = session.setPermission('auto');
    await overridePermission;
  }
  return restorePermission;
}

function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = configuredModel(...models);
  if (model === undefined) {
    throw new Error(
      t('cli.prompt.no_model'),
    );
  }
  return model;
}

function configuredModel(...models: readonly (string | undefined)[]): string | undefined {
  return models.find((model) => model !== undefined && model.trim().length > 0);
}

function installHeadlessHandlers(session: Session): void {
  session.setApprovalHandler(() => ({ decision: 'approved' }));
  session.setQuestionHandler(() => null);
}

function installPromptTerminationCleanup(
  promptProcess: PromptProcess,
  cleanup: () => Promise<void>,
): () => void {
  let terminating = false;
  const exitAfterCleanup = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      await cleanup();
    } finally {
      promptProcess.exit(signalExitCode(signal));
    }
  };
  const onSigint = () => exitAfterCleanup('SIGINT');
  const onSigterm = () => exitAfterCleanup('SIGTERM');
  promptProcess.once('SIGINT', onSigint);
  promptProcess.once('SIGTERM', onSigterm);
  return () => {
    promptProcess.off('SIGINT', onSigint);
    promptProcess.off('SIGTERM', onSigterm);
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function runPromptTurn(
  session: Session,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
  maxTimeMs?: number | undefined,
): Promise<void> {
  let activeTurnId: number | undefined;
  let activeAgentId: string | undefined;
  const outputWriter =
    outputFormat === 'stream-json'
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);
  let settled = false;
  let unsubscribe: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  let resolve: () => void;
  let reject: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    if (deadline !== undefined) clearTimeout(deadline);
    unsubscribe?.();
    outputWriter.finish();
    if (error !== undefined) {
      reject(error);
      return;
    }
    resolve();
  };

  unsubscribe = session.onEvent((event) => {
    if (event.type === 'error') {
      if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
        return;
      }
      finish(new Error(`${event.code}: ${event.message}`));
      return;
    }
    if (event.type === 'turn.started' && activeTurnId === undefined) {
      if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
        return;
      }
      activeTurnId = event.turnId;
      activeAgentId = event.agentId;
      return;
    }
    if (
      activeTurnId === undefined ||
      activeAgentId === undefined ||
      !hasTurnId(event) ||
      event.turnId !== activeTurnId ||
      event.agentId !== activeAgentId
    ) {
      return;
    }
    switch (event.type) {
      case 'turn.step.started':
      case 'turn.step.interrupted':
        outputWriter.flushAssistant();
        return;
      case 'turn.step.retrying':
        outputWriter.discardAssistant();
        return;
      case 'assistant.delta':
        outputWriter.writeAssistantDelta(event.delta);
        return;
      case 'hook.result':
        outputWriter.writeHookResult(event);
        return;
      case 'thinking.delta':
        outputWriter.writeThinkingDelta(event.delta);
        return;
      case 'tool.call.started':
        outputWriter.writeToolCall(event.toolCallId, event.name, event.args);
        return;
      case 'tool.call.delta':
        outputWriter.writeToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
        return;
      case 'tool.result':
        outputWriter.writeToolResult(event.toolCallId, event.output);
        return;
      case 'tool.progress':
        if (event.update.text !== undefined && event.update.text.length > 0) {
          stderr.write(
            event.update.text.endsWith('\n') ? event.update.text : `${event.update.text}\n`,
          );
        }
        return;
      case 'turn.ended':
        if (event.reason === 'completed' && event.tokenCapReached !== undefined) {
          // The session token limit stopped the turn before a model request: the
          // prompt did not get done, so do not report success.
          finish(
            new Error(
              t('cli.prompt.token_cap', {
                used: formatTokenCount(event.tokenCapReached.usedTokens),
                limit: formatTokenLimit(event.tokenCapReached.limitTokens),
              }),
            ),
          );
          return;
        }
        if (event.reason === 'completed') {
          finish();
          return;
        }
        finish(new Error(formatTurnEndedFailure(event)));
        return;
      case 'agent.status.updated':
      case 'background.task.started':
      case 'background.task.terminated':
      case 'background.task.updated':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
      case 'compaction.started':
      case 'mcp.server.status':
      case 'memory.recalled':
      case 'session.meta.updated':
      case 'skill.activated':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.spawned':
      case 'tool.list.updated':
      case 'turn.started':
      case 'turn.step.completed':
        return;
    }
  });

  if (maxTimeMs !== undefined) {
    deadline = setTimeout(() => {
      // Stop the work, but do not wait for it to wind down: the limit is about
      // when this process returns.
      void session.cancel().catch(() => {});
      finish(new PromptTimeoutError(maxTimeMs));
    }, maxTimeMs);
  }

  session.prompt(prompt).catch((error: unknown) => {
    finish(error instanceof Error ? error : new Error(String(error)));
  });

  return promise;
}

interface PromptTurnWriter {
  writeAssistantDelta(delta: string): void;
  writeHookResult(event: HookResultEvent): void;
  writeThinkingDelta(delta: string): void;
  writeToolCall(toolCallId: string, name: string, args: unknown): void;
  writeToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void;
  writeToolResult(toolCallId: string, output: unknown): void;
  flushAssistant(): void;
  discardAssistant(): void;
  finish(): void;
}

class PromptTranscriptWriter implements PromptTurnWriter {
  private readonly assistantWriter: PromptBlockWriter;
  private readonly thinkingWriter: PromptBlockWriter;

  constructor(stdout: PromptOutput, stderr: PromptOutput) {
    this.assistantWriter = new PromptBlockWriter(stdout);
    this.thinkingWriter = new PromptBlockWriter(stderr);
  }

  writeAssistantDelta(delta: string): void {
    this.thinkingWriter.finish();
    this.assistantWriter.write(delta);
  }

  writeHookResult(event: HookResultEvent): void {
    this.thinkingWriter.finish();
    this.assistantWriter.finish();
    this.assistantWriter.write(formatHookResultPlain(event));
    this.assistantWriter.finish();
  }

  writeThinkingDelta(delta: string): void {
    this.thinkingWriter.write(delta);
  }

  writeToolCall(): void {}

  writeToolCallDelta(): void {}

  writeToolResult(): void {}

  flushAssistant(): void {}

  discardAssistant(): void {}

  finish(): void {
    this.thinkingWriter.finish();
    this.assistantWriter.finish();
  }
}

interface PromptJsonToolCall {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface PromptJsonAssistantMessage {
  role: 'assistant';
  content?: string;
  tool_calls?: PromptJsonToolCall[];
}

interface PromptJsonToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

interface PromptJsonResumeMetaMessage {
  role: 'meta';
  type: 'session.resume_hint';
  session_id: string;
  command: string;
  content: string;
}

function writeResumeHint(
  sessionId: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): void {
  const command = `scream -r ${sessionId}`;
  const content = t('cli.resume_hint', { command });
  if (outputFormat === 'stream-json') {
    const message: PromptJsonResumeMetaMessage = {
      role: 'meta',
      type: 'session.resume_hint',
      session_id: sessionId,
      command,
      content,
    };
    stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  stderr.write(`${content}\n`);
}

class PromptJsonWriter implements PromptTurnWriter {
  private assistantText = '';
  private readonly toolCalls: PromptJsonToolCall[] = [];

  constructor(private readonly stdout: PromptOutput) {}

  writeAssistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  writeHookResult(event: HookResultEvent): void {
    this.flushAssistant();
    this.writeJsonLine({
      role: 'assistant',
      content: formatHookResultPlain(event),
    });
  }

  writeThinkingDelta(): void {}

  writeToolCall(toolCallId: string, name: string, args: unknown): void {
    const existing = this.toolCalls.find((toolCall) => toolCall.id === toolCallId);
    if (existing !== undefined) {
      existing.function.name = name;
      existing.function.arguments = stringifyJsonValue(args);
      return;
    }
    this.toolCalls.push({
      type: 'function',
      id: toolCallId,
      function: {
        name,
        arguments: stringifyJsonValue(args),
      },
    });
  }

  writeToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void {
    const toolCall = this.findOrCreateToolCall(toolCallId, name ?? '');
    if (name !== undefined) {
      toolCall.function.name = name;
    }
    if (argumentsPart !== undefined) {
      toolCall.function.arguments += argumentsPart;
    }
  }

  writeToolResult(toolCallId: string, output: unknown): void {
    this.flushAssistant();
    this.writeJsonLine({
      role: 'tool',
      tool_call_id: toolCallId,
      content: stringifyToolOutput(output),
    });
  }

  flushAssistant(): void {
    if (this.assistantText.length === 0 && this.toolCalls.length === 0) return;
    const message: PromptJsonAssistantMessage = {
      role: 'assistant',
      content: this.assistantText.length > 0 ? this.assistantText : undefined,
      tool_calls: this.toolCalls.length > 0 ? [...this.toolCalls] : undefined,
    };
    this.writeJsonLine(message);
    this.discardAssistant();
  }

  discardAssistant(): void {
    this.assistantText = '';
    this.toolCalls.length = 0;
  }

  finish(): void {
    this.flushAssistant();
  }

  private findOrCreateToolCall(toolCallId: string, name: string): PromptJsonToolCall {
    const existing = this.toolCalls.find((toolCall) => toolCall.id === toolCallId);
    if (existing !== undefined) return existing;
    const toolCall: PromptJsonToolCall = {
      type: 'function',
      id: toolCallId,
      function: {
        name,
        arguments: '',
      },
    };
    this.toolCalls.push(toolCall);
    return toolCall;
  }

  private writeJsonLine(message: PromptJsonAssistantMessage | PromptJsonToolMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

class PromptBlockWriter {
  private started = false;
  private atLineStart = false;
  private lineWidth = 0;
  private readonly wrapWidth: number | undefined;

  constructor(private readonly output: PromptOutput) {
    this.wrapWidth =
      typeof output.columns === 'number' && output.columns > PROMPT_BLOCK_INDENT.length + 1
        ? output.columns
        : undefined;
  }

  write(chunk: string): void {
    if (chunk.length === 0) return;
    let rendered = this.start();
    for (const char of chunk) {
      if (this.atLineStart && char !== '\n') {
        rendered += PROMPT_BLOCK_INDENT;
        this.atLineStart = false;
        this.lineWidth = PROMPT_BLOCK_INDENT.length;
      }
      const charWidth = visibleCharWidth(char);
      if (
        this.wrapWidth !== undefined &&
        !this.atLineStart &&
        char !== '\n' &&
        this.lineWidth + charWidth > this.wrapWidth
      ) {
        rendered += `\n${PROMPT_BLOCK_INDENT}`;
        this.lineWidth = PROMPT_BLOCK_INDENT.length;
      }
      rendered += char;
      if (char === '\n') {
        this.atLineStart = true;
        this.lineWidth = 0;
      } else {
        this.lineWidth += charWidth;
      }
    }
    this.output.write(rendered);
  }

  finish(): void {
    if (!this.started) return;
    this.output.write(this.atLineStart ? '\n' : '\n\n');
    this.started = false;
    this.atLineStart = false;
    this.lineWidth = 0;
  }

  private start(): string {
    if (this.started) return '';
    this.started = true;
    this.atLineStart = false;
    this.lineWidth = PROMPT_BLOCK_BULLET.length;
    return PROMPT_BLOCK_BULLET;
  }
}

function visibleCharWidth(char: string): number {
  return char === '\t' ? 4 : 1;
}

function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultEvent): string {
  return `${event.hookEvent} hook${event.blocked === true ? t('cli.prompt.hook_blocked') : ''}`;
}

function formatHookResultBody(event: HookResultEvent): string {
  const content = event.content.trim();
  return content.length === 0 ? t('cli.prompt.empty') : content;
}

function stringifyJsonValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json ?? '';
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const json = JSON.stringify(output);
  return json ?? String(output);
}

function hasTurnId(event: Event): event is Event & { readonly turnId: number } {
  return 'turnId' in event;
}

function formatTurnEndedFailure(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.error !== undefined) return `${event.error.code}: ${event.error.message}`;
  return t('cli.prompt.turn_ended', { reason: event.reason });
}
/**
 * Compare two working directories tolerating symlink aliases (/tmp vs
 * /private/tmp on macOS), trailing separators, and Windows case
 * differences. Falls back to resolved-string compare when either path
 * doesn't exist on disk.
 */
function sameWorkDir(a: string, b: string): boolean {
  const normalize = (p: string): string => {
    let out = resolve(p);
    try {
      out = realpathSync(out);
    } catch {
      // Path doesn't exist — keep the resolved form.
    }
    out = out.replace(/[/\\]+$/, '');
    return process.platform === 'win32' ? out.toLowerCase() : out;
  };
  return normalize(a) === normalize(b);
}
