<!-- Spotlight-style session search: Cmd+K to open, type to filter by title,
     arrow keys to navigate, Enter to switch. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { SessionListItem } from '../types';
import Dialog from './ui/Dialog.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{
  sessions: SessionListItem[];
  activeId: string | null;
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();

const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.sessions;
  return props.sessions.filter((s) =>
    s.title.toLowerCase().includes(q) ||
    s.sessionId.toLowerCase().includes(q),
  );
});

const selectedIndex = ref(0);

watch(query, () => { selectedIndex.value = 0; });
watch(results, () => { selectedIndex.value = 0; });

function clampIndex(i: number): number {
  const len = results.value.length;
  if (len === 0) return 0;
  return Math.max(0, Math.min(len - 1, i));
}

async function scrollSelectedIntoView(): Promise<void> {
  await nextTick();
  const el = listRef.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  el?.scrollIntoView({ block: 'nearest' });
}

function move(delta: number): void {
  selectedIndex.value = clampIndex(selectedIndex.value + delta);
  void scrollSelectedIntoView();
}

function openSelected(): void {
  const hit = results.value[selectedIndex.value];
  if (hit) {
    emit('select', hit.sessionId);
    emit('close');
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); openSelected(); }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

onMounted(() => {
  inputRef.value?.focus();
});
</script>

<template>
  <Dialog :open="true" @close="emit('close')">
    <template #header>
      <div class="sd-search-wrap">
        <span class="sd-icon"><SvgIcon name="search" :size="19" /></span>
        <input
          ref="inputRef"
          v-model="query"
          class="sd-input"
          type="text"
          placeholder="搜索会话..."
          id="session-search-input"
          name="session-search"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKeydown"
        />
      </div>
    </template>

    <div ref="listRef" class="sd-list" role="listbox">
      <button
        v-for="(s, i) in results"
        :key="s.sessionId"
        :class="['sd-row', { on: i === selectedIndex, active: s.sessionId === activeId }]"
        role="option"
        :aria-selected="i === selectedIndex"
        @click="emit('select', s.sessionId); emit('close')"
        @mousemove="selectedIndex = i"
      >
        <span class="sd-title">{{ s.title || 'New Session' }}</span>
        <span class="sd-meta">
          <span class="sd-time">{{ formatTime(s.createdAt) }}</span>
          <span class="sd-count">{{ s.messageCount }} 条</span>
          <span v-if="s.active" class="sd-active">●</span>
        </span>
      </button>
      <div v-if="results.length === 0" class="sd-empty">没有匹配的会话</div>
    </div>

    <template #footer>
      <span class="sd-hint">↑↓ 导航 · Enter 切换 · Esc 关闭</span>
    </template>
  </Dialog>
</template>

<style scoped>
.sd-search-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.sd-icon {
  flex-shrink: 0;
  font-size: var(--font-size-base);
  opacity: 0.6;
}
.sd-input {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-base);
  color: var(--color-text);
  background: none;
  border: none;
  outline: none;
  padding: var(--space-1) 0;
}
.sd-input::placeholder {
  color: var(--color-text-muted);
}

.sd-list {
  max-height: 360px;
  overflow-y: auto;
  padding: var(--space-1);
  margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-4)) 0;
}
.sd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: none;
  cursor: pointer;
  text-align: left;
  color: var(--color-text);
  transition: background var(--dur-fast);
}
.sd-row:hover,
.sd-row.on {
  background: var(--color-surface-sunken);
}
.sd-row.active .sd-title {
  color: var(--color-accent);
}

.sd-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.sd-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
.sd-active {
  color: var(--color-accent);
}

.sd-empty {
  padding: var(--space-5) var(--space-3);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.sd-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
</style>
