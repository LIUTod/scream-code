<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { FileEntryLite } from '../utils/fileFuzzy';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(
  defineProps<{
    suggestions: FileEntryLite[];
    activeIndex: number;
    loading?: boolean;
    /** Working dir shown in the footer so users know the @ scope. */
    workDir?: string;
  }>(),
  { loading: false, workDir: '' },
);

const emit = defineEmits<{
  (e: 'select', entry: FileEntryLite): void;
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

const dirName = (p: string) => p.split('/').pop() || p;

function baseName(entry: FileEntryLite): string {
  return dirName(entry.path);
}

/** Secondary line: the containing dir of the entry (relative to workDir). */
function parentDir(entry: FileEntryLite): string {
  const idx = entry.path.lastIndexOf('/');
  return idx === -1 ? '' : entry.path.slice(0, idx);
}
</script>

<template>
  <div class="at-menu" role="listbox" aria-label="文件提及">
    <div v-if="loading && suggestions.length === 0" class="at-status">加载文件列表…</div>
    <div v-else-if="suggestions.length === 0" class="at-status">无匹配文件</div>
    <ul v-else ref="listRef" class="at-list">
      <li v-for="(entry, i) in suggestions" :key="entry.path">
        <button
          class="at-item"
          :class="{ selected: i === activeIndex }"
          :data-active="i === activeIndex ? 'true' : undefined"
          role="option"
          :aria-selected="i === activeIndex"
          @click="emit('select', entry)"
          @mousemove="emit('hover', i)"
        >
          <span class="at-item-icon" :class="{ 'is-dir': entry.isDir }">
            <SvgIcon :name="entry.isDir ? 'folder' : 'file'" :size="14" />
          </span>
          <span class="at-item-name">{{ baseName(entry) }}</span>
          <span v-if="parentDir(entry)" class="at-item-dir">{{ parentDir(entry) }}</span>
        </button>
      </li>
    </ul>
    <div class="at-hints">
      <span class="at-hint"><kbd>↑↓</kbd>选择</span>
      <span class="at-hint"><kbd>Tab/Enter</kbd>{{ suggestions[activeIndex]?.isDir ? '进入目录' : '插入引用' }}</span>
      <span class="at-hint"><kbd>Esc</kbd>关闭</span>
      <span v-if="workDir" class="at-root" :title="workDir">根：{{ dirName(workDir) }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Same popover geometry as SlashMenu (anchored above the composer input). */
.at-menu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + var(--space-2));
  z-index: 30;
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow: hidden;
  background: var(--color-surface-raised, var(--color-surface));
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, var(--shadow-xs));
}
.at-status {
  padding: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-faint);
}
.at-list {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
  overflow-y: auto;
  min-height: 0;
}
.at-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.at-item:hover,
.at-item.selected {
  background: var(--color-hover);
}
.at-item.selected {
  background: var(--color-accent-soft);
}
.at-item-icon {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: var(--color-text-muted);
}
.at-item-icon.is-dir {
  color: var(--color-accent);
}
.at-item-name {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.at-item-dir {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* keep the tail of long dirs visible */
}
.at-hints {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 5px var(--space-3);
  border-top: 1px solid var(--color-line);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
}
.at-hint kbd {
  padding: 1px 4px;
  margin-right: 4px;
  border-radius: 3px;
  background: var(--color-surface-sunken);
  font-family: inherit;
  font-size: 10px;
}
.at-root {
  margin-left: auto;
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
