<!-- Session detail tab: the stacked overview panels (run status, git + inline
     diff, todo, preferences, goal). Content is rendered flat inside the dock;
     this component owns only the scroll container. -->
<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { UseScreamWebClientReturn } from '../composables/useScreamWebClient';
import { parseUnifiedDiff, type DiffLine } from '../utils/diff';
import DiffLines from './DiffLines.vue';
import GitPanel from './GitPanel.vue';
import GoalPanel from './GoalPanel.vue';
import LikePanel from './LikePanel.vue';
import RunStatusPanel from './RunStatusPanel.vue';
import TodoPanel from './TodoPanel.vue';

const props = defineProps<{ client: UseScreamWebClientReturn }>();

/** Inline git diff preview for a selected changed file. */
interface DiffPreview {
  path: string;
  display: string;
  adds?: number;
  dels?: number;
  lines: DiffLine[];
  loading: boolean;
}
const gitDiff = ref<DiffPreview | null>(null);
const diffRef = ref<HTMLElement | null>(null);

async function openDiff(file: { path: string; display: string; adds?: number; dels?: number }): Promise<void> {
  gitDiff.value = { ...file, lines: [], loading: true };
  try {
    const res = await fetch(`/api/v1/git/diff?path=${encodeURIComponent(file.path)}`);
    const data = (await res.json()) as { patch: string };
    const lines = parseUnifiedDiff(data.patch ?? '');
    // Untracked rows have no numstat entry, so fall back to counting the
    // synthesised added-file patch.
    const adds = file.adds ?? (file.dels === undefined ? lines.filter((l) => l.type === 'add').length : undefined);
    gitDiff.value = { ...file, adds, lines, loading: false };
  } catch {
    gitDiff.value = { ...file, lines: [], loading: false };
  }
  // The card lands below a 500px+ file list; without this the click looks dead.
  await nextTick();
  const reduced = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  diffRef.value?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}

const {
  connectionStatus,
  status,
  sessionId,
  isBusy,
  isArchived,
  goal,
  todos,
  goalRequestPending,
  goalRequestError,
  like,
  gitStatus,
  refineGoal,
  createGoal,
  updateGoal,
  pauseGoal,
  resumeGoal,
  cancelGoal,
} = props.client;
</script>

<template>
  <div class="detail-view">
    <RunStatusPanel :status="status" :busy="isBusy" :connection-status="connectionStatus" />
    <GitPanel
      :git-status="gitStatus"
      @refresh="props.client.fetchGitStatus()"
      @diff="openDiff"
    />
    <div v-if="gitDiff" ref="diffRef" class="git-diff-view">
      <div class="git-diff-head">
        <span class="git-diff-title" :title="gitDiff.path">{{ gitDiff.loading ? '加载中…' : gitDiff.display }}</span>
        <span class="git-diff-tools">
          <span v-if="!gitDiff.loading && (gitDiff.adds || gitDiff.dels)" class="git-diff-stat">
            <span v-if="gitDiff.adds" class="add">+{{ gitDiff.adds }}</span>
            <span v-if="gitDiff.dels" class="del">−{{ gitDiff.dels }}</span>
          </span>
          <button class="git-diff-close" title="关闭 diff" aria-label="关闭 diff" @click="gitDiff = null">✕</button>
        </span>
      </div>
      <div v-if="gitDiff.lines.length" class="git-diff-body">
        <DiffLines :lines="gitDiff.lines" />
      </div>
      <p v-else-if="!gitDiff.loading" class="git-diff-empty">该文件无差异内容（可能是二进制文件或已被忽略）。</p>
    </div>
    <TodoPanel :todos="todos" />
    <LikePanel :like="like" :update-like="props.client.updateLike" />
    <GoalPanel
      :goal="goal"
      :session-id="sessionId"
      :connection-status="connectionStatus"
      :busy="isBusy"
      :archived="isArchived"
      :pending="goalRequestPending"
      :error="goalRequestError"
      :refine-goal="refineGoal"
      :create-goal="createGoal"
      :update-goal="updateGoal"
      :pause-goal="pauseGoal"
      :resume-goal="resumeGoal"
      :cancel-goal="cancelGoal"
    />
  </div>
</template>

<style scoped>
/* The dock body scrolls as one container; sections keep their natural height
   instead of being flex-shrunk and clipped. */
.detail-view {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-5);
}
/* Cards must keep their natural height: as flex items they would shrink and
   `overflow: hidden` would slice the rows. */
.detail-view > * { flex-shrink: 0; }

/* Diff preview is a module card too — same container language as the panels. */
.git-diff-view {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}
.git-diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 9px var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.git-diff-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-diff-tools { display: inline-flex; align-items: center; gap: var(--space-2); flex-shrink: 0; }
.git-diff-stat {
  display: inline-flex;
  gap: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
.git-diff-stat .add { color: var(--color-success); }
.git-diff-stat .del { color: var(--color-danger); }
.git-diff-close {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}
.git-diff-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.git-diff-body {
  padding: var(--space-2);
  /* A patch can be thousands of lines; cap the pane instead of letting one
     module push the whole column into a scroll marathon. */
  max-height: 40vh;
  overflow: auto;
}
.git-diff-empty {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
</style>
