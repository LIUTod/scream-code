import type { Component, Focusable } from '@earendil-works/pi-tui';
import type {
  ScreamHarness,
  Session,
} from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { MemoryMemoStore, type MemoryMemoSummary } from '@scream-code/memory';
import { getDataDir } from '#/utils/paths';
import type { TUIState } from '../tui-state';
import type { LivePaneState } from '../types';
import { ApprovalPanelComponent, type ApprovalPanelResponse } from '../components/dialogs/approval-panel';
import { ApprovalPreviewViewer, type ApprovalPreviewBlock } from '../components/dialogs/approval-preview';
import { HelpPanelComponent, type HelpPanelCommand } from '../components/dialogs/help-panel';
import { MemoryPickerComponent } from '../components/dialogs/memory-picker';
import { SessionPickerComponent, type SessionRow } from '../components/dialogs/session-picker';
import { QuestionDialogComponent } from '../components/dialogs/question-dialog';
import { formatMemoryMemoForInjection } from '../commands/memory';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { adaptPanelResponse } from '../reverse-rpc/approval/adapter';
import type { ApprovalController } from '../reverse-rpc/approval/controller';
import type { QuestionController } from '../reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '../reverse-rpc/types';

export interface DialogManagerHost {
  readonly state: TUIState;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  readonly harness: ScreamHarness;

  showError(message: string): void;
  showStatus(message: string, color?: string): void;
  /** 退出 /tasks 等全屏接管组件,让后续 editor 替换能挂载到真实容器。 */
  exitFullScreenTakeover(): void;
  sendNormalUserInput(text: string): void;
  resumeSession(sessionId: string): Promise<boolean>;
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
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        savedChildren: readonly Component[];
        panel: ApprovalPanelComponent;
      }
    | undefined;

  constructor(private readonly host: DialogManagerHost) {}

  // =========================================================================
  // Editor replacement primitives
  // =========================================================================
  private mountEditorReplacement(panel: Component & Focusable): void {
    this.host.exitFullScreenTakeover();
    this.host.state.editorContainer.clear();
    this.host.state.editorContainer.addChild(panel);
    this.host.state.ui.setFocus(panel);
    this.host.state.ui.requestRender();
  }

  private restoreEditor(): void {
    this.host.state.editorContainer.clear();
    this.host.state.editorContainer.addChild(this.host.state.editor);
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender();
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
        onSelect: (pickerId: string) => {
          const row = this.host.getSessions().find((s) => s.id === pickerId);
          const isCc = row?.metadata?.['source'] === 'cc-connect';
          const realId = isCc ? (row.metadata['agentSessionId'] as string) : pickerId;

          void this.host.resumeSession(realId).then(async (switched) => {
            if (switched) {
              this.hideSessionPicker();
              return;
            }
            if (isCc) {
              try {
                const session = await this.host.harness.createSession({
                  id: realId,
                  workDir: this.host.getCurrentWorkDir(),
                  model: this.host.state.appState.model,
                  permission: this.host.state.appState.permissionMode,
                });
                if (session) {
                  await this.host.switchToSession(session, t('dialog.cc_session_connected', { id: session.id }));
                  this.hideSessionPicker();
                }
              } catch {
                this.host.showError(t('dialog.create_session_failed'));
              }
            }
          });
        },
        onCancel,
        onDelete: (sessionId: string) => {
          const row = this.host.getSessions().find((s) => s.id === sessionId);
          if (row?.metadata?.['source'] === 'cc-connect') {
            this.host.showStatus(t('dialog.cc_managed'));
            return;
          }
          void this.host.deleteSession(sessionId).then(async () => {
            await this.host.fetchSessions();
            if (this.host.getSessions().length === 0) {
              this.hideSessionPicker();
            } else if (this.host.state.activeDialog === 'session-picker') {
              this.mountSessionPicker(onCancel);
            }
          });
        },
      }),
    );
  }

  // =========================================================================
  // Memory picker
  // =========================================================================
  showMemoryPicker(
    preloadedMemos?: MemoryMemoSummary[],
    preloadedTotal?: number,
  ): void {
    const store = new MemoryMemoStore(getDataDir());

    const hasData = preloadedMemos !== undefined;
    const memos = preloadedMemos ?? [];
    const total = preloadedTotal ?? 0;

    if (!hasData) {
      void store.init().then(async () => {
        try {
          const result = await store.list({ limit: 50 });
          if (this.host.state.activeDialog === 'memory-picker') {
            this.showMemoryPicker(result.memos, result.total);
          }
        } catch { /* ignore */ }
      });
    }

    this.host.state.activeDialog = 'memory-picker';
    this.mountEditorReplacement(
      new MemoryPickerComponent({
        store,
        memos,
        total,
        loading: !hasData,
        colors: this.host.state.theme.colors,
        ui: this.host.state.ui,
        onCancel: () => {
          this.host.state.activeDialog = null;
          this.restoreEditor();
        },
        onInject: (memo) => {
          this.host.sendNormalUserInput(formatMemoryMemoForInjection(memo));
          this.host.showStatus(t('dialog.memo_injected', { id: memo.id }));
          this.host.state.activeDialog = null;
          this.restoreEditor();
        },
      }),
    );
  }

  hideMemoryPicker(): void {
    this.host.state.activeDialog = null;
    this.restoreEditor();
  }

  // =========================================================================
  // Approval panel
  // =========================================================================
  showApprovalPanel(payload: ApprovalPanelData): void {
    this.host.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.host.state, `approval:${payload.id}`, {
      title: t('dialog.approval_title'),
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
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
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  hideApprovalPanel(): void {
    if (this.approvalPreview !== undefined) {
      this.closeApprovalPreview();
    }
    this.activeApprovalPanel = undefined;
    this.host.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const savedChildren = [...this.host.state.ui.children];
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
    this.host.state.ui.clear();
    this.host.state.ui.addChild(viewer);
    this.host.state.ui.setFocus(viewer);
    this.host.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, savedChildren, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    this.host.state.ui.clear();
    for (const child of preview.savedChildren) {
      this.host.state.ui.addChild(child);
    }
    this.host.state.ui.setFocus(preview.panel);
    this.host.state.ui.requestRender(true);
  }

  // =========================================================================
  // Question dialog
  // =========================================================================
  showQuestionDialog(payload: QuestionPanelData): void {
    this.host.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.host.state, `question:${payload.id}`, {
      title: t('dialog.question_title'),
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
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
    );
    this.mountEditorReplacement(dialog);
  }

  hideQuestionDialog(): void {
    this.host.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }

}
