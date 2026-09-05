<!-- Sidebar file tree (compact, lazy).
     Reads /files/list?path= through the shared dir cache, renders one level
     per expanded directory, filters loaded nodes with the shared fuzzy ladder,
     and stamps git change badges (M/A/?) from /git/status. Clicking a file
     opens it in the right panel via fileTabState. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GitFileChange, GitStatus } from '../types';
import { useFileTreeState } from '../composables/useFileTreeState';
import { filterFileEntries } from '../utils/fileFuzzy';
import { openFileInPanel } from '../utils/fileTabState';
import { invalidateDirEntry } from '../utils/fileDirCache';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{
  workDir: string | null;
  gitStatus: GitStatus | null;
  /** Optional: refresh git status (WebShell provides client.fetchGitStatus). */
  refreshGit?: () => void;
}>();

const {
  query,
  isExpanded,
  toggleExpand,
  loadedChildren,
  loadChildren,
  invalidate,
  setRoot,
} = useFileTreeState();

const rootLoading = ref(false);
const rootMissing = ref(false);

watch(
  () => props.workDir,
  (wd) => {
    setRoot(wd);
    if (wd) void loadRoot(wd);
  },
  { immediate: true },
);

async function loadRoot(wd: string): Promise<void> {
  rootLoading.value = true;
  rootMissing.value = false;
  try {
    const entries = await loadChildren(wd);
    if (entries.length === 0) rootMissing.value = true;
  } finally {
    rootLoading.value = false;
  }
}

async function toggleDir(dir: string): Promise<void> {
  const wd = props.workDir;
  if (!wd) return;
  const expanded = toggleExpand(wd, dir);
  if (expanded) await loadChildren(dir);
}

/** Absolute dir path for an entry inside a parent dir. */
function childAbs(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

/** Relative-to-workdir path used for matching git status. */
function relOf(abs: string): string {
  const wd = props.workDir;
  if (!wd) return abs;
  const base = wd.replace(/\/+$/, '');
  if (abs === base) return '';
  return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : abs;
}

function gitBadgeFor(abs: string): string | null {
  const files = props.gitStatus?.files;
  if (!files || files.length === 0) return null;
  const rel = relOf(abs);
  const hit = files.find((f: GitFileChange) => (f.displayPath ?? f.path) === rel);
  if (!hit) return null;
  if (hit.status.includes('?')) return '?';
  if (hit.status.includes('A')) return 'A';
  if (hit.status.includes('M')) return 'M';
  return null;
}

/* ── Flat tree rows (one row per loaded node, expanded dirs recursed) ────── */
interface TreeRow {
  abs: string;
  name: string;
  rel: string;
  isDir: boolean;
  depth: number;
  git: string | null;
}

const rows = computed<TreeRow[]>(() => {
  const wd = props.workDir;
  if (!wd) return [];
  const out: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of loadedChildren(dir)) {
      const abs = childAbs(dir, entry.name);
      out.push({
        abs,
        name: entry.name,
        rel: relOf(abs),
        isDir: entry.type === 'dir',
        depth,
        git: gitBadgeFor(abs),
      });
      if (entry.type === 'dir' && isExpanded(wd, abs)) walk(abs, depth + 1);
    }
  };
  walk(wd, 0);
  return out;
});

/* ── Search: flat-filter all loaded nodes with the shared fuzzy ladder ───── */
const flatNodes = computed<TreeRow[]>(() => rows.value);

const searchResults = computed<TreeRow[]>(() => {
  const q = query.value.trim();
  if (!q) return [];
  const byRel = new Map(flatNodes.value.map((n) => [n.rel, n]));
  return filterFileEntries(
    flatNodes.value.map((n) => ({ path: n.rel, isDir: n.isDir })),
    q,
    50,
  )
    .map((hit) => byRel.get(hit.path))
    .filter((n): n is TreeRow => n !== undefined);
});

const searching = computed(() => query.value.trim().length > 0);

function onRowClick(row: TreeRow): void {
  if (row.isDir) {
    void toggleDir(row.abs);
  } else {
    openFileInPanel(row.abs);
  }
}

