<script setup lang="ts">
import { computed, ref } from 'vue';
import type { GitStatus } from '../types';
import { splitPath } from '../utils/pathLabel';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  gitStatus?: GitStatus | null;
}>(), { gitStatus: null });

const emit = defineEmits<{
  (e: 'refresh'): void;
  /** `path` is repo-root-relative (for the API); `display` is the short label. */
  (e: 'diff', file: { path: string; display: string; adds?: number; dels?: number }): void;
}>();

const STATUS_LABEL: Record<string, string> = {
  M: 'M', A: 'A', D: 'D', R: 'R', U: 'U', '??': '?', '?': '?',
};
const STATUS_COLOR: Record<string, string> = {
  D: 'danger', A: 'success', R: 'success', U: 'danger', '??': 'warning', '?': 'warning',
};

/** Long worktrees used to scroll inside a 24vh slot; a capped list plus an
 * explicit "show all" reads better in a 310px column. */
const FILE_PREVIEW = 8;
const showAll = ref(false);

const STORAGE_KEY = 'scream-panel-git-open';
const open = ref(true);
try {
  open.value = localStorage.getItem(STORAGE_KEY) !== '0';
} catch {
  /* ignore */
}
function toggle() {
  open.value = !open.value;
  try { localStorage.setItem(STORAGE_KEY, open.value ? '1' : '0'); } catch { /* ignore */ }
}

function refresh() {
  emit('refresh');
}

const visibleFiles = computed(() => {
  const files = props.gitStatus?.files ?? [];
  return showAll.value ? files : files.slice(0, FILE_PREVIEW);
});
const hiddenCount = computed(() => Math.max(0, (props.gitStatus?.files?.length ?? 0) - visibleFiles.value.length));

/** Ahead/behind summary folded into the header hint, e.g. `main · ↑2`. */
const syncLabel = computed(() => {
  const ahead = props.gitStatus?.ahead ?? 0;
  const behind = props.gitStatus?.behind ?? 0;
  if (!ahead && !behind) return '';
  const parts = [];
  if (ahead) parts.push(`↑${ahead}`);
  if (behind) parts.push(`↓${behind}`);
  return ` · ${parts.join(' ')}`;
});
</script>

<template>
  <section :class="['panel-section', 'git-panel', { 'is-open': open }]">
    <div class="panel-head-row">
      <button class="panel-head" :aria-expanded="open" @click="toggle">
        <span class="head-icon"><SvgIcon name="git-branch" :size="14" /></span>
        <span class="head-title">Git 变更</span>
        <span v-if="gitStatus" class="head-hint" :title="`${gitStatus.branch ?? 'detached'}${syncLabel}`">{{ gitStatus.branch ?? 'detached' }}{{ syncLabel }}</span>
        <span v-else class="head-hint">状态不可用</span>
        <span class="head-tail">
          <span v-if="gitStatus" class="head-count">{{ gitStatus.changed }}</span>
          <SvgIcon class="chevron" :class="{ rotated: open }" name="chevron-down" :size="14" />
        </span>
      </button>
      <button class="icon-btn" title="刷新" aria-label="刷新 Git 状态" @click="refresh">
        <SvgIcon name="refresh" :size="14" />
      </button>
    </div>

    <div v-show="open" class="panel-body">
      <template v-if="gitStatus">
        <ul v-if="visibleFiles.length" class="git-files">
          <li v-for="file in visibleFiles" :key="file.path">
            <button class="git-file" :title="`查看 ${file.displayPath ?? file.path} 的 diff`" @click="emit('diff', { path: file.path, display: file.displayPath ?? file.path, adds: file.adds, dels: file.dels })">
              <span class="git-file-status" :class="STATUS_COLOR[file.status] ?? ''">{{ STATUS_LABEL[file.status] ?? file.status }}</span>
              <!-- Long worktree paths are trimmed by segment so the filename
                   always survives (CSS rtl ellipsis reordered the slashes). -->
              <span class="git-file-name">
                <span v-if="splitPath(file.displayPath ?? file.path).dir" class="git-file-dir">{{ splitPath(file.displayPath ?? file.path).dir }}</span>
                <span class="git-file-base">{{ splitPath(file.displayPath ?? file.path).base }}</span>
              </span>
              <span v-if="file.adds !== undefined || file.dels !== undefined" class="git-file-stat">
                <span v-if="file.adds" class="add">+{{ file.adds }}</span>
                <span v-if="file.dels" class="del">−{{ file.dels }}</span>
              </span>
            </button>
          </li>
        </ul>
        <button v-if="hiddenCount" class="git-more" @click="showAll = !showAll">
          {{ showAll ? '收起列表' : `显示全部 ${gitStatus.files?.length ?? 0} 个文件` }}
        </button>
        <pre v-if="gitStatus.diffStat" class="diff-body">{{ gitStatus.diffStat }}</pre>
        <div v-else-if="!visibleFiles.length" class="diff-empty">工作区干净，没有变更。</div>
      </template>
      <div v-else class="diff-empty">读取 Git 状态失败，点右上角刷新重试。</div>
    </div>
  </section>
</template>

<style scoped>
/* Card / header anatomy comes from the shared global styles. The header row
   carries the hairline so the refresh button sits on the same strip. */
.panel-head-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--color-line);
}
.panel-head-row > .panel-head { flex: 1 1 auto; min-width: 0; border-bottom: 0; }
.panel-head-row > .icon-btn { margin-right: var(--space-2); }
.git-files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.git-file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-xs);
  cursor: pointer;
  text-align: left;
}
.git-file:hover { background: transparent; }
/* Status as coloured type instead of 74 grey blocks — the letter is the
   information, the tint only has to flag the destructive/additive cases. */
.git-file-status {
  width: 18px;
  display: inline-flex;
  justify-content: center;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.git-file-status.danger { color: var(--color-danger); }
.git-file-status.success { color: var(--color-success); }
.git-file-status.warning { color: var(--color-warning); }
.git-file-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  font-family: var(--font-mono);
}
.git-file-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-faint);
}
.git-file-base {
  flex-shrink: 0;
  color: var(--color-text);
}
.git-file-stat {
  flex-shrink: 0;
  display: inline-flex;
  gap: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
.git-file-stat .add { color: var(--color-success); }
.git-file-stat .del { color: var(--color-danger); }
.git-file:hover .git-file-base { color: var(--color-accent); text-decoration: underline; text-underline-offset: 2px; }
.git-more {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.git-more:hover { text-decoration: underline; text-underline-offset: 2px; }
.diff-body {
  margin: 0;
  padding: var(--space-2);
  max-height: 30vh;
  overflow: auto;
  white-space: pre-wrap;
  border-radius: var(--radius-sm);
  font: var(--font-size-xs)/1.6 var(--font-mono);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
}
.diff-empty { color: var(--color-text-faint); font-size: var(--font-size-xs); line-height: 1.5; }

@media (max-width: 640px) {
  .panel-head-row > .panel-head { min-height: 48px; }
  .panel-head-row > .icon-btn { width: 44px; height: 44px; }
}
</style>
