<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ModelInfo } from '../types';

/**
 * Model + thinking-level picker (TUI `/model` selector parity).
 * Opens upward from the composer model pill; grouped by provider, searchable.
 */
const props = defineProps<{
  models: ModelInfo[];
  currentModel?: string | undefined;
  currentThinking?: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'apply-model', alias: string): void;
  (e: 'apply-thinking', level: string): void;
  (e: 'close'): void;
}>();

const DEFAULT_THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;

const THINKING_LABELS: Record<string, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
};

const query = ref('');
const searchRef = ref<HTMLInputElement | null>(null);

onMounted(() => {
  searchRef.value?.focus();
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.models;
  return props.models.filter(
    (m) =>
      m.alias.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.displayName ?? '').toLowerCase().includes(q),
  );
});

/** Group filtered models by provider, preserving config order. */
const groups = computed(() => {
  const map = new Map<string, ModelInfo[]>();
  for (const m of filtered.value) {
    const list = map.get(m.provider) ?? [];
    list.push(m);
    map.set(m.provider, list);
  }
  return [...map.entries()].map(([provider, models]) => ({ provider, models }));
});

const activeModel = computed(() => props.models.find((m) => m.alias === props.currentModel));

const thinkingLevels = computed<readonly string[]>(
  () => activeModel.value?.thinkingLevels ?? DEFAULT_THINKING_LEVELS,
);

function thinkingLabel(level: string): string {
  return THINKING_LABELS[level] ?? level;
}

function formatContext(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function displayName(m: ModelInfo): string {
  return m.displayName ?? m.model;
}

const rootRef = ref<HTMLElement | null>(null);

function onDocMousedown(e: MouseEvent): void {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) emit('close');
}

onMounted(() => document.addEventListener('mousedown', onDocMousedown, true));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown, true));

function pick(alias: string) {
  if (alias !== props.currentModel) emit('apply-model', alias);
  emit('close');
}

/** Keyboard navigation: search ↓ focuses the first row; ↑/↓ cycles row focus. */
const listRef = ref<HTMLElement | null>(null);

function rowButtons(): HTMLButtonElement[] {
  const root = listRef.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.picker-row'));
}

function focusFirstRow(): void {
  rowButtons()[0]?.focus();
}

function onListKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = rowButtons();
  if (rows.length === 0) return;
  const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
  e.preventDefault();
  if (idx === -1) {
    rows[0]?.focus();
  } else if (e.key === 'ArrowDown') {
    rows[(idx + 1) % rows.length]?.focus();
  } else {
    rows[(idx - 1 + rows.length) % rows.length]?.focus();
  }
}

function pickThinking(level: string) {
  if (level !== props.currentThinking) emit('apply-thinking', level);
}
</script>

<template>
  <div ref="rootRef" class="model-picker" role="dialog" aria-label="模型选择" @keydown.esc.stop="emit('close')">
    <input
      ref="searchRef"
      v-model="query"
      class="picker-search"
      type="text"
      placeholder="搜索模型…"
      id="model-search-input"
      name="model-search"
      autocomplete="off"
      spellcheck="false"
      @keydown.arrow-down.prevent="focusFirstRow"
    />

    <div ref="listRef" class="picker-list" @keydown="onListKeydown">
      <div v-if="groups.length === 0" class="picker-empty">无匹配模型</div>
      <div v-for="group in groups" :key="group.provider" class="picker-group">
        <div class="picker-group-title">{{ group.provider }}</div>
        <button
          v-for="m in group.models"
          :key="m.alias"
          :class="['picker-row', { active: m.alias === currentModel }]"
          @click="pick(m.alias)"
        >
          <span class="row-main">
            <span class="row-name">{{ displayName(m) }}</span>
            <span class="row-alias">{{ m.alias }}</span>
          </span>
          <span class="row-meta">{{ formatContext(m.maxContextSize) }}</span>
          <span v-if="m.alias === currentModel" class="row-check">✓</span>
        </button>
      </div>
    </div>

    <div class="picker-thinking">
      <span class="thinking-label">思考强度</span>
      <div class="thinking-options">
        <button
          v-for="level in thinkingLevels"
          :key="level"
          :class="['thinking-btn', { active: level === currentThinking }]"
          @click="pickThinking(level)"
        >
          {{ thinkingLabel(level) }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-picker {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: var(--space-2);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: calc(100vw - var(--space-8));
  max-height: 60vh;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
  animation: rise-in var(--dur-slower) var(--ease-spring);
}

.picker-search {
  margin: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: inherit;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.picker-search:focus {
  outline: none;
  border-color: var(--color-accent-bd);
  box-shadow: var(--glow-focus);
}
.picker-search::placeholder {
  color: var(--color-text-faint);
}

.picker-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 0 var(--space-2) var(--space-2);
}

.picker-empty {
  padding: var(--space-4);
  text-align: center;
  color: var(--color-text-faint);
  font-size: var(--font-size-sm);
}

.picker-group-title {
  padding: var(--space-2) var(--space-2) var(--space-1);
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur-fast),
    border-color var(--dur-fast);
}
.picker-row:hover {
  background: var(--color-hover);
}
.picker-row.active {
  background: var(--color-selected);
  border-color: var(--color-accent-bd);
}
.picker-row.active .row-name {
  color: var(--color-accent);
}

.row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.row-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-alias {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-meta {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
.row-check {
  flex-shrink: 0;
  color: var(--color-accent);
  font-weight: 700;
}

.picker-thinking {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-line);
  background: var(--color-surface);
}
.thinking-label {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.thinking-options {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}
.thinking-btn {
  padding: 2px 10px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.thinking-btn:hover {
  border-color: var(--color-line-strong);
  color: var(--color-text);
  background: var(--color-hover);
}
.thinking-btn.active {
  background: var(--color-selected);
  border-color: var(--color-accent-bd);
  color: var(--color-accent);
  font-weight: 600;
}

@media (max-width: 640px) {
  .model-picker {
    left: var(--space-2);
    right: var(--space-2);
    width: auto;
    max-width: calc(100vw - 32px);
    max-height: 70vh;
  }
  .picker-row,
  .thinking-btn {
    min-height: 44px;
  }
}
</style>
