/**
 * The background host (`scream host`; `scream line` is the same process).
 *
 * One host runs per Scream home (its process lock guarantees it). It
 *
 * - serves the Feishu/WeChat channel when one is configured: per message,
 *   platform receive pipeline → session driver turn → reply (feishu:
 *   text/post-md + receipt reactions; weixin: chunked text + typing indicator),
 *   all platform-specific behavior in the platform modules;
 * - continues work that stopped without finishing — a goal or a bot-mode run
 *   cut off by a crash, a shutdown or a power loss, and sessions a terminal
 *   handed over on exit (`WorkResumer`);
 * - lets a terminal take a session it is continuing back (the session lock's
 *   `handover` request).
 *
 * Boot: load the channel config (optional) → take the host lock → open the SDK
 * harness → start the configured platform → start the work resumer. Without a
 * channel and without being installed as a service, the host exits once it has
 * had nothing to do for a while, so starting it for one handoff does not leave
 * a process behind for good.
 */

import { setInterval as setRepeating } from 'node:timers';

import { t } from '@scream-code/config';
import {
  JobStore,
  listInbox,
  listRunningWork,
  snapshotEvolution,
  log,
  resolveScreamHome,
  sessionLockHolder,
  ScreamHarness,
  type Session,
  type ToolCallRequest,
  type ToolCallResponse,
} from '@scream-code/scream-code-sdk';

import { createScreamCodeHostIdentity, getVersion } from '#/cli/version';
import { createChannelDriver, startChannel, type PlatformHandle } from '#/line/channel';
import { assertSinglePlatformConfig, loadLineConfig, type LineConfig } from '#/line/config';
import type { LineSessionDriver } from '#/line/session-driver';

import {
  claimHostLock,
  getHostDir,
  HOST_SHUTDOWN_GRACE_MS,
  hostStopRequestedSince,
  rotateHostLogIfNeeded,
} from './control';
import { CRASH_LIMIT, CRASH_WINDOW_MS, hostStartsFile, markHostStartClean, recordHostStart } from './host-starts';
import { hostErr as err, hostOut as out } from './log';
import { appendActivity, readActivitySince } from './activity';
import { notifyDesktop } from './desktop-notify';
import { InboxProcessor } from './inbox-processor';
import { isSelfReviewJob, selfReviewContext } from './self-review';
import { releaseHeldWorktree } from './worktree';
import { briefHasNothingToReport, JOB_RUN_SESSION_PREFIX, jobIdOfRunSession, JobRunner } from './job-runner';
import { KeepAwake } from './keep-awake';
import { pauseAllJobs } from './pause-all';
import { readHostSettings } from './settings';
import { addHostTokens, hostBudgetReached } from './usage';
import { inboxNotice, isBriefJob } from '#/line/background-commands';
import { WorkResumer } from './work-resumer';
import {
  formatReminder,
  parseTerminalReminder,
  reminderAllowed,
  ReminderOutbox,
  ReminderSettings,
  reminderTitle,
  type Reminder,
} from './reminders';

/**
 * How long a shutdown waits for the in-flight turn to finish before forcing an
 * exit. Ten seconds used to be enough in theory but cut real turns mid-tool, so
 * the window matches a slow tool call; the wait is announced on stderr. `stop`
 * waits for this window too (see `control.ts`).
 */
const SHUTDOWN_GRACE_MS = HOST_SHUTDOWN_GRACE_MS;
/** How often the running host checks whether `host.log` needs rotating. */
const LOG_ROTATE_CHECK_MS = 10 * 60 * 1000;
/** A host with no channel and no service install exits after this long with nothing to do. */
const IDLE_EXIT_MS = 10 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;
/** How often the inbox is swept (new items pushed, answers delivered). */
const INBOX_SWEEP_MS = 15 * 1000;
/** How often the host decides whether to hold the sleep inhibitor. */
const KEEP_AWAKE_CHECK_MS = 30 * 1000;
/** A chat that cannot be reached is noted in the activity log at most this often. */
const UNDELIVERED_NOTE_EVERY_MS = 6 * 60 * 60 * 1000;


