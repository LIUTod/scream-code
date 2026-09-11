import type { ChatMessage } from '../../types';
import { API_BASE, generateId, onWsMessage, type ClientContext } from './state';

export interface MessagesModule {
  sendPrompt(text: string): void;
  sendCommand(command: string, args?: string): void;
  clearMessages(): void;
  appendSystemMessage(text: string): void;
  abort(): void;
  resolveApproval(id: string, decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session'): void;
  loadOlderMessages(): Promise<number>;
}

export function createMessagesModule(ctx: ClientContext): MessagesModule {
  const { s, showToast } = ctx;

  function sendPrompt(text: string): void {
    if (!text) return;
    if (s.connectionStatus.value === 'idle') {
      showToast('暂无会话，请先新建会话。', 'warning');
      return;
    }
    if (s.connectionStatus.value !== 'connected') {
      // G5.4: queue the prompt instead of dropping it, then reconnect. This
      // runs BEFORE the isBusy guard so a prompt typed mid-disconnect is
      // never silently discarded.
      ctx.enqueueOfflinePrompt(text);
      showToast('连接已断开，消息已排队，重连后自动发送。', 'warning');
      ctx.connect();
      return;
    }
    if (s.isBusy.value) return;
    const clientMessageId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const localMessageId = generateId();
    s.sentMessageIds.set(clientMessageId, { messageId: localMessageId, connectionGeneration: s.connectionGeneration });
    s.promptGeneration++;
    s.pendingPromptAccepted = false;
    s.promptPending.value = true;
    s.messages.value.push({ id: localMessageId, role: 'user', content: text, clientMessageId, tools: [], ts: Date.now() });
    ctx.recordRecentPrompt(text);
    ctx.send({ type: 'prompt', text, clientMessageId });
  }

  // ── Slash commands / local message ops ──────────────────────────────────

  function sendCommand(command: string, args?: string): void {
    if (s.connectionStatus.value === 'idle') {
      showToast('暂无会话，请先新建会话。', 'warning');
      return;
    }
    if (s.connectionStatus.value !== 'connected') {
      showToast('连接已断开，命令未发送。', 'error');
      ctx.connect();
      return;
    }
    // Side questions are designed to run during an active turn; other commands
    // mutate session state and must wait until the turn settles.
    if (s.isBusy.value && command !== 'btw') {
      showToast(`会话忙碌中，无法执行 /${command}，请稍后再试。`, 'warning');
      return;
    }
    // Show pending feedback for commands that take time.
    const pendingCommands = ['compact', 'plan', 'auto', 'yes', 'fork', 'title'];
    let pendingMsgId: string | null = null;
    if (pendingCommands.includes(command)) {
      pendingMsgId = generateId();
      s.messages.value.push({
        id: pendingMsgId,
        role: 'system',
        content: `正在执行 /${command}${args ? ` ${args}` : ''}...`,
        tools: [],
        pending: true,
        ts: Date.now(),
        local: true,
      });
    }
    ctx.send({ type: 'command', command, ...(args ? { args } : {}), ...(pendingMsgId ? { pendingMsgId } : {}) });
  }

  function clearMessages(): void {
    s.messages.value = [];
    s.pendingApprovals.value = [];
  }

  function appendSystemMessage(text: string): void {
    s.messages.value.push({
      id: generateId(),
      role: 'system',
      content: text,
      tools: [],
      ts: Date.now(),
      local: true,
    });
  }

  function resolveApproval(id: string, decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session'): void {
    if (s.connectionStatus.value !== 'connected') {
      showToast('连接已断开，审批结果未发送。', 'error');
      ctx.connect();
      return;
    }
    s.pendingApprovals.value = s.pendingApprovals.value.filter((a) => a.id !== id);
    ctx.send({ type: 'approval_response', id, decision, ...(feedback ? { feedback } : {}), ...(scope ? { scope } : {}) });
  }

  function abort(): void {
    ctx.send({ type: 'abort' });
  }

  /** Fetch and prepend an older history page. Returns the number of messages added. */
  async function loadOlderMessages(): Promise<number> {
    const targetSession = s.sessionId.value;
    const cursor = s.oldestSeq.value;
    if (!targetSession || cursor === undefined) return 0;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSession}/messages?before=${cursor}&tail=50`);
      if (!res.ok) return 0;
      const data = (await res.json()) as { messages: ChatMessage[]; hasMore: boolean };
      if (data.messages.length === 0) return 0;
      const older = data.messages.map((m) => ({ ...m, id: m.id ?? generateId() }));
      s.messages.value = [...older, ...s.messages.value];
      s.oldestSeq.value = older[0]?.seq ?? cursor;
      s.olderAvailable.value = data.hasMore;
      return older.length;
    } catch {
      return 0;
    }
  }

  // ── WS handlers (message-domain frames) ────────────────────────────────

  onWsMessage(s, 'user_message', (msg) => {
    s.liveGeneration++;
    if (msg.clientMessageId && s.sentMessageIds.has(msg.clientMessageId)) {
      s.pendingPromptAccepted = true;
      // G5.4: only an offline-flush send carries queueText — advance the
      // queue for its echo. A plain send's echo must not shift the head.
      // (Entry is intentionally kept: duplicate user_message frames from
      // a lastSeq replay still dedupe against it.)
      if (s.sentMessageIds.get(msg.clientMessageId)?.queueText !== undefined) ctx.flushQueueNext();
      return;
    }
    s.messages.value.push({
      id: generateId(),
      role: 'user',
      content: msg.text,
      clientMessageId: msg.clientMessageId,
      tools: [],
      ts: Date.now(),
    });
  });

  onWsMessage(s, 'approval_request', (msg) => {
    s.liveGeneration++;
    s.pendingApprovals.value = [...s.pendingApprovals.value, { id: msg.id, toolName: msg.toolName, action: msg.action, display: msg.display }];
  });

  onWsMessage(s, 'approval_resolved', (msg) => {
    s.liveGeneration++;
    s.pendingApprovals.value = s.pendingApprovals.value.filter((a) => a.id !== msg.id);
  });

  onWsMessage(s, 'command_result', (msg) => {
    // Update pending message if it exists, otherwise add new message.
    const pendingIdx = msg.pendingMsgId
      ? s.messages.value.findIndex((m) => m.id === msg.pendingMsgId)
      : -1;
    if (pendingIdx >= 0) {
      const existing = s.messages.value[pendingIdx];
      s.messages.value[pendingIdx] = {
        ...existing,
        content: msg.message,
        isError: !msg.ok,
        pending: false,
      };
    } else {
      s.messages.value.push({
        id: generateId(),
        role: 'system',
        content: msg.message,
        tools: [],
        isError: !msg.ok,
        ts: Date.now(),
        local: true,
      });
    }
    // fork/title change the session list - refresh the sidebar.
    if (msg.command === 'fork' || msg.command === 'title') {
      void ctx.fetchSessions();
    }
    // compact changes message history - refresh snapshot to get the
    // compacted messages. Local messages (command results etc.) are
    // preserved by applySnapshot, so no manual save/restore needed.
    if (msg.ok && msg.command === 'compact') {
      void ctx.fetchSnapshot();
    }
  });

  onWsMessage(s, 'error', (msg) => {
    s.error.value = msg.message;
    if (msg.clientMessageId) {
      const pendingEntry = s.sentMessageIds.get(msg.clientMessageId);
      if (pendingEntry) {
        s.sentMessageIds.delete(msg.clientMessageId);
        s.promptPending.value = false;
        s.pendingPromptAccepted = false;
        const local = s.messages.value.find((m) => m.id === pendingEntry.messageId);
        if (local) local.isError = true;
        showToast(`消息未发送：${msg.message}`, 'error');
        // G5.4: drop the queued item only when THIS rejected send came
        // from the offline flush. A plain connected send must never
        // evict an unrelated queue head that was never sent.
        if (pendingEntry.queueText !== undefined) {
          ctx.removeOfflineQueueItem(pendingEntry.queueText);
        }
      }
    }
  });

  ctx.appendSystemMessage = appendSystemMessage;

  return { sendPrompt, sendCommand, clearMessages, appendSystemMessage, abort, resolveApproval, loadOlderMessages };
}
