import type { GitStatus, SessionListItem } from '../../types';
import { isCurrentSessionRequest } from '../../utils/goalTodoState';
import { API_BASE, type ClientContext } from './state';

export interface SessionsModule {
  fetchSessions(): Promise<void>;
  fetchGitStatus(): Promise<void>;
  createSession(): Promise<void>;
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
    try {
      const res = await fetch(`${API_BASE}/git/status`);
      if (!res.ok) return;
      const gs: GitStatus = await res.json();
      s.gitStatus.value = gs.isRepo ? gs : null;
    } catch {
      // Best-effort — git status is optional chrome.
    }
  }

  async function createSession(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sessions`, { method: 'POST' });
      if (!res.ok) {
        showToast(`新建会话失败（HTTP ${res.status}）`, 'error');
        return;
      }
      const item: SessionListItem = await res.json();
      s.sessions.value = [item, ...s.sessions.value];
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
    s.messages.value = [];
    s.pendingApprovals.value = [];
    s.status.value = { busy: false };
    s.goal.value = null;
    s.todos.value = [];
    s.sessionPlan.value = null;
    s.skills.value = [];
    s.plugins.value = [];
    s.pluginInfo.value = null;
    s.mcpServers.value = [];
    s.mcpStartupMetrics.value = null;
    s.backgroundTasks.value = [];
    s.backgroundTaskOutput.value = '';
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
          s.messages.value = [];
          s.pendingApprovals.value = [];
          s.status.value = { busy: false };
          s.goal.value = null;
          s.todos.value = [];
          s.sessionPlan.value = null;
          s.skills.value = [];
          s.plugins.value = [];
          s.pluginInfo.value = null;
          s.mcpServers.value = [];
          s.mcpStartupMetrics.value = null;
          s.backgroundTasks.value = [];
          s.backgroundTaskOutput.value = '';
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
  ctx.fetchGitStatus = fetchGitStatus;
  ctx.activateSession = activateSession;

  return { fetchSessions, fetchGitStatus, createSession, switchSession, deleteSession, exportSession };
}
