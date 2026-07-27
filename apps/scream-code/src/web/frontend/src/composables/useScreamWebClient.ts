import { ref, computed, type Ref } from 'vue';
import type { ChatMessage, ApprovalRequest, SessionSnapshot, SessionListItem, SessionStatus, GitStatus, ModelInfo, ModelsResponse, WsMessage, ServerHello } from '../types';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const API_BASE = '/api/v1';
const HEARTBEAT_TIMEOUT_MS = 2 * 30000;

export interface UseScreamWebClientReturn {
  connectionStatus: Ref<ConnectionStatus>;
  messages: Ref<ChatMessage[]>;
  pendingApprovals: Ref<ApprovalRequest[]>;
  status: Ref<SessionStatus>;
  error: Ref<string | null>;
  sessionId: Ref<string | null>;
  workDir: Ref<string | null>;
  isBusy: Ref<boolean>;
  sessions: Ref<SessionListItem[]>;
  currentSessionId: Ref<string | null>;
  gitStatus: Ref<GitStatus | null>;
  models: Ref<ModelInfo[]>;
  sendPrompt: (text: string) => void;
  sendCommand: (command: string, args?: string) => void;
  clearMessages: () => void;
  appendSystemMessage: (text: string) => void;
  abort: () => void;
  resolveApproval: (id: string, decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session') => void;
  fetchSessions: () => Promise<void>;
  fetchGitStatus: () => Promise<void>;
  fetchModels: () => Promise<void>;
  switchModel: (alias: string) => Promise<void>;
  switchThinking: (level: string) => Promise<void>;
  createSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  exportSession: (sessionId: string) => Promise<void>;
  fetchSnapshot: () => Promise<void>;
}

export function useScreamWebClient(): UseScreamWebClientReturn {
  const connectionStatus = ref<ConnectionStatus>('connecting');
  const messages = ref<ChatMessage[]>([]);
  const pendingApprovals = ref<ApprovalRequest[]>([]);
  const status = ref<SessionStatus>({ busy: false });
  const error = ref<string | null>(null);
  const sessionId = ref<string | null>(null);
  const workDir = ref<string | null>(null);
  const isBusy = computed(() => status.value.busy);
  const sessions = ref<SessionListItem[]>([]);
  const currentSessionId = ref<string | null>(null);
  const gitStatus = ref<GitStatus | null>(null);
  const models = ref<ModelInfo[]>([]);

  let ws: WebSocket | null = null;
  let heartbeatTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let lastPongAt = Date.now();
  let seq = 0;
  let epoch = 0;
  let reconnectAttempt = 0;
  const sentMessageIds = new Set<string>();

  function wsUrl(): string {
    const base = `ws://${window.location.host}`;
    if (currentSessionId.value) {
      return `${base}/?sessionId=${encodeURIComponent(currentSessionId.value)}`;
    }
    return `${base}/`;
  }

  function setConnectionStatus(s: ConnectionStatus) {
    connectionStatus.value = s;
  }

  function send(obj: Record<string, unknown>) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  async function fetchSnapshot(): Promise<void> {
    if (!sessionId.value) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionId.value}/snapshot`);
      if (!res.ok) return;
      const snapshot: SessionSnapshot = await res.json();
      applySnapshot(snapshot);
    } catch {
      // Best-effort
    }
  }

  function applySnapshot(snapshot: SessionSnapshot): void {
    messages.value = snapshot.messages.map((m) => ({ ...m, id: m.id ?? generateId() }));
    pendingApprovals.value = snapshot.pendingApprovals;
    status.value = { ...snapshot.status, busy: snapshot.busy };
    workDir.value = snapshot.workDir;
  }

  function generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function startHeartbeat(ms: number): void {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = window.setInterval(() => {
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        ws?.close();
        return;
      }
      send({ type: 'ping' });
    }, ms);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return;
    setConnectionStatus('reconnecting');
    reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleMessage(msg: WsMessage): void {
    switch (msg.type) {
      case 'server_hello': {
        const hello = msg as ServerHello;
        sessionId.value = hello.sessionId;
        workDir.value = hello.workDir;
        currentSessionId.value = hello.sessionId;
        epoch = hello.epoch;
        startHeartbeat(hello.heartbeat_ms);
        send({ type: 'client_hello', lastSeq: seq, epoch });
        // Only activate archived sessions; skip if already active to avoid extra reconnect.
        if (hello.active === false) {
          void activateSession(hello.sessionId).then(() => {
            fetchSnapshot();
            void fetchSessions();
            void fetchGitStatus();
          });
        } else {
          fetchSnapshot();
          void fetchSessions();
          void fetchGitStatus();
        }
        break;
      }
      case 'event': {
        if (typeof msg.seq === 'number') seq = Math.max(seq, msg.seq);
        if (typeof msg.epoch === 'number') epoch = msg.epoch;
        onEvent(msg.payload);
        break;
      }
      case 'user_message': {
        if (msg.clientMessageId && sentMessageIds.has(msg.clientMessageId)) break;
        messages.value.push({
          id: generateId(),
          role: 'user',
          content: msg.text,
          tools: [],
          ts: Date.now(),
        });
        break;
      }
      case 'approval_request': {
        pendingApprovals.value = [...pendingApprovals.value, { id: msg.id, toolName: msg.toolName, action: msg.action, display: msg.display }];
        break;
      }
      case 'approval_resolved': {
        pendingApprovals.value = pendingApprovals.value.filter((a) => a.id !== msg.id);
        break;
      }
      case 'command_result': {
        // Update pending message if it exists, otherwise add new message.
        const pendingIdx = msg.pendingMsgId
          ? messages.value.findIndex((m) => m.id === msg.pendingMsgId)
          : -1;
        if (pendingIdx >= 0) {
          const existing = messages.value[pendingIdx];
          messages.value[pendingIdx] = {
            ...existing,
            content: msg.message,
            isError: !msg.ok,
            pending: false,
          };
        } else {
          messages.value.push({
            id: generateId(),
            role: 'system',
            content: msg.message,
            tools: [],
            isError: !msg.ok,
            ts: Date.now(),
          });
        }
        // fork/title change the session list - refresh the sidebar.
        if (msg.command === 'fork' || msg.command === 'title') {
          void fetchSessions();
        }
        // auto/yes/plan/compact change session state - refresh snapshot to update UI.
        if (msg.ok && ['auto', 'yes', 'plan', 'compact'].includes(msg.command)) {
          fetchSnapshot();
        }
        break;
      }
      case 'resync_required': {
        seq = 0;
        fetchSnapshot();
        break;
      }
      case 'status': {
        // Server-pushed status sync (e.g. model/thinking switched from another tab).
        status.value = { ...status.value, ...msg.status };
        break;
      }
      case 'error': {
        error.value = msg.message;
        break;
      }
    }
  }

  function onEvent(payload: { type: string; [key: string]: unknown }): void {
    switch (payload.type) {
      case 'turn.started': {
        status.value = { ...status.value, busy: true };
        messages.value.push({ id: generateId(), role: 'assistant', content: '', tools: [], ts: Date.now() });
        break;
      }
      case 'assistant.delta': {
        const last = lastAssistantMessage();
        if (last) last.content += String(payload.delta);
        break;
      }
      case 'thinking.delta': {
        const last = lastAssistantMessage();
        if (last) {
          const thinkingTool = last.tools.find((t) => t.name === 'thinking');
          if (thinkingTool) {
            thinkingTool.output = (thinkingTool.output ?? '') + String(payload.delta);
          } else {
            last.tools.push({ toolCallId: 'thinking', name: 'thinking', output: String(payload.delta) });
          }
        }
        break;
      }
      case 'tool.call.started': {
        const last = lastAssistantMessage();
        if (last) {
          last.tools.push({ toolCallId: String(payload.toolCallId), name: String(payload.name), args: payload.args });
        }
        break;
      }
      case 'tool.result': {
        const last = lastAssistantMessage();
        if (last) {
          const tool = last.tools.find((t) => t.toolCallId === payload.toolCallId);
          if (tool) {
            tool.output = String(payload.output);
            tool.isError = Boolean(payload.isError);
          }
        }
        break;
      }
      case 'tool.progress': {
        const last = lastAssistantMessage();
        if (last) {
          const tool = last.tools.find((t) => t.toolCallId === payload.toolCallId);
          if (tool) tool.output = String(payload.message ?? payload.output);
        }
        break;
      }
      case 'turn.ended': {
        status.value = { ...status.value, busy: false };
        if (payload.reason === 'failed') {
          const last = lastAssistantMessage();
          if (last) last.isError = true;
          error.value = String(payload.error?.message ?? 'Turn failed');
        }
        void fetchSessions();
        void fetchGitStatus();
        break;
      }
      case 'session.meta.updated': {
        const patch: Partial<SessionStatus> = {};
        if (payload.model !== undefined) patch.model = payload.model as string;
        if (payload.contextTokens !== undefined) patch.contextTokens = payload.contextTokens as number;
        if (payload.maxContextTokens !== undefined) patch.maxContextTokens = payload.maxContextTokens as number;
        if (payload.contextUsage !== undefined) patch.contextUsage = payload.contextUsage as number;
        status.value = { ...status.value, ...patch };
        break;
      }
      case 'error': {
        error.value = String(payload.error?.message ?? 'Unknown error');
        break;
      }
    }
  }

  function lastAssistantMessage(): ChatMessage | null {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'assistant') return messages.value[i];
    }
    return null;
  }

  function connect(): void {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    setConnectionStatus('connecting');
    error.value = null;
    seq = 0;
    epoch = 0;
    messages.value = [];
    pendingApprovals.value = [];
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttempt = 0;
    };

    ws.onclose = () => {
      stopHeartbeat();
      setConnectionStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      setConnectionStatus('reconnecting');
    };

    ws.onmessage = (e) => {
      lastPongAt = Date.now();
      let msg: WsMessage;
      try {
        msg = JSON.parse(e.data) as WsMessage;
      } catch {
        return;
      }
      handleMessage(msg);
    };
  }

  function sendPrompt(text: string): void {
    if (!text || status.value.busy) return;
    if (connectionStatus.value !== 'connected') {
      messages.value.push({
        id: generateId(),
        role: 'system',
        content: '连接已断开，消息未发送。正在尝试重连...',
        tools: [],
        isError: true,
        ts: Date.now(),
      });
      connect();
      return;
    }
    const clientMessageId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sentMessageIds.add(clientMessageId);
    messages.value.push({ id: generateId(), role: 'user', content: text, tools: [], ts: Date.now() });
    send({ type: 'prompt', text, clientMessageId });
  }

  function abort(): void {
    send({ type: 'abort' });
  }

  // ── Slash commands / local message ops ──────────────────────────────────

  function sendCommand(command: string, args?: string): void {
    // Side questions are designed to run during an active turn; other commands
    // mutate session state and must wait until the turn settles.
    if (status.value.busy && command !== 'btw') {
      appendSystemMessage(`会话忙碌中，无法执行 /${command}，请稍后再试。`);
      return;
    }
    // Show pending feedback for commands that take time.
    const pendingCommands = ['compact', 'plan', 'auto', 'yes', 'fork', 'title'];
    let pendingMsgId: string | null = null;
    if (pendingCommands.includes(command)) {
      pendingMsgId = generateId();
      messages.value.push({
        id: pendingMsgId,
        role: 'system',
        content: `正在执行 /${command}${args ? ` ${args}` : ''}...`,
        tools: [],
        pending: true,
        ts: Date.now(),
      });
    }
    send({ type: 'command', command, ...(args ? { args } : {}), ...(pendingMsgId ? { pendingMsgId } : {}) });
  }

  function clearMessages(): void {
    messages.value = [];
    pendingApprovals.value = [];
  }

  function appendSystemMessage(text: string): void {
    messages.value.push({
      id: generateId(),
      role: 'system',
      content: text,
      tools: [],
      ts: Date.now(),
    });
  }

  function resolveApproval(id: string, decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session'): void {
    pendingApprovals.value = pendingApprovals.value.filter((a) => a.id !== id);
    send({ type: 'approval_response', id, decision, ...(feedback ? { feedback } : {}), ...(scope ? { scope } : {}) });
  }

  // ── Session management ──────────────────────────────────────────────────

  async function fetchSessions(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions`);
      if (!res.ok) return;
      sessions.value = await res.json();
    } catch {
      // Best-effort
    }
  }

  async function activateSession(sessionId: string): Promise<void> {
    try {
      await fetch(`${API_BASE}/sessions/${sessionId}/activate`, { method: 'POST' });
    } catch {
      // Best-effort — archived sessions may already be active or unknown.
    }
  }

  async function fetchGitStatus(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/git/status`);
      if (!res.ok) return;
      const gs: GitStatus = await res.json();
      gitStatus.value = gs.isRepo ? gs : null;
    } catch {
      // Best-effort — git status is optional chrome.
    }
  }

  // ── Model / thinking switching (TUI /model parity) ────────────────────────

  async function fetchModels(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/models`);
      if (!res.ok) return;
      const data: ModelsResponse = await res.json();
      models.value = data.models;
    } catch {
      // Best-effort — model picker stays hidden when unavailable.
    }
  }

  /** POST a session mutation and apply the returned status / surface errors. */
  async function postSessionSwitch(path: string, body: Record<string, unknown>, okMessage: string): Promise<void> {
    if (!sessionId.value) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionId.value}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { status?: SessionStatus; message?: string };
      if (!res.ok) {
        appendSystemMessage(data.message ?? `请求失败（HTTP ${res.status}）`);
        return;
      }
      if (data.status) {
        status.value = { ...status.value, ...data.status };
      }
      appendSystemMessage(okMessage);
    } catch (error) {
      appendSystemMessage(`请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function switchModel(alias: string): Promise<void> {
    if (alias === status.value.model) return;
    await postSessionSwitch('model', { model: alias }, `已切换模型：${alias}`);
  }

  async function switchThinking(level: string): Promise<void> {
    if (level === status.value.thinkingLevel) return;
    await postSessionSwitch('thinking', { level }, `思考强度已切换为 ${level}`);
  }

  async function createSession(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions`, { method: 'POST' });
      if (!res.ok) return;
      const item: SessionListItem = await res.json();
      sessions.value = [item, ...sessions.value];
      await switchSession(item.sessionId);
    } catch (error) {
      console.error('Failed to create session', error); // eslint-disable-line no-console
    }
  }

  async function switchSession(targetId: string): Promise<void> {
    if (currentSessionId.value === targetId && connectionStatus.value === 'connected') return;
    currentSessionId.value = targetId;
    // Close existing connection and reconnect to the new session.
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    stopHeartbeat();
    connect();
  }

  async function deleteSession(targetId: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetId}`, { method: 'DELETE' });
      if (!res.ok) return;
      sessions.value = sessions.value.filter((s) => s.sessionId !== targetId);
      // If we deleted the current session, switch to the first remaining.
      if (currentSessionId.value === targetId) {
        const next = sessions.value[0];
        if (next) {
          await switchSession(next.sessionId);
        } else {
          await createSession();
        }
      }
    } catch (error) {
      console.error('Failed to delete session', error); // eslint-disable-line no-console
    }
  }

  async function exportSession(targetId: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetId}/export`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${targetId}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export session', error); // eslint-disable-line no-console
    }
  }

  // Initial connection.
  connect();
  void fetchSessions();
  void fetchModels();

  window.addEventListener('online', () => connect());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && connectionStatus.value !== 'connected') connect();
  });

  return {
    connectionStatus,
    messages,
    pendingApprovals,
    status,
    error,
    sessionId,
    workDir,
    isBusy,
    sessions,
    currentSessionId,
    gitStatus,
    models,
    sendPrompt,
    sendCommand,
    clearMessages,
    appendSystemMessage,
    abort,
    resolveApproval,
    fetchSessions,
    fetchGitStatus,
    fetchModels,
    switchModel,
    switchThinking,
    createSession,
    switchSession,
    deleteSession,
    exportSession,
    fetchSnapshot,
  };
}
