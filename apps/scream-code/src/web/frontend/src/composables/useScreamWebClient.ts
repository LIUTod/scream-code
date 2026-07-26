import { ref, computed, type Ref } from 'vue';
import type { ChatMessage, ApprovalRequest, SessionSnapshot, SessionStatus, WsMessage, ServerHello } from '../types';

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
  sendPrompt: (text: string) => void;
  abort: () => void;
  resolveApproval: (id: string, decision: 'approved' | 'rejected') => void;
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

  let ws: WebSocket | null = null;
  let heartbeatTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let lastPongAt = Date.now();
  let seq = 0;
  let epoch = 0;
  let reconnectAttempt = 0;
  const sentMessageIds = new Set<string>();

  function wsUrl(): string {
    return `ws://${window.location.host}/`;
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
    status.value = snapshot.status;
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
        epoch = hello.epoch;
        startHeartbeat(hello.heartbeat_ms);
        send({ type: 'client_hello', lastSeq: seq, epoch });
        fetchSnapshot();
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
      case 'resync_required': {
        seq = 0;
        fetchSnapshot();
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
        messages.value.push({ id: generateId(), role: 'assistant', content: '', tools: [] });
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
        break;
      }
      case 'session.meta.updated': {
        status.value = {
          ...status.value,
          model: payload.model as string | undefined,
          contextTokens: payload.contextTokens as number | undefined,
          maxContextTokens: payload.maxContextTokens as number | undefined,
          contextUsage: payload.contextUsage as number | undefined,
        };
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
    const clientMessageId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sentMessageIds.add(clientMessageId);
    messages.value.push({ id: generateId(), role: 'user', content: text, tools: [] });
    send({ type: 'prompt', text, clientMessageId });
  }

  function abort(): void {
    send({ type: 'abort' });
  }

  function resolveApproval(id: string, decision: 'approved' | 'rejected'): void {
    pendingApprovals.value = pendingApprovals.value.filter((a) => a.id !== id);
    send({ type: 'approval_response', id, decision });
  }

  // Initial connection.
  connect();

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
    sendPrompt,
    abort,
    resolveApproval,
  };
}
