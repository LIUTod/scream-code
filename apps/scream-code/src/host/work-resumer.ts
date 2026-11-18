/**
 * Continues work that should not stop just because the process running it
 * did: a goal or a bot-mode run interrupted by a crash, a shutdown or a power
 * cut, and a session a terminal handed to the background on exit.
 *
 * The register (`listRunningWork`) says which sessions had a turn in flight;
 * the session lock says whether any process still runs it. A record whose
 * session no process holds is work that stopped. The resumer opens that
 * session here (taking its lock, so nothing else can open it meanwhile), drops
 * the old record (the new turn writes its own), and sends one prompt that says
 * the run was interrupted and should continue; an active goal then drives
 * itself as it always does. When the turn ends the session is closed again, so
 * a terminal can open it normally.
 *
 * A plain conversation interrupted mid-turn is not continued behind the
 * person's back: its record stays for the next open to mention, and is
 * forgotten after a week. A chat channel's session is continued through the
 * channel, so the result reaches the chat.
 */

import {
  listRunningWork,
  log,
  removeRunningWork,
  sessionLockHolder,
  type RunningWorkRecord,
  type ScreamHarness,
  type Session,
} from '@scream-code/scream-code-sdk';

import { runPromptToEnd } from './run-to-end';
import { readUsage, usageTokens } from './usage';

/** How often the register is read while the host runs. */
export const WORK_SWEEP_INTERVAL_MS = 30_000;
/** A plain conversation's interrupted-turn record is kept this long for the next open. */
const STALE_CHAT_RECORD_MS = 7 * 24 * 60 * 60 * 1000;
/** Chat-channel sessions are keyed `line-<platform>-<hash>`. */
const CHANNEL_SESSION_PREFIX = 'line-';
/** Background-task runs (see `job-runner.ts`): rerun by their job, never continued here. */
const JOB_RUN_SESSION_PREFIX = 'job-run-';

export interface WorkResumerOptions {
  readonly harness: ScreamHarness;
  readonly screamHomeDir: string;
  /** The prompt that continues an interrupted run (localized by the caller). */
  readonly continuationText: string;
  /**
   * Continues a chat-channel session through its channel, so the reply is
   * delivered to the chat. Undefined while no channel runs: such sessions are
   * then left for the channel to pick up when it starts.
   */
  readonly continueChannelSession?: ((sessionId: string, text: string) => Promise<void>) | undefined;
  /** Told when a session is continued, with its title (for the log, a push). */
  readonly onContinued?: ((record: RunningWorkRecord, title: string | undefined) => void) | undefined;
  /** Told when continued work is done (or failed, or hit its deadline), with its last answer. */
  readonly onFinished?:
    | ((record: RunningWorkRecord, title: string | undefined, result: { ok: boolean; text: string }) => void)
    | undefined;
  readonly now?: () => number;
  /** How long after a turn ends with none following the run counts as done (default 2 s). */
  readonly settleMs?: number;
  /** Today's unattended-work token limit is reached: continue nothing. */
  readonly budgetReached?: (() => boolean) | undefined;
  /** A continued run's tokens, for the daily total. */
  readonly recordUsage?: ((tokens: number) => void) | undefined;
}

export class WorkResumer {
  private readonly inFlight = new Set<string>();
  /** Sessions this resumer has open right now, by id. */
  private readonly open = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<number> | undefined;
  private stopped = false;

  constructor(private readonly options: WorkResumerOptions) {}

