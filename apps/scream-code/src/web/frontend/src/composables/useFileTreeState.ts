import { reactive, ref, type Ref } from 'vue';
import { fetchDirEntries, type ServerFileEntry } from '../utils/fileDirCache';

/**
 * Module-level singleton state for the sidebar file tree.
 *
 * WebShell mounts the sidebar twice (desktop rail + mobile drawer); both
 * copies must share the query, the expanded set and the loaded entries so the
 * two never diverge. The directory *listing* cache itself lives in
 * fileDirCache.ts — this composable only holds tree shape and expansion.
 */
const EXPANDED_KEY = 'scream-file-tree-expanded';

/** File-tree search query, shared across both sidebar instances. */
const query = ref('');

interface ExpandedMap {
  [workDir: string]: string[];
}

function loadExpanded(): ExpandedMap {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: ExpandedMap = {};
      for (const [dir, paths] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(paths)) out[dir] = paths.filter((p): p is string => typeof p === 'string');
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

/** Per-workdir expanded absolute-dir set (persisted). */
const expandedByDir = ref<ExpandedMap>(loadExpanded());
/** Per-workdir loaded children keyed by absolute dir path.
 *  Reactive so computed tree rows re-render when a directory loads. */
const childrenByDir = reactive(new Map<string, ServerFileEntry[]>());
/** The currently active tree root (workDir of the current session). */
const activeWorkDir = ref<string | null>(null);
/** In-flight loader guard: absolute dir path → generation token. */
const loadGen = new Map<string, number>();

export function useFileTreeState() {
  function expandedSet(workDir: string | null): Set<string> {
    if (!workDir) return new Set();
    return new Set(expandedByDir.value[workDir] ?? []);
  }

  function persist(workDir: string | null): void {
    if (!workDir) return;
    const next = { ...expandedByDir.value };
    next[workDir] = [...expandedSet(workDir)];
    expandedByDir.value = next;
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable — expansion is best-effort.
    }
  }

  /** Set the tree root; resets expansion to what was persisted for it. */
  function setRoot(workDir: string | null): void {
    if (activeWorkDir.value === workDir) return;
    activeWorkDir.value = workDir;
  }

  function isExpanded(workDir: string | null, dir: string): boolean {
    if (!workDir) return false;
    return expandedByDir.value[workDir]?.includes(dir) ?? false;
  }

  /** Toggle a directory open/closed. Returns the new state. */
  function toggleExpand(workDir: string | null, dir: string): boolean {
    if (!workDir) return false;
    const cur = expandedByDir.value[workDir] ?? [];
    const next = cur.includes(dir) ? cur.filter((d) => d !== dir) : [...cur, dir];
    expandedByDir.value = { ...expandedByDir.value, [workDir]: next };
    persist(workDir);
    return !cur.includes(dir);
  }

  function loadedChildren(dir: string): ServerFileEntry[] {
    return childrenByDir.get(dir) ?? [];
  }

  /** Load (or return cached) children for an absolute dir path. */
  async function loadChildren(dir: string): Promise<ServerFileEntry[]> {
    const gen = (loadGen.get(dir) ?? 0) + 1;
    loadGen.set(dir, gen);
    const entries = await fetchDirEntries(dir);
    if (gen !== (loadGen.get(dir) ?? 0)) return childrenByDir.get(dir) ?? [];
    if (entries !== null) childrenByDir.set(dir, entries);
    return childrenByDir.get(dir) ?? [];
  }

  /** Clear loaded entries for a dir (manual refresh re-fetches). */
  function invalidate(dir: string): void {
    childrenByDir.delete(dir);
  }

  return {
    activeWorkDir,
    query,
    isExpanded,
    toggleExpand,
    loadedChildren,
    loadChildren,
    invalidate,
    setRoot,
  };
}

/** Test helper: clear all module-level state (query, children, load gen). */
export function _resetFileTreeForTests(): void {
  query.value = '';
  childrenByDir.clear();
  loadGen.clear();
  activeWorkDir.value = null;
}
