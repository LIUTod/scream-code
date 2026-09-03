<!-- Renders the active file tab of the right panel: source / preview / diff.
     Content is fetched over the read-only file API and cached per file while
     the panel lives; the backend has no watch push, so refresh is manual. -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  activeFileTab,
  filePanel,
  resolveInitialFileDisplayMode,
  saveFileViewerState,
  type FileTab,
  type FileViewerDisplayMode,
  type FileViewerState,
} from '../utils/fileTabState';
import { languageForPath, previewKindForPath } from '../utils/filePreview';
import { parseUnifiedDiff, type DiffLine } from '../utils/diff';
import SvgIcon from './ui/SvgIcon.vue';
import CodeBlock from './CodeBlock.vue';
import DiffLines from './DiffLines.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import type { useScreamWebClient } from '../composables/useScreamWebClient';

type ScreamWebClient = ReturnType<typeof useScreamWebClient>;

const props = defineProps<{
  /** Needed to translate tab paths into repo-root-relative diff paths. */
  client?: ScreamWebClient;
}>();

const API = '/api/v1';

const MODES: { id: FileViewerDisplayMode; label: string }[] = [
  { id: 'source', label: '源码' },
  { id: 'preview', label: '预览' },
  { id: 'diff', label: 'Diff' },
];

const tab = computed<FileTab | undefined>(() => activeFileTab());

const displayMode = computed<FileViewerDisplayMode>(() =>
  tab.value
    ? resolveInitialFileDisplayMode(tab.value.viewerState, tab.value.initialDisplayMode)
    : 'source',
);

const kind = computed(() => (tab.value ? previewKindForPath(tab.value.filePath) : 'source'));

/** Raw media URL (images/audio bypass the text endpoint entirely). */
const refreshTick = ref(0);
const rawUrl = computed(() => {
  if (!tab.value) return '';
  const bust = refreshTick.value > 0 ? `&t=${refreshTick.value}` : '';
  return `${API}/files/raw?path=${encodeURIComponent(tab.value.filePath)}${bust}`;
});

type TextPayload =
  | { status: 'ok'; content: string; truncated: boolean }
  | { status: 'error'; message: string };
type DiffPayload = { status: 'ok'; patch: string } | { status: 'error'; message: string };

// Component-local caches survive tab switches; no cross-component sharing.
const textCache = reactive(new Map<string, TextPayload>());
const diffCache = reactive(new Map<string, DiffPayload>());

async function errorMessageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * `/git/diff` expects a repository-root-relative path, but tabs hold absolute
 * (file gate) or workdir-relative (tool args) paths. Translate via the
 * status entry for this file, or via the workdir→repo prefix that the
 * status `path`/`displayPath` pairs imply.
 */
function repoDiffPath(filePath: string): string | null {
  const gs = props.client?.gitStatus.value;
  const wd = props.client?.workDir.value ?? '';
  if (!gs?.files || gs.files.length === 0) return null;

  const workRel = wd && filePath.startsWith(`${wd}/`)
    ? filePath.slice(wd.length + 1)
    : (!filePath.startsWith('/') ? filePath : null);

  if (workRel) {
    const exact = gs.files.find((f) => (f.displayPath ?? f.path) === workRel);
    if (exact) return exact.path;
    for (const f of gs.files) {
      const dp = f.displayPath ?? f.path;
      if (dp && f.path.endsWith(dp)) {
        return f.path.slice(0, f.path.length - dp.length) + workRel;
      }
    }
  }
  return null;
}

/** Candidate diff paths, best guess first; duplicates dropped. */
function diffPathCandidates(filePath: string): string[] {
  const out: string[] = [];
  const push = (p: string | null): void => {
    if (p && p !== filePath && !out.includes(p)) out.push(p);
  };
  push(repoDiffPath(filePath));
  out.push(filePath);
  const wd = props.client?.workDir.value ?? '';
  if (wd && filePath.startsWith(`${wd}/`)) push(filePath.slice(wd.length + 1));
  return out;
}

