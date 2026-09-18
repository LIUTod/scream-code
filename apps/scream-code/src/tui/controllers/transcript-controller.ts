import {
  deleteAllKittyImages,
  type Component,
  getCapabilities,
  Spacer,
} from '@liutod-scream/pi-tui';
import type { ApprovalRequest, ApprovalResponse } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
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
import { CronMessageComponent } from '../components/messages/cron-message';
import { MoonLoader } from '../components/chrome/moon-loader';
import type { StreamingUIController } from './streaming-ui';
import type { TranscriptEntry, LoginProgressSpinnerHandle } from '../types';
import type { TUIState } from '../tui-state';
import { ImageAttachmentStore, type ImageAttachment } from '../utils/image-attachment-store';
import { truncateErrorMessage } from '../utils/event-payload';
import { replaceTabs } from '../utils/sanitize';
import { disposeChildren, hasDispose, isExpandable, isPlanExpandable } from '../utils/component-capabilities';
import { buildApprovalNotice } from '../utils/approval-notice';
import { isStreaming } from '../utils/app-state';
import { CommittedTranscriptComponent } from '../components/transcript/committed-transcript';

export interface TranscriptControllerHost {
  readonly state: TUIState;
  readonly imageStore: ImageAttachmentStore;
  readonly streamingUI: StreamingUIController;

  showStatus(message: string, color?: string): void;
  batchUpdate<T>(fn: () => T): T;
  /** Force a status-bar refresh (e.g. to re-show the empty-session hint after
   *  the transcript was cleared, even when the activity mode is unchanged). */
  forceUpdateStatusBar(): void;
}
export class TranscriptController {
  private welcomeComponent: WelcomeComponent | undefined;
  private committedComponent: CommittedTranscriptComponent | undefined;
  private readonly liveComponentToEntry = new Map<Component, TranscriptEntry>();
  /** Live `started` notice cards by task id, so the terminal notice can stop the
   *  ticker of the card that is still claiming the task is running. */
  private readonly liveNoticesByTrackingId = new Map<string, BackgroundAgentStatusComponent>();
  private readonly pendingComponents = new Set<Component>();

  /** Max live transcript children before the oldest are folded into the
   *  committed single-line summary. Overridable via SCREAM_TRANSCRIPT_LIVE_LIMIT
   *  (mirrors a commit-fold approach for bounding ultra-long sessions). */
  private static readonly LIVE_LIMIT =
    Number.isFinite(Number(process.env['SCREAM_TRANSCRIPT_LIVE_LIMIT'])) &&
    Number(process.env['SCREAM_TRANSCRIPT_LIVE_LIMIT']) > 0
      ? Math.floor(Number(process.env['SCREAM_TRANSCRIPT_LIVE_LIMIT']))
      : 150;

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

  /**
   * Drops the entry mapping of a component that will never be folded into the
   * committed history (it is not a container child), so the map cannot retain
   * components — and the text they hold — for the life of the session.
   */
  releaseLiveComponent(component: Component): void {
    this.liveComponentToEntry.delete(component);
  }

  /**
   * Stop everything a component owns once it leaves the live area. Committed
   * views re-render from the entry data, so disposing cannot lose content, but
   * skipping it would let an animation timer outlive the row it belonged to.
   */
  private dropLiveComponent(component: Component): void {
    for (const [trackingId, tracked] of this.liveNoticesByTrackingId) {
      if (tracked === component) this.liveNoticesByTrackingId.delete(trackingId);
    }
    if (hasDispose(component)) component.dispose();
  }

