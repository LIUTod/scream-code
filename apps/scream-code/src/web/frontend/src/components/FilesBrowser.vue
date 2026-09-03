<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { openFileInPanel } from '../utils/fileTabState';
import SvgIcon from './ui/SvgIcon.vue';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

const props = withDefaults(defineProps<{ initialPath?: string }>(), { initialPath: '' });

const cwd = ref('');
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref('');

const API = '/api/v1/files';

const crumbComponents = computed(() => {
  if (!cwd.value) return [] as { label: string; path: string }[];
  const parts = cwd.value.split('/');
  const out: { label: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    let label = parts[i]!;
    if (i > 1 && label === 'Users' && parts[i - 1] === '') label = label;
    out.push({ label: label.slice(0, 12), path: parts.slice(0, i + 1).join('/') || '/' });
  }
  if (out.length > 4) {
    return [{ label: '…', path: '/' }, ...out.slice(out.length - 3)];
  }
  return out;
});

async function loadList(path: string): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch(`${API}/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { path: string; entries: FileEntry[] };
    cwd.value = data.path || (await firstRoot());
    entries.value = data.entries;
    if (!cwd.value) error.value = '没有可访问的目录（尚无会话）';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function firstRoot(): Promise<string> {
  try {
    const res = await fetch(`${API}/root`);
    const data = (await res.json()) as { roots: string[] };
    return data.roots[0] ?? '';
  } catch {
    return '';
  }
}

/** Directories navigate the list; files open in the right-hand file panel. */
async function openEntry(entry: FileEntry): Promise<void> {
  if (entry.type === 'dir') {
    await loadList(entry.path);
    return;
  }
  openFileInPanel(entry.path);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

onMounted(() => {
  void loadList(props.initialPath);
});

watch(
  () => props.initialPath,
  (p) => {
    if (p) void loadList(p);
  },
);
</script>

<template>
  <div class="files-pane">
    <div class="files-path">
      <button class="files-up" title="上一级" aria-label="上一级" @click="loadList(cwd.split('/').slice(0, -1).join('/') || '/')">
        <SvgIcon name="chevron-left" :size="16" />
      </button>
      <div class="crumbs">
        <span v-for="(c, i) in crumbComponents" :key="i" class="crumb" @click="loadList(c.path)">
          <b v-if="i > 0" class="crumb-sep">/</b><span class="crumb-name">{{ c.label }}</span>
        </span>
      </div>
    </div>

    <p v-if="error" class="files-error">{{ error }}</p>
    <p v-else-if="loading" class="files-loading">加载中…</p>

    <ul class="files-list">
      <li v-for="entry in entries" :key="entry.path">
        <button class="files-item" :class="{ dir: entry.type === 'dir' }" @click="openEntry(entry)">
          <SvgIcon :name="entry.type === 'dir' ? 'folder' : 'file'" :size="16" />
          <span class="files-name">{{ entry.name }}</span>
          <span class="files-meta">{{ entry.type === 'dir' ? '目录' : fmtSize(entry.size) }}</span>
        </button>
      </li>
      <li v-if="!loading && entries.length === 0" class="files-empty">空目录</li>
    </ul>
  </div>
</template>

<style scoped>
.files-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  height: 100%;
  min-height: 0;
}
.files-path {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
}
.files-up {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
}
.files-up:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.crumbs {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.crumb {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  padding: 2px 3px;
  border-radius: var(--radius-xs);
}
.crumb:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.crumb-sep {
  margin-right: 3px;
  color: var(--color-text-faint);
}
.files-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}
.files-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
  min-height: 32px;
}
.files-item:hover {
  background: var(--color-hover);
}
.files-item.dir {
  color: var(--color-text);
  font-weight: 500;
}
.files-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.files-meta {
  font-size: 11px;
  color: var(--color-text-faint);
  flex-shrink: 0;
}
.files-empty,
.files-loading,
.files-error {
  padding: var(--space-3) var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-faint);
}
.files-error {
  color: var(--color-danger);
}
</style>
