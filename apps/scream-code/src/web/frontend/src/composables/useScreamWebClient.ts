import { ref, computed, onBeforeUnmount, type Ref } from 'vue';
import type {
  ApprovalRequest,
  ChatMessage,
  CreateGoalRequest,
  GitStatus,
  GoalSnapshot,
  ModelInfo,
  ModelsResponse,
  SessionListItem,
  SessionSnapshot,
  SessionStatus,
  TodoItem,
  UpdateGoalRequest,
  WsMessage,
} from '../types';
import {
  acceptJournalEvent,
  applyGoalTodoEvent,
  buildCreateGoalBody,
  buildUpdateGoalBody,
  canApplySnapshot,
  isCurrentSessionRequest,
} from '../utils/goalTodoState';
import { useToast } from './useToast';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'idle';

const API_BASE = '/api/v1';
const HEARTBEAT_TIMEOUT_MS = 2 * 30000;

export interface UseScreamWebClientReturn {
  connectionStatus: Ref<ConnectionStatus>;
  messages: Ref<ChatMessage[]>;
  pendingApprovals: Ref<ApprovalRequest[]>;
  status: Ref<SessionStatus>;
  goal: Ref<GoalSnapshot | null>;
  todos: Ref<TodoItem[]>;
  goalRequestPending: Ref<boolean>;
  goalRequestError: Ref<string | null>;
  error: Ref<string | null>;
  sessionId: Ref<string | null>;
  workDir: Ref<string | null>;
  isBusy: Ref<boolean>;
  isArchived: Ref<boolean>;
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
  refineGoal: (description: string) => Promise<string | null>;
  createGoal: (request: CreateGoalRequest) => Promise<boolean>;
  updateGoal: (request: UpdateGoalRequest) => Promise<boolean>;
  pauseGoal: () => Promise<boolean>;
  resumeGoal: () => Promise<boolean>;
  cancelGoal: () => Promise<boolean>;
  createSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  exportSession: (sessionId: string) => Promise<void>;
  fetchSnapshot: () => Promise<void>;
}

