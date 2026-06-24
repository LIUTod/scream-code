import type {
  AutocompleteItem,
  SlashCommand,
} from '@earendil-works/pi-tui';
import type { Session } from '@scream-code/scream-code-sdk';

import {
  dispatchInput,
  handlePlanCommand,
  type ScreamSlashCommand,
  type SlashCommandHost,
} from '../commands';
import { FileMentionProvider } from '../components/editor/file-mention-provider';
import { QueuePaneComponent } from '../components/panes/queue-pane';
import { LLM_NOT_SET_MESSAGE, MAIN_AGENT_ID } from '../constant/scream-tui';
import type {
  QueuedMessage,
  SendMessageOptions,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';
import { formatErrorMessage } from '../utils/event-payload';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import { extractMediaAttachments } from '../utils/image-placeholder';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { getInputHistoryFile } from '#/utils/paths';
import { nextTranscriptId } from '../utils/transcript-id';
import chalk from 'chalk';

// ── Idle breathing gradient for the input box border ──────────────────

const BREATHE_FRAMES = 120;
const BREATHE_INTERVAL_MS = 40;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
  else if (max === gf) h = ((bf - rf) / d + 2) / 6;
  else h = ((rf - gf) / d + 4) / 6;
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  const sf = s / 100, lf = l / 100;
  const c = (1 - Math.abs(2 * lf - 1)) * sf;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lf - c / 2;
  let rf = 0, gf = 0, bf = 0;
  if (h < 60) { rf = c; gf = x; }
  else if (h < 120) { rf = x; gf = c; }
  else if (h < 180) { gf = c; bf = x; }
  else if (h < 240) { gf = x; bf = c; }
  else if (h < 300) { rf = x; bf = c; }
  else { rf = c; bf = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(rf)}${toHex(gf)}${toHex(bf)}`;
}

export interface InputControllerHost extends SlashCommandHost {
  state: TUIState;
  readonly imageStore: ImageAttachmentStore;

  stopMemoryIdleTimer(): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  getSlashCommands(): readonly ScreamSlashCommand[];
  stopWelcomeBreathing(): void;
  updateQueueDisplay(): void;
}

export class InputController {
  private lastHistoryContent: string | undefined;
  private breatheTimer: ReturnType<typeof setInterval> | null = null;
  private breatheFrame = 0;
  /** Once the user types, breathing stops permanently (same as welcome). */
  private breatheOnceStopped = false;

  constructor(private readonly host: InputControllerHost) {}

  setupAutocomplete(): void {
    const visible = this.host.getSlashCommands().filter((cmd) => !cmd.name.startsWith('skill:'));
    const slashCommands: (AutocompleteItem | SlashCommand)[] = visible.map((cmd) => ({
      value: cmd.name,
      label: `/${cmd.name} — ${cmd.description}`,
    }));
    const { state } = this.host;
    const provider = new FileMentionProvider(
      slashCommands,
      state.appState.workDir,
      state.fdPath,
      state.gitLsFilesCache,
    );
    state.editor.setAutocompleteProvider(provider);
    state.editor.onFirstInput = () => {
      this.host.stopWelcomeBreathing();
      this.#permanentlyStopBreathing();
    };
    // Start idle breathing immediately (editor is empty on mount).
    if (!this.host.state.appState.planMode) {
      this.#startBreathing();
    }
  }

  handleInput(text: string): void {
    if (text.trim().length === 0) return;
    if (this.host.state.appState.isReplaying) {
      this.host.showError('会话历史正在回放时无法发送输入。');
      return;
    }
    void this.persistInputHistory(text);
    dispatchInput(this.host, text);
    this.host.stopMemoryIdleTimer();
  }

  sendNormalUserInput(text: string): void {
    if (this.host.state.appState.model.trim().length === 0) {
      this.host.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    const extraction = extractMediaAttachments(text, this.host.imageStore);
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = this.host.session;
    if (session === undefined) {
      this.host.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.host.updateQueueDisplay();
    this.host.state.ui.requestRender();
  }

  steerMessage(session: Session, input: string[]): void {
    if (this.host.deferUserMessages || this.host.state.appState.isCompacting) {
      for (const part of input) {
        this.enqueueMessage(part);
      }
      return;
    }
    if (this.host.state.appState.streamingPhase === 'idle') {
      for (const part of input) {
        this.sendMessageInternal(session, part);
      }
      return;
    }

    for (const part of input) {
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.host.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: part,
      });
    }

    this.host.state.errorBanner.clear();
    void session.steer(input.join('\n\n')).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(`引导失败：${message}`);
    });
  }

  handlePlanToggle(next: boolean): void {
    void handlePlanCommand(this.host, next ? 'on' : 'off');
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.host.state.editor.getText()).trimStart();
    const isPlan = this.host.state.appState.planMode;
    const isEmpty = trimmed.length === 0;

    if (isEmpty && !isPlan && !this.breatheOnceStopped) {
      this.#startBreathing();
    } else {
      this.#stopBreathing();
      const colorToken = isPlan
        ? this.host.state.theme.colors.planMode
        : this.host.state.theme.colors.primary;
      this.host.state.editor.borderColor = (s: string) => chalk.hex(colorToken)(s);
      this.host.state.ui.requestRender();
    }
  }

  /** Stop the idle breathing timer. Safe to call when not breathing. */
  dispose(): void {
    this.#stopBreathing();
  }

  // ── Breathing animation ────────────────────────────────────────────

  #permanentlyStopBreathing(): void {
    this.breatheOnceStopped = true;
    this.#stopBreathing();
    // Fall back to static green.
    const colorToken = this.host.state.theme.colors.primary;
    this.host.state.editor.borderColor = (s: string) => chalk.hex(colorToken)(s);
    this.host.state.ui.requestRender();
  }

  #startBreathing(): void {
    if (this.breatheTimer) return;
    if (this.breatheOnceStopped) return;
    const primaryHex = this.host.state.theme.colors.primary;
    const [r, g, b] = hexToRgb(primaryHex);
    const [baseHue] = rgbToHsl(r, g, b);
    this.breatheFrame = 0;
    const editor = this.host.state.editor;
    const ui = this.host.state.ui;
    this.breatheTimer = setInterval(() => {
      const hue = (baseHue + (this.breatheFrame / BREATHE_FRAMES) * 360) % 360;
      const hex = hslToHex(hue, 90, 70);
      editor.borderColor = (s: string) => chalk.hex(hex)(s);
      ui.requestRender();
      this.breatheFrame = (this.breatheFrame + 1) % BREATHE_FRAMES;
    }, BREATHE_INTERVAL_MS);
  }

  #stopBreathing(): void {
    if (!this.breatheTimer) return;
    clearInterval(this.breatheTimer);
    this.breatheTimer = null;
  }

  updateQueueDisplay(): void {
    this.host.state.queueContainer.clear();
    const queued = this.host.state.queuedMessages;
    if (queued.length === 0) return;

    this.host.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        colors: this.host.state.theme.colors,
        isCompacting: this.host.state.appState.isCompacting,
        isStreaming: this.host.state.appState.streamingPhase !== 'idle',
        canSteerImmediately: !this.host.deferUserMessages,
      }),
    );
  }

  async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.host.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.host.state.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.host.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.host.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  private enqueueMessage(text: string, options?: SendMessageOptions): void {
    this.host.state.queuedMessages.push({
      text,
      agentId: this.host.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
    });
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    this.host.state.errorBanner.clear();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    });

    this.host.beginSessionRequest();

    void session.prompt(options?.parts ?? input).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.failSessionRequest(`发送失败：${message}`);
    });
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    this.host.harness.interactiveAgentId = item.agentId ?? MAIN_AGENT_ID;
    this.sendMessageInternal(session, item.text, {
      parts: item.parts,
      imageAttachmentIds: item.imageAttachmentIds,
    });
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    if (
      this.host.deferUserMessages ||
      this.host.state.appState.streamingPhase !== 'idle' ||
      this.host.state.appState.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  private validateMediaCapabilities(
    extraction: ReturnType<typeof extractMediaAttachments>,
  ): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.host.showError('当前模型不支持图片输入。');
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.host.showError('当前模型不支持视频输入。');
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.host.state.appState.availableModels[this.host.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }
}
