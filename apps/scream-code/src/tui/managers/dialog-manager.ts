import type { Component, Focusable } from '@earendil-works/pi-tui';
import type {
  ApprovalResponse,
  Session,
} from '@scream-cli/scream-code-sdk';
import { MemoryMemoStore, resolveProjectDir, type MemoryMemoSummary } from '@scream-cli/memory';
import { getDataDir } from '#/utils/paths';
import type { TUIState } from '../tui-state';
import { ApprovalPanelComponent, type ApprovalPanelResponse } from '../components/dialogs/approval-panel';
import { ApprovalPreviewViewer, type ApprovalPreviewBlock } from '../components/dialogs/approval-preview';
import { HelpPanelComponent, type HelpPanelCommand } from '../components/dialogs/help-panel';
import { MemoryPickerComponent } from '../components/dialogs/memory-picker';
import { SessionPickerComponent, type SessionRow } from '../components/dialogs/session-picker';
import { QuestionDialogComponent } from '../components/dialogs/question-dialog';
import { formatMemoryMemoForInjection } from '../commands/memory';
import { sessionRowsForPicker } from '../utils/session-picker-rows';
import { adaptPanelResponse } from '../reverse-rpc/approval/adapter';
import type { ApprovalController } from '../reverse-rpc/approval/controller';
import type { QuestionController } from '../reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '../reverse-rpc/types';

export interface DialogManagerHost {
  readonly state: TUIState;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;

  showError(message: string): void;
  showStatus(message: string, color?: string): void;
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
  showSessionPicker(): void {
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
    this.host.state.activeDialog = 'session-picker';
    this.mountEditorReplacement(
      new SessionPickerComponent({
        sessions: this.host.getSessions() as any,
        loading: this.host.getIsLoadingSessions(),
        currentSessionId: this.host.getCurrentSessionId(),
        colors: this.host.state.theme.colors,
        onSelect: (pickerId: string) => {
          const row = (this.host.getSessions() as any[]).find((s) => s.id === pickerId);
          const isCc = row?.metadata?.['source'] === 'cc-connect';
          const realId = isCc ? (row!.metadata!['agentSessionId'] as string) : pickerId;

          void this.host.resumeSession(realId).then(async (switched) => {
            if (switched) {
              this.hideSessionPicker();
              return;
            }
            if (isCc) {
              try {
                const session = await (this.host as any).harness?.createSession?.({
                  id: realId,
                  workDir: this.host.getCurrentWorkDir(),
                  model: (this.host as any).state?.appState?.model,
                  permission: (this.host as any).state?.appState?.permissionMode,
                });
                if (session) {
                  await this.host.switchToSession(session, `已连接 CC 会话 (${session.id})。`);
                  this.hideSessionPicker();
                }
              } catch (err) {
                this.host.showError(`创建会话失败`);
              }
            }
          });
        },
        onCancel,
        onDelete: (sessionId: string) => {
          const row = (this.host.getSessions() as any[]).find((s) => s.id === sessionId);
          if (row?.metadata?.['source'] === 'cc-connect') {
            this.host.showStatus('CC 会话由 cc-connect 管理，请在聊天通道中操作。');
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
  showMemoryPicker(): void {
    const store = new MemoryMemoStore(
      resolveProjectDir(getDataDir(), this.host.getCurrentWorkDir()),
    );
    let memos: MemoryMemoSummary[] = [];
    let total = 0;
    try {
      // list is async — fire it but show picker immediately with empty list
      void store.list({ limit: 50 }).then((result) => {
        memos = result.memos;
        total = result.total;
        // re-render if picker is still open
        if (this.host.state.activeDialog === 'memory-picker') {
          this.showMemoryPicker();
        }
      });
    } catch {
      // show empty list on error
    }

    this.host.state.activeDialog = 'memory-picker';
    this.mountEditorReplacement(
      new MemoryPickerComponent({
        store,
        memos,
        total,
        loading: false,
        colors: this.host.state.theme.colors,
        onCancel: () => {
          this.host.state.activeDialog = null;
          this.restoreEditor();
        },
        onInject: (memo) => {
          this.host.sendNormalUserInput(formatMemoryMemoForInjection(memo));
          this.host.showStatus(`已注入备忘录 #${memo.id}`);
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
    this.host.state.livePane = {
      ...this.host.state.livePane,
      pendingApproval: { data: payload },
    };
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
    this.host.state.livePane = {
      ...this.host.state.livePane,
      pendingApproval: null,
    };
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
    this.host.state.livePane = {
      ...this.host.state.livePane,
      pendingQuestion: { data: payload },
    };
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
    this.host.state.livePane = {
      ...this.host.state.livePane,
      pendingQuestion: null,
    };
    this.restoreEditor();
  }

  // =========================================================================
  // Cleanup
  // =========================================================================
  clearAllPanels(): void {
    if (this.approvalPreview !== undefined) {
      this.closeApprovalPreview();
    }
    this.activeApprovalPanel = undefined;
  }
}
