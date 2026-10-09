import type { BackgroundTaskInfo, Session } from '@scream-code/scream-code-sdk';
import type { Component, ProcessTerminal, TuiAltScreen } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';

import { TaskOutputViewer } from '../components/dialogs/task-output-viewer';
import { TasksBrowserApp, type TasksFilter } from '../components/dialogs/tasks-browser';
import type { ColorPalette } from '../theme';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { SubagentSlot } from '../utils/subagent-slots';
import { buildAgentRows, type AgentRow, type SubagentInstanceInfo, type SubagentInstanceRow } from '../utils/subagent-instances';

export interface TasksBrowserHost {
  readonly state: {
    readonly tasksBrowser: TasksBrowserState | undefined;
    readonly theme: { readonly colors: ColorPalette };
    readonly terminal: ProcessTerminal;
    readonly ui: TuiAltScreen;
    readonly layoutRoot: Component | undefined;
    readonly editor: CustomEditor;
  };
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  /**
   * Agent that owns each subagent-owned entry in {@link backgroundTasks}
   * (task id → agent id). Absent ⇒ the main agent's own task. A subagent's task
   * is only reachable through its owner: the main registry answers neither its
   * rows nor its output, and the owner id is what routes output/stop RPCs.
   */
  readonly backgroundTaskOwners: ReadonlyMap<string, string>;
  /** Sidebar slot snapshot — the live per-type subagent state machine. */
  readonly subagentSlots: readonly SubagentSlot[];
  /** Per-instance subagent provenance (spawn parent, outcome), keyed by agentId. */
  readonly subagentInstances: ReadonlyMap<string, SubagentInstanceInfo>;
  /** Archive ring behind the live registry: closed instances' last derived
   *  rows, oldest first. */
  readonly recentSubagentInstances: readonly SubagentInstanceRow[];
  readonly session: Session | undefined;
  showError(msg: string): void;
  setTasksBrowser(value: TasksBrowserState | undefined): void;
}

export type TasksBrowserState = {
  component: TasksBrowserApp;
  savedLayoutRoot: Component | undefined;
  filter: TasksFilter;
  selectedTaskId: string | undefined;
  tailOutput: string | undefined;
  tailLoading: boolean;
  tailRequestId: number;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  viewer:
    | {
        component: TaskOutputViewer;
        savedLayoutRoot: Component | undefined;
        taskId: string;
        output: string;
        refreshId: number;
        pollTimer: NodeJS.Timeout;
      }
    | undefined;
};

export class TasksBrowserController {
  constructor(private readonly host: TasksBrowserHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.tasksBrowser !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.host.showError(t('tasks.no_session'));
      return;
    }

