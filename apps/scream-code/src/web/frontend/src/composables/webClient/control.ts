import type { AgentContextData, SessionPlan, SessionStatus, SessionUsage } from '../../types';
import { API_BASE, type ClientContext } from './state';

export interface ControlModule {
  fetchSessionStatus(): Promise<void>;
  fetchSessionUsage(): Promise<void>;
  fetchSessionContext(): Promise<void>;
  fetchSessionPlan(): Promise<void>;
  clearPlan(): Promise<boolean>;
  switchPermission(mode: string): Promise<boolean>;
  switchPlanMode(enabled: boolean, strategy?: 'normal' | 'fusion'): Promise<boolean>;
  switchWolfpack(enabled: boolean): Promise<boolean>;
  switchRlm(enabled: boolean, maxDepth?: number): Promise<boolean>;
  undoHistory(count?: number): Promise<boolean>;
  compact(instruction?: string): Promise<boolean>;
}

export function createControlModule(ctx: ClientContext): ControlModule {
  const { s, showToast } = ctx;

  // ── Session-control / resource / global REST methods ────────────────────
  // These mirror the endpoints exposed in server.ts (see apps/scream-code/src/web/README.md).

  /** Read-only session-scoped fetches, best-effort (no toast on failure). */
  async function fetchSessionStatus(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/status`);
      if (!res.ok) return;
      const data: SessionStatus = await res.json();
      s.status.value = { ...s.status.value, ...data };
    } catch { /* best-effort */ }
  }

  async function fetchSessionUsage(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/usage`);
      if (!res.ok) return;
      const usage = (await res.json()) as SessionUsage;
      s.status.value = { ...s.status.value, usage };
    } catch { /* best-effort */ }
  }

  async function fetchSessionContext(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/context`);
      if (!res.ok) return;
      const contextData = (await res.json()) as AgentContextData;
      if (contextData.tokenCount !== undefined) s.status.value = { ...s.status.value, contextTokens: contextData.tokenCount };
    } catch { /* best-effort */ }
  }

  async function fetchSessionPlan(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/plan`);
      if (!res.ok) return;
      s.sessionPlan.value = (await res.json()) as SessionPlan;
    } catch { /* best-effort */ }
  }

  async function clearPlan(): Promise<boolean> {
    const id = s.sessionId.value;
    if (!id) return false;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/plan/clear`, { method: 'POST' });
      if (!res.ok) return false;
      s.sessionPlan.value = null;
      return true;
    } catch {
      return false;
    }
  }

  /** POST a session-scoped mutation with a boolean result (mode toggles etc). */
  async function postSessionAction(path: string, body?: Record<string, unknown>): Promise<boolean> {
    const id = s.sessionId.value;
    if (!id) return false;
    if (s.connectionStatus.value !== 'connected') {
      showToast('连接已断开，操作未发送。', 'error');
      ctx.connect();
      return false;
    }
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        showToast(data.message ?? `操作失败（HTTP ${res.status}）`, 'error');
        return false;
      }
      return true;
    } catch (error) {
      showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      return false;
    }
  }

  async function switchPermission(mode: string): Promise<boolean> {
    const ok = await postSessionAction('permission', { mode });
    if (ok) await fetchSessionStatus();
    return ok;
  }

  async function switchPlanMode(enabled: boolean, strategy?: 'normal' | 'fusion'): Promise<boolean> {
    const ok = await postSessionAction('plan', { enabled, ...(strategy ? { strategy } : {}) });
    if (ok) await fetchSessionStatus();
    return ok;
  }

  async function switchWolfpack(enabled: boolean): Promise<boolean> {
    const ok = await postSessionAction('wolfpack', { enabled });
    if (ok) await fetchSessionStatus();
    return ok;
  }

  async function switchRlm(enabled: boolean, maxDepth?: number): Promise<boolean> {
    const ok = await postSessionAction('rlm', { enabled, ...(maxDepth !== undefined ? { maxDepth } : {}) });
    if (ok) await fetchSessionStatus();
    return ok;
  }

  async function undoHistory(count = 1): Promise<boolean> {
    return postSessionAction('undo', { count });
  }

  async function compact(instruction?: string): Promise<boolean> {
    return postSessionAction('compact', (instruction ? { instruction } : {}));
  }

  ctx.postSessionAction = postSessionAction;

  return {
    fetchSessionStatus,
    fetchSessionUsage,
    fetchSessionContext,
    fetchSessionPlan,
    clearPlan,
    switchPermission,
    switchPlanMode,
    switchWolfpack,
    switchRlm,
    undoHistory,
    compact,
  };
}
