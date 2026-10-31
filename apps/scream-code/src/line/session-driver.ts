/**
 * Line session driver — maps Feishu chats to scream agent sessions.
 *
 * Uses the same headless layer as `scream stream-json` (`ScreamHarness`),
 * including the create/resume/repair session lifecycle (ported from
 * `run-stream-json.ts` L659-726) and the approval-handler mapping. Turns are
 * serialized per session (one FIFO chain each) and run in parallel across
 * sessions; a bounded queue rejects new work with a friendly busy reply
 * instead of growing unbounded.
 */

import { execFile } from 'node:child_process';
import { realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  ScreamHarness,
  isOrphanedToolCallError,
  log,
  resolveScreamHome,
  type Event as SdkEvent,
  type PromptPart,
  type Session,
  type ToolCallRequest,
  type ToolCallResponse,
} from '@scream-code/scream-code-sdk';

import { mapStreamJsonMode } from '#/cli/run-stream-json';
import { buildChannelPrompt } from './channel-prompt';
import type { LineCustomCommand } from './config';
import type { LineImageAttachment } from './media';
import { isLineCommand, runLineCommand, type LineCommandResult } from './command-router';
import { createScreamCodeHostIdentity } from '#/cli/version';
import { describeVoiceSupport, probeVoiceSupport, type VoiceSupport } from './voice-support';
import { buildCronFailureNotice, buildCronReminderChip } from '../tui/utils/cron-chip';
import type { ProactiveDelivery } from './proactive';
import { CronRelay } from './cron-relay';
import { LineTurnCollector } from './turn-collector';

const MAX_QUEUE_PER_SESSION = 3;
const ORPHAN_RESET_NOTICE = '会话已自动重置，请重新发送你的消息。';

export type { LineImageAttachment } from './media';

/** A turn that never settles is cancelled after this long (product default). */
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * `/stop` interrupts in-process. A tool that ignores the abort would otherwise
 * keep the chat busy until the 15-minute cap, so after this window the live
 * session is closed: history stays on disk and the next message resumes the same
 * session id — the same end result as tearing down the agent process.
 */
const STOP_ESCALATION_MS = 10_000;
const TURN_TIMEOUT_TEXT = '本轮执行超时（15 分钟），已取消。请重试或拆分任务。';

/** `exec`-type custom commands are bounded like any other IM command. */
const CUSTOM_COMMAND_TIMEOUT_MS = 30_000;
const CUSTOM_COMMAND_MAX_BUFFER = 1024 * 1024;
const CUSTOM_COMMAND_OUTPUT_LIMIT = 8_000;

const execFileAsync = promisify(execFile);

/** POSIX shell single-quoting; Windows never interpolates arguments (see runCustomExec). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Host tool exposed to the model so it can send images/files over the channel. */
export const LINE_SEND_MEDIA_TOOL = 'line_send_media';
/** One outbound attachment cap (matches the reference upload limit order). */
export const MAX_OUTBOUND_MEDIA_BYTES = 25 * 1024 * 1024;

export type LineMediaSender = (
  kind: 'image' | 'file' | 'voice',
  path: string,
) => Promise<string | void>;

export interface LineTurnJob {
  readonly sessionKey: string;
  readonly text: string;
  /** Inbound images; sent as `image_url` parts of the prompt. */
  readonly images?: readonly LineImageAttachment[];
  /** Absolute paths of inbound files already saved to disk. */
  readonly files?: readonly string[];
  /**
   * Called when this message has to wait behind a running turn. Without it the
   * chat hears nothing for minutes, which reads as "the bot is dead"; the
   * daemon sends a one-line receipt instead.
   */
  readonly onQueued?: (position: number) => void;
}

export interface TurnOutcome {
  ok: boolean;
  text: string;
  /** No reply should be sent: the chat was already answered (e.g. `/stop`). */
  silent?: boolean;
}

export interface LineSessionDriverOptions {
  permissionMode: 'auto' | 'yolo' | 'dontAsk';
  /** User-defined IM commands from the line config. */
  commands?: readonly LineCustomCommand[];
  /** Session working directory (default: daemon start cwd). */
  workDir?: string;
  /** Session model (default: config.defaultModel). */
  model?: string;
  /** Channel platform — recorded in session metadata for the picker badge. */
  platform: 'feishu' | 'weixin';
  /**
   * Called when this message has to wait behind a running turn. Without it the
   * chat hears nothing for minutes, which reads as "the bot is dead"; the
   * daemon sends a one-line "queued" receipt instead.
   */
  onQueued?: (position: number) => void;
}

interface SessionQueue {
  chain: Promise<void>;
  pending: number;
}

type MappedMode = ReturnType<typeof mapStreamJsonMode>;

