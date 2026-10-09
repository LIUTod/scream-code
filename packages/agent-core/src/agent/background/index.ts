import type { ContentPart } from '@scream-code/ltod';

import type { Agent } from '../..';
import {
  BackgroundProcessManager,
  type BackgroundTaskInfo,
  isBackgroundTaskTerminal,
  type ReconcileResult,
} from '../../tools/builtin';
import type { BackgroundTaskOrigin } from '../context';
import { renderNotificationXml } from '../context/notification-xml';

type BackgroundTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  /** Subagent id for agent-* tasks. Surfaced as a structured attribute so
   *  the LLM can pass it verbatim to `Agent(resume=...)` without confusing
   *  it with `source_id` (the BackgroundManager ledger id). Omitted for
   *  bash background tasks and for restored tasks whose previous session
   *  pre-dates agent_id persistence. */
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly tail_output: string;
};

interface BackgroundTaskNotificationContext {
  readonly content: readonly ContentPart[];
  readonly origin: BackgroundTaskOrigin;
  readonly notification: BackgroundTaskNotification;
}

const NOTIFICATION_TAIL_BYTES = 3_000;

export class BackgroundManager extends BackgroundProcessManager {
  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();
  /**
   * Session-death latch, set by `Session.close()` before it tears anything
   * down, and by a subagent's terminal release as it evicts its finished
   * owner (see `markSessionClosed`). While set, a terminal task notification
   * is dropped instead of steered — see `notifyBackgroundTask`.
   */
  private sessionClosed = false;

  constructor(public readonly agent: Agent) {
    super({
      maxRunningTasks: agent.screamConfig?.background?.maxRunningTasks,
      killGracePeriodMs: agent.screamConfig?.background?.killGracePeriodMs,
      sessionDir: agent.homedir,
    });

    this.onLifecycle((event, info) => {
      switch (event) {
        case 'started':
          this.agent.emitEvent({ type: 'background.task.started', info });
          return;
        case 'updated':
          this.agent.emitEvent({ type: 'background.task.updated', info });
          return;
        case 'terminated':
          this.agent.emitEvent({ type: 'background.task.terminated', info });
          return;
      }
    });
  }

  /**
   * Latch this manager so no further terminal task notification is steered
   * through it (see `notifyBackgroundTask`). Two owners set it:
   *
   * - `Session.close()` calls it for every manager the session created, before
   *   any teardown runs. That single drop does both jobs: no ghost turn is
   *   launched for the closing session, and the notification stays undelivered,
   *   so the reconcile path (`restoreBackgroundTaskNotifications`) appends it
   *   silently the next time the session is opened.
   * - The subagent host latches a child's manager when the child is evicted at
   *   the end of its run. The child can no longer consume a notification, and
   *   the tasks that outlive it — a parked foreground command above all —
   *   would otherwise wake the evicted agent as a ghost turn. The drop is the
   *   same: undelivered here, reported as `lost` by the reconcile of the
   *   fresh manager a later resume builds.
   *
   * The latch has no reset counterpart on purpose: it models "this manager has
   * no live consumer left", and nothing re-registers the latched instance. A
   * closed session is discarded (the RPC layer's closeSession deletes it from
   * the active map, and a later activation constructs a new `Session`), and
   * `Session.resume()` / `ensureAgent` drop evicted agents before
   * re-instantiating them from metadata — so every reopened or resumed owner
   * runs a brand-new BackgroundManager whose latch starts unset.
   */
  markSessionClosed(): void {
    this.sessionClosed = true;
  }

  /**
   * Stop every non-terminal agent-class task — the tasks registered through
   * `registerAgentTask`, whose ids carry the `agent-` prefix (see
   * generateTaskId).
   *
   * `Session.close()` calls this under `keepAliveOnExit`: that switch protects
   * real bash processes, whose work stays meaningful to the user after the
   * session is gone, while an agent task is a coroutine driving a subagent turn
   * the close has already cancelled — left "alive" it can never finish on its
   * own and would strand a half-dead ledger entry that later notifies a dead
   * session. Bash tasks are deliberately untouched here; stopping those is
   * `stopAll`, the keepAlive=false path.
   */
  async stopAgentTasks(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const taskIds = this.list()
      .filter((info) => isAgentTaskId(info.taskId))
      .map((info) => info.taskId);
    const results = await Promise.all(taskIds.map((taskId) => this.stop(taskId, reason)));
    return results.filter((info): info is BackgroundTaskInfo => info !== undefined);
  }

  override async reconcile(): Promise<ReconcileResult> {
    const result = await super.reconcile();
    await this.restoreBackgroundTaskNotifications();
    return result;
  }

  protected override onLiveTaskTerminal(info: BackgroundTaskInfo): void | Promise<void> {
    return this.notifyBackgroundTask(info);
  }