async function loadDiff(): Promise<void> {
  const t = tab.value;
  if (!t || diffCache.has(t.filePath)) return;
  try {
    for (const cand of diffPathCandidates(t.filePath)) {
      const res = await fetch(`${API}/git/diff?path=${encodeURIComponent(cand)}`);
      if (!res.ok) {
        diffCache.set(t.filePath, { status: 'error', message: await errorMessageOf(res) });
        return;
      }
      const data = (await res.json()) as { patch?: string };
      if ((data.patch ?? '') !== '') {
        diffCache.set(t.filePath, { status: 'ok', patch: data.patch ?? '' });
        return;
      }
    }
    diffCache.set(t.filePath, { status: 'ok', patch: '' });
  } catch (e) {
    diffCache.set(t.filePath, { status: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

async function ensureLoaded(): Promise<void> {
  const t = tab.value;
  if (!t) return;

  if (displayMode.value === 'diff') {
    await loadDiff();
    return;
  }

  // Media previews stream straight from the raw endpoint — nothing to fetch.
  if (displayMode.value === 'preview' && (kind.value === 'image' || kind.value === 'audio' || kind.value === 'pdf')) return;

  if (textCache.has(t.filePath)) return;
  try {
    const res = await fetch(`${API}/files/read?path=${encodeURIComponent(t.filePath)}`);
    if (!res.ok) {
      textCache.set(t.filePath, { status: 'error', message: await errorMessageOf(res) });
    } else {
      const data = (await res.json()) as { content: string; truncated?: boolean };
      textCache.set(t.filePath, {
        status: 'ok',
        content: data.content,
        truncated: data.truncated === true,
      });
    }
  } catch (e) {
    textCache.set(t.filePath, { status: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

watch(
  () => [tab.value?.id, displayMode.value] as const,
  () => {
    void ensureLoaded();
  },
  { immediate: true },
);

/** Payload required by the current (tab, mode); undefined while in flight. */
const currentPayload = computed<TextPayload | DiffPayload | { status: 'ok' } | undefined>(() => {
  const t = tab.value;
  if (!t) return undefined;
  if (displayMode.value === 'diff') return diffCache.get(t.filePath);
  if (displayMode.value === 'preview' && (kind.value === 'image' || kind.value === 'audio' || kind.value === 'pdf')) {
    return { status: 'ok' };
  }
  return textCache.get(t.filePath);
});

const loading = computed(() => tab.value !== undefined && currentPayload.value === undefined);
const errorPayload = computed(() =>
  currentPayload.value?.status === 'error' ? currentPayload.value : null,
);

const textContent = computed(() => {
  const p = tab.value ? textCache.get(tab.value.filePath) : undefined;
  return p?.status === 'ok' ? p.content : '';
});
const truncated = computed(() => {
  const p = tab.value ? textCache.get(tab.value.filePath) : undefined;
  return p?.status === 'ok' ? p.truncated : false;
});
const diffLines = computed<DiffLine[]>(() => {
  const p = tab.value ? diffCache.get(tab.value.filePath) : undefined;
  // An empty patch parses into one bogus blank context line — guard first.
  return p?.status === 'ok' && p.patch.trim() !== '' ? parseUnifiedDiff(p.patch) : [];
});

function setMode(mode: FileViewerDisplayMode): void {
  const t = tab.value;
  if (!t || displayMode.value === mode) return;
  const state: FileViewerState = {
    displayMode: mode,
    wrapLines: t.viewerState?.wrapLines ?? false,
    scrollTop: t.viewerState?.scrollTop ?? 0,
    scrollLeft: t.viewerState?.scrollLeft ?? 0,
  };
  filePanel.tabs = saveFileViewerState(filePanel.tabs, t.id, t.viewerRevision ?? 0, state);
}

/** Manual refresh re-loads the current mode's content (no backend watch push). */
function reload(): void {
  const t = tab.value;
  if (!t) return;
  if (displayMode.value === 'diff') {
    diffCache.delete(t.filePath);
  } else if (displayMode.value === 'preview' && (kind.value === 'image' || kind.value === 'audio' || kind.value === 'pdf')) {
    refreshTick.value += 1;
    return;
  } else {
    textCache.delete(t.filePath);
  }
  void ensureLoaded();
}

const copied = ref(false);
function copyPath(): void {
  const t = tab.value;
  if (!t) return;
  void navigator.clipboard?.writeText(t.filePath).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  }).catch(() => {
    // Clipboard unavailable; ignore.
  });
}
</script>

<template>
  <div v-if="tab" class="file-viewer">
    <div class="fv-toolbar">
      <button
        class="fv-path"
        :title="copied ? '已复制路径' : `复制路径：${tab.filePath}`"
        :aria-label="`文件路径 ${tab.filePath}`"
        @click="copyPath"
      >
        <SvgIcon name="copy" :size="12" class="fv-path-icon" />
        <span class="fv-path-text">{{ tab.filePath }}</span>
      </button>
      <div class="fv-modes" role="tablist" aria-label="显示模式">
        <button
          v-for="m in MODES"
          :key="m.id"
          class="fv-mode"
          :class="{ active: displayMode === m.id }"
          role="tab"
          :aria-selected="displayMode === m.id"
          :title="`${m.label}模式`"
          @click="setMode(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <button class="fv-icon-btn" title="刷新" aria-label="刷新" @click="reload">
        <SvgIcon name="refresh" :size="14" />
      </button>
    </div>

    <div class="fv-body">
      <div v-if="loading" class="fv-status">
        <span class="fv-spinner" aria-hidden="true" />
        <span>加载中…</span>
      </div>

      <div v-else-if="errorPayload" class="fv-status fv-error">
        <p class="fv-error-name">{{ tab.label }}</p>
        <p class="fv-error-msg">{{ errorPayload.message }}</p>
        <button class="fv-retry" @click="reload">重试</button>
      </div>

      <template v-else-if="displayMode === 'diff'">
        <div v-if="diffLines.length > 0" class="fv-scroll">
          <DiffLines :lines="diffLines" />
        </div>
        <div v-else class="fv-status">该文件没有未提交的改动。</div>
      </template>

      <template v-else-if="displayMode === 'preview'">
        <div v-if="kind === 'image'" class="fv-media">
          <img :src="rawUrl" :alt="tab.label" />
        </div>
        <div v-else-if="kind === 'audio'" class="fv-media">
          <audio class="fv-audio" controls :src="rawUrl" />
        </div>
        <div v-else-if="kind === 'pdf'" class="fv-media fv-pdf">
          <iframe class="fv-pdf-frame" :src="rawUrl" :title="tab.label" />
        </div>
        <div v-else-if="kind === 'markdown'" class="fv-scroll fv-markdown">
          <MarkdownRenderer :content="textContent" />
        </div>
        <div v-else class="fv-scroll">
          <p class="fv-note">该类型暂不支持预览，显示源码内容。</p>
          <CodeBlock :code="textContent" :lang="languageForPath(tab.filePath)" />
        </div>
      </template>

      <div v-else class="fv-scroll">
        <p v-if="truncated" class="fv-note">文件较大，仅显示前 256KB。</p>
        <CodeBlock :code="textContent" :lang="languageForPath(tab.filePath)" />
      </div>
    </div>
  </div>

  <div v-else class="fv-empty">从工具卡片、文件浏览或消息中选择文件打开</div>
</template>

<style scoped>
.file-viewer {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.fv-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-line);
  flex-shrink: 0;
}
.fv-path {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.fv-path:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.fv-path-icon {
  flex-shrink: 0;
}
.fv-path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  /* Keep the tail (file name) visible for long paths. */
  direction: rtl;
  text-align: left;
}

.fv-modes {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.fv-mode {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  padding: 3px var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.fv-mode:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.fv-mode.active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.fv-icon-btn {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.fv-icon-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.fv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.fv-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-2) var(--space-3);
}
.fv-markdown {
  color: var(--color-text);
}
.fv-media {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3);
}
.fv-media img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
}
.fv-audio {
  width: 100%;
}
.fv-pdf {
  padding: 0;
  align-items: stretch;
  justify-content: stretch;
}
.fv-pdf-frame {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: none;
  background: var(--color-surface);
}

.fv-status {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}
.fv-error-name {
  margin: 0;
  font-weight: 600;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  word-break: break-all;
}
.fv-error-msg {
  margin: 0;
  color: var(--color-danger);
  word-break: break-word;
}
.fv-retry {
  margin-top: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.fv-retry:hover {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
}

.fv-note {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-warning);
}

.fv-spinner {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  border: 2px solid var(--color-line-strong);
  border-top-color: var(--color-accent);
  animation: fv-spin 0.8s linear infinite;
}
@keyframes fv-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .fv-spinner { animation: none; }
}

.fv-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--font-size-sm);
  text-align: center;
}
</style>
