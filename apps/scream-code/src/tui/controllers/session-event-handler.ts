import chalk from 'chalk';
import type {
  AgentStatusUpdatedEvent,
  AssistantDeltaEvent,
  BackgroundTaskInfo,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  BackgroundTaskUpdatedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  CronFiredEvent,
  ErrorEvent,
  Event,
  HookResultEvent,
  Session,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  ThinkingDeltaEvent,
  TokenUsage,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
  WarningEvent,
} from '@scream-code/scream-code-sdk';

import { MoonLoader } from '../components/chrome/moon-loader';
import { StatusMessageComponent } from '../components/messages/status-message';
import { MAIN_AGENT_ID } from '../constant/scream-tui';
import {
  argsRecord,
  isTodoItemShape,
  serializeToolResultOutput,
  stringValue,
} from '../utils/event-payload';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { formatHookResultMarkdown, formatHookResultPlain } from '../utils/hook-result-format';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status';
import { openUrl } from '../utils/open-url';
import { McpOAuthAuthorizationUrlOpener } from '../utils/mcp-oauth';
import { setProcessTitle } from '../utils/proctitle';
import { formatStepDebugTiming } from '#/utils/usage/debug-timing';
import { consumeLoopLimitIteration, isLoopLimitExpired } from '../utils/loop-limit';
import { runShellVerifier } from '../utils/loop-verifier';
import { nextTranscriptId } from '../utils/transcript-id';
import { canTransitionTo } from '../streaming-phase';
import { detectCompactionAnomaly } from '../utils/compaction-anomaly';
import type { StreamingUIController } from './streaming-ui';
import type { TasksBrowserController } from './tasks-browser';
import type {
  AppState,
  BackgroundAgentMetadata,
  LivePaneState,
  QueuedMessage,
  SubagentUsageMap,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputOther: a.inputOther + b.inputOther,
    inputCacheRead: a.inputCacheRead + b.inputCacheRead,
    inputCacheCreation: a.inputCacheCreation + b.inputCacheCreation,
    output: a.output + b.output,
  };
}


export interface SessionEventHost {
  state: TUIState;
  session: Session | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): Session;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: string): void;
  showNotice(title: string, detail?: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  sendNormalUserInput(text: string): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  readonly tasksBrowserController: TasksBrowserController;
  markMemoryExtracted(): void;
}

export class SessionEventHandler {
  constructor(private readonly host: SessionEventHost) {}

  // Runtime state – owned by this handler, reset between sessions.
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata> = new Map();
  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  /**
   * Compaction trigger of the in-flight compaction, captured in
   * `handleCompactionBegin` (CompactionStartedEvent carries `trigger`) and
   * read in `handleCompactionEnd` (CompactionCompletedEvent does not). Used so
   * Storm Breaker cadence tracking only counts auto-compactions — manual
   * /compact must not inflate `autoCompactionCount` or set
   * `lastCompactionFinishedAt`, otherwise the first genuine auto-compaction
   * would silently fail to trigger `first_step_blowup`, and a manual compact
   * followed shortly by an auto one would falsely trip `rapid_refire`.
   */
  private lastCompactionTrigger: 'manual' | 'auto' | undefined;
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();
  subagentInfo: Map<string, { parentToolCallId: string; name: string }> = new Map();
  renderedSkillActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();

