import {
  deleteAllKittyImages,
  type Component,
  getCapabilities,
  Spacer,
} from '@earendil-works/pi-tui';
import type { ApprovalRequest, ApprovalResponse } from '@scream-code/scream-code-sdk';
import chalk from 'chalk';

import { CompactionComponent } from '../components/dialogs/compaction';
import { WelcomeComponent } from '../components/chrome/welcome';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from '../components/messages/status-message';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { FusionPlanStatusComponent } from '../components/messages/fusion-plan-status';
import { CronMessageComponent } from '../components/messages/cron-message';
import { MoonLoader } from '../components/chrome/moon-loader';
import type { StreamingUIController } from './streaming-ui';
import type { TranscriptEntry, LoginProgressSpinnerHandle } from '../types';
import type { TUIState } from '../tui-state';
import { ImageAttachmentStore, type ImageAttachment } from '../utils/image-attachment-store';
import { truncateErrorMessage } from '../utils/event-payload';
import { replaceTabs } from '../utils/sanitize';
import { nextTranscriptId } from '../utils/transcript-id';
import { isExpandable, isPlanExpandable } from '../utils/component-capabilities';
import { isStreaming } from '../utils/app-state';
import { CommittedTranscriptComponent } from '../components/transcript/committed-transcript';
import { ReadGroupComponent, parseReadGroupOutput } from '../components/messages/read-group';

export interface TranscriptControllerHost {
  readonly state: TUIState;
  readonly imageStore: ImageAttachmentStore;
  readonly streamingUI: StreamingUIController;

  showStatus(message: string, color?: string): void;
  batchUpdate<T>(fn: () => T): T;
}
export class TranscriptController {
  private welcomeComponent: WelcomeComponent | undefined;
  private committedComponent: CommittedTranscriptComponent | undefined;
  private readonly liveComponentToEntry = new Map<Component, TranscriptEntry>();
  private readonly pendingComponents = new Set<Component>();

  private static readonly LIVE_LIMIT = 150;

  constructor(private readonly host: TranscriptControllerHost) {}

  stopWelcomeBreathing(): void {
    this.welcomeComponent?.stopBreathing();
  }

  findEntryForComponent(component: Component): TranscriptEntry | undefined {
    return this.liveComponentToEntry.get(component);
  }

  registerLiveComponent(component: Component, entry: TranscriptEntry): void {
    this.liveComponentToEntry.set(component, entry);
  }

  markPending(component: Component): void {
    this.pendingComponents.add(component);
  }

  unmarkPending(component: Component): void {
    this.pendingComponents.delete(component);
  }

  getCommittedCount(): number {
    return this.committedComponent?.getCount() ?? 0;
  }

  getLiveCount(): number {
    return this.host.state.transcriptContainer.children.length;
  }

