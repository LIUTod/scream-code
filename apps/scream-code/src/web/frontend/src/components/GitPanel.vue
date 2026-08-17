<script setup lang="ts">
import { ref } from 'vue';
import type { GitStatus } from '../types';
import SvgIcon from './ui/SvgIcon.vue';

withDefaults(defineProps<{
  gitStatus?: GitStatus | null;
}>(), { gitStatus: null });

const emit = defineEmits<{
  (e: 'refresh'): void;
}>();

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
</script>

<template>
  <section class="panel-section git-panel">
    <div class="panel-head-row">
      <button class="panel-head" :aria-expanded="open" @click="toggle">
        <span class="head-icon"><SvgIcon name="git-branch" :size="16" /></span>
        <span class="head-title">Git 变更</span>
        <span v-if="gitStatus" class="head-count">{{ gitStatus.changed }}</span>
        <SvgIcon class="chevron" :class="{ rotated: open }" name="chevron-down" :size="16" />
      </button>
      <button class="icon-btn" title="刷新" aria-label="刷新 Git 状态" @click="refresh">
        <SvgIcon name="refresh" :size="14" />
      </button>
    </div>

    <div v-show="open" class="panel-body">
      <template v-if="gitStatus">
        <div class="status-row">
          <span class="row-label">分支</span>
          <span class="row-value">{{ gitStatus.branch ?? 'detached' }}</span>
        </div>
        <div v-if="gitStatus.ahead || gitStatus.behind" class="status-row">
          <span class="row-label">同步</span>
          <span class="row-value">
            <template v-if="gitStatus.ahead">↑{{ gitStatus.ahead }}</template>
            <template v-if="gitStatus.ahead && gitStatus.behind"> · </template>
            <template v-if="gitStatus.behind">↓{{ gitStatus.behind }}</template>
          </span>
        </div>
        <div v-if="gitStatus.changed" class="diff-block">
          <pre v-if="gitStatus.diffStat" class="diff-body">{{ gitStatus.diffStat }}</pre>
          <div v-else class="diff-empty">{{ gitStatus.changed }} 项变更</div>
        </div>
        <div v-else class="diff-empty">工作区干净，没有变更。</div>
      </template>
      <div v-else class="diff-empty">Git 状态不可用。</div>
    </div>
  </section>
</template>

<style scoped>
.panel-section {
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: 14px;
  background: var(--color-surface);
  box-shadow: 0 2px 8px rgba(20, 35, 24, 0.03);
}
.panel-head-row { display: flex; align-items: center; }
.panel-head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 0 12px 14px;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.panel-head:hover { background: var(--color-surface-sunken); }
.head-icon { display: grid; place-items: center; color: var(--color-accent); }
.head-title { flex: 1; }
.head-count {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 600;
}
.icon-btn {
  margin-right: 10px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
}
.icon-btn:hover { color: var(--color-accent); background: var(--color-accent-soft); }
.chevron { color: var(--color-text-faint); transition: transform 160ms var(--ease-out); }
.chevron.rotated { transform: rotate(180deg); }
.panel-body { padding: 0 14px 13px; display: flex; flex-direction: column; gap: 9px; }
.status-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-text-muted); }
.row-label { width: 52px; color: var(--color-text-faint); }
.row-value { font-family: var(--font-mono); font-size: 12px; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-block { margin-top: 2px; }
.diff-body {
  margin: 0;
  padding: 10px;
  max-height: 30vh;
  overflow: auto;
  white-space: pre-wrap;
  font: 11px/1.6 var(--font-mono);
  background: var(--color-surface-sunken);
  border-radius: 9px;
  color: var(--color-text-muted);
}
.diff-empty { padding: 10px 2px; text-align: center; color: var(--color-text-faint); font-size: 12px; }
</style>