/** How often a service-launched host waiting behind a terminal's host tries the lock again. */
const LOCK_WAIT_POLL_MS = 5_000;

/**
 * Wait for the host lock a terminal's host holds, trying again every few
 * seconds (one local socket connect — nothing like the Node boot a supervisor
 * restart costs). Ends without the lock when a stop is asked for meanwhile
 * (`scream host stop` must leave the background stopped, not hand it to this
 * process), when the process is told to end, or when the holder turns out to
 * be the service's own host.
 */
export async function waitForTheLock(
  info: Readonly<Record<string, unknown>>,
  deps: {
    readonly claim?: typeof claimHostLock;
    readonly stopRequestedSince?: (since: number) => boolean;
    readonly pollMs?: number;
  } = {},
): Promise<Awaited<ReturnType<typeof claimHostLock>> | undefined> {
  const claim = deps.claim ?? claimHostLock;
  const stopRequestedSince = deps.stopRequestedSince ?? hostStopRequestedSince;
  const pollMs = deps.pollMs ?? LOCK_WAIT_POLL_MS;
  const since = Date.now();
  const state: { ended: boolean; wake: (() => void) | undefined } = { ended: false, wake: undefined };
  const end = (): void => {
    state.ended = true;
    state.wake?.();
  };
  // Sleeps one poll, or less when the process is told to end.
  const pause = (): Promise<void> =>
    new Promise<void>((resolve) => {
      state.wake = resolve;
      setTimeout(resolve, pollMs);
    });
  process.once('SIGTERM', end);
  process.once('SIGINT', end);
  log.info('host: a terminal host holds the lock; waiting to take over');
  try {
    for (;;) {
      await pause();
      if (state.ended || stopRequestedSince(since)) return undefined;
      const attempt = await claim(info);
      if (attempt.held) return attempt;
      if (attempt.holder?.info?.['service'] === true) return undefined;
    }
  } finally {
    process.off('SIGTERM', end);
    process.off('SIGINT', end);
  }
}