  private async restoreBackgroundTaskNotifications(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isBackgroundTaskTerminal(info.status)) continue;
      await this.restoreBackgroundTaskNotification(info);
    }
  }

  /**
   * Steer a terminal task notification into the owning agent's turn.
   *
   * Notifications follow the owner chain: a BackgroundManager belongs to
   * exactly one agent, and the Agent tool registers a background child in the
   * manager of the agent that spawned it (AgentTool is built with that agent's
   * `background`). A grandchild spawned in background by a subagent therefore
   * notifies its direct owner — the child — which surfaces it in its own turn;
   * it never skips a level up to the root. TaskList/TaskOutput/TaskStop see the
   * same boundary, each scoped to the manager's own agent.
   */
  private async notifyBackgroundTask(info: BackgroundTaskInfo): Promise<void> {
    // Consumer gate (see `markSessionClosed`): there is no one left to steer
    // this notification into when the session is closing or closed, OR the
    // owning subagent was evicted at the end of its run. Steering an idle
    // agent auto-launches a turn (`AgentTurn.steer` → `launch`), and in both
    // cases that turn is a ghost — invisible to the user, but it still spends
    // API calls and writes wire records. Checked BEFORE the context builder on
    // purpose: the builder reserves a scheduled-notification key, and a
    // reservation whose delivery never happened would also block the reconcile
    // path (`restoreBackgroundTaskNotifications`) from re-delivering this
    // notification when the session is next opened.
    if (this.sessionClosed) return;
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    if (this.sessionClosed) {
      // The latch was set while the notification was being built (the session
      // started closing, or the child was evicted). Release the reservation
      // taken above for the same reason — reconcile must still be able to
      // re-deliver — and do not steer: steering now would launch exactly the
      // ghost turn this gate exists to prevent.
      this.scheduledNotificationKeys.delete(notificationKey(context.origin));
      return;
    }
    this.agent.turn.steer(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async restoreBackgroundTaskNotification(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.context.appendUserMessage(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async buildBackgroundTaskNotificationContext(
    info: BackgroundTaskInfo,
  ): Promise<BackgroundTaskNotificationContext | undefined> {
    const origin: BackgroundTaskOrigin = {
      kind: 'background_task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const notificationId = origin.notificationId;
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.hasDeliveredNotification(origin)) return;

    this.scheduledNotificationKeys.add(key);
    const tailOutput = (await this.getOutputSnapshot(info.taskId, NOTIFICATION_TAIL_BYTES))
      .preview;
    if (this.hasDeliveredNotification(origin)) return;
    const isAgentTask = isAgentTaskId(info.taskId);
    const label = isAgentTask ? 'agent' : 'task';
    const notification: BackgroundTaskNotification = {
      id: notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: isAgentTask ? info.agentId : undefined,
      title: `Background ${label} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildBackgroundTaskNotificationBody(info, isAgentTask),
      tail_output: tailOutput,
    };
    const content = [
      {
        type: 'text',
        text: renderNotificationXml(notification),
      },
    ] as const;
    return { content, origin, notification };
  }

  private fireNotificationHook(notification: BackgroundTaskNotification): void {
    void this.agent.hooks?.fireAndForgetTrigger('Notification', {
      matcherValue: notification.type,
      inputData: {
        sink: 'context',
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      },
    });
  }

  markDeliveredNotification(origin: BackgroundTaskOrigin): void {
    this.deliveredNotificationKeys.add(notificationKey(origin));
  }

  /**
   * Export the delivered-notification keys for wire persistence. A full
   * compaction folds the notification messages these marks were derived from
   * into its summary, and the folded `context.append_message` records never
   * replay — the `context.snapshot` payload is therefore the only place a
   * resume can recover the marks from (see
   * `ContextMemoryJSONSnapshot.deliveredNotificationKeys`). Losing them makes
   * reconcile re-deliver notifications the session already saw.
   */
  exportDeliveredNotificationKeys(): readonly string[] {
    return [...this.deliveredNotificationKeys];
  }

  /**
   * Rebuild delivered marks from a restored snapshot. Additive on purpose:
   * replay separately re-marks every notification message still present in
   * the restored history, and a key from either source suppresses re-delivery
   * — only a notification neither source knows about is appended by reconcile.
   */
  restoreDeliveredNotificationKeys(keys: readonly string[]): void {
    for (const key of keys) this.deliveredNotificationKeys.add(key);
  }

  private hasDeliveredNotification(origin: BackgroundTaskOrigin): boolean {
    return this.deliveredNotificationKeys.has(notificationKey(origin));
  }

  override stop(taskId: string, reason?: string) {
    this.agent.records.logRecord({
      type: 'background.stop',
      taskId,
    });
    return super.stop(taskId, reason);
  }

  override _reset(): void {
    super._reset();
    this.scheduledNotificationKeys.clear();
    this.deliveredNotificationKeys.clear();
  }
}

function notificationKey(origin: BackgroundTaskOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

/**
 * Agent-class tasks are the ones registered through `registerAgentTask`; their
 * ids carry the `agent-` prefix (generateTaskId in tools/background/manager).
 */
function isAgentTaskId(taskId: string): boolean {
  return taskId.startsWith('agent-');
}

/**
 * Build the human/LLM-readable body that lands in the `<notification>`
 * XML. For agent-* tasks that ended non-successfully and whose subagent id
 * we still know, append a paragraph telling the LLM exactly how to resume
 * — which id to pass, how to distinguish it from the look-alike `source_id`,
 * and what state the resumed subagent will and will not have. The intent is
 * to make recovery a one-shot decision instead of a memory lookup against
 * the original spawn-success ToolResult.
 *
 * Bash tasks, successful agent tasks, and restored agent tasks from
 * sessions that pre-date `agent_id` persistence keep the original
 * single-sentence body.
 */
export function buildBackgroundTaskNotificationBody(
  info: BackgroundTaskInfo,
  isAgentTask: boolean,
): string {
  const baseLine =
    info.status === 'killed' && info.stopReason
      ? `${info.description} was killed: ${info.stopReason}.`
      : `${info.description} ${info.status}.`;

  if (!isAgentTask) return baseLine;
  if (info.status === 'completed') return baseLine;
  // A user-initiated stop (killed) is a deliberate cancellation: never suggest
  // resuming a cancelled subagent, so this notification cannot restart work the
  // user explicitly ended. Failures and losses keep the recovery hint.
  if (info.status === 'killed') {
    return `${baseLine} The subagent was cancelled by the user. Do not resume or retry it automatically — wait for the user's next instruction.`;
  }
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}