export function useScreamWebClient(): UseScreamWebClientReturn {
  const { showToast } = useToast();
  const connectionStatus = ref<ConnectionStatus>('connecting');
  const messages = ref<ChatMessage[]>([]);
  const pendingApprovals = ref<ApprovalRequest[]>([]);
  const status = ref<SessionStatus>({ busy: false });
  const goal = ref<GoalSnapshot | null>(null);
  const todos = ref<TodoItem[]>([]);
  const goalRequestPending = ref(false);
  const goalRequestError = ref<string | null>(null);
  const promptPending = ref(false);
  const error = ref<string | null>(null);
  const sessionId = ref<string | null>(null);
  const workDir = ref<string | null>(null);
  const isBusy = computed(() => status.value.busy || promptPending.value);
  const sessions = ref<SessionListItem[]>([]);
  const currentSessionId = ref<string | null>(null);
  const sessionActive = ref(false);
  const isArchived = computed(() => sessionId.value !== null && !sessionActive.value);
  const gitStatus = ref<GitStatus | null>(null);
  const models = ref<ModelInfo[]>([]);

  let ws: WebSocket | null = null;
  let heartbeatTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let snapshotRetryTimer: number | null = null;
  let lastPongAt = Date.now();
  let seq = 0;
  let epoch = 0;
  let reconnectAttempt = 0;
  let sessionGeneration = 0;
  let connectionGeneration = 0;
  let promptGeneration = 0;
  let liveGeneration = 0;
  let sessionMutationGeneration = 0;
  let goalMutationGeneration = 0;
  let goalAwaitingMutation: { generation: number } | null = null;
  let goalRequestInFlight = false;
  let snapshotRetryGoalGeneration: number | null = null;
  let pendingPromptAccepted = false;
  let disposed = false;
  const sentMessageIds = new Map<string, { messageId: string; connectionGeneration: number }>();

  function wsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${protocol}//${window.location.host}/api/v1/ws`;
    if (currentSessionId.value) {
      return `${base}?sessionId=${encodeURIComponent(currentSessionId.value)}`;
    }
    return base;
  }

  function setConnectionStatus(s: ConnectionStatus) {
    connectionStatus.value = s;
  }

  function send(obj: Record<string, unknown>) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function syncGoalRequestPending(): void {
    goalRequestPending.value = goalRequestInFlight || goalAwaitingMutation !== null;
  }

  function resetGoalRequestState(): void {
    goalMutationGeneration++;
    goalAwaitingMutation = null;
    goalRequestInFlight = false;
    snapshotRetryGoalGeneration = null;
    goalRequestPending.value = false;
    goalRequestError.value = null;
  }

  function eventErrorMessage(value: unknown, fallback: string): string {
    if (value !== null && typeof value === 'object') {
      const message = (value as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    return fallback;
  }

  function scheduleSnapshotRetry(): void {
    if (disposed || snapshotRetryTimer !== null) return;
    snapshotRetryTimer = window.setTimeout(() => {
      snapshotRetryTimer = null;
      const goalGeneration = snapshotRetryGoalGeneration;
      snapshotRetryGoalGeneration = null;
      void fetchSnapshot(goalGeneration ?? undefined);
    }, 250);
  }

  async function fetchSnapshot(goalGeneration?: number): Promise<void> {
    const targetSessionId = sessionId.value;
    if (!targetSessionId) return;
    const targetSessionGeneration = sessionGeneration;
    const targetConnectionGeneration = connectionGeneration;
    const targetPromptGeneration = promptGeneration;
    const targetLiveGeneration = liveGeneration;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/snapshot`);
      if (!res.ok) {
        if (goalGeneration !== undefined && goalAwaitingMutation?.generation === goalGeneration) {
          snapshotRetryGoalGeneration = goalGeneration;
          scheduleSnapshotRetry();
        }
        return;
      }
      const snapshot: SessionSnapshot = await res.json();
      if (!canApplySnapshot({
        snapshot,
        targetSessionId,
        currentSessionId: sessionId.value,
        targetSessionGeneration,
        currentSessionGeneration: sessionGeneration,
        targetConnectionGeneration,
        currentConnectionGeneration: connectionGeneration,
        targetPromptGeneration,
        currentPromptGeneration: promptGeneration,
        targetLiveGeneration,
        currentLiveGeneration: liveGeneration,
        currentEpoch: epoch,
        currentSeq: seq,
      })) {
        if (goalGeneration !== undefined) snapshotRetryGoalGeneration = goalGeneration;
        scheduleSnapshotRetry();
        return;
      }
      applySnapshot(snapshot, goalGeneration);
    } catch {
      if (goalGeneration !== undefined && goalAwaitingMutation?.generation === goalGeneration) {
        snapshotRetryGoalGeneration = goalGeneration;
        scheduleSnapshotRetry();
      }
    }
  }

  function applySnapshot(snapshot: SessionSnapshot, goalGeneration?: number): void {
    // Preserve local-only messages (command results, system notices) that are
    // not in the server journal. Without this, applySnapshot's full replace
    // would drop them - the "闪一下" bug.
    const localMsgs = messages.value.filter((m) => m.local);
    const pendingClientId = sentMessageIds.keys().next().value;
    const pendingEntry = pendingClientId ? sentMessageIds.get(pendingClientId) : undefined;
    const pendingLocal = pendingEntry
      ? messages.value.find((m) => m.id === pendingEntry.messageId)
      : undefined;
    const pendingCovered = Boolean(
      pendingClientId && snapshot.messages.some((m) => m.clientMessageId === pendingClientId),
    );
    const pendingLost = Boolean(
      pendingEntry && !pendingCovered && pendingEntry.connectionGeneration < connectionGeneration,
    );
    if (pendingLost && pendingLocal) pendingLocal.isError = true;
    const pendingMessages = pendingLocal && !pendingCovered ? [pendingLocal] : [];
    messages.value = [
      ...snapshot.messages.map((m) => ({ ...m, id: m.id ?? generateId() })),
      ...localMsgs,
      ...pendingMessages,
    ];
    pendingApprovals.value = snapshot.pendingApprovals;
    status.value = { ...snapshot.status, busy: snapshot.busy };
    goal.value = snapshot.goal;
    todos.value = snapshot.todos;
    if (
      goalGeneration !== undefined &&
      goalAwaitingMutation !== null &&
      goalAwaitingMutation.generation === goalGeneration &&
      goalMutationGeneration === goalGeneration
    ) {
      goalAwaitingMutation = null;
      syncGoalRequestPending();
    }
    if (pendingCovered || pendingLost) {
      promptPending.value = false;
      pendingPromptAccepted = false;
      sentMessageIds.clear();
      if (pendingLost) showToast('消息未送达，已恢复连接。', 'error');
    }
    seq = snapshot.seq;
    epoch = snapshot.epoch;
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
    if (disposed || reconnectTimer !== null) return;
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
        const hello = msg;
        sessionId.value = hello.sessionId;
        workDir.value = hello.workDir;
        currentSessionId.value = hello.sessionId;
        sessionActive.value = hello.active;
        const resumeEpoch = epoch;
        epoch = hello.epoch;
        startHeartbeat(hello.heartbeat_ms);
        send({ type: 'client_hello', lastSeq: seq, epoch: resumeEpoch });
        if (resumeEpoch !== 0 && resumeEpoch !== hello.epoch) seq = 0;
        setConnectionStatus('connected');
        reconnectAttempt = 0;
        // Only activate archived sessions; skip if already active to avoid extra reconnect.
        if (!hello.active) {
          void activateSession(hello.sessionId).then((active) => {
            if (active && sessionId.value === hello.sessionId) sessionActive.value = true;
            void fetchSnapshot();
            void fetchSessions();
            void fetchGitStatus();
          });
        } else {
          void fetchSnapshot();
          void fetchSessions();
          void fetchGitStatus();
        }
        break;
      }
      case 'event': {
        const decision = acceptJournalEvent(epoch, seq, msg);
        if (decision === 'resync') {
          epoch = msg.epoch;
          seq = 0;
          void fetchSnapshot();
          break;
        }
        if (decision === 'duplicate') break;
        seq = msg.seq;
        epoch = msg.epoch;
        liveGeneration++;
        onEvent(msg.payload);
        break;
      }
      case 'user_message': {
        liveGeneration++;
        if (msg.clientMessageId && sentMessageIds.has(msg.clientMessageId)) {
          pendingPromptAccepted = true;
          break;
        }
        messages.value.push({
          id: generateId(),
          role: 'user',
          content: msg.text,
          clientMessageId: msg.clientMessageId,
          tools: [],
          ts: Date.now(),
        });
        break;
      }
      case 'approval_request': {
        liveGeneration++;
        pendingApprovals.value = [...pendingApprovals.value, { id: msg.id, toolName: msg.toolName, action: msg.action, display: msg.display }];
        break;
      }
      case 'approval_resolved': {
        liveGeneration++;
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
            local: true,
          });
        }
        // fork/title change the session list - refresh the sidebar.
        if (msg.command === 'fork' || msg.command === 'title') {
          void fetchSessions();
        }
        // compact changes message history - refresh snapshot to get the
        // compacted messages. Local messages (command results etc.) are
        // preserved by applySnapshot, so no manual save/restore needed.
        if (msg.ok && msg.command === 'compact') {
          void fetchSnapshot();
        }
        break;
      }
      case 'resync_required': {
        seq = 0;
        void fetchSnapshot();
        break;
      }
      case 'status': {
        liveGeneration++;
        // Server-pushed status sync (e.g. model/thinking switched from another tab).
        status.value = { ...status.value, ...msg.status };
        break;
      }
      case 'error': {
        error.value = msg.message;
        if (msg.clientMessageId) {
          const pendingEntry = sentMessageIds.get(msg.clientMessageId);
          if (pendingEntry) {
            sentMessageIds.delete(msg.clientMessageId);
            promptPending.value = false;
            pendingPromptAccepted = false;
            const local = messages.value.find((m) => m.id === pendingEntry.messageId);
            if (local) local.isError = true;
            showToast(`消息未发送：${msg.message}`, 'error');
          }
        }
        break;
      }
      case 'server_empty': {
        // Server has no session yet; stay idle instead of reconnect-looping.
        setConnectionStatus('idle');
        break;
      }
      case 'pong':
        break;
    }
  }

  function onEvent(payload: { type: string; [key: string]: unknown }): void {
    const goalTodoState = applyGoalTodoEvent({ goal: goal.value, todos: todos.value }, payload);
    goal.value = goalTodoState.goal;
    todos.value = goalTodoState.todos;
    if (
      payload.type === 'goal.updated' &&
      goalAwaitingMutation !== null &&
      goalAwaitingMutation.generation === goalMutationGeneration
    ) {
      goalAwaitingMutation = null;
      snapshotRetryGoalGeneration = null;
      syncGoalRequestPending();
    }

    switch (payload.type) {
      case 'turn.started': {
        if (pendingPromptAccepted) {
          promptPending.value = false;
          pendingPromptAccepted = false;
          sentMessageIds.clear();
        }
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
          error.value = eventErrorMessage(payload.error, 'Turn failed');
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
        error.value = eventErrorMessage(payload.error, 'Unknown error');
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
    if (disposed || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;

    setConnectionStatus('connecting');
    error.value = null;
    resetGoalRequestState();
    connectionGeneration++;
    const socket = new WebSocket(wsUrl());
    ws = socket;

    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      stopHeartbeat();
      if (connectionStatus.value === 'idle') return;
      // 1008 = server rejected the session (deleted or unknown): go idle
      // instead of reconnect-looping; the user picks another session.
      if (event.code === 1008) {
        sessionGeneration++;
        resetGoalRequestState();
        sessionId.value = null;
        currentSessionId.value = null;
        sessionActive.value = false;
        goal.value = null;
        todos.value = [];
        setConnectionStatus('idle');
        return;
      }
      setConnectionStatus('disconnected');
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws === socket) setConnectionStatus('reconnecting');
    };

    socket.onmessage = (e) => {
      if (ws !== socket) return;
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
    if (!text || isBusy.value) return;
    if (connectionStatus.value === 'idle') {
      showToast('暂无会话，请先新建会话。', 'warning');
      return;
    }
    if (connectionStatus.value !== 'connected') {
      showToast('连接已断开，正在尝试重连...', 'error');
      connect();
      return;
    }
    const clientMessageId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const localMessageId = generateId();
    sentMessageIds.set(clientMessageId, { messageId: localMessageId, connectionGeneration });
    promptGeneration++;
    pendingPromptAccepted = false;
    promptPending.value = true;
    messages.value.push({ id: localMessageId, role: 'user', content: text, clientMessageId, tools: [], ts: Date.now() });
    send({ type: 'prompt', text, clientMessageId });
  }

  function abort(): void {
    send({ type: 'abort' });
  }

  // ── Slash commands / local message ops ──────────────────────────────────

  function sendCommand(command: string, args?: string): void {
    if (connectionStatus.value === 'idle') {
      showToast('暂无会话，请先新建会话。', 'warning');
      return;
    }
    if (connectionStatus.value !== 'connected') {
      showToast('连接已断开，命令未发送。', 'error');
      connect();
      return;
    }
    // Side questions are designed to run during an active turn; other commands
    // mutate session state and must wait until the turn settles.
    if (isBusy.value && command !== 'btw') {
      showToast(`会话忙碌中，无法执行 /${command}，请稍后再试。`, 'warning');
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
        local: true,
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
      local: true,
    });
  }

  function resolveApproval(id: string, decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session'): void {
    if (connectionStatus.value !== 'connected') {
      showToast('连接已断开，审批结果未发送。', 'error');
      connect();
      return;
    }
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

  async function activateSession(targetSessionId: string): Promise<boolean> {
    const targetSessionGeneration = sessionGeneration;
    const targetConnectionGeneration = connectionGeneration;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/activate`, { method: 'POST' });
      return res.ok && connectionGeneration === targetConnectionGeneration && isCurrentSessionRequest(
        sessionId.value,
        sessionGeneration,
        targetSessionId,
        targetSessionGeneration,
      );
    } catch {
      // Best-effort — archived sessions may already be active or unknown.
      return false;
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
    const targetSessionId = sessionId.value;
    if (!targetSessionId) return;
    const targetSessionGeneration = sessionGeneration;
    const targetConnectionGeneration = connectionGeneration;
    const requestGeneration = ++sessionMutationGeneration;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { status?: SessionStatus; message?: string };
      if (
        sessionId.value !== targetSessionId ||
        sessionGeneration !== targetSessionGeneration ||
        connectionGeneration !== targetConnectionGeneration ||
        sessionMutationGeneration !== requestGeneration
      ) return;
      if (!res.ok) {
        showToast(data.message ?? `请求失败（HTTP ${res.status}）`, 'error');
        return;
      }
      if (data.status) {
        status.value = { ...status.value, ...data.status };
      }
      appendSystemMessage(okMessage);
    } catch (error) {
      if (
        sessionId.value !== targetSessionId ||
        sessionGeneration !== targetSessionGeneration ||
        connectionGeneration !== targetConnectionGeneration ||
        sessionMutationGeneration !== requestGeneration
      ) return;
      showToast(`请求失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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

  async function requestGoal(
    path: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    waitForState: boolean,
  ): Promise<Record<string, unknown> | null> {
    const targetSessionId = sessionId.value;
    if (!targetSessionId) {
      goalRequestError.value = '暂无可操作的会话。';
      return null;
    }
    if (connectionStatus.value !== 'connected') {
      goalRequestError.value = '连接已断开，请等待重连后再试。';
      return null;
    }
    if (isArchived.value) {
      goalRequestError.value = '当前会话已归档，无法修改 Goal。';
      return null;
    }
    if (goalRequestInFlight) {
      goalRequestError.value = '正在处理上一个请求，请稍候。';
      return null;
    }
    if (goalAwaitingMutation !== null) {
      // Stale guard: if waiting too long, clear and allow retry.
      goalAwaitingMutation = null;
      syncGoalRequestPending();
    }

    const targetSessionGeneration = sessionGeneration;
    const requestGeneration = ++goalMutationGeneration;
    goalRequestInFlight = true;
    syncGoalRequestPending();
    goalRequestError.value = null;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/goal${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (
        !isCurrentSessionRequest(
          sessionId.value,
          sessionGeneration,
          targetSessionId,
          targetSessionGeneration,
        ) || goalMutationGeneration !== requestGeneration
      ) return null;
      if (!res.ok) {
        goalRequestError.value = typeof data['message'] === 'string'
          ? data['message']
          : `请求失败（HTTP ${res.status}）`;
        return null;
      }
      if (waitForState) {
        goalAwaitingMutation = { generation: requestGeneration };
        snapshotRetryGoalGeneration = requestGeneration;
      }
      return data;
    } catch (requestError) {
      if (
        isCurrentSessionRequest(
          sessionId.value,
          sessionGeneration,
          targetSessionId,
          targetSessionGeneration,
        ) && goalMutationGeneration === requestGeneration
      ) {
        goalRequestError.value = `请求失败：${requestError instanceof Error ? requestError.message : String(requestError)}`;
      }
      return null;
    } finally {
      if (
        isCurrentSessionRequest(
          sessionId.value,
          sessionGeneration,
          targetSessionId,
          targetSessionGeneration,
        ) && goalMutationGeneration === requestGeneration
      ) {
        goalRequestInFlight = false;
        syncGoalRequestPending();
      }
    }
  }

  async function refineGoal(description: string): Promise<string | null> {
    const data = await requestGoal('/refine', 'POST', { description }, false);
    return typeof data?.['objective'] === 'string' ? data['objective'] : null;
  }

  async function createGoal(request: CreateGoalRequest): Promise<boolean> {
    const data = await requestGoal('', 'POST', buildCreateGoalBody(request), true);
    if (data === null) return false;
    if (goalAwaitingMutation !== null) void fetchSnapshot(goalAwaitingMutation.generation);
    return true;
  }

  async function updateGoal(request: UpdateGoalRequest): Promise<boolean> {
    const data = await requestGoal('', 'PATCH', buildUpdateGoalBody(request), true);
    if (data === null) return false;
    if (goalAwaitingMutation !== null) void fetchSnapshot(goalAwaitingMutation.generation);
    return true;
  }

  async function runGoalLifecycle(path: '/pause' | '/resume' | '/cancel'): Promise<boolean> {
    const data = await requestGoal(path, 'POST', {}, true);
    if (data === null) return false;
    if (goalAwaitingMutation !== null) void fetchSnapshot(goalAwaitingMutation.generation);
    return true;
  }

  function pauseGoal(): Promise<boolean> {
    return runGoalLifecycle('/pause');
  }

  function resumeGoal(): Promise<boolean> {
    return runGoalLifecycle('/resume');
  }

  function cancelGoal(): Promise<boolean> {
    return runGoalLifecycle('/cancel');
  }

  async function createSession(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions`, { method: 'POST' });
      if (!res.ok) {
        showToast(`新建会话失败（HTTP ${res.status}）`, 'error');
        return;
      }
      const item: SessionListItem = await res.json();
      sessions.value = [item, ...sessions.value];
      await switchSession(item.sessionId);
    } catch (error) {
      showToast(`新建会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function switchSession(targetId: string): Promise<void> {
    if (currentSessionId.value === targetId && connectionStatus.value === 'connected') return;
    currentSessionId.value = targetId;
    sessionId.value = targetId;
    sessionGeneration++;
    resetGoalRequestState();
    seq = 0;
    epoch = 0;
    messages.value = [];
    pendingApprovals.value = [];
    status.value = { busy: false };
    goal.value = null;
    todos.value = [];
    sessionActive.value = false;
    promptPending.value = false;
    pendingPromptAccepted = false;
    sentMessageIds.clear();
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (snapshotRetryTimer !== null) {
      clearTimeout(snapshotRetryTimer);
      snapshotRetryTimer = null;
    }
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
      if (!res.ok) {
        showToast(`删除会话失败（HTTP ${res.status}）`, 'error');
        return;
      }
      sessions.value = sessions.value.filter((s) => s.sessionId !== targetId);
      // If we deleted the current session, switch to the first remaining.
      if (currentSessionId.value === targetId) {
        const next = sessions.value[0];
        if (next) {
          await switchSession(next.sessionId);
        } else {
          // No sessions left: go idle instead of silently creating one.
          sessionGeneration++;
          resetGoalRequestState();
          sessionId.value = null;
          currentSessionId.value = null;
          sessionActive.value = false;
          seq = 0;
          epoch = 0;
          messages.value = [];
          pendingApprovals.value = [];
          status.value = { busy: false };
          goal.value = null;
          todos.value = [];
          promptPending.value = false;
          pendingPromptAccepted = false;
          sentMessageIds.clear();
          if (ws) {
            ws.onclose = null;
            ws.close();
            ws = null;
          }
          stopHeartbeat();
          setConnectionStatus('idle');
        }
      }
    } catch (error) {
      showToast(`删除会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function exportSession(targetId: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetId}/export`);
      if (!res.ok) {
        showToast(`导出会话失败（HTTP ${res.status}）`, 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${targetId}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showToast(`导出会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  // Initial connection.
  connect();
  void fetchSessions();
  void fetchModels();

  const handleOnline = () => {
    connect();
  };
  const handleVisibilityChange = () => {
    if (!document.hidden && connectionStatus.value !== 'connected') connect();
  };
  window.addEventListener('online', handleOnline);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  onBeforeUnmount(() => {
    disposed = true;
    window.removeEventListener('online', handleOnline);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    stopHeartbeat();
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (snapshotRetryTimer !== null) {
      clearTimeout(snapshotRetryTimer);
      snapshotRetryTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  });

  return {
    connectionStatus,
    messages,
    pendingApprovals,
    status,
    goal,
    todos,
    goalRequestPending,
    goalRequestError,
    error,
    sessionId,
    workDir,
    isBusy,
    isArchived,
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
    refineGoal,
    createGoal,
    updateGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    createSession,
    switchSession,
    deleteSession,
    exportSession,
    fetchSnapshot,
  };
}
