import type { PluginInfo, PluginSummary, ReloadSummary, SkillSummary } from '../../types';
import {
  API_BASE,
  captureSessionRequest,
  isCurrentSessionRequest,
  type ClientContext,
  type SessionRequestToken,
} from './state';

export interface ExtensionsModule {
  fetchSkills(): Promise<void>;
  activateSkill(name: string, args?: string): Promise<boolean>;
  removeSkill(name: string): Promise<boolean>;
  fetchPlugins(): Promise<void>;
  fetchPluginInfo(pid: string): Promise<void>;
  installPlugin(source: string): Promise<PluginSummary | null>;
  setPluginEnabled(pid: string, enabled: boolean): Promise<boolean>;
  setPluginMcpServerEnabled(pid: string, server: string, enabled: boolean): Promise<boolean>;
  removePlugin(pid: string): Promise<boolean>;
  reloadPlugins(): Promise<ReloadSummary | null>;
  activatePlugin(pid: string): Promise<boolean>;
  deactivatePlugin(pid: string): Promise<boolean>;
  injectPlugin(pid: string): Promise<boolean>;
}

export function createExtensionsModule(ctx: ClientContext): ExtensionsModule {
  const { s } = ctx;

  // Separate request counters prevent an older response from a repeated
  // refresh (or an install/reload follow-up) from replacing newer data in the
  // same session.  Session/connection generations below protect cross-session
  // responses; these counters protect ordering within one session.
  let skillsRequest = 0;
  let pluginsRequest = 0;
  let pluginInfoRequest = 0;

  function current(token: SessionRequestToken | null): token is SessionRequestToken {
    return token !== null && isCurrentSessionRequest(s, token);
  }

  async function fetchSkills(): Promise<void> {
    const token = captureSessionRequest(s);
    if (!token) return;
    const request = ++skillsRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/skills`);
      if (!current(token) || request !== skillsRequest) return;
      if (!res.ok) {
        // Silent-failure sweep: the skills center must distinguish "genuinely no skills"
        // from "failed to load".
        s.skillsError.value = `技能列表加载失败（HTTP ${res.status}）`;
        return;
      }
      s.skills.value = (await res.json()) as SkillSummary[];
      s.skillsError.value = null;
    } catch (error) {
      if (!current(token) || request !== skillsRequest) return;
      s.skillsError.value = `技能列表加载失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function activateSkill(name: string, args?: string): Promise<boolean> {
    return ctx.postSessionAction(`skills/${encodeURIComponent(name)}/activate`, (args ? { args } : {}));
  }

  async function removeSkill(name: string): Promise<boolean> {
    const token = captureSessionRequest(s);
    if (!token) return false;
    ++skillsRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!current(token) || !res.ok) return false;
      s.skills.value = s.skills.value.filter((s) => s.name !== name);
      return true;
    } catch {
      return false;
    }
  }

  async function fetchPlugins(): Promise<void> {
    const token = captureSessionRequest(s);
    if (!token) return;
    const request = ++pluginsRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/plugins`);
      if (!current(token) || request !== pluginsRequest || !res.ok) return;
      s.plugins.value = (await res.json()) as PluginSummary[];
    } catch { /* best-effort */ }
  }

  async function fetchPluginInfo(pid: string): Promise<void> {
    const token = captureSessionRequest(s);
    if (!token) return;
    const request = ++pluginInfoRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/plugins/${encodeURIComponent(pid)}`);
      if (!current(token) || request !== pluginInfoRequest || !res.ok) return;
      s.pluginInfo.value = (await res.json()) as PluginInfo;
    } catch { /* best-effort */ }
  }

  async function installPlugin(source: string): Promise<PluginSummary | null> {
    const token = captureSessionRequest(s);
    if (!token) return null;
    ++pluginsRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/plugins/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      if (!current(token) || !res.ok) return null;
      const plugin = (await res.json()) as PluginSummary;
      await fetchPlugins();
      return current(token) ? plugin : null;
    } catch {
      return null;
    }
  }

  async function setPluginEnabled(pid: string, enabled: boolean): Promise<boolean> {
    return ctx.postSessionAction(`plugins/${encodeURIComponent(pid)}/enable`, { enabled });
  }

  async function setPluginMcpServerEnabled(pid: string, server: string, enabled: boolean): Promise<boolean> {
    return ctx.postSessionAction(`plugins/${encodeURIComponent(pid)}/mcp/${encodeURIComponent(server)}/enable`, { enabled });
  }

  async function removePlugin(pid: string): Promise<boolean> {
    const token = captureSessionRequest(s);
    if (!token) return false;
    ++pluginsRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/plugins/${encodeURIComponent(pid)}`, { method: 'DELETE' });
      if (!current(token) || !res.ok) return false;
      s.plugins.value = s.plugins.value.filter((p) => p.id !== pid);
      return true;
    } catch {
      return false;
    }
  }

  async function reloadPlugins(): Promise<ReloadSummary | null> {
    const token = captureSessionRequest(s);
    if (!token) return null;
    ++pluginsRequest;
    try {
      const res = await fetch(`${API_BASE}/sessions/${token.sessionId}/plugins/reload`, { method: 'POST' });
      if (!current(token) || !res.ok) return null;
      const summary = (await res.json()) as ReloadSummary;
      await fetchPlugins();
      return current(token) ? summary : null;
    } catch {
      return null;
    }
  }

  async function activatePlugin(pid: string): Promise<boolean> {
    return ctx.postSessionAction(`plugins/${encodeURIComponent(pid)}/activate`);
  }

  async function deactivatePlugin(pid: string): Promise<boolean> {
    return ctx.postSessionAction(`plugins/${encodeURIComponent(pid)}/deactivate`);
  }

  async function injectPlugin(pid: string): Promise<boolean> {
    return ctx.postSessionAction(`plugins/${encodeURIComponent(pid)}/inject`);
  }

  return {
    fetchSkills,
    activateSkill,
    removeSkill,
    fetchPlugins,
    fetchPluginInfo,
    installPlugin,
    setPluginEnabled,
    setPluginMcpServerEnabled,
    removePlugin,
    reloadPlugins,
    activatePlugin,
    deactivatePlugin,
    injectPlugin,
  };
}