    let tasks: readonly BackgroundTaskInfo[] = [];
    try {
      tasks = this.withSubagentTasks(await session.listBackgroundTasks({ activeOnly: false }));
    } catch (error) {
      this.host.showError(
        t('tasks.load_failed', { msg: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    if (state.tasksBrowser !== undefined) return;

    const filter: TasksFilter = 'all';
    const selectedTaskId = this.pickInitialSelection(tasks, filter);
    const component = new TasksBrowserApp(
      {
        tasks,
        taskSourceNames: this.taskSourceNames(),
        agents: this.snapshotAgentRows(),
        filter,
        selectedTaskId,
        tailOutput: undefined,
        tailLoading: false,
        flashMessage: undefined,
        colors: state.theme.colors,
        ...this.buildCallbacks(),
      },
      state.terminal,
    );

    const savedLayoutRoot = state.layoutRoot;
    state.ui.setLayoutRoot(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);

    this.host.setTasksBrowser({
      component,
      savedLayoutRoot,
      filter,
      selectedTaskId,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
      viewer: undefined,
    });

    if (selectedTaskId !== undefined) {
      this.loadTail(selectedTaskId);
    }
  }

  close(): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) this.closeOutputViewer();
    if (browser.pollTimer !== undefined) clearInterval(browser.pollTimer);
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    // Component-local timers (pending-stop confirm) must not outlive the
    // browser — the component is swapped out right after this.
    browser.component.close();

    state.ui.setLayoutRoot(browser.savedLayoutRoot);
    this.host.setTasksBrowser(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  repaint(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    const tasks = [...this.host.backgroundTasks.values()];
    this.pushProps(tasks);
  }

  async refreshOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    const viewer = browser?.viewer;
    if (browser === undefined || viewer === undefined) return;

    const session = this.host.session;
    if (session === undefined) return;

    const myRefreshId = ++viewer.refreshId;
    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(viewer.taskId, {
        agentId: this.ownerOf(viewer.taskId),
      });
    } catch (error) {
      if (!opts.silent) {
        const message = error instanceof Error ? error.message : String(error);
        this.flash(t('tasks.refresh_output_failed', { msg: message }));
      }
      return;
    }
    const current = state.tasksBrowser?.viewer;
    if (current === undefined || current !== viewer || current.refreshId !== myRefreshId) {
      return;
    }
    if (output === viewer.output) return;
    viewer.output = output;
    const info = this.host.backgroundTasks.get(viewer.taskId);
    viewer.component.setProps({
      taskId: viewer.taskId,
      info,
      output,
      colors: state.theme.colors,
      onClose: () => {
        this.closeOutputViewer();
      },
    });
    state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------

  private pickInitialSelection(
    tasks: readonly BackgroundTaskInfo[],
    filter: TasksFilter,
  ): string | undefined {
    const candidates =
      filter === 'all'
        ? tasks
        : tasks.filter(
            (t) =>
              t.status !== 'completed' &&
              t.status !== 'failed' &&
              t.status !== 'killed' &&
              t.status !== 'lost',
          );
    if (candidates.length === 0) return undefined;
    return (
      candidates.find((t) => t.status === 'running')?.taskId ?? candidates[0]!.taskId
    );
  }

  /**
   * Merge the subagent-owned rows into a main-agent list. The polled list is
   * authoritative for main's own registry — it cannot list a subagent's
   * registry at all — so those rows come from the event-fed
   * {@link TasksBrowserHost.backgroundTasks}, tagged in
   * {@link TasksBrowserHost.backgroundTaskOwners}. Without this, opening /tasks
   * would show an empty list for work the transcript never mentions and the
   * subagent's own rows would be invisible.
   */
  private withSubagentTasks(fetched: readonly BackgroundTaskInfo[]): readonly BackgroundTaskInfo[] {
    const owners = this.host.backgroundTaskOwners;
    if (owners.size === 0) return fetched;
    const merged = new Map(fetched.map((info) => [info.taskId, info] as const));
    for (const taskId of owners.keys()) {
      if (merged.has(taskId)) continue;
      const local = this.host.backgroundTasks.get(taskId);
      if (local !== undefined) merged.set(taskId, local);
    }
    return [...merged.values()];
  }

  /** Row/detail tag: the owning subagent's display name per subagent-owned task. */
  private taskSourceNames(): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    for (const [taskId, ownerId] of this.host.backgroundTaskOwners) {
      names.set(taskId, this.ownerDisplayName(ownerId));
    }
    return names;
  }

  /** Owning subagent's profile name, falling back to the archived instance row
   *  and finally to the raw agent id — an id is better than a wrong name. */
  private ownerDisplayName(ownerId: string): string {
    const live = this.host.subagentInstances.get(ownerId);
    if (live !== undefined) return live.type;
    const archived = this.host.recentSubagentInstances.find((row) => row.instanceId === ownerId);
    return archived?.type ?? ownerId;
  }

  /** Agent whose registry answers for this task; undefined ⇒ the main agent's. */
  private ownerOf(taskId: string): string | undefined {
    return this.host.backgroundTaskOwners.get(taskId);
  }

  private async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) return;