  commit(): void {
    this.host.batchUpdate(() => {
      const { state } = this.host;
      // Don't fold history while a turn is actively streaming. Committing mid-turn
      // collapses the transcript height and triggers viewport jumps. We fold once
      // when the turn fully settles instead.
      if (isStreaming(state.appState)) return;
      const container = state.transcriptContainer;
      const children = container.children;
      if (children.length <= TranscriptController.LIVE_LIMIT) return;

      const toCommit: { component: Component; entry: TranscriptEntry }[] = [];
      for (const child of children) {
        if (this.pendingComponents.has(child)) continue;
        if (child === this.welcomeComponent) continue;
        if (child === this.committedComponent) continue;
        const entry = this.liveComponentToEntry.get(child);
        if (entry === undefined) continue;
        if (children.length - toCommit.length <= TranscriptController.LIVE_LIMIT) break;
        toCommit.push({ component: child, entry });
      }

      if (toCommit.length === 0) return;

      if (this.committedComponent === undefined) {
        this.committedComponent = new CommittedTranscriptComponent(state.theme.colors);
        container.children.unshift(this.committedComponent);
      }

      for (const { component, entry } of toCommit) {
        this.committedComponent.appendEntry(entry, state.theme.colors);
        container.removeChild(component);
        this.liveComponentToEntry.delete(component);
      }

      this.committedComponent.setCount(this.committedComponent.getCount() + toCommit.length);
      if (process.env['SCREAM_CODE_DEBUG'] === '1') {
        this.host.showStatus(
          `[debug] committed=${this.committedComponent.getCount()} live=${this.getLiveCount()}`,
        );
      }
      container.invalidate();
      state.ui.requestRender();
    });
  }
  private createComponent(entry: TranscriptEntry): Component | null {
    const { state, imageStore } = this.host;

    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(
        state.theme.colors,
        state.ui,
        data.instruction,
      );
      block.markDone(data.tokensBefore, data.tokensAfter);
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        return new UserMessageComponent(entry.content, state.theme.colors, images);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          state.theme.colors,
          entry.skillTrigger,
        );
      case 'assistant': {
        const component = new AssistantMessageComponent(
          state.theme.markdownTheme,
          state.theme.colors,
        );
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, state.theme.colors, true);
        if (state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call': {
        if (entry.toolCallData?.name === 'ReadGroup' && entry.toolCallData.result !== undefined) {
          const rgc = new ReadGroupComponent(state.theme.colors, state.ui);
          rgc.setResults(parseReadGroupOutput(entry.toolCallData.result.output));
          return rgc;
        }
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            state.theme.colors,
            state.ui,
            state.theme.markdownTheme,
            state.appState.workDir,
          );
          if (state.toolOutputExpanded) tc.setExpanded(true);
          if (state.planExpanded) tc.setPlanExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            state.theme.colors,
          );
        }
        if (entry.fusionPlanStatus !== undefined) {
          return new FusionPlanStatusComponent(entry.fusionPlanStatus, state.theme.colors, state.ui);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail, state.theme.colors)
          : new StatusMessageComponent(entry.content, state.theme.colors, entry.color);
      }
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            state.theme.colors,
          );
        }
        if (entry.fusionPlanStatus !== undefined) {
          return new FusionPlanStatusComponent(entry.fusionPlanStatus, state.theme.colors, state.ui);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail, state.theme.colors)
          : new StatusMessageComponent(entry.content, state.theme.colors, entry.color);
      case 'cron': {
        if (entry.cronData === undefined) return null;
        return new CronMessageComponent(entry.content, entry.cronData, state.theme.colors);
      }
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendEntry(entry: TranscriptEntry): Component | null {
    this.host.state.transcriptEntries.push(entry);
    const component = this.createComponent(entry);
    if (component) {
      this.liveComponentToEntry.set(component, entry);
      this.host.state.transcriptContainer.addChild(component);
      this.host.state.ui.requestRender();
    }
    return component ?? null;
  }

  appendApprovalEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    if (request.toolName === 'ExitPlanMode' || request.display.kind === 'plan_review') return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(response.scope === 'session' ? '已批准（当前会话）' : '已批准');
        break;
      case 'rejected':
        parts.push('已拒绝');
        break;
      case 'cancelled':
        parts.push('已取消');
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendEntry({
      id: nextTranscriptId(),
      kind: 'status',
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  renderWelcome(): void {
    const { state } = this.host;
    this.welcomeComponent?.stopBreathing();
    const welcome = new WelcomeComponent(
      state.appState,
      state.theme.colors,
      state.ui,
      state.appState.recentSessions,
    );
    welcome.borderTitle = 'Scream Code';
    this.welcomeComponent = welcome;
    // Once the user has typed anything (even a single character), breathing
    // stays off forever — even across session switches.  This prevents the
    // logo colour cycle from re-triggering expensive full-tree renders when
    // the transcript is packed with replayed historical components.
    if (state.editor.hasFirstInputFired()) {
      welcome.stopBreathing();
    }
    state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.host.state.terminal.write(deleteAllKittyImages());
  }

  clearAndRedraw(): void {
    const { state, streamingUI, imageStore } = this.host;
    streamingUI.discardPending();
    state.transcriptEntries = [];
    streamingUI.disposeActiveCompactionBlock();
    streamingUI.resetLiveText();
    streamingUI.resetToolUi();
    this.welcomeComponent?.stopBreathing();
    this.welcomeComponent = undefined;
    this.committedComponent = undefined;
    this.liveComponentToEntry.clear();
    this.pendingComponents.clear();
    state.transcriptContainer.clear();
    this.clearTerminalInlineImages();
    state.todoPanel.clear();
    state.todoPanelContainer.clear();
    state.errorBanner.clear();
    imageStore.clear();
    this.renderWelcome();
  }

  showStatus(message: string, color?: string): void {
    this.host.state.transcriptContainer.addChild(
      new StatusMessageComponent(message, this.host.state.theme.colors, color),
    );
    this.host.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.host.state.transcriptContainer.addChild(
      new NoticeMessageComponent(title, detail, this.host.state.theme.colors),
    );
    this.host.state.ui.requestRender();
  }

  showError(message: string): void {
    const cleaned = replaceTabs(message);
    // Transcript keeps the fuller (8-line) error for history/replay.
    this.showStatus(`错误：${truncateErrorMessage(cleaned)}`, this.host.state.theme.colors.error);
    // Banner shows a tighter (3-line) preview pinned above the input so a
    // turn-ending error can't scroll out of view before the user returns.
    this.host.state.errorBanner.setMessage(cleaned);
    this.host.state.ui.requestRender();
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => chalk.hex(this.host.state.theme.colors.primary)(s);
    const spinner = new MoonLoader(this.host.state.ui, 'braille', tint, label);
    const spacer = new Spacer(1);
    const container = this.host.state.transcriptContainer;
    container.addChild(spacer);
    container.addChild(spinner);
    this.host.state.ui.requestRender();
    return {
      setLabel: (label: string) => {
        spinner.setLabel(label);
      },
      stop: ({ ok, label: finalLabel }: { ok: boolean; label: string }) => {
        spinner.stop();
        container.removeChild(spacer);
        container.removeChild(spinner);
        container.invalidate();
        const tone = ok ? this.host.state.theme.colors.success : this.host.state.theme.colors.error;
        this.showStatus(finalLabel, tone);
      },
    };
  }

  toggleToolOutputExpansion(): void {
    const { state } = this.host;
    state.toolOutputExpanded = !state.toolOutputExpanded;
    const walk = (children: readonly Component[]): void => {
      for (const child of children) {
        if (isExpandable(child)) {
          child.setExpanded(state.toolOutputExpanded);
        }
        if ('children' in child && Array.isArray((child as { children?: unknown }).children)) {
          walk((child as { children: readonly Component[] }).children);
        }
      }
    };
    walk(state.transcriptContainer.children);
    state.ui.requestRender();
  }

  togglePlanExpansion(): boolean {
    const { state } = this.host;
    const next = !state.planExpanded;
    let toggled = false;
    for (const child of state.transcriptContainer.children) {
      if (isPlanExpandable(child) && child.setPlanExpanded(next)) {
        toggled = true;
      }
    }
    if (!toggled) return false;
    state.planExpanded = next;
    state.ui.requestRender();
    return true;
  }

  // Package-visible helpers for ScreamTUI to reach specific components.
  getWelcomeComponent(): WelcomeComponent | undefined {
    return this.welcomeComponent;
  }

  setWelcomeComponent(component: WelcomeComponent | undefined): void {
    this.welcomeComponent = component;
  }
}