function refresh(): void {
  const wd = props.workDir;
  if (!wd) return;
  invalidate(wd);
  // Drop the shared dir cache too, or the re-fetch just reads the stale TTL.
  invalidateDirEntry(wd);
  void loadRoot(wd);
  props.refreshGit?.();
}
</script>

<template>
  <div class="file-tree">
    <div v-if="workDir" class="tree-toolbar">
      <label class="tree-search">
        <SvgIcon name="search" :size="13" />
        <input
          v-model="query"
          type="text"
          placeholder="过滤文件…"
          aria-label="过滤文件"
          spellcheck="false"
        />
      </label>
      <button
        class="tree-refresh"
        title="刷新文件树与 Git 状态"
        aria-label="刷新文件树与 Git 状态"
        @click="refresh"
      >
        <SvgIcon name="refresh" :size="13" />
      </button>
    </div>

    <div v-if="!workDir" class="tree-empty">当前会话没有工作目录</div>
    <div v-else-if="rootLoading && rows.length === 0" class="tree-empty">加载中…</div>
    <div v-else-if="rootMissing && rows.length === 0" class="tree-empty">工作目录为空</div>
    <div v-else-if="searching && searchResults.length === 0" class="tree-empty">没有匹配的文件</div>

    <div v-else class="tree-scroll" role="tree" :aria-label="'文件树 ' + workDir">
      <template v-if="searching">
        <button
          v-for="r in searchResults"
          :key="r.abs"
          class="tree-row"
          :class="{ 'is-dir': r.isDir }"
          role="treeitem"
          :aria-expanded="r.isDir ? isExpanded(workDir, r.abs) : undefined"
          @click="onRowClick(r)"
        >
          <SvgIcon :name="r.isDir ? 'folder' : 'file'" :size="14" class="row-icon" />
          <span class="row-label mono" :title="r.rel">{{ r.rel }}</span>
          <span v-if="r.git" class="row-git" :class="`g-${r.git}`">{{ r.git }}</span>
        </button>
      </template>
      <template v-else>
        <button
          v-for="r in rows"
          :key="r.abs"
          class="tree-row"
          :class="{ 'is-dir': r.isDir }"
          :style="{ paddingLeft: `${8 + r.depth * 14}px` }"
          role="treeitem"
          :aria-expanded="r.isDir ? isExpanded(workDir, r.abs) : undefined"
          @click="onRowClick(r)"
        >
          <SvgIcon
            :name="r.isDir ? (isExpanded(workDir, r.abs) ? 'chevron-down' : 'chevron-right') : 'file'"
            :size="13"
            class="row-caret"
          />
          <SvgIcon :name="r.isDir ? 'folder' : 'file'" :size="14" class="row-icon" />
          <span class="row-label" :class="{ mono: !r.isDir }" :title="r.rel">{{ r.name }}</span>
          <span v-if="r.git" class="row-git" :class="`g-${r.git}`">{{ r.git }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.tree-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-1) var(--space-2);
}
.tree-search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-faint);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.tree-search:focus-within {
  border-color: var(--color-accent-bd);
  box-shadow: var(--glow-focus);
}
.tree-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-xs);
  font-family: inherit;
  outline: none;
}
.tree-search input::placeholder {
  color: var(--color-text-faint);
}
.tree-refresh {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.tree-refresh:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-right: 2px;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 26px;
  padding: 2px var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-xs);
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.tree-row:hover {
  background: var(--color-hover);
}
.tree-row.is-dir {
  font-weight: 600;
  color: var(--color-text);
}
.row-caret {
  flex-shrink: 0;
  color: var(--color-text-faint);
}
.row-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
}
.is-dir > .row-icon {
  color: var(--color-accent);
}
.row-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono {
  font-family: var(--font-mono);
  font-size: 11px;
}
.row-git {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: var(--radius-full);
  line-height: 1.6;
}
.row-git.g-M {
  background: var(--color-warning-soft, rgba(255, 170, 0, 0.16));
  color: var(--color-warning);
}
.row-git.g-A {
  background: var(--color-success-soft, rgba(60, 200, 120, 0.16));
  color: var(--color-success);
}
.row-git.g-? {
  background: var(--color-selected);
  color: var(--color-text-muted);
}
.tree-empty {
  padding: var(--space-3) var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
  text-align: center;
}
</style>