  resetRuntimeState(): void {
    this.backgroundAgentMetadata.clear();
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subagentInfo.clear();
    this.renderedSkillActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.stopAllMcpServerStatusSpinners();
    this.host.setAppState({ subagentUsage: {} });
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const mcpOAuthOpener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const { sessionId } = host.state.appState;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      if (event.type === 'tool.progress') {
        const authOpened = mcpOAuthOpener.handleToolProgress(event);
        if (authOpened !== undefined) {
          host.showStatus(`已在浏览器中打开 ${authOpened.serverName} 的授权页面`);
        }
      }
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: Session): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.showError(`同步 MCP 服务器状态失败： ${message}`);
      return;
    }
    if (host.session !== session || host.state.appState.sessionId !== session.id) return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }

    const hidden: McpServerStatusSnapshot[] = [];
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
      hidden.push(server);
    }
    if (hidden.length > 0) {
      host.showStatus(
        formatMcpStartupStatusSummary(hidden, visible.length),
        host.state.theme.colors.textMuted,
      );
    }
  }

  handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    if (this.routeSubagentEvent(event)) return;

    if ('turnId' in event && event.turnId !== undefined) {
      this.host.streamingUI.setTurnId(String(event.turnId));
    }

    switch (event.type) {
      case 'turn.started': this.handleTurnBegin(event); break;
      case 'turn.ended': this.handleTurnEnd(event, sendQueued); break;
      case 'turn.step.started': this.handleStepBegin(event); break;
      case 'turn.step.interrupted': this.handleStepInterrupted(event); break;
      case 'turn.step.completed': this.handleStepCompleted(event); break;
      case 'turn.step.retrying': break;
      case 'tool.progress': this.handleToolProgress(event); break;
      case 'assistant.delta': this.handleAssistantDelta(event); break;
      case 'hook.result': this.handleHookResult(event); break;
      case 'thinking.delta': this.handleThinkingDelta(event); break;
      case 'tool.call.started': this.handleToolCall(event); break;
      case 'tool.call.delta': this.handleToolCallDelta(event); break;
      case 'tool.result': this.handleToolResult(event); break;
      case 'agent.status.updated': this.handleStatusUpdate(event); break;
      case 'session.meta.updated': this.handleSessionMetaChanged(event); break;
      case 'skill.activated': this.handleSkillActivated(event); break;
      case 'error': this.handleSessionError(event); break;
      case 'warning': this.handleSessionWarning(event); break;
      case 'compaction.started': this.handleCompactionBegin(event); break;
      case 'compaction.completed': this.handleCompactionEnd(event, sendQueued); break;
      case 'compaction.blocked': break;
      case 'compaction.cancelled': this.handleCompactionCancel(event, sendQueued); break;
      case 'subagent.spawned': this.handleSubagentSpawned(event); break;
      case 'subagent.started': this.handleSubagentStarted(event); break;
      case 'subagent.completed': this.handleSubagentCompleted(event); break;
      case 'subagent.failed': this.handleSubagentFailed(event); break;
      case 'background.task.started':
      case 'background.task.updated':
      case 'background.task.terminated':
        this.handleBackgroundTaskEvent(event); break;
      case 'cron.fired': this.handleCronFired(event); break;
      case 'mcp.server.status': this.renderMcpServerStatus(event.server); break;
      case 'tool.list.updated': break;
      case 'goal.updated': this.handleGoalUpdated(event); break;
      default: break;
    }
  }

  stopAllMcpServerStatusSpinners(): void {
    const { state } = this.host;
    const children = state.transcriptContainer.children;
    for (const spinner of this.mcpServerStatusSpinners.values()) {
      spinner.stop();
      const idx = children.indexOf(spinner);
      if (idx >= 0) children.splice(idx, 1);
    }
    if (this.mcpServerStatusSpinners.size > 0) {
      state.transcriptContainer.invalidate();
    }
    this.mcpServerStatusSpinners.clear();
  }

  // ---------------------------------------------------------------------------
  // Private handlers
  // ---------------------------------------------------------------------------

  private routeSubagentEvent(event: Event): boolean {
    const subagentId = event.agentId;
    if (subagentId === MAIN_AGENT_ID) return false;

    const { streamingUI } = this.host;
    const info = this.subagentInfo.get(subagentId);
    if (info === undefined || info.parentToolCallId.length === 0) return true;
    const { parentToolCallId } = info;
    const sourceName = info.name;
    const toolCall = streamingUI.getToolComponent(parentToolCallId);
    if (toolCall === undefined) return true;
    toolCall.setSubagentMeta(subagentId, sourceName);

    switch (event.type) {
      case 'hook.result':
        toolCall.appendSubagentText(formatHookResultPlain(event), 'text');
        return true;
      case 'assistant.delta':
        toolCall.appendSubagentText(event.delta, 'text');
        return true;
      case 'thinking.delta':
        toolCall.appendSubagentText(event.delta, 'thinking');
        return true;
      case 'tool.call.started':
        toolCall.appendSubToolCall({
          id: `${subagentId}:${event.toolCallId}`,
          name: event.name,
          args: argsRecord(event.args),
        });
        return true;
      case 'tool.call.delta':
        toolCall.appendSubToolCallDelta({
          id: `${subagentId}:${event.toolCallId}`,
          name: event.name,
          argumentsPart: event.argumentsPart ?? null,
        });
        return true;
      case 'tool.result':
        toolCall.finishSubToolCall({
          tool_call_id: `${subagentId}:${event.toolCallId}`,
          output: serializeToolResultOutput(event.output),
          is_error: event.isError,
          display: event.display,
        });
        return true;
      case 'agent.status.updated': {
        const usageObj = event.usage;
        const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
        toolCall.updateSubagentMetrics({
          contextTokens: event.contextTokens,
          usage: totalUsage,
        });
        return true;
      }
      case 'background.task.started':
      case 'background.task.updated':
      case 'background.task.terminated':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
      case 'compaction.started':
      case 'error':
      case 'session.meta.updated':
      case 'skill.activated':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.spawned':
      case 'tool.progress':
      case 'tool.list.updated':
      case 'mcp.server.status':
      case 'turn.ended':
      case 'turn.started':
      case 'turn.step.completed':
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
      case 'turn.step.started':
        return true;
      default:
        return true;
    }
  }

  private handleTurnBegin(_event: TurnStartedEvent): void {
    void _event;
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.setStep(0);
    this.host.patchLivePane({
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
    });
  }

  private handleTurnEnd(event: TurnEndedEvent, sendQueued: (item: QueuedMessage) => void): void {
    this.host.streamingUI.flushNow();
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();

    this.host.streamingUI.finalizeTurn(sendQueued);

    // Auto-resubmit loop prompt after turn completes, if loop mode is active.
    this.maybeScheduleLoopAutoSubmit();
  }

  private maybeScheduleLoopAutoSubmit(): void {
    const { loopModeEnabled, loopPrompt, loopLimit } = this.host.state.appState;
    if (!loopModeEnabled || loopPrompt === undefined) return;

    if (isLoopLimitExpired(loopLimit)) {
      const reason = loopLimit?.kind === 'duration' ? '时间' : '次数';
      this.disableLoop(`循环${reason}限制已到，循环模式已关闭。`);
      return;
    }

    // Brief delay so the user has a chance to press Esc between iterations.
    setTimeout(() => {
      void this.advanceLoopIteration(loopPrompt);
    }, 800);
  }

  private disableLoop(message: string): void {
    this.host.setAppState({
      loopModeEnabled: false,
      loopPrompt: undefined,
      loopLimit: undefined,
      loopVerifier: undefined,
      loopIteration: 0,
      loopLastVerifyPassed: undefined,
      loopVerifying: false,
    });
    this.host.showStatus(message);
  }

  private async advanceLoopIteration(loopPrompt: string): Promise<void> {
    const state = this.host.state.appState;
    if (
      !state.loopModeEnabled ||
      state.loopPrompt !== loopPrompt ||
      state.streamingPhase !== 'idle'
    ) {
      return;
    }

    const currentIteration = state.loopIteration + 1;
    this.host.setAppState({ loopIteration: currentIteration });

    const verifier = state.loopVerifier;
    if (verifier) {
      this.host.setAppState({ loopVerifying: true });
      const result = await runShellVerifier(verifier, state.workDir);
      // verifier 期间用户可能按 Esc 暂停或修改 prompt，需重新检查
      const after = this.host.state.appState;
      if (!after.loopModeEnabled || after.loopPrompt !== loopPrompt) {
        this.host.setAppState({ loopVerifying: false });
        return;
      }

      if (result.passed) {
        this.host.setAppState({ loopVerifying: false });
        this.disableLoop(`✓ 验证通过，循环结束（${currentIteration} 次迭代）。`);
        return;
      }
      this.host.setAppState({ loopVerifying: false, loopLastVerifyPassed: false });
    }

    if (!consumeLoopLimitIteration(this.host.state.appState.loopLimit)) {
      const limit = this.host.state.appState.loopLimit;
      const reason = limit?.kind === 'duration' ? '时间' : '次数';
      const suffix = verifier ? '，验证未通过' : '';
      this.disableLoop(`循环${reason}限制已到${suffix}，循环模式已关闭。`);
      return;
    }

    this.host.sendNormalUserInput(loopPrompt);
  }

  private handleStepBegin(event: TurnStepStartedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.setStep(event.step);
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers();
    this.host.patchLivePane({
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
    });
  }

  private handleStepCompleted(event: TurnStepCompletedEvent): void {
    this.host.streamingUI.flushNow();
    this.maybeShowDebugTiming(event);
    if (event.finishReason !== 'max_tokens') return;

    const truncatedCount = this.host.streamingUI.markStepTruncated(
      String(event.turnId),
      event.step,
    );

    const title =
      truncatedCount > 0
        ? '模型达到 max_tokens 限制 — 工具调用在运行前被截断。'
        : '模型达到 max_tokens 限制 — 未发出工具调用。';
    const detail = this.isAnthropicSessionActive()
      ? '如果此限制对您的模型不合适，请在 scream-code 配置中为模型别名设置 `max_output_size`。'
      : undefined;
    this.host.showNotice(title, detail);
  }

  private maybeShowDebugTiming(event: TurnStepCompletedEvent): void {
    if (process.env['SCREAM_CODE_DEBUG'] !== '1') return;
    const text = formatStepDebugTiming(event);
    if (text !== undefined) this.host.showStatus(text);
  }

  private isAnthropicSessionActive(): boolean {
    const { state } = this.host;
    const providerKey = state.appState.availableModels[state.appState.model]?.provider;
    if (providerKey === undefined) return false;
    return state.appState.availableProviders[providerKey]?.type === 'anthropic';
  }

  private handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers();
    const reason = event.reason;
    if (reason === 'error') return;
    if (reason === 'aborted' || reason === undefined || reason === '') {
      this.host.showStatus('用户中断', this.host.state.theme.colors.error);
      return;
    }
    this.host.showError(
      reason === 'max_steps'
        ? '达到每轮步骤限制（max_steps）'
        : `步骤中断 (${reason})`,
    );
  }

  private handleThinkingDelta(event: ThinkingDeltaEvent): void {
    const { state, streamingUI } = this.host;
    streamingUI.appendThinkingDelta(event.delta);
    if (canTransitionTo(state.appState.streamingPhase, 'thinking')) {
      this.host.setAppState({ streamingPhase: 'thinking' });
    }
    streamingUI.scheduleFlush();
  }

  private handleAssistantDelta(event: AssistantDeltaEvent): void {
    const { state, streamingUI } = this.host;
    if (streamingUI.hasThinkingDraft()) {
      streamingUI.flushThinkingToTranscript();
    }

    streamingUI.appendAssistantDelta(event.delta);

    this.host.patchLivePane({
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (canTransitionTo(state.appState.streamingPhase, 'composing')) {
      this.host.setAppState({ streamingPhase: 'composing' });
    }
    streamingUI.scheduleFlush();
  }

  private handleHookResult(event: HookResultEvent): void {
    this.host.streamingUI.flushNow();
    if (this.host.streamingUI.hasThinkingDraft()) {
      this.host.streamingUI.flushThinkingToTranscript();
    }
    this.host.streamingUI.finalizeAssistantStream();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: String(event.turnId),
      renderMode: 'markdown',
      content: formatHookResultMarkdown(event),
    });
    this.host.patchLivePane({
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCall(event: ToolCallStartedEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.name,
      args: argsRecord(event.args),
      description: event.description,
      display: event.display,
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    this.host.patchLivePane({
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (canTransitionTo(this.host.state.appState.streamingPhase, 'tool')) {
      this.host.setAppState({ streamingPhase: 'tool' });
    }
  }

  private handleToolCallDelta(event: ToolCallDeltaEvent): void {
    if (event.toolCallId.length === 0) return;
    const { state, streamingUI } = this.host;
    streamingUI.accumulateToolCallDelta(event.toolCallId, event.name, event.argumentsPart);

    this.host.patchLivePane({
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (canTransitionTo(state.appState.streamingPhase, 'tool')) {
      this.host.setAppState({ streamingPhase: 'tool' });
    }
    streamingUI.scheduleFlush();
  }

  private handleToolProgress(event: ToolProgressEvent): void {
    if (event.update.kind !== 'status') return;
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (tc === undefined) return;
    tc.appendProgress(text);
  }

  private handleToolResult(event: ToolResultEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output: serializeToolResultOutput(event.output),
      is_error: event.isError,
      synthetic: event.synthetic,
      display: event.display,
    };
    const matchedCall = streamingUI.completeToolResult(event.toolCallId, resultData);
    if (matchedCall !== undefined && matchedCall.name === 'TodoList' && !event.isError) {
      const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
      if (Array.isArray(rawTodos)) {
        const sanitized = rawTodos
          .filter((todo): todo is { title: string; status: 'pending' | 'in_progress' | 'done' } =>
            isTodoItemShape(todo),
          )
          .map((t) => ({ title: t.title, status: t.status }));
        streamingUI.setTodoList(sanitized);
      }
    }
    if (canTransitionTo(this.host.state.appState.streamingPhase, 'waiting')) {
      this.host.setAppState({ streamingPhase: 'waiting' });
    }
  }

  private handleStatusUpdate(event: AgentStatusUpdatedEvent): void {
    const patch: Partial<AppState> = {};
    if (event.contextUsage !== undefined) patch.contextUsage = event.contextUsage;
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) {
      // Agent-core reports planMode as a boolean and planStrategy as 'normal' | 'fusion'.
      // Respect the strategy so that LLM-initiated fusion plan requests switch the TUI
      // into fusionplan mode, while preserving the local state when the agent only signals
      // that plan mode is active.
      patch.planMode = event.planMode
        ? event.planStrategy === 'fusion'
          ? 'fusionplan'
          : this.host.state.appState.planMode === 'fusionplan'
            ? 'fusionplan'
            : 'plan'
        : 'off';
    }
    if (event.permission !== undefined) {
      patch.permissionMode = event.permission;
    }
    if (event.model !== undefined) patch.model = event.model;
    if (event.thinkingLevel !== undefined) {
      patch.thinkingLevel = event.thinkingLevel as import('@scream-code/scream-code-sdk').ThinkingEffort;
    }
    if (Object.keys(patch).length > 0) this.host.setAppState(patch);
  }

  private handleSessionMetaChanged(event: SessionMetaUpdatedEvent): void {
    const title = event.title ?? stringValue(event.patch?.['title']);
    if (title !== undefined) {
      this.host.setAppState({ sessionTitle: title });
      setProcessTitle(title, this.host.state.appState.sessionId);
    }
  }

  private handleSessionError(event: ErrorEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers();
    this.host.showError(`[${event.code}] ${event.message}`);
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.host.showStatus(`警告： ${event.message}`, this.host.state.theme.colors.warning);
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const { state } = this.host;
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);

    const colors = state.theme.colors;
    switch (server.status) {
      case 'connected': {
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.success);
        return;
      }
      case 'failed': {
        const message = `MCP 服务器 "${server.name}" 失败${server.error !== undefined ? `: ${server.error}` : ''}`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.error);
        return;
      }
      case 'needs-auth': {
        const message = `MCP 服务器 "${server.name}" 需要 OAuth 认证，请运行 /mcp`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.warning);
        return;
      }
      case 'disabled':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP 服务器 "${server.name}" 已禁用`,
          colors.textMuted,
        );
        return;
      case 'pending':
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const { state } = this.host;
    const label = `MCP 服务器 "${name}" 正在连接…`;
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => chalk.hex(state.theme.colors.textMuted)(s);
    const spinner = new MoonLoader(state.ui, 'braille', tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(name: string, message: string, color: string): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const container = state.transcriptContainer;
    const children = container.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      children.splice(idx, 1);
      container.addChild(new StatusMessageComponent(message, state.theme.colors, color));
      container.invalidate();
    } else {
      container.addChild(new StatusMessageComponent(message, state.theme.colors, color));
    }
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  private handleSkillActivated(event: SkillActivatedEvent): void {
    if (this.renderedSkillActivationIds.has(event.activationId)) return;
    this.renderedSkillActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: `已激活技能： ${event.skillName}`,
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      skillTrigger: event.trigger,
    });
  }

  private handleCronFired(event: CronFiredEvent): void {
    this.host.streamingUI.flushNow();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'cron',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: event.prompt,
      cronData: {
        jobId: event.origin.jobId,
        cron: event.origin.cron,
        recurring: event.origin.recurring,
        coalescedCount: event.origin.coalescedCount,
        stale: event.origin.stale,
      },
    });
  }

  private handleGoalUpdated(event: { snapshot: { objective: string; status: string } | null }): void {
    const snapshot = event.snapshot;
    if (snapshot === null) {
      this.host.setAppState({ goal: null, goalActive: false });
    } else {
      this.host.setAppState({
        goal: snapshot.objective,
        goalActive: snapshot.status === 'active',
      });
    }
  }

  private handleCompactionBegin(event: CompactionStartedEvent): void {
    this.host.streamingUI.finalizeLiveTextBuffers();
    this.lastCompactionTrigger = event.trigger;

    // Storm Breaker: surface pathological auto-compaction patterns without
    // blocking the compaction itself (blocking would deadlock the session).
    if (event.trigger === 'auto') {
      const anomaly = detectCompactionAnomaly({
        lastFinishedAt: this.host.state.appState.lastCompactionFinishedAt,
        autoCompactionCount: this.host.state.appState.autoCompactionCount,
        currentTokens: this.host.state.appState.contextTokens,
        maxContextTokens: this.host.state.appState.maxContextTokens,
        now: Date.now(),
      });
      if (anomaly !== null) {
        this.host.showNotice(
          'Storm Breaker（风暴守护者）',
          `检测到异常压缩节奏：${anomaly.detail}` +
            '可能存在工具调用循环或超长输出，建议查看最近几步的对话记录。',
        );
      }
    }

    this.host.setAppState({
      isCompacting: true,
      streamingPhase: 'waiting',
    });
    this.host.streamingUI.beginCompaction(event.instruction);
  }

  private handleCompactionEnd(
    event: CompactionCompletedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.endCompaction(event.result.tokensBefore, event.result.tokensAfter);
    this.host.markMemoryExtracted();

    // Only auto-compactions count toward Storm Breaker cadence tracking. A
    // manual /compact must not inflate the auto counter or set the
    // last-finished timestamp — otherwise the first genuine auto-compaction
    // would fail first_step_blowup, and manual→auto within 30s would false-trip
    // rapid_refire.
    if (this.lastCompactionTrigger === 'auto') {
      this.host.setAppState({
        lastCompactionFinishedAt: Date.now(),
        autoCompactionCount: this.host.state.appState.autoCompactionCount + 1,
      });
    }
    this.lastCompactionTrigger = undefined;

    this.finishCompaction(sendQueued);
  }

  private handleCompactionCancel(
    event: CompactionCancelledEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    if (event.reason) {
      this.host.showStatus(event.reason, this.host.state.theme.colors.warning);
    }
    this.host.streamingUI.cancelCompaction();
    this.lastCompactionTrigger = undefined;
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.host.resetLivePane();
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) {
        setTimeout(() => {
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }

  private handleSubagentSpawned(event: SubagentSpawnedEvent): void {
    const { streamingUI } = this.host;
    this.subagentInfo.set(event.subagentId, {
      parentToolCallId: event.parentToolCallId,
      name: event.subagentName,
    });

    if (event.runInBackground) {
      const meta = this.buildBackgroundAgentMetadata(event);
      this.backgroundAgentMetadata.set(event.subagentId, meta);
      this.appendBackgroundAgentEntry('started', meta);
      this.syncBackgroundAgentBadge();
      return;
    }

    let tc = streamingUI.getToolComponent(event.parentToolCallId);
    if (tc === undefined) {
      const toolCall = streamingUI.getActiveToolCall(event.parentToolCallId);
      if (toolCall !== undefined) {
        streamingUI.onToolCallStart(toolCall);
        tc = streamingUI.getToolComponent(event.parentToolCallId);
      }
    }
    tc ??= this.createStandaloneSubagentToolCall(event);
    if (tc === undefined) return;
    tc.onSubagentSpawned({
      agentId: event.subagentId,
      agentName: event.subagentName,
      runInBackground: event.runInBackground,
    });
  }

  private handleSubagentStarted(event: SubagentStartedEvent): void {
    if (event.runInBackground) return;
    const tc = this.host.streamingUI.getToolComponent(event.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentStarted({
      agentId: event.subagentId,
      agentName: event.subagentName,
      runInBackground: event.runInBackground,
    });
  }

  private handleSubagentCompleted(event: SubagentCompletedEvent): void {
    this.recordSubagentUsage(event.subagentId, undefined, event.usage);
    const { streamingUI } = this.host;
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.syncBackgroundAgentBadge();
      const taskId = this.findAgentTaskId(event.subagentId);
      if (taskId !== undefined && this.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      const extras =
        event.resultSummary === undefined ? undefined : { resultSummary: event.resultSummary };
      this.appendBackgroundAgentEntry('completed', backgroundMeta, extras);
      return;
    }
    const tc = streamingUI.getToolComponent(event.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentCompleted({
      contextTokens: event.contextTokens,
      usage: event.usage,
      resultSummary: event.resultSummary,
    });
    streamingUI.removeToolComponentIfInactive(event.parentToolCallId);
  }

  private handleSubagentFailed(event: SubagentFailedEvent): void {
    this.recordSubagentUsage(event.subagentId, undefined, event.usage);
    const { streamingUI } = this.host;
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.syncBackgroundAgentBadge();
      // Push the real subagent error onto the parent Agent card too —
      // `background.task.terminated` arrives separately (possibly later)
      // with no error string and would only stamp the generic
      // `Background agent failed`. The card and the separate transcript
      // entry now share the same actual reason.
      streamingUI.applyBackgroundTaskTerminalStatus({
        agentId: event.subagentId,
        description: backgroundMeta.description ?? '',
        status: 'failed',
        errorText: event.error,
      });
      const taskId = this.findAgentTaskId(event.subagentId);
      if (taskId !== undefined && this.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      this.appendBackgroundAgentEntry('failed', backgroundMeta, { error: event.error });
      return;
    }
    const tc = streamingUI.getToolComponent(event.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentFailed({ error: event.error });
    streamingUI.removeToolComponentIfInactive(event.parentToolCallId);
  }

  private recordSubagentUsage(
    subagentId: string,
    subagentName: string | undefined,
    usage: TokenUsage | undefined,
  ): void {
    if (usage === undefined) return;
    const info = this.subagentInfo.get(subagentId);
    const name = info?.name ?? subagentName ?? subagentId;
    const current = this.host.state.appState.subagentUsage[name];
    const next: SubagentUsageMap = {
      ...this.host.state.appState.subagentUsage,
      [name]: current === undefined ? usage : addTokenUsage(current, usage),
    };
    this.host.setAppState({ subagentUsage: next });
  }

  private createStandaloneSubagentToolCall(event: SubagentSpawnedEvent) {
    const { streamingUI } = this.host;
    const description = event.description ?? `Run ${event.subagentName} agent`;
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.parentToolCallId,
      name: 'Agent',
      args: {
        description,
        subagent_type: event.subagentName,
      },
      description,
      step,
      turnId,
    };
    streamingUI.onToolCallStart(toolCall);
    return streamingUI.getToolComponent(event.parentToolCallId);
  }

  private findAgentTaskId(subagentId: string): string | undefined {
    const meta = this.backgroundAgentMetadata.get(subagentId);
    const description = meta?.description ?? meta?.agentName;
    if (description === undefined) return undefined;
    let match: string | undefined;
    for (const info of this.backgroundTasks.values()) {
      if (!info.taskId.startsWith('agent-')) continue;
      if (info.description !== description) continue;
      if (match !== undefined) return undefined;
      match = info.taskId;
    }
    return match;
  }

  private buildBackgroundAgentMetadata(event: SubagentSpawnedEvent): BackgroundAgentMetadata {
    const parent = this.host.streamingUI.getActiveToolCall(event.parentToolCallId);
    const description = parent?.args['description'] ?? event.description;
    return {
      agentId: event.subagentId,
      parentToolCallId: event.parentToolCallId,
      agentName: event.subagentName,
      description: typeof description === 'string' ? description : undefined,
    };
  }

  private appendBackgroundAgentEntry(
    phase: 'started' | 'completed' | 'failed',
    meta: BackgroundAgentMetadata,
    extras: { resultSummary?: string; error?: string } | undefined = undefined,
  ): void {
    const status = formatBackgroundAgentTranscript(phase, meta, extras);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private syncBackgroundAgentBadge(): void {
    this.syncBackgroundTaskBadge();
  }

  // ---------------------------------------------------------------------------
  // Background task lifecycle
  // ---------------------------------------------------------------------------

  private handleBackgroundTaskEvent(
    event: BackgroundTaskStartedEvent | BackgroundTaskUpdatedEvent | BackgroundTaskTerminatedEvent,
  ): void {
    const { state } = this.host;
    const { info } = event;
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    const viewer = state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.host.tasksBrowserController.refreshOutputViewer({ silent: true });
    }

    const isTerminal =
      info.status === 'completed' ||
      info.status === 'failed' ||
      info.status === 'killed' ||
      info.status === 'lost';

    if (event.type === 'background.task.started') {
      if (info.taskId.startsWith('agent-')) {
        this.syncBackgroundTaskBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === 'background.task.terminated' && isTerminal) {
      if (info.taskId.startsWith('agent-')) {
        // The Agent tool's spawn-success ToolResult is not an error, so the
        // parent toolCall card would otherwise render `✓ Completed` for any
        // terminated bg agent — including `lost` / `failed` / `killed`.
        // Push the actual terminal status so the card matches reality.
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status,
        });
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        if (info.taskId.startsWith('bash-')) {
          this.appendBackgroundTaskEntry(info);
        }
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) {
      this.syncBackgroundTaskBadge();
    }
    this.host.tasksBrowserController.repaint();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private syncBackgroundTaskBadge(): void {
    const { state } = this.host;
    let bashTasks = 0;
    let agentTasks = 0;
    for (const info of this.backgroundTasks.values()) {
      if (
        info.status === 'completed' ||
        info.status === 'failed' ||
        info.status === 'killed' ||
        info.status === 'lost'
      ) {
        continue;
      }
      if (info.taskId.startsWith('agent-')) {
        agentTasks += 1;
      } else {
        bashTasks += 1;
      }
    }
    state.footer.setBackgroundCounts({ bashTasks, agentTasks });
    state.ui.requestRender();
  }
}
