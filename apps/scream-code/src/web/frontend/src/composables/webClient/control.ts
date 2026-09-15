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
    // Optimistic update: the chip flips to the new value immediately and then waits for the
    // network — the permission entry must "give feedback the moment it is clicked". The
    // authoritative value is reconciled afterwards by the status frame / fetchSessionStatus;
    // on server failure postSessionAction has already toasted and the local value is rolled
    // back below, so we never stay on an illusion.
    //
    // Generation guard (mirrors postSessionSwitch in models.ts): rolling back is a dangerous
    // action that writes status.permission unconditionally — when two modes are clicked in
    // quick succession, the earlier request may come back late and its rollback would
    // overwrite the value the later request already confirmed; after a session switch /
    // reconnect it would even write the previous session's permission into the new one. The
    // rollback must first confirm "the world has not changed", otherwise it is better to skip
    // the write (the authoritative value is reconciled by the following status frame /
    // snapshot). A permission-specific generation is used here rather than the shared
    // sessionMutationGeneration: the latter is advanced by unrelated requests such as model /
    // thinking switches, which would silently downgrade a failure that should be rolled back
    // into "staying on the optimistic value".
    const targetSessionId = s.sessionId.value;
    const targetSessionGeneration = s.sessionGeneration;
    const targetConnectionGeneration = s.connectionGeneration;
    const requestGeneration = ++s.permissionMutationGeneration;
    const prev = s.status.value.permission;
    s.status.value = { ...s.status.value, permission: mode };
    const ok = await postSessionAction('permission', { mode });
    if (!ok) {
      const stale =
        s.sessionId.value !== targetSessionId ||
        s.sessionGeneration !== targetSessionGeneration ||
        s.connectionGeneration !== targetConnectionGeneration ||
        s.permissionMutationGeneration !== requestGeneration;
      if (!stale) s.status.value = { ...s.status.value, permission: prev };
      return false;
    }
    await fetchSessionStatus();
    return true;
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
