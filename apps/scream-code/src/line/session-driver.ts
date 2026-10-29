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

import { rm } from 'node:fs/promises';

import {
  ScreamHarness,
  isOrphanedToolCallError,
  log,
  resolveScreamHome,
  type Event,
  type Session,
} from '@scream-code/scream-code-sdk';

import { mapCcConnectMode } from '#/cli/run-stream-json';
import { createScreamCodeHostIdentity } from '#/cli/version';

const MAX_QUEUE_PER_SESSION = 3;
const ORPHAN_RESET_NOTICE = '会话已自动重置，请重新发送你的消息。';

/**
 * Collects the final content output of one turn from the session event
 * stream (main agent only).
 *
 * Remote-channel reply policy: thinking deltas are a separate event type and
 * never accumulate; intermediate assistant narration BEFORE a tool call is
 * discarded — the IM reply carries only the content that follows the last
 * tool call, i.e. the final answer (the reference parity: it forwards progress
 * for display, but the "reply" is the completion text).
 */
export class LineTurnCollector {
  text = '';
  failure: { code: string; message: string } | undefined;
  ended: 'completed' | 'cancelled' | 'failed' | undefined;
  stepBudgetExhausted = false;
  private activeTurnId: number | undefined;
  private activeAgentId: string | undefined;
  private resolveTurn: () => void;

  constructor(onTurnSettled: () => void) {
    this.resolveTurn = onTurnSettled;
  }

  handleEvent(event: Event): void {
    if (event.type === 'error') {
      if (event.agentId !== 'main') return;
      this.failure = { code: event.code, message: event.message };
      this.resolveTurn();
      return;
    }
    if (event.type === 'turn.started') {
      if (this.activeTurnId !== undefined) return;
      this.activeTurnId = event.turnId;
      this.activeAgentId = event.agentId;
      return;
    }
    if (
      this.activeTurnId === undefined ||
      this.activeAgentId === undefined ||
      !('turnId' in event) ||
      event.turnId !== this.activeTurnId ||
      event.agentId !== this.activeAgentId
    ) {
      return;
    }
    if (event.type === 'tool.call.started' || event.type === 'tool.call.delta') {
      // Drop narration emitted before the tool call.
      this.text = '';
      return;
    }
    if (event.type === 'assistant.delta') {
      this.text += event.delta;
      return;
    }
    if (event.type === 'turn.ended') {
      this.ended = event.reason;
      if (event.reason === 'completed' && event.stepBudgetExhausted === true) {
        this.stepBudgetExhausted = true;
      }
      this.resolveTurn();
    }
  }
}

export interface TurnOutcome {
  ok: boolean;
  text: string;
}

export interface LineSessionDriverOptions {
  permissionMode: 'yolo' | 'dontAsk';
  /** Session working directory (default: daemon start cwd). */
  workDir?: string;
  /** Session model (default: config.defaultModel). */
  model?: string;
  /** Channel platform — recorded in session metadata for the picker badge. */
  platform: 'feishu' | 'weixin';
}

interface SessionQueue {
  chain: Promise<void>;
  pending: number;
}

type MappedMode = ReturnType<typeof mapCcConnectMode>;

export class LineSessionDriver {
  private harness: ScreamHarness | undefined;
  private defaultModel = '';
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, SessionQueue>();
  private closed = false;

  constructor(private readonly options: LineSessionDriverOptions) {}

  async init(): Promise<void> {
    const harness = new ScreamHarness({
      homeDir: resolveScreamHome(),
      identity: createScreamCodeHostIdentity(),
      uiMode: 'print',
    });
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    this.defaultModel = config.defaultModel ?? '';
    this.harness = harness;
  }

  /**
   * Submit a turn on the session for `sessionKey`. Serialized per session;
   * resolves with the turn outcome (final text or a friendly error).
   */
  async submit(job: { sessionKey: string; text: string }): Promise<TurnOutcome> {
    if (this.closed) {
      return { ok: false, text: 'line 守护进程正在关闭，请稍后再试。' };
    }
    if (!this.harness) {
      throw new Error('LineSessionDriver 未初始化');
    }
    const queue = this.queues.get(job.sessionKey) ?? { chain: Promise.resolve(), pending: 0 };
    if (queue.pending >= MAX_QUEUE_PER_SESSION) {
      log.warn('line: session queue full, replying busy', { sessionKey: job.sessionKey });
      return { ok: false, text: '上一条消息还在处理中，队列已满，请稍后再发。' };
    }
    queue.pending += 1;
    this.queues.set(job.sessionKey, queue);

    let outcome!: TurnOutcome;
    const next = queue.chain.then(async () => {
      try {
        outcome = await this.runTurn(job);
      } catch (error) {
        // Last-resort guard: every submitted message must get a reply.
        log.error('line: turn crashed unexpectedly', { sessionKey: job.sessionKey, error: String(error) });
        outcome = { ok: false, text: friendlyTurnError(error) };
      }
    });
    queue.chain = next.catch(() => {}); // never let the chain reject
    await next.finally(() => {
      queue.pending -= 1;
      if (queue.pending === 0 && this.queues.get(job.sessionKey) === queue) {
        this.queues.delete(job.sessionKey);
      }
    });
    return outcome;
  }

  /** Close all sessions and the harness (daemon shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await session.close().catch(() => {});
    }
    await this.harness?.close().catch(() => {});
    this.harness = undefined;
  }

  // ─── Turn execution (port of run-stream-json event collection) ──────────

  private async runTurn(job: { sessionKey: string; text: string }): Promise<TurnOutcome> {
    const harness = this.harness;
    if (!harness) return { ok: false, text: 'line 守护进程未初始化' };
    const workDir = this.options.workDir ?? process.cwd();
    const { permission, planMode } = mapCcConnectMode(this.options.permissionMode);

    let session = this.sessions.get(job.sessionKey);
    if (!session) {
      session = await this.getOrCreateSession(harness, job.sessionKey, workDir, permission, planMode);
      this.sessions.set(job.sessionKey, session);
    }
    this.applyApprovalHandler(session);
    session.setQuestionHandler(() => null);

    // Collect the final content output for this turn via the collector
    // (thinking excluded; narration before tool calls discarded).
    let promptError: unknown;
    let resolveTurn!: () => void;
    const turnPromise = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const collector = new LineTurnCollector(resolveTurn);

    const unsubscribe = session.onEvent((event) => {
      collector.handleEvent(event);
    });

    try {
      session
        .prompt(job.text)
        .catch((error: unknown) => {
          promptError = error;
          // Without an error event the turn never ends — resolve so we can
          // surface the prompt failure below instead of hanging.
          resolveTurn();
        });
      await turnPromise;
    } finally {
      unsubscribe();
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
