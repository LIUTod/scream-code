import type { BackgroundTaskInfo, McpServerInfo, McpStartupMetrics } from '../../types';
import { API_BASE, type ClientContext } from './state';

export interface McpModule {
  fetchMcpServers(): Promise<void>;
  fetchMcpStartupMetrics(): Promise<void>;
  addMcpServer(name: string, config: Record<string, unknown>): Promise<boolean>;
  reconnectMcpServer(name: string): Promise<boolean>;
  stopMcpServer(name: string): Promise<boolean>;
  removeMcpServer(name: string): Promise<boolean>;
  fetchBackgroundTasks(activeOnly?: boolean, limit?: number): Promise<void>;
  fetchBackgroundTaskOutput(taskId: string, tail?: number): Promise<void>;
  stopBackgroundTask(taskId: string, reason?: string): Promise<boolean>;
}

export function createMcpModule(ctx: ClientContext): McpModule {
  const { s } = ctx;

  async function fetchMcpServers(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/mcp`);
      if (!res.ok) return;
      s.mcpServers.value = (await res.json()) as McpServerInfo[];
    } catch { /* best-effort */ }
  }

  async function fetchMcpStartupMetrics(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/mcp/startup-metrics`);
      if (!res.ok) return;
      s.mcpStartupMetrics.value = (await res.json()) as McpStartupMetrics;
    } catch { /* best-effort */ }
  }

  async function addMcpServer(name: string, config: Record<string, unknown>): Promise<boolean> {
    return ctx.postSessionAction('mcp/add', { name, config });
  }

  async function reconnectMcpServer(name: string): Promise<boolean> {
    return ctx.postSessionAction(`mcp/${encodeURIComponent(name)}/reconnect`);
  }

  async function stopMcpServer(name: string): Promise<boolean> {
    return ctx.postSessionAction(`mcp/${encodeURIComponent(name)}/stop`);
  }

  async function removeMcpServer(name: string): Promise<boolean> {
    const id = s.sessionId.value;
    if (!id) return false;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) return false;
      s.mcpServers.value = s.mcpServers.value.filter((m) => m.name !== name);
      return true;
    } catch {
      return false;
    }
  }

  async function fetchBackgroundTasks(activeOnly?: boolean, limit?: number): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const q = new URLSearchParams();
      if (activeOnly !== undefined) q.set('activeOnly', String(activeOnly));
      if (limit !== undefined) q.set('limit', String(limit));
      const qs = q.toString();
      const res = await fetch(`${API_BASE}/sessions/${id}/tasks${qs ? `?${qs}` : ''}`);
      if (!res.ok) return;
      s.backgroundTasks.value = (await res.json()) as BackgroundTaskInfo[];
    } catch { /* best-effort */ }
  }

  async function fetchBackgroundTaskOutput(taskId: string, tail?: number): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const qs = tail !== undefined ? `?tail=${tail}` : '';
      const res = await fetch(`${API_BASE}/sessions/${id}/tasks/${encodeURIComponent(taskId)}/output${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as { output: string };
      s.backgroundTaskOutput.value = data.output;
    } catch { /* best-effort */ }
  }

  async function stopBackgroundTask(taskId: string, reason?: string): Promise<boolean> {
    return ctx.postSessionAction(`tasks/${encodeURIComponent(taskId)}/stop`, (reason ? { reason } : {}));
  }

  return {
    fetchMcpServers,
    fetchMcpStartupMetrics,
    addMcpServer,
    reconnectMcpServer,
    stopMcpServer,
    removeMcpServer,
    fetchBackgroundTasks,
    fetchBackgroundTaskOutput,
    stopBackgroundTask,
  };
}