  /** Sweep now, then every {@link WORK_SWEEP_INTERVAL_MS}. */
  start(intervalMs: number = WORK_SWEEP_INTERVAL_MS): void {
    void this.sweep();
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Mark every session this resumer is running as handed over, so closing
   * them (a host shutdown) keeps their running-work records and the next host
   * continues them.
   */
  async handOffAll(): Promise<void> {
    for (const session of this.open.values()) {
      await session.handOff().catch(() => {});
    }
  }

  /** Stop the turns this resumer is running (the sessions stay, nothing continues them). */
  async cancelAll(): Promise<void> {
    for (const session of this.open.values()) {
      await session.cancel().catch(() => {});
    }
  }

  /** Close every session this resumer has open. */
  async closeAll(): Promise<void> {
    const sessions = Array.from(this.open.values());
    this.open.clear();
    for (const session of sessions) {
      await session.close({ unattended: true }).catch(() => {});
    }
  }

  /** Sessions a terminal took back from this resumer: their run ending is not a failure. */
  private readonly handedOver = new Set<string>();

  /** A terminal is taking `sessionId` over (the session handover handler said yes). */
  noteHandedOver(sessionId: string): void {
    if (this.open.has(sessionId)) this.handedOver.add(sessionId);
  }

  /** Whether some continued work is still running here. */
  busy(): boolean {
    return this.inFlight.size > 0;
  }

  /**
   * Look for stopped work once and start continuing it. Resolves with how many
   * sessions were started; their turns run on in the background.
   */
  sweep(): Promise<number> {
    if (this.sweeping !== undefined) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<number> {
    if (this.stopped) return 0;
    if (this.options.budgetReached?.() === true) return 0;
    const now = (this.options.now ?? Date.now)();
    let started = 0;
    for (const record of listRunningWork(this.options.screamHomeDir)) {
      if (this.stopped) break;
      if (this.inFlight.has(record.sessionId)) continue;
      if (record.sessionId.startsWith(JOB_RUN_SESSION_PREFIX)) {
        const holder = await sessionLockHolder(this.options.screamHomeDir, record.sessionId).catch(() => undefined);
        if (holder === undefined) removeRunningWork(this.options.screamHomeDir, record.sessionId);
        continue;
      }
      if (!continuesOnItsOwn(record)) {
        if (now - record.startedAt > STALE_CHAT_RECORD_MS) {
          removeRunningWork(this.options.screamHomeDir, record.sessionId);
        }
        continue;
      }
      let holder: Awaited<ReturnType<typeof sessionLockHolder>>;
      try {
        holder = await sessionLockHolder(this.options.screamHomeDir, record.sessionId);
      } catch {
        continue;
      }
      if (holder !== undefined) continue; // some process runs it right now
      if (record.sessionId.startsWith(CHANNEL_SESSION_PREFIX) && this.options.continueChannelSession === undefined) {
        continue;
      }
      this.inFlight.add(record.sessionId);
      started += 1;
      void this.continueWork(record)
        .catch((error: unknown) => {
          log.warn('host: continuing interrupted work failed', {
            sessionId: record.sessionId,
            error: String(error),
          });
        })
        .finally(() => {
          this.inFlight.delete(record.sessionId);
        });
    }
    return started;
  }

  private async continueWork(record: RunningWorkRecord): Promise<void> {
    const { harness, screamHomeDir, continuationText } = this.options;
    if (record.sessionId.startsWith(CHANNEL_SESSION_PREFIX)) {
      removeRunningWork(screamHomeDir, record.sessionId);
      this.options.onContinued?.(record, undefined);
      await this.options.continueChannelSession?.(record.sessionId, continuationText);
      return;
    }
    let session: Session;
    try {
      session = await harness.resumeSession({ id: record.sessionId });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'session.in_use') return; // taken meanwhile; its holder runs it
      if (code === 'session.not_found') {
        removeRunningWork(screamHomeDir, record.sessionId);
        return;
      }
      throw error;
    }
    this.open.set(record.sessionId, session);
    // A resumed session reports its lifetime usage (the wire is replayed);
    // only what this continuation spends counts towards today's limit.
    const usedBefore = usageTokens(await readUsage(session));
    try {
      removeRunningWork(screamHomeDir, record.sessionId);
      // Reopening a session pauses its active goal ("paused after agent
      // resume"), and a cancelled turn may have paused it too. The goal was
      // running when the work stopped, so drive it again: otherwise the
      // continuation is one plain turn and the goal never finishes. A goal
      // that is blocked waits for the person and is left as it is.
      if (record.kind === 'goal') {
        try {
          const current = (await session.getGoal()).goal;
          if (current?.status === 'paused') await session.updateGoalStatus('active');
        } catch {
          // The continuation still runs; it is just one turn.
        }
      }
      this.options.onContinued?.(record, session.summary?.title);
      const result = await runPromptToEnd(session, continuationText, { settleMs: this.options.settleMs ?? 2_000 });
      // Taken back by a terminal: the person carries on there; nothing stopped.
      if (!this.handedOver.delete(record.sessionId)) this.options.onFinished?.(record, session.summary?.title, result);
    } finally {
      this.open.delete(record.sessionId);
      const usage = await readUsage(session);
      this.options.recordUsage?.(Math.max(0, usageTokens(usage) - usedBefore));
      await session.close({ unattended: true }).catch(() => {});
    }
  }
}

/** An active goal, a bot-mode run and a handed-off session continue without the person. */
function continuesOnItsOwn(record: RunningWorkRecord): boolean {
  return record.handoff === true || record.kind === 'goal' || record.kind === 'bot';
}

/**
 * Send `text` and wait until the session's main agent has no turn running. An
 * active goal runs several turns back to back inside one prompt, so this
 * waits for the last `turn.ended` with no new `turn.started` after it.
 */
