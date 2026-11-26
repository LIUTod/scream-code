import type { Component, Focusable } from '@liutod-scream/pi-tui';
import type {
  ScreamHarness,
  Session,
} from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { sharedMemoStore, type MemoryMemoSummary } from '@scream-code/memory';
import { getDataDir } from '#/utils/paths';
import type { TUIState } from '../tui-state';
import type { LivePaneState } from '../types';
import { ApprovalPanelComponent, type ApprovalPanelResponse } from '../components/dialogs/approval-panel';
import { ApprovalPreviewViewer, type ApprovalPreviewBlock } from '../components/dialogs/approval-preview';
import { defaultKeyboardShortcuts, HelpPanelComponent, type HelpPanelCommand } from '../components/dialogs/help-panel';
import { MemoryPickerComponent } from '../components/dialogs/memory-picker';
import { SessionPickerComponent, type SessionRow } from '../components/dialogs/session-picker';
import { QuestionDialogComponent } from '../components/dialogs/question-dialog';
import { formatMemoryMemoForInjection } from '../commands/memory';
import { isChannelManagedSession } from '../utils/channel-sessions';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { adaptPanelResponse } from '../reverse-rpc/approval/adapter';
import type { ApprovalController } from '../reverse-rpc/approval/controller';
import type { QuestionController } from '../reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '../reverse-rpc/types';
import { disposeChildren } from '../utils/component-capabilities';
import { panelViewportRows } from '../utils/panel-rows';

export interface DialogManagerHost {
  readonly state: TUIState;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  readonly harness: ScreamHarness;

  showError(message: string): void;
  showStatus(message: string, color?: string): void;
  /** Force a status-bar refresh; invalidates the activity-mode cache so the
   *  empty-session hint reacts to dialog open/close (the dialog itself is not
   *  a phase transition, so the cache would otherwise go stale). */
  forceUpdateStatusBar(): void;
  /** 退出 /tasks 等全屏接管组件,让后续 editor 替换能挂载到真实容器。 */
  exitFullScreenTakeover(): void;
  sendNormalUserInput(text: string): void;
  /** Start /dream from the memory panel. */
  startDream(): void;
  /** Last dream timestamp for the memory panel header. */
  readDreamTracker(): Promise<{ lastDreamAt?: number } | undefined>;
  resumeSession(sessionId: string): Promise<{ switched: boolean; blocked?: boolean }>;
  switchToSession(session: Session, message: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  fetchSessions(): Promise<void>;
  getSessions(): SessionRow[];
  getIsLoadingSessions(): boolean;
  getCurrentSessionId(): string;
  getCurrentWorkDir(): string;
  toggleToolOutputExpansion(): void;
  togglePlanExpansion(): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
}

/**
 * Encapsulates all dialog / picker / panel operations.
 */
export class DialogManager {
  /** The memory picker on screen right now; async fills check they still own it. */
  private memoryPicker: MemoryPickerComponent | undefined;
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  private activeQuestionDialog: QuestionDialogComponent | undefined;
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        savedLayoutRoot: Component | undefined;
        panel: ApprovalPanelComponent;
      }
    | undefined;

  constructor(private readonly host: DialogManagerHost) {}

  // =========================================================================
  // Editor replacement primitives
  // =========================================================================
  private mountEditorReplacement(panel: Component & Focusable): void {
    this.host.exitFullScreenTakeover();
    disposeChildren(this.host.state.editorContainer);
    this.host.state.editorContainer.addChild(panel);
    this.host.state.ui.setFocus(panel);
    this.host.state.ui.requestRender();
    this.host.forceUpdateStatusBar();
  }

  private restoreEditor(): void {
    disposeChildren(this.host.state.editorContainer);
    this.host.state.editorContainer.addChild(this.host.state.editor);
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.activeDialog = null;
    this.host.state.ui.requestRender();
    this.host.forceUpdateStatusBar();
  }