/** Run the host in the foreground; exits the process on shutdown. */
export async function runHost(): Promise<void> {
  // The chat channel is optional: the host also continues interrupted work.
  let lineConfig: LineConfig | undefined;
  try {
    lineConfig = (await loadLineConfig()) ?? undefined;
  } catch (error) {
    err(t('host.log.channel_config_unreadable', { error: error instanceof Error ? error.message : String(error) }));
  }
  const channelConfig =
    lineConfig !== undefined && (lineConfig.feishu !== undefined || lineConfig.weixin !== undefined)
      ? lineConfig
      : undefined;
  if (channelConfig !== undefined) {
    try {
      assertSinglePlatformConfig(channelConfig);
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
      return;
    }
  }

  // One host per Scream home: the lock is held by this process for as long as
  // it lives and released by the OS however it exits.
  const serviceLaunched = process.env['SCREAM_CODE_HOST_SERVICE'] === '1';
  const lockInfo = { kind: 'host', service: serviceLaunched, version: getVersion() } as const;
  let claimed = await claimHostLock(lockInfo);
  // "Another host is running" is the steady state, not a failure — and the
  // exit code is what the resident service reads: launchd
  // (KeepAlive.SuccessfulExit=false) and systemd (Restart=on-failure) restart a
  // non-zero exit every ten seconds, forever. That once meant one log line and
  // one Node boot per ten seconds for as long as another host lived (4908 lines
  // and 5168 spawns over two days, observed). So a service-launched host never
  // exits non-zero to retry: when a terminal's host holds the lock it waits in
  // place until that host leaves and then takes over.
  if (!claimed.held && serviceLaunched && claimed.holder?.info?.['service'] !== true) {
    claimed = (await waitForTheLock(lockInfo)) ?? claimed;
  }
  if (!claimed.held) {
    const pid = claimed.holder?.pid;
    // The service's own host holds it, or the wait ended (a stop was asked
    // for, a signal): nothing to do, and exit 0 keeps the supervisor from
    // starting another. A host started by hand or by a terminal keeps the
    // old exit 1.
    process.exitCode = serviceLaunched || claimed.holder?.info?.['service'] === true ? 0 : 1;
    // A person running `scream host run` by hand still deserves to be told; the
    // service says nothing, because it is expected and it is what spammed the log.
    if (!serviceLaunched) {
      err(t('cli.line.already_running', { pid: pid === undefined ? '?' : String(pid) }));
    }
    return;
  }
  const lock = claimed;

  // A host that keeps dying must not be restarted forever either.
  const startedAt = Date.now();
  const startsFile = hostStartsFile(getHostDir());
  const crashes = recordHostStart(startsFile, { at: startedAt, pid: process.pid });
  if (crashes >= CRASH_LIMIT) {
    err(t('host.log.crash_loop', { count: String(crashes), minutes: String(CRASH_WINDOW_MS / 60_000) }));
    appendActivity({
      kind: 'health',
      title: t('host.notify.crash_loop_title'),
      ok: false,
      detail: t('host.notify.crash_loop_body', { count: String(crashes) }),
    });
    notifyDesktop(t('host.notify.crash_loop_title'), t('host.notify.crash_loop_body', { count: String(crashes) }));
    if (serviceLaunched) {
      // Exit 0: the supervisor leaves it stopped until the next login or a
      // start from a terminal. The lock goes first: its listening socket
      // would otherwise keep this process alive, holding the lock and doing
      // nothing.
      markHostStartClean(startsFile, process.pid, startedAt);
      await lock.release().catch(() => {});
      process.exitCode = 0;
      return;
    }
  }
  let resumer: WorkResumer | undefined;
  // Declared before the lock answers requests: a request can arrive during
  // any await of the boot below.
  let keepAwakeRef: KeepAwake | undefined;
  let jobsRef: JobRunner | undefined;
  let inboxRef: InboxProcessor | undefined;
  let harnessRef: ScreamHarness | undefined;
  let outboxRef: ReminderOutbox | undefined;
  let remindRef: ((reminder: Reminder, source: 'background' | 'terminal', key: string) => Promise<boolean>) | undefined;
  let lastBusyAt = Date.now();
  // `stop` asks through the lock, so a stop is graceful on every platform (on
  // Windows a signal would end the process at once); `sweep` is a terminal
  // saying it just handed work over.
  lock.onRequest((request) => {
    if (request.type === 'stop') {
      setImmediate(() => {
        shutdownRun('stop request');
      });
      return { ok: true };
    }
    if (request.type === 'pause-all') {
      return (async () => {
        const paused = await pauseAllJobs(resolveScreamHome());
        await jobsRef?.cancelAll();
        await resumer?.cancelAll();
        out(t('host.log.paused_all', { count: String(paused.length) }));
        return { ok: true, paused: paused.length };
      })();
    }
    // "Just watch" from a terminal: what the host is doing in one session,
    // without taking it over (the session stays locked here).
    if (request.type === 'peek') {
      const sessionId = (request as { sessionId?: unknown }).sessionId;
      const session = typeof sessionId === 'string' ? harnessRef?.getSession(sessionId) : undefined;
      if (session === undefined) return { ok: false, error: 'not_open' };
      return peekSession(session);
    }
    // A terminal's session finished, waits or failed while the person is away
    // from that terminal: the chat connection is here, so the terminal asks.
    if (request.type === 'remind') {
      const payload = request as { reminder?: unknown; key?: unknown };
      const reminder = parseTerminalReminder(payload.reminder);
      if (reminder === undefined || typeof payload.key !== 'string') return { ok: false, error: 'bad_request' };
      const key = `terminal:${payload.key.slice(0, 200)}`;
      return (async () => {
        const ok = (await remindRef?.(reminder, 'terminal', key)) ?? false;
        return { ok };
      })();
    }
    if (request.type === 'sweep') {
      lastBusyAt = Date.now();
      void resumer?.sweep();
      void inboxRef?.sweep();
      return { ok: true };
    }
    return { ok: false, error: 'unsupported' };
  });
  // The log grows for as long as the host runs; keep it bounded.
  setRepeating(() => {
    void rotateHostLogIfNeeded();
  }, LOG_ROTATE_CHECK_MS).unref();

  let driver: LineSessionDriver | undefined;
  const harness = new ScreamHarness({
    homeDir: resolveScreamHome(),
    identity: createScreamCodeHostIdentity(),
    uiMode: 'print',
    // Host tool calls (the channel's `line_send_media` bridge) are answered by
    // the channel driver.
    onToolCall: (request: ToolCallRequest): Promise<ToolCallResponse> =>
      driver !== undefined
        ? driver.handleHostToolCall(request)
        : Promise.resolve({ output: 'No chat channel runs in this host.', isError: true }),
  });
  harnessRef = harness;
  await harness.ensureConfigFile();
  // A terminal may take back a session the host is continuing. Chat-channel
  // sessions stay with the channel (the TUI does not open them), and a job's
  // run session stays with its run (it is not in the session list; taking it
  // would record the run as failed). A session taken back is not reported as
  // work that stopped.
  harness.setSessionHandoverHandler(async (sessionId) => {
    if (sessionId.startsWith('line-') || sessionId.startsWith(JOB_RUN_SESSION_PREFIX)) return false;
    resumer?.noteHandedOver(sessionId);
    return true;
  });

  if (channelConfig !== undefined) driver = createChannelDriver(channelConfig, harness);

  const handles: PlatformHandle[] = [];
  const failures: string[] = [];

  let shuttingDown = false;
  function shutdownRun(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    keepAwakeRef?.release();
    jobsRef?.stop();
    log.info('host: shutting down', { reason });
    err(t('host.log.shutting_down', { seconds: String(SHUTDOWN_GRACE_MS / 1000) }));
    const forceTimer = setTimeout(() => {
      err(`host: shutdown exceeded ${SHUTDOWN_GRACE_MS / 1000}s, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceTimer.unref();
    void gracefulShutdown(handles, driver, resumer, jobsRef, outboxRef).finally(() => {
      clearTimeout(forceTimer);
      markHostStartClean(startsFile, process.pid, startedAt);
      process.exit(0);
    });
  }
  // Uncaught exception: broken state — a hard exit. The lock is released by
  // the OS, and work in flight keeps its running-work record, so the next
  // host continues it.
  function fatalExit(error: unknown): void {
    log.error('host: uncaught exception, exiting', { error: String(error) });
    process.exit(1);
  }
  process.on('SIGTERM', () => {
    shutdownRun('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdownRun('SIGINT');
  });
  process.on('uncaughtException', (error) => {
    fatalExit(error);
  });
  process.on('unhandledRejection', (reason) => {
    // A single failed turn must not kill the host.
    log.error('host: unhandled rejection (host keeps running)', { reason: String(reason) });
  });

  if (driver !== undefined && channelConfig !== undefined) {
    await startChannel(channelConfig, driver, handles, failures);
    for (const failure of failures) {
      err(t('host.log.platform_failed', { failure }));
    }
    if (handles.length === 0) {
      err(t('host.log.channel_down'));
    }
  }

  const activeDriver = handles.length > 0 ? driver : undefined;

  // Session reminders to the chat (see host/reminders.ts): one outbox, so a
  // reminder is sent once and several at once go out as one message.
  let lastUndeliveredNote = 0;
  const outbox =
    activeDriver === undefined
      ? undefined
      : new ReminderOutbox({
          send: (chat, text) => activeDriver.sendToChat(chat, text),
          // A reminder that never arrives is worse than none: say so where the
          // person will look (the terminal's "while you were away"), at most
          // every few hours.
          onUndelivered: (chat, delivery) => {
            if (Date.now() - lastUndeliveredNote < UNDELIVERED_NOTE_EVERY_MS) return;
            lastUndeliveredNote = Date.now();
            const title =
              chat.startsWith('line-weixin-') && delivery === 'no-target'
                ? t('reminder.undelivered_weixin')
                : t('reminder.undelivered');
            appendActivity({ kind: 'health', title, ok: false });
            notifyDesktop(t('host.notify.health_title'), title);
          },
        });
  const reminders = new ReminderSettings();
  // Read before the inbox's first sweep and the first job run: until then the
  // default would let a reminder through to a chat that switched them off.
  await reminders.mode();
  /** Queue a reminder for the chat the person last wrote from, when the chat's setting allows it. */
  const remind = async (
    reminder: Reminder,
    source: 'background' | 'terminal',
    key: string,
  ): Promise<boolean> => {
    const chat = activeDriver?.ownerChat();
    if (outbox === undefined || chat === undefined) return false;
    if (!reminderAllowed(await reminders.mode(), source)) return false;
    return outbox.push(chat, formatReminder(reminder), key);
  };
  outboxRef = outbox;
  remindRef = remind;

  resumer = new WorkResumer({
    onFinished: (record, title, result) => {
      lastBusyAt = Date.now();
      const name = reminderTitle(title, record.workDir);
      appendActivity({ kind: 'continued', title: name, ok: result.ok, detail: result.text });
      notifyDesktop(t('host.notify.continued_title'), name);
      // A chat session answers in its own chat; nothing to remind about.
      if (record.sessionId.startsWith('line-')) return;
      void remind(
        {
          state: result.ok ? 'done' : 'failed',
          title,
          workDir: record.workDir,
          // How long it ran means something for work handed over; for work a
          // crash or a power loss cut off it would count the time it was down.
          ...(record.handoff === true ? { elapsedMs: Date.now() - record.startedAt } : {}),
          recovered: record.handoff !== true,
          ...(result.ok ? {} : { what: result.failedReason ?? (result.timedOut ? t('reminder.timed_out') : undefined) }),
        },
        'background',
        `continued:${record.sessionId}:${String(record.startedAt)}`,
      );
    },
    harness,
    screamHomeDir: resolveScreamHome(),
    continuationText: t('host.continue_prompt'),
    handoffText: t('host.handoff_prompt'),
    budgetReached: () => hostBudgetReached(),
    recordUsage: (tokens) => {
      addHostTokens(tokens);
    },
    continueChannelSession:
      activeDriver === undefined
        ? undefined
        : (sessionId, text) => activeDriver.continueInterrupted(sessionId, text),
    onContinued: (record, title) => {
      lastBusyAt = Date.now();
      // The log says it; the chat hears only when it is done (a reminder is
      // for something to know or do, not for progress), and that reminder
      // says the work had been cut off.
      out(
        t(record.handoff === true ? 'host.log.continued_handoff' : 'host.log.continued_interrupted', {
          title: title ?? record.sessionId,
        }),
      );
    },
  });
  resumer.start();

  const jobs = new JobRunner({
    harness,
    screamHomeDir: resolveScreamHome(),
    // The weekly self-review: given numbers only, works in the skills folder,
    // and everything it changes goes into the change history.
    prepareRun: async (job) => {
      if (!isSelfReviewJob(job)) return undefined;
      await snapshotEvolution(resolveScreamHome(), 'before self-review');
      return { context: await selfReviewContext(resolveScreamHome(), Date.now()), noWorktree: true };
    },
    afterRun: async (job, run) => {
      if (!isSelfReviewJob(job)) return;
      const first = run.summary.split('\n').find((line) => line.trim() !== '') ?? '';
      await snapshotEvolution(resolveScreamHome(), `self-review: ${first.slice(0, 200)}`);
    },
    // Through the outbox: several results at once are one message.
    deliver:
      outbox === undefined
        ? undefined
        : (sessionKey, text) => {
            outbox.push(sessionKey, text);
            return Promise.resolve();
          },
    nothingToReport: (job, since) =>
      isBriefJob(job) &&
      briefHasNothingToReport({
        job,
        since,
        now: Date.now(),
        activity: readActivitySince(since),
        inbox: listInbox(resolveScreamHome()),
        jobs: new JobStore(resolveScreamHome()).list(),
      }),
    messages: {
      firstFailure: (job, summary) => t('jobs.msg.first_failure', { title: job.title, error: summary.slice(0, 300) }),
      fatigued: (job) => t('jobs.msg.fatigued', { title: job.title }),
      result: (job, summary) => t('jobs.msg.result', { title: job.title, summary }),
      branch: (branch) => t('jobs.msg.branch', { branch }),
    },
    budgetReached: () => hostBudgetReached(),
    onBudgetHold: (job) => {
      out(t('host.log.budget_hold'));
      if (job.deliverTo !== undefined && activeDriver !== undefined) {
        void activeDriver.sendToChat(job.deliverTo, t('jobs.msg.budget_hold'));
      }
    },
    recordUsage: (tokens) => {
      addHostTokens(tokens);
    },
    onRetry: (job, at) => {
      lastBusyAt = Date.now();
      const time = new Date(at);
      out(
        t('host.log.job_retry', {
          title: job.title,
          time: `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`,
        }),
      );
    },
    onRun: (job, ok) => {
      lastBusyAt = Date.now();
      out(t(ok ? 'host.log.job_ok' : 'host.log.job_failed', { title: job.title }));
      const summary = job.runs.at(-1)?.summary;
      appendActivity({ kind: 'job', title: job.title, ok, detail: summary });
      if (!ok) notifyDesktop(t('host.notify.job_failed_title'), t('host.notify.job_failed_body', { title: job.title }));
    },
    // A job made in a terminal names no chat: its results go to the chat the
    // person last wrote from, when a channel runs — a reminder like any other,
    // so the chat's setting decides. A job made in a chat always answers there.
    fallbackChat: () => (reminders.latest() === 'off' ? undefined : activeDriver?.ownerChat()),
  });
  jobsRef = jobs;
  await jobs.start();

  // The "waiting for you" inbox: push new items to the chat, expire old ones,
  // deliver answers to their sessions.
  const inbox = new InboxProcessor({
    harness,
    screamHomeDir: resolveScreamHome(),
    notify:
      outbox === undefined
        ? undefined
        : (sessionKey, text) => {
            outbox.push(sessionKey, text);
            return Promise.resolve();
          },
    // Items of a chat's own session go to that chat; the rest are reminders
    // to the chat the person last wrote from, when its setting allows.
    ownerChat: () => (reminders.latest() === 'off' ? undefined : activeDriver?.ownerChat()),
    titleFor: async (item) => {
      const jobId = jobIdOfRunSession(item.sessionId);
      if (jobId !== undefined) return new JobStore(resolveScreamHome()).get(jobId)?.title;
      const [summary] = await harness.listSessions({ sessionId: item.sessionId });
      return reminderTitle(summary?.title, item.workDir);
    },
    deliverToChat:
      activeDriver === undefined
        ? undefined
        : (sessionKey, text, actionKey) => activeDriver.deliverDecision(sessionKey, text, actionKey),
    formatNotice: inboxNotice,
    onNewItem: (item) => {
      const what =
        item.kind === 'memory'
          ? t('jobs.inbox_memory_line', { count: String(item.memories?.length ?? 0) })
          : item.kind === 'question'
            ? (item.question?.items[0]?.question ?? '')
            : (item.approval?.action ?? '');
      appendActivity({ kind: 'waiting', title: what });
      // Memories wait quietly; an approval or a question deserves a heads-up.
      if (item.kind !== 'memory') notifyDesktop(t('host.notify.waiting_title'), what);
    },
    recordUsage: (tokens) => {
      addHostTokens(tokens);
    },
    // A job run kept its worktree while it waited on the person; now finish it.
    // An approved self-review follow-up may have changed skills: record it.
    onSessionSettled: async (sessionId) => {
      const branch = await releaseHeldWorktree(resolveScreamHome(), sessionId, 'scream: approved follow-up');
      if (branch !== undefined) log.info('host: held worktree finished', { sessionId, branch });
      await snapshotEvolution(resolveScreamHome(), 'approved change from the inbox');
    },
  });
  inboxRef = inbox;
  if (activeDriver !== undefined) {
    activeDriver.onInboxDecided = () => {
      void inbox.sweep();
    };
  }
  void inbox.sweep();
  setRepeating(() => {
    void inbox.sweep();
  }, INBOX_SWEEP_MS).unref();

  log.info('host: started', {
    platforms: handles.map((h) => h.name),
    permissionMode: channelConfig?.permissionMode,
    workDir: channelConfig?.workDir ?? process.cwd(),
  });
  out(
    handles.length > 0
      ? t('host.log.started_channel', { channel: handles.map((h) => h.name).join(' + ') })
      : t('host.log.started'),
  );

  // Chat sessions are opened by messages, so after a restart their scheduled
  // tasks would sleep until the user wrote again. Open the ones that have tasks
  // now — in the background, so a slow session start never delays the chats.
  if (activeDriver !== undefined) {
    const prefixes = handles.map((handle) => `line-${handle.name}-`);
    void activeDriver.resumeScheduledSessions(prefixes).then((opened) => {
      if (opened.length > 0) out(t('host.log.scheduled_resumed', { count: String(opened.length) }));
    });
  }

  // Keep the machine awake while any scream process has a turn in flight
  // (this host's continued work, a chat turn, a goal in a terminal): every
  // such turn has a running-work record whose session lock is held.
  const keepAwake = new KeepAwake();
  keepAwakeRef = keepAwake;
  const checkKeepAwake = async (): Promise<void> => {
    if (shuttingDown) return;
    let working =
      (resumer !== undefined && resumer.busy()) ||
      jobs.busy() ||
      (activeDriver?.pendingTurnCount() ?? 0) > 0;
    if (!working && readHostSettings().keepAwake) {
      for (const record of listRunningWork(resolveScreamHome())) {
        if ((await sessionLockHolder(resolveScreamHome(), record.sessionId).catch(() => undefined)) !== undefined) {
          working = true;
          break;
        }
      }
    }
    await keepAwake.update(working && readHostSettings().keepAwake);
  };
  void checkKeepAwake();
  setRepeating(() => {
    void checkKeepAwake();
  }, KEEP_AWAKE_CHECK_MS).unref();

  // Without a channel or a service install nothing will call on this host
  // again once its work is done: leave instead of running for nothing.
  if (activeDriver === undefined && process.env['SCREAM_CODE_HOST_SERVICE'] !== '1') {
    setRepeating(() => {
      // Enabled background tasks need this host to run them.
      const pending =
        new JobStore(resolveScreamHome()).list().some((job) => job.enabled) ||
        // Inbox work this host must do: deliver a decision, or wait for one on
        // an approval or a question (24 h at most). Memories to save need no
        // host (saving happens where they are decided), and a chat's decision
        // cannot be delivered without a channel, so neither keeps it alive.
        listInbox(resolveScreamHome()).some(
          (item) =>
            item.kind !== 'memory' &&
            (item.status === 'pending' || (item.status === 'decided' && !item.sessionId.startsWith('line-'))),
        ) ||
        listRunningWork(resolveScreamHome()).some((record) => record.handoff === true || record.kind !== 'chat');
      if ((resumer !== undefined && resumer.busy()) || pending) {
        lastBusyAt = Date.now();
        return;
      }
      if (Date.now() - lastBusyAt >= IDLE_EXIT_MS) shutdownRun('idle');
    }, IDLE_CHECK_MS).unref();
  }

  // Keep the event loop alive; park until shutdown.
  setRepeating(() => {}, 1 << 30);
  await new Promise<void>(() => {});
}

async function gracefulShutdown(
  handles: PlatformHandle[],
  driver: LineSessionDriver | undefined,
  resumer: WorkResumer | undefined,
  jobs: JobRunner | undefined,
  outbox: ReminderOutbox | undefined,
): Promise<void> {
  // Work that should outlive this process (a goal, a bot run, a channel turn
  // in flight) is marked as handed over before anything closes, so closing
  // does not wipe its running-work record: an OS shutdown sends SIGTERM first,
  // and the next host — after the reboot — continues it.
  resumer?.stop();
  await resumer?.handOffAll().catch(() => {});
  await driver?.handOffActive().catch(() => {});
  // Job runs in flight get most of the grace window to finish; then they are
  // cancelled, and the few seconds left let each record its (failed) run and
  // commit and remove its worktree, instead of dying mid-tool with a worktree
  // left behind. In parallel with the channel's wait below.
  const jobsDone = (async () => {
    if (jobs === undefined || (await jobs.waitIdle(SHUTDOWN_GRACE_MS - 15_000))) return;
    log.warn('host: shutdown cancels job runs still in flight');
    await jobs.cancelAll().catch(() => {});
    await jobs.waitIdle(10_000);
  })();
  if (driver !== undefined) {
    // Let the running turn finish and reply before the transports go away; the
    // grace window keeps a stuck turn from blocking the exit forever.
    await driver.waitIdle(SHUTDOWN_GRACE_MS - 5_000).catch(() => {});
    const abandoned = driver.pendingTurnCount();
    if (abandoned > 0) {
      // The window expired with work still queued: those chats will never get
      // a reply. Say so — a silent exit reads as "the bot died".
      log.warn('host: shutdown timed out with pending turns', { pending: abandoned });
      err(t('host.log.abandoned_turns', { count: String(abandoned) }));
    }
  }
  await jobsDone;
  // Reminders still gathering (a run that just finished) go out while the
  // channel is still connected.
  await outbox?.flushAll().catch(() => {});
  for (const handle of handles) {
    try {
      await handle.close();
    } catch {
      // best-effort
    }
  }
  try {
    await driver?.close();
  } catch {
    // best-effort
  }
  await resumer?.closeAll().catch(() => {});
  log.info('host: stopped');
}

/** A read-only snapshot of a session the host has open: its title, whether a turn runs, its last answer, its goal. */
async function peekSession(session: Session): Promise<{
  ok: true;
  title?: string | undefined;
  running: boolean;
  lastReply: string;
  goal?: { objective: string; status: string } | undefined;
}> {
  const [context, goal] = await Promise.all([
    session.getContext().catch(() => undefined),
    session.getGoal().catch(() => undefined),
  ]);
  let lastReply = '';
  for (const message of [...(context?.history ?? [])].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim();
    if (text !== '') {
      lastReply = text.length > 2_000 ? `…${text.slice(-2_000)}` : text;
      break;
    }
  }
  return {
    ok: true,
    title: session.summary?.title,
    // A turn in progress is registered as running work while it runs.
    running: listRunningWork(resolveScreamHome()).some((record) => record.sessionId === session.id),
    lastReply,
    ...(goal?.goal === null || goal === undefined ? {} : { goal: { objective: goal.goal.objective, status: goal.goal.status } }),
  };
}
