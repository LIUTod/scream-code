import { computed, ref } from 'vue';

import { readStoredString, writeStoredString } from '../utils/storage';
import { API_BASE } from './webClient/state';

/**
 * Module-level singleton for "which workspace the next new session uses".
 *
 * Why module-level and not component state: the home Composer is unmounted by the view
 * switch right after a successful send, so the selection must outlive it; it is also a pure
 * preference (not a session fact) unrelated to the session list or WS state, so it does not
 * belong in useScreamWebClient's core.
 * The localStorage key is a stable contract: reopening the page still restores the last
 * workspace chosen.
 */
export const WORKSPACE_PREF_KEY = 'scream-workspace-preference';

/** Directory explicitly chosen by the user; null = not chosen, falls back to the server process directory. */
const preferredWorkDir = ref<string | null>(readStoredString(WORKSPACE_PREF_KEY) || null);

/** Server default workspace (reported by GET /api/v1/workdir); used only as the display fallback. */
const serverWorkDir = ref<string | null>(null);
let serverWorkDirInFlight: Promise<void> | null = null;

export function setPreferredWorkDir(dir: string | null): void {
  preferredWorkDir.value = dir;
  // Writing an empty string back to storage is equivalent to clearing it (the read side normalizes via `|| null`).
  writeStoredString(WORKSPACE_PREF_KEY, dir ?? '');
}

/** Fetches the server default workspace; best-effort, a failure can be retried on the next mount. */
export async function fetchServerWorkDir(): Promise<void> {
  if (serverWorkDirInFlight) return serverWorkDirInFlight;
  serverWorkDirInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/workdir`);
      if (!res.ok) return;
      const data = (await res.json()) as { workDir?: unknown };
      if (typeof data.workDir === 'string' && data.workDir) {
        serverWorkDir.value = data.workDir;
      }
    } catch {
      // Endpoint missing (e.g. an older single-session server) or a network hiccup: staying null is fine.
    } finally {
      serverWorkDirInFlight = null;
    }
  })();
  return serverWorkDirInFlight;
}

/** For chip display: explicit selection first, then the server default. */
const displayWorkDir = computed(() => preferredWorkDir.value ?? serverWorkDir.value ?? '');

/** Whether the user has made an explicit choice (decides whether createSession carries the workDir argument). */
const hasPreference = computed(() => !!preferredWorkDir.value);

export function useWorkspacePreference() {
  return {
    preferredWorkDir,
    serverWorkDir,
    displayWorkDir,
    hasPreference,
    setPreferredWorkDir,
    fetchServerWorkDir,
  };
}

/** Takes the last non-root segment as the short chip label (absolute paths start with /, trailing slashes are stripped before splitting). */
export function workDirBasename(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? trimmed ?? dir;
}
