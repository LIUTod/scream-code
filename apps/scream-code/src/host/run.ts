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

import { createScreamCodeHostIdentity } from '#/cli/version';
import { createChannelDriver, startChannel, type PlatformHandle } from '#/line/channel';
import { assertSinglePlatformConfig, loadLineConfig, type LineConfig } from '#/line/config';
import type { LineSessionDriver } from '#/line/session-driver';

import { claimHostLock, HOST_SHUTDOWN_GRACE_MS, rotateHostLogIfNeeded } from './control';
import { hostErr as err, hostOut as out } from './log';
import { appendActivity } from './activity';
import { notifyDesktop } from './desktop-notify';
import { InboxProcessor } from './inbox-processor';
import { isSelfReviewJob, selfReviewContext } from './self-review';
import { releaseHeldWorktree } from './worktree';
import { JOB_RUN_SESSION_PREFIX, JobRunner } from './job-runner';
import { KeepAwake } from './keep-awake';
import { pauseAllJobs } from './pause-all';
import { readHostSettings } from './settings';
import { addHostTokens, hostBudgetReached } from './usage';
import { inboxNotice } from '#/line/background-commands';
import { WorkResumer } from './work-resumer';

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
  const lock = await claimHostLock({ kind: 'host' });
  if (!lock.held) {
    const pid = lock.holder?.pid;
    err(t('cli.line.already_running', { pid: pid === undefined ? '?' : String(pid) }));
    process.exitCode = 1;
    return;
  }
  let resumer: WorkResumer | undefined;
  // Declared before the lock answers requests: a request can arrive during
  // any await of the boot below.
  let keepAwakeRef: KeepAwake | undefined;
  let jobsRef: JobRunner | undefined;
  let inboxRef: InboxProcessor | undefined;
  let harnessRef: ScreamHarness | undefined;
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
    void gracefulShutdown(handles, driver, resumer, jobsRef).finally(() => {
      clearTimeout(forceTimer);
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
  resumer = new WorkResumer({
    onFinished: (record, title, result) => {
      lastBusyAt = Date.now();
      const name = title ?? record.sessionId;
      appendActivity({ kind: 'continued', title: name, ok: result.ok, detail: result.text });
      notifyDesktop(t('host.notify.continued_title'), name);
      const chat = activeDriver?.ownerChat();
      if (activeDriver !== undefined && chat !== undefined && !record.sessionId.startsWith('line-')) {
        const last = result.text.trim().slice(-600);
        void activeDriver
          .sendToChat(chat, t(result.ok ? 'host.msg.continued_done' : 'host.msg.continued_stopped', { title: name, detail: last }))
          .catch(() => {});
      }
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
      out(
        t(record.handoff === true ? 'host.log.continued_handoff' : 'host.log.continued_interrupted', {
          title: title ?? record.sessionId,
        }),
      );
      // Say so on the phone: work picked up after a crash or a power loss
      // would otherwise happen unseen. A chat session replies in its own chat.
      const chat = activeDriver?.ownerChat();
      if (activeDriver !== undefined && chat !== undefined && !record.sessionId.startsWith('line-')) {
        void activeDriver
          .sendToChat(
            chat,
            t(record.handoff === true ? 'host.msg.continued_handoff' : 'host.msg.continued_interrupted', {
              title: title ?? record.sessionId,
            }),
          )
          .catch(() => {});
      }
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
    deliver: activeDriver === undefined ? undefined : (sessionKey, text) => activeDriver.sendToChat(sessionKey, text),
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
    onRun: (job, ok) => {
      lastBusyAt = Date.now();
      out(t(ok ? 'host.log.job_ok' : 'host.log.job_failed', { title: job.title }));
      const summary = job.runs.at(-1)?.summary;
      appendActivity({ kind: 'job', title: job.title, ok, detail: summary });
      if (!ok) notifyDesktop(t('host.notify.job_failed_title'), t('host.notify.job_failed_body', { title: job.title }));
    },
    // A job made in a terminal names no chat: its results go to the chat the
    // person last wrote from, when a channel runs.
    fallbackChat: () => activeDriver?.ownerChat(),
  });
  jobsRef = jobs;
  await jobs.start();

  // The "waiting for you" inbox: push new items to the chat, expire old ones,
  // deliver answers to their sessions.
  const inbox = new InboxProcessor({
    harness,
    screamHomeDir: resolveScreamHome(),
    notify: activeDriver === undefined ? undefined : (sessionKey, text) => activeDriver.sendToChat(sessionKey, text),
    ownerChat: () => activeDriver?.ownerChat(),
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
