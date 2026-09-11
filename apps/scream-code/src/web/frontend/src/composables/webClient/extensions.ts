import type { PluginInfo, PluginSummary, ReloadSummary, SkillSummary } from '../../types';
import { API_BASE, type ClientContext } from './state';

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

  async function fetchSkills(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/skills`);
      if (!res.ok) return;
      s.skills.value = (await res.json()) as SkillSummary[];
    } catch { /* best-effort */ }
  }

  async function activateSkill(name: string, args?: string): Promise<boolean> {
    return ctx.postSessionAction(`skills/${encodeURIComponent(name)}/activate`, (args ? { args } : {}));
  }

  async function removeSkill(name: string): Promise<boolean> {
    const id = s.sessionId.value;
    if (!id) return false;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) return false;
      s.skills.value = s.skills.value.filter((s) => s.name !== name);
      return true;
    } catch {
      return false;
    }
  }

  async function fetchPlugins(): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/plugins`);
      if (!res.ok) return;
      s.plugins.value = (await res.json()) as PluginSummary[];
    } catch { /* best-effort */ }
  }

  async function fetchPluginInfo(pid: string): Promise<void> {
    const id = s.sessionId.value;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/plugins/${encodeURIComponent(pid)}`);
      if (!res.ok) return;
      s.pluginInfo.value = (await res.json()) as PluginInfo;
    } catch { /* best-effort */ }
  }

  async function installPlugin(source: string): Promise<PluginSummary | null> {
    const id = s.sessionId.value;
    if (!id) return null;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/plugins/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      if (!res.ok) return null;
      const plugin = (await res.json()) as PluginSummary;
      await fetchPlugins();
      return plugin;
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
    const id = s.sessionId.value;
    if (!id) return false;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/plugins/${encodeURIComponent(pid)}`, { method: 'DELETE' });
      if (!res.ok) return false;
      s.plugins.value = s.plugins.value.filter((p) => p.id !== pid);
      return true;
    } catch {
      return false;
    }
  }

  async function reloadPlugins(): Promise<ReloadSummary | null> {
    const id = s.sessionId.value;
    if (!id) return null;
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}/plugins/reload`, { method: 'POST' });
      if (!res.ok) return null;
      const summary = (await res.json()) as ReloadSummary;
      await fetchPlugins();
      return summary;
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
