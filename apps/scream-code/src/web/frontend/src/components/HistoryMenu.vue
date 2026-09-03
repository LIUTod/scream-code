<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{
  items: string[];
  activeIndex: number;
}>();

const emit = defineEmits<{
  (e: 'apply', text: string): void;
  (e: 'hover', index: number): void;
}>();

const listRef = ref<HTMLElement | null>(null);

// Keyboard navigation moves the active row outside; keep it in view.
watch(
  () => props.activeIndex,
  async () => {
    await nextTick();
    const el = listRef.value?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  },
);

// Initial open: scroll the active row (latest entry) into view immediately.
onMounted(async () => {
  await nextTick();
  const el = listRef.value?.querySelector<HTMLElement>('[data-active="true"]');
  el?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <div class="history-menu" role="listbox" aria-label="输入历史">
    <div class="history-header" title="输入历史">
      <SvgIcon name="refresh" :size="14" />
      <span class="history-hints">
        <span class="history-hint"><kbd>↑↓</kbd>选择</span>
        <span class="history-hint"><kbd>Tab/Enter</kbd>填入</span>
        <span class="history-hint"><kbd>Esc</kbd>关闭</span>
      </span>
    </div>
    <ul ref="listRef" class="history-list">
      <li v-for="(item, i) in items" :key="`${i}:${item}`">
        <button
          class="history-item"
          :class="{ selected: i === activeIndex }"
          :data-active="i === activeIndex ? 'true' : undefined"
          role="option"
          :aria-selected="i === activeIndex"
          @click="emit('apply', item)"
          @mousemove="emit('hover', i)"
        >
          <span class="history-item-index">{{ i + 1 }}</span>
          <span class="history-item-text">{{ item }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Same popover geometry as AtFileMenu / SlashMenu (anchored above input). */
.history-menu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + var(--space-2));
  z-index: 30;
  display: flex;
  flex-direction: column;
  max-height: min(44vh, 360px);
  overflow: hidden;
  background: var(--color-surface-raised, var(--color-surface));
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, var(--shadow-xs));
}
.history-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-line);
  color: var(--color-text-faint);
}
.history-hints {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-xs, 11px);
}
.history-hint kbd {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xs, 11px);
  color: var(--color-text-muted);
}
.history-list {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
  overflow-y: auto;
  min-height: 0;
}
.history-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--font-size-sm);
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.history-item:hover,
.history-item.selected {
  background: var(--color-hover);
}
.history-item.selected {
  background: var(--color-accent-soft);
}
.history-item-index {
  flex-shrink: 0;
  padding-top: 1px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--color-text-faint);
}
.history-item-text {
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
</style>