  /**
   * Stops the ticker of the card that announced `trackingId`. Called when the
   * task reaches a terminal state: that card is history now, and a glyph that
   * keeps rotating would claim the task is still running.
   */
  private settleLiveNotice(trackingId: string): void {
    const tracked = this.liveNoticesByTrackingId.get(trackingId);
    if (tracked === undefined) return;
    this.liveNoticesByTrackingId.delete(trackingId);
    tracked.settle();
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
        // Unmounted for good: release the timer it was running.
        this.dropLiveComponent(component);
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
        // Historical replay: no `ui` → AssistantMessageComponent skips the
        // streaming bullet fade (startFade returns early when ui is unset).
        // Only live streaming (streaming-ui.ts) passes ui so the bullet
        // fades from accent to ink on first token arrival.
        const component = new AssistantMessageComponent(
          state.theme.markdownTheme,
          state.theme.colors,
        );
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        // Note: live sessions and session replay both route reasoning through the
        // activity block (see streaming-ui onThinkingUpdate), so this standalone
        // mount path is currently unreachable; kept for entries appended by other
        // producers.
        const thinking = new ThinkingComponent(entry.content, state.theme.colors, true);
        return thinking;
      }
      // `tool_result` is the same thing as far as rendering goes: both carry a
      // finished tool card. The caller that appends such an entry mounts its own
      // component today, but routing it here must not silently drop the row.
      case 'tool_call':
      case 'tool_result': {
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            state.theme.colors,
            state.ui,
            state.theme.markdownTheme,
            state.appState.workDir,
          );
          if (state.planExpanded) tc.setPlanExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            state.theme.colors,
            state.ui,
          );
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(
              entry.content,
              entry.detail,
              state.theme.colors,
              entry.noticeMarkerColor,
            )
          : new StatusMessageComponent(entry.content, state.theme.colors, entry.color);
      }
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            state.theme.colors,
            state.ui,
          );
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(
              entry.content,
              entry.detail,
              state.theme.colors,
              entry.noticeMarkerColor,
            )
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
      // A background task notice belongs to the work that spawned it: while the
      // turn's block is still open it becomes one of its steps. The component
      // then stays unmounted (like a borrowed tool card) and remains the entry's
      // live counterpart for revoke, folding and disposal.
      const status = entry.backgroundAgentStatus;
      if (status !== undefined && component instanceof BackgroundAgentStatusComponent) {
        const trackingId = status.trackingId;
        if (trackingId !== undefined) {
          if (status.phase === 'started') {
            this.liveNoticesByTrackingId.set(trackingId, component);
          } else {
            this.settleLiveNotice(trackingId);
          }
        }
      }
      if (status !== undefined && this.host.streamingUI.attachNotice(status)) {
        // The block owns the row: the component is never mounted anywhere, so
        // drop its bookkeeping and its timer instead of retaining an unreachable
        // twin that keeps repainting in the background.
        this.releaseLiveComponent(component);
        this.dropLiveComponent(component);
      } else {
        this.host.state.transcriptContainer.addChild(component);
      }
      this.host.state.ui.requestRender();
    }
    return component ?? null;
  }

  /** Append a suffix to the given turn's final assistant message last line.
   *  Used to place the turn elapsed marker flush against the last character
   *  of the assistant's reply. Turn-scoped so a tool-only turn never stamps
   *  the previous turn's message. No-op when this turn has no assistant
   *  entry with a matching turnId. */
  appendElapsedToLastAssistant(suffix: string, turnId: string): void {
    const entries = this.host.state.transcriptEntries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry === undefined || entry.kind !== 'assistant') continue;
      if (entry.turnId !== turnId) continue;
      for (const [component, mapped] of this.liveComponentToEntry) {
        if (mapped === entry && component instanceof AssistantMessageComponent) {
          component.appendToLastLine(suffix);
          this.host.state.ui.requestRender();
          return;
        }
      }
      return;
    }
  }

  appendApprovalEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    if (request.toolName === 'ExitPlanMode' || request.display.kind === 'plan_review') return;
    const notice = buildApprovalNotice({
      decision: response.decision,
      scope: response.scope,
      action: request.action,
      feedback: response.feedback,
      labels: {
        approved: t('tc.approved'),
        approvedSession: t('tc.approved_session'),
        rejected: t('tc.rejected'),
        cancelled: t('tc.cancelled'),
      },
    });
    // An approval belongs to the call it allowed, so it is filed with the work
    // rather than mounted as a message of its own: the block that owns the call
    // takes the row as a step (bounded by its own row budget), and streaming-ui
    // falls back to a notice row when no block ever claims it.
    this.host.streamingUI.recordApproval(
      request.toolCallId,
      notice.label,
      notice.detail,
      notice.tone,
    );
  }

  renderWelcome(): void {
    const { state } = this.host;
    this.welcomeComponent?.stopBreathing();
    const welcome = new WelcomeComponent(
      state.appState,
      state.theme.colors,
      state.ui,
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
    streamingUI.endActivityGroup();
    // Settle anything the discarded transcript still owned *before* the entry
    // list is replaced, so a flush cannot leave a row behind in the new session.
    streamingUI.flushPendingApprovals();
    state.transcriptEntries = [];
    streamingUI.disposeActiveCompactionBlock();
    streamingUI.resetLiveText();
    streamingUI.resetToolUi();
    this.welcomeComponent?.stopBreathing();
    this.welcomeComponent = undefined;
    this.committedComponent = undefined;
    this.liveComponentToEntry.clear();
    this.pendingComponents.clear();
    // The expand mode is per session: a fresh transcript starts collapsed.
    state.toolOutputExpanded = false;
    // Dispose live components before clearing the container so their timers
    // (AssistantMessageComponent fade, ToolCallComponent streaming/elapsed
    // timers) don't keep firing requestRender for ~1.2s into the next session.
    disposeChildren(state.transcriptContainer);
    this.clearTerminalInlineImages();
    state.todoPanel.clear();
    state.todoPanelContainer.clear();
    state.errorBanner.clear();
    imageStore.clear();
    this.renderWelcome();
    // The transcript is now empty: force the status bar to refresh so the
    // empty-session hint (Ctrl+F) (re)appears even when the activity mode
    // stayed idle across the switch (idle -> idle normally short-circuits).
    this.host.forceUpdateStatusBar();
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
    this.showStatus(`${t('tc.error_prefix')}${truncateErrorMessage(cleaned)}`, this.host.state.theme.colors.error);
    // Banner shows a tighter (3-line) preview pinned above the input so a
    // turn-ending error can't scroll out of view before the user returns.
    this.host.state.errorBanner.setMessage(cleaned);
    this.host.state.ui.requestRender();
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => chalk.hex(this.host.state.theme.colors.primary)(s);
    const spinner = new MoonLoader(this.host.state.ui, tint, label);
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
    // Ctrl+O is a mode, not a per-card flip: the press sets every expandable
    // piece of the current turn and the new state is remembered, so components
    // that mount later come up in the same mode and the transcript can never end
    // up half expanded. Work from earlier prompts keeps whatever it was showing.
    const next = !state.toolOutputExpanded;
    const children = state.transcriptContainer.children;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child === undefined) continue;
      // Rows that open a turn (a user message — including a mid-turn steer — a
      // skill activation, a cron notice) and folded history end the scan:
      // everything above them belongs to earlier work and keeps its own state.
      // Components without a collapse state (the agent group) simply do not match
      // isExpandable.
      if (
        child instanceof UserMessageComponent ||
        child instanceof SkillActivationComponent ||
        child instanceof CronMessageComponent ||
        child instanceof CommittedTranscriptComponent
      ) {
        break;
      }
      if (isExpandable(child)) child.setExpanded(next);
    }
    state.toolOutputExpanded = next;
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
