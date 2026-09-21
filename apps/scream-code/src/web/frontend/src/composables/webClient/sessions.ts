import type { GitStatus, SessionListItem } from '../../types';
import { isCurrentSessionRequest } from '../../utils/goalTodoState';
import { API_BASE, captureSessionRequest, isCurrentSessionRequest as isCurrentRestRequest, type ClientContext } from './state';

export interface SessionsModule {
  fetchSessions(): Promise<void>;
  fetchGitStatus(): Promise<void>;
  /** onCreated aligns with the implementation / facade (types.ts): it fires synchronously
   *  once the REST create succeeds but before the WS is connected, so callers can switch
   *  the view first and wait for the connection afterwards. */
  createSession(workDir?: string, onCreated?: (id: string) => void): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  exportSession(sessionId: string): Promise<void>;
}

export function createSessionsModule(ctx: ClientContext): SessionsModule {
  const { s, showToast } = ctx;

  // ── Session management ──────────────────────────────────────────────────

  async function fetchSessions(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions`);
      if (!res.ok) return;
      s.sessions.value = await res.json();
    } catch {
      // Best-effort
    }
  }

  async function activateSession(targetSessionId: string): Promise<boolean> {
    const targetSessionGeneration = s.sessionGeneration;
    const targetConnectionGeneration = s.connectionGeneration;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/activate`, { method: 'POST' });
      return res.ok && s.connectionGeneration === targetConnectionGeneration && isCurrentSessionRequest(
        s.sessionId.value,
        s.sessionGeneration,
        targetSessionId,
        targetSessionGeneration,
      );
    } catch {
      // Best-effort — archived sessions may already be active or unknown.
      return false;
    }
  }

  async function fetchGitStatus(): Promise<void> {
    const token = captureSessionRequest(s);
    try {
      // Git belongs to the selected session's workspace. Keep the query
      // optional for the idle/home state so older single-session servers and
      // bookmarked API calls retain their launch-directory fallback.
      const id = token?.sessionId ?? s.currentSessionId.value;
      const query = id ? `?sessionId=${encodeURIComponent(id)}` : '';
      const res = await fetch(`${API_BASE}/git/status${query}`);
      if (token && !isCurrentRestRequest(s, token)) return;
      if (!res.ok) return;
      const gs: GitStatus = await res.json();
      s.gitStatus.value = gs.isRepo ? gs : null;
    } catch {
      // Best-effort — git status is optional chrome.
    }
  }

  /** Creates a session; omitting workDir = use the server process directory (matches the old behavior).
   *  onCreated fires synchronously once the REST create succeeds and before the WS is connected —
   *  it is used to "switch the view first and connect asynchronously afterwards", removing the wait
   *  on the home page after a session is created. */
  async function createSession(workDir?: string, onCreated?: (id: string) => void): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        ...(workDir
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ workDir }),
            }
          : {}),
      });
      if (!res.ok) {
        // Server-side validation (e.g. an illegal directory) carries a human-readable
        // message: prefer it, fall back to the HTTP status.
        const detail = await res.json().catch(() => null);
        const message =
          detail && typeof (detail as { message?: unknown }).message === 'string'
            ? (detail as { message: string }).message
            : '';
        showToast(`新建会话失败：${message || `HTTP ${res.status}`}`, 'error');
        return;
      }
      const item: SessionListItem = await res.json();
      s.sessions.value = [item, ...s.sessions.value];
      onCreated?.(item.sessionId);
      await switchSession(item.sessionId);
    } catch (error) {
      showToast(`新建会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function switchSession(targetId: string): Promise<void> {
    if (s.currentSessionId.value === targetId && s.connectionStatus.value === 'connected') return;
    s.currentSessionId.value = targetId;
    s.sessionId.value = targetId;
    s.sessionGeneration++;
    ctx.resetGoalRequestState();
    s.seq = 0;
    s.epoch = 0;
    // journalGapCount means a "consecutive" gap count: it must reset across sessions. Otherwise
    // the count accumulated by the previous session would push the new session's first two
    // legitimate jumps (reconnect replays skip volatile events) straight onto the ≥3 error
    // escalation line, falsely reporting "the stream may be permanently corrupted".
    s.journalGapCount = 0;
    s.messages.value = [];
    s.pendingApprovals.value = [];
    s.status.value = { busy: false };
    s.gitStatus.value = null;
    s.workDir.value = null;
    s.goal.value = null;
    s.todos.value = [];
    s.sessionPlan.value = null;
    s.skills.value = [];
    s.skillsError.value = null;
    s.plugins.value = [];
    s.pluginInfo.value = null;
    s.mcpServers.value = [];
    s.mcpStartupMetrics.value = null;
    s.backgroundTasks.value = [];
    s.backgroundTaskOutput.value = '';
    s.subagents.value = [];
    s.sessionActive.value = false;
    s.promptPending.value = false;
    s.pendingPromptAccepted = false;
    s.sentMessageIds.clear();
    if (s.reconnectTimer !== null) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    if (s.snapshotRetryTimer !== null) {
      clearTimeout(s.snapshotRetryTimer);
      s.snapshotRetryTimer = null;
    }
    // Close existing connection and reconnect to the new session.
    if (s.ws) {
      s.ws.onclose = null;
      s.ws.close();
      s.ws = null;
    }
    ctx.stopHeartbeat();
    ctx.connect();
  }

  async function deleteSession(targetId: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetId}`, { method: 'DELETE' });
      if (!res.ok) {
        showToast(`删除会话失败（HTTP ${res.status}）`, 'error');
        return;
      }
      s.sessions.value = s.sessions.value.filter((s) => s.sessionId !== targetId);
      // If we deleted the current session, switch to the first remaining.
      if (s.currentSessionId.value === targetId) {
        const next = s.sessions.value[0];
        if (next) {
          await switchSession(next.sessionId);
        } else {
          // No sessions left: go idle instead of silently creating one.
          s.sessionGeneration++;
          ctx.resetGoalRequestState();
          s.sessionId.value = null;
          s.currentSessionId.value = null;
          s.sessionActive.value = false;
          s.seq = 0;
          s.epoch = 0;
          // Same as above: the whole session context is destroyed, so the gap count resets with it.
          s.journalGapCount = 0;
          s.messages.value = [];
          s.pendingApprovals.value = [];
          s.status.value = { busy: false };
          s.gitStatus.value = null;
          s.workDir.value = null;
          s.goal.value = null;
          s.todos.value = [];
          s.sessionPlan.value = null;
          s.skills.value = [];
          s.skillsError.value = null;
          s.plugins.value = [];
          s.pluginInfo.value = null;
          s.mcpServers.value = [];
          s.mcpStartupMetrics.value = null;
          s.backgroundTasks.value = [];
          s.backgroundTaskOutput.value = '';
          s.subagents.value = [];
          s.promptPending.value = false;
          s.pendingPromptAccepted = false;
          s.sentMessageIds.clear();
          if (s.ws) {
            s.ws.onclose = null;
            s.ws.close();
            s.ws = null;
          }
          ctx.stopHeartbeat();
          ctx.setConnectionStatus('idle');
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

  ctx.fetchSessions = fetchSessions;
  ctx.switchSession = switchSession;
  ctx.fetchGitStatus = fetchGitStatus;
  ctx.activateSession = activateSession;

  return { fetchSessions, fetchGitStatus, createSession, switchSession, deleteSession, exportSession };
}
