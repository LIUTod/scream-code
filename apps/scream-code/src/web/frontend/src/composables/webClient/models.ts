import type { LikePreferences, ModelsResponse, SessionStatus } from '../../types';
import { API_BASE, onWsMessage, type ClientContext } from './state';

export interface ModelsModule {
  fetchModels(): Promise<void>;
  fetchLike(): Promise<void>;
  updateLike(prefs: LikePreferences): Promise<boolean>;
  switchModel(alias: string): Promise<void>;
  switchThinking(level: string): Promise<void>;
}

export function createModelsModule(ctx: ClientContext): ModelsModule {
  const { s, showToast } = ctx;

  // ── Model / thinking switching (TUI /model parity) ────────────────────────

  async function fetchModels(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/models`);
      if (!res.ok) return;
      const data: ModelsResponse = await res.json();
      s.models.value = data.models;
    } catch {
      // Best-effort — model picker stays hidden when unavailable.
    }
  }

  // ── Like preferences (TUI /like parity) ──────────────────────────────────

  async function fetchLike(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/like`);
      if (!res.ok) return;
      s.like.value = (await res.json()) as LikePreferences;
    } catch {
      // Best-effort — like panel stays empty when unavailable.
    }
  }

  async function updateLike(prefs: LikePreferences): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/like`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) return false;
      s.like.value = prefs;
      return true;
    } catch {
      return false;
    }
  }

  /** POST a session mutation and apply the returned status / surface errors. */
  async function postSessionSwitch(path: string, body: Record<string, unknown>, okMessage: string): Promise<void> {
    const targetSessionId = s.sessionId.value;
    if (!targetSessionId) return;
    const targetSessionGeneration = s.sessionGeneration;
    const targetConnectionGeneration = s.connectionGeneration;
    const requestGeneration = ++s.sessionMutationGeneration;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { status?: SessionStatus; message?: string };
      if (
        s.sessionId.value !== targetSessionId ||
        s.sessionGeneration !== targetSessionGeneration ||
        s.connectionGeneration !== targetConnectionGeneration ||
        s.sessionMutationGeneration !== requestGeneration
      ) return;
      if (!res.ok) {
        showToast(data.message ?? `请求失败（HTTP ${res.status}）`, 'error');
        return;
      }
      if (data.status) {
        s.status.value = { ...s.status.value, ...data.status };
      }
      ctx.appendSystemMessage(okMessage);
    } catch (error) {
      if (
        s.sessionId.value !== targetSessionId ||
        s.sessionGeneration !== targetSessionGeneration ||
        s.connectionGeneration !== targetConnectionGeneration ||
        s.sessionMutationGeneration !== requestGeneration
      ) return;
      showToast(`请求失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function switchModel(alias: string): Promise<void> {
    if (alias === s.status.value.model) return;
    await postSessionSwitch('model', { model: alias }, `已切换模型：${alias}`);
  }

  async function switchThinking(level: string): Promise<void> {
    if (level === s.status.value.thinkingLevel) return;
    await postSessionSwitch('thinking', { level }, `思考强度已切换为 ${level}`);
  }

  // Server-pushed status sync (e.g. model/thinking switched from another tab).
  onWsMessage(s, 'status', (msg) => {
    s.liveGeneration++;
    s.status.value = { ...s.status.value, ...msg.status };
  });

  ctx.fetchModels = fetchModels;

  return { fetchModels, fetchLike, updateLike, switchModel, switchThinking };
}
