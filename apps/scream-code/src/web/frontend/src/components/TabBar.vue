<!-- Dock tab strip: the right column's top edge. Hosts every registered tab
     kind (multi-instance file tabs + singleton session tabs) and the two
     chrome actions (maximise / collapse) at its right end. Reads the
     module-level dock state directly; middle-click closes a tab. -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { closeDockTab, dockPanel, selectDockTab } from '../utils/fileTabState';
import { dockPanelDomId, dockTabDomId, dockTabType } from '../utils/dockTabTypes';
import SvgIcon from './ui/SvgIcon.vue';

withDefaults(
  defineProps<{
    /** Whether the dock currently covers the whole viewport. */
    maximized?: boolean;
    /** The maximise control only makes sense beside a live grid track; the
     *  shell hides it while the dock is already a full-screen overlay. */
    showMaximize?: boolean;
  }>(),
  { maximized: false, showMaximize: true },
);

const emit = defineEmits<{
  (e: 'update:maximized', value: boolean): void;
  (e: 'collapse'): void;
}>();

const barRef = ref<HTMLElement | null>(null);

// Keep the active tab visible when selection changes from anywhere.
// immediate: the strip can remount (dock re-open) with a persisted selection.
watch(
  () => dockPanel.activeTabId,
  async () => {
    await nextTick();
    // jsdom (tests) has no scrollIntoView — optional-call keeps the guard cheap.
    const el = barRef.value?.querySelector('.tab-button.active');
    (el as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  },
  { immediate: true },
);

function onAuxClick(e: MouseEvent, id: string): void {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  closeAndRefocus(id);
}

function focusTab(id: string | null): void {
  if (!id) return;
  void nextTick(() => document.getElementById(dockTabDomId(id))?.focus());
}

function selectAndFocus(id: string): void {
  selectDockTab(id);
  focusTab(id);
}

function closeAndRefocus(id: string): void {
  const wasActive = dockPanel.activeTabId === id;
  closeDockTab(id);
  if (wasActive) focusTab(dockPanel.activeTabId);
}

function panelIdForTab(tab: { id: string; kind: string }): string {
  // All file instances share one mounted pane; session panes each stay
  // mounted so their ids can remain one-to-one with their tabs.
  return dockPanelDomId(tab.kind === 'file' ? 'file-pane' : tab.id);
}

function onTabKeydown(event: KeyboardEvent, id: string): void {
  const tabs = dockPanel.tabs;
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectAndFocus(id);
    return;
  }
  let nextIndex = -1;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  if (nextIndex < 0) return;
  event.preventDefault();
  const target = tabs[nextIndex];
  if (target) selectAndFocus(target.id);
}
</script>

<template>
  <div ref="barRef" class="tab-bar">
    <div class="dock-tabs" role="tablist" aria-label="右栏标签" aria-orientation="horizontal">
      <div
        v-for="t in dockPanel.tabs"
        :key="t.id"
        class="tab-entry"
        role="presentation"
        :class="{ active: t.id === dockPanel.activeTabId }"
        @auxclick="(e) => onAuxClick(e, t.id)"
      >
        <button
          :id="dockTabDomId(t.id)"
          class="tab-button"
          :class="{ active: t.id === dockPanel.activeTabId }"
          role="tab"
          :aria-selected="t.id === dockPanel.activeTabId"
          :aria-controls="panelIdForTab(t)"
          :tabindex="t.id === dockPanel.activeTabId ? 0 : -1"
          :title="t.kind === 'file' ? t.filePath : t.label"
          :data-kind="t.kind"
          @click="selectAndFocus(t.id)"
          @keydown="onTabKeydown($event, t.id)"
          @mousedown="(e) => { if (e.button === 1) e.preventDefault(); }"
        >
          <SvgIcon :name="dockTabType(t.kind).icon" :size="13" class="tab-icon" />
          <span class="tab-label">{{ t.label }}</span>
        </button>
        <button
          class="tab-close"
          :title="`关闭 ${t.label}`"
          :aria-label="`关闭 ${t.label}`"
          @click.stop="closeAndRefocus(t.id)"
        >
          <SvgIcon name="x" :size="11" />
        </button>
      </div>
    </div>
    <!-- Chrome: the dock has no separate header, so its window controls live
         at the strip's right end. -->
    <div class="dock-chrome">
      <button
        v-if="showMaximize"
        class="dock-chrome-btn dock-chrome-maximize"
        :title="maximized ? '退出全屏' : '全屏'"
        :aria-label="maximized ? '退出全屏' : '全屏'"
        :aria-pressed="maximized"
        @click="emit('update:maximized', !maximized)"
      >
        <SvgIcon :name="maximized ? 'minimize' : 'expand'" :size="14" />
      </button>
      <button
        class="dock-chrome-btn dock-chrome-collapse"
        title="折叠右栏"
        aria-label="折叠右栏"
        @click="emit('collapse')"
      >
        <SvgIcon name="panel-right" :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  min-height: 36px;
  border-bottom: 1px solid var(--color-line);
  flex-shrink: 0;
  background: var(--color-surface);
}
.dock-tabs {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-width: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--color-line-strong) transparent;
}
.dock-tabs::-webkit-scrollbar {
  height: 6px;
}
.dock-tabs::-webkit-scrollbar-thumb {
  background: var(--color-line-strong);
  border-radius: var(--radius-full);
}

.tab-entry {
  display: flex;
  align-items: center;
  border-right: 1px solid var(--color-line);
  max-width: 180px;
  flex-shrink: 0;
}
.tab-button {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
  padding-left: var(--space-3);
  padding-right: var(--space-1);
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  user-select: none;
  box-shadow: inset 0 -2px 0 transparent;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.tab-entry:hover {
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

.dock-chrome {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2) 0 var(--space-1);
  flex-shrink: 0;
  border-left: 1px solid var(--color-line);
}
.dock-chrome-btn {
  width: 26px;
  height: 26px;
  align-self: center;
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
.dock-chrome-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
</style>