export class LineSessionDriver {
  private harness: ScreamHarness | undefined;
  private defaultModel = '';
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, SessionQueue>();
  /** Sessions that already carry the channel capability note (per object, so a
   * resumed or re-created session gets it again). */
  private readonly promptedSessions = new WeakSet<Session>();
  /** sessionKey → platform sender for outbound media (registered by the daemon). */
  private readonly mediaSenders = new Map<string, LineMediaSender>();
  /** Fallback sender resolved from the platform's own target cache, so a
   *  scheduled-task turn can still send media after a reset or restart. */
  private mediaSenderResolver: ((sessionKey: string) => LineMediaSender | undefined) | undefined;
  /** Session id → sessionKey, so a host tool call can find its channel. */
  private readonly sessionKeyBySessionId = new Map<string, string>();
  /** Chats currently executing `/new`; a turn must not start meanwhile. */
  private readonly resetting = new Set<string>();
  /** The turn executing right now per chat, so `/stop` has something to abort.
   *  Chats run in parallel, so this is keyed by session — a single slot would
   *  let one chat's turn hide another's from `/stop`. */
  private readonly activeTurns = new Map<string, { sessionKey: string; stop: () => void }>();
  /** Bumped by `/stop`: turns queued before the bump are dropped instead of
   *  running. "Stop" has to mean the messages I just sent, not only the one
   *  that happens to be executing. */
  private stopEpoch = new Map<string, number>();
  /** Escalation timers for a `/stop` whose turn never settles, per chat. */
  private readonly stopEscalations = new Map<string, ReturnType<typeof setTimeout>>();
  /** Injected by the daemon: sends to a chat with no inbound message to reply
   *  to. Undefined when no platform supports proactive delivery. */
  private proactiveSender:
    | ((sessionKey: string, text: string) => Promise<ProactiveDelivery>)
    | undefined;
  /** One relay + event subscription per live session, so scheduled tasks can
   *  reach the chat. Replaced on session reset, dropped on close. */
  private cronForwarders = new Map<
    string,
    { unsubscribe: () => void; relay: CronRelay; isCronTurnRunning: () => boolean }
  >();
  /** Cached ffmpeg capability answer (see `probeVoice`). */
  private voiceSupport: VoiceSupport | null = null;
  /** In-flight creations, so a command and a turn cannot create two sessions. */
  private readonly sessionCreations = new Map<string, Promise<Session>>();
  /** Per-chat lifecycle mutex: session creation must never interleave a reset. */
  private readonly lifecycleLocks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly options: LineSessionDriverOptions) {}

  async init(): Promise<void> {
    const harness = new ScreamHarness({
      homeDir: resolveScreamHome(),
      identity: createScreamCodeHostIdentity(),
      uiMode: 'print',
      // Host tool calls (the `line_send_media` bridge) are answered here.
      onToolCall: (request) => this.handleHostToolCall(request),
    });
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    this.defaultModel = config.defaultModel ?? '';
    this.harness = harness;
  }

  /**
   * Probes the host for an AMR-NB encoder once. Called by the daemon at startup
   * so `/status` can warn before the first voice reply falls back to a file.
   * Never throws.
   */
  async probeVoice(): Promise<void> {
    try {
      this.voiceSupport = await probeVoiceSupport();
      const description = describeVoiceSupport(this.voiceSupport);
      if (description !== null) log.info('line: voice capability', { support: this.voiceSupport });
    } catch (error) {
      this.voiceSupport = 'unknown';
      log.warn('line: voice probe failed', { error: String(error) });
    }
  }

  /**
   * `/stop`: aborts the turn that is running now. The cancel itself happens
   * inside `runTurn` so the queue unwinds in one place; this only requests it.
   */
  stopActiveTurn(sessionKey: string): boolean {
    const running = this.activeTurns.get(sessionKey);
    const pending = this.queues.get(sessionKey)?.pending ?? 0;
    const forwarder = this.cronForwarders.get(sessionKey);
    const forwarding = forwarder?.relay.isCollecting() ?? false;
    const cronTurn = forwarder?.isCronTurnRunning() ?? false;
    if (running === undefined && pending === 0 && !forwarding && !cronTurn) return false;
    // Queued turns captured this epoch are dropped when their chain reaches
    // them; the running one is interrupted through its stop promise.
    this.stopEpoch.set(sessionKey, (this.stopEpoch.get(sessionKey) ?? 0) + 1);
    if (running !== undefined) {
      running.stop();
      this.armStopEscalation(sessionKey);
    }
    if (forwarding || cronTurn) {
      // A scheduled task's turn is not in the queue, so it needs its own stop:
      // discard the relay first, otherwise the cancelled turn would be reported
      // as "finished with no output".
      forwarder?.relay.dispose();
      void this.sessions.get(sessionKey)?.cancel().catch(() => {});
      log.info('line: dropped a scheduled-task turn', { sessionKey });
    }
    log.info('line: stop requested', { sessionKey, running: running !== undefined, pending });
    return true;
  }

  /**
   * `/cancel`: stop whatever runs and start a clean session. Falls back to
   * closing the live session when a hung tool refuses to settle, then resets.
   */
  async cancelSession(sessionKey: string): Promise<boolean> {
    const stopped = this.stopActiveTurn(sessionKey);
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        resolve('timeout');
      }, STOP_ESCALATION_MS);
      timer.unref?.();
    });
    const reset = this.resetSession(sessionKey).then(
      () => 'done' as const,
      () => 'done' as const,
    );
    if ((await Promise.race([reset, timeout])) === 'timeout') {
      log.warn('line: cancel could not reset in time, closing live session', { sessionKey });
      await this.forceCloseSession(sessionKey);
      await this.resetSession(sessionKey).catch((error: unknown) => {
        log.warn('line: cancel reset failed after close', { sessionKey, error: String(error) });
      });
    }
    return stopped;
  }

  private armStopEscalation(sessionKey: string): void {
    this.clearStopEscalation(sessionKey);
    const timer = setTimeout(() => {
      this.stopEscalations.delete(sessionKey);
      if (!this.activeTurns.has(sessionKey)) return;
      log.warn('line: /stop did not settle, closing the live session', { sessionKey });
      void this.forceCloseSession(sessionKey);
    }, STOP_ESCALATION_MS);
    timer.unref?.();
    this.stopEscalations.set(sessionKey, timer);
  }

  private clearStopEscalation(sessionKey: string): void {
    const timer = this.stopEscalations.get(sessionKey);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.stopEscalations.delete(sessionKey);
  }

  /** Closes the live session without deleting it: the next message resumes. */
  private async forceCloseSession(sessionKey: string): Promise<void> {
    this.stopCronForwarder(sessionKey);
    const session = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    if (session !== undefined) {
      this.sessionKeyBySessionId.delete(session.id);
      // Closing the RPC is what unblocks a hung `cancel()`.
      await session.close().catch(() => {});
    }
    this.mediaSenders.delete(sessionKey);
  }

  /**
   * Submit a turn on the session for `sessionKey`. Serialized per session;
   * resolves with the turn outcome (final text or a friendly error).
   */
  async submit(job: LineTurnJob): Promise<TurnOutcome> {
    if (this.closed) {
      return { ok: false, text: 'line 守护进程正在关闭，请稍后再试。' };
    }
    if (!this.harness) {
      throw new Error('LineSessionDriver 未初始化');
    }
    // Slash commands are answered by the bridge and never reach the model.
    // Unrecognised ones fall through to the turn below (reference behaviour).
    // A message carrying attachments is a prompt, never a command: intercepting
    // it would silently drop the photos/files the user just sent.
    if (this.resetting.has(job.sessionKey)) {
      return { ok: false, text: '会话正在重置，请稍后重发这条消息。' };
    }
    const hasAttachments = (job.images?.length ?? 0) > 0 || (job.files?.length ?? 0) > 0;
    let effectiveJob = job;
    if (!hasAttachments && isLineCommand(job.text)) {
      const result = await this.runCommand(job.sessionKey, job.text);
      if ('prompt' in result) {
        // Prompt-type custom command: its expanded text becomes this turn.
        effectiveJob = { ...job, text: result.prompt };
      } else if (result.handled) {
        return { ok: true, text: result.text };
      }
    }
    const queue = this.queues.get(effectiveJob.sessionKey) ?? { chain: Promise.resolve(), pending: 0 };
    if (queue.pending >= MAX_QUEUE_PER_SESSION) {
      log.warn('line: session queue full, replying busy', { sessionKey: effectiveJob.sessionKey });
      return { ok: false, text: '上一条消息还在处理中，队列已满，请稍后再发。' };
    }
    const epoch = this.stopEpoch.get(effectiveJob.sessionKey) ?? 0;
    const waitingBehind = queue.pending;
    queue.pending += 1;
    this.queues.set(effectiveJob.sessionKey, queue);
    if (waitingBehind > 0) {
      // Fire-and-forget receipt: the chat should know it was heard even though
      // the turn has not started. A broken notifier must never fail the turn.
      try {
        effectiveJob.onQueued?.(waitingBehind);
      } catch (error) {
        log.warn('line: queued notice failed', { sessionKey: effectiveJob.sessionKey, error: String(error) });
      }
    }

    let outcome!: TurnOutcome;
    const next = queue.chain.then(async () => {
      if ((this.stopEpoch.get(effectiveJob.sessionKey) ?? 0) !== epoch) {
        // `/stop` arrived while this message waited: drop it silently — the
        // chat already got the "已停止" receipt.
        outcome = { ok: false, text: '', silent: true };
        return;
      }
      try {
        outcome = await this.runTurn(effectiveJob);
      } catch (error) {
        // Last-resort guard: every submitted message must get a reply.
        log.error('line: turn crashed unexpectedly', { sessionKey: effectiveJob.sessionKey, error: String(error) });
        outcome = { ok: false, text: friendlyTurnError(error) };
      }
    });
    queue.chain = next.catch(() => {}); // never let the chain reject
    await next.finally(() => {
      queue.pending -= 1;
      if (queue.pending === 0 && this.queues.get(effectiveJob.sessionKey) === queue) {
        this.queues.delete(effectiveJob.sessionKey);
      }
    });
    return outcome;
  }

  /**
   * Resolves after `TURN_TIMEOUT_MS`. Raced against the turn promise so a
   * provider that never emits a settlement event cannot wedge the chat queue.
   *
   * The timer belongs to this turn, not to the driver: chats run in parallel,
   * so a shared field would let the first chat to finish cancel the second
   * chat's deadline and leave that turn with no way out.
   */
  private turnDeadline(): { promise: Promise<void>; clear: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TURN_TIMEOUT_MS);
      timer.unref?.();
    });
    return {
      promise,
      clear: () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      },
    };
  }

  /** Close all sessions and the harness (daemon shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.stopEscalations.values()) clearTimeout(timer);
    this.stopEscalations.clear();
    const forwarders = [...this.cronForwarders.values()];
    this.cronForwarders.clear();
    for (const forwarder of forwarders) {
      forwarder.unsubscribe();
      forwarder.relay.dispose();
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await session.close().catch(() => {});
    }
    await this.harness?.close().catch(() => {});
    this.harness = undefined;
  }

  // ─── Turn execution (port of run-stream-json event collection) ──────────

  private async runTurn(job: LineTurnJob): Promise<TurnOutcome> {
    const harness = this.harness;
    if (!harness) return { ok: false, text: 'line 守护进程未初始化' };

    const session = await this.resolveSession(job.sessionKey);
    this.applyApprovalHandler(session);
    session.setQuestionHandler(() => null);

    // Collect the final content output for this turn via the collector
    // (thinking excluded; narration before tool calls discarded).
    let promptError: unknown;
    let resolveTurn!: () => void;
    const turnPromise = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    let stopRequested = false;
    let requestStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      requestStop = () => {
        stopRequested = true;
        resolve();
      };
    });
    const collector = new LineTurnCollector(resolveTurn);

    const unsubscribe = session.onEvent((event) => {
      collector.handleEvent(event);
    });

    const registration = { sessionKey: job.sessionKey, stop: requestStop };
    this.activeTurns.set(job.sessionKey, registration);
    const deadline = this.turnDeadline();
    try {
      session
        .prompt(buildPromptParts(job))
        .catch((error: unknown) => {
          promptError = error;
          // Without an error event the turn never ends — resolve so we can
          // surface the prompt failure below instead of hanging.
          resolveTurn();
        });
      await Promise.race([turnPromise, deadline.promise, stopPromise]);
      if (stopRequested) {
        // `/stop` already replied in the chat; suppress this turn's own reply
        // so the user does not read the same sentence twice.
        await session.cancel().catch(() => {});
        return { ok: false, text: '', silent: true };
      }
      if (!collector.ended) {
        // The deadline won: cancel the run and report, otherwise the queue
        // slot would stay occupied until the daemon restarts.
        await session.cancel().catch(() => {});
        return { ok: false, text: TURN_TIMEOUT_TEXT };
      }
    } finally {
      if (this.activeTurns.get(job.sessionKey) === registration) {
        this.activeTurns.delete(job.sessionKey);
      }
      this.clearStopEscalation(job.sessionKey);
      unsubscribe();
      deadline.clear();
    }

    // Orphaned tool calls in history — reset the session so the next message
    // starts fresh (port of the run-stream-json reset path).
    if (promptError !== undefined && isOrphanedToolCallError(promptError)) {
      log.warn('line: resetting session after tool call mismatch', {
        sessionKey: job.sessionKey,
        error: promptError instanceof Error ? promptError.message : '[non-error throw]',
      });
      await session.close({ extractMemories: false }).catch(() => {});
      await harness.deleteSession(job.sessionKey).catch(() => {});
      this.sessions.delete(job.sessionKey);
      this.sessionKeyBySessionId.delete(session.id);
      return { ok: false, text: ORPHAN_RESET_NOTICE };
    }
    if (promptError !== undefined) {
      return { ok: false, text: friendlyTurnError(promptError) };
    }
    if (collector.failure) {
      return { ok: false, text: friendlyProviderError(collector.failure.code, collector.failure.message) };
    }
    if (collector.ended === 'completed' && !collector.stepBudgetExhausted) {
      const finalText = collector.text.trim();
      return { ok: true, text: finalText.length > 0 ? finalText : '（本轮没有产出文本内容）' };
    }
    if (collector.ended === 'cancelled') {
      return { ok: false, text: '本轮已被中断。' };
    }
    if (collector.stepBudgetExhausted) {
      return { ok: false, text: collector.text.trim() || '本轮步数预算用尽，已提前收尾。' };
    }
    return { ok: false, text: `处理失败：turn ended: ${collector.ended ?? 'unknown'}` };
  }

  /**
   * Waits for in-flight turns to finish (bounded), so a shutdown does not cut a
   * reply mid-flight. Only the per-chat queues are awaited.
   */
  /** How many turns are queued or running. Read by the shutdown path so a
   *  timed-out drain is reported instead of looking like a clean exit. */
  pendingTurnCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.pending;
    return total;
  }

  async waitIdle(timeoutMs: number): Promise<void> {
    // Shutdown barrier: no new turn may start while we drain.
    this.closed = true;
    const chains = [
      ...[...this.queues.values()].map((queue) => queue.chain.catch(() => {})),
      // Commands create sessions outside the queue; those must drain too.
      ...[...this.sessionCreations.values()].map((creation) => creation.then(() => {}).catch(() => {})),
    ];
    if (chains.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.all(chains), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Runs an `exec`-type custom command: `{args}` is replaced with a
   * shell-quoted argument (or appended), the working directory stays inside
   * the line workDir, and output is bounded.
   */
  private async runCustomExec(command: LineCustomCommand, arg: string): Promise<string> {
    const script = command.exec ?? '';
    if (script.trim().length === 0) return '命令未配置 exec。';
    const workDir = resolve(this.options.workDir ?? process.cwd());
    let cwd = workDir;
    if (command.workDir !== undefined && command.workDir.trim().length > 0) {
      const candidate = resolve(workDir, command.workDir);
      const lexical = relative(workDir, candidate);
      if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
        return `工作目录越界：${command.workDir}`;
      }
      // realpath on both sides: a symlinked subdirectory must not smuggle the
      // command outside the sandbox (same rule as the media tool).
      try {
        const [realWork, realCandidate] = await Promise.all([realpath(workDir), realpath(candidate)]);
        const rel = relative(realWork, realCandidate);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          return `工作目录越界：${command.workDir}`;
        }
        cwd = realCandidate;
      } catch {
        return `工作目录不可用：${command.workDir}`;
      }
    }
    // cmd.exe has no safe quoting for arbitrary values, so Windows users pass
    // arguments through %LINE_ARGS% instead of a placeholder — no string is
    // ever interpolated into the command line there.
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      if (script.includes('{args}')) {
        return 'Windows 下自定义命令不支持 {args} 占位符，请改用环境变量 %LINE_ARGS%。';
      }
      // cmd expands %LINE_ARGS% into the command line *before* parsing it, so
      // shell metacharacters in the argument would chain a second command.
      if (/[&|<>^"%\r\n]/.test(arg)) {
        return '参数包含 Windows 命令解释器保留字符（& | < > ^ " %），已拒绝执行。';
      }
    }
    const quotedArg = shellQuote(arg);
    const finalScript = isWindows
      ? script
      : script.includes('{args}')
        ? // Function replacement: a string replacement would interpret `$&`,
          // `$'` etc. inside the user's argument.
          script.replaceAll('{args}', () => quotedArg)
        : arg.trim().length > 0
          ? `${script} ${quotedArg}`
          : script;
    try {
      const isWin = process.platform === 'win32';
      const shell = isWin ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh';
      // cmd.exe has no `\"` escape: hand it one fully quoted line, verbatim
      // (the project convention for cmd invocations).
      const shellArgs = isWin ? ['/d', '/s', '/c', `"${finalScript}"`] : ['-c', finalScript];
      const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
        windowsVerbatimArguments: isWin,
        cwd,
        timeout: CUSTOM_COMMAND_TIMEOUT_MS,
        maxBuffer: CUSTOM_COMMAND_MAX_BUFFER,
        env: { ...process.env, LINE_ARGS: arg },
      });
      const combined = `${stdout}${stderr}`.trim();
      if (combined.length === 0) return '（无输出）';
      return combined.length > CUSTOM_COMMAND_OUTPUT_LIMIT
        ? `${combined.slice(0, CUSTOM_COMMAND_OUTPUT_LIMIT)}…`
        : combined;
    } catch (error) {
      return `命令执行失败：${describeToolError(error)}`;
    }
  }

  /** Registers the channel's outbound-media sender for one chat. */
  /** Wired once by the daemon after the platforms are up. */
  setProactiveSender(
    sender: (sessionKey: string, text: string) => Promise<ProactiveDelivery>,
  ): void {
    this.proactiveSender = sender;
  }

  /**
   * Watches one session for `cron.fired`.
   *
   * A scheduled task runs inside the session, not through `submit()`, so this
   * subscription is the only path that carries its output back to the chat.
   */
  private attachCronForwarder(sessionKey: string, session: Session): void {
    this.stopCronForwarder(sessionKey);
    const relay = new CronRelay({
      send: (text) => this.proactiveSender?.(sessionKey, text) ?? Promise.resolve('no-target'),
      // Per chat: another chat's running turn says nothing about this one, and
      // treating it as busy would drop this chat's scheduled result outright.
      isBusy: () => this.activeTurns.has(sessionKey),
    });
    // The core emits `turn.started` *before* `cron.fired` because `steer()`
    // launches the turn synchronously. Keep the latest start so the relay can
    // replay it and actually collect that turn's text.
    let pendingStart: SdkEvent | undefined;
    // A cron turn the relay is not collecting — `mute`, or a fire that was
    // dropped — is still a running turn of this chat: `/stop` must see it, or
    // it answers "nothing is running" while the task keeps working.
    let cronTurnId: number | undefined;
    const unsubscribe = session.onEvent((event) => {
      if (event.type === 'turn.started') {
        pendingStart = event;
        // Only the main agent's turns describe what `/stop` can abort; a
        // subagent starting mid-task must not clear the owner's turn.
        if (event.agentId === 'main') {
          cronTurnId = event.origin.kind === 'cron_job' ? event.turnId : undefined;
        }
        relay.onEvent(event);
        return;
      }
      if (event.type === 'turn.ended') {
        pendingStart = undefined;
        if (event.turnId === cronTurnId) cronTurnId = undefined;
        relay.onEvent(event);
        return;
      }
      if (event.type === 'cron.fired') {
        if (event.agentId !== 'main') return;
        // `mute`: the task exists for its side effect — say nothing at all.
        if (event.origin.mute === true) return;
        relay.onFire(
          event.origin.silent === true ? null : buildCronReminderChip(event).text,
          pendingStart,
          event.origin.silent === true ? undefined : buildCronFailureNotice(event),
        );
        return;
      }
      relay.onEvent(event);
    });
    this.cronForwarders.set(sessionKey, {
      unsubscribe,
      relay,
      isCronTurnRunning: () => cronTurnId !== undefined,
    });
  }

  private stopCronForwarder(sessionKey: string): void {
    const entry = this.cronForwarders.get(sessionKey);
    if (entry === undefined) return;
    entry.unsubscribe();
    entry.relay.dispose();
    this.cronForwarders.delete(sessionKey);
  }

  /** Wired once by the daemon; covers sessions whose per-message sender is gone
   *  (scheduled tasks, after `/stop`, after a restart). */
  setMediaSenderResolver(resolver: (sessionKey: string) => LineMediaSender | undefined): void {
    this.mediaSenderResolver = resolver;
  }

  setMediaSender(sessionKey: string, sender: LineMediaSender): void {
    this.mediaSenders.set(sessionKey, sender);
  }

  // ─── Commands, session resolution and channel context ───────────────────

  /** Runs a bridge command; returns `{handled:false}` for unknown commands. */
  private async runCommand(sessionKey: string, text: string): Promise<LineCommandResult> {
    if (!this.harness) return { handled: true, text: 'line 守护进程未初始化' };
    return runLineCommand(text, {
      defaultModel: this.defaultModel,
      // A fired scheduled task runs as a turn of this chat too, but outside the
      // queue; without it a `/new` or `/compact` would tear down or compact the
      // context under a running task.
      isBusy: () =>
        (this.queues.get(sessionKey)?.pending ?? 0) > 0 ||
        (this.cronForwarders.get(sessionKey)?.relay.isCollecting() ?? false),
      // Only the turn of *this* chat is interruptible from this chat.
      stopTurn: () => this.stopActiveTurn(sessionKey),
      cancelSession: () => this.cancelSession(sessionKey),
      voiceStatus: describeVoiceSupport(this.voiceSupport),
      getSession: () => this.resolveSession(sessionKey),
      resetSession: () => this.resetSession(sessionKey),
      commands: this.options.commands ?? [],
      runExec: (command, arg) => this.runCustomExec(command, arg),
    });
  }

  /**
   * Live session for this chat, created/resumed on first use.
   *
   * Commands are answered outside the per-session queue, so a `/status` can
   * arrive while the first turn is still creating the session: both paths share
   * one in-flight promise instead of racing into two Session objects.
   */
  private async resolveSession(sessionKey: string): Promise<Session> {
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) return existing;
    const pending = this.sessionCreations.get(sessionKey);
    if (pending !== undefined) return pending;
    return this.withLifecycleLock(sessionKey, async () => {
      // Re-check inside the lock: a reset may have run while we waited.
      const inside = this.sessions.get(sessionKey);
      if (inside !== undefined) return inside;
      const creation = this.createSessionFor(sessionKey).finally(() => {
        this.sessionCreations.delete(sessionKey);
      });
      this.sessionCreations.set(sessionKey, creation);
      return creation;
    });
  }

  /**
   * Serializes session creation against `/new` for one chat. Without it a turn
   * starting at the same moment as a reset could have its fresh session deleted
   * by the reset's `deleteSession`.
   */
  private async withLifecycleLock<T>(sessionKey: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleLocks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored = previous.then(() => gate);
    this.lifecycleLocks.set(sessionKey, stored);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.lifecycleLocks.get(sessionKey) === stored) {
        this.lifecycleLocks.delete(sessionKey);
      }
    }
  }

  private async createSessionFor(sessionKey: string): Promise<Session> {
    const harness = this.harness;
    if (!harness) throw new Error('LineSessionDriver 未初始化');
    const workDir = this.options.workDir ?? process.cwd();
    const { permission, planMode } = mapStreamJsonMode(this.options.permissionMode);
    const session = await this.getOrCreateSession(harness, sessionKey, workDir, permission, planMode);
    this.sessions.set(sessionKey, session);
    this.sessionKeyBySessionId.set(session.id, sessionKey);
    this.attachCronForwarder(sessionKey, session);
    await this.applyChannelPrompt(session);
    return session;
  }

  /** Drops the chat's session so the next message starts a fresh one. */
  private async resetSession(sessionKey: string): Promise<void> {
    // Any message that lands during the reset gets a "try again" reply instead
    // of starting a turn on a session this reset is about to delete.
    this.resetting.add(sessionKey);
    // The old session is about to be replaced: stop forwarding its fires.
    this.stopCronForwarder(sessionKey);
    try {
      // Let the running turn finish first: deleting storage underneath it would
      // lose that turn's history.
      const queue = this.queues.get(sessionKey);
      if (queue !== undefined) {
        await queue.chain.catch(() => {});
        if (queue.pending > 0) {
          throw new Error('有新的任务已开始，请稍后再试。');
        }
      }
      await this.withLifecycleLock(sessionKey, async () => {
        // Re-read the live queue: a turn may have been enqueued after the
        // `pending` check above but before the lock was granted.
        const live = this.queues.get(sessionKey);
        if (live !== undefined && live.pending > 0) {
          throw new Error('有新的任务已开始，请稍后再试。');
        }
        // A creation may have been in flight before the queue drained.
        const pending = this.sessionCreations.get(sessionKey);
        if (pending !== undefined) await pending.catch(() => {});
        const session = this.sessions.get(sessionKey);
        this.sessions.delete(sessionKey);
        if (session !== undefined) {
          // Drop the reverse mappings: a stale sessionId must not resolve to
          // this chat, and the sender is re-registered on the next dispatch.
          this.sessionKeyBySessionId.delete(session.id);
          await session.close({ extractMemories: false }).catch(() => {});
        }
        this.mediaSenders.delete(sessionKey);
        await this.harness?.deleteSession(sessionKey).catch(() => {});
      });
    } finally {
      this.resetting.delete(sessionKey);
    }
  }

  /** Tells the model which channel it is on and registers the media tool. */
  private async applyChannelPrompt(session: Session): Promise<void> {
    if (this.promptedSessions.has(session)) return;
    await session.setRuntimeSystemPrompt({ append: buildChannelPrompt(this.options.platform) });
    // Only after the prompt landed: a rejected call must be retried by the next
    // resolveSession instead of leaving the chat permanently unaware.
    this.promptedSessions.add(session);
    await session
      .registerTool({
        name: LINE_SEND_MEDIA_TOOL,
        description:
          'Send a local image or file back to the user on this IM channel. Use it when the user asks to see a file or picture you produced. Only files inside the working directory can be sent; there is no screenshot ability.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file, inside the working directory.' },
            kind: {
              type: 'string',
              enum: ['image', 'file', 'audio'],
              description:
                'Optional; inferred from the extension. `audio` sends a WeChat voice bubble (transcoded to AMR; needs ffmpeg), otherwise the file.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      })
      .catch(() => {
        // A failed registration must not block the chat: the model simply has
        // no media tool in this session.
      });
  }

  /** Host tool dispatch for `line_send_media`. */
  private async handleHostToolCall(request: ToolCallRequest): Promise<ToolCallResponse> {
    const toolName = request.name ?? '';
    if (toolName !== LINE_SEND_MEDIA_TOOL) {
      return { output: `未知的宿主工具：${toolName}`, isError: true };
    }
    const sessionKey =
      request.sessionId === undefined ? undefined : this.sessionKeyBySessionId.get(request.sessionId);
    const sender =
      sessionKey === undefined
        ? undefined
        : (this.mediaSenders.get(sessionKey) ?? this.mediaSenderResolver?.(sessionKey));
    if (sender === undefined) {
      return { output: '当前会话没有可用的发送通道（该工具仅在 IM 会话中可用）。', isError: true };
    }
    const args = parseSendMediaArgs(request.args);
    if (args === null) {
      return { output: '参数无效：需要 {"path": "<工作目录内的文件>"}', isError: true };
    }
    const resolved = await this.resolveOutboundPath(args.path, args.kind);
    if ('error' in resolved) return { output: resolved.error, isError: true };
    try {
      const note = await sender(resolved.kind, resolved.path);
      const label = resolved.kind === 'voice' ? '语音' : resolved.kind === 'image' ? '图片' : '文件';
      return { output: `已发送${label} ${basename(resolved.path)}${typeof note === 'string' ? note : ''}` };
    } catch (error) {
      return { output: `发送失败：${describeToolError(error)}`, isError: true };
    }
  }

  /**
   * Resolves and validates an outbound path: inside the working directory,
   * existing, a regular file, and under the size cap. Symlinks are resolved
   * first so a link cannot smuggle a path from outside the sandbox.
   */
  private async resolveOutboundPath(
    rawPath: string,
    explicitKind: 'image' | 'file' | 'audio' | undefined,
  ): Promise<{ kind: 'image' | 'file' | 'voice'; path: string } | { error: string }> {
    const workDir = resolve(this.options.workDir ?? process.cwd());
    const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workDir, rawPath);
    let real: string;
    let realWorkDir: string;
    try {
      real = await realpath(candidate);
      realWorkDir = await realpath(workDir);
    } catch {
      return { error: `文件不存在：${rawPath}` };
    }
    const rel = relative(realWorkDir, real);
    // `..notes.png` is a legal file name inside the sandbox; only a real parent
    // segment escapes it.
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { error: '只允许发送工作目录内的文件。' };
    }
    const info = await stat(real).catch(() => null);
    if (info === null || !info.isFile()) return { error: `不是普通文件：${rawPath}` };
    if (info.size > MAX_OUTBOUND_MEDIA_BYTES) {
      return { error: `文件过大（${info.size} 字节），上限 ${MAX_OUTBOUND_MEDIA_BYTES}。` };
    }
    return { kind: toSenderKind(explicitKind) ?? inferMediaKind(real), path: real };
  }

  // ─── Session lifecycle (port of run-stream-json repair path) ────────────

  private async getOrCreateSession(
    harness: ScreamHarness,
    sessionKey: string,
    workDir: string,
    permission: MappedMode['permission'],
    planMode: MappedMode['planMode'],
  ): Promise<Session> {
    const existing = await harness.listSessions({ sessionId: sessionKey, workDir });
    if (existing.length > 0) {
      try {
        const session = await harness.resumeSession({ id: sessionKey });
        log.info('line: resumed session', { sessionKey, sessionId: session.id });
        return session;
      } catch (error) {
        // Inconsistent state: directory without index entry, or a stale index
        // entry pointing to a missing directory. Clean up BOTH before
        // createSession (port of run-stream-json L676-712).
        log.warn('line: resume failed, repairing session', { sessionKey, error: String(error) });
        await harness.deleteSession(sessionKey).catch(() => {});
        const orphanDir = existing[0]?.sessionDir;
        if (orphanDir) {
          await rm(orphanDir, { recursive: true, force: true }).catch(() => {});
        }
        return this.createSessionRepaired(harness, sessionKey, workDir, permission, planMode);
      }
    }
    return this.createSessionRepaired(harness, sessionKey, workDir, permission, planMode);
  }

  /**
   * createSession with a one-shot repair: when creation fails (e.g. the id
   * already exists in another workDir after a platform switch, or a corrupt
   * index), delete the stale entry and retry once. Without this, a wedged
   * session id would fail every future message.
   */
  private async createSessionRepaired(
    harness: ScreamHarness,
    sessionKey: string,
    workDir: string,
    permission: MappedMode['permission'],
    planMode: MappedMode['planMode'],
  ): Promise<Session> {
    try {
      return await this.createSession(harness, sessionKey, workDir, permission, planMode);
    } catch (error) {
      log.warn('line: create failed, repairing before retry', { sessionKey, error: String(error) });
      await harness.deleteSession(sessionKey).catch(() => {});
      return this.createSession(harness, sessionKey, workDir, permission, planMode);
    }
  }

  private async createSession(
    harness: ScreamHarness,
    sessionKey: string,
    workDir: string,
    permission: MappedMode['permission'],
    planMode: MappedMode['planMode'],
  ): Promise<Session> {
    const session = await harness.createSession({
      id: sessionKey,
      workDir,
      model: this.options.model ?? this.defaultModel,
      permission,
      planMode,
      metadata: { source: 'line', agentType: 'scream-code', platform: this.options.platform },
    });
    log.info('line: created session', { sessionKey, sessionId: session.id });
    return session;
  }

  /** Unattended approval handlers (port of the stream-json yolo/dontAsk cases). */
  private applyApprovalHandler(session: Session): void {
    // `auto` is blanket-approved by the policy chain before this handler runs
    // (and it denies AskUserQuestion there), so the handler is only a fallback
    // for a mode that still asks. `dontAsk` is the deny-all escape hatch.
    if (this.options.permissionMode === 'dontAsk') {
      session.setApprovalHandler(() => ({
        decision: 'rejected',
        feedback: 'dontAsk mode: tool call auto-denied',
      }));
      return;
    }
    // yolo (the only other allowed mode) — approve everything.
    session.setApprovalHandler(() => ({ decision: 'approved' }));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Map provider error codes to friendly chat text (port of stream-json codes). */
export function friendlyProviderError(code: string, message: string): string {
  if (
    code === 'provider.auth_error' ||
    code === 'provider.rate_limit' ||
    code === 'provider.api_error' ||
    code === 'provider.connection_error' ||
    code === 'provider.timeout'
  ) {
    return `模型服务暂时不可用（${code}），请稍后重试。`;
  }
  return `处理失败：${message || code}`;
}

function friendlyTurnError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return `处理失败：${msg}`;
}

