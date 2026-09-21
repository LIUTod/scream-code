import type { WsMessage } from '../../types';
import { createDispatch } from './dispatch';
import {
  HEARTBEAT_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  onWsMessage,
  type ClientContext,
  type ConnectionStatus,
} from './state';

export interface ConnectionModule {
  connect(): void;
  waitForConnected(timeoutMs?: number): Promise<boolean>;
  send(obj: Record<string, unknown>): void;
  reconnectNow(): void;
  stopHeartbeat(): void;
}

export function createConnectionModule(ctx: ClientContext): ConnectionModule {
  const { s, showToast } = ctx;

  const handleMessage = createDispatch(ctx);

  function wsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${protocol}//${window.location.host}/api/v1/ws`;
    if (s.currentSessionId.value) {
      return `${base}?sessionId=${encodeURIComponent(s.currentSessionId.value)}`;
    }
    return base;
  }

  function setConnectionStatus(status: ConnectionStatus): void {
    s.connectionStatus.value = status;
  }

  /**
   * Wait for the current websocket handshake before dispatching a command.
   *
   * Session switches intentionally replace the socket asynchronously.  The
   * slash-command surface is shared by the home and conversation views, so a
   * command typed in that handoff window must wait instead of being silently
   * dropped by `sendCommand` / REST controls.  The idle/disposed checks make a
   * waiter resolve promptly when the selected session disappears.
   */
  function waitForConnected(timeoutMs = 8000): Promise<boolean> {
    if (s.connectionStatus.value === 'connected') return Promise.resolve(true);
    if (s.connectionStatus.value === 'idle' || s.disposed) return Promise.resolve(false);
    // A second session switch while this command is waiting must cancel the
    // dispatch rather than send the command into the newly selected chat.
    const targetSessionId = s.sessionId.value;
    if (!targetSessionId) return Promise.resolve(false);
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (s.sessionId.value !== targetSessionId) {
          window.clearInterval(timer);
          resolve(false);
        } else if (s.connectionStatus.value === 'connected') {
          window.clearInterval(timer);
          resolve(true);
        } else if (
          s.connectionStatus.value === 'idle' ||
          s.disposed ||
          Date.now() - started >= timeout
        ) {
          window.clearInterval(timer);
          resolve(false);
        }
      }, 50);
    });
  }

  function send(obj: Record<string, unknown>): void {
    if (s.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify(obj));
    }
  }

  function startHeartbeat(rawMs: number): void {
    stopHeartbeat();
    // heartbeat_ms arrives from the server unvalidated: an absurd value
    // (0 / NaN / hours) would hot-loop pings or starve the pong timeout.
    const ms = Number.isFinite(rawMs) && rawMs >= 1000 && rawMs <= 120000 ? rawMs : 15000;
    s.lastPongAt = Date.now();
    s.heartbeatTimer = window.setInterval(() => {
      if (Date.now() - s.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        s.ws?.close();
        return;
      }
      send({ type: 'ping' });
    }, ms);
  }

  function stopHeartbeat(): void {
    if (s.heartbeatTimer !== null) {
      clearInterval(s.heartbeatTimer);
      s.heartbeatTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (s.disposed || s.reconnectTimer !== null) return;
    if (s.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      // Terminal: an unbounded retry storm (e.g. a session the server keeps
      // rejecting) pins the tab in a reconnect loop forever. Surface a clear
      // error and stop; the banner's retry button calls reconnectNow().
      setConnectionStatus('disconnected');
      s.error.value = `连接失败：自动重试已达上限（${MAX_RECONNECT_ATTEMPTS} 次），请手动重试`;
      return;
    }
    setConnectionStatus('reconnecting');
    s.reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** s.reconnectAttempt, 30000);
    s.reconnectTimer = window.setTimeout(() => {
      s.reconnectTimer = null;
      connect();
    }, delay);
  }

  /** Force an immediate reconnect (connection banner "retry" button). */
  function reconnectNow(): void {
    if (s.disposed) return;
    if (s.reconnectTimer !== null) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    if (s.ws !== null) {
      try {
        s.ws.close();
      } catch {
        // already closed
      }
      s.ws = null;
    }
    s.reconnectAttempt = 0;
    connect();
  }

  function connect(): void {
    if (s.disposed || (s.ws && (s.ws.readyState === WebSocket.CONNECTING || s.ws.readyState === WebSocket.OPEN))) return;
    setConnectionStatus('connecting');
    s.error.value = null;
    ctx.resetGoalRequestState();
    s.connectionGeneration++;
    const socket = new WebSocket(wsUrl());
    s.ws = socket;

    socket.onclose = (event) => {
      if (s.ws !== socket) return;
      s.ws = null;
      stopHeartbeat();
      if (s.connectionStatus.value === 'idle') return;
      // 1008 = server rejected the session (deleted or unknown): go idle
      // instead of reconnect-looping; the user picks another session.
      if (event.code === 1008) {
        s.sessionGeneration++;
        ctx.resetGoalRequestState();
        s.sessionId.value = null;
        s.currentSessionId.value = null;
        s.sessionActive.value = false;
        s.goal.value = null;
        s.todos.value = [];
        s.subagents.value = [];
        s.sessionPlan.value = null;
        s.skills.value = [];
        s.skillsError.value = null;
        s.plugins.value = [];
        s.pluginInfo.value = null;
        s.mcpServers.value = [];
        s.mcpStartupMetrics.value = null;
        s.backgroundTasks.value = [];
        s.backgroundTaskOutput.value = '';
        s.pendingApprovals.value = [];
        s.status.value = { busy: false };
        s.gitStatus.value = null;
        s.workDir.value = null;
        // A rejected session's transcript must not haunt the idle view;
        // offlineQueue survives on purpose — unsent prompts wait for the
        // next session the user picks.
        s.messages.value = [];
        s.error.value = null;
        s.promptPending.value = false;
        s.sentMessageIds.clear();
        setConnectionStatus('idle');
        if (event.reason !== 'unauthorized') {
          showToast('会话不可用或已被删除', 'warning');
          void ctx.fetchSessions();
        }
        return;
      }
      setConnectionStatus('disconnected');
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (s.ws === socket) setConnectionStatus('reconnecting');
    };

    socket.onmessage = (e) => {
      if (s.ws !== socket) return;
      s.lastPongAt = Date.now();
      let msg: WsMessage;
      try {
        msg = JSON.parse(e.data) as WsMessage;
      } catch {
        return;
      }
      handleMessage(msg);
    };
  }

  // ── Connection-owned WS frames ──────────────────────────────────────────

  onWsMessage(s, 'server_hello', (hello) => {
    s.sessionId.value = hello.sessionId;
    s.workDir.value = hello.workDir;
    s.currentSessionId.value = hello.sessionId;
    s.sessionActive.value = hello.active;
    const resumeEpoch = s.epoch;
    s.epoch = hello.epoch;
    startHeartbeat(hello.heartbeat_ms);
    send({ type: 'client_hello', lastSeq: s.seq, epoch: resumeEpoch });
    if (resumeEpoch !== 0 && resumeEpoch !== hello.epoch) s.seq = 0;
    setConnectionStatus('connected');
    s.reconnectAttempt = 0;
    // G5.4: flush prompts queued while offline, oldest first. Send them
    // ONE AT A TIME: the server marks the session busy synchronously on
    // the first prompt, so back-to-back sends would be rejected and the
    // queue was already emptied. Each item is only removed after the
    // server echoes it back via user_message; a rejection re-queues it.
    ctx.flushQueue();
    // Snapshot carries the authoritative journal/status baseline. Start the
    // remaining session projections only after it settles so a slower snapshot
    // cannot overwrite a newer REST status/plan response (or vice versa).
    // `server_hello` handlers can outlive a subsequent session switch while
    // their snapshot/activation promises settle. Capture this particular
    // connection identity so its finally callback never starts a resource
    // refresh for whichever session happened to become current later.
    const helloSessionGeneration = s.sessionGeneration;
    const helloConnectionGeneration = s.connectionGeneration;
    const isHelloCurrent = () =>
      s.sessionId.value === hello.sessionId &&
      s.currentSessionId.value === hello.sessionId &&
      s.sessionGeneration === helloSessionGeneration &&
      s.connectionGeneration === helloConnectionGeneration;
    const refreshSessionData = () => {
      if (!isHelloCurrent()) return;
      void ctx.fetchSnapshot().finally(() => {
        if (isHelloCurrent()) void ctx.refreshSessionResources?.();
      });
      void ctx.fetchSessions();
      void ctx.fetchGitStatus();
    };
    // Only activate archived sessions; skip if already active to avoid extra reconnect.
    if (!hello.active) {
      void ctx.activateSession(hello.sessionId).then((active) => {
        if (!isHelloCurrent()) return;
        if (active && s.sessionId.value === hello.sessionId) s.sessionActive.value = true;
        refreshSessionData();
      });
    } else {
      refreshSessionData();
    }
  });

  onWsMessage(s, 'server_empty', () => {
    // Server has no session yet; stay idle instead of reconnect-looping.
    setConnectionStatus('idle');
  });

  onWsMessage(s, 'pong', () => {
    // Nothing to do; the pong refreshed lastPongAt in the onmessage wrapper.
  });

  ctx.connect = connect;
  ctx.waitForConnected = waitForConnected;
  ctx.send = send;
  ctx.stopHeartbeat = stopHeartbeat;
  ctx.setConnectionStatus = setConnectionStatus;

  return { connect, waitForConnected, send, reconnectNow, stopHeartbeat };
}