    let tasks: readonly BackgroundTaskInfo[];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      if (!opts.silent) {
        this.flash(
          t('tasks.refresh_failed', { msg: error instanceof Error ? error.message : String(error) }),
        );
      }
      return;
    }
    if (state.tasksBrowser !== browser) return;
    this.pushProps(this.withSubagentTasks(tasks));
  }

  private pushProps(tasks: readonly BackgroundTaskInfo[]): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    browser.component.setProps({
      tasks,
      taskSourceNames: this.taskSourceNames(),
      agents: this.snapshotAgentRows(),
      filter: browser.filter,
      selectedTaskId: browser.selectedTaskId,
      tailOutput: browser.tailOutput,
      tailLoading: browser.tailLoading,
      flashMessage: browser.flashMessage,
      colors: this.host.state.theme.colors,
      ...this.buildCallbacks(),
    });
    this.host.state.ui.requestRender();
  }

  /** Agents view rows: the live slot state machine (authoritative status)
   *  enriched with the per-instance provenance registry, plus the archive ring
   *  for agents whose registry record has already been released. Rebuilt on
   *  every refresh/repaint — all three sources are in-memory snapshots. */
  private snapshotAgentRows(): readonly AgentRow[] {
    return buildAgentRows(
      this.host.subagentSlots,
      this.host.subagentInstances,
      this.host.recentSubagentInstances,
    );
  }

  private buildCallbacks(): {
    onSelect: (taskId: string) => void;
    onToggleFilter: () => void;
    onRefresh: () => void;
    onCancel: () => void;
    onStopConfirmed: (taskId: string) => void;
    onOpenOutput: (taskId: string) => void;
    onStopIgnored: (taskId: string, reason: 'terminal') => void;
  } {
    return {
      onSelect: (taskId) => {
        this.handleSelect(taskId);
      },
      onToggleFilter: () => {
        this.handleToggleFilter();
      },
      onRefresh: () => {
        this.handleRefresh();
      },
      onCancel: () => {
        this.close();
      },
      onStopConfirmed: (taskId) => {
        void this.handleStop(taskId);
      },
      onOpenOutput: (taskId) => {
        void this.handleOpenOutput(taskId);
      },
      onStopIgnored: (taskId, reason) => {
        if (reason === 'terminal') {
          this.flash(t('tasks.already_stopped', { name: taskId }));
        }
      },
    };
  }

  private handleSelect(taskId: string): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.tailOutput = undefined;
    browser.tailLoading = true;
    this.repaint();
    this.loadTail(taskId);
  }

  private handleToggleFilter(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    // Three-stop cycle: tasks (all) → tasks (active) → agents → tasks (all).
    browser.filter =
      browser.filter === 'all' ? 'active' : browser.filter === 'active' ? 'agents' : 'all';
    this.repaint();
  }

  private handleRefresh(): void {
    this.flash(t('tasks.refreshing'), 600);
    void this.refresh();
  }

  private async handleStop(taskId: string): Promise<void> {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.flash(t('tasks.no_session'));
      return;
    }

    this.flash(t('tasks.stopping', { name: taskId }), 1500);
    try {
      // Stop through the owning registry: a subagent's task is unknown to the
      // main one, where stopping it would be a silent no-op.
      await session.stopBackgroundTask(taskId, {
        reason: t('tasks.user_stopped'),
        agentId: this.ownerOf(taskId),
      });
      await this.refresh({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(t('tasks.stop_failed', { msg: message }));
    }
  }

  private async handleOpenOutput(taskId: string): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.flash(t('tasks.no_session'));
      return;
    }

    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(taskId, { agentId: this.ownerOf(taskId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(t('tasks.open_output_failed', { msg: message }));
      return;
    }
    const current = state.tasksBrowser;
    if (current === undefined || current !== browser) return;
    // A second Enter/O (or key auto-repeat) can land inside the fetch window:
    // the entry guard ran before the await, so re-check here — otherwise the
    // extra viewer replaces the first one below and its poll interval leaks.
    if (current.viewer !== undefined) return;

    const info = this.host.backgroundTasks.get(taskId);
    const viewer = new TaskOutputViewer(
      {
        taskId,
        info,
        output,
        colors: state.theme.colors,
        onClose: () => {
          this.closeOutputViewer();
        },
      },
      state.terminal,
    );

    // The viewer replaces the *current* layout root — while the browser is
    // open that is `browser.component`. `state.layoutRoot` still points at
    // the main layout (only the lifecycle controller ever writes it), and
    // restoring that here drops the browser out of the render tree while its
    // focus survives: the screen looks like the main TUI, typing stays dead,
    // and a second Esc is needed to really leave.
    const savedBrowserLayout: Component = browser.component;
    state.ui.setLayoutRoot(viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshOutputViewer({ silent: true });
    }, 1000);

    browser.viewer = {
      component: viewer,
      savedLayoutRoot: savedBrowserLayout,
      taskId,
      output,
      refreshId: 0,
      pollTimer,
    };
  }

  private loadTail(taskId: string): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      browser.tailLoading = false;
      this.repaint();
      return;
    }

    const requestId = ++browser.tailRequestId;
    void session
      .getBackgroundTaskOutput(taskId, { tail: 4000, agentId: this.ownerOf(taskId) })
      .then((output) => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = output;
        current.tailLoading = false;
        this.repaint();
      })
      .catch(() => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = '';
        current.tailLoading = false;
        this.repaint();
      });
  }

  private flash(message: string, durationMs = 2500): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.host.state.tasksBrowser;
      if (current !== browser) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.repaint();
    }, durationMs);
    this.repaint();
  }

  private closeOutputViewer(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined || browser.viewer === undefined) return;
    const viewer = browser.viewer;
    clearInterval(viewer.pollTimer);
    browser.viewer = undefined;
    this.host.state.ui.setLayoutRoot(viewer.savedLayoutRoot);
    this.host.state.ui.setFocus(browser.component);
    this.host.state.ui.requestRender(true);
  }
}
