<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { SlashCommand } from '../commands';
import {
  isAdvancedCollapsed,
  resetSlashMenuFilter,
  setSlashMenuFilter,
  SLASH_MENU_SEARCH_THRESHOLD,
} from '../commands';

/**
 * Slash candidate menu (the rendering layer after the three sources were merged, L3):
 * - command group (emitted straight by core) → advanced group (expanded only when
 *   the query matches; with an empty query it collapses to a group header) → skill group;
 * - when candidates exceed the threshold a search filter row appears at the top
 *   (AND-combined with the slash suffix; filter state lives in commands.ts, so the
 *   array Composer receives is already filtered and keyboard indices stay in sync);
 * - skill entries show the skill description and a source badge; selecting one
 *   fills in the `/skill-name ` text (acceptsInput semantics).
 */
const props = defineProps<{
  commands: SlashCommand[];
  activeIndex: number;
}>();

const emit = defineEmits<{
  (e: 'select', command: SlashCommand): void;
  (e: 'hover', index: number): void;
}>();

type Row =
  | { type: 'header'; label: string; hint?: string }
  | { type: 'item'; cmd: SlashCommand; index: number };

const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  user: '用户',
  extra: '扩展',
  project: '项目',
};
/** Source badge: commands.ts marks skills contributed by a plugin with a `plugin:<id>` prefix. */
function sourceLabel(source?: string): string {
  if (!source) return '';
  if (source.startsWith('plugin:')) return `插件 ${source.slice('plugin:'.length)}`;
  return SOURCE_LABEL[source] || source;
}

/** Splits the flat candidate array into a row sequence with group headers; group membership follows array order (commands.ts already sorts). */
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  let section = '';
  props.commands.forEach((cmd, index) => {
    const key =
      cmd.kind === 'skill' ? 'skills' : cmd.group === 'advanced' ? 'advanced' : 'commands';
    if (key !== section) {
      section = key;
      out.push({ type: 'header', label: SECTION_LABEL[key] });
    }
    out.push({ type: 'item', cmd, index });
  });
  // Empty-query browse state: the advanced group is collapsed and only a header
  // hint remains, so users do not think the commands disappeared.
  if (section !== 'advanced' && isAdvancedCollapsed()) {
    out.push({ type: 'header', label: SECTION_LABEL.advanced, hint: '输入继续筛选' });
  }
  return out;
});

const SECTION_LABEL: Record<string, string> = {
  commands: '命令',
  advanced: '高级',
  skills: '技能',
};

/* ── Search filter inside the menu (shown only with >8 candidates) ─────── */
const filter = ref('');
const showSearch = computed(
  () => props.commands.length > SLASH_MENU_SEARCH_THRESHOLD || filter.value !== '',
);

function onFilterInput(e: Event) {
  filter.value = (e.target as HTMLInputElement).value;
  setSlashMenuFilter(filter.value);
}

// Closing the menu unmounts it (Composer drives it with v-if); reset the filter
// term so the next open is not narrowed by leftovers.
onBeforeUnmount(() => {
  if (filter.value) {
    filter.value = '';
    resetSlashMenuFilter();
  }
});
</script>

<template>
  <div class="slash-menu" role="listbox" aria-label="斜杠命令与技能">
    <div v-if="showSearch" class="slash-search">
      <input
        class="slash-search-input"
        type="text"
        :value="filter"
        placeholder="筛选命令与技能…"
        aria-label="筛选命令与技能"
        @input="onFilterInput"
        @mousedown.stop
      />
    </div>
    <div class="slash-list">
      <template v-for="(row, ri) in rows" :key="ri">
        <div v-if="row.type === 'header'" class="slash-group">
          <span class="slash-group-label">{{ row.label }}</span>
          <span v-if="row.hint" class="slash-group-hint">{{ row.hint }}</span>
        </div>
        <button
          v-else
          :class="['slash-item', { active: row.index === activeIndex }]"
          role="option"
          :aria-selected="row.index === activeIndex"
          @mousedown.prevent="emit('select', row.cmd)"
          @mouseenter="emit('hover', row.index)"
        >
          <span class="slash-name">/{{ row.cmd.name }}<span v-if="row.cmd.aliases?.length" class="slash-aliases">{{ row.cmd.aliases.map((a) => `/${a}`).join(' ') }}</span></span>
          <span class="slash-desc">{{ row.cmd.description }}</span>
          <template v-if="row.cmd.kind === 'skill'">
            <span v-if="row.cmd.source" class="slash-badge slash-badge-source">{{ sourceLabel(row.cmd.source) }}</span>
            <span class="slash-badge slash-badge-skill">技能</span>
          </template>
          <template v-else>
            <span v-if="row.cmd.acceptsInput" class="slash-badge slash-badge-input">输入参数</span>
            <span v-if="row.cmd.target === 'backend'" class="slash-badge">服务端</span>
          </template>
        </button>
      </template>
    </div>
    <div class="slash-hint">↑↓ 选择 · Enter/Tab 执行 · Esc 关闭</div>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: var(--space-4);
  right: var(--space-4);
  max-width: 480px;
  background: var(--color-surface-raised);
  border: 0;
  border-radius: var(--radius-lg);
  /* Elevated surface: hairline stroke + darker scrollbar, no layout border. */
  box-shadow: var(--shadow-elevation-prominent);
  --shadow-stroke-color: var(--color-text-faint);
  --scrollbar-thumb: var(--color-text-faint);
  --scrollbar-thumb-hover: var(--color-text-muted);
  padding: var(--space-1);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform-origin: bottom center;
  animation: rise-in var(--dur-fast) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .slash-menu { animation: none; }
}

.slash-list {
  overflow-y: auto;
  max-height: min(46vh, 340px);
}

.slash-search {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-line);
  margin-bottom: var(--space-1);
}
.slash-search-input {
  width: 100%;
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: inherit;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.slash-search-input:focus {
  border-color: var(--color-accent-bd);
  box-shadow: var(--glow-focus);
}

/* Group header: one small line at the same density as the menu entries, not a card. */
.slash-group {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-1);
}
.slash-group-label {
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-faint);
  text-transform: none;
}
.slash-group-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}

.slash-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 36px;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  font-size: var(--font-size-sm);
  color: var(--color-text);
}
.slash-item.active,
.slash-item:hover {
  background: var(--color-hover);
}
.slash-item:active {
  background: var(--color-selected);
}
.slash-name {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--color-accent);
  flex-shrink: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slash-aliases {
  font-weight: 400;
  color: var(--color-text-faint);
  margin-left: var(--space-2);
  font-size: var(--font-size-xs);
}
.slash-desc {
  flex: 1;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slash-badge {
  font-size: var(--font-size-xs);
  color: var(--color-info);
  border: 1px solid var(--color-info);
  border-radius: var(--radius-full);
  padding: 0 var(--space-2);
  flex-shrink: 0;
}
.slash-badge-input {
  color: var(--color-accent);
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
}
.slash-badge-skill {
  color: var(--color-success);
  border-color: var(--color-success);
  background: var(--color-success-soft, rgba(60, 200, 120, 0.16));
}
.slash-badge-source {
  color: var(--color-text-muted);
  border-color: var(--color-line-strong, var(--color-line));
  background: var(--color-surface-sunken);
}
.slash-hint {
  padding: var(--space-1) var(--space-3) var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
  border-top: 1px solid var(--color-line);
  margin-top: var(--space-1);
}
@media (max-width: 640px) {
  .slash-item { min-height: 44px; }
  .slash-desc { white-space: normal; }
}
</style>
