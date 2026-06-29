import type { Session } from '@scream-code/scream-code-sdk';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  EXIT_CONFIRM_WINDOW_MS,
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
} from '../constant/scream-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { isBusy, isStreaming } from '../utils/app-state';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import type { AppState, PendingExit, PlanModeState, QueuedMessage } from '../types';
import type { TUIState } from '../tui-state';

export interface EditorKeyboardHost {
  state: TUIState;
  session: Session | undefined;
  cancelInFlight: (() => void) | undefined;

  setAppState(patch: Partial<AppState>): void;
  showStatus(msg: string, color?: string): void;

  readonly inputController: { handleInput(text: string): void };
  steerMessage(session: Session, input: string[]): void;
  recallLastQueued(): string | undefined;
  showError(msg: string): void;
  updateEditorBorderHighlight(text?: string): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  togglePlanExpansion(): boolean;
  hideSessionPicker(): void;
  stop(exitCode?: number): Promise<void>;
  handlePlanModeStateChange(state: PlanModeState): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
  cancelPendingMemoryExtraction(): void;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    editor.onSubmit = (text: string) => {
      host.inputController.handleInput(text);
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      host.updateEditorBorderHighlight(text);
    };

    editor.onCtrlC = () => {
      if (host.cancelInFlight !== undefined) {
        const cancel = host.cancelInFlight;
        host.cancelInFlight = undefined;
        this.clearPendingExit();
        cancel();
        return;
      }

      if (host.state.appState.isCompacting) {
        this.clearPendingExit();
        this.cancelCurrentCompaction();
        return;
      }

      if (isStreaming(host.state.appState)) {
        this.clearPendingExit();
        this.cancelCurrentStream();
        return;
      }

      if (this.pendingExit?.kind === 'ctrl-c') {
        this.clearPendingExit();
        void host.stop();
        return;
      }

      if (editor.getText().length > 0) {
        editor.setText('');
      }
      this.armPendingExit('ctrl-c', CTRL_C_HINT);
    };

    editor.onCtrlD = () => {
      if (this.pendingExit?.kind === 'ctrl-d') {
        this.clearPendingExit();
        void host.stop();
        return;
      }
      this.armPendingExit('ctrl-d', CTRL_D_HINT);
    };

    editor.onEscape = () => {
      if (this.pendingExit) this.clearPendingExit();
      if (host.state.activeDialog === 'session-picker') {
        host.hideSessionPicker();
        return;
      }
      if (host.state.appState.isCompacting) {
        this.cancelCurrentCompaction();
        return;
      }
      if (isStreaming(host.state.appState)) {
        this.cancelCurrentStream();
        return;
      }
      // 如果循环模式正在等待自动重发，则暂停当前迭代，但不完全关闭循环模式。
      if (host.state.appState.loopModeEnabled && host.state.appState.loopPrompt) {
        host.setAppState({ loopPrompt: undefined });
        host.showStatus('循环已暂停。输入 /loop <提示词> 恢复或修改。');
      }
    };

    editor.onShiftTab = () => {
      if (host.session === undefined) {
        host.showError(NO_ACTIVE_SESSION_MESSAGE);
        return;
      }
      const current = host.state.appState.planMode;
      const next: PlanModeState =
        current === 'off' ? 'plan' : current === 'plan' ? 'fusionplan' : 'off';
      host.handlePlanModeStateChange(next);
    };

    editor.onOpenExternalEditor = () => {
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      host.toggleToolOutputExpansion();
    };

    editor.onTogglePlanExpand = () => host.togglePlanExpansion();

    editor.onCtrlS = () => {
      if (!isBusy(host.state.appState)) return;
      const text = editor.getText().trim();
      const queuedTexts = host.state.queuedMessages.map((m: QueuedMessage) => m.text);
      host.clearQueuedMessages();

      const parts: string[] = [];
      for (const q of queuedTexts) {
        const trimmed = q.trim();
        if (trimmed.length > 0) parts.push(trimmed);
      }
      if (text.length > 0) parts.push(text);

      if (parts.length > 0) {
        editor.setText('');
        const session = host.session;
        if (host.state.appState.model.trim().length === 0 || session === undefined) {
          host.showError(LLM_NOT_SET_MESSAGE);
        } else {
          host.steerMessage(session, parts);
        }
      }
      host.updateQueueDisplay();
      host.state.ui.requestRender();
    };

    editor.onCtrlW = () => {
      host.cancelPendingMemoryExtraction();
    };

    editor.onUpArrowEmpty = () => {
      if (!isBusy(host.state.appState)) return false;
      const recalled = host.recallLastQueued();
      if (recalled !== undefined) {
        editor.setText(recalled);
        host.updateQueueDisplay();
        host.state.ui.requestRender();
        return true;
      }
      return false;
    };

    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  private armPendingExit(kind: 'ctrl-c' | 'ctrl-d', hint: string): void {
    this.clearPendingExit();
    this.host.state.footer.setTransientHint(hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
        this.host.state.ui.requestRender();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
    this.host.state.ui.requestRender();
  }

  private cancelCurrentStream(): void {
    void this.host.session?.cancel();
  }

  private cancelCurrentCompaction(): void {
    const session = this.host.session;
    if (session === undefined) return;
    void session.cancelCompaction().catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(`取消压缩失败： ${message}`);
    });
  }

  private async handleClipboardImagePaste(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.host.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;

    if (media.kind === 'video') {
      const attachment = this.imageStore.addVideo(media.mimeType, media.sourcePath, media.filename);
      this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
      this.host.state.ui.requestRender();
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;
    const attachment = this.imageStore.addImage(media.bytes, meta.mime, meta.width, meta.height);
    this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.host.state.ui.requestRender();
    return true;
  }

  private async openExternalEditor(): Promise<void> {
    const { state } = this.host;
    if (state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(state.appState.editorCommand);
    if (cmd === undefined) {
      this.host.showError('未配置编辑器。请设置 $VISUAL / $EDITOR，或运行 /editor <命令>。');
      return;
    }
    this.host.setExternalEditorRunning(true);
    const seed = state.editor.getExpandedText?.() ?? state.editor.getText();
    state.ui.stop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        state.editor.setText(result.replaceAll('\r\n', '\n').replace(/\n$/, ''));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`外部编辑器失败： ${msg}`);
    } finally {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      state.ui.start();
      state.ui.setFocus(state.editor);
      state.ui.requestRender(true);
      this.host.setExternalEditorRunning(false);
    }
  }
}
