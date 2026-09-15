<script setup lang="ts">
import { computed, ref } from 'vue';
import { dockPanel, openDockTab, setDockOpen, toggleDock } from '../utils/fileTabState';
import { singleGroup, type MenuEntry } from '../utils/menus';
import MenuPopover from './MenuPopover.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(
  defineProps<{
    title: string | null;
    busy: boolean;
    statsOpen: boolean;
    /** Current-turn token total; shown inside the stats pill when > 0. */
    turnTokens: number | null;
    /** Turn number from the loaded journal; when 0 / null the stats pill keeps the icon only. */
    turnCount?: number | null;
  }>(),
  { title: null, busy: false, statsOpen: false, turnTokens: null, turnCount: null },
);

const emit = defineEmits<{
  (e: 'home'): void;
  (e: 'rename', title: string): void;
  (e: 'export'): void;
  (e: 'fork'): void;
  (e: 'clear'): void;
  (e: 'toggle-stats'): void;
}>();

const dockOpen = computed(() => dockPanel.panelOpen);
/** Export/clear only make sense with a journal; in an empty session both actions have no target, so their entry points are removed. */
const hasContent = computed(() => (props.turnCount ?? 0) > 0 || (props.turnTokens ?? 0) > 0);

/** Collapse / reveal the right dock. Opening from here lands on the session
 *  detail tab (the dock entry point the retired drawer used to own). */
function onDockToggle(): void {
  if (dockPanel.panelOpen) setDockOpen(false);
  else openDockTab('detail');
}

function fmtTokens(n: number | null): string {
  if (n === null || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/* ── "More" popover: export / clear / file panel folded into one menu ───── */
const moreOpen = ref(false);

const moreGroups = computed(() =>
  singleGroup([
    {
      key: 'export',
      label: '导出 Markdown',
      icon: 'download',
      disabled: !hasContent.value,
      title: hasContent.value ? '把当前会话导出成 Markdown 文件' : '还没有消息可导出',
    },
    {
      key: 'fork',
      label: '分叉会话',
      icon: 'fork',
      disabled: !hasContent.value,
      title: hasContent.value ? '从当前会话分叉出新会话' : '还没有消息可分叉',
    },
    {
      key: 'clear',
      label: '清空本地消息',
      icon: 'broom',
      tone: 'danger',
      disabled: !hasContent.value,
      title: hasContent.value
        ? '清空本地 journal（服务端记录不受影响）'
        : '还没有消息可清空',
    },
    {
      key: 'files',
      label: dockOpen.value ? '收起文件面板' : '打开文件面板',
      icon: 'file',
      title: dockOpen.value ? '收起右侧面板' : '在右侧面板打开文件视图',
    },
  ] satisfies MenuEntry[]),
);

function onMoreSelect(key: string): void {
  moreOpen.value = false;
  if (key === 'export') emit('export');
  else if (key === 'fork') emit('fork');
  else if (key === 'clear') emit('clear');
  else if (key === 'files') toggleDock();
}

const editing = ref(false);
const draft = ref('');

function startEdit() {
  draft.value = props.title ?? '';
  editing.value = true;
}

function commitEdit() {
  const t = draft.value.trim();
  editing.value = false;
  if (t && t !== props.title) emit('rename', t);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    editing.value = false;
  }
}

const statusText = computed(() => (props.busy ? '运行中' : '就绪'));
</script>

<template>
  <header class="conv-bar">
    <div class="conv-bar-left">
      <button class="ghost-btn back-btn" title="返回工作台" aria-label="返回工作台" @click="emit('home')">
        <SvgIcon name="chevron-left" :size="20" />
      </button>
      <span class="status-dot" :class="{ busy }" :title="statusText" aria-hidden="true" />
      <button
        class="title-btn"
        :title="editing ? '' : '点击重命名'"
        @click="startEdit"
      >
        <template v-if="editing">
          <input
            v-model="draft"
            class="title-input"
            aria-label="会话标题"
            @keydown="onKeydown"
            @blur="commitEdit"
            @click.stop
          />
        </template>
        <template v-else>
          <span class="title-text">{{ title || '新会话' }}</span>
        </template>
      </button>
    </div>
    <div class="conv-bar-right">
      <!-- Stats pill: turns · tokens, opening the SessionStatsPanel popover.
           pointerdown.stop is the regression point: without it the panel's global
           outside-click close swallows this toggle first. -->
      <button
        class="ghost-btn stats-btn"
        :class="{ active: statsOpen }"
        :title="statsOpen ? '收起会话统计' : '会话统计：轮次与 token 用量'"
        :aria-label="statsOpen ? '收起会话统计' : '会话统计'"
        :aria-expanded="statsOpen"
        data-stats-pill
        @pointerdown.stop
        @click="emit('toggle-stats')"
      >
        <SvgIcon name="bar-chart" :size="16" />
        <span v-if="turnCount" class="stats-metric mono">{{ turnCount }} 轮</span>
        <span v-if="turnCount && fmtTokens(turnTokens)" class="stats-sep" aria-hidden="true">·</span>
        <span v-if="fmtTokens(turnTokens)" class="stats-metric mono">{{ fmtTokens(turnTokens) }}</span>
      </button>
      <MenuPopover
        v-model:open="moreOpen"
        label="更多会话操作"
        :groups="moreGroups"
        placement="bottom"
        align="right"
        @select="onMoreSelect"
      >
        <button
          class="ghost-btn more-btn"
          :class="{ active: moreOpen }"
          title="更多操作"
          aria-label="更多操作"
          aria-haspopup="menu"
          :aria-expanded="moreOpen"
          @click="moreOpen = !moreOpen"
        >
          <SvgIcon name="more" :size="18" />
        </button>
      </MenuPopover>
      <button
        class="ghost-btn"
        :title="dockOpen ? '收起右栏' : '打开右栏'"
        :aria-label="dockOpen ? '收起右栏' : '打开右栏'"
        :class="{ active: dockOpen }"
        @click="onDockToggle"
      >
        <SvgIcon name="panel-right" :size="18" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.conv-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-line);
  background: transparent;
  min-height: 56px;
}
.conv-bar-left,
.conv-bar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.ghost-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}
.ghost-btn:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
.ghost-btn.active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
/* Both the stats pill and "more" size to their content rather than being square icon slots. */
.stats-btn,
.more-btn {
  width: auto;
  min-width: 36px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
}
.stats-metric {
  font-size: 11px;
  color: inherit;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.stats-sep {
  color: var(--color-text-faint);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-success);
  flex-shrink: 0;
}
.status-dot.busy {
  background: var(--color-accent);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
}

.title-btn {
  min-width: 0;
  max-width: min(480px, 55vw);
  height: 36px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.title-btn:hover {
  background: var(--color-hover);
}
.title-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-input {
  width: 100%;
  min-width: 160px;
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 600;
  font-family: inherit;
}
.title-input:focus {
  outline: none;
  box-shadow: var(--glow-focus);
}

@media (max-width: 900px) {
  /* At medium widths the turn count is dropped first and the token count kept — it is the primary "what did this turn cost" information. */
  .stats-btn .stats-metric:first-of-type,
  .stats-btn .stats-sep {
    display: none;
  }
}

@media (max-width: 640px) {
  .conv-bar {
    min-height: 52px;
  }
  .ghost-btn {
    width: 44px;
    height: 44px;
  }
  .stats-btn,
  .more-btn {
    width: auto;
    min-width: 44px;
  }
  .title-btn {
    max-width: 40vw;
  }
}
</style>