/**
 * Builds the prompt from text plus inbound attachments.
 *
 * Images travel as `image_url` data URLs: the kernel and every provider adapter
 * already understand that part, so no new content type is needed. Files are
 * already on disk, so the model only gets their paths and opens them with its
 * own tools (ReadMediaFile for images, Read for text).
 */
function buildPromptParts(job: LineTurnJob): PromptPart[] {
  const parts: PromptPart[] = [];
  if (job.text.trim().length > 0) parts.push({ type: 'text', text: job.text });
  for (const image of job.images ?? []) {
    parts.push({
      type: 'image_url',
      imageUrl: { url: `data:${image.mime};base64,${image.data.toString('base64')}` },
    });
  }
  const files = job.files ?? [];
  if (files.length > 0) {
    parts.push({
      type: 'text',
      text: `附件已保存到本机，需要时用工具查看：\n${files.map((f) => `- ${f}`).join('\n')}`,
    });
  }
  // A turn always needs at least one part; an empty text part keeps the IM
  // behaviour of "one message = one turn" when only an attachment arrived.
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

/** Parses `line_send_media` arguments without trusting the model's JSON shape. */
function parseSendMediaArgs(
  raw: unknown,
): { path: string; kind: 'image' | 'file' | 'audio' | undefined } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const path = record['path'];
  if (typeof path !== 'string' || path.trim().length === 0) return null;
  const kind = record['kind'];
  if (kind !== undefined && kind !== 'image' && kind !== 'file' && kind !== 'audio') return null;
  return { path: path.trim(), kind };
}

const AUDIO_EXTENSIONS = /\.(amr|wav|mp3|m4a|aac|ogg|oga|opus|silk|flac)$/i;

/** Extension-based default; the explicit `kind` argument wins when provided. */
function inferMediaKind(path: string): 'image' | 'file' | 'voice' {
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) return 'image';
  if (AUDIO_EXTENSIONS.test(path)) return 'voice';
  return 'file';
}

/** Tool vocabulary (`audio`) → sender vocabulary (`voice`). */
function toSenderKind(
  kind: 'image' | 'file' | 'audio' | undefined,
): 'image' | 'file' | 'voice' | undefined {
  if (kind === undefined) return undefined;
  return kind === 'audio' ? 'voice' : kind;
}

function describeToolError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}
