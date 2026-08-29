<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import SvgIcon from './ui/SvgIcon.vue';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

interface FileInfo {
  path: string;
  content: string;
  truncated: boolean;
}

const props = withDefaults(defineProps<{ initialPath?: string }>(), { initialPath: '' });

const cwd = ref('');
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref('');
const preview = ref<FileInfo | null>(null);
const previewError = ref('');

const API = '/api/v1/files';

function rawUrl(path: string): string {
  return `${API}/raw?path=${encodeURIComponent(path)}`;
}

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
  preview.value = null;
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

async function openEntry(entry: FileEntry): Promise<void> {
  if (entry.type === 'dir') {
    await loadList(entry.path);
    return;
  }
  const kind = previewKind(entry.name);
  if (kind === 'binary') {
    preview.value = { path: entry.path, content: '', truncated: false };
    previewError.value = '该文件类型暂不支持预览';
    return;
  }
  previewError.value = '';
  try {
    const res = await fetch(`${API}/read?path=${encodeURIComponent(entry.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as FileInfo;
    if (data.truncated) previewError.value = '文件较大，仅显示前 256KB';
    preview.value = data;
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e);
    preview.value = null;
  }
}

function previewKind(name: string): 'image' | 'audio' | 'pdf' | 'text' | 'binary' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['md', 'txt', 'json', 'yml', 'yaml', 'csv', 'log', 'toml', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'sh', 'css', 'html', 'vue', 'lock', 'env', 'patch', 'diff'].includes(ext)) return 'text';
  return 'binary';
}

const previewFile = computed(() => {
  if (!preview.value) return null;
  const name = preview.value.path.split(/[\\/]/).pop() ?? '';
  return { name, path: preview.value.path };
});

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

    <template v-if="preview">
      <div class="files-preview-head">
        <span class="files-preview-name" :title="preview?.path">{{ previewFile?.name }}</span>
        <button class="files-preview-close" title="关闭预览" aria-label="关闭预览" @click="preview = null">
          <SvgIcon name="x" :size="16" />
        </button>
      </div>
      <p v-if="previewError" class="files-preview-note">{{ previewError }}</p>
      <div class="files-preview-body">
        <pre v-if="previewKind(previewFile?.name ?? '') === 'text'" class="files-pre">{{ preview.content }}</pre>
        <img v-else-if="previewKind(previewFile?.name ?? '') === 'image'" :src="rawUrl(preview.path)" alt="" class="files-img" />
        <audio v-else-if="previewKind(previewFile?.name ?? '') === 'audio'" :src="rawUrl(preview.path)" controls />
        <iframe v-else-if="previewKind(previewFile?.name ?? '') === 'pdf'" :src="rawUrl(preview.path)" class="files-pdf" title="PDF 预览" />
        <p v-else class="files-binary">该文件类型暂不支持预览（可下载）。</p>
      </div>
    </template>

    <ul v-else class="files-list">
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
.files-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.files-preview-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.files-preview-close {
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
.files-preview-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.files-preview-body {
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.files-pre {
  margin: 0;
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60vh;
  overflow: auto;
  color: var(--color-text);
}
.files-img {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  object-fit: contain;
  margin: auto;
}
.files-pdf {
  width: 100%;
  height: 60vh;
  border: none;
}
.files-binary {
  padding: var(--space-4);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.files-preview-note {
  font-size: 11px;
  color: var(--color-warning);
}
</style>
