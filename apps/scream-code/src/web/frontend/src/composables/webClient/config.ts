import type { ExperimentalFlagMap, ScreamConfig, ScreamConfigPatch } from '../../types';
import { API_BASE, type ClientContext } from './state';

export interface ConfigModule {
  fetchConfig(): Promise<void>;
  setConfig(patch: ScreamConfigPatch): Promise<boolean>;
  removeProvider(providerId: string): Promise<boolean>;
  fetchExperimentalFlags(): Promise<void>;
  preflight(): Promise<void>;
}

export function createConfigModule(ctx: ClientContext): ConfigModule {
  const { s } = ctx;

  // Global (harness-scoped) methods, no session needed.
  async function fetchConfig(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/config`);
      if (!res.ok) return;
      s.config.value = (await res.json()) as ScreamConfig;
    } catch { /* best-effort */ }
  }

  async function setConfig(patch: ScreamConfigPatch): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      });
      if (!res.ok) return false;
      s.config.value = (await res.json()) as ScreamConfig;
      return true;
    } catch {
      return false;
    }
  }

  async function removeProvider(providerId: string): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/config/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
      if (!res.ok) return false;
      await fetchConfig();
      return true;
    } catch {
      return false;
    }
  }

  async function fetchExperimentalFlags(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/experimental-flags`);
      if (!res.ok) return;
      s.experimentalFlags.value = (await res.json()) as ExperimentalFlagMap;
    } catch { /* best-effort */ }
  }

  async function preflight(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/preflight`);
      if (!res.ok) return;
      s.preflightOk.value = true;
    } catch { /* best-effort */ }
  }

  return { fetchConfig, setConfig, removeProvider, fetchExperimentalFlags, preflight };
}
