<!-- Horizontal file-tab strip for the right panel. Reads the module-level
     panel state directly; middle-click closes a tab (desktop convention). -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { closeFileTab, filePanel, selectFileTab } from '../utils/fileTabState';
import SvgIcon from './ui/SvgIcon.vue';

const barRef = ref<HTMLElement | null>(null);

// Keep the active tab visible when selection changes from anywhere.
// immediate: the strip can remount (panel re-open) with a persisted selection.
watch(
  () => filePanel.activeTabId,
  async () => {
    await nextTick();
    const el = barRef.value?.querySelector('.tab-button.active');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },
  { immediate: true },
);

function onAuxClick(e: MouseEvent, id: string): void {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  closeFileTab(id);
}
</script>

<template>
  <div v-if="filePanel.tabs.length > 0" ref="barRef" class="tab-bar" role="tablist" aria-label="文件标签">
    <div
      v-for="t in filePanel.tabs"
      :key="t.id"
      class="tab-button"
      :class="{ active: t.id === filePanel.activeTabId }"
      role="tab"
      :aria-selected="t.id === filePanel.activeTabId"
      :title="t.filePath"
      @click="selectFileTab(t.id)"
      @mousedown="(e) => { if (e.button === 1) e.preventDefault(); }"
      @auxclick="(e) => onAuxClick(e, t.id)"
    >
      <SvgIcon name="file" :size="13" class="tab-icon" />
      <span class="tab-label">{{ t.label }}</span>
      <button
        class="tab-close"
        :title="`关闭 ${t.label}`"
        :aria-label="`关闭 ${t.label}`"
        @click.stop="closeFileTab(t.id)"
      >
        <SvgIcon name="x" :size="11" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-width: 0;
  height: 36px;
  flex-shrink: 1;
  scrollbar-width: thin;
  scrollbar-color: var(--color-line-strong) transparent;
}
.tab-bar::-webkit-scrollbar {
  height: 6px;
}
.tab-bar::-webkit-scrollbar-thumb {
  background: var(--color-line-strong);
  border-radius: var(--radius-full);
}

.tab-button {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-left: var(--space-3);
  padding-right: var(--space-1);
  border-right: 1px solid var(--color-line);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  max-width: 180px;
  min-width: 80px;
  flex-shrink: 0;
  user-select: none;
  box-shadow: inset 0 -2px 0 transparent;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.tab-button:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.tab-button.active {
  background: var(--color-surface-raised);
  color: var(--color-text);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}
.tab-icon {
  flex-shrink: 0;
  opacity: 0.75;
}
.tab-button.active .tab-icon {
  opacity: 1;
  color: var(--color-accent);
}
.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.tab-button.active .tab-label {
  font-weight: 500;
}
.tab-close {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.tab-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
</style>
