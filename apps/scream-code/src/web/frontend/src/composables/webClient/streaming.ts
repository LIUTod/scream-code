import type { ChatMessage, SessionStatus, SessionUsage } from '../../types';
import { acceptJournalEvent, applyGoalTodoEvent } from '../../utils/goalTodoState';
import { clearToolStarts, recordToolStart, takeToolStart } from '../../utils/toolTiming';
import { useThrottledFlush } from '../useThrottledFlush';
import { eventErrorMessage, generateId, onWsMessage, type ClientContext } from './state';

export interface StreamingModule {
  onEvent(payload: { type: string; [key: string]: unknown }): void;
  disposeStreaming(): void;
}

export function createStreamingModule(ctx: ClientContext): StreamingModule {
  const { s } = ctx;

  // ── Streaming coalescing ──────────────────────────────────────────────
  // Stream chunks arrive as separate macrotasks; coalesce content deltas and
  // tool progress into at most one state flush per animation frame so the
  // renderer does not run O(chunks) full passes.
  function flushStreaming(): void {
    if (s.streamDisposed) return;
    const last = lastAssistantMessage();
    if (!last) {
      s.pendingAssistantDelta = '';
      s.pendingThinkingDelta = '';
      s.pendingToolProgress.clear();
      return;
    }
    if (s.pendingAssistantDelta) {
      last.content += s.pendingAssistantDelta;
      s.pendingAssistantDelta = '';
    }
    if (s.pendingThinkingDelta) {
      const thinkingTool = last.tools.find((t) => t.name === 'thinking');
      if (thinkingTool) {
        thinkingTool.output = (thinkingTool.output ?? '') + s.pendingThinkingDelta;
      } else {
        last.tools.push({ toolCallId: 'thinking', name: 'thinking', output: s.pendingThinkingDelta });
      }
      s.pendingThinkingDelta = '';
    }
    if (s.pendingToolProgress.size > 0) {
      for (const [toolCallId, output] of s.pendingToolProgress) {
        const tool = last.tools.find((t) => t.toolCallId === toolCallId);
        // Progress is LIVE-only state on tool.progress, so a running tool's
        // progress frames can never contaminate the final tool.result output.
        if (tool) tool.progress = output;
      }
      s.pendingToolProgress.clear();
    }
  }

  const streamFlush = useThrottledFlush(flushStreaming);

  function onEvent(payload: { type: string; [key: string]: unknown }): void {
    const goalTodoState = applyGoalTodoEvent({ goal: s.goal.value, todos: s.todos.value }, payload);
    s.goal.value = goalTodoState.goal;
    s.todos.value = goalTodoState.todos;
    if (
      payload.type === 'goal.updated' &&
      s.goalAwaitingMutation !== null &&
      s.goalAwaitingMutation.generation === s.goalMutationGeneration
    ) {
      s.goalAwaitingMutation = null;
      s.snapshotRetryGoalGeneration = null;
      ctx.syncGoalRequestPending();
    }

    switch (payload.type) {
      case 'turn.started': {
        if (s.pendingPromptAccepted) {
          s.promptPending.value = false;
          s.pendingPromptAccepted = false;
          s.sentMessageIds.clear();
        }
        streamFlush.flushNow();
        s.status.value = { ...s.status.value, busy: true };
        s.turnNumber += 1;
        s.turnStartAt = Date.now();
        s.turnFirstTokenAt = null;
        s.activeToolMs = 0;
        clearToolStarts();
        s.messages.value.push({
          id: generateId(),
          role: 'assistant',
          content: '',
          tools: [],
          ts: Date.now(),
          model: s.status.value.model,
          turnStats: {
            turn: s.turnNumber,
            step: 0,
            status: 'running',
            firstTokenMs: null,
            llmMs: 0,
            toolMs: 0,
            tokens: null,
            tokensPerSec: null,
          },
        });
        break;
      }
      case 'assistant.delta': {
        if (s.turnFirstTokenAt === null) s.turnFirstTokenAt = Date.now();
        s.pendingAssistantDelta += String(payload.delta);
        streamFlush.schedule();
        break;
      }
      case 'thinking.delta': {
        if (s.turnFirstTokenAt === null) s.turnFirstTokenAt = Date.now();
        s.pendingThinkingDelta += String(payload.delta);
        streamFlush.schedule();
        break;
      }
      case 'tool.call.started': {
        const last = lastAssistantMessage();
        if (last) {
          last.tools.push({ toolCallId: String(payload.toolCallId), name: String(payload.name), args: payload.args });
          if (last.turnStats) last.turnStats.step += 1;
        }
        recordToolStart(String(payload.toolCallId));
        break;
      }
      case 'tool.result': {
        // Clear any buffered progress for this tool so a stale progress frame
        // cannot overwrite the authoritative result at the next flush.
        s.pendingToolProgress.delete(String(payload.toolCallId));
        const startedAt = takeToolStart(String(payload.toolCallId));
        if (startedAt !== undefined) s.activeToolMs += Date.now() - startedAt;
        const last = lastAssistantMessage();
        if (last) {
          const tool = last.tools.find((t) => t.toolCallId === payload.toolCallId);
          if (tool) {
            tool.output = String(payload.output);
            tool.isError = Boolean(payload.isError);
            tool.progress = undefined;
            if (startedAt !== undefined) tool.durationMs = Date.now() - startedAt;
          }
        }
        break;
      }
      case 'tool.progress': {
        // Progress is overwrite-semantics: keep only the latest text per tool.
        s.pendingToolProgress.set(String(payload.toolCallId), String(payload.message ?? payload.output));
        streamFlush.schedule();
        break;
      }
      case 'turn.ended': {
        streamFlush.flushNow();
        s.status.value = { ...s.status.value, busy: false };
        if (payload.reason === 'failed') {
          const last = lastAssistantMessage();
          if (last) last.isError = true;
          s.error.value = eventErrorMessage(payload.error, 'Turn failed');
        }
        const last = lastAssistantMessage();
        const llmMs = Date.now() - s.turnStartAt;
        const usage = s.status.value.usage?.currentTurn;
        const tokens = usage
          ? usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation
          : null;
        if (last && last.turnStats) {
          last.turnStats.status = 'done';
          last.turnStats.llmMs = llmMs;
          last.turnStats.toolMs = s.activeToolMs;
          last.turnStats.firstTokenMs = s.turnFirstTokenAt !== null ? s.turnFirstTokenAt - s.turnStartAt : null;
          last.turnStats.tokens = tokens;
          last.turnStats.tokensPerSec =
            tokens !== null && llmMs > 0 ? Math.round((tokens / llmMs) * 1000) : null;
        }
        void ctx.fetchSessions();
        void ctx.fetchGitStatus();
        break;
      }
      case 'session.meta.updated': {
        const patch: Partial<SessionStatus> = {};
        if (payload.model !== undefined) patch.model = payload.model as string;
        if (payload.contextTokens !== undefined) patch.contextTokens = payload.contextTokens as number;
        if (payload.maxContextTokens !== undefined) patch.maxContextTokens = payload.maxContextTokens as number;
        if (payload.contextUsage !== undefined) patch.contextUsage = payload.contextUsage as number;
        s.status.value = { ...s.status.value, ...patch };
        break;
      }
      case 'agent.status.updated': {
        const patch: Partial<SessionStatus> = {};
        if (payload.model !== undefined) patch.model = payload.model as string;
        if (payload.thinkingLevel !== undefined) patch.thinkingLevel = payload.thinkingLevel as string;
        if (payload.contextTokens !== undefined) patch.contextTokens = payload.contextTokens as number;
        if (payload.maxContextTokens !== undefined) patch.maxContextTokens = payload.maxContextTokens as number;
        if (payload.contextUsage !== undefined) patch.contextUsage = payload.contextUsage as number;
        if (payload.usage !== undefined) {
          patch.usage = payload.usage as SessionUsage;
          // Late-arriving token usage: backfill the last settled assistant turn
          // so the stats row shows tokens even when usage lands after turn.ended.
          const turn = payload.usage as SessionUsage | undefined;
          if (turn?.currentTurn) {
            const last = lastAssistantMessage();
            const tokens = turn.currentTurn.inputOther + turn.currentTurn.output + turn.currentTurn.inputCacheRead + turn.currentTurn.inputCacheCreation;
            if (last?.turnStats && last.turnStats.status === 'done' && last.turnStats.tokens === null) {
              last.turnStats.tokens = tokens;
              last.turnStats.tokensPerSec = last.turnStats.llmMs ? Math.round((tokens / last.turnStats.llmMs) * 1000) : null;
            }
          }
        }
        s.status.value = { ...s.status.value, ...patch };
        break;
      }
      case 'error': {
        s.error.value = eventErrorMessage(payload.error, 'Unknown error');
        break;
      }
    }
  }

  function lastAssistantMessage(): ChatMessage | null {
    for (let i = s.messages.value.length - 1; i >= 0; i--) {
      if (s.messages.value[i].role === 'assistant') return s.messages.value[i];
    }
    return null;
  }

  // Journal frames: gate on epoch/seq, then fold the payload into state.
  onWsMessage(s, 'event', (msg) => {
    const decision = acceptJournalEvent(s.epoch, s.seq, msg);
    if (decision === 'resync') {
      s.epoch = msg.epoch;
      s.seq = 0;
      void ctx.fetchSnapshot();
      return;
    }
    if (decision === 'duplicate') return;
    s.seq = msg.seq;
    s.epoch = msg.epoch;
    s.liveGeneration++;
    onEvent(msg.payload);
  });

  // Server-side drift detection we cannot patch locally: drop the journal
  // cursor and pull a fresh snapshot (semantics preserved verbatim from the
  // original monolithic switch — losing this handler left the UI stale).
  onWsMessage(s, 'resync_required', () => {
    s.seq = 0;
    void ctx.fetchSnapshot();
  });

  ctx.onEvent = onEvent;

  function disposeStreaming(): void {
    s.streamDisposed = true;
    streamFlush.dispose();
  }

  return { onEvent, disposeStreaming };
}