  // =========================================================================
  // Help panel
  // =========================================================================
  showHelpPanel(commands: readonly HelpPanelCommand[]): void {
    this.host.state.activeDialog = 'help';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands,
        colors: this.host.state.theme.colors,
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  hideHelpPanel(): void {
    this.host.state.activeDialog = null;
    this.restoreEditor();
  }

  showHotkeysPanel(): void {
    this.host.state.activeDialog = 'hotkeys';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: [],
        shortcuts: defaultKeyboardShortcuts(),
        colors: this.host.state.theme.colors,
        title: t('help.hotkeys_title'),
        onClose: () => {
          this.hideHotkeysPanel();
        },
      }),
    );
  }

  hideHotkeysPanel(): void {
    this.host.state.activeDialog = null;
    this.restoreEditor();
  }

  // =========================================================================
  // Session picker
  // =========================================================================
  async showSessionPicker(): Promise<void> {
    await this.host.fetchSessions();
    this.host.state.activeDialog = 'session-picker';
    this.mountSessionPicker(() => {
      this.host.state.activeDialog = null;
      this.restoreEditor();
    });
  }

  hideSessionPicker(): void {
    this.host.state.activeDialog = null;
    this.restoreEditor();
  }

  private mountSessionPicker(onCancel: () => void): void {
    this.mountEditorReplacement(
      new SessionPickerComponent({
        sessions: this.host.getSessions(),
        loading: this.host.getIsLoadingSessions(),
        currentSessionId: this.host.getCurrentSessionId(),
        colors: this.host.state.theme.colors,
        onStatus: (message: string) => {
          this.host.showStatus(message);
        },
        onSelect: (sessionId: string) => {
          void this.host.resumeSession(sessionId).then(({ switched }) => {
            if (switched) this.hideSessionPicker();
          }).catch((error: unknown) => {
            this.host.showError(error instanceof Error ? error.message : String(error));
          });
        },
        onCancel,
        onDelete: (sessionId: string) => {
          const row = this.host.getSessions().find((s) => s.id === sessionId);
          if (row !== undefined && isChannelManagedSession(row.metadata)) {
            this.host.showStatus(t('dialog.channel_managed'));
            return;
          }
          void this.host.deleteSession(sessionId).then(async () => {
            await this.host.fetchSessions();
            if (this.host.getSessions().length === 0) {
              this.hideSessionPicker();
            } else if (this.host.state.activeDialog === 'session-picker') {
              this.mountSessionPicker(onCancel);
            }
          }).catch((error: unknown) => {
            this.host.showError(error instanceof Error ? error.message : String(error));
          });
        },
        onDeleteMany: (sessionIds: string[]) => {
          // Channel-managed sessions (the line daemon's) are skipped in batch
          // deletes; the picker
          // already excludes them from selection — belt-and-suspenders guard.
          const channelIds = new Set(
            this.host
              .getSessions()
              .filter((s) => isChannelManagedSession(s.metadata))
              .map((s) => s.id),
          );
          const deletable = sessionIds.filter((id) => !channelIds.has(id));
          if (deletable.length === 0) {
            this.host.showStatus(t('dialog.channel_managed'));
            return;
          }
          void (async () => {
            for (const id of deletable) {
              try {
                await this.host.deleteSession(id);
              } catch (error) {
                this.host.showError(
                  error instanceof Error ? error.message : String(error),
                );
                break; // stop on the first failure to avoid cascading errors
              }
            }
            await this.host.fetchSessions();
            if (this.host.getSessions().length === 0) {
              this.hideSessionPicker();
            } else if (this.host.state.activeDialog === 'session-picker') {
              this.mountSessionPicker(onCancel);
            }
          })().catch((error: unknown) => {
            this.host.showError(error instanceof Error ? error.message : String(error));
          });
        },
      }),
    );
  }

  // =========================================================================
  // Memory picker
  // =========================================================================
  showMemoryPicker(preloadedMemos?: MemoryMemoSummary[], preloadedTotal?: number): void {
    const store = sharedMemoStore(getDataDir());

    const hasData = preloadedMemos !== undefined;
    const component = new MemoryPickerComponent({
      store,
      memos: preloadedMemos ?? [],
      total: preloadedTotal ?? 0,
      loading: !hasData,
      colors: this.host.state.theme.colors,
      ui: this.host.state.ui,
      onDream: () => {
        this.memoryPicker = undefined;
        this.host.state.activeDialog = null;
        this.restoreEditor();
        this.host.startDream();
      },
      onUndoMerge: (memoId: string) => {
        void (async () => {
          const undone = await store.revertMerge(memoId);
          this.host.showStatus(t(undone ? 'memory.undo_merge_ok' : 'memory.undo_merge_none'));
          this.memoryPicker = undefined;
          this.showMemoryPicker();
        })();
      },
      onCancel: () => {
        this.memoryPicker = undefined;
        this.host.state.activeDialog = null;
        this.restoreEditor();
      },
      onInject: (memo: MemoryMemoSummary) => {
        this.host.sendNormalUserInput(formatMemoryMemoForInjection(memo));
        this.host.showStatus(t('dialog.memo_injected', { id: memo.id }));
        this.memoryPicker = undefined;
        this.host.state.activeDialog = null;
        this.restoreEditor();
      },
    });

    this.memoryPicker = component;
    this.host.state.activeDialog = 'memory-picker';
    this.mountEditorReplacement(component);

    // One async fill for this mount: memos (when not preloaded) and the dream
    // counters. Both land on the component that is actually on screen — a
    // second mount would race the first one, and the loser used to paint an
    // empty page over a loaded one (the panel looked empty after reopening).
    void (async () => {
      const stillMounted = (): boolean => this.memoryPicker === component;
      try {
        await store.init();
        if (!hasData) {
          const page = await store.list({ limit: 50 });
          if (!stillMounted()) return;
          component.setMemos(page.memos, page.total);
        }
        let distilled = 0;
        let pending = 0;
        let neverUsed = 0;
        try {
          for await (const memo of store.read()) {
            if ((memo.distilled ?? '').trim().length > 0) distilled += 1;
            if (memo.dreamedAt === undefined || memo.recordedAt > memo.dreamedAt) pending += 1;
            // Counted over the whole library, not the loaded page: the point of
            // the number is how much of the notebook recall has never surfaced.
            if ((memo.recallCount ?? 0) === 0) neverUsed += 1;
          }
        } catch {
          // Counters are a nicety: a store that cannot enumerate still gets the
          // "last dream" line rather than nothing at all.
        }
        if (!stillMounted()) return;
        const tracker = await this.host.readDreamTracker();
        if (!stillMounted()) return;
        component.setDreamStatus({
          distilled,
          pending,
          neverUsed,
          ...(tracker?.lastDreamAt === undefined ? {} : { lastAt: tracker.lastDreamAt }),
        });
      } catch {
        // An unreadable store or tracker just means no counters; the list is
        // whatever the component already had.
      }
    })();
  }

  hideMemoryPicker(): void {
    this.memoryPicker = undefined;
    this.host.state.activeDialog = null;
    this.restoreEditor();
  }

  /**
   * An approval or a question waits in this terminal: when the person is away
   * from it, the chat hears (see utils/terminal-reminders). Dropped once it is
   * answered — the live pane no longer holds it.
   */
  private remindWhileAway(kind: 'approval' | 'question', id: string, what: string | undefined): void {
    const { appState } = this.host.state;
    if (appState.sessionId === undefined || appState.sessionId === '') return;
    this.host.state.reminders.note({
      state: 'waiting',
      key: `${appState.sessionId}:${kind}:${id}`,
      title: appState.sessionTitle ?? undefined,
      workDir: appState.workDir,
      waitingFor: kind,
      ...(what === undefined ? {} : { what }),
      stillHolds: () =>
        kind === 'approval'
          ? this.host.state.livePane.pendingApproval?.data.id === id
          : this.host.state.livePane.pendingQuestion?.data.id === id,
    });
  }

  // =========================================================================
  // Approval panel
  // =========================================================================
  showApprovalPanel(payload: ApprovalPanelData): void {
    // Defensive: a second panel must not orphan the previous one's timer.
    this.activeApprovalPanel?.stop();
    this.host.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.host.state, `approval:${payload.id}`, {
      title: t('dialog.approval_title'),
      body: payload.tool_name,
    });
    this.remindWhileAway('approval', payload.id, payload.description || payload.action || payload.tool_name);
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        panel.stop();
        this.host.approvalController.respond(adaptPanelResponse(response));
      },
      this.host.state.theme.colors,
      () => {
        this.host.toggleToolOutputExpansion();
      },
      () => {
        this.host.togglePlanExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
      this.host.state.ui,
      () => panelViewportRows(this.host.state),
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  hideApprovalPanel(): void {
    if (this.approvalPreview !== undefined) {
      this.closeApprovalPreview();
    }
    this.activeApprovalPanel?.stop();
    this.activeApprovalPanel = undefined;
    this.host.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const savedLayoutRoot = this.host.state.layoutRoot;
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        colors: this.host.state.theme.colors,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.host.state.terminal,
    );
    // TuiAltScreen renders its layout root, not ui.children. Replace the
    // root with the full-screen viewer, and restore the main layout on close.
    this.host.state.ui.setLayoutRoot(viewer);
    this.host.state.ui.setFocus(viewer);
    this.host.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, savedLayoutRoot, panel };
  }
  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    this.host.state.ui.setLayoutRoot(preview.savedLayoutRoot);
    this.host.state.ui.setFocus(preview.panel);
    this.host.state.ui.requestRender(true);
  }

  // =========================================================================
  // Question dialog
  // =========================================================================
  showQuestionDialog(payload: QuestionPanelData): void {
    // Defensive: a second dialog must not orphan the previous one's timer.
    this.activeQuestionDialog?.stop();
    this.host.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.host.state, `question:${payload.id}`, {
      title: t('dialog.question_title'),
      body: payload.questions[0]?.question,
    });
    this.remindWhileAway('question', payload.id, undefined);
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        dialog.stop();
        this.host.questionController.respond(response);
      },
      this.host.state.theme.colors,
      undefined,
      () => {
        this.host.toggleToolOutputExpansion();
      },
      () => {
        this.host.togglePlanExpansion();
      },
      this.host.state.ui,
    );
    this.activeQuestionDialog = dialog;
    this.mountEditorReplacement(dialog);
  }

  hideQuestionDialog(): void {
    this.activeQuestionDialog?.stop();
    this.activeQuestionDialog = undefined;
    this.host.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }

}
