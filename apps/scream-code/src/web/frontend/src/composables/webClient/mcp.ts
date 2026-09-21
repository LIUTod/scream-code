import type { BackgroundTaskInfo, McpServerInfo, McpStartupMetrics } from '../../types';
import {
  API_BASE,
  captureSessionRequest,
  isCurrentSessionRequest,
  type ClientContext,
  type SessionRequestToken,
} from './state';

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

  let serversRequest = 0;
  let metricsRequest = 0;
  let tasksRequest = 0;
  let taskOutputRequest = 0;

  function current(token: SessionRequestToken | null): token is SessionRequestToken {
    return token !== null && isCurrentSessionRequest(s, token);
  }

  async function fetchMcpServers(): Promise<void> {
    const token = captureSessionRequest(s);
    if (!token) return;
    const request = ++serversRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/mcp`);
      if (!current(token) || request !== serversRequest || !res.ok) return;
      s.mcpServers.value = (await res.json()) as McpServerInfo[];
    } catch { /* best-effort */ }
  }

  async function fetchMcpStartupMetrics(): Promise<void> {
    const token = captureSessionRequest(s);
    if (!token) return;
    const request = ++metricsRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/mcp/startup-metrics`);
      if (!current(token) || request !== metricsRequest || !res.ok) return;
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
    const token = captureSessionRequest(s);
    if (!token) return false;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!current(token) || !res.ok) return false;
      s.mcpServers.value = s.mcpServers.value.filter((m) => m.name !== name);
      return true;
    } catch {
      return false;
    }
  }

  async function fetchBackgroundTasks(activeOnly?: boolean, limit?: number): Promise<void> {
    const token = captureSessionRequest(s);
    if (!token) return;
    const request = ++tasksRequest;
    try {
      const q = new URLSearchParams();
      if (activeOnly !== undefined) q.set('activeOnly', String(activeOnly));
      if (limit !== undefined) q.set('limit', String(limit));
      const qs = q.toString();
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/tasks${qs ? `?${qs}` : ''}`);
      if (!current(token) || request !== tasksRequest || !res.ok) return;
      s.backgroundTasks.value = (await res.json()) as BackgroundTaskInfo[];
    } catch { /* best-effort */ }
  }

  async function fetchBackgroundTaskOutput(taskId: string, tail?: number): Promise<void> {
    const token = captureSessionRequest(s);
    if (!token) return;
    const request = ++taskOutputRequest;
    try {
      const qs = tail !== undefined ? `?tail=${tail}` : '';
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/tasks/${encodeURIComponent(taskId)}/output${qs}`);
      if (!current(token) || request !== taskOutputRequest || !res.ok) return;
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
